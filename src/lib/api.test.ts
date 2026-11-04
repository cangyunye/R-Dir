import { describe, it, expect, vi, afterEach } from "vitest";
import { isSelfMutatedDir, noteSelfMutatedDirs } from "./api";

/**
 * 本地 FS 变更登记（fs watcher 静默窗口）：应用自己的落盘操作登记受影响目录，
 * fs://changed 处理方据此跳过——watcher 轮询分不清内外改动，否则应用自己的
 * 新建/改名/删除/粘贴之后总要多刷一轮（「正在加载…」横条白闪第二次）。
 */
describe("api 自变更登记（fs watcher 静默窗口）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("未登记的目录不在静默窗口内", () => {
    expect(isSelfMutatedDir("/tmp/never-noted")).toBe(false);
  });

  it("登记后的目录在窗口内；窗口外（约4.5s）过期", () => {
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(1_000_000);
    noteSelfMutatedDirs(["/tmp/watched", null, undefined, ""]);
    expect(isSelfMutatedDir("/tmp/watched")).toBe(true);
    // 空/缺失路径不登记
    expect(isSelfMutatedDir("")).toBe(false);

    // 窗口边缘内（4s < 4.5s）仍静默
    spy.mockReturnValue(1_000_000 + 4_000);
    expect(isSelfMutatedDir("/tmp/watched")).toBe(true);
    // 出窗（5s）过期
    spy.mockReturnValue(1_000_000 + 5_000);
    expect(isSelfMutatedDir("/tmp/watched")).toBe(false);
  });

  it("同目录重复登记刷新时刻（连续操作持续静默）", () => {
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(2_000_000);
    noteSelfMutatedDirs(["/tmp/again"]);
    spy.mockReturnValue(2_000_000 + 3_000);
    noteSelfMutatedDirs(["/tmp/again"]);
    spy.mockReturnValue(2_000_000 + 4_000); // 距首次 4s 已过期，距续登 1s 仍在窗内
    expect(isSelfMutatedDir("/tmp/again")).toBe(true);
  });

  it("UNC / 反斜杠路径按原样登记比对", () => {
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(3_000_000);
    noteSelfMutatedDirs(["\\\\srv\\share\\dir"]);
    expect(isSelfMutatedDir("\\\\srv\\share\\dir")).toBe(true);
    expect(isSelfMutatedDir("\\\\srv\\share\\other")).toBe(false);
  });
});
