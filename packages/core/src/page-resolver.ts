/**
 * 页面级解析缓存。
 *
 * 一页只构建一次 PageContext（遍历全文），所有批注共享；
 * 单条批注的解析结果也缓存，避免侧边栏重绘时反复匹配。
 * 页面 DOM 发生变化（懒加载、内容更新）后调用 invalidate() 重来。
 */

import {
  createPageContext,
  describeOnPage,
  resolveAnchorOnPage,
  type AnchorData,
  type PageContext,
  type ResolvedAnchor,
} from "./anchor.js";
import type { Annotation } from "./types.js";

type AnchorFields = Pick<
  Annotation,
  "id" | "quote" | "prefix" | "suffix" | "pos_hint"
>;

export class PageResolver {
  private readonly root: Node;
  private ctx: PageContext | null = null;
  private readonly cache = new Map<string, ResolvedAnchor | null>();

  constructor(root: Node) {
    this.root = root;
  }

  /** 当前页面的上下文；首次调用时才遍历全文。 */
  getContext(): PageContext {
    if (!this.ctx) {
      this.ctx = createPageContext(this.root);
    }
    return this.ctx;
  }

  /** 丢弃上下文与所有解析缓存（DOM 变化后调用）。 */
  invalidate(): void {
    this.ctx = null;
    this.cache.clear();
  }

  /** 从 DOM Range 提取锚点，复用同一份页面上下文。 */
  describe(range: Range): AnchorData {
    return describeOnPage(range, this.getContext());
  }

  /** 解析一条批注；结果按 id 缓存。 */
  resolve(annotation: AnchorFields): ResolvedAnchor | null {
    const hit = this.cache.get(annotation.id);
    if (hit !== undefined) return hit;

    const result = resolveAnchorOnPage(annotation, this.getContext());
    this.cache.set(annotation.id, result);
    return result;
  }

  /** 单条批注内容变化时清掉它的缓存（例如重新保存锚点）。 */
  forget(annotationId: string): void {
    this.cache.delete(annotationId);
  }
}
