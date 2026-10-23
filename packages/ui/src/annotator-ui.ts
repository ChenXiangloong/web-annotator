/**
 * 页面内 UI：全部放在一个 Shadow DOM 里，避免页面样式互相污染。
 *
 * 结构：
 *   浮动工具栏（选中文本后出现）
 *   右下角按钮（打开批注列表）
 *   侧边栏（桌面）／底部抽屉（窄屏）
 *   批注编辑器
 *   轻提示
 */

import { UI_HOST_ATTR, type Annotation } from "@annotator/core";

export interface UiHandlers {
  /** 点击“划线”：直接保存一条无想法的划线 */
  onStartHighlight(): void;
  /** 点击“写想法”：打开编辑器 */
  onStartComment(): void;
  /** 编辑器里保存新批注 */
  onCreateWithComment(comment: string): void;
  /** 编辑器里保存已有批注 */
  onUpdateComment(id: string, comment: string): void;
  /** 删除批注 */
  onDelete(id: string): void;
  /** 点击列表项 */
  onSelect(id: string): void;
}

const STYLE_TEXT = `
:host {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #6b7280;
  --border: #e5e7eb;
  --hover: rgba(0, 0, 0, 0.05);
  --accent: #d97706;
  --shadow: 0 10px 40px rgba(0, 0, 0, 0.18);

  all: initial;
  position: fixed;
  display: block;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #1f2937;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --hover: rgba(255, 255, 255, 0.08);
    --shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }
button {
  font: inherit;
  color: inherit;
  -webkit-tap-highlight-color: transparent;
}
[hidden] { display: none !important; }

.toolbar {
  position: fixed;
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  pointer-events: auto;
}
.toolbar button {
  min-height: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}
.toolbar button:hover { background: var(--hover); }
.toolbar button.primary { background: var(--accent); color: #fff; }
.toolbar button.primary:hover { filter: brightness(1.05); }

.fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  min-width: 48px;
  min-height: 48px;
  padding: 0 18px;
  border: 0;
  border-radius: 24px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow);
  pointer-events: auto;
}

.panel {
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  overflow: hidden;
  pointer-events: auto;
}
.panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.panel header .count { color: var(--muted); font-weight: 400; }
.panel header .header-actions {
  display: flex;
  gap: 2px;
}
.icon-button {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.icon-button:hover { background: var(--hover); }

.settings-slot {
  /* 紧贴 header 底部：去掉 border-top / padding-top，
     header 自身的 border-bottom 已经是 slot 上方的自然分隔。 */
  padding: 0 14px 14px 14px;
  border-top: none;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.item {
  position: relative;
  padding: 10px 36px 10px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.item:hover { background: var(--hover); }
.item + .item { margin-top: 4px; }
.item .quote {
  font-size: 13px;
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.item .comment {
  color: var(--muted);
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.item .meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
}
.item.orphan { opacity: 0.5; }
.empty {
  padding: 24px 16px;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
}

.editor {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  width: min(440px, calc(100vw - 32px));
  padding: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  pointer-events: auto;
}
.editor .editor-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.editor .editor-quote {
  max-height: 108px;
  overflow-y: auto;
  padding: 8px 10px;
  margin-bottom: 10px;
  border-left: 3px solid var(--accent);
  background: var(--hover);
  border-radius: 4px;
  color: var(--muted);
  font-size: 13px;
}
.editor textarea {
  width: 100%;
  min-height: 96px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  resize: vertical;
}
.editor .actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}
.editor .actions button {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
}
.editor .actions .primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.editor .actions .danger { color: #dc2626; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  max-width: 80vw;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgba(31, 41, 55, 0.95);
  color: #fff;
  font-size: 13px;
  pointer-events: none;
}

@media (max-width: 768px) {
  .panel {
    top: auto;
    left: 0;
    right: 0;
    /* iOS Safari 底部工具栏 + home indicator 约 80-100px，
       真机实测 bottom:0 会被完全遮挡；这里整体上移。 */
    bottom: max(80px, env(safe-area-inset-bottom));
    width: auto;
    height: 60vh;
    border-radius: 16px 16px 0 0;
  }
  .editor { bottom: 72px; }
}
`;

function text(tag: string, className: string, content: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = content;
  return el;
}

