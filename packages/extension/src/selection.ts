/**
 * 选区守卫：决定一次选区是否属于"可以划线的正文"。
 */

import { UI_HOST_ATTR } from "@annotator/core";

const BLOCKED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION"]);

/**
 * 输入框、可编辑区域、我们自己的 UI（Shadow DOM）、页面自身的 Shadow DOM
 * 以及游离节点都不允许触发划线。
 */
export function isBlockedSelection(node: Node | null): boolean {
  if (!node) return true;

  // Shadow DOM（包括我们注入的 UI）与游离节点：getRootNode 不等于文档
  if (node.getRootNode() !== node.ownerDocument) return true;

  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el) {
    if (BLOCKED_TAGS.has(el.tagName)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (
      el.hasAttribute("contenteditable") &&
      el.getAttribute("contenteditable") !== "false"
    ) {
      return true;
    }
    if (el.hasAttribute(UI_HOST_ATTR)) return true;
    el = el.parentElement;
  }
  return false;
}

/** 事件是否发生在我们的 UI 里（Shadow DOM 会被重定向到宿主）。 */
export function isUiEvent(event: Event): boolean {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.some(
    (node) => node instanceof Element && node.hasAttribute(UI_HOST_ATTR)
  );
}

/** 当前文档里可用于划线的非空选区；不可用时返回 null。 */
export function currentSelectionRange(doc: Document = document): Range | null {
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !range.toString().trim()) return null;
  if (!doc.body?.contains(range.commonAncestorContainer)) return null;
  if (isBlockedSelection(range.commonAncestorContainer)) return null;
  return range;
}
