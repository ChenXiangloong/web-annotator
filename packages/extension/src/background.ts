/**
 * MV3 service worker：唯一有网络权限的地方。
 *
 * content script 只读写本地缓存，然后通过消息请求这里：
 *   - annotator:sync → 拉远端最新、合并进本地
 *   - annotator:save → 本地已写好，入队并立刻上传
 *
 * 上传队列持久化在 chrome.storage.local，失败按指数退避；
 * 每分钟一次的 alarm 负责在离线恢复后继续重试。
 */

import {
  GitHubAdapter,
  LocalAdapter,
  SyncEngine,
  UploadQueue,
  type GitHubConfig,
} from "@annotator/storage";
import { ChromeStorageKVStore } from "./kv.js";

const CONFIG_KEY = "annotator:github-config";
const FLUSH_ALARM = "annotator:flush";
const FLUSH_PERIOD_MINUTES = 1;

const kv = new ChromeStorageKVStore();
const local = new LocalAdapter(kv);
const queue = new UploadQueue(kv);

interface IncomingMessage {
  type?: string;
  key?: string;
}

async function readConfig(): Promise<GitHubConfig | null> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const raw = stored[CONFIG_KEY] as Partial<GitHubConfig> | undefined;
  if (!raw || typeof raw !== "object") return null;

  const owner = String(raw.owner ?? "").trim();
  const repo = String(raw.repo ?? "").trim();
  const token = String(raw.token ?? "").trim();
  if (!owner || !repo || !token) return null;

  return {
    owner,
    repo,
    token,
    branch: String(raw.branch ?? "").trim() || "main",
  };
}

function createEngine(config: GitHubConfig): SyncEngine {
  const remote = new GitHubAdapter({
    ...config,
    kv,
  });
  return new SyncEngine({ local, remote, queue });
}

/** 未配置仓库时返回 null，所有同步操作静默跳过。 */
async function withEngine<T>(
  fn: (engine: SyncEngine) => Promise<T>
): Promise<T | null> {
  const config = await readConfig();
  if (!config) return null;
  return fn(createEngine(config));
}

async function handleMessage(message: IncomingMessage): Promise<unknown> {
  switch (message.type) {
    case "annotator:sync": {
      if (!message.key) return { ok: false, error: "missing key" };
      const key = message.key;
      const result = await withEngine(async (engine) => {
        await engine.pull(key);
        // 再过一次上传队列：内容没变时是 no-op；
        // 但旧版哈希路径 / 缺少计数的文档会借此自动迁移到新布局。
        return engine.scheduleUpload(key);
      });
      return result
        ? { ok: true, configured: true, ...result }
        : { ok: true, configured: false };
    }

    case "annotator:save": {
      if (!message.key) return { ok: false, error: "missing key" };
      const key = message.key;
      const result = await withEngine((engine) => engine.scheduleUpload(key));
      return result
        ? { ok: true, configured: true, ...result }
        : { ok: true, configured: false };
    }

    case "annotator:flush": {
      const result = await withEngine((engine) => engine.flush());
      return result
        ? { ok: true, configured: true, ...result }
        : { ok: true, configured: false };
    }

    default:
      return { ok: false, error: `unknown message: ${String(message.type)}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage((message ?? {}) as IncomingMessage)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.warn("[annotator] 同步消息处理失败", error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // 保持消息通道打开，等待异步结果
  return true;
});

async function ensureAlarm(): Promise<void> {
  try {
    const existing = await chrome.alarms.get(FLUSH_ALARM);
    if (existing) return;
    chrome.alarms.create(FLUSH_ALARM, {
      periodInMinutes: FLUSH_PERIOD_MINUTES,
    });
  } catch (error) {
    console.warn("[annotator] 创建同步定时器失败", error);
  }
}

async function flushNow(): Promise<void> {
  try {
    await withEngine((engine) => engine.flush());
  } catch (error) {
    console.warn("[annotator] 后台上传失败，稍后重试", error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) void flushNow();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  void flushNow();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void flushNow();
});

void ensureAlarm();
