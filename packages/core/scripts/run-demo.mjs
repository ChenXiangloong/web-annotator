/**
 * 验证 esbuild 打出的 IIFE 单文件（模拟 Userscripts 运行时）能否工作。
 * 用法：node packages/core/scripts/run-demo.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const bundlePath = process.argv[2] ?? "/tmp/anchor-demo.js";
const code = fs.readFileSync(bundlePath, "utf8");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

// 打包产物首行是 "use strict"，严格模式 eval 里的 var 不会挂到 window 上，
// 所以在同一段 eval 里显式导出到 globalThis。
dom.window.eval(`${code}\n;globalThis.AnchorDemo = AnchorDemo;`);

const api = dom.window.AnchorDemo;
if (!api || typeof api.run !== "function") {
  console.error("FAIL: IIFE bundle did not expose AnchorDemo.run");
  process.exit(1);
}

const results = api.run(dom.window.document);
const rows = results.map((r) => ({
  ...r,
  detail: `${r.detail} | bundle=${path.basename(bundlePath)}`,
}));
console.log(JSON.stringify(rows, null, 2));

process.exit(rows.every((r) => r.ok) ? 0 : 1);
