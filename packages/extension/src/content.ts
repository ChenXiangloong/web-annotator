/**
 * 内容脚本：把锚点、存储、高亮、UI 组装起来。
 *
 * 解析路径：
 *   PageResolver 只构建一次页面正文上下文，所有批注共享；
 *   DOM 变化（懒加载等）后失效重建，并重绘高亮。
 */

import {
  activeAnnotations,
  emptyDocData,
  mergeAnnotations,
  PageResolver,
  refreshDocCounts,
  urlToKey,
  type Annotation,
  type AnchorData,
  type DocData,
} from "@annotator/core";
import { LocalAdapter, ShaConflictError } from "@annotator/storage";
import { MarkRenderer } from "./highlight.js";
import { createId } from "./id.js";
import { ChromeStorageKVStore } from "./kv.js";
import { currentSelectionRange, isUiEvent } from "./selection.js";
import { AnnotatorUi } from "./ui.js";

const LOADED_FLAG = "__annotatorContentLoaded";
const DOC_STORAGE_PREFIX = "annotator:doc:";
const OBSERVE_OPTIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
};
const OBSERVE_DEBOUNCE = 300;

/**
 * content script 以 document_start 注入（见 manifest.json），
 * 这里先冻结一份 URL 快照：Substack 这类 SPA 会在脚本就绪后
 * 用 history.replaceState 把地址改成首页，导致批注挂到错误的 key 上。
 * main() 无论等到 DOMContentLoaded 还是立即执行，都用这份快照。
 */
const INITIAL_URL = location.href;

/**
 * 交给 service worker 处理，content script 自己不发网络请求。
 * 扩展上下文失效（开发时重载）时静默忽略。
 */
function postToBackground(message: { type: string; key: string }): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  try {
    const pending = chrome.runtime.sendMessage(message) as unknown;
    if (pending && typeof (pending as Promise<unknown>).catch === "function") {
      (pending as Promise<unknown>).catch(() => {});
    }
  } catch {
    // 忽略：下一次页面加载会继续同步
  }
}

/**
 * 作者/站点名。依次尝试常见的 author meta、og:site_name、
 * 微信公众号的 #js_name（需实测），最后退回域名。
 */
function extractAuthor(): string {
  const meta = (selector: string): string =>
    document.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
  return (
    meta('meta[name="author"]') ||
    meta('meta[property="article:author"]') ||
    meta('meta[name="twitter:creator"]') ||
    meta('meta[property="og:site_name"]') ||
    document.getElementById("js_name")?.textContent?.trim() ||
    location.hostname
  );
}

