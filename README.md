# Web Annotator 网页划线批注

个人使用的网页划线批注工具：在任意网页选中文字划线、写想法，刷新后自动恢复，并通过 GitHub 仓库在多设备之间同步。

核心逻辑用 TypeScript 写一份，分别打包为 **Chrome MV3 扩展** 和 **iOS Safari Userscripts 单文件脚本**。不使用 React / Vue，UI 由原生 DOM + Shadow DOM 实现。

## 功能

- **划线**：选中文字后点击「划线」，以 `<mark>` 恢复显示；无需输入文字。
- **写想法**：选中文字后点击「写想法」，在浮层编辑框中输入批注内容。
- **自动恢复**：刷新页面、重新打开页面后按锚点重新定位并渲染。
- **多端同步**：批注以 JSON 文件存入 GitHub 仓库，手机与电脑共享同一份数据。
- **本地优先**：先读本地缓存立即渲染，后台再拉取远端最新版本；离线时改动进入持久化队列，恢复联网后自动重试。
- **SPA 兼容**：`document_start` 阶段冻结初始 URL，避免页面路由改写地址后批注挂到错误的文档 key 上。
- **隐私**：GitHub token 只保存在本机存储，不进入构建产物、不写入日志、设置面板不回显完整 token。

## 平台支持

| 平台 | 形态 | 状态 |
| --- | --- | --- |
| Chrome / Edge（Chromium 114+） | MV3 扩展 | 已支持 |
| iOS Safari | Userscripts（quoid）单文件脚本 | 已支持，GM API 细节需真机实测 |
| Firefox / Safari 桌面版 | — | 未支持 |

## 快速开始

### 环境要求

- Node.js ≥ 20
- pnpm（仓库声明 `packageManager: pnpm@12.14.0`）

### 安装与构建

```bash
pnpm install
pnpm build          # 构建全部产物
pnpm test           # 运行单元测试
pnpm typecheck      # 类型检查
```

构建产物：

- Chrome 扩展：`packages/extension/dist/`（整个目录即为可加载的扩展）
- Userscripts：`packages/userscript/dist/annotator.user.js`

### 安装 Chrome 扩展

1. 打开 `chrome://extensions/`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `packages/extension/dist/`。
3. 在扩展详情页点击「扩展程序选项」，填写 GitHub 同步配置（见下文）。

### 安装 iOS Safari 脚本

1. 在 iPhone 上安装 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)，并在 Safari 扩展设置中启用、允许访问所有网站。
2. 将 `packages/userscript/dist/annotator.user.js` 导入 Userscripts App 并启用。
3. 打开任意网页，左下角/左上角会短暂出现启动自检徽标；正常启动后自动消失。若徽标变红常驻，说明 GM API 不可用或启动失败，页面上会直接显示原因。
4. 点击批注面板右上角 ⚙ 打开同步设置。

> iOS 上 Userscripts 的 GM API 注入方式、`GM_xmlhttpRequest` 回调字段、`@connect` 域名匹配等行为以真机实测为准，代码中相应位置标注了「需实测」。

### 配置 GitHub 同步

在设置页（Chrome 的扩展选项页 / Userscripts 的 ⚙ 面板）填写：

| 字段 | 说明 |
| --- | --- |
| `owner` | 仓库所有者，例如 `ChenXiangloong` |
| `repo` | 仓库名，例如 `my-annotations` |
| `branch` | 分支，默认 `main` |
| `token` | GitHub Personal Access Token，需要该仓库的 **Contents: Read and write** 权限 |

未配置时扩展仍可本地划线，所有同步操作静默跳过。Chrome 的选项页还提供「清除本地数据」，会删除文档缓存、索引、上传队列与索引缓存，但保留 token 配置。

## 使用

| 操作 | 说明 |
| --- | --- |
| 选中文字 | 在选区附近浮出「划线 / 写想法」按钮 |
| 划线 | 直接保存为纯划线批注 |
| 写想法 | 打开编辑框，保存后成为带评论的批注 |
| 点击右下角「批注」 | 打开批注列表面板，点击条目可滚动定位到原文 |
| 点击已有高亮 | 打开该条批注的编辑框，可修改或删除 |
| 设置 ⚙ | Userscripts 版在面板标题栏，仅用于同步配置 |

## 工作原理

### 文档 key 与 URL 规范化

URL 规范化规则：

1. 去掉点击追踪参数（`utm_*`、`fbclid`、`gclid`、`gbraid`、`wbraid`、`mc_cid`、`mc_eid`）；`id`、`p`、`page` 等身份参数保留。
2. 移除 `#fragment`。
3. host 小写、去掉默认端口（`:80` / `:443`）。
4. 去掉 pathname 末尾的单个 `/`（根路径 `/` 保留）。
5. query 参数按 key 字典序排序。

对规范化后的字符串做 SHA-256，取前 16 位十六进制作为文档 key。

### 锚点匹配

每条批注保存 `quote`（选中文本）、前后各 30 字符的 `prefix` / `suffix`，以及 `pos_hint`（在空白折叠后的正文文本中的字符偏移）。恢复时按三级规则匹配：

