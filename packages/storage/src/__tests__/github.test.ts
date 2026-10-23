import { describe, expect, it } from "vitest";

import { emptyDocData, serializeDoc, type Annotation, type DocData } from "@annotator/core";

import { GitHubAdapter, GitHubApiError, slugify } from "../github.js";
import { ShaConflictError } from "../adapter.js";
import { MemoryKVStore } from "../kv.js";

type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function mkAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    quote: "hello",
    prefix: "pre",
    suffix: "post",
    pos_hint: 0,
    comment: "想法",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

interface FakeFile {
  content: string;
  sha: string;
}

/** 最小可用的 GitHub 假服务：Trees + Contents（GET / PUT）。 */
class FakeGitHub {
  readonly files = new Map<string, FakeFile>();
  readonly requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
  }> = [];
  treeCalls = 0;
  contentsCalls: Array<{ method: string; path: string; body?: string }> = [];
  /** 下一次 PUT 直接返回该状态码（用一次后清除） */
  nextPutStatus: number | null = null;
  nextPutMessage = "sha does not match";
  counter = 0;

  addFile(path: string, doc: DocData): FakeFile {
    const content = serializeDoc(doc);
    const file = { content, sha: `sha-${++this.counter}` };
    this.files.set(path, file);
    return file;
  }

  fetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.requests.push({ url: raw, method, headers });

    if (method === "GET" && /\/git\/trees\//.test(url.pathname)) {
      this.treeCalls++;
      return json({
        tree: Array.from(this.files.entries()).map(([path, file]) => ({
          path,
          type: "blob",
          sha: file.sha,
        })),
      });
    }

    const match = /^\/repos\/o\/r\/contents\/(.+)$/.exec(url.pathname);
    if (!match) return json({ message: "Not Found" }, 404);
    const path = decodeURIComponent(match[1]);

    if (method === "GET") {
      this.contentsCalls.push({ method, path });
      const file = this.files.get(path);
      if (!file) return json({ message: "Not Found" }, 404);
      return json({
        sha: file.sha,
        content: base64(file.content),
        encoding: "base64",
      });
    }

    if (method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        content: string;
        sha?: string;
      };
      this.contentsCalls.push({ method, path, body: String(init.body) });
      if (this.nextPutStatus !== null) {
        const status = this.nextPutStatus;
        this.nextPutStatus = null;
        return json({ message: this.nextPutMessage }, status);
      }
      const existing = this.files.get(path);
      if (existing && body.sha !== existing.sha) {
        return json({ message: "sha does not match" }, 409);
      }
      if (!existing && body.sha !== undefined) {
        return json(
          { message: "does not match: sha supplied for new file" },
          422
        );
      }
      const content = Buffer.from(body.content, "base64").toString("utf8");
      const sha = `sha-${++this.counter}`;
      this.files.set(path, { content, sha });
      return json({ content: { sha } });
    }

    if (method === "DELETE") {
      const body = JSON.parse(String(init.body)) as { sha?: string };
      this.contentsCalls.push({ method, path, body: String(init.body) });
      const existing = this.files.get(path);
      if (!existing) return json({ message: "Not Found" }, 404);
      if (body.sha !== existing.sha) {
        return json({ message: "sha does not match" }, 409);
      }
      this.files.delete(path);
      return json({ commit: { sha: `commit-${++this.counter}` } });
    }

    return json({ message: "Method Not Allowed" }, 405);
  };
}

function setup(options: { clock?: { value: number }; kv?: MemoryKVStore } = {}) {
  const gh = new FakeGitHub();
  const kv = options.kv ?? new MemoryKVStore();
  const clock = options.clock ?? { value: 1_000_000 };
  const adapter = new GitHubAdapter({
    owner: "o",
    repo: "r",
    branch: "main",
    token: "tok",
    kv,
    fetchFn: gh.fetch,
    now: () => clock.value,
  });
  return { gh, kv, clock, adapter };
}

