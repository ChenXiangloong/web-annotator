import { describe, expect, it } from "vitest";

import { emptyDocData, type Annotation, type DocData } from "@annotator/core";

import { LocalAdapter } from "../local.js";
import { MemoryKVStore } from "../kv.js";
import { ShaConflictError } from "../adapter.js";
import {
  MAX_BACKOFF_MS,
  SyncEngine,
  UploadQueue,
  backoffDelay,
} from "../sync.js";

function mkAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    quote: "hello",
    prefix: "pre",
    suffix: "post",
    pos_hint: 0,
    comment: "想法",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function docWith(url: string, annotations: Annotation[]): DocData {
  const doc = emptyDocData(url, "标题");
  doc.annotations = annotations;
  return doc;
}

function setup() {
  const localKv = new MemoryKVStore();
  const remoteKv = new MemoryKVStore();
  const queueKv = new MemoryKVStore();
  const clock = { value: 1_000_000 };
  const local = new LocalAdapter(localKv);
  const remote = new LocalAdapter(remoteKv);
  const queue = new UploadQueue(queueKv);
  const engine = new SyncEngine({
    local,
    remote,
    queue,
    now: () => clock.value,
  });
  return { localKv, remoteKv, queueKv, clock, local, remote, queue, engine };
}

describe("backoffDelay", () => {
  it("从 1s 起指数退避，封顶 5 分钟", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(10)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelay(100)).toBe(MAX_BACKOFF_MS);
  });
});

describe("UploadQueue", () => {
  it("enqueue 去重，并按 key 持久化", async () => {
    const { queue, queueKv } = setup();
    await queue.enqueue("k1", 100);
    await queue.enqueue("k2", 100);
    await queue.enqueue("k1", 200);

    const entries = await queue.list();
    expect(entries.map((entry) => entry.key)).toEqual(["k2", "k1"]);
    expect(entries.find((entry) => entry.key === "k1")!.nextAttemptAt).toBe(200);

    // 另一个实例能读到同一份队列（service worker 重启场景）
    const reloaded = await new UploadQueue(queueKv).list();
    expect(reloaded).toHaveLength(2);
  });

  it("due 只返回到期条目；remove 删除；清空后不留下空数组", async () => {
    const { queue, queueKv } = setup();
    await queue.enqueue("k1", 100);
    await queue.enqueue("k2", 500);

    expect((await queue.due(400)).map((entry) => entry.key)).toEqual(["k1"]);

    await queue.remove("k1");
    await queue.remove("k2");
    expect(await queue.list()).toEqual([]);
    expect(await queueKv.get("annotator:queue")).toBeUndefined();
  });

  it("markFailure 递增失败次数并安排下次时间", async () => {
    const { queue } = setup();
    await queue.enqueue("k", 1000);

    const first = await queue.markFailure("k", 1000);
    expect(first).toEqual({ key: "k", attempts: 1, nextAttemptAt: 2000 });

    const second = await queue.markFailure("k", 2000);
    expect(second).toEqual({ key: "k", attempts: 2, nextAttemptAt: 4000 });

    expect(await queue.markFailure("missing", 2000)).toBeNull();
  });
});

