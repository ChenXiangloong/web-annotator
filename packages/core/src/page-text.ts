/**
 * 统一的「正文文本」入口。
 *
 * 为什么需要它：dom-anchor-text-quote 内部直接读 root.textContent，
 * 会把 <script>/<style>/隐藏元素里的文字也算进去，导致偏移量随页面结构漂移。
 * 这里遍历真实 DOM，只收集「可见正文」文本节点，并维护：
 *   - 净文本偏移（clean offset）：只统计可见文本
 *   - 原始文本偏移（raw offset）：统计所有文本节点，用于把 DOM Range 翻译成净偏移
 * 两套偏移一起用，才能既过滤噪声又不丢失 DOM 定位能力。
 */

/** 完全不参与正文的元素（内容、脚本、表单、媒体、我们自己的 UI 宿主）。 */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "CANVAS",
  "SVG",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "VIDEO",
  "AUDIO",
]);

/** 我们注入的 Shadow DOM 宿主标记，按属性排除。 */
export const UI_HOST_ATTR = "data-annotator-root";

export interface TextEntry {
  node: Text;
  /** 净文本中的起始偏移 */
  start: number;
  /** 净文本中的结束偏移 */
  end: number;
  /** 原始文本（含被跳过节点）中的起始偏移 */
  rawStart: number;
  rawEnd: number;
}

export interface PageText {
  text: string;
  entries: TextEntry[];
}

/** 元素是否应整棵跳过。 */
function shouldSkipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute(UI_HOST_ATTR)) return true;
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;

  const view = el.ownerDocument?.defaultView;
  const style =
    view && typeof view.getComputedStyle === "function"
      ? view.getComputedStyle(el)
      : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return true;
  }
  return false;
}

/**
 * 收集正文文本与偏移映射。
 * root 通常是 document.body。
 */
export function buildPageText(root: Node): PageText {
  const entries: TextEntry[] = [];
  let clean = 0;
  let raw = 0;

  const walk = (node: Node, visible: boolean): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const text = node as Text;
      const len = text.data.length;
      if (visible && len > 0) {
        entries.push({
          node: text,
          start: clean,
          end: clean + len,
          rawStart: raw,
          rawEnd: raw + len,
        });
        clean += len;
      }
      raw += len;
      return;
    }

    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;

    const el = node as Element;
    const childVisible = visible && !shouldSkipElement(el);
    for (const child of Array.from(el.childNodes)) {
      walk(child, childVisible);
    }
  };

  walk(root, true);

  const text = entries.length
    ? entries.map((e) => e.node.data).join("")
    : "";

  return { text, entries };
}

/**
 * 原始文本偏移 → 净文本偏移。
 * 落在被跳过区域时，返回最近的净文本边界（用于 describe 的容错）。
 */
export function cleanOffsetFromRaw(pt: PageText, rawOffset: number): number {
  for (let i = 0; i < pt.entries.length; i++) {
    const e = pt.entries[i];
    if (rawOffset >= e.rawStart && rawOffset < e.rawEnd) {
      return e.start + (rawOffset - e.rawStart);
    }
    if (rawOffset === e.rawEnd) {
      const next = pt.entries[i + 1];
      if (next && next.rawStart === rawOffset) return next.start;
      return e.end;
    }
  }
  return pt.text.length;
}

/** 净文本偏移 → 真实 DOM 位置（跨节点可用）。 */
export function domPositionFromCleanOffset(
  pt: PageText,
  offset: number
): { node: Text; offset: number } | null {
  if (pt.entries.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, pt.text.length));

  for (let i = 0; i < pt.entries.length; i++) {
    const e = pt.entries[i];
    if (clamped >= e.start && clamped < e.end) {
      return { node: e.node, offset: clamped - e.start };
    }
    if (clamped === e.end) {
      const next = pt.entries[i + 1];
      if (next && next.start === clamped) {
        return { node: next.node, offset: 0 };
      }
      return { node: e.node, offset: e.node.data.length };
    }
  }
  const last = pt.entries[pt.entries.length - 1];
  return { node: last.node, offset: last.node.data.length };
}

/** 净文本起点/终点 → DOM Range。 */
export function rangeFromCleanOffsets(
  pt: PageText,
  start: number,
  end: number
): Range | null {
  const s = domPositionFromCleanOffset(pt, start);
  const e = domPositionFromCleanOffset(pt, end);
  if (!s || !e) return null;

  const doc = s.node.ownerDocument;
  const range = doc.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}