const KEY = "a1b2c3d4e5f60718";
/** doc(url=https://x.com, title=T) 对应的新版友好路径 */
const PATH = `annotations/x.com/t-${KEY}.json`;
/** 旧版哈希路径 */
const LEGACY_PATH = `annotations/a1/${KEY}.json`;

describe("slugify / pathForDoc", () => {
  it("中文标题原样保留，特殊字符折叠为短横线", () => {
    expect(slugify("How to Build Wealth as a Career Person")).toBe(
      "how-to-build-wealth-as-a-career-person"
    );
    expect(slugify("刘言飞语：第 42 期")).toBe("刘言飞语-第-42-期");
    expect(slugify("  --Hello__World!!  ")).toBe("hello-world");
    expect(slugify("")).toBe("");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("pathForDoc 生成 域名/标题-key.json", () => {
    const doc = emptyDocData("https://AsherAdeniyi.com/2026/04/10/x/", "How to Build Wealth");
    expect(GitHubAdapter.pathForDoc(KEY, doc)).toBe(
      `annotations/asheradeniyi.com/how-to-build-wealth-${KEY}.json`
    );
  });

  it("标题为空时退回 untitled", () => {
    const doc = emptyDocData("https://x.com", "");
    expect(GitHubAdapter.pathForDoc(KEY, doc)).toBe(
      `annotations/x.com/untitled-${KEY}.json`
    );
  });
});

describe("GitHubAdapter 索引", () => {
  it("Trees API 同时收录新版与旧版布局，忽略其它文件", async () => {
    const { gh, adapter } = setup();
    gh.addFile(PATH, emptyDocData("https://x.com", "T"));
    gh.addFile("annotations/bb/bbbbbbbbbbbbbbbb.json", emptyDocData("https://b.com", "B"));
    gh.addFile("annotations/aa/other.txt", emptyDocData("https://y.com", "Y"));
    gh.addFile("README.md", emptyDocData("https://z.com", "Z"));

    const index = await adapter.getIndex();

    expect(Object.keys(index).sort()).toEqual([KEY, "bbbbbbbbbbbbbbbb"]);
    expect(index[KEY].path).toBe(PATH);
    expect(index["bbbbbbbbbbbbbbbb"].path).toBe(
      "annotations/bb/bbbbbbbbbbbbbbbb.json"
    );
    expect(gh.treeCalls).toBe(1);
  });

  it("索引命中缓存时不再请求 Trees；超过 TTL 后重新拉取", async () => {
    const clock = { value: 1_000_000 };
    const { gh, adapter } = setup({ clock });
    gh.addFile(PATH, emptyDocData("https://x.com", "X"));

    await adapter.getIndex();
    await adapter.getIndex();
    expect(gh.treeCalls).toBe(1);

    clock.value += 5 * 60 * 1000 - 1;
    await adapter.getIndex();
    expect(gh.treeCalls).toBe(1);

    clock.value += 1;
    await adapter.getIndex();
    expect(gh.treeCalls).toBe(2);
  });

  it("空仓库（Trees 404）视为空索引", async () => {
    const gh = new FakeGitHub();
    gh.fetch = async () => json({ message: "Not Found" }, 404);
    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "t",
      kv: new MemoryKVStore(),
      fetchFn: gh.fetch,
    });

    expect(await adapter.getIndex()).toEqual({});
    expect(await adapter.hasDoc(KEY)).toBe(false);
  });

  it("空仓库（Trees 409 Git Repository is empty）视为空索引，且不报错", async () => {
    const gh = new FakeGitHub();
    gh.fetch = async () => json({ message: "Git Repository is empty." }, 409);
    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "t",
      kv: new MemoryKVStore(),
      fetchFn: gh.fetch,
    });

    expect(await adapter.getIndex()).toEqual({});
    expect(await adapter.getDoc(KEY)).toBeNull();
    expect(await adapter.hasDoc(KEY)).toBe(false);
  });

  it("索引里没有的页面不发 Contents 请求", async () => {
    const { gh, adapter } = setup();
    gh.addFile("annotations/bb/bbbbbbbbbbbbbbbb.json", emptyDocData("https://b.com", "B"));

    expect(await adapter.getDoc(KEY)).toBeNull();
    expect(gh.contentsCalls).toHaveLength(0);
  });

  it("索引里有但文件已删除 → null，并从缓存移除该 key", async () => {
    const { gh, adapter } = setup();
    gh.addFile(PATH, emptyDocData("https://x.com", "X"));

    await adapter.getIndex();
    gh.files.delete(PATH);

    expect(await adapter.getDoc(KEY)).toBeNull();
    expect(await adapter.getIndex()).not.toHaveProperty(KEY);
  });
});

