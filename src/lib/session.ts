/**
 * 会话序列化纯函数（v0.34 从 App.tsx 抽出，与 UI 解耦便于单测）：
 * TabState → SessionTab / SessionLayout 快照，供退出保存、Ctrl+S 主动保存、
 * 崩溃恢复自动保存与标签收藏共用。SFTP 只存 serverId，不含任何凭据。
 */
import type { SessionLayout, SessionTab, TabState } from "@/lib/types";

/** 从 sftp://user@host:port/path 提取 authority（= 服务器 id） */
export function sftpAuthorityId(path: string): string | null {
  const rest = path.startsWith("sftp://") ? path.slice("sftp://".length) : path;
  const authority = rest.split("/")[0] ?? "";
  if (!authority || !authority.includes("@")) return null;
  return authority;
}

/** 单个标签页 → SessionTab 快照（退出会话保存与标签收藏共用） */
export function serializeSessionTab(t: TabState): SessionTab {
  return {
    id: t.id,
    title: t.title,
    customTitle: t.customTitle,
    activePane: t.activePane,
    root: t.root,
    panes: Object.values(t.panes).map((p) => {
      if (p.path.startsWith("sftp://")) {
        return {
          id: p.id,
          path: p.path,
          kind: "sftp" as const,
          serverId: sftpAuthorityId(p.path) ?? undefined,
          zoom: p.zoom,
          viewMode: p.viewMode,
          iconSize: p.iconSize,
        };
      }
      if (p.tagId)
        return {
          id: p.id,
          path: p.path,
          kind: "tag" as const,
          tagId: p.tagId,
          zoom: p.zoom,
          viewMode: p.viewMode,
          iconSize: p.iconSize,
        };
      return { id: p.id, path: p.path, kind: "local" as const, zoom: p.zoom, viewMode: p.viewMode, iconSize: p.iconSize };
    }),
  };
}

/** 全部标签页 → 快照数组（serializeSession / sessionSignature 共用） */
function serializeSessionTabs(tabs: TabState[]): SessionTab[] {
  return tabs.map(serializeSessionTab);
}

/** 会话布局快照；savedAt 可注入（测试 / 签名场景传固定值） */
export function serializeSession(
  tabs: TabState[],
  activeId: number,
  savedAt: string = new Date().toISOString(),
): SessionLayout {
  return {
    version: 1,
    savedAt,
    activeTab: activeIndexOf(tabs, activeId),
    tabs: serializeSessionTabs(tabs),
  };
}

function activeIndexOf(tabs: TabState[], activeId: number): number {
  return Math.max(0, tabs.findIndex((t) => t.id === activeId));
}

/**
 * 会话内容签名（不含 savedAt）：自动保存脏检查用——布局没变就不写盘。
 * 覆盖标签页集合、各窗格路径/视图状态与活动标签；entries/selection 等瞬时状态不进签名。
 */
export function sessionSignature(tabs: TabState[], activeId: number): string {
  return JSON.stringify({ activeTab: activeIndexOf(tabs, activeId), tabs: serializeSessionTabs(tabs) });
}
