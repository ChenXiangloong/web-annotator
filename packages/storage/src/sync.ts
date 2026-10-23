/**
 * 同步引擎：本地优先，后台把改动推到远端。
 *
 * 流程：
 *   1. 页面先读本地缓存并渲染；
 *   2. 后台 pull：拉远端 → 按 id + updated_at 合并 → 写回本地；
 *   3. 保存批注时先写本地，再进上传队列；
 *   4. flush 时把本地文档推到远端；遇到 sha 冲突则重拉、合并、重试；
 *   5. 失败保留在队列里，按指数退避重试（离线时不会丢）。
 *
 * 本地与远端的 sha 是两套互不相干的标识（本地是内容哈希，远端是 blob sha），
 * 因此合并永远发生在「文档」层面，不会把一方的 sha 传给另一方。
 */

import {
  deriveCounts,
  mergeAnnotations,
  refreshDocCounts,
  type DocData,
} from "@annotator/core";
import type { StorageAdapter } from "./adapter.js";
import { ShaConflictError } from "./adapter.js";
import type { KVStore } from "./kv.js";

export interface UploadQueueEntry {
  key: string;
  /** 已失败次数（0 表示还没失败过） */
  attempts: number;
  /** 最早可以重试的时间戳（毫秒） */
  nextAttemptAt: number;
}

/** 首次退避 1s，每次翻倍，上限 5 分钟。 */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

export function backoffDelay(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(1000 * 2 ** exponent, MAX_BACKOFF_MS);
}

/**
 * 持久化上传队列。只存 key，文档本身从本地存储现读，
 * 这样队列不会长期持有一份过期副本。
 */
export class UploadQueue {
  private readonly kv: KVStore;
  private readonly storageKey: string;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(kv: KVStore, storageKey = "annotator:queue") {
    this.kv = kv;
    this.storageKey = storageKey;
  }

  async list(): Promise<UploadQueueEntry[]> {
    const raw = await this.kv.get(this.storageKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is UploadQueueEntry =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as UploadQueueEntry).key === "string" &&
          typeof (entry as UploadQueueEntry).attempts === "number" &&
          typeof (entry as UploadQueueEntry).nextAttemptAt === "number"
      );
    } catch {
      return [];
    }
  }

  /** 在当前时刻已经可以重试的条目。 */
  async due(now = Date.now()): Promise<UploadQueueEntry[]> {
    return (await this.list()).filter((entry) => entry.nextAttemptAt <= now);
  }

  /** 同一 key 去重；新改动意味着「立刻再试一次」，重置退避。 */
  async enqueue(key: string, now = Date.now()): Promise<void> {
    await this.mutate((entries) => {
      const others = entries.filter((entry) => entry.key !== key);
      return [
        ...others,
        { key, attempts: 0, nextAttemptAt: now },
      ].sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    });
  }

  async remove(key: string): Promise<void> {
    await this.mutate((entries) => entries.filter((entry) => entry.key !== key));
  }

  /** 记录一次失败并安排下次重试；返回更新后的条目。 */
  async markFailure(
    key: string,
    now = Date.now()
  ): Promise<UploadQueueEntry | null> {
    let updated: UploadQueueEntry | null = null;
    await this.mutate((entries) =>
      entries.map((entry) => {
        if (entry.key !== key) return entry;
        updated = {
          ...entry,
          attempts: entry.attempts + 1,
          nextAttemptAt: now + backoffDelay(entry.attempts + 1),
        };
        return updated;
      })
    );
    return updated;
  }

  private async mutate(
    fn: (entries: UploadQueueEntry[]) => UploadQueueEntry[]
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const entries = await this.list();
      const next = fn(entries);
      if (next.length === 0) {
        await this.kv.delete(this.storageKey);
      } else {
        await this.kv.set(this.storageKey, JSON.stringify(next));
      }
    };
    this.lock = this.lock.then(run, run);
    await this.lock;
  }
}

export interface SyncResult {
  pushed: string[];
  failed: string[];
  skipped: string[];
}

export interface SyncEngineOptions {
  local: StorageAdapter;
  remote: StorageAdapter;
  queue: UploadQueue;
  now?: () => number;
}

const MAX_CONFLICT_RETRIES = 3;

export class SyncEngine {
  private readonly local: StorageAdapter;
  private readonly remote: StorageAdapter;
  private readonly queue: UploadQueue;
  private readonly now: () => number;
  private flushing: Promise<SyncResult> | null = null;

