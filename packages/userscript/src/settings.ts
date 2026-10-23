/**
 * 同步设置表单：注入到 AnnotatorUi 面板底部的 settings-slot。
 *
 * 原来的独立 FAB + 独立 Shadow DOM host 已合并进 AnnotatorUi：
 *   - ⚙ 触发按钮 → AnnotatorUi 的 panel header（点击 toggle slot）
 *   - 表单主体 → mountSettings(html) 注入到 panel 底部的 settings-slot
 *   - 事件绑定 → 调用方拿到 slot 后在其上 addEventListener
 *
 * 样式作为 <style> 标签一起注入 settings-slot。
 * 因为 slot 属于 AnnotatorUi 的 Shadow Root，Shadow DOM 内的 <style>
 * 只影响该 Shadow Root，自然实现样式隔离。
 *
 * token 纪律：
 *   - 输入框 type=password，保存后立即清空，绝不回显完整 token；
 *   - 已保存时只用 placeholder 提示「留空表示不修改」；
 *   - token 不进日志、不进构建产物（源码里没有任何硬编码凭证）；
 *   - 配置 key 与扩展共享 annotator:github-config，形状一致。
 */

import type { KVStore } from "@annotator/storage";
import { CONFIG_KEY } from "./platform.js";

/**
 * 表单 + 样式 HTML。挂载到 AnnotatorUi 的 Shadow Root 中，
 * 外层 slot 已经是 relative 流内元素，所以样式里不做 fixed 定位、
 * 也不需要 :host/all:initial 这类宿主清理。
 */
const SETTINGS_HTML = `
<style>
  form, .settings-actions, .settings-status {
    margin: 0; padding: 0;
  }
  .settings-title {
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 10px;
  }
  .settings-field {
    margin-bottom: 10px;
  }
  .settings-field label {
    display: block;
    font-size: 12px;
    color: var(--muted, #6b7280);
    margin-bottom: 4px;
  }
  .settings-field input {
    display: block;
    width: 100%;
    padding: 10px;
    min-height: 44px;
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 10px;
    background: var(--bg, #fff);
    color: var(--fg, #1f2328);
    font: inherit;
  }
  .settings-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .settings-actions button {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 10px;
    background: transparent;
    cursor: pointer;
  }
  .settings-actions .primary {
    background: var(--accent, #d97706);
    border-color: var(--accent, #d97706);
    color: #fff;
  }
  .settings-status {
    margin-top: 10px;
    font-size: 13px;
    color: var(--muted, #6b7280);
  }
  .settings-status.error { color: #dc2626; }
  .settings-hint {
    margin-top: 10px;
    font-size: 12px;
    color: var(--muted, #6b7280);
  }
</style>
<form class="settings-form">
  <div class="settings-title">同步设置</div>
  <div class="settings-field">
    <label>仓库所有者（owner）<input data-field="owner" autocomplete="off"></label>
  </div>
  <div class="settings-field">
    <label>仓库名（repo）<input data-field="repo" autocomplete="off"></label>
  </div>
  <div class="settings-field">
    <label>分支（branch）<input data-field="branch" autocomplete="off" placeholder="main"></label>
  </div>
  <div class="settings-field">
    <label>GitHub token<input data-field="token" type="password" autocomplete="off"></label>
  </div>
  <div class="settings-actions">
    <button type="button" data-action="clear-cache">清除本地缓存</button>
    <button type="button" class="primary" data-action="save">保存</button>
  </div>
  <div class="settings-status" data-status></div>
  <div class="settings-hint">token 只保存在本机 Userscripts 存储里；保存后输入框会清空，不会回显。</div>
</form>
`;

interface StoredConfig {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
}

export interface SettingsOptions {
  kv: KVStore;
  /** GM 环境不可用时的错误提示（需实测场景）。 */
  gmError?: string;
}

/**
 * 创建 settings 内容。返回 HTML + bind 函数。
 *
 * 用法：
 *   const { html, bind } = createSettingsContent({ kv, gmError });
 *   const slot = ui.mountSettings(html);
 *   bind(slot);  // 在 slot 上 addEventListener 绑定 save/clear/load
 *   ui.showSettingsButton();
 */
