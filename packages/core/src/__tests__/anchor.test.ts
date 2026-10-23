// @vitest-environment jsdom
import { describe as describeSuite, it, expect, beforeEach } from "vitest";
import {
  collapseWhitespace,
  describe,
  resolve,
  resolveAnchor,
} from "../anchor.js";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

/** 用整段文本的字符偏移构造 Range（可跨节点）。 */
function rangeFromOffsets(host: Node, start: number, end: number): Range {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
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

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** Range 起点在整段文本中的字符偏移。 */
function startOffsetOf(host: Node, range: Range): number {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node === range.startContainer) return pos + range.startOffset;
    pos += node.data.length;
  }
  return -1;
}

describeSuite("describe", () => {
  it("返回 quote 与前后各最多 30 字", () => {
    const before = "前".repeat(50);
    const quote = "这是被划线的句子";
    const after = "后".repeat(50);
    root.innerHTML = `<p>${before}<span>${quote}</span>${after}</p>`;
    const raw = root.textContent as string;
    const start = raw.indexOf(quote);

    const anchor = describe(
      rangeFromOffsets(root, start, start + quote.length),
      root
    );

    expect(anchor.quote).toBe(quote);
    expect(anchor.prefix).toBe("前".repeat(30));
    expect(anchor.suffix).toBe("后".repeat(30));
  });

  it("pos_hint 是空白折叠后的字符偏移", () => {
    root.innerHTML = `<div>
      <p>第一段\n  有空白</p>
      <p>目标句在这里</p>
    </div>`;
    const raw = root.textContent as string;
    const start = raw.indexOf("目标句");

    const anchor = describe(
      rangeFromOffsets(root, start, start + "目标句".length),
      root
    );

    expect(anchor.pos_hint).toBe(collapseWhitespace(raw.slice(0, start)).length);
  });

  it("空 Range 抛出错误", () => {
    root.innerHTML = "<p>一段文字</p>";
    const range = document.createRange();
    range.setStart(root.firstChild as Node, 0);
    range.setEnd(root.firstChild as Node, 0);
    expect(() => describe(range, root)).toThrow();
  });
});

describeSuite("resolve - 精确匹配", () => {
  it("同一句话出现多次时，按 pos_hint 命中第二次", () => {
    const sentence = "积累财富不是一次性的冲刺而是持续多年的系统工程";
    root.innerHTML = `<p>开头。${sentence}（第一处）</p><p>中间。${sentence}（第二处）</p>`;
    const raw = root.textContent as string;
    const first = raw.indexOf(sentence);
    const second = raw.indexOf(sentence, first + 1);

    const anchor = describe(
      rangeFromOffsets(root, second, second + sentence.length),
      root
    );
    const resolved = resolveAnchor(anchor, root);

    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("exact");
    expect(startOffsetOf(root, resolved!.range)).toBe(second);
    expect(resolved!.range.toString()).toBe(sentence);
  });

  it("跨多个文本节点的选区能保存并恢复", () => {
    root.innerHTML = `<p>这个选区从<em>这里开始</em>然后延伸到<strong>那里</strong>结束。</p>`;
    const raw = root.textContent as string;
    const start = raw.indexOf("从");
    const end = raw.indexOf("那里") + "那里".length;

    const anchor = describe(rangeFromOffsets(root, start, end), root);
    const resolved = resolveAnchor(anchor, root);

    expect(anchor.quote).toBe("从这里开始然后延伸到那里");
    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("exact");
    expect(resolved!.range.toString()).toBe(anchor.quote);
    expect(resolved!.range.startContainer).not.toBe(
      resolved!.range.endContainer
    );
  });

  it("中文内容与英文内容都能精确恢复", () => {
    root.innerHTML = `<p>Some English words here. 还有一些中文内容在这里。</p>`;
    const raw = root.textContent as string;

    for (const quote of ["English words", "还有一些中文内容"]) {
      const start = raw.indexOf(quote);
      const anchor = describe(
        rangeFromOffsets(root, start, start + quote.length),
        root
      );
      const resolved = resolveAnchor(anchor, root);
      expect(resolved).not.toBeNull();
      expect(resolved!.level).toBe("exact");
      expect(resolved!.range.toString()).toBe(quote);
    }
  });
});

describeSuite("resolve - 模糊匹配", () => {
  it("中文长句（超过 diff-match-patch 的 32 字符切片上限）被小幅修改后仍能命中", () => {
    const long =
      "在职业生涯中积累财富需要长期坚持与理性决策而不是追逐短期收益也不能因为一时的市场波动而改变既定的长期计划";
    expect(long.length).toBeGreaterThan(32);
    root.innerHTML = `<p>${long}。</p>`;
    const raw = root.textContent as string;
    const start = raw.indexOf(long);
    const anchor = describe(
      rangeFromOffsets(root, start, start + long.length),
      root
    );

    // 原文被小幅修改：改掉其中四个字
    root.textContent = `${long.replace("理性决策", "理性判断")}。`;
    const resolved = resolveAnchor(anchor, root);

    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("fuzzy");
    expect(resolved!.range.toString()).toContain("长期坚持");
  });

  it("短文本小幅修改也能模糊命中，并标记为 fuzzy", () => {
    const quote = "这是一句会被稍微修改的测试文字";
    root.innerHTML = `<p>${quote}</p>`;
    const raw = root.textContent as string;
    const start = raw.indexOf(quote);
    const anchor = describe(
      rangeFromOffsets(root, start, start + quote.length),
      root
    );

    root.textContent = "这是一句会被稍微改动的测试文字";
    const resolved = resolveAnchor(anchor, root);

    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("fuzzy");
  });
});

describeSuite("resolve - 孤立批注", () => {
  it("原文完全不存在时 resolve 返回 null", () => {
    const target = "这段文字稍后会从页面上彻底消失";
    root.innerHTML = `<p>前文。${target}。后文。</p>`;
    const raw = root.textContent as string;
    const start = raw.indexOf(target);
    const anchor = describe(
      rangeFromOffsets(root, start, start + target.length),
      root
    );

    root.textContent = "页面内容已经被完全替换成另一篇毫不相干的文章。";

    expect(resolve(anchor, root)).toBeNull();
    expect(resolveAnchor(anchor, root)).toBeNull();
  });

  it("空 quote 返回 null", () => {
    root.innerHTML = "<p>有内容</p>";
    expect(
      resolve({ quote: "", prefix: "", suffix: "", pos_hint: 0 }, root)
    ).toBeNull();
  });

  it("空页面返回 null", () => {
    expect(
      resolve({ quote: "任意", prefix: "", suffix: "", pos_hint: 0 }, root)
    ).toBeNull();
  });
});

describeSuite("pos_hint 作为消歧线索", () => {
  it("同一 quote 在不同位置保存，各自恢复到原位置", () => {
    const sentence = "重复出现的句子用于验证位置消歧是否有效";
    root.innerHTML = `<p>${sentence}</p><p>中间隔一段。</p><p>${sentence}</p>`;
    const raw = root.textContent as string;
    const first = raw.indexOf(sentence);
    const second = raw.indexOf(sentence, first + 1);
    expect(first).not.toBe(second);

    const anchorFirst = describe(
      rangeFromOffsets(root, first, first + sentence.length),
      root
    );
    const anchorSecond = describe(
      rangeFromOffsets(root, second, second + sentence.length),
      root
    );

    const r1 = resolveAnchor(anchorFirst, root);
    const r2 = resolveAnchor(anchorSecond, root);

    expect(startOffsetOf(root, r1!.range)).toBe(first);
    expect(startOffsetOf(root, r2!.range)).toBe(second);
  });
});
