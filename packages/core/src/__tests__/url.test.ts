import { describe, it, expect } from "vitest";
import { normalizeUrl, sha256, urlToKey, keyToPath } from "../url.js";

describe("normalizeUrl", () => {
  it("剥离 utm_* 参数", () => {
    expect(
      normalizeUrl(
        "https://example.com/article?utm_source=twitter&utm_medium=social&id=42"
      )
    ).toBe("https://example.com/article?id=42");
  });

  it("剥离确定的点击追踪参数（fbclid, gclid, gbraid, wbraid, mc_cid, mc_eid）", () => {
    expect(
      normalizeUrl(
        "https://example.com/?fbclid=abc&gclid=xyz&gbraid=1&wbraid=2&mc_cid=3&mc_eid=4&q=hi"
      )
    ).toBe("https://example.com/?q=hi");
  });

  it("身份参数必须保留：?id=123、?p=2、?page=3", () => {
    expect(normalizeUrl("https://example.com/post?id=123")).toBe(
      "https://example.com/post?id=123"
    );
    expect(normalizeUrl("https://example.com/list?p=2")).toBe(
      "https://example.com/list?p=2"
    );
    expect(normalizeUrl("https://example.com/list?page=3&id=7")).toBe(
      "https://example.com/list?id=7&page=3"
    );
  });

  it("歧义参数不剔除：from / ref / source / spm / referrer", () => {
    expect(
      normalizeUrl(
        "https://example.com/x?from=search&ref=issue-1&source=hn&spm=a1.b2&referrer=mail"
      )
    ).toBe(
      "https://example.com/x?from=search&ref=issue-1&referrer=mail&source=hn&spm=a1.b2"
    );
  });

  it("单独的 utm 参数不算追踪（只有 utm_ 前缀才剔除）", () => {
    expect(normalizeUrl("https://example.com/x?utm=keep")).toBe(
      "https://example.com/x?utm=keep"
    );
  });

  it("query 参数按 key 字典序排序", () => {
    expect(
      normalizeUrl("https://example.com/path?b=2&a=1&c=3")
    ).toBe("https://example.com/path?a=1&b=2&c=3");
  });

  it("移除 fragment", () => {
    expect(
      normalizeUrl("https://example.com/article#section-2")
    ).toBe("https://example.com/article");
    expect(
      normalizeUrl("https://example.com/article?x=1#frag")
    ).toBe("https://example.com/article?x=1");
  });

  it("host 小写、默认端口去掉", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM:443/foo")).toBe(
      "https://example.com/foo"
    );
    expect(normalizeUrl("http://Example.com:80/bar")).toBe(
      "http://example.com/bar"
    );
    expect(normalizeUrl("https://example.com:8443/foo")).toBe(
      "https://example.com:8443/foo"
    );
  });

  it("pathname 末尾单一 / 去掉，根路径保留", () => {
    expect(normalizeUrl("https://example.com/")).toBe(
      "https://example.com/"
    );
    expect(normalizeUrl("https://example.com/article/")).toBe(
      "https://example.com/article"
    );
    expect(normalizeUrl("https://example.com/a/b//")).toBe(
      "https://example.com/a/b"
    );
  });

  it("同一逻辑 URL 无论追踪参数和顺序如何都相同", () => {
    const a = normalizeUrl(
      "https://blog.io/2026/04/post/?utm_source=twitter&x=1&b=2&a=1#comment-1"
    );
    const b = normalizeUrl(
      "https://blog.io:443/2026/04/post?b=2&utm_campaign=spring&a=1&x=1#top"
    );
    expect(a).toBe(b);
  });

  it("无效 URL 抛 TypeError", () => {
    expect(() => normalizeUrl("not-a-url")).toThrow(TypeError);
    expect(() => normalizeUrl("")).toThrow(TypeError);
  });
});

describe("sha256", () => {
  it("返回小写十六进制字符串，固定 64 字符", async () => {
    const h = await sha256("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("相同输入相同输出", async () => {
    expect(await sha256("abc")).toBe(await sha256("abc"));
  });

  it("不同输入不同输出（基本区分度）", async () => {
    expect(await sha256("a")).not.toBe(await sha256("b"));
  });
});

describe("urlToKey", () => {
  it("返回 key 为 16 位十六进制、prefix 为前 2 位", async () => {
    const k = await urlToKey("https://example.com/article");
    expect(k.key).toHaveLength(16);
    expect(k.prefix).toBe(k.key.slice(0, 2));
    expect(k.normalizedUrl).toBe(normalizeUrl("https://example.com/article"));
  });

  it("归一化后相同 URL key 相同", async () => {
    const a = await urlToKey(
      "https://example.com/article?utm_source=x&b=2&a=1#frag"
    );
    const b = await urlToKey(
      "https://example.com/article?a=1&b=2#top"
    );
    expect(a.key).toBe(b.key);
  });

  it("身份参数不同 → key 不同", async () => {
    const id123 = await urlToKey("https://example.com/post?id=123");
    const id456 = await urlToKey("https://example.com/post?id=456");
    expect(id123.key).not.toBe(id456.key);

    const p1 = await urlToKey("https://example.com/list?p=1");
    const p2 = await urlToKey("https://example.com/list?p=2");
    expect(p1.key).not.toBe(p2.key);
  });

  it("只有追踪参数不同 → key 相同", async () => {
    const a = await urlToKey("https://example.com/post?id=9&utm_source=a");
    const b = await urlToKey("https://example.com/post?id=9&fbclid=b");
    expect(a.key).toBe(b.key);
  });
});

describe("keyToPath", () => {
  it("拼成 annotations/{prefix}/{key}.json", () => {
    expect(
      keyToPath({ key: "abcdef0123456789", normalizedUrl: "x", prefix: "ab" })
    ).toBe("annotations/ab/abcdef0123456789.json");
  });
});
