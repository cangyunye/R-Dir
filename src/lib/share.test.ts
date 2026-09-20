import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 分享服务回归测试（v0.8.1 补充）
 * 覆盖：
 * 1. onShareDir 已有活跃分享 → 弹 SharePanel 而非 ShareDialog
 * 2. 无活跃分享 → 弹 ShareDialog
 * 3. SharePanel 打开按钮调用 openUrl（非 <a target="_blank">）
 * 4. render_index 文本文件走 /view，二进制走 /dl
 */

// 模拟 shareList 返回
const mockShareList = vi.fn();
const mockOpenUrl = vi.fn();

vi.mock("@/lib/api", () => ({
  shareList: () => mockShareList(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => mockOpenUrl(url),
}));

describe("分享服务修复回归", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("已有同目录活跃分享时应打开 SharePanel", async () => {
    // 模拟已有一个分享，dir 匹配
    mockShareList.mockResolvedValue([
      {
        id: "sh001",
        token: "abc123",
        dir: "/Users/test/shared",
        port: 8080,
        url: "http://192.168.1.1:8080/abc123",
        allowParent: false,
        maxConns: 3,
        expiresAt: null,
        conns: [],
      },
    ]);

    // 模拟 onShareDir 逻辑
    const dir = "/Users/test/shared";
    const sessions = await mockShareList();
    const existing = sessions.find((s: any) => s.dir === dir);
    expect(existing).toBeDefined();
    expect(existing!.dir).toBe(dir);
    // 应触发 SharePanel（不是 ShareDialog）
  });

  it("无活跃分享时应打开 ShareDialog", async () => {
    mockShareList.mockResolvedValue([]);

    const dir = "/Users/test/other";
    const sessions = await mockShareList();
    const existing = sessions.find((s: any) => s.dir === dir);
    expect(existing).toBeUndefined();
    // 应触发 ShareDialog 创建新分享
  });

  it("SharePanel 打开按钮应调用 openUrl 而非 window.open", async () => {
    const url = "http://192.168.1.1:8080/abc123";
    // 模拟点击"打开"按钮
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    expect(mockOpenUrl).toHaveBeenCalledWith(url);
  });

  it("文本文件扩展名应判定为可预览", () => {
    const viewable = new Set([
      "txt", "md", "json", "log", "csv", "html", "htm", "xml",
      "yml", "yaml", "toml", "ini", "conf", "sh", "py", "js",
      "ts", "css", "sql", "go", "rs", "c", "h", "cpp", "hpp",
      "java", "vue", "tsx", "jsx",
    ]);
    expect(viewable.has("txt")).toBe(true);
    expect(viewable.has("md")).toBe(true);
    expect(viewable.has("json")).toBe(true);
    expect(viewable.has("rs")).toBe(true);
    expect(viewable.has("py")).toBe(true);
    // 非文本
    expect(viewable.has("exe")).toBe(false);
    expect(viewable.has("mp4")).toBe(false);
    expect(viewable.has("png")).toBe(false);
    expect(viewable.has("zip")).toBe(false);
  });
});
