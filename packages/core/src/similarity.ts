/**
 * 文本相似度（用于模糊匹配后的校验）。
 * 用 diff-match-patch 的 diff + levenshtein 计算编辑距离，再归一化。
 */
import DiffMatchPatch from "diff-match-patch";

const dmp = new (DiffMatchPatch as unknown as new () => {
  diff_main(a: string, b: string): unknown;
  diff_levenshtein(diffs: unknown): number;
})();

/** 相似度 ∈ [0,1]：1 表示完全一致。 */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = dmp.diff_levenshtein(dmp.diff_main(a, b));
  return Math.max(0, 1 - distance / maxLen);
}

/** 默认阈值：改动不超过 30%。 */
export const DEFAULT_MIN_SIMILARITY = 0.7;

/** 短文本（<10 字）容错更低，避免短 quote 模糊到别处。 */
export const SHORT_QUOTE_LENGTH = 10;
export const SHORT_QUOTE_MIN_SIMILARITY = 0.8;

export function minSimilarityFor(quote: string): number {
  return quote.length < SHORT_QUOTE_LENGTH
    ? SHORT_QUOTE_MIN_SIMILARITY
    : DEFAULT_MIN_SIMILARITY;
}
