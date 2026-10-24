/** 标签收藏夹纯函数:命名去重、面板搜索打分、路径展示。与 UI 解耦便于单测。 */
import { fuzzyMatch } from "@/lib/fuzzy";
import type { SessionTab, TabFavorite } from "@/lib/types";

/** 收藏面板行视图:名称命中位置 + 展示路径(最佳命中,无命中取首个)与命中位置 */
export interface FavoriteRow {
  item: TabFavorite;
  namePositions: number[];
  path: string;
  pathPositions: number[];
}

/** 收藏的全部窗格路径(搜索字段之二) */
export function favoritePaths(fav: TabFavorite): string[] {
  return fav.tab.panes.map((p) => p.path).filter(Boolean);
}

/** 重名去重:base、base (2)、base (3)…;空名回落「收藏标签」 */
export function dedupeName(base: string, existing: readonly string[]): string {
  const trimmed = base.trim() || "收藏标签";
  const taken = new Set(existing);
  if (!taken.has(trimmed)) return trimmed;
  for (let i = 2; ; i++) {
    const cand = `${trimmed} (${i})`;
    if (!taken.has(cand)) return cand;
  }
}

/** 面板搜索:空查询按 updatedAt 倒序;非空对「名称 + 各窗格路径」分别 fzf 打分,
 *  任一命中即入选,按最高分降序(稳定)。展示路径取最佳命中的窗格路径。 */
export function searchFavorites(
  items: readonly TabFavorite[],
  query: string,
): FavoriteRow[] {
  const q = query.trim();
  if (!q) {
    return [...items]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((item) => ({
        item,
        namePositions: [],
        path: favoritePaths(item)[0] ?? "",
        pathPositions: [],
      }));
  }
  const scored: { row: FavoriteRow; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const nameMatch = fuzzyMatch(q, item.name);
    let bestPath: { path: string; score: number; positions: number[] } | null = null;
    for (const p of favoritePaths(item)) {
      const m = fuzzyMatch(q, p);
      if (m && (!bestPath || m.score > bestPath.score)) {
        bestPath = { path: p, score: m.score, positions: m.positions };
      }
    }
    const score = Math.max(
      nameMatch?.score ?? Number.NEGATIVE_INFINITY,
      bestPath?.score ?? Number.NEGATIVE_INFINITY,
    );
    if (score === Number.NEGATIVE_INFINITY) return;
    scored.push({
      row: {
        item,
        namePositions: nameMatch?.positions ?? [],
        path: bestPath?.path ?? favoritePaths(item)[0] ?? "",
        pathPositions: bestPath?.positions ?? [],
      },
      score,
      i,
    });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.row);
}

/** 测试/构造辅助:最小可用收藏项 */
export function makeFavorite(id: string, name: string, tab?: Partial<SessionTab>): TabFavorite {
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    tab: {
      id: 1,
      title: name,
      activePane: 1,
      root: { type: "pane", paneId: 1 },
      panes: [{ id: 1, path: "/tmp", kind: "local" }],
      ...tab,
    },
  };
}
