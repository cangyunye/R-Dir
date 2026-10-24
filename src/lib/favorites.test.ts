import { describe, it, expect } from "vitest";
import { dedupeName, favoritePaths, searchFavorites, makeFavorite } from "./favorites";

describe("dedupeName 收藏重名去重", () => {
  it("无冲突时原样返回", () => {
    expect(dedupeName("项目布局", ["另一个"])).toBe("项目布局");
  });

  it("重名自动加序号", () => {
    expect(dedupeName("项目布局", ["项目布局"])).toBe("项目布局 (2)");
    expect(dedupeName("项目布局", ["项目布局", "项目布局 (2)"])).toBe("项目布局 (3)");
  });

  it("空白名称回落默认名", () => {
    expect(dedupeName("   ", [])).toBe("收藏标签");
    expect(dedupeName("", ["收藏标签"])).toBe("收藏标签 (2)");
  });
});

describe("searchFavorites 收藏面板搜索", () => {
  const a = { ...makeFavorite("a", "需求排期", { title: "需求排期" }), updatedAt: "2026-01-01T00:00:00Z" };
  const b = { ...makeFavorite("b", "日志排查", { title: "日志排查" }), updatedAt: "2026-02-01T00:00:00Z" };
  const c = {
    ...makeFavorite("c", "发布窗口", {
      title: "发布窗口",
      panes: [
        { id: 1, path: "/Users/me/proj/tests", kind: "local" },
        { id: 2, path: "/Users/me/proj/logs", kind: "local" },
      ],
    }),
    updatedAt: "2026-03-01T00:00:00Z",
  };
  const items = [a, b, c];

  it("空查询按 updatedAt 倒序,无高亮位置", () => {
    const rows = searchFavorites(items, "");
    expect(rows.map((r) => r.item.id)).toEqual(["c", "b", "a"]);
    expect(rows[0].namePositions).toEqual([]);
  });

  it("按名称命中并高亮", () => {
    const rows = searchFavorites(items, "需求");
    expect(rows.map((r) => r.item.id)).toEqual(["a"]);
    expect(rows[0].namePositions).toEqual([0, 1]);
  });

  it("按窗格路径命中(与名称无关)", () => {
    const rows = searchFavorites(items, "tests");
    expect(rows.map((r) => r.item.id)).toEqual(["c"]);
    expect(rows[0].path).toBe("/Users/me/proj/tests");
    expect(rows[0].pathPositions.length).toBeGreaterThan(0);
  });

  it("展示路径取最佳命中而非首个", () => {
    const rows = searchFavorites(items, "logs");
    expect(rows[0].item.id).toBe("c");
    expect(rows[0].path).toBe("/Users/me/proj/logs");
  });

  it("无命中返回空", () => {
    expect(searchFavorites(items, "zzz")).toEqual([]);
  });

  it("名称命中排在路径命中之前(分数更高)", () => {
    // "发" 直接命中名称 vs "logs" 只命中路径
    const rows = searchFavorites(
      [c, { ...makeFavorite("d", "logs 专用") }],
      "log",
    );
    expect(rows[0].item.id).toBe("d");
  });
});

describe("favoritePaths", () => {
  it("返回全部窗格路径,过滤空值", () => {
    const fav = makeFavorite("x", "x", {
      panes: [
        { id: 1, path: "/a", kind: "local" },
        { id: 2, path: "", kind: "local" },
        { id: 3, path: "/c", kind: "local" },
      ],
    });
    expect(favoritePaths(fav)).toEqual(["/a", "/c"]);
  });
});
