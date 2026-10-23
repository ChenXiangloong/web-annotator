// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { PageResolver } from "../page-resolver.js";
import type { Annotation } from "../types.js";

function makeAnnotation(
  id: string,
  quote: string,
  prefix = "",
  suffix = ""
): Annotation {
  return {
    id,
    quote,
    prefix,
    suffix,
    pos_hint: 0,
    comment: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
  };
}

describe("PageResolver 页面级缓存", () => {
  beforeEach(() => {
    document.body.innerHTML = `<p id="p">这是一段用于缓存测试的正文内容，后面还有更多文字。</p>`;
  });

  it("同一页面只构建一份上下文", () => {
    const resolver = new PageResolver(document.body);
    const first = resolver.getContext();
    const second = resolver.getContext();
    expect(second).toBe(first);
  });

  it("同一条批注重复解析命中缓存", () => {
    const resolver = new PageResolver(document.body);
    const annotation = makeAnnotation("a1", "正文内容");

    const first = resolver.resolve(annotation);
    const second = resolver.resolve(annotation);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("invalidate 后重建上下文并清空缓存", () => {
    const resolver = new PageResolver(document.body);
    const annotation = makeAnnotation("a1", "正文内容");

    const before = resolver.getContext();
    const first = resolver.resolve(annotation);
    resolver.invalidate();
    const after = resolver.getContext();
    const second = resolver.resolve(annotation);

    expect(after).not.toBe(before);
    expect(second).not.toBe(first);
    expect(second?.range.toString()).toBe(first?.range.toString());
  });

  it("describe 与 resolve 使用同一份正文偏移", () => {
    const resolver = new PageResolver(document.body);
    const p = document.getElementById("p")!;
    const textNode = p.firstChild as Text;

    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);

    const anchor = resolver.describe(range);
    const annotation = { ...makeAnnotation("a1", anchor.quote), ...anchor };
    const resolved = resolver.resolve(annotation);

    expect(anchor.quote).toBe("缓存测试");
    expect(resolved?.matched).toBe(anchor.quote);
    expect(resolved?.level).toBe("exact");
  });

  it("forget 只清掉单条批注的缓存", () => {
    const resolver = new PageResolver(document.body);
    const first = resolver.resolve(makeAnnotation("a1", "正文内容"));
    const second = resolver.resolve(makeAnnotation("a2", "更多文字"));

    resolver.forget("a1");

    expect(resolver.resolve(makeAnnotation("a1", "正文内容"))).not.toBe(first);
    expect(resolver.resolve(makeAnnotation("a2", "更多文字"))).toBe(second);
  });
});
