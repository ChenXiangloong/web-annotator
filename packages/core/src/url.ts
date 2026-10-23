/**
 * URL 规范化 + SHA-256 哈希 → 文档 key。
 *
 * 规范化规则：
 *   1. 解析为 URL 对象（无效则抛）
 *   2. 去掉确定的点击追踪参数（utm_* 前缀、fbclid、gclid、gbraid、wbraid、
 *      mc_cid、mc_eid）；身份参数（id、p、page 等）必须保留
 *   3. 移除 #fragment
 *   4. host 统一小写、默认端口去掉（:80 / :443）
 *   5. pathname 末尾的单一 / 去掉，但根路径 "/" 保留
 *   6. query 参数按 key 字典序排序（避免?b=2&a=1 与 ?a=1&b=2 不同 key）
 *
 * 哈希：规范化后字符串做 SHA-256，取前 16 位十六进制。
 */

import type { DocKey } from "./types.js";
import { sha256Bytes } from "./sha256.js";

/**
 * 要剥离的追踪 query 参数（小写精确匹配）。
 *
 * 只收「确定与页面身份无关」的点击追踪参数。像 from / ref / source / spm
 * 这类在不同站点上可能是业务参数（如 ?from=search、?ref=issue-1），
 * 剔除会造成不同页面撞成同一个 key，因此一律不剔除。
 */
const TRACKING_PARAMS = new Set([
  // Facebook
  "fbclid",
  // Google Ads / Analytics 点击 ID
  "gclid",
  "gbraid",
  "wbraid",
  // Mailchimp
  "mc_cid",
  "mc_eid",
]);

/** utm_* 全部视为追踪参数（仅前缀 utm_，单独的 utm 不算）。 */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * 规范化 URL 字符串。
 * 抛出 TypeError 如果输入不是合法 URL。
 */
export function normalizeUrl(input: string): string {
  if (!input || typeof input !== "string") {
    throw new TypeError("normalizeUrl: input must be a non-empty string");
  }
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new TypeError(`normalizeUrl: invalid URL: ${input}`);
  }

  // 1. host 小写
  u.hostname = u.hostname.toLowerCase();

  // 2. 去掉默认端口
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  // 3. 剥离追踪参数（忽略大小写）
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (isTrackingParam(k)) continue;
    kept.push([k, v]);
  }
  // 按 key 字典序排序
  kept.sort((a, b) => a[0].localeCompare(b[0]));
  // 重建 search
  u.search = kept.length
    ? kept
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
        )
        .join("&")
    : "";

  // 4. 移除 fragment
  u.hash = "";

  // 5. pathname 去掉末尾 /（根路径 "/" 不动）
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}

/**
 * SHA-256 哈希。优先用 Web Crypto（浏览器 + Node 20+）；
 * 非安全上下文里 crypto.subtle 不可用时退回纯 JS 实现。
 * 返回小写十六进制字符串。
 */
export async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const globalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.subtle?.digest === "function") {
    try {
      const buf = await globalCrypto.subtle.digest("SHA-256", enc);
      return toHex(new Uint8Array(buf));
    } catch {
      // 某些环境声明了 subtle 但调用失败，继续走兜底实现
    }
  }
  return toHex(sha256Bytes(enc));
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * 一步到位：输入 URL → 规范化 → 哈希 → DocKey。
 */
export async function urlToKey(input: string): Promise<DocKey> {
  const normalized = normalizeUrl(input);
  const hash = await sha256(normalized);
  const key = hash.slice(0, 16);
  return {
    key,
    normalizedUrl: normalized,
    prefix: key.slice(0, 2),
  };
}

/** 由 DocKey 拼成 GitHub 仓库里的文件相对路径。 */
export function keyToPath(key: DocKey): string {
  return `annotations/${key.prefix}/${key.key}.json`;
}
