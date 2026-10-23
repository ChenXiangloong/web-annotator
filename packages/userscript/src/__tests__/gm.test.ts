/**
 * gm.ts 单测：mock GM_* 全局，验证封装层行为。
 * 真机行为（Promise/同步、回调字段）以「需实测」为准，这里只锁定
 * 我们自己封装层的契约。
 */
import { afterEach, describe, expect, it } from "vitest";

import { GmKVStore, gmAvailable, gmFetch } from "../gm.js";

type GMShape = Record<string, unknown>;

function installGM(shape: GMShape): void {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(shape)) g[key] = value;
}

function uninstallGM(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.GM_xmlhttpRequest;
  delete g.GM_setValue;
  delete g.GM_getValue;
  delete g.GM_deleteValue;
  delete g.GM_listValues;
  delete g.GM;
}

afterEach(uninstallGM);

describe("gmAvailable", () => {
  it("全套 GM_* 下划线式可用时为 true", () => {
    installGM({
      GM_xmlhttpRequest: () => {},
      GM_setValue: () => {},
      GM_getValue: () => undefined,
      GM_deleteValue: () => {},
      GM_listValues: () => [],
    });
    expect(gmAvailable()).toBe(true);
  });

  it("GM.xxx 点式也可用", () => {
    installGM({
      GM: {
        xmlHttpRequest: () => {},
        setValue: () => {},
        getValue: () => undefined,
        deleteValue: () => {},
        listValues: () => [],
      },
    });
    expect(gmAvailable()).toBe(true);
  });

  it("缺任何一个原语都为 false", () => {
    installGM({
      GM_setValue: () => {},
      GM_getValue: () => undefined,
      GM_deleteValue: () => {},
      GM_listValues: () => [],
      // 没有 GM_xmlhttpRequest
    });
    expect(gmAvailable()).toBe(false);
    uninstallGM();
    expect(gmAvailable()).toBe(false);
  });
});

describe("GmKVStore", () => {
  it("set/get/delete/keys 全流程", async () => {
    const data = new Map<string, unknown>();
    installGM({
      GM_setValue: (k: string, v: unknown) => void data.set(k, v),
      GM_getValue: (k: string) => data.get(k),
      GM_deleteValue: (k: string) => void data.delete(k),
      GM_listValues: () => Array.from(data.keys()),
      GM_xmlhttpRequest: () => {},
    });

    const kv = new GmKVStore();
    expect(await kv.get("a")).toBeUndefined();
    await kv.set("a", "1");
    await kv.set("b", "2");
    expect(await kv.get("a")).toBe("1");
    expect((await kv.keys()).sort()).toEqual(["a", "b"]);
    await kv.delete("a");
    expect(await kv.keys()).toEqual(["b"]);
  });

  it("Promise 风格返回值同样兼容", async () => {
    const data = new Map<string, unknown>();
    installGM({
      GM_setValue: async (k: string, v: unknown) => void data.set(k, v),
      GM_getValue: async (k: string) => data.get(k),
      GM_deleteValue: async (k: string) => void data.delete(k),
      GM_listValues: async () => Array.from(data.keys()),
      GM_xmlhttpRequest: () => {},
    });

    const kv = new GmKVStore();
    await kv.set("x", "y");
    expect(await kv.get("x")).toBe("y");
  });

  it("非字符串值读取返回 undefined", async () => {
    installGM({
      GM_setValue: () => {},
      GM_getValue: () => 42,
      GM_deleteValue: () => {},
      GM_listValues: () => [],
      GM_xmlhttpRequest: () => {},
    });
    expect(await new GmKVStore().get("n")).toBeUndefined();
  });
});

describe("gmFetch", () => {
  it("把 method/headers/body 透传给 GM_xmlhttpRequest，并包装响应", async () => {
    let captured: {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      data?: string;
      onload?: (r: unknown) => void;
    } | null = null;
    installGM({
      GM_xmlhttpRequest: (details: typeof captured) => {
        captured = details;
      },
    });

    const pending = gmFetch("https://api.github.com/repos/o/r/contents/x", {
      method: "PUT",
      headers: { Authorization: "Bearer SECRET", Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message: "m" }),
    });

    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("PUT");
    expect(captured!.url).toBe("https://api.github.com/repos/o/r/contents/x");
    expect(captured!.headers?.Accept).toBe("application/vnd.github+json");
    expect(captured!.data).toBe('{"message":"m"}');

    captured!.onload!({
      status: 201,
      statusText: "Created",
      responseText: '{"content":{"sha":"abc"}}',
    });
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ content: { sha: "abc" } });
  });

  it("非 2xx 时 ok=false", async () => {
    installGM({
      GM_xmlhttpRequest: (details: { onload?: (r: unknown) => void }) => {
        details.onload!({ status: 404, statusText: "Not Found", responseText: "{}" });
      },
    });
    const response = await gmFetch("https://api.github.com/x");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it("onerror 时 reject，且不泄露请求详情", async () => {
    installGM({
      GM_xmlhttpRequest: (details: { onerror?: (e: unknown) => void }) => {
        details.onerror!({ error: "SECRET" });
      },
    });
    await expect(gmFetch("https://api.github.com/x")).rejects.toThrow(
      "GM_xmlhttpRequest 网络错误"
    );
  });

  it("GM_xmlhttpRequest 缺失时 reject", async () => {
    await expect(gmFetch("https://api.github.com/x")).rejects.toThrow(
      "GM_xmlhttpRequest 不可用"
    );
  });
});