export function createSettingsContent(options: SettingsOptions): {
  html: string;
  bind(root: HTMLElement): void;
} {
  const { kv, gmError } = options;

  return {
    html: SETTINGS_HTML,
    bind(root: HTMLElement): void {
      bindSettingsRoot(root, kv, gmError);
    },
  };
}

function bindSettingsRoot(
  root: HTMLElement,
  kv: KVStore,
  gmError?: string
): void {
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  if (!statusEl) return;
  const field = (name: string): HTMLInputElement => {
    const el = root.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el) throw new Error(`settings: missing field ${name}`);
    return el;
  };

  let savedToken = "";

  function showStatus(message: string, isError = false): void {
    statusEl!.textContent = message;
    statusEl!.classList.toggle("error", isError);
  }

  async function load(): Promise<void> {
    if (gmError) {
      showStatus(gmError, true);
      return;
    }
    let config: StoredConfig = {};
    try {
      const raw = await kv.get(CONFIG_KEY);
      if (raw) config = JSON.parse(raw) as StoredConfig;
    } catch {
      showStatus("读取配置失败", true);
      return;
    }
    field("owner")!.value = config.owner ?? "";
    field("repo")!.value = config.repo ?? "";
    field("branch")!.value = config.branch ?? "main";
    savedToken = config.token ?? "";
    if (savedToken) {
      field("token")!.placeholder = "已保存，留空表示不修改";
    }
  }

  async function save(): Promise<void> {
    const owner = field("owner")!.value.trim();
    const repo = field("repo")!.value.trim();
    const branch = field("branch")!.value.trim() || "main";
    const token = field("token")!.value.trim() || savedToken;

    if (!owner || !repo) {
      showStatus("请填写仓库所有者和仓库名", true);
      return;
    }
    if (!token) {
      showStatus("请填写 token", true);
      return;
    }

    try {
      await kv.set(CONFIG_KEY, JSON.stringify({ owner, repo, branch, token }));
    } catch {
      showStatus("保存失败（GM 存储不可用，需实测）", true);
      return;
    }
    savedToken = token;
    field("token")!.value = "";
    field("token")!.placeholder = "已保存，留空表示不修改";
    showStatus("已保存");
  }

  /** 清除本机批注数据，保留 GitHub 凭证配置。 */
  async function clearCache(): Promise<void> {
    let keys: string[];
    try {
      keys = await kv.keys();
    } catch {
      showStatus("读取缓存列表失败", true);
      return;
    }
    const targets = keys.filter(
      (k) => k.startsWith("annotator:") && k !== CONFIG_KEY
    );
    if (targets.length === 0) {
      showStatus("本地没有批注缓存");
      return;
    }
    for (const key of targets) {
      try {
        await kv.delete(key);
      } catch {
        // 单个删除失败不阻塞其余
      }
    }
    showStatus(`已清除 ${targets.length} 条本地数据`);
  }

  // 打开 slot 时首次加载
  void load();

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest("[data-action]")?.getAttribute("data-action");
    switch (action) {
      case "save":
        void save();
        break;
      case "clear-cache":
        void clearCache();
        break;
    }
  });
}

/**
 * 保留旧 API 兼容已有调用点；新代码推荐用 createSettingsContent。
 * 这个版本仍会创建一个独立的 host + FAB——仅供向后兼容，
 * userscript main.ts 已不再使用。
 *
 * @deprecated 请用 createSettingsContent 配合 AnnotatorUi.mountSettings()
 */
