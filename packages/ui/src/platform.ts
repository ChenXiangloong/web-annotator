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

/**
 * 一次同步请求的结果。
 *   idle   —— 未配置 GitHub，静默跳过，不算错误；
 *   ok     —— 拉取/上传都成功（或内容无变化）；
 *   failed —— 任意接口/网络错误，message 为可直接展示的原始错误文本。
 */
export type SyncOutcome =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "failed"; message: string };

export interface PlatformAdapter {
  /**
   * 文档/索引/队列使用的 KV 存储。
   * Chrome 扩展是 chrome.storage.local；Userscripts 是 GM_setValue 系。
   */
  readonly kv: KVStore;

  /**
   * 通知后台：拉远端最新版本合并到本地（通常页面加载完成后触发一次）。
   * 未配置 GitHub 时返回 { status: "idle" }。
   * 任何接口错误都必须通过 failed.message 回传给页面展示，不能静默吞掉。
   */
  requestSync(key: string): Promise<SyncOutcome>;

  /**
   * 通知后台：本地已写好，把它推进上传队列并立刻尝试 flush。
   * 与 requestSync 相同：失败必须把原始错误文本带回页面。
   */
  requestUpload(key: string): Promise<SyncOutcome>;

  /**
   * 监听某篇文档在 KV 里的变化（例如后台同步写回）。
   * 返回一个取消订阅函数。
   *
   * Chrome 扩展基于 chrome.storage.onChanged；Userscripts 单页面上下文
   * 通常没有跨上下文写入，可以实现为 no-op 返回 () => {}。
   */
  watchDoc(key: string, callback: () => void): () => void;
}
