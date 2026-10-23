/**
 * chrome.storage.local 的 KVStore 实现。
 *
 * LocalAdapter 只依赖 KVStore 接口，这里负责把 Chrome 的异步 API
 * 包成统一的 Promise 形式；测试时可注入任意同形状的 KVArea。
 */

import type { KVStore } from "@annotator/storage";

/** chrome.storage.local 中我们用到的方法子集。 */
export interface KVArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class ChromeStorageKVStore implements KVStore {
  private readonly area: KVArea;

  constructor(area: KVArea = chrome.storage.local) {
    this.area = area;
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.area.get(key);
    const value = result[key];
    return typeof value === "string" ? value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async delete(key: string): Promise<void> {
    await this.area.remove(key);
  }

  async keys(): Promise<string[]> {
    const all = await this.area.get(null);
    return Object.keys(all);
  }
}
