/**
 * 锚点保存与恢复。
 *
 * 业务代码只应依赖本文件导出的 describe / resolve / resolveAnchor / createPageContext，
 * 不要直接 import dom-anchor-text-quote 或 dom-anchor-text-position。
 *
 * 文本基准：由 page-text.ts 收集的「正文文本」（排除 script/style/隐藏元素/我们注入的 UI）。
 * 定位库本身只认 root.textContent，因此把净文本放进一个 detached 元素交给它做匹配，
 * 再把结果偏移映射回真实 DOM。这样偏移量与匹配结果都不受噪声节点影响。
 *
 * 三级匹配：
 *   1. 精确：库定位成功，且切片与 quote 逐字相等
 *   2. 模糊：库定位成功，切片与 quote 有差异，但相似度达到阈值
 *   3. 孤立：库返回 null，或相似度不达标（避免匹配到毫不相干的位置）
 */

import { toTextPosition } from "dom-anchor-text-quote";
import * as textPosition from "dom-anchor-text-position";
import type { Annotation } from "./types.js";
import {
  buildPageText,
  cleanOffsetFromRaw,
  rangeFromCleanOffsets,
  type PageText,
} from "./page-text.js";
import {
  minSimilarityFor,
  similarityRatio,
} from "./similarity.js";

export interface AnchorData {
  quote: string;
  prefix: string;
  suffix: string;
  /** quote 起点在「空白折叠后的正文文本」中的字符偏移 */
  pos_hint: number;
}

export type MatchLevel = "exact" | "fuzzy";

export interface ResolvedAnchor {
  range: Range;
  level: MatchLevel;
  /** 实际匹配到的文本（用于调试/侧边栏展示） */
  matched: string;
  /**
   * 匹配区间在正文文本中的净偏移。
   * 批量渲染高亮时必须用这两个值：渲染会拆分文本节点，
   * 共享的 Range / 页面上下文在渲染过程中会失效，净偏移不会。
   */
  cleanStart: number;
  cleanEnd: number;
}

/**
 * 一次页面解析的上下文。
 * 同一页面只构建一次，所有批注共享，避免每条批注重复遍历全文。
 */
export interface PageContext {
  root: Node;
  page: PageText;
  /** 交给定位库使用的 detached 文本根（textContent === page.text） */
  matchingRoot: HTMLElement;
}

const CONTEXT_LENGTH = 30;

/** 空白归一化：连续空白折叠为一个空格，不 trim，保证偏移与原文对应。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function collapsedOffset(raw: string, rawOffset: number): number {
  return collapseWhitespace(raw.slice(0, rawOffset)).length;
}

/** 折叠后偏移 → 原文偏移（供定位库的 hint 使用）。 */
export function rawOffsetFromCollapsed(raw: string, collapsed: number): number {
  let count = 0;
  let i = 0;
  while (i < raw.length) {
    if (count === collapsed) return i;
    if (/\s/.test(raw[i])) {
      while (i < raw.length && /\s/.test(raw[i])) i++;
      count++;
    } else {
      i++;
      count++;
    }
  }
  return raw.length;
}

/** 建立页面上下文（正文文本 + 定位库用的文本根）。 */
export function createPageContext(root: Node): PageContext {
  const page = buildPageText(root);
  const doc = root.ownerDocument ?? document;
  const matchingRoot = doc.createElement("div");
  matchingRoot.textContent = page.text;
  return { root, page, matchingRoot };
}

/** 从 DOM Range 提取锚点（基于已构建的页面上下文）。 */
export function describeOnPage(range: Range, ctx: PageContext): AnchorData {
  if (!range || range.collapsed) {
    throw new Error("describe: range is empty");
  }

  const raw = textPosition.fromRange(ctx.root, range);
  const start = cleanOffsetFromRaw(ctx.page, raw.start);
  const end = cleanOffsetFromRaw(ctx.page, raw.end);
  if (end <= start) throw new Error("describe: range has no visible text");

  const text = ctx.page.text;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_LENGTH)),
    pos_hint: collapsedOffset(text, start),
  };
}

/** 从 DOM Range 提取锚点（内部构建一次性上下文，便于测试/单次调用）。 */
export function describe(range: Range, root: Node): AnchorData {
  return describeOnPage(range, createPageContext(root));
}

/**
 * 在已构建的页面上下文上恢复锚点。
 * 返回 null 表示孤立批注。
 *
 * 定位策略：
 *   1. 先在正文文本里找出 quote 的全部精确出现位置，用 prefix/suffix/pos_hint
 *      打分挑最合适的一个 —— 这一步不依赖 hint，页面顶部插入内容也不会漏。
 *   2. 没有精确出现时，再交给 dom-anchor-text-quote 做模糊定位；hint 依次尝试
 *      pos_hint、页面中点、prefix 的出现位置（prefix/suffix 粗定位）。
 *   3. 模糊结果还要过相似度阈值，避免匹配到无关位置。
 */