1. **精确**：定位成功且切片与 `quote` 逐字相等。
2. **模糊**：定位成功但存在差异，相似度达到阈值（diff-match-patch），仍渲染高亮。
3. **孤立**：无法定位或相似度不足，不高亮，仅在批注列表中降淡显示并标注「原文已找不到」，避免误标到无关位置。

定位基于「可见正文」文本（排除 `script` / `style` / 隐藏元素 / 本工具注入的 UI 宿主），避免页面结构噪声导致偏移漂移。锚点定位使用 `dom-anchor-text-quote` 与 `dom-anchor-text-position`。

### 存储布局

GitHub 仓库中每篇文章一个 JSON 文件：

```
annotations/{站点域名}/{标题 slug}-{key}.json
```

例如：

```
annotations/asheradeniyi.com/how-to-build-wealth-as-a-career-a1b2c3d4e5f60718.json
```

同域名文章自动归类，`{key}` 后缀保证唯一。旧版布局 `annotations/{key前2位}/{key}.json` 仍可被索引识别，写入新路径成功后自动删除旧文件。

文档结构示例：

```json
{
  "url": "https://example.com/post",
  "title": "文章标题",
  "author": "示例站点",
  "highlight_count": 1,
  "note_count": 1,
  "annotations": [
    {
      "id": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      "quote": "被划线的原文",
      "prefix": "前文上下文……",
      "suffix": "……后文上下文",
      "pos_hint": 1234,
      "comment": "",
      "created_at": "2026-10-23T09:00:00.000Z",
      "updated_at": "2026-10-23T09:00:00.000Z",
      "deleted_at": null
    }
  ]
}
```

- `comment` 为空字符串表示纯划线；`deleted_at` 非空为软删除墓碑。
- `author` / `highlight_count` / `note_count` 为派生字段，写入时自动刷新。
- 上传前会剔除超过 30 天的软删除墓碑（近期墓碑保留，用于跨设备传播删除）。

### 同步策略

- **拉取**：先渲染本地缓存，再后台 `pull` 远端；按 `id` 合并，同一 id 取 `updated_at` 较新者。
- **推送**：保存时先写本地，再进入持久化上传队列；`flush` 时用 GitHub Contents API 写入。
- **冲突**：远端 sha 不一致时重新拉取、合并，再用新 sha 重试。
- **失败重试**：指数退避，首次 1 秒，上限 5 分钟；离线改动不会丢失。
- **索引缓存**：用 Trees API 一次性列出 `annotations/` 下全部文件，缓存 5 分钟。无批注的页面在缓存有效期内打开不会发起任何网络请求。
- **定时器**：Chrome 通过每分钟一次的 `alarms` 执行 flush；Userscripts 用 60 秒定时器，并在页面隐藏时额外 flush。
- **网络位置**：Chrome 中所有网络请求与队列操作都在 background service worker 中执行，content script 只读写本地缓存。

## 项目结构

```
packages/
  core/        数据结构、URL 规范化与哈希、正文文本收集、锚点匹配、相似度
  storage/     存储适配器（Local / GitHub）、同步引擎、持久化上传队列
  ui/          Shadow DOM 界面、高亮渲染、选区处理、平台适配接口
  extension/   Chrome MV3 入口（content / background / options）与构建脚本
  userscript/  Userscripts 入口、GM API 封装、设置面板、单文件打包
types/         第三方库的补充类型声明
```

平台差异通过 `PlatformAdapter` 接口抽象：KV 存储、网络请求、同步触发都由各平台实现，UI 与核心逻辑不感知平台。

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 构建所有包含 build 脚本的包 |
| `pnpm test` | Vitest 运行全部单元测试 |
| `pnpm test:watch` | 监听模式 |
| `pnpm typecheck` | 所有包执行 `tsc --noEmit` |
| `pnpm clean` | 删除各包 `dist/` |

单独构建：

```bash
pnpm --filter @annotator/extension run build
pnpm --filter @annotator/userscript run build
```

### 打包注意事项

- **Userscripts 产物不能有顶层 `"use strict"`**：Userscripts 以 `Function('{GM,GM_info,...}', code)(apis)` 注入，non-simple 参数列表 + 顶层严格模式指令会直接抛 `SyntaxError`，整个脚本不执行。构建脚本会在写盘前删除 esbuild 默认添加的这行指令。
- **GM API 探测**：必须用 `typeof` 探测裸标识符，不能检查 `window.GM`。
- **UI 安全区**：iOS Safari 底部工具栏会遮挡 `bottom` 定位的常驻元素，UI 已避开底部约 100px。
- **Token 纪律**：token 只来自运行时存储，源码与产物中不得出现任何凭证。

## 已知限制

- 仅支持 `http` / `https` 页面，且只在顶层 frame 运行（`all_frames: false`）。
- 仅支持文本锚点；图片、PDF、Canvas 内文字无法划线。
- 未提供 Firefox / 桌面 Safari 版本。
- iOS Userscripts 的 GM API 行为、请求超时与 `@connect` 域名匹配需真机实测。
- 批注同步依赖 GitHub API 速率限制；大量写入时可能触发限流，队列会退避重试。
