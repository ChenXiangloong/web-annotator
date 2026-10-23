import { describe, it, expect } from "vitest";
import { LocalAdapter, ShaConflictError } from "../index.js";
import { MemoryKVStore } from "../kv.js";
import { emptyDocData, type Annotation } from "@annotator/core";

function mkAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    quote: "hello",
    prefix: "pre",
    suffix: "post",
    pos_hint: 128,
    comment: "nice",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function setup(kv = new MemoryKVStore()) {
  return { kv, adapter: new LocalAdapter(kv) };
}

describe("LocalAdapter", () => {
  it("putDoc 后 getDoc 能取回 doc 和 sha", async () => {
    const { adapter } = setup();
    const doc = emptyDocData("https://x.com/article", "Title");
    doc.annotations.push(mkAnnotation());

    const { sha } = await adapter.putDoc("abc123", doc);
    const got = await adapter.getDoc("abc123");

    expect(got).not.toBeNull();
    expect(got!.sha).toBe(sha);
    expect(got!.doc.annotations).toHaveLength(1);
    expect(got!.doc.annotations[0].comment).toBe("nice");
  });

  it("getDoc 不存在返回 null", async () => {
    const { adapter } = setup();
    expect(await adapter.getDoc("no-such-key")).toBeNull();
  });

  it("getIndex 返回 key → 索引条目", async () => {
    const { adapter } = setup();
    const r1 = await adapter.putDoc("k1", emptyDocData("https://a.com", "A"));
    const r2 = await adapter.putDoc("k2", emptyDocData("https://b.com", "B"));

    const idx = await adapter.getIndex();
    expect(idx).toEqual({ k1: { sha: r1.sha }, k2: { sha: r2.sha } });
  });

  it("兼容旧版索引格式（value 直接是 sha 字符串）", async () => {
    const kv = new MemoryKVStore();
    await kv.set("annotator:index", JSON.stringify({ k1: "oldsha" }));
    const adapter = new LocalAdapter(kv);

    const idx = await adapter.getIndex();
    expect(idx).toEqual({ k1: { sha: "oldsha" } });
    expect(await adapter.hasDoc("k1")).toBe(true);
  });

  it("相同内容写入 → sha 稳定；内容变化 → sha 变化", async () => {
    const { adapter } = setup();
    const doc = emptyDocData("https://x.com", "T");

    const a = await adapter.putDoc("k", doc);
    const b = await adapter.putDoc("k", doc);
    expect(b.sha).toBe(a.sha);

    doc.annotations.push(mkAnnotation());
    const c = await adapter.putDoc("k", doc);
    expect(c.sha).not.toBe(a.sha);
  });

  it("sha 匹配时允许写入", async () => {
    const { adapter } = setup();
    const doc = emptyDocData("https://x.com", "T");
    const { sha } = await adapter.putDoc("k", doc);

    doc.annotations.push(mkAnnotation({ comment: "added" }));
    const next = await adapter.putDoc("k", doc, sha);
    expect(next.sha).not.toBe(sha);

    const got = await adapter.getDoc("k");
    expect(got!.doc.annotations[0].comment).toBe("added");
  });

  it("sha 不匹配时抛 ShaConflictError，且不写入", async () => {
    const { adapter } = setup();
    const doc = emptyDocData("https://x.com", "T");
    await adapter.putDoc("k", doc);

    const staleDoc = emptyDocData("https://x.com", "T");
    staleDoc.annotations.push(mkAnnotation({ comment: "should not persist" }));

    const err = await adapter
      .putDoc("k", staleDoc, "deadbeef")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShaConflictError);
    expect((err as ShaConflictError).key).toBe("k");
    expect((err as ShaConflictError).expectedSha).toBe("deadbeef");
    expect((err as ShaConflictError).actualSha).toBeDefined();

    const got = await adapter.getDoc("k");
    expect(got!.doc.annotations).toHaveLength(0);
  });

  it("对不存在的文档传 sha → 也算冲突（避免覆盖他人新建的文档）", async () => {
    const { adapter } = setup();
    const err = await adapter
      .putDoc("missing", emptyDocData("https://x.com", ""), "somesha")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShaConflictError);
    expect((err as ShaConflictError).actualSha).toBeUndefined();
  });

  it("数据只经过 KVStore，不直接依赖 localStorage", async () => {
    const kv = new MemoryKVStore();
    const adapter = new LocalAdapter(kv, "test:");
    await adapter.putDoc("k", emptyDocData("https://x.com", "T"));

    const keys = await kv.keys();
    expect(keys).toContain("test:index");
    expect(keys).toContain("test:doc:k");
  });

  it("hasDoc 基于索引", async () => {
    const { adapter } = setup();
    expect(await adapter.hasDoc("new")).toBe(false);
    await adapter.putDoc("new", emptyDocData("https://x.com", ""));
    expect(await adapter.hasDoc("new")).toBe(true);
  });
});
