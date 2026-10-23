import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome114",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [resolve(root, "src/content.ts")],
  outfile: resolve(dist, "content.js"),
});

await build({
  ...common,
  entryPoints: [resolve(root, "src/background.ts")],
  outfile: resolve(dist, "background.js"),
});

await build({
  ...common,
  entryPoints: [resolve(root, "src/options.ts")],
  outfile: resolve(dist, "options.js"),
});

await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
await copyFile(resolve(root, "options.html"), resolve(dist, "options.html"));
await cp(resolve(root, "icons"), resolve(dist, "icons"), { recursive: true });
