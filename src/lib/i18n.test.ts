import { afterEach, describe, expect, it } from "vitest";
import { isCancelledError, setPack, t, terr, type Pack } from "./i18n";

const fakePack: Pack = {
  meta: { id: "xx", name: "Test", version: "0.1.0" },
  strings: {
    "删除": "Delete",
    "共 {n} 项": "{n} items",
    "操作失败：{msg}": "Operation failed: {msg}",
  },
  errors: {
    CANCELLED: "Cancelled",
    NEED_PASSWORD: "Password required",
  },
};

afterEach(() => {
  // 模块级包是全局状态，逐用例还原，避免影响其他测试文件
  setPack(null);
});

describe("t：占位符替换与包缺失回退", () => {
  it("无包时回退 key 原文（中文），占位符仍替换", () => {
    setPack(null);
    expect(t("删除")).toBe("删除");
    expect(t("共 {n} 项", { n: 3 })).toBe("共 3 项");
  });

  it("有包时按表翻译并替换占位符", () => {
    setPack(fakePack);
    expect(t("删除")).toBe("Delete");
    expect(t("共 {n} 项", { n: 12 })).toBe("12 items");
    expect(t("操作失败：{msg}", { msg: "磁盘已满" })).toBe("Operation failed: 磁盘已满");
  });

  it("包内缺失的 key 回退 key 原文（英文滞后不阻塞新增文案）", () => {
    setPack(fakePack);
    expect(t("不存在")).toBe("不存在");
    expect(t("重命名 {name} 失败", { name: "a.txt" })).toBe("重命名 a.txt 失败");
  });
});

describe("terr：错误码解析", () => {
  it("无码中文原样透传", () => {
    setPack(fakePack);
    expect(terr("读取目录失败：权限不足")).toBe("读取目录失败：权限不足");
  });

  it("无包时纯码原样透传，带详情剥码留详情（zh 显示与码化前一致）", () => {
    setPack(null);
    expect(terr("CANCELLED")).toBe("CANCELLED");
    expect(terr("CMD_NOT_FOUND|未找到命令：foo（不在 PATH 中）")).toBe(
      "未找到命令：foo（不在 PATH 中）",
    );
  });

  it("有包时码查表翻译，详情原样保留", () => {
    setPack(fakePack);
    expect(terr("CANCELLED")).toBe("Cancelled");
    expect(terr("NEED_PASSWORD")).toBe("Password required");
    expect(terr("CANCELLED|用户取消")).toBe("Cancelled：用户取消");
  });

  it("未知码：纯码原样透传，带详情剥码留详情", () => {
    setPack(fakePack);
    expect(terr("SOME_NEW_CODE")).toBe("SOME_NEW_CODE");
    expect(terr("SOME_NEW_CODE|详情")).toBe("详情");
  });

  it("NEED_MASTER_KEY 冒号格式不按码处理，原样透传", () => {
    setPack(fakePack);
    expect(terr("NEED_MASTER_KEY: 需要输入主密钥以解密已保存的密码")).toBe(
      "NEED_MASTER_KEY: 需要输入主密钥以解密已保存的密码",
    );
  });
});

describe("isCancelledError：按码判定取消", () => {
  it("纯码与码|详情均判定为取消", () => {
    expect(isCancelledError("CANCELLED")).toBe(true);
    expect(isCancelledError("CANCELLED|已取消")).toBe(true);
  });

  it("非取消错误不误判（含「取消」字样的中文、其他码）", () => {
    expect(isCancelledError("已取消")).toBe(false);
    expect(isCancelledError("无法取消关联：被占用")).toBe(false);
    expect(isCancelledError("NEED_PASSWORD")).toBe(false);
    expect(isCancelledError("")).toBe(false);
  });
});
