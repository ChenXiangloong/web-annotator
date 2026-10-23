/**
 * 性能基准：量化大型页面下的热点耗时。
 *
 * 场景模拟：长文章（~1600 文本节点、~35KB 净文本），
 * 50 条批注（覆盖文章各处）。输出每个热点的平均值/最大值，
 * 为后续优化提供量化依据。
 */
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { createPageContext, resolveAnchorOnPage, type AnchorData } from "../anchor.js";
import { buildPageText, type PageText } from "../page-text.js";
import { PageResolver } from "../page-resolver.js";
import { MarkRenderer } from "../../../ui/src/highlight.js";
import { emptyDocData, type Annotation, type DocData } from "../types.js";

const PARAGRAPH_COUNT = 200;
const WORDS_PER_PARAGRAPH = 18;
const ANNOTATION_COUNT = 50;
const SAMPLES = 5;

/** 生成一段随机但稳定的段落文本。 */
function paragraph(seed: number): string {
  const words = [
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "hello", "world", "annotator", "test", "benchmark", "performance",
    "web", "article", "content", "highlight", "selection", "anchor",
    "resolver", "context", "render", "batch", "document", "fragment",
    "mutation", "observer", "debounce", "threshold", "compute", "index",
  ];
  let out = "";
  for (let i = 0; i < WORDS_PER_PARAGRAPH; i++) {
    out += words[(seed + i) % words.length] + " ";
  }
  return out.trim();
}

function buildLargeDom(): { dom: JSDOM; body: HTMLElement } {
  const parts: string[] = ["<!doctype html><html><head><title>Perf Test</title></head><body>"];
  for (let i = 0; i < PARAGRAPH_COUNT; i++) {
    parts.push(`<p>${paragraph(i)}</p>`);
  }
  parts.push("</body></html>");

  const dom = new JSDOM(parts.join(""), {
    url: "https://example.com/perf",
    pretendToBeVisual: true,
  });
  // Range.prototype.getBoundingClientRect 在 jsdom 里缺失
  (dom.window.Range.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  }).getBoundingClientRect = () =>
    ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
      width: 0, height: 0, toJSON: () => ({}),
    }) as DOMRect;
  return { dom, body: dom.window.document.body! };
}

/** 从 page.text 里挑若干段作为 quote，构造一批批注。 */
function makeAnnotations(page: PageText, count: number): Annotation[] {
  const annotations: Annotation[] = [];
  const step = Math.floor(page.text.length / (count + 1));
  for (let i = 0; i < count; i++) {
    const center = step * (i + 1);
    const quoteLen = 30;
    const start = Math.max(0, center - quoteLen / 2);
    const quote = page.text.slice(Math.floor(start), Math.floor(start) + quoteLen);

    annotations.push({
      id: `a-${i}`,
      quote,
      prefix: page.text.slice(Math.max(0, Math.floor(start) - 30), Math.floor(start)),
      suffix: page.text.slice(Math.floor(start) + quoteLen, Math.floor(start) + quoteLen + 30),
      pos_hint: Math.floor(start),
      comment: i % 5 === 0 ? `note ${i}` : "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
  }
  return annotations;
}

/** 测 fn 平均耗时（ms），跑 samples 次取中间值。 */
function benchMs(fn: () => void, samples = SAMPLES): number {
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

describe("性能基准（大型 DOM, 50 批注）", () => {
  it("buildPageText: 单次遍历全文耗时", () => {
    const { body } = buildLargeDom();
    const ms = benchMs(() => buildPageText(body));
    const page = buildPageText(body);
    console.log(`  buildPageText  中位数: ${ms.toFixed(2)}ms   text=${page.text.length}  entries=${page.entries.length}`);
    expect(page.text.length).toBeGreaterThan(10_000);
    expect(page.entries.length).toBeGreaterThan(100);
  });

  it("createPageContext + 50 条 resolve（全量，无缓存）", () => {
    const { body } = buildLargeDom();
    const page = buildPageText(body);
    const annotations = makeAnnotations(page, ANNOTATION_COUNT);

    const ms = benchMs(() => {
      const ctx = createPageContext(body);
      for (const a of annotations) {
        resolveAnchorOnPage(a, ctx);
      }
    });
    console.log(`  resolve×50     中位数: ${ms.toFixed(2)}ms`);
  });

  it("renderBatch: 50 批注批量渲染耗时", () => {
    const { dom, body } = buildLargeDom();
    const doc = dom.window.document;
    const ctx = createPageContext(body);
    const annotations = makeAnnotations(ctx.page, ANNOTATION_COUNT);

    const resolved: Array<{ id: string; start: number; end: number }> = [];
    for (const a of annotations) {
      const r = resolveAnchorOnPage(a, ctx);
      if (r) resolved.push({ id: a.id, start: r.cleanStart, end: r.cleanEnd });
    }

    const renderer = new MarkRenderer(doc);
    const ms = benchMs(() => {
      renderer.clear();
      renderer.renderBatch(resolved, ctx.page);
    });
    console.log(`  renderBatch    中位数: ${ms.toFixed(2)}ms   批注=${resolved.length}`);
  });

  it("renderAll: 完整一次（clear + invalidate + resolve×N + renderBatch）", () => {
    const { dom, body } = buildLargeDom();
    const doc = dom.window.document;
    const ctx = createPageContext(body);
    const annotations = makeAnnotations(ctx.page, ANNOTATION_COUNT);
    const renderer = new MarkRenderer(doc);

    const resolver = new PageResolver(body);
    // 预热
    for (const a of annotations) resolver.resolve(a as AnchorData);
    resolver.invalidate();

    const ms = benchMs(() => {
      renderer.clear();
      resolver.invalidate();
      const spans: Array<{ id: string; start: number; end: number }> = [];
      for (const a of annotations) {
        const r = resolver.resolve(a as AnchorData);
        if (r) spans.push({ id: a.id, start: r.cleanStart, end: r.cleanEnd });
      }
      if (spans.length) renderer.renderBatch(spans, resolver.getContext().page);
    });
    console.log(`  renderAll      中位数: ${ms.toFixed(2)}ms   批注=${annotations.length}`);
  });

  it("sameDoc: 50 批注的 JSON.stringify 深度比较", () => {
    const { body } = buildLargeDom();
    const page = buildPageText(body);
    const annotations = makeAnnotations(page, ANNOTATION_COUNT);

    const a: DocData = {
      url: "https://example.com/perf",
      title: "Perf Test",
      annotations,
    };
    const b: DocData = { ...a, annotations: annotations.map((x) => ({ ...x })) };

    const msJson = benchMs(() => {
      JSON.stringify(a) === JSON.stringify(b);
    });

    console.log(`  sameDoc(JSON)  中位数: ${msJson.toFixed(2)}ms   批注=${annotations.length}`);
  });
});
