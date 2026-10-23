/**
 * 最小验证 demo：用 dom-anchor-text-quote 处理中文长句 / 重复句 / 跨节点 / 微小修改。
 * 由 esbuild 打包成 IIFE 后在 jsdom 中执行（见 run-demo.mjs）。
 */
import { describe, resolveAnchor } from "../src/anchor.js";

export interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

function rangeFromOffsets(root: Node, start: number, end: number): Range {
  const doc = root.ownerDocument as Document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let pos = 0;
  let startNode: Text | undefined;
  let startOffset = 0;
  let endNode: Text | undefined;
  let endOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (!startNode && start >= pos && start <= pos + len) {
      startNode = node;
      startOffset = start - pos;
    }
    if (!endNode && end >= pos && end <= pos + len) {
      endNode = node;
      endOffset = end - pos;
    }
    pos += len;
  }
  if (!startNode || !endNode) throw new Error("offsets out of range");
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function offsetOf(root: Node, range: Range): number {
  const doc = root.ownerDocument as Document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node === range.startContainer) return pos + range.startOffset;
    pos += node.data.length;
  }
  return -1;
}

export function run(doc: Document): CaseResult[] {
  const results: CaseResult[] = [];
  const host = doc.createElement("div");
  doc.body.appendChild(host);

  // ---- 用例 1：同一句话出现两次，应命中第二次 ----
  {
    const repeated = "积累财富不是一次性的冲刺而是持续多年的系统工程";
    host.innerHTML = `<p>开头。${repeated}（第一处）</p><p>中间。${repeated}（第二处）</p>`;
    const raw = host.textContent as string;
    const secondStart = raw.indexOf(repeated, raw.indexOf(repeated) + 1);
    const range = rangeFromOffsets(host, secondStart, secondStart + repeated.length);

    const anchor = describe(range, host);
    const resolved = resolveAnchor(anchor, host);
    const at = resolved ? offsetOf(host, resolved.range) : -1;

    results.push({
      name: "重复句命中第二次",
      ok:
        !!resolved &&
        resolved.level === "exact" &&
        at === secondStart &&
        resolved.range.toString() === repeated,
      detail: `level=${resolved?.level} start=${at} expected=${secondStart}`,
    });
  }

  // ---- 用例 2：中文长句（>32 字）被小幅修改，应模糊命中 ----
  {
    const long =
      "在职业生涯中积累财富需要长期坚持与理性决策而不是追逐短期收益也不能因为一时的市场波动而改变既定的长期计划";
    host.innerHTML = `<p>${long}。</p>`;
    const raw = host.textContent as string;
    const start = raw.indexOf(long);
    const range = rangeFromOffsets(host, start, start + long.length);
    const anchor = describe(range, host);

    // 模拟原文被小幅修改：改掉中间四个字
    const mutated = long.replace("理性决策", "理性判断");
    host.textContent = `${mutated}。`;

    const resolved = resolveAnchor(anchor, host);
    results.push({
      name: "中文长句（>32 字）小幅修改后模糊命中",
      ok:
        !!resolved &&
        resolved.level === "fuzzy" &&
        resolved.range.toString().includes("长期坚持"),
      detail: `level=${resolved?.level} matched="${resolved?.range.toString().slice(0, 24)}…"`,
    });
  }

  // ---- 用例 3：跨多个文本节点的选区 ----
  {
    host.innerHTML = `<p>这个选区从<em>这里开始</em>然后延伸到<strong>那里</strong>结束。</p>`;
    const raw = host.textContent as string;
    const start = raw.indexOf("从");
    const end = raw.indexOf("那里") + "那里".length;
    const range = rangeFromOffsets(host, start, end);
    const anchor = describe(range, host);
    const resolved = resolveAnchor(anchor, host);

    results.push({
      name: "跨多个文本节点选区可保存并恢复",
      ok:
        !!resolved &&
        resolved.level === "exact" &&
        resolved.range.toString() === anchor.quote &&
        resolved.range.startContainer !== resolved.range.endContainer,
      detail: `quote="${anchor.quote}" nodes=${
        resolved ? resolved.range.startContainer !== resolved.range.endContainer : false
      }`,
    });
  }

  // ---- 用例 4：原文完全不存在，应返回 null（孤立） ----
  {
    const target = "这段文字稍后会从页面上彻底消失";
    host.innerHTML = `<p>前文。${target}。后文。</p>`;
    const raw = host.textContent as string;
    const start = raw.indexOf(target);
    const anchor = describe(rangeFromOffsets(host, start, start + target.length), host);

    host.textContent = "页面内容已经被完全替换成另一篇毫不相干的文章。";
    const resolved = resolveAnchor(anchor, host);

    results.push({
      name: "原文不存在时返回 null（孤立批注）",
      ok: resolved === null,
      detail: `resolved=${resolved === null ? "null" : "range"}`,
    });
  }

  // ---- 用例 5：pos_hint 为空白折叠后的字符偏移 ----
  {
    host.innerHTML = `<div>
      <p>第一段有\n一些空白</p>
      <p>第二段的目标句子在这里。</p>
    </div>`;
    const raw = host.textContent as string;
    const start = raw.indexOf("目标句子");
    const anchor = describe(
      rangeFromOffsets(host, start, start + "目标句子".length),
      host
    );
    const expected = raw.slice(0, start).replace(/\s+/g, " ").length;

    results.push({
      name: "pos_hint 是空白折叠后的字符偏移",
      ok: anchor.pos_hint === expected,
      detail: `pos_hint=${anchor.pos_hint} expected=${expected}`,
    });
  }

  return results;
}
