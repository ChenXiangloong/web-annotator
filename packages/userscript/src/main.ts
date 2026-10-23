/**
 * Userscripts 入口：薄壳。
 *
 * 与 Chrome content script 相同的纪律：
 *   1. @run-at document-start，脚本求值时立刻快照 URL——SPA 会在
 *      之后用 history.replaceState 改写地址，导致批注挂错 key；
 *   2. 防重复注入；
 *   3. DOM 就绪后启动应用主体 + 设置面板。
 *
 * iOS 上没有扩展的 devtools，因此这里带一个「启动自检徽标」：
 * 脚本一跑起来就在左下角显示一行状态，正常启动后自动消失，
 * 出错或 GM API 缺失时变红常驻。真机排查据此区分
 * 「没注入」/「注入后崩溃」/「GM 不可用」三种情况。
 */

import { startAnnotatorApp } from "@annotator/ui";
import type { KVStore } from "@annotator/storage";
import { gmAvailable, gmDebugSummary } from "./gm.js";
import { createUserscriptPlatform } from "./platform.js";
import { createSettingsContent } from "./settings.js";

const LOADED_FLAG = "__annotatorUserscriptLoaded";
const FLUSH_INTERVAL_MS = 60 * 1000;

/** document_start 时冻结的 URL 快照。 */
const INITIAL_URL = location.href;

let bootEl: HTMLElement | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 页面左上角的自检徽标。
 * 注意：必须在顶部——iPhone Safari 的底部工具栏会完全遮挡 bottom 定位的元素
 * （真机实测：bottom:8px 的徽标不可见，误判为脚本没运行）。
 */
function boot(text: string, isError = false): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (!bootEl) {
    const el = document.createElement("div");
    el.setAttribute("data-annotator-boot", "");
    el.style.cssText = [
      "position:fixed",
      "left:8px",
      "top:8px",
      "z-index:2147483647",
      "max-width:90vw",
      "padding:6px 10px",
      "border-radius:8px",
      "color:#fff",
      "background:#1f2937",
      "font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.3)",
      "pointer-events:none",
      "white-space:pre-wrap",
    ].join(";");
    document.documentElement.appendChild(el);
    bootEl = el;
  }
  bootEl.textContent = text;
  bootEl.style.background = isError ? "#dc2626" : "#1f2937";
}

/** 启动成功后延时移除徽标。 */
function dismissBoot(delay = 1500): void {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = setTimeout(() => {
    bootEl?.remove();
    bootEl = null;
    bootTimer = null;
  }, delay);
}

/** GM 不可用时的空实现，只让设置面板能显示错误说明。 */
const stubKV: KVStore = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  keys: () => Promise.resolve([]),
};

async function main(): Promise<void> {
  if (window.top !== window.self) return;
  if (!document.body) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals[LOADED_FLAG]) return;
  globals[LOADED_FLAG] = true;

  const available = gmAvailable();
  boot(`annotator 已注入\n${gmDebugSummary()}`);
  console.log("[annotator] injected", location.href, gmDebugSummary());

  const platform = createUserscriptPlatform();

  if (!available) {
    boot("annotator：GM API 不可用，批注无法保存\n" + gmDebugSummary(), true);
    console.error("[annotator] GM API 不可用", gmDebugSummary());
    return;
  }

  try {
    const handle = await startAnnotatorApp({
      platform,
      initialUrl: INITIAL_URL,
    });
    if (!handle) return;

    // 把 settings 表单挂进 AnnotatorUi 面板底部的 slot，
    // 触发按钮由 AnnotatorUi 在 panel header 里控制。
    const { html, bind } = createSettingsContent({ kv: platform.kv });
    const slot = handle.ui.mountSettings(html);
    bind(slot);
    handle.ui.showSettingsButton();
  } catch (error) {
    // 真机上看不到控制台，把失败原因直接显示在页面上。
    const message = error instanceof Error ? error.message : String(error);
    boot("annotator 启动失败\n" + message, true);
    console.error("[annotator] 启动失败", error);
    return;
  }

  boot("annotator 已就绪");
  dismissBoot();

  window.setInterval(() => platform.flush(), FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") platform.flush();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void main(), {
    once: true,
  });
} else {
  void main();
}