export function resolveAnchorOnPage(
  annotation: Pick<Annotation, "quote" | "prefix" | "suffix" | "pos_hint">,
  ctx: PageContext
): ResolvedAnchor | null {
  const quote = annotation.quote;
  if (!quote) return null;

  const text = ctx.page.text;
  if (!text) return null;

  // ---- 第一级：精确出现 ----
  const exact = findExactCandidates(text, quote)
    .map((start) => ({
      start,
      score: scoreCandidate(text, start, quote, annotation),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (exact) {
    const range = rangeFromCleanOffsets(ctx.page, exact.start, exact.start + quote.length);
    if (range) {
      return {
        range,
        level: "exact",
        matched: quote,
        cleanStart: exact.start,
        cleanEnd: exact.start + quote.length,
      };
    }
  }

  // ---- 第二级：模糊定位 ----
  const minSim = minSimilarityFor(quote);
  const hints = buildHints(text, annotation);
  let best: { start: number; end: number; matched: string; similarity: number; score: number } | null = null;

  for (const hint of hints) {
    let position: { start: number; end: number } | null;
    try {
      position = toTextPosition(
        ctx.matchingRoot,
        {
          exact: quote,
          prefix: annotation.prefix || undefined,
          suffix: annotation.suffix || undefined,
        },
        { hint }
      );
    } catch {
      continue;
    }
    if (!position || position.start >= position.end) continue;

    const matched = text.slice(position.start, position.end);
    const similarity = similarityRatio(matched, quote);
    if (similarity < minSim) continue;

    const score = similarity * 1000 + scoreCandidate(text, position.start, quote, annotation);
    if (!best || score > best.score) {
      best = { ...position, matched, similarity, score };
    }
  }

  if (!best) return null;

  const range = rangeFromCleanOffsets(ctx.page, best.start, best.end);
  if (!range) return null;

  return {
    range,
    level: "fuzzy",
    matched: best.matched,
    cleanStart: best.start,
    cleanEnd: best.end,
  };
}

/** quote 在正文文本中的所有精确出现位置。 */
function findExactCandidates(text: string, quote: string): number[] {
  const starts: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const at = text.indexOf(quote, from);
    if (at === -1) break;
    starts.push(at);
    from = at + 1;
  }
  return starts;
}

/**
 * 候选位置打分：前后文一致加分，离 pos_hint 越近加分。
 * 用于“同一句话出现多次”时挑出用户当初划的那一处。
 */
function scoreCandidate(
  text: string,
  start: number,
  quote: string,
  annotation: Pick<Annotation, "prefix" | "suffix" | "pos_hint">
): number {
  let score = 0;

  if (annotation.prefix) {
    const actual = text.slice(Math.max(0, start - annotation.prefix.length), start);
    score += commonSuffixLength(actual, annotation.prefix) * 2;
    if (actual === annotation.prefix) score += 500;
  }
  if (annotation.suffix) {
    const actual = text.slice(start + quote.length, start + quote.length + annotation.suffix.length);
    score += commonPrefixLength(actual, annotation.suffix) * 2;
    if (actual === annotation.suffix) score += 500;
  }

  const distance = Math.abs(collapsedOffset(text, start) - annotation.pos_hint);
  score -= Math.min(distance, 10000) * 0.05;
  return score;
}

/** 模糊定位的 hint 候选：pos_hint → 页面中点 → prefix 出现位置。 */
function buildHints(
  text: string,
  annotation: Pick<Annotation, "prefix" | "pos_hint">
): number[] {
  const hints = new Set<number>();
  hints.add(rawOffsetFromCollapsed(text, annotation.pos_hint));
  hints.add(Math.floor(text.length / 2));

  const prefix = annotation.prefix;
  if (prefix) {
    let from = 0;
    let found = 0;
    while (found < 5) {
      const at = text.indexOf(prefix, from);
      if (at === -1) break;
      hints.add(at + prefix.length);
      from = at + 1;
      found++;
    }
  }

  return Array.from(hints).filter((h) => h >= 0 && h <= text.length);
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** 恢复锚点（内部构建一次性上下文）。 */
export function resolveAnchor(
  annotation: Pick<Annotation, "quote" | "prefix" | "suffix" | "pos_hint">,
  root: Node
): ResolvedAnchor | null {
  return resolveAnchorOnPage(annotation, createPageContext(root));
}

/** 恢复锚点，只要 Range。三级匹配：精确 → 模糊 → null（孤立）。 */
export function resolve(
  annotation: Pick<Annotation, "quote" | "prefix" | "suffix" | "pos_hint">,
  root: Node
): Range | null {
  return resolveAnchor(annotation, root)?.range ?? null;
}
