/**
 * GitHub 仓库存储适配器。
 *
 * 只依赖标准 fetch，不依赖任何 Chrome / Node API，方便在 service worker、
 * 普通页面或测试里复用。
 *
 * 文件布局（方便在 GitHub 上直接翻阅）：
 *   annotations/{站点域名}/{标题 slug}-{key}.json
 * 例如：
 *   annotations/asheradeniyi.com/how-to-build-wealth-a1b2c3d4e5f60718.json
 * 旧版布局 annotations/{key前2位}/{key}.json 仍会被索引识别，
 * 写入新路径成功后会自动删除对应的旧文件。
 *
 * sha 语义：使用 GitHub Contents API 返回的 blob sha（不是内容哈希）。
 * 它只在本适配器内部用于乐观并发控制，不要与 LocalAdapter 的 sha 混用。
 *
 * 索引：用 Trees API 一次性列出 annotations/ 下的全部文件，缓存在 KVStore 里。
 * getDoc 会先查索引，索引里没有的 key 直接返回 null，不发网络请求。
 */

import { parseDoc, serializeDoc, type DocData } from "@annotator/core";
import type { DocIndexEntry, StorageAdapter, StoredDoc } from "./adapter.js";
import { ShaConflictError, hasDocFromIndex } from "./adapter.js";
import type { KVStore } from "./kv.js";

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface GitHubAdapterOptions {
  owner: string;
  repo: string;
  token: string;
  /** 默认 "main" */
  branch?: string;
  /** 索引缓存载体；不传则每次 getIndex 都请求 Trees API */
  kv?: KVStore;
  /** 索引缓存有效期，默认 5 分钟 */
  indexTtlMs?: number;
  /** 索引缓存键前缀，默认 "annotator:github:" */
  cachePrefix?: string;
  /** 可注入的 fetch，默认全局 fetch */
  fetchFn?: typeof fetch;
  /** API 根地址，默认 https://api.github.com */
  apiBase?: string;
  /** 可注入的时钟，默认 Date.now */
  now?: () => number;
}

/** GitHub API 返回非 2xx（且不是约定的 404 / 冲突）时抛出。 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`GitHub API ${status}: ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** 旧版布局：annotations/{key前2位}/{key}.json */
const LEGACY_PATH = /^annotations\/[0-9a-f]{2}\/([0-9a-f]{16})\.json$/;
/** 新版布局：annotations/{域名}/{slug}-{key}.json */
const DOC_PATH = /^annotations\/[^/]+\/.+-([0-9a-f]{16})\.json$/;

const DEFAULT_TTL = 5 * 60 * 1000;
const DEFAULT_BRANCH = "main";
const DEFAULT_API_BASE = "https://api.github.com";
const SLUG_MAX_LENGTH = 60;

interface CachedIndex {
  fetchedAt: number;
  index: Record<string, DocIndexEntry>;
}

interface ContentsFile {
  sha: string;
  content?: string;
  encoding?: string;
}

interface TreeResponse {
  tree?: Array<{ path?: string; type?: string; sha?: string }>;
}

/** 从索引路径反推文档 key；不认识的布局返回 null。 */
function keyFromPath(path: string): string | null {
  return (
    LEGACY_PATH.exec(path)?.[1] ?? DOC_PATH.exec(path)?.[1] ?? null
  );
}

/** 标题 → 文件名 slug：保留中英文与数字，其余折叠为短横线。 */
export function slugify(text: string, maxLength = SLUG_MAX_LENGTH): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength).replace(/-+$/g, "");
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/[^a-z0-9.-]+/g, "-") || "unknown";
  } catch {
    return "unknown";
  }
}

export class GitHubAdapter implements StorageAdapter {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly kv: KVStore | undefined;
  private readonly indexTtlMs: number;
  private readonly cachePrefix: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly now: () => number;

  /** 已读取过的索引缓存，避免同一上下文里反复解析 KV。 */
  private cached: CachedIndex | null = null;

  constructor(options: GitHubAdapterOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch ?? DEFAULT_BRANCH;
    this.token = options.token;
    this.kv = options.kv;
    this.indexTtlMs = options.indexTtlMs ?? DEFAULT_TTL;
    this.cachePrefix = options.cachePrefix ?? "annotator:github:";
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.now = options.now ?? (() => Date.now());
    this.fetchFn =
      options.fetchFn ?? ((input, init) => fetch(input as RequestInfo, init));
  }

  /** 文档对应的友好路径。 */
  static pathForDoc(key: string, doc: Pick<DocData, "url" | "title">): string {
    const slug = slugify(doc.title) || "untitled";
    return `annotations/${hostOf(doc.url)}/${slug}-${key}.json`;
  }

