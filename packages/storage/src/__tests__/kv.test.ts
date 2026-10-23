import { describe, it, expect } from "vitest";
import { MemoryKVStore } from "../kv.js";

describe("MemoryKVStore", () => {
  it("get 未设置返回 undefined", async () => {
    const kv = new MemoryKVStore();
    expect(await kv.get("nope")).toBeUndefined();
  });

  it("set / get / delete 往返", async () => {
    const kv = new MemoryKVStore();
    await kv.set("a", "1");
    expect(await kv.get("a")).toBe("1");
    await kv.set("a", "2");
    expect(await kv.get("a")).toBe("2");
    await kv.delete("a");
    expect(await kv.get("a")).toBeUndefined();
  });

  it("keys 返回全部键", async () => {
    const kv = new MemoryKVStore();
    await kv.set("x", "1");
    await kv.set("y", "2");
    expect((await kv.keys()).sort()).toEqual(["x", "y"]);
  });

  it("delete 不存在的键不报错", async () => {
    const kv = new MemoryKVStore();
    await expect(kv.delete("ghost")).resolves.toBeUndefined();
  });
});