export class AnnotatorUi {
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly handlers: UiHandlers;
  private readonly doc: Document;

  private readonly toolbar: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fab: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly editor: HTMLElement;
  private readonly editorTitle: HTMLElement;
  private readonly editorQuote: HTMLElement;
  private readonly editorTextarea: HTMLTextAreaElement;
  private readonly editorDelete: HTMLButtonElement;
  private readonly toastEl: HTMLElement;
  private readonly settingsToggle: HTMLElement;
  private readonly settingsSlot: HTMLElement;

  private editorId: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: UiHandlers, doc: Document = document) {
    this.handlers = handlers;
    this.doc = doc;

    this.host = doc.createElement("div");
    this.host.setAttribute(UI_HOST_ATTR, "");
    doc.documentElement.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `<style>${STYLE_TEXT}</style>
      <div class="toolbar" role="toolbar" hidden>
        <button type="button" data-action="highlight" class="primary">划线</button>
        <button type="button" data-action="comment">写想法</button>
      </div>
      <button type="button" class="fab" data-action="toggle-panel" title="打开批注列表">批注</button>
      <aside class="panel" hidden>
        <header>
          <span>批注 <span class="count">0</span></span>
          <div class="header-actions">
            <button type="button" class="icon-button settings-toggle" data-action="open-settings" hidden title="同步设置">⚙</button>
            <button type="button" class="icon-button" data-action="close-panel" title="关闭">×</button>
          </div>
        </header>
        <div class="settings-slot" hidden></div>
        <div class="list"></div>
      </aside>
      <div class="editor" hidden>
        <div class="editor-title">写想法</div>
        <div class="editor-quote"></div>
        <textarea placeholder="写下你的想法……" aria-label="批注内容"></textarea>
        <div class="actions">
          <button type="button" class="danger" data-action="delete-editor">删除</button>
          <button type="button" data-action="cancel">取消</button>
          <button type="button" class="primary" data-action="save">保存</button>
        </div>
      </div>
      <div class="toast" hidden></div>`;

    this.toolbar = this.query(".toolbar");
    this.panel = this.query(".panel");
    this.list = this.query(".list");
    this.fab = this.query(".fab");
    this.countEl = this.query(".count");
    this.editor = this.query(".editor");
    this.editorTitle = this.query(".editor-title");
    this.editorQuote = this.query(".editor-quote");
    this.editorTextarea = this.query("textarea");
    this.editorDelete = this.query('[data-action="delete-editor"]');
    this.toastEl = this.query(".toast");
    this.settingsToggle = this.query(".settings-toggle");
    this.settingsSlot = this.query(".settings-slot");

    this.shadow.addEventListener("click", this.onClick);
    this.editorTextarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeEditor();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitEditor();
      }
    });
  }

  /** 在选区上方（空间不足时下方）显示工具栏。 */
  showToolbar(rect: DOMRectReadOnly): void {
    this.toolbar.hidden = false;
    const halfWidth = this.toolbar.offsetWidth
      ? this.toolbar.offsetWidth / 2
      : 92;
    const margin = 8;
    const viewportWidth =
      this.doc.defaultView?.innerWidth ?? rect.right + halfWidth;
    const center = rect.left + rect.width / 2;
    const left = Math.max(
      halfWidth + margin,
      Math.min(center, viewportWidth - halfWidth - margin)
    );
    const above = rect.top > 72;
    const top = above ? rect.top - 8 : rect.bottom + 8;

    this.toolbar.style.left = `${left}px`;
    this.toolbar.style.top = `${top}px`;
    this.toolbar.style.transform = above
      ? "translate(-50%, -100%)"
      : "translate(-50%, 0)";
  }

  hideToolbar(): void {
    this.toolbar.hidden = true;
  }

  /** 打开编辑器。id 为 null 时表示新建。 */
  openEditor(params: {
    id: string | null;
    quote: string;
    comment: string;
  }): void {
    this.editorId = params.id;
    this.editorTitle.textContent = params.id ? "编辑批注" : "写想法";
    this.editorQuote.textContent = params.quote;
    this.editorTextarea.value = params.comment;
    this.editorDelete.hidden = params.id === null;
    this.editor.hidden = false;
    this.editorTextarea.focus({ preventScroll: true });
  }

  closeEditor(): void {
    this.editor.hidden = true;
    this.editorId = null;
    this.editorTextarea.value = "";
  }

  setAnnotations(annotations: Annotation[], orphanIds: Set<string>): void {
    const sorted = annotations
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    this.list.replaceChildren();
    if (sorted.length === 0) {
      this.list.appendChild(
        text("div", "empty", "还没有批注。选中文字后点“划线”。")
      );
    }

    for (const annotation of sorted) {
      const item = document.createElement("div");
      item.className = `item${orphanIds.has(annotation.id) ? " orphan" : ""}`;
      item.setAttribute("data-action", "select");
      item.setAttribute("data-id", annotation.id);
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");

      item.appendChild(text("div", "quote", annotation.quote));
      item.appendChild(
        text(
          "div",
          "comment",
          annotation.comment || "（无想法，纯划线）"
        )
      );
      const meta = text(
        "div",
        "meta",
        orphanIds.has(annotation.id)
          ? "原文已找不到"
          : annotation.created_at.slice(0, 10)
      );
      item.appendChild(meta);

      this.list.appendChild(item);
    }

    this.updateCount(sorted.length);
  }

  showPanel(): void {
    this.panel.hidden = false;
  }

  hidePanel(): void {
    this.panel.hidden = true;
  }

  togglePanel(): void {
    this.panel.hidden = !this.panel.hidden;
  }

  toast(message: string, duration = 2200): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    this.toastTimer = setTimeout(() => {
      this.toastEl.hidden = true;
      this.toastTimer = null;
    }, duration);
  }

  destroy(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.host.remove();
  }

  /**
   * 让面板 header 里的 ⚙ 按钮可见——默认隐藏（非同步场景如 Chrome 扩展不需要）。
   * 调用后按钮出现在 × 关闭按钮左边，点击可 toggle settings slot。
   */
  showSettingsButton(): void {
    this.settingsToggle.hidden = false;
  }

  /**
   * 把一段 HTML（含 style + 表单）注入到 panel 底部的 settings-slot。
   * HTML 里使用 data-action="..." 标记交互元素，外部随后调用方应在
   * settingsSlot 上 addEventListener 绑定业务逻辑。
   *
   * 每次 mount 会覆盖旧内容，因此先 unmount 再 mount 是幂等的。
   */
  mountSettings(html: string): HTMLElement {
    this.settingsSlot.innerHTML = html;
    return this.settingsSlot;
  }

  toggleSettings(): void {
    this.settingsSlot.hidden = !this.settingsSlot.hidden;
  }

  hideSettings(): void {
    this.settingsSlot.hidden = true;
  }

  private readonly onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionEl = target.closest("[data-action]") as HTMLElement | null;
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;

    switch (action) {
      case "highlight":
        this.hideToolbar();
        this.handlers.onStartHighlight();
        break;
      case "comment":
        this.hideToolbar();
        this.handlers.onStartComment();
        break;
      case "toggle-panel":
        this.togglePanel();
        break;
      case "close-panel":
        this.hidePanel();
        break;
      case "open-settings":
        this.toggleSettings();
        break;
      case "save":
        this.commitEditor();
        break;
      case "cancel":
        this.closeEditor();
        break;
      case "delete-editor":
        this.deleteFromEditor();
        break;
      case "select":
        if (id) this.handlers.onSelect(id);
        break;
    }
  };

  private commitEditor(): void {
    if (this.editor.hidden) return;
    const comment = this.editorTextarea.value.trim();
    const id = this.editorId;
    this.closeEditor();
    if (id) {
      this.handlers.onUpdateComment(id, comment);
    } else {
      this.handlers.onCreateWithComment(comment);
    }
  }

  private deleteFromEditor(): void {
    const id = this.editorId;
    if (!id || !this.confirmDelete()) return;
    this.closeEditor();
    this.handlers.onDelete(id);
  }

  private confirmDelete(): boolean {
    return this.doc.defaultView?.confirm("删除这条批注？") ?? true;
  }

  private updateCount(count: number): void {
    this.fab.textContent = count > 0 ? `批注 ${count}` : "批注";
    this.countEl.textContent = String(count);
  }

  private query<T extends Element>(selector: string): T {
    const el = this.shadow.querySelector<T>(selector);
    if (!el) throw new Error(`AnnotatorUi: missing ${selector}`);
    return el;
  }
}
