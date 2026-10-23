/**
 * 高亮渲染接口。
 *
 * 当前实现用 <mark> 包裹文本，后续可以替换成 CSS Custom Highlight API，
 * 业务代码只依赖 HighlightRenderer。
 */

import type { PageText } from "@annotator/core";

export const MARK_CLASS = "annotator-mark";
const STYLE_ID = "annotator-highlight-style";

const STYLE_TEXT = `
mark.${MARK_CLASS} {
  background-color: rgba(255, 213, 79, 0.55) !important;
  color: inherit !important;
  padding: 0 !important;
  margin: 0 !important;
  border-radius: 2px !important;
  cursor: pointer !important;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
mark.${MARK_CLASS}:hover {
  background-color: rgba(255, 193, 7, 0.75) !important;
}
`;

/** 一个待渲染的高亮区间（正文文本净偏移，见 anchor.ts 的 ResolvedAnchor）。 */
export interface HighlightSpan {
  id: string;
  start: number;
  end: number;
}

export interface HighlightRenderer {
  /** 用高亮包住 range 覆盖的所有文本。 */
  render(annotationId: string, range: Range): void;
  /**
   * 批量渲染整页高亮。
   *
   * 必须先做完全部锚点解析再调用它：渲染会拆分文本节点，
   * 而 page.entries 引用的正是这些节点；边解析边渲染会让
   * 后续解析落到已失效的节点上（offset 越界）。
   */
  renderBatch(highlights: HighlightSpan[], page: PageText): void;
  /** 移除某条批注的高亮。 */
  remove(annotationId: string): void;
  /** 移除全部高亮（重新渲染前调用）。 */
  clear(): void;
  /** 从事件目标反查批注 id。 */
  getAnnotationId(target: EventTarget | null): string | null;
  /** 某条批注的第一个高亮元素（用于滚动定位）。 */
  elementFor(annotationId: string): HTMLElement | null;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/** 收集 Range 覆盖的所有文本片段（跨节点安全）。 */
function collectSegments(range: Range, doc: Document): TextSegment[] {
  const common = range.commonAncestorContainer;
  const walkerRoot =
    common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
  if (!walkerRoot) return [];

  const walker = doc.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      if (!text.data) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const segments: TextSegment[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const start =
      node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end > start) segments.push({ node, start, end });
    node = walker.nextNode() as Text | null;
  }
  return segments;
}

export class MarkRenderer implements HighlightRenderer {
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    this.ensureStyle();
  }

  render(annotationId: string, range: Range): void {
    const segments = collectSegments(range, this.doc);
    for (const segment of segments) {
      let node = segment.node;

      if (segment.start > 0) {
        node = node.splitText(segment.start);
      }
      const length = segment.end - segment.start;
      if (length < node.data.length) {
        node.splitText(length);
      }

      const mark = this.doc.createElement("mark");
      mark.className = MARK_CLASS;
      mark.setAttribute("data-annotation-id", annotationId);

      const parent = node.parentNode;
      if (!parent) continue;
      parent.insertBefore(mark, node);
      mark.appendChild(node);
    }
  }

  renderBatch(highlights: HighlightSpan[], page: PageText): void {
    for (const entry of page.entries) {
      const segments = highlights
        .filter((h) => h.end > entry.start && h.start < entry.end)
        .map((h) => ({
          id: h.id,
          start: Math.max(h.start, entry.start),
          end: Math.min(h.end, entry.end),
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      if (segments.length === 0) continue;
      this.wrapSegments(entry.node, entry.start, segments);
    }
  }

  /**
   * 在同一个原始文本节点上按净偏移依次包裹多个区间。
   * 从头到尾推进 tail：splitText 只影响当前节点之后的部分，
   * 其他 entry 的节点不受影响，因此可以安全地逐 entry 调用。
   * 重叠区间只标一次（后面的区间截断到已处理边界）。
   */
  private wrapSegments(
    node: Text,
    nodeCleanStart: number,
    segments: HighlightSpan[]
  ): void {
    let tail: Text | null = node;
    let base = nodeCleanStart;

    for (const segment of segments) {
      if (!tail || segment.end <= base) continue;
      const start = Math.max(segment.start, base);
      const relStart = start - base;
      if (relStart > 0) {
        tail = tail.splitText(relStart);
        base = start;
      }
      const length = segment.end - start;
      if (length <= 0) continue;

      const markedNode = tail;
      if (length < tail.data.length) {
        tail = tail.splitText(length);
      } else {
        tail = null;
      }
      base = segment.end;

      const parent = markedNode.parentNode;
      if (!parent) continue;
      const mark = this.doc.createElement("mark");
      mark.className = MARK_CLASS;
      mark.setAttribute("data-annotation-id", segment.id);
      parent.insertBefore(mark, markedNode);
      mark.appendChild(markedNode);
    }
  }

  remove(annotationId: string): void {
    const marks = this.marksFor(annotationId);
    this.unwrap(marks);
  }

  clear(): void {
    this.unwrap(Array.from(this.doc.querySelectorAll(`mark.${MARK_CLASS}`)));
  }

  getAnnotationId(target: EventTarget | null): string | null {
    const element = this.asElement(target);
    if (!element) return null;
    const mark = element.closest(`mark.${MARK_CLASS}`);
    return mark?.getAttribute("data-annotation-id") ?? null;
  }

  elementFor(annotationId: string): HTMLElement | null {
    return this.marksFor(annotationId)[0] ?? null;
  }

  private marksFor(annotationId: string): HTMLElement[] {
    return Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        `mark.${MARK_CLASS}[data-annotation-id="${annotationId}"]`
      )
    );
  }

  private unwrap(marks: Element[]): void {
    const parents = new Set<Node>();
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      mark.replaceWith(...Array.from(mark.childNodes));
      parents.add(parent);
    }
    for (const parent of parents) {
      parent.normalize();
    }
  }

  private asElement(target: EventTarget | null): Element | null {
    if (!target) return null;
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  }

  private ensureStyle(): void {
    if (this.doc.getElementById(STYLE_ID)) return;
    const style = this.doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (this.doc.head ?? this.doc.documentElement).appendChild(style);
  }
}
