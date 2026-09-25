import { describe, expect, it, vi, afterEach } from "vitest";
import { compareVersions, fetchLatestRelease } from "./update";

describe("compareVersions", () => {
  it("比较数值段而非字符串", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  it("忽略 v 前缀与预发布后缀", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
  });

  it("补齐缺失段", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });
});

describe("fetchLatestRelease", () => {
  afterEach(() => vi.unstubAllGlobals());

  const mockFetch = (body: unknown, ok = true, status = 200) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, status, json: async () => body })),
    );
  };

  it("有新版本时返回版本与下载地址", async () => {
    mockFetch({ tag_name: "v9.9.9", html_url: "https://example.com/dl" });
    expect(await fetchLatestRelease("0.11.0")).toEqual({
      version: "9.9.9",
      url: "https://example.com/dl",
    });
  });

  it("已是最新返回 null", async () => {
    mockFetch({ tag_name: "v0.11.0" });
    expect(await fetchLatestRelease("0.11.0")).toBeNull();
  });

  it("HTTP 非 2xx 抛错", async () => {
    mockFetch({}, false, 403);
    await expect(fetchLatestRelease("0.11.0")).rejects.toThrow("403");
  });
});
