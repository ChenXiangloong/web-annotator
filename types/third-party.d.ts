/**
 * 第三方锚点库的类型声明。
 * 这些包都不带 TS 类型，这里只声明我们实际用到的 API。
 */

declare module "dom-anchor-text-quote" {
  export interface TextQuoteSelector {
    exact: string;
    prefix?: string;
    suffix?: string;
  }

  export interface TextPosition {
    start: number;
    end: number;
  }

  export interface ResolveOptions {
    /** 优先选择靠近该字符偏移的匹配 */
    hint?: number;
  }

  export function fromRange(root: Node, range: Range): TextQuoteSelector;
  export function fromTextPosition(
    root: Node,
    selector: TextPosition
  ): TextQuoteSelector;
  export function toTextPosition(
    root: Node,
    selector: TextQuoteSelector,
    options?: ResolveOptions
  ): TextPosition | null;
  export function toRange(
    root: Node,
    selector: TextQuoteSelector,
    options?: ResolveOptions
  ): Range | null;
}

declare module "dom-anchor-text-position" {
  export interface TextPosition {
    start: number;
    end: number;
  }
  export function fromRange(root: Node, range: Range): TextPosition;
  export function toRange(root: Node, selector: TextPosition): Range | null;
}

declare module "diff-match-patch" {
  /** 仅声明我们用到的两个方法。 */
  export default class DiffMatchPatch {
    diff_main(a: string, b: string): unknown;
    diff_levenshtein(diffs: unknown): number;
    match_main(text: string, pattern: string, loc: number): number;
    Match_Distance: number;
  }
}
