// @vitest-environment jsdom
import { describe as describeSuite, it, expect, beforeEach } from "vitest";
import { buildPageText, collapseWhitespace } from "../index.js";
import { describe, resolve, resolveAnchor } from "../anchor.js";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function rangeFromOffsets(host: Node, start: number, end: number): Range {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let sn: Text | undefined, so = 0, en: Text | undefined, eo = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.data.length;
    if (!sn && start >= pos && start <= pos + len) {
      sn = n;
      so = start - pos;
    }
    if (!en && end >= pos && end <= pos + len) {
      en = n;
      eo = end - pos;
    }
    pos += len;
  }
  if (!sn || !en) throw new Error("offsets out of range");
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  return r;
}

describeSuite("修复 1：正文文本入口过滤噪声节点", () => {
  it("script / style 的内容不进入正文文本", () => {
    root.innerHTML = `<p>正文第一段。</p>
      <script>var noisy = "这段脚本内容不应参与锚点计算";</script>
      <style>.x { color: red; } 这段样式也不应参与</style>
      <p>正文第二段。</p>`;

    const pt = buildPageText(root);
    expect(pt.text).not.toContain("noisy");
    expect(pt.text).not.toContain("color");
    expect(pt.text.replace(/\s+/g, "")).toBe("正文第一段。正文第二段。");
  });

  it("隐藏元素（display:none / aria-hidden）被排除", () => {
    root.innerHTML = `<p>可见内容。</p>
      <p style="display:none">隐藏内容</p>
      <p aria-hidden="true">辅助隐藏内容</p>
      <p hidden>hidden 属性内容</p>`;

    expect(buildPageText(root).text.replace(/\s+/g, "")).toBe("可见内容。");
  });

  it("我们注入的 Shadow DOM 宿主被排除", () => {
    const host = document.createElement("div");
    host.setAttribute("data-annotator-root", "");
    host.innerHTML = "工具栏文字";
    root.innerHTML = "<p>正文。</p>";
    root.appendChild(host);

    expect(buildPageText(root).text).toBe("正文。");
  });

  it("含 script/style 时 pos_hint 与匹配结果不受影响", () => {
    const quote = "被划线的目标句子";
    root.innerHTML = `<script>${"x".repeat(500)}</script>
      <p>前文。${quote}</p>
      <style>${"y".repeat(300)}</style>`;

    const pt = buildPageText(root);
    const start = pt.text.indexOf(quote);

    // 用净文本偏移构造真实 Range
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let node: Text | undefined;
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.data.includes(quote)) {
        node = n;
        break;
      }
      pos += n.data.length;
    }
    const localStart = node!.data.indexOf(quote);
    const range = document.createRange();
    range.setStart(node!, localStart);
    range.setEnd(node!, localStart + quote.length);

    const anchor = describe(range, root);
    expect(anchor.quote).toBe(quote);
    expect(anchor.pos_hint).toBe(collapseWhitespace(pt.text.slice(0, start)).length);

    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("exact");
    expect(resolved!.range.toString()).toBe(quote);
  });

  it("跨节点选区在含噪声节点时仍然正确", () => {
    root.innerHTML = `<p>从<em>这里</em><script>噪声</script>到<strong>那里</strong>结束</p>`;
    const pt = buildPageText(root);
    expect(pt.text).toBe("从这里到那里结束");

    const start = pt.text.indexOf("从");
    const end = pt.text.indexOf("那里") + 2;

    // 用映射后的净偏移构造 Range（跨节点）
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (!n.data.includes("噪声")) nodes.push(n);
    }
    // nodes = ["从", "这里", "到", "那里", "结束"]
    const r = document.createRange();
    r.setStart(nodes[0], 0);
    r.setEnd(nodes[3], 2);

    const anchor = describe(r, root);
    expect(anchor.quote).toBe("从这里到那里");
    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.matched).toBe("从这里到那里");
    // Range 横跨 script，DOM 的 toString 会带出噪声；高亮渲染按可见文本节点分段，不受影响
    expect(resolved!.range.startContainer).not.toBe(resolved!.range.endContainer);
  });
});

describeSuite("修复 2：模糊匹配相似度校验", () => {
  it("短 quote 被改掉一半时返回 null", () => {
    const quote = "短句子测试"; // 5 字
    root.innerHTML = `<p>${quote}</p>`;
    const anchor = describe(rangeFromOffsets(root, 0, quote.length), root);

    root.textContent = "短句完全换了"; // 与原文只共享"短句"
    expect(resolve(anchor, root)).toBeNull();
  });

  it("短 quote 只改一个字仍然可以模糊命中", () => {
    const quote = "这是一个短句"; // 6 字
    root.innerHTML = `<p>${quote}</p>`;
    const anchor = describe(rangeFromOffsets(root, 0, quote.length), root);

    root.textContent = "这是一篇短句"; // 个→篇，相似度 5/6≈0.83
    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("fuzzy");
  });

  it("长 quote 改动超过 30% 时按孤立处理", () => {
    const quote =
      "这段话用于验证相似度阈值当改动幅度过大时不应该继续认为它还能匹配";
    root.innerHTML = `<p>${quote}</p>`;
    const anchor = describe(rangeFromOffsets(root, 0, quote.length), root);

    root.textContent = "完全另一段文字内容与原文几乎没有任何相同的地方存在";
    expect(resolve(anchor, root)).toBeNull();
  });
});

describeSuite("修复 3：页面顶部插入大量内容后的模糊匹配", () => {
  it("顶部插入 3000 字 + quote 小改动，仍能模糊命中", () => {
    const quote =
      "职业生涯早期最值得投资的是可迁移的技能而不是即时的薪水涨幅";
    root.innerHTML = `<p>${quote}</p>`;
    const anchor = describe(rangeFromOffsets(root, 0, quote.length), root);

    // 顶部插入 3000 字，同时把 quote 改掉两个字
    const filler = "填充".repeat(1500);
    const mutated = quote.replace("可迁移的技能", "可迁移的能力");
    root.textContent = `${filler}${mutated}`;

    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("fuzzy");
    expect(resolved!.matched).toContain("职业生涯早期");
  });

  it("插入 3000 字且 quote 完全不变时仍精确命中", () => {
    const quote = "长期主义在个人财富积累中比短期择时更重要";
    root.innerHTML = `<p>${quote}</p>`;
    const anchor = describe(rangeFromOffsets(root, 0, quote.length), root);

    root.textContent = `${"填充".repeat(1500)}${quote}`;
    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.level).toBe("exact");
  });
});
