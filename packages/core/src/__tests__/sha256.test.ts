import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../sha256.js";
import { sha256 } from "../url.js";

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("sha256 兜底实现", () => {
  it("标准测试向量：空字符串与 abc", () => {
    expect(hex(sha256Bytes(enc.encode("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(hex(sha256Bytes(enc.encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("与 Web Crypto 结果一致（中文、长文本、多分组边界）", async () => {
    const samples = [
      "中文内容",
      "https://example.com/2026/04/10/article?utm_source=x&id=1",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(1000),
    ];
    for (const sample of samples) {
      expect(hex(sha256Bytes(enc.encode(sample)))).toBe(await sha256(sample));
    }
  });
});
