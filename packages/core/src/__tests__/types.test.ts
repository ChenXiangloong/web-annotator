import { describe, it, expect } from "vitest";
import {
  Annotation,
  DocData,
  emptyDocData,
  activeAnnotations,
  compactGraveyard,
  mergeAnnotations,
  parseDoc,
  serializeDoc,
} from "../types.js";

function mk(id: string, updated: string, deleted_at: string | null = null): Annotation {
  return {
    id,
    quote: "hello",
    prefix: "",
    suffix: "",
    pos_hint: 0,
    comment: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: updated,
    deleted_at,
  };
}

describe("emptyDocData", () => {
  it("返回空 annotations 数组", () => {
    const d = emptyDocData("https://x.com");
    expect(d.url).toBe("https://x.com");
    expect(d.annotations).toEqual([]);
  });
});

describe("activeAnnotations", () => {
  it("过滤掉软删除", () => {
    const d: DocData = {
      url: "",
      title: "",
      annotations: [
        mk("a", "2026-01-01T00:00:00.000Z"),
        mk("b", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
      ],
    };
    expect(activeAnnotations(d)).toHaveLength(1);
    expect(activeAnnotations(d)[0].id).toBe("a");
  });
});

describe("compactGraveyard", () => {
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();

  it("移除 deleted_at 超过 maxAgeDays 的墓碑", () => {
    const d: DocData = {
      url: "",
      title: "",
      annotations: [
        mk("alive", "2026-05-01T00:00:00.000Z"),
        // 31 天前的墓碑（超过默认 30 天）
        mk("old", "2026-04-30T00:00:00.000Z", "2026-04-30T00:00:00.000Z"),
        // 29 天前的墓碑（应保留）
        mk("recent", "2026-05-03T00:00:00.000Z", "2026-05-03T00:00:00.000Z"),
      ],
    };
    const compacted = compactGraveyard(d, 30, now);
    expect(compacted.annotations.map((a) => a.id).sort()).toEqual([
      "alive", "recent",
    ]);
  });

  it("maxAgeDays 可自定义", () => {
    const d: DocData = {
      url: "",
      title: "",
      annotations: [
        mk("keep", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      ],
    };
    // maxAgeDays = 400 → 不过滤（距 now 约 150 天）
    expect(compactGraveyard(d, 400, now).annotations).toHaveLength(1);
    // maxAgeDays = 100 → 过滤掉
    expect(compactGraveyard(d, 100, now).annotations).toHaveLength(0);
  });

  it("没有墓碑时返回原对象", () => {
    const d: DocData = {
      url: "",
      title: "",
      annotations: [mk("alive", "2026-01-01T00:00:00.000Z")],
    };
    expect(compactGraveyard(d, 30, now)).toBe(d);
  });

  it("all 墓碑都应清理时返回新对象", () => {
    const d: DocData = {
      url: "",
      title: "",
      annotations: [
        mk("t1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      ],
    };
    expect(compactGraveyard(d, 30, now)).not.toBe(d);
    expect(compactGraveyard(d, 30, now).annotations).toEqual([]);
  });
});

describe("mergeAnnotations", () => {
  it("同 id 取 updated_at 较新者", () => {
    const a = mk("same", "2026-01-01T00:00:00.000Z");
    const b = { ...mk("same", "2026-01-05T00:00:00.000Z"), comment: "newer" };
    const merged = mergeAnnotations([a], [b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].comment).toBe("newer");
  });

  it("一侧有一侧没有 → 保留", () => {
    const merged = mergeAnnotations(
      [mk("only-local", "2026-01-01T00:00:00.000Z")],
      [mk("only-remote", "2026-01-01T00:00:00.000Z")]
    );
    expect(merged.map((a) => a.id).sort()).toEqual(["only-local", "only-remote"]);
  });

  it("按 created_at 排序", () => {
    const a = mk("a", "2026-01-01T00:00:00.000Z");
    a.created_at = "2026-01-02T00:00:00.000Z";
    const b = mk("b", "2026-01-01T00:00:00.000Z");
    b.created_at = "2026-01-01T00:00:00.000Z";
    const merged = mergeAnnotations([a], [b]);
    expect(merged[0].id).toBe("b");
    expect(merged[1].id).toBe("a");
  });

  it("pos_hint 是字符偏移量：同 quote 不同偏移是两条独立批注", () => {
    const first = { ...mk("first", "2026-01-01T00:00:00.000Z"), pos_hint: 1200 };
    const second = { ...mk("second", "2026-01-01T00:00:00.000Z"), pos_hint: 4800 };
    expect(first.quote).toBe(second.quote);

    const merged = mergeAnnotations([first], [second]);
    expect(merged.map((a) => a.id).sort()).toEqual(["first", "second"]);
    expect(merged.map((a) => a.pos_hint).sort((x, y) => x - y)).toEqual([
      1200, 4800,
    ]);
  });
});

describe("serializeDoc / parseDoc", () => {
  it("往返无损，且保持单一 annotations 数组", () => {
    const doc = emptyDocData("https://x.com/a", "标题", "作者");
    doc.annotations.push(
      mk("h1", "2026-01-01T00:00:00.000Z"),
      { ...mk("n1", "2026-01-02T00:00:00.000Z"), comment: "想法" }
    );
    doc.highlight_count = 1;
    doc.note_count = 1;

    const file = JSON.parse(serializeDoc(doc)) as Record<string, unknown>;

    expect(Array.isArray(file.annotations)).toBe(true);
    expect(file.highlights).toBeUndefined();
    expect(file.notes).toBeUndefined();
    expect((file.annotations as Annotation[]).map((a) => a.id)).toEqual(["h1", "n1"]);
    expect(serializeDoc(doc).endsWith("\n")).toBe(true);

    const restored = parseDoc(serializeDoc(doc));
    expect(restored).toEqual(doc);
  });
});
