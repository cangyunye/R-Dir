import { describe, expect, beforeEach, it } from "vitest";
import {
  isTopModalLayer,
  popModalLayer,
  pushModalLayer,
  resetModalLayers,
} from "./modal-stack";

describe("modal-stack 弹层栈仲裁", () => {
  beforeEach(() => resetModalLayers());

  it("未登记的弹层不是栈顶", () => {
    expect(isTopModalLayer("ghost")).toBe(false);
  });

  it("唯一弹层是栈顶", () => {
    pushModalLayer("a", 50);
    expect(isTopModalLayer("a")).toBe(true);
  });

  it("z 更高者在上", () => {
    pushModalLayer("settings", 50);
    pushModalLayer("deleteConfirm", 60);
    expect(isTopModalLayer("deleteConfirm")).toBe(true);
    expect(isTopModalLayer("settings")).toBe(false);
  });

  it("同 z 后打开者在上（与 CSS 绘制顺序一致）", () => {
    pushModalLayer("searchPanel", 50);
    pushModalLayer("settings", 50);
    expect(isTopModalLayer("settings")).toBe(true);
    expect(isTopModalLayer("searchPanel")).toBe(false);
  });

  it("低 z 弹层后打开仍不在高 z 之上", () => {
    pushModalLayer("deleteConfirm", 60);
    pushModalLayer("browse", 40);
    expect(isTopModalLayer("deleteConfirm")).toBe(true);
    expect(isTopModalLayer("browse")).toBe(false);
  });

  it("栈顶关闭后次层回位", () => {
    pushModalLayer("settings", 50);
    pushModalLayer("deleteConfirm", 60);
    popModalLayer("deleteConfirm");
    expect(isTopModalLayer("settings")).toBe(true);
  });

  it("重复登记同一 id 刷新其顺序（幂等）", () => {
    pushModalLayer("a", 50);
    pushModalLayer("b", 50);
    pushModalLayer("a", 50); // a 重新打开 → 反超 b
    expect(isTopModalLayer("a")).toBe(true);
    expect(isTopModalLayer("b")).toBe(false);
  });

  it("关闭未登记的 id 不抛错", () => {
    expect(() => popModalLayer("ghost")).not.toThrow();
  });

  it("z 更高的同 id 重复登记以新 z 生效", () => {
    pushModalLayer("x", 50);
    pushModalLayer("y", 60);
    pushModalLayer("x", 70);
    expect(isTopModalLayer("x")).toBe(true);
    expect(isTopModalLayer("y")).toBe(false);
  });
});
