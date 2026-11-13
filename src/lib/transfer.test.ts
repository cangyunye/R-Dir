import { describe, it, expect } from "vitest";
import {
  applyConflictAction,
  remoteNamesFromPlan,
  splitRemoteConflicts,
} from "./transfer";
import type { TransferConflict } from "./types";

const c = (dest: string): TransferConflict => ({
  src: `/src/${dest}`,
  dest: `/dst/${dest}`,
  srcKind: "file",
  destKind: "file",
  suggest: `${dest}_1`,
});

const three = [c("a.txt"), c("b.txt"), c("c.txt")];

describe("applyConflictAction", () => {
  it("覆盖单条并前进", () => {
    const r = applyConflictAction(three, 0, {}, { type: "overwrite" });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "overwrite" });
    expect(r.nextIndex).toBe(1);
    expect(r.finished).toBe(false);
    expect(r.stopped).toBe(false);
  });

  it("最后一条裁决后 finished", () => {
    const r = applyConflictAction(three, 2, {}, { type: "overwrite" });
    expect(r.finished).toBe(true);
    expect(r.nextIndex).toBe(3);
  });

  it("改名写入 name", () => {
    const r = applyConflictAction(three, 0, {}, { type: "rename", name: "a_1.txt" });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "rename", name: "a_1.txt" });
  });

  it("全部覆盖把当前及之后都设为覆盖", () => {
    const r = applyConflictAction(three, 1, { "/dst/a.txt": { action: "skip" } }, {
      type: "overwriteAll",
    });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "skip" });
    expect(r.plan["/dst/b.txt"]).toEqual({ action: "overwrite" });
    expect(r.plan["/dst/c.txt"]).toEqual({ action: "overwrite" });
    expect(r.finished).toBe(true);
  });

  it("停止返回 stopped 且不改方案", () => {
    const base = { "/dst/a.txt": { action: "overwrite" as const } };
    const r = applyConflictAction(three, 1, base, { type: "stop" });
    expect(r.stopped).toBe(true);
    expect(r.plan).toEqual(base);
  });
});

describe("splitRemoteConflicts", () => {
  const srcs = ["sftp://u@h:22/dst/f.txt", "sftp://u@h:22/dst/dir"];
  const topLevel: TransferConflict = {
    src: "sftp://u@h:22/dst/f.txt",
    dest: "sftp://u@h:22/dst2/f.txt",
    srcKind: "file",
    destKind: "file",
    suggest: "f_1.txt",
  };
  const drilled: TransferConflict = {
    src: "sftp://u@h:22/dst/dir/sub/n.txt",
    dest: "sftp://u@h:22/dst2/dir/sub/n.txt",
    srcKind: "file",
    destKind: "file",
    suggest: "n_1.txt",
  };

  it("顶层冲突进弹窗，下钻冲突按覆盖处理", () => {
    const r = splitRemoteConflicts([topLevel, drilled], srcs);
    expect(r.topLevel).toEqual([topLevel]);
    expect(r.drilled).toEqual([drilled]);
  });

  it("无冲突时两侧皆空", () => {
    const r = splitRemoteConflicts([], srcs);
    expect(r.topLevel).toEqual([]);
    expect(r.drilled).toEqual([]);
  });
});

describe("remoteNamesFromPlan", () => {
  const conflicts: TransferConflict[] = [
    {
      src: "sftp://u@h:22/a/f.txt",
      dest: "sftp://u@h:22/b/f.txt",
      srcKind: "file",
      destKind: "file",
      suggest: "f_1.txt",
    },
    {
      src: "sftp://u@h:22/a/g.txt",
      dest: "sftp://u@h:22/b/g.txt",
      srcKind: "file",
      destKind: "file",
      suggest: "g_1.txt",
    },
  ];

  it("rename 裁决折算为源条目的落盘名", () => {
    const names = remoteNamesFromPlan(conflicts, {
      "sftp://u@h:22/b/f.txt": { action: "rename", name: "f_1.txt" },
    });
    expect(names).toEqual({ "sftp://u@h:22/a/f.txt": "f_1.txt" });
  });

  it("覆盖裁决不改名", () => {
    const names = remoteNamesFromPlan(conflicts, {
      "sftp://u@h:22/b/f.txt": { action: "overwrite" },
      "sftp://u@h:22/b/g.txt": { action: "overwrite" },
    });
    expect(names).toEqual({});
  });
});
