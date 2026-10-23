/**
 * 批注应用主体：把锚点、存储、高亮、UI 组装起来。
 *
 * 与平台无关——Chrome 扩展和 Userscripts 各自实现 PlatformAdapter，
 * 入口（content.ts / main.ts）负责：
 *   1. 尽早快照 initialUrl（document_start，防 SPA 改写路由）
 *   2. 防重复注入
 *   3. DOM 就绪后调用 startAnnotatorApp
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
  UI_HOST_ATTR,
  urlToKey,
  type Annotation,
  type AnchorData,
  type DocData,
} from "@annotator/core";
import { LocalAdapter, ShaConflictError } from "@annotator/storage";
import { MARK_CLASS, MarkRenderer } from "./highlight.js";
import { createId } from "./id.js";
import type { PlatformAdapter } from "./platform.js";
import { currentSelectionRange, isUiEvent } from "./selection.js";
import { AnnotatorUi } from "./annotator-ui.js";

const OBSERVE_OPTIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
};
const OBSERVE_DEBOUNCE = 300;

/**
 * mutation 是否发生在「会影响正文文本结构」的地方。
 *
 * 过滤掉两种无关变化：
 *   1. 我们自己注入的 UI 宿主内部（Shadow DOM 外层容器）；
 *   2. 只发生在 mark.annotator-mark 内部的 characterData / childList ——
 *      这些是 renderBatch 里 splitText 产生的，正文文本节点的整体结构没变。
 *
 * 但 mark 被 unwrap 时（clear 或 remove），mutation.target 是 mark 的父节点，
 * removedNodes 里有 mark 元素——这种要放行，因为它改变了正文 DOM 结构。
 */
function mutationAffectsBody(mutations: MutationRecord[]): boolean {
  for (const m of mutations) {
    const target = m.target;
    if (
      target instanceof Element &&
      target.hasAttribute(UI_HOST_ATTR)
    ) {
      continue;
    }
    // mark 内部的 characterData：splitText 产生，不影响正文结构
    if (
      m.type === "characterData" &&
      target.parentElement?.classList.contains(MARK_CLASS)
    ) {
      continue;
    }
    // mark 内部的 childList：理论上 mark 不会有子元素，保险起见也过滤
    if (
      m.type === "childList" &&
      target instanceof Element &&
      target.classList.contains(MARK_CLASS)
    ) {
      continue;
    }
    return true;
  }
  return false;
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

export interface AnnotatorAppOptions {
  platform: PlatformAdapter;
  /** 入口在 document_start 快照的 location.href，不要用运行时的 location.href。 */
  initialUrl: string;
}

export interface AnnotatorAppHandle {
  ui: AnnotatorUi;
}

export async function startAnnotatorApp(
  options: AnnotatorAppOptions
): Promise<AnnotatorAppHandle | null> {
  if (window.top !== window.self) return null;
  if (!document.body) return null;

  const { platform, initialUrl } = options;

  const keyInfo = await urlToKey(initialUrl);
  const url = keyInfo.normalizedUrl;
  const key = keyInfo.key;
  const adapter = new LocalAdapter(platform.kv);

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

  const observer = new MutationObserver((mutations) => {
    if (rendering) return;
    // 只对真正影响正文的变化重渲——我们自己注入 mark 的 splitText
    // 会触发大量 characterData mutation，但正文文本结构没变。
    if (!mutationAffectsBody(mutations)) return;
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
      // 本地已经写好，再让平台层把它推进上传队列。
      platform.requestUpload(key);
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

  /** 平台层同步可能改写本地缓存，这里监听后重新渲染。 */
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

    // 重复划线判定：同一段文字（quote + pos_hint 完全相同）只允许存在
    // 一条 active 批注。想加想法应该点开已有批注编辑，而不是新建。
    // 局限：若两次划线之间 DOM 变化导致 pos_hint 漂移，判重会失效——
    // 这种场景下即便允许新建，旧锚点也大概率会漂走，属于可接受边界。
    const duplicate = activeAnnotations(docData).some(
      (a) => a.quote === anchor.quote && a.pos_hint === anchor.pos_hint
    );
    if (duplicate) {
      pendingRange = null;
      ui.hideToolbar();
      ui.toast("这段已经划过了");
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

  platform.watchDoc(key, () => {
    void reloadFromLocal();
  });
  renderAll();
  // 先用本地缓存渲染完，再让平台层拉远端最新版本。
  platform.requestSync(key);

  return { ui };
}
