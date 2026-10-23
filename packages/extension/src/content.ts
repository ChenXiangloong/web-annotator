/**
 * Chrome 扩展入口：薄壳。
 *
 * 职责只有三件：
 *   1. document_start 注入时立刻快照 URL——Substack 这类 SPA 会在
 *      脚本就绪后用 history.replaceState 改写地址，导致批注挂到
 *      错误的 key 上；
 *   2. 防重复注入；
 *   3. DOM 就绪后用 Chrome 版 PlatformAdapter 启动应用主体。
 *
 * 全部业务逻辑在 @annotator/ui 的 startAnnotatorApp 里。
 */

import { startAnnotatorApp } from "@annotator/ui";
import { createChromePlatform } from "./platform.js";

const LOADED_FLAG = "__annotatorContentLoaded";

/**
 * content script 以 document_start 注入（见 manifest.json），
 * 这里先冻结一份 URL 快照。main() 无论等到 DOMContentLoaded
 * 还是立即执行，都用这份快照。
 */
const INITIAL_URL = location.href;

async function main(): Promise<void> {
  if (window.top !== window.self) return;
  if (!document.body) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals[LOADED_FLAG]) return;
  globals[LOADED_FLAG] = true;

  await startAnnotatorApp({
    platform: createChromePlatform(),
    initialUrl: INITIAL_URL,
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void main(), {
    once: true,
  });
} else {
  void main();
}
