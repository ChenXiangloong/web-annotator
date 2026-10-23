import { sha256, type DocData, parseDoc, serializeDoc } from "@annotator/core";
import type { DocIndexEntry, StorageAdapter, StoredDoc } from "./adapter.js";
import { ShaConflictError, hasDocFromIndex } from "./adapter.js";
import type { KVStore } from "./kv.js";

/**
 * 基于 KVStore 的本地存储适配器。
 *
 * 存储布局：
 *   `${prefix}index`      → JSON: Record<docKey, sha>
 *   `${prefix}doc:${key}` → 序列化后的 DocData
 *
 * sha 用文档内容哈希模拟（与 GitHub Contents API 的 blob sha 语义同类，
 * 只是算法不同）。这使里程碑 4 的冲突合并逻辑现在就能被测试覆盖。
 */
export class LocalAdapter implements StorageAdapter {
  private readonly kv: KVStore;
  private readonly prefix: string;

  constructor(kv: KVStore, prefix = "annotator:") {
    this.kv = kv;
    this.prefix = prefix;
  }

  private docStorageKey(key: string): string {
    return `${this.prefix}doc:${key}`;
  }

  private get indexPath(): string {
    return `${this.prefix}index`;
  }

  private async readIndex(): Promise<Record<string, DocIndexEntry>> {
    const raw = await this.kv.get(this.indexPath);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      // 兼容旧格式：value 直接是 sha 字符串
      const index: Record<string, DocIndexEntry> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          index[key] = { sha: value };
        } else if (
          value &&
          typeof value === "object" &&
          typeof (value as DocIndexEntry).sha === "string"
        ) {
          index[key] = { sha: (value as DocIndexEntry).sha };
        }
      }
      return index;
    } catch {
      return {};
    }
  }

  private async writeIndex(index: Record<string, DocIndexEntry>): Promise<void> {
    await this.kv.set(this.indexPath, JSON.stringify(index));
  }

  async getIndex(): Promise<Record<string, DocIndexEntry>> {
    return this.readIndex();
  }

  async getDoc(key: string): Promise<StoredDoc | null> {
    const raw = await this.kv.get(this.docStorageKey(key));
    if (raw === undefined) return null;
    return {
      doc: parseDoc(raw),
      sha: await sha256(raw),
    };
  }

  async putDoc(
    key: string,
    doc: DocData,
    sha?: string
  ): Promise<{ sha: string }> {
    const storageKey = this.docStorageKey(key);
    const existing = await this.kv.get(storageKey);
    const currentSha = existing === undefined ? undefined : await sha256(existing);

    if (sha !== undefined && sha !== currentSha) {
      throw new ShaConflictError(key, sha, currentSha);
    }

    const serialized = serializeDoc(doc);
    const newSha = await sha256(serialized);
    await this.kv.set(storageKey, serialized);

    const index = await this.readIndex();
    index[key] = { sha: newSha };
    await this.writeIndex(index);

    return { sha: newSha };
  }

  async hasDoc(key: string): Promise<boolean> {
    return hasDocFromIndex(this, key);
  }
}
