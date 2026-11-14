import { describe, it, expect } from "vitest";
import {
  applyConflictAction,
  drilledTypeClashes,
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

describe("drilledTypeClashes", () => {
  // 顶层同名目录行 + 其子树内的下钻类型冲突 / 文件冲突
  const dirRow: TransferConflict = {
    src: "sftp://u@h:22/a/tree",
    dest: "sftp://u@h:22/b/tree",
    srcKind: "dir",
    destKind: "dir",
    suggest: "tree_1",
  };
  const drilledType: TransferConflict = {
    src: "sftp://u@h:22/a/tree/clash",
    dest: "sftp://u@h:22/b/tree/clash",
    srcKind: "file",
    destKind: "dir",
    suggest: "clash_1",
  };
  const drilledFile: TransferConflict = {
    src: "sftp://u@h:22/a/tree/n.txt",
    dest: "sftp://u@h:22/b/tree/n.txt",
    srcKind: "file",
    destKind: "file",
    suggest: "n_1.txt",
  };

  it("顶层目录行获覆盖：下钻类型冲突保留（合并前预删除），文件冲突过滤", () => {
    const r = drilledTypeClashes([drilledType, drilledFile], [dirRow], {
      "sftp://u@h:22/b/tree": { action: "overwrite" },
    });
    expect(r).toEqual([drilledType]);
  });

  it("顶层目录行被改名：子树落新名无冲突，下钻行全部作废", () => {
    const r = drilledTypeClashes([drilledType, drilledFile], [dirRow], {
      "sftp://u@h:22/b/tree": { action: "rename", name: "tree_1" },
    });
    expect(r).toEqual([]);
  });

  it("无顶层行（防御）：维持覆盖行为", () => {
    const r = drilledTypeClashes([drilledType], [], {});
    expect(r).toEqual([drilledType]);
  });

  it("本地路径反斜杠分隔符同样判定 owner", () => {
    const localDir: TransferConflict = { ...dirRow, src: "C:\\src\\tree", dest: "sftp://u@h:22/b/tree" };
    const localDrill: TransferConflict = {
      ...drilledType,
      src: "C:\\src\\tree\\clash",
      dest: "sftp://u@h:22/b/tree/clash",
    };
    const r = drilledTypeClashes([localDrill], [localDir], {
      "sftp://u@h:22/b/tree": { action: "rename", name: "tree_1" },
    });
    expect(r).toEqual([]);
  });

  it("owner 取最长匹配（嵌套顶层行）", () => {
    const inner: TransferConflict = {
      src: "sftp://u@h:22/a/tree/sub",
      dest: "sftp://u@h:22/b/tree/sub",
      srcKind: "dir",
      destKind: "dir",
      suggest: "sub_1",
    };
    const deepDrill: TransferConflict = {
      ...drilledType,
      src: "sftp://u@h:22/a/tree/sub/clash",
      dest: "sftp://u@h:22/b/tree/sub/clash",
    };
    const r = drilledTypeClashes([deepDrill], [dirRow, inner], {
      "sftp://u@h:22/b/tree": { action: "overwrite" },
      "sftp://u@h:22/b/tree/sub": { action: "rename", name: "sub_1" },
    });
    expect(r).toEqual([]);
  });
});
