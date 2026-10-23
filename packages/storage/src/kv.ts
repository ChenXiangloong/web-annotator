/**
 * 最小键值存储抽象。
 *
 * LocalAdapter 只依赖这个接口，不直接接触 localStorage / chrome.storage / GM_setValue。
 * 平台实现方：
 *   - 测试：MemoryKVStore（本文件）
 *   - 浏览器普通页面：LocalStorageKVStore（里程碑 3 需要时再加）
 *   - Chrome 扩展：ChromeStorageKVStore → chrome.storage.local（里程碑 3）
 *   - Userscripts：GMKVStore → GM_getValue / GM_setValue（里程碑 5，需实测）
 */
export interface KVStore {
  /** 取不到返回 undefined */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** 返回全部键名（不带任何过滤） */
  keys(): Promise<string[]>;
}

/** 进程内实现，仅用于单元测试。 */
export class MemoryKVStore implements KVStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}
