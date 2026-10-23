import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocData } from "@annotator/core";
import { LocalAdapter } from "@annotator/storage";
import { ChromeStorageKVStore, type KVArea } from "../kv.js";

/** 按 chrome.storage.local 的行为模拟（get(null) 返回全部）。 */
class FakeArea implements KVArea {
  readonly data = new Map<string, unknown>();

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null || keys === undefined) {
      return Object.fromEntries(this.data);
    }
    const wanted = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const key of wanted) {
      if (this.data.has(key)) result[key] = this.data.get(key);
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, value);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.data.delete(key);
  }
}

describe("ChromeStorageKVStore", () => {
  let area: FakeArea;
  let store: ChromeStorageKVStore;

  beforeEach(() => {
    area = new FakeArea();
    store = new ChromeStorageKVStore(area);
  });

  it("set / get 往返", async () => {
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
  });

  it("缺失的 key 返回 undefined", async () => {
    expect(await store.get("missing")).toBeUndefined();
  });

  it("非字符串值不当作字符串返回", async () => {
    area.data.set("n", 42);
    expect(await store.get("n")).toBeUndefined();
  });

  it("keys 返回全部 key", async () => {
    await store.set("a", "1");
    await store.set("b", "2");
    expect((await store.keys()).sort()).toEqual(["a", "b"]);
  });

  it("delete 删除指定 key", async () => {
    await store.set("a", "1");
    await store.set("b", "2");
    await store.delete("a");
    expect(await store.keys()).toEqual(["b"]);
  });

  it("可以直接注入 LocalAdapter 使用", async () => {
    const adapter = new LocalAdapter(store);
    const doc = emptyDocData("https://example.com/a", "标题");
    doc.annotations.push({
      id: "x",
      quote: "原文",
      prefix: "",
      suffix: "",
      pos_hint: 0,
      comment: "想法",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
    });

    const { sha } = await adapter.putDoc("abc123", doc);
    const stored = await adapter.getDoc("abc123");
    const index = await adapter.getIndex();

    expect(stored?.doc.annotations[0].comment).toBe("想法");
    expect(stored?.sha).toBe(sha);
    expect(index["abc123"]).toEqual({ sha });
  });
});