async function main(): Promise<void> {
  if (window.top !== window.self) return;
  if (!document.body) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals[LOADED_FLAG]) return;
  globals[LOADED_FLAG] = true;

  const keyInfo = await urlToKey(INITIAL_URL);
  const url = keyInfo.normalizedUrl;
  const key = keyInfo.key;
  const adapter = new LocalAdapter(new ChromeStorageKVStore());

  let docData: DocData = emptyDocData(url, document.title);
  let sha: string | undefined;
  try {
    const stored = await adapter.getDoc(key);
    if (stored) {
      docData = stored.doc;
      sha = stored.sha;
    }
  } catch (error) {
    console.error("[annotator] 读取本地批注失败", error);
  }
  if (!docData.title) docData.title = document.title;
  if (!docData.author) docData.author = extractAuthor();

  const resolver = new PageResolver(document.body);
  const renderer = new MarkRenderer(document);

  let ui!: AnnotatorUi;
  let orphanIds = new Set<string>();
  let pendingRange: Range | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let rendering = false;

  const observer = new MutationObserver(() => {
    if (rendering) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      renderAll();
    }, OBSERVE_DEBOUNCE);
  });
  observer.observe(document.body, OBSERVE_OPTIONS);

  function toastError(error: unknown): void {
    console.error("[annotator]", error);
    const message = error instanceof Error ? error.message : String(error);
    ui?.toast(`保存失败：${message}`);
  }

  async function persist(): Promise<boolean> {
    try {
      // 写入前刷新派生字段，保证本地与仓库里的计数始终最新。
      docData = refreshDocCounts(docData);
      const result = await adapter.putDoc(key, docData, sha);
      sha = result.sha;
      // 本地已经写好，再让后台把它推进上传队列。
      postToBackground({ type: "annotator:save", key });
      return true;
    } catch (error) {
      if (error instanceof ShaConflictError) {
        try {
          const latest = await adapter.getDoc(key);
          if (latest) {
            docData = {
              ...latest.doc,
              title: docData.title || latest.doc.title,
              annotations: mergeAnnotations(
                latest.doc.annotations,
                docData.annotations
              ),
            };
            sha = latest.sha;
            return persist();
          }
        } catch (inner) {
          toastError(inner);
          return false;
        }
      }
      toastError(error);
      return false;
    }
  }

  /** 清空高亮并按当前页面上下文重画；顺带刷新列表。 */
  function renderAll(): void {
    if (rendering) return;
    rendering = true;
    observer.disconnect();
    try {
      renderer.clear();
      // clear() 会 unwrap <mark> 并 normalize 文本节点，缓存的 Range
      // 指向已被合并/移除的旧节点，必须全部作废、基于当前 DOM 重新解析。
      resolver.invalidate();

      const list = activeAnnotations(docData);
      orphanIds = new Set<string>();

      // 先完成全部解析（纯文本匹配，不动 DOM），再统一渲染：
      // 渲染会拆分文本节点，边解析边渲染会让后续解析落到失效节点上。
      const spans: Array<{ id: string; start: number; end: number }> = [];
      for (const annotation of list) {
        const resolved = resolver.resolve(annotation);
        if (!resolved) {
          orphanIds.add(annotation.id);
          continue;
        }
        spans.push({
          id: annotation.id,
          start: resolved.cleanStart,
          end: resolved.cleanEnd,
        });
      }
      if (spans.length > 0) {
        renderer.renderBatch(spans, resolver.getContext().page);
      }
      ui.setAnnotations(list, orphanIds);
    } finally {
      observer.observe(document.body!, OBSERVE_OPTIONS);
      rendering = false;
    }
  }

  function refreshList(): void {
    ui.setAnnotations(activeAnnotations(docData), orphanIds);
  }

  /** 后台同步可能改写本地缓存，这里监听后重新渲染。 */
  function watchStorage(): void {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!Object.prototype.hasOwnProperty.call(changes, DOC_STORAGE_PREFIX + key)) {
        return;
      }
      void reloadFromLocal();
    });
  }

  async function reloadFromLocal(): Promise<void> {
    try {
      const stored = await adapter.getDoc(key);
      if (!stored) return;
      sha = stored.sha;
      // 自己写入触发的变化与内存中的文档一致，不必重绘。
      if (JSON.stringify(stored.doc) === JSON.stringify(docData)) return;
      docData = stored.doc;
      renderAll();
    } catch (error) {
      console.error("[annotator] 读取同步结果失败", error);
    }
  }

  async function createAnnotation(comment: string): Promise<void> {
    const range = pendingRange;
    if (!range) {
      ui.toast("请先选中文字");
      return;
    }

    let anchor: AnchorData;
    try {
      anchor = resolver.describe(range);
    } catch {
      ui.toast("这段内容无法作为锚点");
      return;
    }

    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: createId(),
      ...anchor,
      comment: comment.trim(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    docData.annotations.push(annotation);
    pendingRange = null;

    if (!(await persist())) {
      docData.annotations = docData.annotations.filter(
        (a) => a.id !== annotation.id
      );
      return;
    }

    renderAll();
    ui.toast(annotation.comment ? "已保存批注" : "已划线");
  }

  async function updateComment(id: string, comment: string): Promise<void> {
    const annotation = docData.annotations.find(
      (a) => a.id === id && a.deleted_at === null
    );
    if (!annotation) return;

    const previousComment = annotation.comment;
    const previousUpdatedAt = annotation.updated_at;
    annotation.comment = comment;
    annotation.updated_at = new Date().toISOString();

    if (!(await persist())) {
      annotation.comment = previousComment;
      annotation.updated_at = previousUpdatedAt;
      return;
    }

    refreshList();
    ui.toast("已保存");
  }

  async function deleteAnnotation(id: string): Promise<void> {
    const annotation = docData.annotations.find(
      (a) => a.id === id && a.deleted_at === null
    );
    if (!annotation) return;

    const previousDeletedAt = annotation.deleted_at;
    const previousUpdatedAt = annotation.updated_at;
    const now = new Date().toISOString();
    annotation.deleted_at = now;
    annotation.updated_at = now;

    if (!(await persist())) {
      annotation.deleted_at = previousDeletedAt;
      annotation.updated_at = previousUpdatedAt;
      return;
    }

    renderer.remove(id);
    orphanIds.delete(id);
    refreshList();
    ui.closeEditor();
    ui.toast("已删除");
  }

  function selectAnnotation(id: string): void {
    const element = renderer.elementFor(id);
    if (!element) {
      ui.toast("原文已找不到");
      return;
    }
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    if ((document.defaultView?.innerWidth ?? 1024) <= 768) {
      ui.hidePanel();
    }
  }

  function startComment(): void {
    if (!pendingRange) {
      ui.toast("请先选中文字");
      return;
    }
    ui.openEditor({
      id: null,
      quote: pendingRange.toString(),
      comment: "",
    });
  }

  ui = new AnnotatorUi({
    onStartHighlight: () => {
      void createAnnotation("");
    },
    onStartComment: startComment,
    onCreateWithComment: (comment) => {
      void createAnnotation(comment);
    },
    onUpdateComment: (id, comment) => {
      void updateComment(id, comment);
    },
    onDelete: (id) => {
      void deleteAnnotation(id);
    },
    onSelect: selectAnnotation,
  });

  function handleSelectionChange(): void {
    const range = currentSelectionRange();
    if (!range) {
      pendingRange = null;
      ui.hideToolbar();
      return;
    }
    pendingRange = range.cloneRange();
    ui.showToolbar(range.getBoundingClientRect());
  }

  document.addEventListener("mouseup", (event) => {
    if (isUiEvent(event)) return;
    window.setTimeout(handleSelectionChange, 0);
  });

  document.addEventListener("touchend", (event) => {
    if (isUiEvent(event)) return;
    window.setTimeout(handleSelectionChange, 300);
  });

  document.addEventListener("keyup", (event) => {
    if (isUiEvent(event)) return;
    if (event.key === "Shift" || event.shiftKey) {
      handleSelectionChange();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!isUiEvent(event)) ui.hideToolbar();
  });

  window.addEventListener("scroll", () => ui.hideToolbar(), { passive: true });

  document.addEventListener(
    "click",
    (event) => {
      if (isUiEvent(event)) return;
      const annotationId = renderer.getAnnotationId(event.target);
      if (!annotationId) return;

      const annotation = docData.annotations.find(
        (a) => a.id === annotationId && a.deleted_at === null
      );
      if (!annotation) return;

      event.preventDefault();
      event.stopPropagation();
      ui.hideToolbar();
      ui.openEditor({
        id: annotation.id,
        quote: annotation.quote,
        comment: annotation.comment,
      });
    },
    true
  );

  watchStorage();
  renderAll();
  // 先用本地缓存渲染完，再让后台拉远端最新版本。
  postToBackground({ type: "annotator:sync", key });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void main(), {
    once: true,
  });
} else {
  void main();
}
