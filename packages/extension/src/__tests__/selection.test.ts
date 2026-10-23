// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { currentSelectionRange, isBlockedSelection } from "@annotator/ui";

describe("选区守卫", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="p">可以划线的正文</p>
      <input id="input" value="输入框">
      <textarea id="textarea">文本域</textarea>
      <div id="editable" contenteditable="true">可编辑区域</div>
      <div id="host" data-annotator-root></div>
    `;
  });

  it("普通正文可以划线", () => {
    const p = document.getElementById("p")!;
    expect(isBlockedSelection(p.firstChild)).toBe(false);
    expect(isBlockedSelection(p)).toBe(false);
  });

  it("input / textarea 内不触发", () => {
    expect(isBlockedSelection(document.getElementById("input"))).toBe(true);
    expect(isBlockedSelection(document.getElementById("textarea"))).toBe(true);
  });

  it("contenteditable 内不触发", () => {
    const editable = document.getElementById("editable")!;
    expect(isBlockedSelection(editable.firstChild)).toBe(true);
    expect(isBlockedSelection(editable)).toBe(true);
  });

  it("我们注入的 UI 宿主内不触发", () => {
    const host = document.getElementById("host")!;
    expect(isBlockedSelection(host)).toBe(true);
  });

  it("Shadow DOM 内不触发", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("p");
    inner.textContent = "shadow 内容";
    shadow.appendChild(inner);
    document.body.appendChild(host);

    expect(isBlockedSelection(inner.firstChild)).toBe(true);
  });

  it("空选区 / 折叠选区返回 null", () => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    expect(currentSelectionRange()).toBeNull();

    const p = document.getElementById("p")!;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 0);
    selection.addRange(range);
    expect(currentSelectionRange()).toBeNull();
  });

  it("正文选区正常返回", () => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();

    const p = document.getElementById("p")!;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    selection.addRange(range);

    const result = currentSelectionRange();
    expect(result).not.toBeNull();
    expect(result?.toString()).toBe("可以划线的");
  });
});