export function initSettings(options: SettingsOptions): void {
  const { kv, gmError } = options;

  const host = document.createElement("div");
  host.setAttribute("data-annotator-settings", "");
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  // 独立 FAB + panel 的样式（不依赖 AnnotatorUi）
  const STYLE_TEXT = `
:host {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #6b7280;
  --border: #e5e7eb;
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
.fab {
  position: fixed;
  right: 16px;
  top: 96px;
  min-width: 48px;
  min-height: 48px;
  border: 0;
  border-radius: 24px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 20px;
  cursor: pointer;
  box-shadow: var(--shadow);
  pointer-events: auto;
}
.panel {
  position: fixed;
  left: 16px;
  right: 16px;
  top: 16px;
  max-width: 440px;
  margin: 0 auto;
  padding: 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  pointer-events: auto;
}
.panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 12px;
}
.icon-button {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
label {
  display: block;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--muted);
}
input {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 10px;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.actions button {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
}
.actions .primary {
  background: #d97706;
  border-color: #d97706;
  color: #fff;
}
.status { margin-top: 10px; font-size: 13px; color: var(--muted); }
.status.error { color: #dc2626; }
.hint { margin-top: 10px; font-size: 12px; color: var(--muted); }
`;

  shadow.innerHTML = `<style>${STYLE_TEXT}</style>
    <button type="button" class="fab" title="批注同步设置">⚙</button>
    <div class="panel" hidden>
      <header>
        <span>同步设置</span>
        <button type="button" class="icon-button" data-action="close" title="关闭">×</button>
      </header>
      <label>仓库所有者（owner）<input data-field="owner" autocomplete="off"></label>
      <label>仓库名（repo）<input data-field="repo" autocomplete="off"></label>
      <label>分支（branch）<input data-field="branch" autocomplete="off" placeholder="main"></label>
      <label>GitHub token<input data-field="token" type="password" autocomplete="off"></label>
      <div class="actions">
        <button type="button" data-action="clear-cache">清除本地缓存</button>
        <button type="button" class="primary" data-action="save">保存</button>
      </div>
      <div class="status" data-status></div>
      <div class="hint">token 只保存在本机 Userscripts 存储里；保存后输入框会清空，不会回显。</div>
    </div>`;

  const panel = shadow.querySelector<HTMLElement>(".panel")!;
  const statusEl = shadow.querySelector<HTMLElement>("[data-status]")!;
  const field = (name: string): HTMLInputElement =>
    shadow.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!;

  let savedToken = "";

  function showStatus(message: string, isError = false): void {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
  }

  async function load(): Promise<void> {
    if (gmError) {
      showStatus(gmError, true);
      return;
    }
    let config: StoredConfig = {};
    try {
      const raw = await kv.get(CONFIG_KEY);
      if (raw) config = JSON.parse(raw) as StoredConfig;
    } catch {
      showStatus("读取配置失败", true);
      return;
    }
    field("owner").value = config.owner ?? "";
    field("repo").value = config.repo ?? "";
    field("branch").value = config.branch ?? "main";
    savedToken = config.token ?? "";
    if (savedToken) {
      field("token").placeholder = "已保存，留空表示不修改";
    }
  }

  async function save(): Promise<void> {
    const owner = field("owner").value.trim();
    const repo = field("repo").value.trim();
    const branch = field("branch").value.trim() || "main";
    const token = field("token").value.trim() || savedToken;

    if (!owner || !repo) {
      showStatus("请填写仓库所有者和仓库名", true);
      return;
    }
    if (!token) {
      showStatus("请填写 token", true);
      return;
    }

    try {
      await kv.set(CONFIG_KEY, JSON.stringify({ owner, repo, branch, token }));
    } catch {
      showStatus("保存失败（GM 存储不可用，需实测）", true);
      return;
    }
    savedToken = token;
    field("token").value = "";
    field("token").placeholder = "已保存，留空表示不修改";
    showStatus("已保存");
  }

  async function clearCache(): Promise<void> {
    let keys: string[];
    try {
      keys = await kv.keys();
    } catch {
      showStatus("读取缓存列表失败", true);
      return;
    }
    const targets = keys.filter(
      (k) => k.startsWith("annotator:") && k !== CONFIG_KEY
    );
    if (targets.length === 0) {
      showStatus("本地没有批注缓存");
      return;
    }
    for (const key of targets) {
      try {
        await kv.delete(key);
      } catch {
        // 单个删除失败不阻塞其余
      }
    }
    showStatus(`已清除 ${targets.length} 条本地数据`);
  }

  shadow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest("[data-action]")?.getAttribute("data-action");
    switch (action) {
      case "close":
        panel.hidden = true;
        break;
      case "save":
        void save();
        break;
      case "clear-cache":
        void clearCache();
        break;
    }
  });

  shadow
    .querySelector(".fab")!
    .addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) void load();
    });
}
