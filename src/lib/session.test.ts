import { describe, it, expect } from "vitest";
import { serializeSession, serializeSessionTab, sessionSignature, sftpAuthorityId } from "./session";
import type { PaneState, TabState } from "./types";

/** 最小可用窗格（只填序列化涉及的字段） */
function pane(id: number, path: string, patch: Partial<PaneState> = {}): PaneState {
  return {
    id,
    path,
    title: path,
    history: [path],
    histIndex: 0,
    entries: [],
    loading: false,
    error: null,
    sortKey: "name",
    sortDir: "asc",
    zoom: 1,
    viewMode: "details",
    iconSize: 64,
    selection: ["/tmp/a.txt"],
    refreshKey: 3,
    ...patch,
  };
}

function tab(id: number, panes: PaneState[], activePane = panes[0].id, customTitle?: string): TabState {
  return {
    id,
    title: panes[0].path,
    customTitle,
    root: panes.length === 1 ? { type: "pane", paneId: panes[0].id } : { type: "split", id: 1, dir: "row", ratio: 0.5, a: { type: "pane", paneId: panes[0].id }, b: { type: "pane", paneId: panes[1].id } },
    activePane,
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
  };
}

describe("sftpAuthorityId", () => {
  it("从 sftp URL 提取 authority 作为 serverId", () => {
    expect(sftpAuthorityId("sftp://root@10.0.0.2:2222/var/log")).toBe("root@10.0.0.2:2222");
    expect(sftpAuthorityId("sftp://me@host/path")).toBe("me@host");
  });

  it("非 sftp 路径 / 无 authority 返回 null", () => {
    expect(sftpAuthorityId("/Users/me")).toBeNull();
    expect(sftpAuthorityId("sftp:///no-authority")).toBeNull();
  });
});

describe("serializeSessionTab", () => {
  it("本地窗格：保留 zoom/viewMode/iconSize，不携带瞬时状态", () => {
    const t = tab(1, [pane(10, "/Users/me/proj", { zoom: 1.25, viewMode: "icons", iconSize: 96 })]);
    const s = serializeSessionTab(t);
    expect(s).toEqual({
      id: 1,
      title: "/Users/me/proj",
      customTitle: undefined,
      activePane: 10,
      root: t.root,
      panes: [{ id: 10, path: "/Users/me/proj", kind: "local", zoom: 1.25, viewMode: "icons", iconSize: 96 }],
    });
  });

  it("SFTP 窗格只存 serverId，不含凭据", () => {
    const t = tab(2, [pane(11, "sftp://root@10.0.0.2:2222/var/log")]);
    const s = serializeSessionTab(t);
    expect(s.panes[0]).toMatchObject({ kind: "sftp", serverId: "root@10.0.0.2:2222", path: "sftp://root@10.0.0.2:2222/var/log" });
    expect(JSON.stringify(s)).not.toContain("password");
  });

  it("标签视图窗格存 tagId", () => {
    const t = tab(3, [pane(12, "tags://red", { tagId: "red" })]);
    expect(serializeSessionTab(t).panes[0]).toMatchObject({ kind: "tag", tagId: "red" });
  });

  it("自定义标题随快照保存", () => {
    const t = tab(4, [pane(13, "/tmp")], 13, "工作区");
    expect(serializeSessionTab(t).customTitle).toBe("工作区");
  });
});

describe("serializeSession", () => {
  const tabs = [
    tab(1, [pane(10, "/tmp")]),
    tab(2, [pane(20, "/var"), pane(21, "/Users/me")], 21),
  ];

  it("activeTab 转为索引，savedAt 可注入", () => {
    const s = serializeSession(tabs, 2, "2026-01-01T00:00:00Z");
    expect(s.version).toBe(1);
    expect(s.savedAt).toBe("2026-01-01T00:00:00Z");
    expect(s.activeTab).toBe(1);
    expect(s.tabs).toHaveLength(2);
  });

  it("activeId 不在列表中回落到第一个标签", () => {
    expect(serializeSession(tabs, 999, "x").activeTab).toBe(0);
  });

  it("同内容不同 savedAt 产出相同的 tabs/activeTab", () => {
    const a = serializeSession(tabs, 1, "2026-01-01T00:00:00Z");
    const b = serializeSession(tabs, 1, "2026-02-02T00:00:00Z");
    expect(a.tabs).toEqual(b.tabs);
    expect(a.activeTab).toBe(b.activeTab);
  });
});

describe("sessionSignature 自动保存脏检查", () => {
  const base = [tab(1, [pane(10, "/tmp", { viewMode: "details" })])];

  it("savedAt 不影响签名（serializeSession 内建签名一致）", () => {
    const sigOf = (activeId: number) => sessionSignature(base, activeId);
    expect(sigOf(1)).toBe(sigOf(1));
  });

  it("布局变化 → 签名变化", () => {
    const before = sessionSignature(base, 1);
    // 窗格路径变化
    const moved = [tab(1, [pane(10, "/etc")])];
    expect(sessionSignature(moved, 1)).not.toBe(before);
    // 活动标签变化
    const two = [...base, tab(2, [pane(20, "/var")])];
    expect(sessionSignature(two, 2)).not.toBe(sessionSignature(two, 1));
    // 视图模式变化
    const view = [tab(1, [pane(10, "/tmp", { viewMode: "icons" })])];
    expect(sessionSignature(view, 1)).not.toBe(before);
  });

  it("瞬时状态（entries/selection/loading）不进签名", () => {
    const noisy = [tab(1, [pane(10, "/tmp", { entries: [{ name: "a", path: "/tmp/a", is_dir: false, is_symlink: false, size: 1, modified: 1, created: null, permissions: "", extension: "" }], loading: true, refreshKey: 99 })])];
    expect(sessionSignature(noisy, 1)).toBe(sessionSignature(base, 1));
  });
});