describe("GitHubAdapter 读写", () => {
  it("getDoc 解码中文内容并返回远端 sha", async () => {
    const { gh, adapter } = setup();
    const doc = emptyDocData("https://x.com/文章", "标题");
    doc.annotations.push(mkAnnotation({ quote: "可以划线的一段中文" }));
    const file = gh.addFile(PATH, doc);

    const stored = await adapter.getDoc(KEY);

    expect(stored).not.toBeNull();
    expect(stored!.sha).toBe(file.sha);
    expect(stored!.doc.title).toBe("标题");
    expect(stored!.doc.annotations[0].comment).toBe("想法");
  });

  it("getDoc 兼容 GitHub 返回的换行包裹 base64", async () => {
    const gh = new FakeGitHub();
    gh.addFile(PATH, emptyDocData("https://x.com", "T"));

    const original = gh.fetch;
    gh.fetch = async (input, init) => {
      const res = await original(input, init);
      if (!res.ok) return res;
      const body = (await res.json()) as Json;
      const content = String(body.content).replace(/(.{20})/g, "$1\n");
      return json({ ...body, content });
    };

    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "t",
      kv: new MemoryKVStore(),
      fetchFn: gh.fetch,
    });

    const stored = await adapter.getDoc(KEY);
    expect(stored!.doc.url).toBe("https://x.com");
  });

  it("putDoc 用 UTF-8 base64 写入、带 branch 与 sha，并更新索引缓存", async () => {
    const { gh, adapter } = setup();
    gh.addFile(PATH, emptyDocData("https://x.com", "T"));
    await adapter.getIndex();
    const current = await adapter.getDoc(KEY);

    const next = emptyDocData("https://x.com", "T");
    next.annotations.push(mkAnnotation({ quote: "划线内容" }));
    const { sha } = await adapter.putDoc(KEY, next, current!.sha);

    const put = gh.contentsCalls.find((call) => call.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.path).toBe(PATH);
    const body = JSON.parse(put!.body!) as {
      branch: string;
      sha: string;
      content: string;
    };
    expect(body.branch).toBe("main");
    expect(body.sha).toBe(current!.sha);
    expect(Buffer.from(body.content, "base64").toString("utf8")).toContain(
      "划线内容"
    );

    expect(await adapter.getDoc(KEY)).not.toBeNull();
    expect(sha).not.toBe(current!.sha);

    // 索引缓存已更新，不需要重新拉 Trees
    const treesBefore = gh.treeCalls;
    const index = await adapter.getIndex();
    expect(index[KEY]).toEqual({ sha, path: PATH });
    expect(gh.treeCalls).toBe(treesBefore);
  });

  it("旧版哈希路径自动迁移：写新路径（不带旧 sha）+ 删除旧文件", async () => {
    const { gh, adapter } = setup();
    gh.addFile(LEGACY_PATH, emptyDocData("https://x.com", "T"));
    await adapter.getIndex();
    const current = await adapter.getDoc(KEY);
    expect(current).not.toBeNull();

    const doc = emptyDocData("https://x.com", "T");
    doc.annotations.push(mkAnnotation({ quote: "迁移后的内容" }));
    const { sha } = await adapter.putDoc(KEY, doc, current!.sha);

    // 新路径创建：不能携带旧文件的 sha
    const put = gh.contentsCalls.find((call) => call.method === "PUT");
    expect(put!.path).toBe(PATH);
    expect(JSON.parse(put!.body!)).not.toHaveProperty("sha");

    // 旧文件被删除
    const del = gh.contentsCalls.find((call) => call.method === "DELETE");
    expect(del).toBeDefined();
    expect(del!.path).toBe(LEGACY_PATH);
    expect(gh.files.has(LEGACY_PATH)).toBe(false);
    expect(gh.files.has(PATH)).toBe(true);

    // 索引指向新路径
    expect(await adapter.storedPath(KEY)).toBe(PATH);
    expect((await adapter.getIndex())[KEY].sha).toBe(sha);
  });

  it("putDoc 409 → ShaConflictError，并让下次 getIndex 重新拉取", async () => {
    const { gh, adapter } = setup({ clock: { value: 1_000_000 } });
    gh.addFile(PATH, emptyDocData("https://x.com", "T"));
    await adapter.getIndex();
    expect(gh.treeCalls).toBe(1);

    gh.nextPutStatus = 409;
    const error = await adapter
      .putDoc(KEY, emptyDocData("https://x.com", "T"), "stale")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShaConflictError);
    expect((error as ShaConflictError).key).toBe(KEY);

    await adapter.getIndex();
    expect(gh.treeCalls).toBe(2);
  });

  it("putDoc 422 且消息含 sha → 视为冲突", async () => {
    const { gh, adapter } = setup();
    gh.addFile(PATH, emptyDocData("https://x.com", "T"));
    gh.nextPutStatus = 422;
    gh.nextPutMessage = "Invalid request.\n\n'sha' wasn't supplied.";

    await expect(
      adapter.putDoc(KEY, emptyDocData("https://x.com", "T"))
    ).rejects.toBeInstanceOf(ShaConflictError);
  });

  it("putDoc 其它错误抛 GitHubApiError", async () => {
    const { gh, adapter } = setup();
    gh.nextPutStatus = 500;
    gh.nextPutMessage = "boom";

    const error = await adapter
      .putDoc(KEY, emptyDocData("https://x.com", "T"))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(500);
    expect((error as GitHubApiError).detail).toBe("boom");
  });

  it("请求带上 Bearer token 与 API 版本头", async () => {
    const { gh, adapter } = setup();
    await adapter.getIndex();

    expect(gh.requests[0].headers.Authorization).toBe("Bearer tok");
    expect(gh.requests[0].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("限流错误文案包含服务端说明与限额重置时间", async () => {
    const resetAt = new Date("2026-10-23T15:04:00");
    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "tok",
      fetchFn: async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(resetAt.getTime() / 1000)),
          },
        }),
    });

    const error = (await adapter
      .testConnection()
      .then(() => null)
      .catch((e: unknown) => e)) as GitHubApiError;

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("API rate limit exceeded");
    expect(error.message).toContain("限额已用尽");
    expect(error.message).toContain("15:04");
  });

  it("网络错误保留底层原始信息", async () => {
    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "tok",
      fetchFn: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    const error = (await adapter
      .testConnection()
      .then(() => null)
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toContain("网络请求失败");
    expect(error.message).toContain("Failed to fetch");
  });

  it("testConnection 返回仓库全名与默认分支", async () => {
    const adapter = new GitHubAdapter({
      owner: "o",
      repo: "r",
      token: "tok",
      fetchFn: async () =>
        new Response(
          JSON.stringify({ full_name: "o/r", default_branch: "main" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    expect(await adapter.testConnection()).toEqual({
      fullName: "o/r",
      defaultBranch: "main",
    });
  });
});
