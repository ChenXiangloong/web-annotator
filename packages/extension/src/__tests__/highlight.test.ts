// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { buildPageText } from "@annotator/core";

import { MARK_CLASS, MarkRenderer } from "../highlight.js";

describe("MarkRenderer", () => {
  let renderer: MarkRenderer;

  beforeEach(() => {
    document.body.innerHTML = `<p id="p">Hello world</p>`;
    renderer = new MarkRenderer(document);
  });

  it("用 mark 包裹单个文本节点", () => {
    const p = document.getElementById("p")!;
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);

    renderer.render("a1", range);

    const marks = p.querySelectorAll(`mark.${MARK_CLASS}`);
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("world");
    expect(p.textContent).toBe("Hello world");
    expect(renderer.elementFor("a1")).toBe(marks[0]);
    expect(marks[0].getAttribute("data-annotation-id")).toBe("a1");
  });

  it("跨多个文本节点时逐段包裹，且不改变正文", () => {
    document.body.innerHTML = `<p id="p"><b>Hello</b> <i>brave</i> world</p>`;
    const p = document.getElementById("p")!;
    const bText = p.querySelector("b")!.firstChild as Text;
    const iText = p.querySelector("i")!.firstChild as Text;

    const range = document.createRange();
    range.setStart(bText, 2);
    range.setEnd(iText, 3);

    renderer.render("a1", range);

    const marks = Array.from(p.querySelectorAll(`mark.${MARK_CLASS}`));
    expect(marks.map((m) => m.textContent).join("|")).toBe("llo| |bra");
    expect(p.textContent).toBe("Hello brave world");
    expect(renderer.getAnnotationId(marks[2].firstChild)).toBe("a1");
  });

  it("clear 还原 DOM 并移除全部高亮", () => {
    const p = document.getElementById("p")!;
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    renderer.render("a1", range);

    renderer.clear();

    expect(p.querySelectorAll(`mark.${MARK_CLASS}`).length).toBe(0);
    expect(p.textContent).toBe("Hello world");
    expect(renderer.elementFor("a1")).toBeNull();
  });

  it("remove 只移除指定批注", () => {
    const p = document.getElementById("p")!;
    const first = p.firstChild as Text;
    const range1 = document.createRange();
    range1.setStart(first, 0);
    range1.setEnd(first, 5);

    renderer.render("a1", range1);

    const rest = p.lastChild as Text;
    const range2 = document.createRange();
    range2.setStart(rest, 0);
    range2.setEnd(rest, 5);
    renderer.render("a2", range2);

    renderer.remove("a1");

    expect(renderer.elementFor("a1")).toBeNull();
    expect(renderer.elementFor("a2")).not.toBeNull();
    expect(p.textContent).toBe("Hello world");
  });

  it("getAnnotationId 对非高亮目标返回 null", () => {
    const p = document.getElementById("p")!;
    expect(renderer.getAnnotationId(p)).toBeNull();
    expect(renderer.getAnnotationId(null)).toBeNull();
    expect(renderer.getAnnotationId((p.firstChild as Text).parentElement)).toBe(
      null
    );
  });

  it("样式只注入一次", () => {
    new MarkRenderer(document);
    new MarkRenderer(document);
    expect(document.querySelectorAll("#annotator-highlight-style").length).toBe(
      1
    );
  });
});

describe("MarkRenderer.renderBatch", () => {
  let renderer: MarkRenderer;

  beforeEach(() => {
    renderer = new MarkRenderer(document);
  });

  function pageFromBody() {
    return buildPageText(document.body);
  }

  it("同一文本节点上的多段高亮互不影响", () => {
    document.body.innerHTML = `<p id="p">Hello brave new world</p>`;
    const page = pageFromBody();

    renderer.renderBatch(
      [
        { id: "a1", start: 0, end: 5 }, // Hello
        { id: "a2", start: 6, end: 11 }, // brave
        { id: "a3", start: 16, end: 21 }, // world
      ],
      page
    );

    const marks = Array.from(
      document.querySelectorAll(`mark.${MARK_CLASS}`)
    );
    expect(marks.map((m) => m.textContent)).toEqual([
      "Hello",
      "brave",
      "world",
    ]);
    expect(marks.map((m) => m.getAttribute("data-annotation-id"))).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(document.getElementById("p")!.textContent).toBe(
      "Hello brave new world"
    );
  });

  it("跨节点区间与单节点区间可以同批渲染", () => {
    document.body.innerHTML = `<p id="p"><b>Hello</b> <i>brave</i> world</p>`;
    const page = pageFromBody();
    // 净文本："Hello brave world"
    // a1: "llo bra"（跨 b / 空白 / i），a2: "world"
    renderer.renderBatch(
      [
        { id: "a1", start: 2, end: 9 },
        { id: "a2", start: 12, end: 17 },
      ],
      page
    );

    const p = document.getElementById("p")!;
    const marks = Array.from(p.querySelectorAll(`mark.${MARK_CLASS}`));
    expect(marks.map((m) => m.textContent).join("|")).toBe(
      "llo| |bra|world"
    );
    expect(p.textContent).toBe("Hello brave world");
  });

  it("重叠区间只标一次，不抛错", () => {
    document.body.innerHTML = `<p id="p">Hello world</p>`;
    const page = pageFromBody();

    renderer.renderBatch(
      [
        { id: "a1", start: 0, end: 8 }, // "Hello wo"
        { id: "a2", start: 6, end: 11 }, // "world"（与 a1 重叠）
      ],
      page
    );

    const p = document.getElementById("p")!;
    expect(p.textContent).toBe("Hello world");
    const marks = Array.from(p.querySelectorAll(`mark.${MARK_CLASS}`));
    expect(marks.length).toBeGreaterThan(0);
    // a2 的重叠部分被截断到 a1 之后
    expect(
      marks
        .filter((m) => m.getAttribute("data-annotation-id") === "a2")
        .map((m) => m.textContent)
        .join("")
    ).toBe("rld");
  });

  it("渲染后可以 clear 还原，再次 renderBatch 结果一致", () => {
    document.body.innerHTML = `<p id="p">Hello brave new world</p>`;

    const spans = [
      { id: "a1", start: 0, end: 5 },
      { id: "a2", start: 6, end: 11 },
    ];
    renderer.renderBatch(spans, pageFromBody());
    expect(document.querySelectorAll(`mark.${MARK_CLASS}`).length).toBe(2);

    renderer.clear();
    expect(document.querySelectorAll(`mark.${MARK_CLASS}`).length).toBe(0);
    expect(document.getElementById("p")!.textContent).toBe(
      "Hello brave new world"
    );

    renderer.renderBatch(spans, pageFromBody());
    const marks = Array.from(
      document.querySelectorAll(`mark.${MARK_CLASS}`)
    );
    expect(marks.map((m) => m.textContent)).toEqual(["Hello", "brave"]);
  });
});