  constructor(options: SyncEngineOptions) {
    this.local = options.local;
    this.remote = options.remote;
    this.queue = options.queue;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 拉取远端最新版本并合并到本地。
   * 返回合并后的文档；远端不存在时返回 null（本地保持原样）。
   */
  async pull(key: string): Promise<DocData | null> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      const remote = await this.remote.getDoc(key);
      if (!remote) return null;

      const local = await this.local.getDoc(key);
      if (!local) {
        // 再确认一次，避免覆盖这期间页面刚写入的本地批注。
        if (await this.local.getDoc(key)) continue;
        await this.local.putDoc(key, remote.doc);
        return remote.doc;
      }

      const merged = refreshDocCounts(mergeDocs(local.doc, remote.doc));
      if (sameDoc(local.doc, merged)) return local.doc;
      try {
        await this.local.putDoc(key, merged, local.sha);
        return merged;
      } catch (error) {
        if (error instanceof ShaConflictError) continue;
        throw error;
      }
    }
    throw new Error(`拉取 ${key} 时本地连续冲突，已放弃本次同步`);
  }

  /**
   * 把本地版本推到远端：先合并远端现有内容，再写入。
   * 冲突时重新拉取、再次合并，最多重试 MAX_CONFLICT_RETRIES 次。
   *
   * 已删除的批注（墓碑）只保留在本地：上传时剔除，
   * 上传成功后本地同步剔除，仓库里始终只有「活着」的批注。
   */
  async push(key: string): Promise<"uploaded" | "unchanged"> {
    const pathAware = asPathAware(this.remote);

    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      const local = await this.local.getDoc(key);
      if (!local) return "unchanged";

      const remote = await this.remote.getDoc(key);
      const merged = refreshDocCounts(
        remote ? mergeDocs(local.doc, remote.doc) : local.doc
      );

      let localSha = local.sha;
      if (!sameDoc(local.doc, merged)) {
        // 先把远端的更新落到本地，保证下次渲染看到的是合并结果。
        try {
          localSha = (await this.local.putDoc(key, merged, local.sha)).sha;
        } catch (error) {
          if (error instanceof ShaConflictError) continue;
          throw error;
        }
      }

      const upload = stripTombstones(merged);
      let needsUpload = !remote || !sameDoc(upload, stripTombstones(remote.doc));
      if (!needsUpload && remote && pathAware) {
        // 内容没变但路径还是旧版布局（或标题变了导致路径变化）→ 也要上传以完成迁移。
        const storedPath = await pathAware.storedPath(key);
        needsUpload =
          storedPath !== undefined &&
          storedPath !== pathAware.currentPath(key, upload);
      }
      if (!needsUpload) return "unchanged";

      try {
        await this.remote.putDoc(key, upload, remote?.sha);
      } catch (error) {
        if (error instanceof ShaConflictError) continue;
        throw error;
      }

      if (upload.annotations.length !== merged.annotations.length) {
        try {
          await this.local.putDoc(key, upload, localSha);
        } catch (error) {
          if (error instanceof ShaConflictError) continue;
          throw error;
        }
      }
      return "uploaded";
    }
    throw new Error(`上传 ${key} 连续冲突，已放弃本次同步`);
  }

  /** 用户保存后：进队列并立刻尝试上传。 */
  async scheduleUpload(key: string): Promise<SyncResult> {
    await this.queue.enqueue(key, this.now());
    // 已有一轮 flush 在跑时，等它结束再开一轮，避免新条目被漏掉。
    if (this.flushing) await this.flushing.catch(() => undefined);
    return this.flush();
  }

  /**
   * 处理所有到期条目。同一时间只跑一个 flush，避免重复上传。
   */
  flush(now = this.now()): Promise<SyncResult> {
    if (this.flushing) return this.flushing;
    const run = this.runFlush(now).finally(() => {
      if (this.flushing === run) this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async runFlush(now: number): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], failed: [], skipped: [] };
    const entries = await this.queue.due(now);

    for (const entry of entries) {
      try {
        const local = await this.local.getDoc(entry.key);
        if (!local) {
          // 本地已不存在（例如缓存被清），没有可上传的内容。
          await this.queue.remove(entry.key);
          result.skipped.push(entry.key);
          continue;
        }
        await this.push(entry.key);
        await this.queue.remove(entry.key);
        result.pushed.push(entry.key);
      } catch {
        await this.queue.markFailure(entry.key, now);
        result.failed.push(entry.key);
      }
    }
    return result;
  }
}

function mergeDocs(local: DocData, remote: DocData): DocData {
  return {
    url: local.url || remote.url,
    title: local.title || remote.title,
    author: local.author || remote.author,
    annotations: mergeAnnotations(local.annotations, remote.annotations),
  };
}

/** 上传给远端的版本：剔除墓碑，仓库里只保留「活着」的批注。 */
function stripTombstones(doc: DocData): DocData {
  return {
    ...doc,
    annotations: doc.annotations.filter(
      (annotation) => annotation.deleted_at === null
    ),
  };
}

/**
 * 能感知「文档实际存储路径」的适配器（GitHub 用）。
 * 同步引擎借此在内容没变但路径过旧时触发一次迁移上传。
 */
export interface PathAwareAdapter extends StorageAdapter {
  currentPath(key: string, doc: Pick<DocData, "url" | "title">): string;
  storedPath(key: string): Promise<string | undefined>;
}

function asPathAware(adapter: StorageAdapter): PathAwareAdapter | null {
  const candidate = adapter as Partial<PathAwareAdapter>;
  if (
    typeof candidate.currentPath === "function" &&
    typeof candidate.storedPath === "function"
  ) {
    return adapter as PathAwareAdapter;
  }
  return null;
}

/** 只比较内容，不比较顺序；缺失的计数字段按批注现算。 */
function sameDoc(a: DocData, b: DocData): boolean {
  if (a.url !== b.url || a.title !== b.title) return false;
  if ((a.author ?? "") !== (b.author ?? "")) return false;
  const countsA = deriveCounts(a);
  const countsB = deriveCounts(b);
  if (
    countsA.highlight_count !== countsB.highlight_count ||
    countsA.note_count !== countsB.note_count
  ) {
    return false;
  }
  if (a.annotations.length !== b.annotations.length) return false;
  const byId = new Map(a.annotations.map((item) => [item.id, item]));
  for (const item of b.annotations) {
    if (JSON.stringify(byId.get(item.id)) !== JSON.stringify(item)) return false;
  }
  return true;
}
