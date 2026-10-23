/**
 * 平台抽象：把「通知后台」「持久化 KV」「监听文档变化」这些平台差异
 * 从 content 逻辑里剥出来，让同一份 annotator-app 既能跑在 Chrome
 * MV3 content script 里，也能跑在 Userscripts（iOS Safari）里。
 *
 * 实现方：
 *   - packages/extension/src/platform.ts（chrome.runtime.sendMessage）
 *   - packages/userscript/src/platform.ts（直接调用本地 SyncEngine）
 */

import type { KVStore } from "@annotator/storage";

export interface PlatformAdapter {
  /**
   * 文档/索引/队列使用的 KV 存储。
   * Chrome 扩展是 chrome.storage.local；Userscripts 是 GM_setValue 系。
   */
  readonly kv: KVStore;

  /**
   * 通知后台：拉远端最新版本合并到本地（通常页面加载完成后触发一次）。
   * 未配置 GitHub 时实现方应静默忽略。
   */
  requestSync(key: string): void;

  /**
   * 通知后台：本地已写好，把它推进上传队列并立刻尝试 flush。
   */
  requestUpload(key: string): void;

  /**
   * 监听某篇文档在 KV 里的变化（例如后台同步写回）。
   * 返回一个取消订阅函数。
   *
   * Chrome 扩展基于 chrome.storage.onChanged；Userscripts 单页面上下文
   * 通常没有跨上下文写入，可以实现为 no-op 返回 () => {}。
   */
  watchDoc(key: string, callback: () => void): () => void;
}
