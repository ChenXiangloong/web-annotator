/**
 * Userscripts 的 PlatformAdapter 实现。
 *
 * 与 Chrome 扩展的差异：没有 service worker，同步就在页面上下文里做——
 *   - requestSync / requestUpload 直接驱动本地 SyncEngine；
 *   - 同步可能把远端合并结果写回本地 KV，完成后主动通知 watchDoc
 *     的订阅者，让页面重绘（GM 存储没有可靠的变更事件，
 *     GM_addValueChangeListener 在 Userscripts iOS 上的支持情况需实测，
 *     因此不依赖它，跨标签页同步也暂不做）；
 *   - 每次调用都重读配置，设置面板保存后无需刷新页面即生效。
 */

import {
  GitHubAdapter,
  LocalAdapter,
  SyncEngine,
  UploadQueue,
  type GitHubConfig,
  type KVStore,
} from "@annotator/storage";
import type { PlatformAdapter } from "@annotator/ui";
import { GmKVStore, gmFetch } from "./gm.js";

export const CONFIG_KEY = "annotator:github-config";

export interface UserscriptPlatform extends PlatformAdapter {
  /** 冲刷上传队列（定时器 / 页面隐藏时调用）。 */
  flush(): void;
  /** 是否已配置 GitHub（设置面板用来决定是否提示）。 */
  hasConfig(): Promise<boolean>;
}

async function readConfig(kv: KVStore): Promise<GitHubConfig | null> {
  let raw: string | undefined;
  try {
    raw = await kv.get(CONFIG_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: Partial<GitHubConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GitHubConfig>;
  } catch {
    return null;
  }

  const owner = String(parsed.owner ?? "").trim();
  const repo = String(parsed.repo ?? "").trim();
  const token = String(parsed.token ?? "").trim();
  if (!owner || !repo || !token) return null;

  return {
    owner,
    repo,
    token,
    branch: String(parsed.branch ?? "").trim() || "main",
  };
}

export function createUserscriptPlatform(): UserscriptPlatform {
  const kv = new GmKVStore();
  const local = new LocalAdapter(kv);
  const queue = new UploadQueue(kv);
  const watchers = new Map<string, Set<() => void>>();

  function notifyWatchers(key: string): void {
    for (const cb of watchers.get(key) ?? []) {
      try {
        cb();
      } catch {
        // 订阅者异常不阻塞同步
      }
    }
  }

  /** 未配置仓库时返回 null，所有同步操作静默跳过。 */
  async function withEngine(
    fn: (engine: SyncEngine) => Promise<unknown>
  ): Promise<void> {
    const config = await readConfig(kv);
    if (!config) return;
    const remote = new GitHubAdapter({ ...config, kv, fetchFn: gmFetch });
    const engine = new SyncEngine({ local, remote, queue });
    try {
      await fn(engine);
    } catch (error) {
      // 同步失败不打扰页面：队列里有指数退避，下个周期会重试。
      // 注意：绝不打印 error.message 以外的内容，GitHubApiError
      // 的 detail 来自服务端响应，不含请求头/token。
      console.warn(
        "[annotator] 同步失败，稍后自动重试",
        error instanceof Error ? error.message : error
      );
    }
  }

  return {
    kv,

    requestSync(key: string): void {
      void withEngine(async (engine) => {
        await engine.pull(key);
        // pull 可能把远端批注合并进本地 KV，通知页面重绘。
        notifyWatchers(key);
        // 再过一次上传队列：内容没变时是 no-op；
        // 旧版哈希路径 / 缺少计数的文档会借此自动迁移到新布局。
        await engine.scheduleUpload(key);
        notifyWatchers(key);
      });
    },

    requestUpload(key: string): void {
      void withEngine(async (engine) => {
        await engine.scheduleUpload(key);
        // push 过程中可能先把远端更新落到本地，同样需要重绘。
        notifyWatchers(key);
      });
    },

    watchDoc(key: string, callback: () => void): () => void {
      let set = watchers.get(key);
      if (!set) {
        set = new Set();
        watchers.set(key, set);
      }
      set.add(callback);
      return () => {
        set.delete(callback);
        if (set.size === 0) watchers.delete(key);
      };
    },

    flush(): void {
      void withEngine((engine) => engine.flush());
    },

    async hasConfig(): Promise<boolean> {
      return (await readConfig(kv)) !== null;
    },
  };
}
