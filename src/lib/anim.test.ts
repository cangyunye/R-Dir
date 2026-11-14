import { describe, it, expect } from "vitest";
import { setAnimLevelRef, getAnimLevelSetting, getAnimLevel, isElegant } from "./anim";

describe("动画级别镜像（JS 路径读取口）", () => {
  it("默认素；setAnimLevelRef 同步镜像", () => {
    expect(getAnimLevelSetting()).toBe("plain");
    setAnimLevelRef("elegant");
    expect(getAnimLevelSetting()).toBe("elegant");
    expect(isElegant()).toBe(true);
    setAnimLevelRef("plain");
    expect(isElegant()).toBe(false);
  });
  it("jsdom 无 matchMedia 实现减弱偏好 → 视作不折算", () => {
    setAnimLevelRef("elegant");
    // jsdom 的 matchMedia 返回 matches:false —— 雅保持雅
    expect(getAnimLevel()).toBe("elegant");
    setAnimLevelRef("plain");
  });
});
