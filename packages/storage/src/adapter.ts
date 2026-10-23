import type { DocData } from "@annotator/core";

/** getDoc 的返回值：文档内容 + 该内容对应的 sha。 */
export interface StoredDoc {
  doc: DocData;
  sha: string;
}

/** 索引条目：key → 内容 sha；GitHub 适配器还会记录仓库内路径。 */
export interface DocIndexEntry {
  sha: string;
  /** 仓库内文件路径（本地适配器不填） */
  path?: string;
}

/**
 * 统一存储接口。
 *
 * 约定：
 *   - getIndex 返回 “文档 key → 索引条目” 的映射，用于判断哪些页面需要拉取。
 *   - getDoc 文件不存在时返回 null（不抛异常）。
 *   - putDoc 传入 sha 时做乐观并发控制：sha 与当前存储不一致则抛 ShaConflictError。
 *
 * 没有 putIndex：索引由适配器在 putDoc 时自行维护，调用方不需要关心。
 */
export interface StorageAdapter {
  /** 文档 key → 索引条目。空仓库返回 {}。 */
  getIndex(): Promise<Record<string, DocIndexEntry>>;

  /** 读取某篇文章的批注；不存在返回 null。 */
  getDoc(key: string): Promise<StoredDoc | null>;

  /**
   * 写入某篇文章的完整批注（覆盖）。
   * @param sha 可选。传入时表示“我基于这个版本修改”，与存储中当前 sha 不一致则冲突。
   * @returns 写入后的新 sha
   */
  putDoc(key: string, doc: DocData, sha?: string): Promise<{ sha: string }>;

  /** 快速判断文档是否存在。 */
  hasDoc(key: string): Promise<boolean>;
}

/** 乐观并发控制冲突。调用方应重新拉取、按 id 合并后用新 sha 重试。 */
export class ShaConflictError extends Error {
  readonly key: string;
  /** 调用方持有的 sha（未提供时为 undefined） */
  readonly expectedSha: string | undefined;
  /** 存储中当前的 sha（文档不存在时为 undefined） */
  readonly actualSha: string | undefined;

  constructor(
    key: string,
    expectedSha: string | undefined,
    actualSha: string | undefined
  ) {
    super(
      `SHA conflict for "${key}": expected ${
        expectedSha ?? "(none)"
      }, actual ${actualSha ?? "(none)"}`
    );
    this.name = "ShaConflictError";
    this.key = key;
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
}

/** StorageAdapter.hasDoc 的默认实现。 */
export async function hasDocFromIndex(
  adapter: Pick<StorageAdapter, "getIndex">,
  key: string
): Promise<boolean> {
  const idx = await adapter.getIndex();
  return Object.prototype.hasOwnProperty.call(idx, key);
}