  /** 旧版哈希路径（仅用于识别与清理历史文件）。 */
  static legacyPathFor(key: string): string {
    return `annotations/${key.slice(0, 2)}/${key}.json`;
  }

  /** 同步引擎用：文档应该存放的路径。 */
  currentPath(key: string, doc: Pick<DocData, "url" | "title">): string {
    return GitHubAdapter.pathForDoc(key, doc);
  }

  /** 同步引擎用：索引里记录的实际路径。 */
  async storedPath(key: string): Promise<string | undefined> {
    return (await this.getIndex())[key]?.path;
  }

  private get cacheKey(): string {
    return `${this.cachePrefix}index`;
  }

  /** 强制刷新 Trees 索引并写缓存。 */
  async refreshIndex(): Promise<Record<string, DocIndexEntry>> {
    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(
        this.branch
      )}?recursive=1`,
      { allow404: true, allowConflict: true }
    );

    // 分支不存在（404）或仓库还是空的（409 "Git Repository is empty."）：
    // 都视为空索引，不视为错误。
    if (data.status === 404 || data.status === 409) {
      return this.writeCache({});
    }

    const body = (await data.json()) as TreeResponse;
    const index: Record<string, DocIndexEntry> = {};
    for (const entry of body.tree ?? []) {
      if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
      const key = keyFromPath(entry.path);
      if (key) index[key] = { sha: entry.sha, path: entry.path };
    }
    return this.writeCache(index);
  }

  async getIndex(): Promise<Record<string, DocIndexEntry>> {
    const cached = await this.readCache();
    if (cached && this.now() - cached.fetchedAt < this.indexTtlMs) {
      return cached.index;
    }
    return this.refreshIndex();
  }

  async getDoc(key: string): Promise<StoredDoc | null> {
    // 索引里有才发请求：绝大多数页面从未被批注过，避免每条都吃一个 404。
    const entry = (await this.getIndex())[key];
    if (!entry) return null;

    const path = entry.path ?? GitHubAdapter.legacyPathFor(key);
    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(
        this.branch
      )}`,
      { allow404: true }
    );

    if (data.status === 404) {
      // 索引过期（文件被删），顺手把它从缓存里抹掉。
      await this.removeFromCache(key);
      return null;
    }

    const file = (await data.json()) as ContentsFile;
    if (typeof file.content !== "string") {
      throw new GitHubApiError(
        data.status,
        `文件内容不可用（可能是大文件）：${path}`
      );
    }

    const text = decodeBase64(file.content);
    let doc: DocData;
    try {
      doc = parseDoc(text);
    } catch (error) {
      throw new GitHubApiError(
        data.status,
        `批注文件不是合法 JSON：${path}（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
    }
    return { doc, sha: file.sha };
  }

  async putDoc(
    key: string,
    doc: DocData,
    sha?: string
  ): Promise<{ sha: string }> {
    const path = GitHubAdapter.pathForDoc(key, doc);
    const previousPath = (await this.readCache())?.index[key]?.path;
    // 路径变化意味着在新路径上「创建」文件，不能带旧路径的 sha。
    const isRename = previousPath !== undefined && previousPath !== path;

    const body: Record<string, unknown> = {
      message: `annotations: update ${doc.title || key}`,
      content: encodeBase64(serializeDoc(doc)),
      branch: this.branch,
    };
    if (sha !== undefined && !isRename) body.sha = sha;

    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
        allow404: true,
        allowConflict: true,
      }
    );

    if (data.status === 409 || data.status === 422) {
      const detail = await readError(data);
      // 已有文件但没带 sha 时 GitHub 返回 422，语义上同样属于冲突。
      if (data.status === 409 || /sha/i.test(detail)) {
        // 索引可能也过期了，让下次 getDoc 重新拉树。
        await this.clearCache();
        throw new ShaConflictError(key, sha, undefined);
      }
      throw new GitHubApiError(data.status, detail);
    }

    if (!data.ok) {
      throw new GitHubApiError(data.status, await readError(data));
    }

    const result = (await data.json()) as { content?: { sha?: string } };
    const nextSha = result.content?.sha;
    if (!nextSha) {
      throw new GitHubApiError(data.status, `写入成功但未返回 sha：${path}`);
    }
    await this.updateCache(key, { sha: nextSha, path });

    // 路径变化（如旧版哈希布局 → 新版友好布局）：删掉旧文件，避免仓库里出现两份。
    if (previousPath && previousPath !== path) {
      await this.deleteLegacyPath(previousPath);
    }
    return { sha: nextSha };
  }

  async hasDoc(key: string): Promise<boolean> {
    return hasDocFromIndex(this, key);
  }

  /**
   * 校验配置是否可用：读取仓库元信息。
   * 失败时抛出带状态码/原始服务端说明的错误，由设置界面直接展示。
   */
  async testConnection(): Promise<{
    fullName: string;
    defaultBranch: string;
  }> {
    const response = await this.request(
      `/repos/${this.owner}/${this.repo}`
    );
    const info = (await response.json()) as {
      full_name?: string;
      default_branch?: string;
    };
    return {
      fullName: info.full_name ?? `${this.owner}/${this.repo}`,
      defaultBranch: info.default_branch ?? "",
    };
  }

  // ---- 网络 ---------------------------------------------------------------

  private async request(
    path: string,
    options: {
      method?: string;
      body?: string;
      allow404?: boolean;
      allowConflict?: boolean;
    } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiBase}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body,
      });
    } catch (error) {
      // fetch / GM_xmlhttpRequest 的原始错误信息（超时、断网、CSP 等）
      // 对排查很关键，这里包一层上下文后原样保留。
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`网络请求失败（${message}）：${path}`);
    }

    if (response.ok) return response;
    if (options.allow404 && response.status === 404) return response;
    if (options.allowConflict && response.status === 409) return response;
    if (options.allowConflict && response.status === 422) return response;
    throw new GitHubApiError(
      response.status,
      withRateLimitHint(response, await readError(response))
    );
  }

  /** 删除旧路径文件。失败不阻塞主流程，下次写入会再试。 */
  private async deleteLegacyPath(path: string): Promise<void> {
    try {
      const existing = await this.request(
        `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(
          this.branch
        )}`,
        { allow404: true }
      );
      if (existing.status === 404) return;
      const file = (await existing.json()) as ContentsFile;
      if (!file.sha) return;
      await this.request(
        `/repos/${this.owner}/${this.repo}/contents/${path}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            message: `annotations: remove legacy path ${path}`,
            sha: file.sha,
            branch: this.branch,
          }),
        }
      );
    } catch {
      // 忽略：旧文件残留无害，会在下次写入时再清理
    }
  }

  // ---- 索引缓存 -----------------------------------------------------------

  private async readCache(): Promise<CachedIndex | null> {
    if (!this.kv) return null;
    if (this.cached) return this.cached;
    const raw = await this.kv.get(this.cacheKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachedIndex;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.fetchedAt === "number" &&
        parsed.index &&
        typeof parsed.index === "object"
      ) {
        // 旧格式（value 是 sha 字符串）的缓存直接作废，重新拉树。
        const values = Object.values(parsed.index);
        const legacy = values.some((value) => typeof value === "string");
        if (!legacy) {
          this.cached = parsed;
          return parsed;
        }
      }
    } catch {
      // 缓存损坏当作没有
    }
    return null;
  }

  private async writeCache(
    index: Record<string, DocIndexEntry>
  ): Promise<Record<string, DocIndexEntry>> {
    const entry: CachedIndex = { fetchedAt: this.now(), index };
    this.cached = entry;
    if (this.kv) await this.kv.set(this.cacheKey, JSON.stringify(entry));
    return index;
  }

  private async clearCache(): Promise<void> {
    this.cached = null;
    if (this.kv) await this.kv.delete(this.cacheKey);
  }

  private async removeFromCache(key: string): Promise<void> {
    const cached = await this.readCache();
    if (!cached || !Object.prototype.hasOwnProperty.call(cached.index, key)) {
      return;
    }
    const index = { ...cached.index };
    delete index[key];
    await this.writeCache(index);
  }

  private async updateCache(key: string, entry: DocIndexEntry): Promise<void> {
    const cached = await this.readCache();
    // 没有缓存时不要凭空造一个「只有这一条」的索引，否则会误判其它页面不存在。
    if (!cached) return;
    await this.writeCache({ ...cached.index, [key]: entry });
  }
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(input: string): string {
  const binary = atob(input.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * 限流（403 且剩余额度为 0）时把恢复时间补进错误文案。
 * GM_xmlhttpRequest 的 Response 兼容层没有 headers，这里全部做存在性判断。
 */
function withRateLimitHint(response: Response, detail: string): string {
  try {
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if (remaining !== "0") return detail;

    const reset = Number(response.headers?.get?.("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return detail;

    const at = new Date(reset * 1000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const when =
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
      `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return `${detail}（API 限额已用尽，将于 ${when} 重置）`;
  } catch {
    return detail;
  }
}
