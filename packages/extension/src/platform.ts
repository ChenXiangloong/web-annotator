/**
 * Chrome MV3 的 PlatformAdapter 实现。
 *
 * content script 自己不发起网络请求：
 *   - requestSync / requestUpload 只是给 service worker 发消息，
 *     由后台（background.ts）读写 GitHub、维护上传队列；
 *   - watchDoc 基于 chrome.storage.onChanged，后台同步写回本地缓存后
 *     通知页面重新渲染。
 *
 * 任何接口/网络错误都必须通过 SyncOutcome 回传给页面展示——
 * 以前的实现直接丢弃 sendResponse，导致限流、token 失效等完全静默。
 */

import type { PlatformAdapter, SyncOutcome } from "@annotator/ui";
import type { KVStore } from "@annotator/storage";
import { ChromeStorageKVStore } from "./kv.js";

const DOC_STORAGE_PREFIX = "annotator:doc:";

interface BackgroundReply {
  ok?: boolean;
  configured?: boolean;
  error?: string;
  errors?: Array<{ key?: string; message?: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把后台返回的结构化结果翻译成页面可直接展示的状态。 */
function toOutcome(reply: unknown): SyncOutcome {
  if (!reply || typeof reply !== "object") {
    return { status: "failed", message: "扩展后台未返回同步结果" };
  }
  const result = reply as BackgroundReply;

  // 未配置 GitHub：不算错误，界面保持安静。
  if (result.configured === false) return { status: "idle" };

  if (result.ok === false) {
    return {
      status: "failed",
      message: result.error || "同步失败（后台未提供原因）",
    };
  }

  const messages = (result.errors ?? [])
    .map((item) => item.message?.trim())
    .filter((message): message is string => !!message);
  if (messages.length > 0) {
    return { status: "failed", message: messages.join("\n") };
  }

  return { status: "ok" };
}

async function postToBackground(message: {
  type: string;
  key: string;
}): Promise<SyncOutcome> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return { status: "failed", message: "扩展后台不可用（请刷新页面后重试）" };
  }
  try {
    return toOutcome(await chrome.runtime.sendMessage(message));
  } catch (error) {
    // 扩展被重载/卸载时消息通道会断开，这本身也是用户需要知道的问题。
    return { status: "failed", message: `无法连接扩展后台：${errorText(error)}` };
  }
}

export function createChromePlatform(): PlatformAdapter {
  const kv: KVStore = new ChromeStorageKVStore();

  return {
    kv,

    requestSync(key: string): Promise<SyncOutcome> {
      return postToBackground({ type: "annotator:sync", key });
    },

    requestUpload(key: string): Promise<SyncOutcome> {
      return postToBackground({ type: "annotator:save", key });
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
