/**
 * 里程碑 4：content script 与 service worker 的接线。
 *
 * 只验证「本地优先 + 后台同步」这两条边界：
 *   1. 页面加载后先渲染本地缓存，再发 annotator:sync；
 *   2. 后台改写本地缓存后，页面按 onChanged 重新渲染；
 *   3. 保存批注后发 annotator:save。
 */
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import { urlToKey, serializeDoc, type Annotation, type DocData } from "@annotator/core";

const HTML = `<!doctype html><html><head><title>同步测试</title></head>
<body><article><p id="p">Hello brave new world.</p></article></body></html>`;
const PAGE_URL = "https://example.com/sync-article";

type ChangeListener = (
  changes: Record<string, unknown>,
  areaName: string
) => void;

function createArea() {
  const data = new Map<string, unknown>();
  const listeners: ChangeListener[] = [];

  function emit(changes: Record<string, unknown>) {
    for (const listener of listeners) listener(changes, "local");
  }

  return {
    data,
    emit,
    async get(keys?: string | string[] | null) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(data);
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) {
        if (data.has(key)) result[key] = data.get(key);
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { newValue: value };
        data.set(key, value);
      }
      emit(changes);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    onChanged: {
      addListener(listener: ChangeListener) {
        listeners.push(listener);
      },
    },
  };
}

type Area = ReturnType<typeof createArea>;

interface SentMessage {
  type: string;
  key: string;
}

function openPage(area: Area) {
  const sent: SentMessage[] = [];
  const dom = new JSDOM(HTML, {
    url: PAGE_URL,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  win.chrome = {
    storage: { local: area, onChanged: area.onChanged },
    runtime: {
      sendMessage(message: SentMessage) {
        sent.push(message);
        return Promise.resolve({ ok: true });
      },
    },
  };
  if (typeof win.TextEncoder === "undefined") win.TextEncoder = TextEncoder;
  (dom.window.Range.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  }).getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return { dom, sent };
}

async function waitFor(
  predicate: () => boolean,
  timeout = 3000,
  label = "condition"
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function markTexts(dom: JSDOM): string[] {
  return Array.from(
    dom.window.document.querySelectorAll("mark.annotator-mark")
  ).map((node) => node.textContent ?? "");
}

function mkAnnotation(overrides: Partial<Annotation>): Annotation {
  return {
    id: "a1",
    quote: "Hello",
    prefix: "",
    suffix: "",
    pos_hint: 0,
    comment: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function docFor(annotations: Annotation[]): DocData {
  return {
    url: PAGE_URL,
    title: "同步测试",
    annotations,
  };
}

async function seed(area: Area, key: string, doc: DocData) {
  area.data.set(`annotator:doc:${key}`, serializeDoc(doc));
}

function selectSubstring(dom: JSDOM, substring: string): void {
  const doc = dom.window.document;
  const p = doc.getElementById("p")!;
  const walker = doc.createTreeWalker(p, 4 /* SHOW_TEXT */);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const at = node.data.indexOf(substring);
    if (at !== -1) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + substring.length);
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`selectSubstring: 找不到 ${substring}`);
}

describe("content ↔ background", () => {
  let code: string;
  let key: string;

  beforeAll(async () => {
    const entry = fileURLToPath(new URL("../content.ts", import.meta.url));
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "chrome114",
    });
    code = result.outputFiles[0].text;
    key = (await urlToKey(PAGE_URL)).key;
  });

  it("先渲染本地缓存再请求同步；后台更新后重绘；保存后入队", async () => {
    const area = createArea();
    await seed(area, key, docFor([mkAnnotation({})]));

    const { dom, sent } = openPage(area);
    dom.window.eval(code);

    await waitFor(() => markTexts(dom).length === 1, 3000, "本地缓存渲染");
    expect(markTexts(dom)).toEqual(["Hello"]);

    // 首次同步请求
    await waitFor(
      () => sent.some((message) => message.type === "annotator:sync"),
      3000,
      "sync message"
    );
    expect(sent.find((message) => message.type === "annotator:sync")!.key).toBe(
      key
    );

    // 模拟后台拉到远端新批注并写入本地
    const merged = docFor([
      mkAnnotation({}),
      mkAnnotation({
        id: "a2",
        quote: "brave",
        pos_hint: 6,
        comment: "来自另一台设备",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    area.data.set(`annotator:doc:${key}`, JSON.stringify(merged));
    area.emit({
      [`annotator:doc:${key}`]: { newValue: JSON.stringify(merged) },
    });

    await waitFor(() => markTexts(dom).length === 2, 3000, "同步后重绘");
    expect(markTexts(dom)).toEqual(["Hello", "brave"]);

    // 新增一条划线 → 保存后应通知后台上传
    selectSubstring(dom, "world");
    dom.window.document.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true })
    );
    const host = dom.window.document.querySelector(
      "[data-annotator-root]"
    ) as HTMLElement;
    const toolbar = host.shadowRoot!.querySelector(".toolbar") as HTMLElement;
    await waitFor(() => !toolbar.hidden, 3000, "toolbar");
    (
      host.shadowRoot!.querySelector('[data-action="highlight"]') as HTMLElement
    ).click();

    await waitFor(
      () => sent.some((message) => message.type === "annotator:save"),
      3000,
      "save message"
    );
    expect(sent.filter((message) => message.type === "annotator:save")).toEqual([
      { type: "annotator:save", key },
    ]);
  });

  it("没有 chrome.runtime 时不影响本地功能", async () => {
    const area = createArea();
    await seed(area, key, docFor([mkAnnotation({})]));

    const { dom } = openPage(area);
    const win = dom.window as unknown as Record<string, unknown>;
    win.chrome = { storage: { local: area, onChanged: area.onChanged } };

    dom.window.eval(code);
    await waitFor(() => markTexts(dom).length === 1, 3000, "本地渲染");
    expect(markTexts(dom)).toEqual(["Hello"]);
  });

  it("SPA 改写 URL 后仍用加载时的地址取 key（Substack 场景）", async () => {
    // 复现 substack.com/home/post/p-xxx → replaceState 到 substack.com/
    const articleUrl = "https://example.com/home/post/p-191966053";
    const articleKey = (await urlToKey(articleUrl)).key;
    const area = createArea();
    await seed(area, articleKey, docFor([mkAnnotation({})]));

    const sent: SentMessage[] = [];
    const dom = new JSDOM(HTML, {
      url: articleUrl,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    win.chrome = {
      storage: { local: area, onChanged: area.onChanged },
      runtime: {
        sendMessage(message: SentMessage) {
          sent.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    };
    if (typeof win.TextEncoder === "undefined") win.TextEncoder = TextEncoder;

    // 真实时序：content script 以 document_start 注入、先冻结文章 URL；
    // 随后页面脚本就绪，用 replaceState 把地址改成首页。
    dom.window.eval(code);
    dom.window.history.replaceState(null, "", "https://example.com/");

    await waitFor(() => markTexts(dom).length === 1, 3000, "快照 URL 对应文档渲染");
    expect(markTexts(dom)).toEqual(["Hello"]);

    await waitFor(
      () => sent.some((message) => message.type === "annotator:sync"),
      3000,
      "sync message"
    );
    expect(sent.find((message) => message.type === "annotator:sync")!.key).toBe(
      articleKey
    );
  });
});