describe("SyncEngine.pull", () => {
  it("本地没有时把远端文档落到本地", async () => {
    const { local, remote, engine } = setup();
    await remote.putDoc("k", docWith("https://x.com", [mkAnnotation()]));

    const merged = await engine.pull("k");

    expect(merged).not.toBeNull();
    expect(merged!.annotations).toHaveLength(1);
    expect((await local.getDoc("k"))!.doc.annotations[0].id).toBe("a1");
  });

  it("远端不存在时返回 null，本地不变", async () => {
    const { local, engine } = setup();
    await local.putDoc("k", docWith("https://x.com", [mkAnnotation()]));

    expect(await engine.pull("k")).toBeNull();
    expect((await local.getDoc("k"))!.doc.annotations).toHaveLength(1);
  });

  it("按 id 合并：同一 id 取 updated_at 较新者，另一侧的独有条目保留", async () => {
    const { local, remote, engine } = setup();
    await local.putDoc(
      "k",
      docWith("https://x.com", [
        mkAnnotation({ id: "a1", comment: "本地旧", updated_at: "2026-01-01T00:00:00.000Z" }),
        mkAnnotation({ id: "local-only", quote: "本地独有" }),
      ])
    );
    await remote.putDoc(
      "k",
      docWith("https://x.com", [
        mkAnnotation({ id: "a1", comment: "远端新", updated_at: "2026-01-02T00:00:00.000Z" }),
        mkAnnotation({ id: "remote-only", quote: "远端独有" }),
      ])
    );

    const merged = await engine.pull("k");

    expect(merged!.annotations.map((item) => item.id).sort()).toEqual([
      "a1",
      "local-only",
      "remote-only",
    ]);
    expect(merged!.annotations.find((item) => item.id === "a1")!.comment).toBe(
      "远端新"
    );

    const stored = (await local.getDoc("k"))!.doc;
    expect(stored.annotations).toHaveLength(3);
  });

  it("远端与本地一致时不重复写入本地（sha 不变）", async () => {
    const { local, remote, engine } = setup();
    const doc = docWith("https://x.com", [mkAnnotation()]);
    await local.putDoc("k", doc);
    const localSha = (await local.getDoc("k"))!.sha;
    const remoteSha = (await remote.putDoc("k", doc)).sha;

    await engine.pull("k");

    const after = await local.getDoc("k");
    expect(after!.sha).toBe(localSha);
    expect((await remote.getDoc("k"))!.sha).toBe(remoteSha);
  });
});

describe("SyncEngine.push", () => {
  it("远端为空时上传本地文档", async () => {
    const { local, remote, engine } = setup();
    await local.putDoc("k", docWith("https://x.com", [mkAnnotation()]));

    expect(await engine.push("k")).toBe("uploaded");

    const stored = await remote.getDoc("k");
    expect(stored!.doc.annotations).toHaveLength(1);
    expect(stored!.doc.title).toBe("标题");
  });

  it("上传前先与远端合并，两边的条目都保留", async () => {
    const { local, remote, engine } = setup();
    await local.putDoc("k", docWith("https://x.com", [mkAnnotation({ id: "local" })]));
    await remote.putDoc("k", docWith("https://x.com", [mkAnnotation({ id: "remote" })]));

    await engine.push("k");

    const stored = await remote.getDoc("k");
    expect(stored!.doc.annotations.map((item) => item.id).sort()).toEqual([
      "local",
      "remote",
    ]);
  });

  it("内容已一致时不产生新的上传", async () => {
    const { local, remote, engine } = setup();
    const doc = docWith("https://x.com", [mkAnnotation()]);
    await local.putDoc("k", doc);
    const remoteSha = (await remote.putDoc("k", doc)).sha;

    expect(await engine.push("k")).toBe("unchanged");
    expect((await remote.getDoc("k"))!.sha).toBe(remoteSha);
  });

  it("写入瞬间被别的设备抢先修改 → 重拉合并后重试", async () => {
    const { local, queueKv } = setup();
    const remoteKv = new MemoryKVStore();

    await local.putDoc("k", docWith("https://x.com", [mkAnnotation({ id: "mine" })]));
    await new LocalAdapter(remoteKv).putDoc(
      "k",
      docWith("https://x.com", [mkAnnotation({ id: "base" })])
    );

    const racing = new RacingRemote(remoteKv);
    const racingEngine = new SyncEngine({
      local,
      remote: racing,
      queue: new UploadQueue(queueKv),
      now: () => 1_000_000,
    });

    await racingEngine.push("k");

    expect(racing.raced).toBe(true);
    const stored = await racing.getDoc("k");
    expect(stored!.doc.annotations.map((item) => item.id).sort()).toEqual([
      "base",
      "mine",
      "rival",
    ]);

    // 合并结果也落回了本地
    const localDoc = await local.getDoc("k");
    expect(localDoc!.doc.annotations.map((item) => item.id).sort()).toEqual([
      "base",
      "mine",
      "rival",
    ]);
  });

  it("本地没有文档时什么也不做", async () => {
    const { engine } = setup();
    expect(await engine.push("missing")).toBe("unchanged");
  });
});

