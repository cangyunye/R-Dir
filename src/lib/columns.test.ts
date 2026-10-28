import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getNameColumnWidth,
  setNameColumnWidth,
  resetNameColumnWidth,
  subscribeNameColumnWidth,
  NAME_COL_MIN,
  NAME_COL_MAX,
} from "./columns";

describe("columns 名称列宽存储", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("默认自动宽度 0，设置后读取一致", async () => {
    expect(getNameColumnWidth()).toBe(0);
    setNameColumnWidth(300);
    expect(getNameColumnWidth()).toBe(300);
  });

  it("夹在 MIN–MAX 区间", () => {
    setNameColumnWidth(10);
    expect(getNameColumnWidth()).toBe(NAME_COL_MIN);
    setNameColumnWidth(99999);
    expect(getNameColumnWidth()).toBe(NAME_COL_MAX);
  });

  it("持久化到 localStorage，重载模块后恢复", async () => {
    setNameColumnWidth(260);
    const mod = await import("./columns");
    expect(mod.getNameColumnWidth()).toBe(260);
  });

  it("reset 恢复自动宽度并清除持久化", () => {
    setNameColumnWidth(260);
    resetNameColumnWidth();
    expect(getNameColumnWidth()).toBe(0);
    expect(localStorage.getItem("rdir.nameColW")).toBeNull();
  });

  it("订阅者收到变更通知，退订后不再收", () => {
    const seen: number[] = [];
    const un = subscribeNameColumnWidth(() => seen.push(getNameColumnWidth()));
    setNameColumnWidth(200);
    un();
    setNameColumnWidth(240);
    expect(seen).toEqual([200]);
  });
});
