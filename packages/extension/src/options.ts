/**
 * 设置页：只负责把 owner / repo / branch / token 存进 chrome.storage.local。
 * service worker 读取同一份配置来创建 GitHubAdapter。
 */

const CONFIG_KEY = "annotator:github-config";

interface StoredConfig {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`missing input: ${id}`);
  }
  return element;
}

const ownerInput = input("owner");
const repoInput = input("repo");
const branchInput = input("branch");
const tokenInput = input("token");
const form = document.getElementById("form") as HTMLFormElement;
const statusEl = document.getElementById("status") as HTMLElement;
const clearCacheBtn = document.getElementById(
  "clear-cache"
) as HTMLButtonElement;
const clearStatusEl = document.getElementById("clear-status") as HTMLElement;

/** 已保存的 token；输入框留空时沿用它，避免把令牌回显到页面。 */
let savedToken = "";

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = (stored[CONFIG_KEY] ?? {}) as StoredConfig;

  ownerInput.value = config.owner ?? "";
  repoInput.value = config.repo ?? "";
  branchInput.value = config.branch ?? "main";

  savedToken = config.token ?? "";
  if (savedToken) {
    tokenInput.placeholder = "已保存，留空表示不修改";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

async function save(): Promise<void> {
  const owner = ownerInput.value.trim();
  const repo = repoInput.value.trim();
  const branch = branchInput.value.trim() || "main";
  const token = tokenInput.value.trim() || savedToken;

  if (!owner || !repo) {
    statusEl.textContent = "请填写仓库所有者和仓库名";
    return;
  }
  if (!token) {
    statusEl.textContent = "请填写 token";
    return;
  }

  await chrome.storage.local.set({
    [CONFIG_KEY]: { owner, repo, branch, token },
  });
  savedToken = token;
  tokenInput.value = "";
  tokenInput.placeholder = "已保存，留空表示不修改";

  statusEl.textContent = "已保存";
  window.setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
}

/**
 * 清除本机的批注数据：文档缓存、索引、上传队列、GitHub 索引缓存。
 * 保留 annotator:github-config（GitHub 凭证配置）。
 */
clearCacheBtn.addEventListener("click", () => {
  void clearCache();
});

async function clearCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith("annotator:") && k !== CONFIG_KEY
  );

  if (keys.length === 0) {
    clearStatusEl.textContent = "本地没有批注缓存";
  } else {
    await chrome.storage.local.remove(keys);
    clearStatusEl.textContent = `已清除 ${keys.length} 条本地数据`;
  }
  window.setTimeout(() => {
    clearStatusEl.textContent = "";
  }, 3000);
}

void load();