describe("SyncEngine.flush", () => {
  it("上传到期条目并清空队列", async () => {
    const { local, remote, queue, engine } = setup();
    await local.putDoc("k1", docWith("https://x.com/1", [mkAnnotation()]));
    await local.putDoc("k2", docWith("https://x.com/2", [mkAnnotation()]));
    await queue.enqueue("k1", 1_000_000);
    await queue.enqueue("k2", 1_000_000);

    const result = await engine.flush(1_000_000);

    expect(result.pushed.sort()).toEqual(["k1", "k2"]);
    expect(result.failed).toEqual([]);
    expect(await queue.list()).toEqual([]);
    expect(await remote.getDoc("k1")).not.toBeNull();
    expect(await remote.getDoc("k2")).not.toBeNull();
  });

  it("失败保留队列并按退避延后；未到期时不再尝试", async () => {
    const { local, queueKv, clock } = setup();
    const remote = new FailingRemote();
    const queue = new UploadQueue(queueKv);
    const engine = new SyncEngine({ local, remote, queue, now: () => clock.value });

    await local.putDoc("k", docWith("https://x.com", [mkAnnotation()]));
    await queue.enqueue("k", clock.value);

    const first = await engine.flush(clock.value);
    expect(first.failed).toEqual(["k"]);
    expect(remote.putAttempts).toBe(1);

    const entry = (await queue.list())[0];
    expect(entry.attempts).toBe(1);
    expect(entry.nextAttemptAt).toBe(clock.value + 1000);

    clock.value += 999;
    await engine.flush(clock.value);
    expect(remote.putAttempts).toBe(1);

    clock.value += 1;
    await engine.flush(clock.value);
    expect(remote.putAttempts).toBe(2);
    const retried = (await queue.list())[0];
    expect(retried.attempts).toBe(2);
    expect(retried.nextAttemptAt).toBe(clock.value + 2000);
  });

  it("本地文档已被清掉时跳过并移除队列条目", async () => {
    const { queue, engine } = setup();
    await queue.enqueue("ghost", 1_000_000);

    const result = await engine.flush(1_000_000);

    expect(result.skipped).toEqual(["ghost"]);
    expect(await queue.list()).toEqual([]);
  });

  it("scheduleUpload = 入队 + 立刻上传", async () => {
    const { local, remote, engine } = setup();
    await local.putDoc("k", docWith("https://x.com", [mkAnnotation()]));

    const result = await engine.scheduleUpload("k");

    expect(result.pushed).toEqual(["k"]);
    expect(await remote.getDoc("k")).not.toBeNull();
  });
});

/** 第一次 putDoc 模拟被别的设备抢先：写入一条 rival 后抛冲突。 */
class RacingRemote extends LocalAdapter {
  raced = false;

  override async putDoc(
    key: string,
    doc: DocData,
    sha?: string
  ): Promise<{ sha: string }> {
    if (!this.raced) {
      this.raced = true;
      const current = await this.getDoc(key);
      if (current) {
        await super.putDoc(
          key,
          {
            ...current.doc,
            annotations: [
              ...current.doc.annotations,
              mkAnnotation({
                id: "rival",
                quote: "另一台设备",
                updated_at: "2026-01-03T00:00:00.000Z",
              }),
            ],
          },
          current.sha
        );
      }
      throw new ShaConflictError(key, sha, undefined);
    }
    return super.putDoc(key, doc, sha);
  }
}

class FailingRemote extends LocalAdapter {
  putAttempts = 0;

  constructor() {
    super(new MemoryKVStore());
  }

  override async putDoc(): Promise<{ sha: string }> {
    this.putAttempts++;
    throw new Error("offline");
  }
}
