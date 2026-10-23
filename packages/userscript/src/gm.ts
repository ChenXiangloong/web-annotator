/**
 * Userscripts 管理器 API（GM_*）的封装层。
 *
 * ⚠️ 关键实现细节（真机实测确认）：
 * Userscripts（iOS, quoid）把 GM API 通过 Function 构造器参数注入：
 *   Function('{GM,GM_info,...}', userscriptCode)(apis)
 * 这些标识符是局部变量，不是 window/globalThis 的属性。
 * 因此必须用 typeof 探测裸标识符，检查 window.GM 永远得到 undefined。
 *
 * @grant 名称支持点式（GM.setValue）和下划线式（GM_setValue），
 * 内部统一处理：grant.startsWith("GM.") ? grant.slice(3) : grant
 *
 * token 纪律：本模块不打印任何请求头/值，日志只允许出现 key 名。
 */

import type { KVStore } from "@annotator/storage";

/** 同时兼容 GM_xxx 下划线式与 GM.xxx 点式两种暴露形态。 */
interface GMGlobal {
  GM_xmlhttpRequest?: (details: GMRequestDetails) => void;
  GM_setValue?: (key: string, value: unknown) => unknown;
  GM_getValue?: (key: string) => unknown;
  GM_deleteValue?: (key: string) => unknown;
  GM_listValues?: () => unknown;
  GM?: {
    xmlHttpRequest?: (details: GMRequestDetails) => void;
    setValue?: (key: string, value: unknown) => unknown;
    getValue?: (key: string) => unknown;
    deleteValue?: (key: string) => unknown;
    listValues?: () => unknown;
  };
}

interface GMRequestDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  onload?: (response: GMResponse) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}

/** 需实测：Userscripts iOS 的 onload 回调对象字段名以 TM 文档为准假设。 */
interface GMResponse {
  status?: number;
  statusText?: string;
  responseText?: string;
}

// Userscripts (quoid) 通过 Function 构造器参数注入这些标识符，
// 它们不存在于 window/globalThis 上，typeof 探测不会抛 ReferenceError。
declare const GM: GMGlobal["GM"];
declare const GM_getValue: GMGlobal["GM_getValue"];
declare const GM_setValue: GMGlobal["GM_setValue"];
declare const GM_deleteValue: GMGlobal["GM_deleteValue"];
declare const GM_listValues: GMGlobal["GM_listValues"];
declare const GM_xmlhttpRequest: GMGlobal["GM_xmlhttpRequest"];

function gm(): GMGlobal {
  const g = globalThis as unknown as GMGlobal;
  return {
    GM: typeof GM !== "undefined" && GM ? GM : g.GM,
    GM_getValue:
      typeof GM_getValue !== "undefined" ? GM_getValue : g.GM_getValue,
    GM_setValue:
      typeof GM_setValue !== "undefined" ? GM_setValue : g.GM_setValue,
    GM_deleteValue:
      typeof GM_deleteValue !== "undefined" ? GM_deleteValue : g.GM_deleteValue,
    GM_listValues:
      typeof GM_listValues !== "undefined" ? GM_listValues : g.GM_listValues,
    GM_xmlhttpRequest:
      typeof GM_xmlhttpRequest !== "undefined"
        ? GM_xmlhttpRequest
        : g.GM_xmlhttpRequest,
  };
}

/**
 * GM API 暴露情况的自检串，用于启动徽标与日志（不含任何凭证）。
 * 必须与 gm() 一样用 typeof 探测裸标识符——查 globalThis 永远全 ✗。
 */
export function gmDebugSummary(): string {
  const g = gm();
  const mark = (value: unknown): string =>
    typeof value === "function" ? "✓" : "✗";
  return [
    `GM.getValue${mark(g.GM_getValue ?? g.GM?.getValue)}`,
    `GM.setValue${mark(g.GM_setValue ?? g.GM?.setValue)}`,
    `GM.listValues${mark(g.GM_listValues ?? g.GM?.listValues)}`,
    `GM.xmlHttpRequest${mark(g.GM_xmlhttpRequest ?? g.GM?.xmlHttpRequest)}`,
  ].join(" ");
}

