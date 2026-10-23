/**
 * 打包 Userscripts 单文件产物：dist/annotator.user.js
 *
 * userscript 头依据 Userscripts 官方 README（github.com/quoid/userscripts）：
 *   - 「所有脚本至少要有一个 @match 或 @include」→ 两者都写上；
 *   - 「GM API 仅在 content 上下文可用」→ 显式 @inject-into content；
 *     （未声明时 GM API 可能拿不到，是 iOS 上 UI 不出现的常见原因之一）
 *   - @grant 的 API 名官方文档用点式（GM.setValue），部分管理器识别
 *     下划线式，这里两种都声明，避免被当作未授权；
 *   - @run-at document-start 与 Chrome 扩展 manifest 一致，确保在
 *     SPA 改写 URL 前拿到 initialUrl。
 *
 * 仍需真机实测的部分：@connect api.github.com 的域名匹配、GM.* 各方法
 * 的实际返回时序（官方文档标注为异步/Promise）。启动自检徽标会显示
 * 实际探测到的 GM API。
 *
 * ⚠️ 关键约束：Userscripts（iOS, quoid）用
 *   Function('{GM,GM_info,...}', code)(apis)
 * 注入脚本——参数是解构列表（non-simple parameters），此时函数体顶层
 * 若出现 "use strict" 指令会直接抛
 *   SyntaxError: Illegal 'use strict' directive in function with
 *   non-simple parameter list
 * 整个脚本一行都不执行（真机 UI 完全不出现的根因）。esbuild 的 iife
 * 产物默认带顶层 "use strict"，必须在写盘前删除。内部函数体内的
 * "use strict" 不受影响，无需处理。
 *
 * token 纪律：产物里不允许出现任何凭证，配置只来自运行时 GM 存储。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");

const HEADER = `// ==UserScript==
// @name         Web Annotator 网页划线批注
// @namespace    https://github.com/ChenXiangloong/web-annotator
// @version      0.2.0
// @description  任意网页选中文字划线/写想法，GitHub 仓库同步
// @match        *://*/*
// @include      *://*/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @inject-into  content
// @run-at       document-start
// ==/UserScript==
`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const outfile = resolve(dist, "annotator.user.js");
const result = await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "safari16",
  banner: { js: HEADER },
  logLevel: "info",
  write: false,
});

let code = result.outputFiles[0].text;
// 见文件头注释：删掉产物顶层第一个 "use strict";（只在 banner 之后出现一次），
// 否则 Userscripts 的 Function 解构参数注入会整个 SyntaxError。
const strictIdx = code.indexOf('"use strict";');
if (strictIdx !== -1) {
  code =
    code.slice(0, strictIdx) + code.slice(strictIdx + '"use strict";'.length);
}
await writeFile(outfile, code);

console.log("userscript 产物：dist/annotator.user.js");
