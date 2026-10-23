/**
 * 端到端冒烟：用 jsdom 加载真实打包产物，模拟「划线 → 写想法 → 刷新恢复」。
 * 存储用内存版 chrome.storage.local。
 */
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const HTML = `<!doctype html><html><head><title>测试文章</title></head>
<body><article><p id="p">Hello brave new world, this is a test article.</p></article></body></html>`;
const PAGE_URL = "https://example.com/article";

/** 内存版 chrome.storage.local（Promise 接口）。 */
function createArea() {
  const data = new Map<string, unknown>();
  return {
    data,
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
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

type Area = ReturnType<typeof createArea>;

function openPage(area: Area): JSDOM {
  const dom = new JSDOM(HTML, {
    url: PAGE_URL,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  win.chrome = { storage: { local: area } };
  if (typeof win.TextEncoder === "undefined") {
    win.TextEncoder = TextEncoder;
  }
  // jsdom 的 Range 没有 getBoundingClientRect，补一个全零矩形
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
  return dom;
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

function selectionFor(doc: Document, start: number, end: number): void {
  const text = doc.getElementById("p")!.firstChild as Text;
  const range = doc.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = doc.defaultView!.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("内容脚本端到端（jsdom）", () => {
  let code: string;

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
  });

  it("划线后写入存储，重新打开页面能恢复高亮", async () => {
    const area = createArea();

    // 第一次打开：划线
    const first = openPage(area);
    first.window.eval(code);

    await waitFor(
      () => !!first.window.document.querySelector("[data-annotator-root]"),
      3000,
      "ui host"
    );

    selectionFor(first.window.document, 0, 5);
    first.window.document.dispatchEvent(
      new first.window.MouseEvent("mouseup", { bubbles: true })
    );

    const host = first.window.document.querySelector(
      "[data-annotator-root]"
    ) as HTMLElement;
    const toolbar = host.shadowRoot!.querySelector(".toolbar") as HTMLElement;
    await waitFor(() => !toolbar.hidden, 3000, "toolbar visible");

    (
      host.shadowRoot!.querySelector('[data-action="highlight"]') as HTMLElement
    ).click();

    await waitFor(
      () => !!first.window.document.querySelector("mark.annotator-mark"),
      3000,
      "mark"
    );

    const mark = first.window.document.querySelector("mark.annotator-mark")!;
    expect(mark.textContent).toBe("Hello");

    const docKey = Array.from(area.data.keys()).find((key) =>
      key.startsWith("annotator:doc:")
    );
    expect(docKey).toBeDefined();
    const stored = JSON.parse(area.data.get(docKey!) as string);
    expect(stored.annotations).toHaveLength(1);
    expect(stored.annotations[0].quote).toBe("Hello");

    // 第二次打开：刷新恢复
    const second = openPage(area);
    second.window.eval(code);

    await waitFor(
      () => !!second.window.document.querySelector("mark.annotator-mark"),
      3000,
      "restored mark"
    );
    expect(
      second.window.document.querySelector("mark.annotator-mark")!.textContent
    ).toBe("Hello");

    // 点击高亮可以打开编辑器
    (
      second.window.document.querySelector("mark.annotator-mark") as HTMLElement
    ).click();
    const secondHost = second.window.document.querySelector(
      "[data-annotator-root]"
    ) as HTMLElement;
    await waitFor(
      () =>
        secondHost.shadowRoot?.querySelector(".editor")?.hasAttribute("hidden") ===
        false,
      3000,
      "editor opened"
    );
  });

  it("写想法后刷新恢复批注内容", async () => {
    const area = createArea();

    const first = openPage(area);
    first.window.eval(code);
    await waitFor(
      () => !!first.window.document.querySelector("[data-annotator-root]"),
      3000,
      "ui host"
    );

    selectionFor(first.window.document, 6, 11); // "brave"
    first.window.document.dispatchEvent(
      new first.window.MouseEvent("mouseup", { bubbles: true })
    );

    const host = first.window.document.querySelector(
      "[data-annotator-root]"
    ) as HTMLElement;
    const toolbar = host.shadowRoot!.querySelector(".toolbar") as HTMLElement;
    await waitFor(() => !toolbar.hidden, 3000, "toolbar visible");
    (
      host.shadowRoot!.querySelector('[data-action="comment"]') as HTMLElement
    ).click();

    const textarea = host.shadowRoot!.querySelector(
      "textarea"
    ) as HTMLTextAreaElement;
    await waitFor(
      () => !host.shadowRoot!.querySelector(".editor")!.hasAttribute("hidden"),
      3000,
      "editor"
    );
    textarea.value = "这是想法";
    (
      host.shadowRoot!.querySelector('[data-action="save"]') as HTMLElement
    ).click();

    await waitFor(
      () => !!first.window.document.querySelector("mark.annotator-mark"),
      3000,
      "mark"
    );

    const second = openPage(area);
    second.window.eval(code);
    await waitFor(
      () => !!second.window.document.querySelector("mark.annotator-mark"),
      3000,
      "restored mark"
    );

    (
      second.window.document.querySelector("mark.annotator-mark") as HTMLElement
    ).click();
    const secondHost = second.window.document.querySelector(
      "[data-annotator-root]"
    ) as HTMLElement;
    await waitFor(
      () =>
        !secondHost.shadowRoot!.querySelector(".editor")!.hasAttribute("hidden"),
      3000,
      "editor"
    );
    expect(
      (secondHost.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement)
        .value
    ).toBe("这是想法");
  });
});
