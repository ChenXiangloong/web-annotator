/**
 * Chrome MV3 的 PlatformAdapter 实现。
 *
 * content script 自己不发起网络请求：
 *   - requestSync / requestUpload 只是给 service worker 发消息，
 *     由后台（background.ts）读写 GitHub、维护上传队列；
 *   - watchDoc 基于 chrome.storage.onChanged，后台同步写回本地缓存后
 *     通知页面重新渲染。
 */

import type { PlatformAdapter } from "@annotator/ui";
import type { KVStore } from "@annotator/storage";
import { ChromeStorageKVStore } from "./kv.js";

const DOC_STORAGE_PREFIX = "annotator:doc:";

/**
 * 交给 service worker 处理，content script 自己不发网络请求。
 * 扩展上下文失效（开发时重载）时静默忽略。
 */
function postToBackground(message: { type: string; key: string }): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  try {
    const pending = chrome.runtime.sendMessage(message) as unknown;
    if (pending && typeof (pending as Promise<unknown>).catch === "function") {
      (pending as Promise<unknown>).catch(() => {});
    }
  } catch {
    // 忽略：下一次页面加载会继续同步
  }
}

export function createChromePlatform(): PlatformAdapter {
  const kv: KVStore = new ChromeStorageKVStore();

  return {
    kv,

    requestSync(key: string): void {
      postToBackground({ type: "annotator:sync", key });
    },

    requestUpload(key: string): void {
      postToBackground({ type: "annotator:save", key });
    },

    watchDoc(key: string, callback: () => void): () => void {
      if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
        return () => {};
      }
      const listener = (
        changes: Record<string, unknown>,
        areaName: string
      ): void => {
        if (areaName !== "local") return;
        if (
          !Object.prototype.hasOwnProperty.call(changes, DOC_STORAGE_PREFIX + key)
        ) {
          return;
        }
        callback();
      };
      chrome.storage.onChanged.addListener(listener);
      return () => {
        chrome.storage.onChanged.removeListener(listener);
      };
    },
  };
}
