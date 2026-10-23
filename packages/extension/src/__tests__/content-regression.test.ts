/**
 * 回归测试：手动测试发现的两个问题。
 *
 * 1. 连续添加划线时，新增后之前的 <mark> 全部消失。
 *    怀疑：renderAll 先 clear()（内含 normalize 合并文本节点），
 *    再复用 PageResolver 缓存的 Range 渲染，缓存 Range 指向已被合并的
 *    旧文本节点而失效。
 * 2. 两条纯划线 + 一条带想法的批注，刷新后带想法那条没有高亮，
 *    且侧边栏列表计数为 0。
 */
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const HTML = `<!doctype html><html><head><title>测试文章</title></head>
<body><article><p id="p">Hello brave new world, this is a test article.</p></article></body></html>`;
const PAGE_URL = "https://example.com/article";

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

/** 在当前 DOM（可能已有 mark 拆分）里选中包含 substring 的文本。 */
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

function shadowHost(dom: JSDOM): HTMLElement {
  return dom.window.document.querySelector(
    "[data-annotator-root]"
  ) as HTMLElement;
}

function markTexts(dom: JSDOM): string[] {
  return Array.from(
    dom.window.document.querySelectorAll("mark.annotator-mark")
  ).map((m) => m.textContent ?? "");
}

async function openToolbar(dom: JSDOM, substring: string): Promise<HTMLElement> {
  selectSubstring(dom, substring);
  dom.window.document.dispatchEvent(
    new dom.window.MouseEvent("mouseup", { bubbles: true })
  );
  const host = shadowHost(dom);
  const toolbar = host.shadowRoot!.querySelector(".toolbar") as HTMLElement;
  await waitFor(() => !toolbar.hidden, 3000, `toolbar for ${substring}`);
  return host;
}

async function addHighlight(dom: JSDOM, substring: string): Promise<void> {
  const host = await openToolbar(dom, substring);
  (
    host.shadowRoot!.querySelector('[data-action="highlight"]') as HTMLElement
  ).click();
}

async function addComment(
  dom: JSDOM,
  substring: string,
  comment: string
): Promise<void> {
  const host = await openToolbar(dom, substring);
  (
    host.shadowRoot!.querySelector('[data-action="comment"]') as HTMLElement
  ).click();
  await waitFor(
    () => !host.shadowRoot!.querySelector(".editor")!.hasAttribute("hidden"),
    3000,
    "editor"
  );
  (
    host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement
  ).value = comment;
  (
    host.shadowRoot!.querySelector('[data-action="save"]') as HTMLElement
  ).click();
}

function storedDoc(area: Area): {
  annotations: Array<{
    quote: string;
    comment: string;
    deleted_at: string | null;
  }>;
} {
  const docKey = Array.from(area.data.keys()).find((key) =>
    key.startsWith("annotator:doc:")
  );
  expect(docKey).toBeDefined();
  return JSON.parse(area.data.get(docKey!) as string);
}

describe("回归：连续添加与刷新恢复", () => {
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

  it("连续添加三条批注后旧高亮不消失；刷新后三条全部恢复且列表计数为 3", async () => {
    const area = createArea();

    const first = openPage(area);
    first.window.eval(code);
    await waitFor(
      () => !!first.window.document.querySelector("[data-annotator-root]"),
      3000,
      "ui host"
    );

    // 第 1 条：纯划线
    await addHighlight(first, "Hello");
    await waitFor(
      () => markTexts(first).length === 1,
      3000,
      "mark 1"
    );
    expect(markTexts(first)).toEqual(["Hello"]);

    // 第 2 条：纯划线 —— 添加后第 1 条的 mark 必须还在
    await addHighlight(first, "brave");
    await waitFor(
      () => markTexts(first).length === 2,
      3000,
      "marks 1+2"
    );
    expect(markTexts(first)).toEqual(["Hello", "brave"]);

    // 第 3 条：带想法 —— 添加后前两条的 mark 必须还在
    await addComment(first, "world", "这是想法");
    await waitFor(
      () => markTexts(first).length === 3,
      3000,
      "marks 1+2+3"
    );
    expect(markTexts(first)).toEqual(["Hello", "brave", "world"]);

    // 确认三条都写入了 storage（问题 C：带想法那条到底有没有被保存）
    const saved = storedDoc(area);
    expect(saved.annotations).toHaveLength(3);
    expect(
      saved.annotations.every((a) => a.deleted_at === null)
    ).toBe(true);
    expect(
      saved.annotations.find((a) => a.quote === "world")?.comment
    ).toBe("这是想法");

    // 模拟刷新：新 JSDOM + 同一份 storage
    const second = openPage(area);
    second.window.eval(code);
    await waitFor(
      () => markTexts(second).length === 3,
      5000,
      "restored marks"
    );
    expect(markTexts(second)).toEqual(["Hello", "brave", "world"]);

    // 侧边栏列表：计数 3、3 个条目
    const host = shadowHost(second);
    expect(
      (host.shadowRoot!.querySelector(".count") as HTMLElement).textContent
    ).toBe("3");
    expect(
      (host.shadowRoot!.querySelector(".fab") as HTMLElement).textContent
    ).toBe("批注 3");
    expect(host.shadowRoot!.querySelectorAll(".list .item")).toHaveLength(3);
  });

  it("同一段文字重复划线会被拒绝，不会生成第二条批注", async () => {
    const area = createArea();

    const dom = openPage(area);
    dom.window.eval(code);
    await waitFor(
      () => !!dom.window.document.querySelector("[data-annotator-root]"),
      3000,
      "ui host"
    );

    // 第一次划 "Hello"：成功
    await addHighlight(dom, "Hello");
    await waitFor(() => markTexts(dom).length === 1, 3000, "first mark");
    expect(storedDoc(area).annotations).toHaveLength(1);

    // 再次选中同一段 "Hello" 点划线：应被拒绝，不产生第二条
    const host = await openToolbar(dom, "Hello");
    (
      host.shadowRoot!.querySelector(
        '[data-action="highlight"]'
      ) as HTMLElement
    ).click();

    // 给 UI 一个响应窗口，确认没有新的 mark / annotation 产生
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(markTexts(dom)).toEqual(["Hello"]);
    expect(storedDoc(area).annotations).toHaveLength(1);

    // toast 应给出拒绝提示
    const toast = host.shadowRoot!.querySelector(".toast") as HTMLElement;
    await waitFor(
      () => (toast.textContent ?? "").includes("已经划过"),
      3000,
      "duplicate toast"
    );
  });

  it("同一段文字划线一次后仍可对其添加想法（updateComment 不受影响）", async () => {
    const area = createArea();

    const dom = openPage(area);
    dom.window.eval(code);
    await waitFor(
      () => !!dom.window.document.querySelector("[data-annotator-root]"),
      3000,
      "ui host"
    );

    await addHighlight(dom, "Hello");
    await waitFor(() => markTexts(dom).length === 1, 3000, "mark");

    // 点击已存在的高亮，打开编辑器加想法
    (
      dom.window.document.querySelector("mark.annotator-mark") as HTMLElement
    ).click();
    const host = shadowHost(dom);
    await waitFor(
      () => !host.shadowRoot!.querySelector(".editor")!.hasAttribute("hidden"),
      3000,
      "editor"
    );
    (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value =
      "补一条想法";
    (
      host.shadowRoot!.querySelector('[data-action="save"]') as HTMLElement
    ).click();

    await waitFor(
      () => storedDoc(area).annotations[0]?.comment === "补一条想法",
      3000,
      "comment saved"
    );
    expect(storedDoc(area).annotations).toHaveLength(1);
  });
});