/** 四种 KV 原语 + xmlhttpRequest 都齐才认为环境可用。 */
export function gmAvailable(): boolean {
  const g = gm();
  const kv =
    (g.GM_setValue && g.GM_getValue && g.GM_deleteValue && g.GM_listValues) ||
    (g.GM?.setValue && g.GM?.getValue && g.GM?.deleteValue && g.GM?.listValues);
  const xhr = g.GM_xmlhttpRequest ?? g.GM?.xmlHttpRequest;
  return Boolean(kv && xhr);
}

async function call<T>(
  underscore: ((...args: never[]) => unknown) | undefined,
  dot: ((...args: never[]) => unknown) | undefined,
  ...args: unknown[]
): Promise<T> {
  const fn = (underscore ?? dot) as
    | ((...a: unknown[]) => unknown)
    | undefined;
  if (!fn) throw new Error("GM API 不可用（需实测：管理器是否支持）");
  // 需实测：GM_setValue 系在 Userscripts iOS 上是同步返回还是 Promise，
  // 这里统一 Promise.resolve 兼容两种。
  return (await Promise.resolve(fn(...args))) as T;
}

/**
 * 基于 GM_setValue 系的 KVStore。
 * 值一律存字符串；listValues 的返回类型需实测（假设 string[]）。
 */
export class GmKVStore implements KVStore {
  async get(key: string): Promise<string | undefined> {
    const value = await call<unknown>(
      gm().GM_getValue?.bind(null),
      gm().GM?.getValue?.bind(gm().GM),
      key
    );
    return typeof value === "string" ? value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await call(
      gm().GM_setValue?.bind(null),
      gm().GM?.setValue?.bind(gm().GM),
      key,
      value
    );
  }

  async delete(key: string): Promise<void> {
    await call(
      gm().GM_deleteValue?.bind(null),
      gm().GM?.deleteValue?.bind(gm().GM),
      key
    );
  }

  async keys(): Promise<string[]> {
    const list = await call<unknown>(
      gm().GM_listValues?.bind(null),
      gm().GM?.listValues?.bind(gm().GM)
    );
    return Array.isArray(list) ? list.filter((k) => typeof k === "string") : [];
  }
}

/**
 * 用 GM_xmlhttpRequest 拼出 fetch 的最小兼容面：
 * GitHubAdapter 只用 ok / status / statusText / json()。
 *
 * 走 GM 而不是页面 fetch 的原因：绕过页面 CSP 与跨域限制，
 * api.github.com 已在 userscript 头 @connect 里声明（需实测生效）。
 */
export function gmFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const request = gm().GM_xmlhttpRequest ?? gm().GM?.xmlHttpRequest;
  if (!request) {
    return Promise.reject(new Error("GM_xmlhttpRequest 不可用（需实测）"));
  }

  const url = String(input);
  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }

  return new Promise<Response>((resolve, reject) => {
    request({
      method: init?.method ?? "GET",
      url,
      headers,
      data: typeof init?.body === "string" ? init.body : undefined,
      onload: (r) => {
        const status = r.status ?? 0;
        const body = r.responseText ?? "";
        const response = {
          ok: status >= 200 && status < 300,
          status,
          statusText: r.statusText ?? "",
          json: () => Promise.resolve(JSON.parse(body) as unknown),
          text: () => Promise.resolve(body),
        };
        resolve(response as unknown as Response);
      },
      // 需实测：onerror 回调参数形状未知，绝不打印（可能含请求详情）。
      onerror: () => reject(new Error("GM_xmlhttpRequest 网络错误")),
      ontimeout: () => reject(new Error("GM_xmlhttpRequest 超时")),
    });
  });
}
