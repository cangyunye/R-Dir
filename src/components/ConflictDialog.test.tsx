import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConflictDialog } from "./ConflictDialog";
import type { FileFingerprint } from "../lib/api";
import type { TransferConflict } from "../lib/types";

const fp = (path: string, md5: string | null, size: number | null): FileFingerprint => ({
  path,
  md5,
  size,
});

// 指纹查询桩：vi.fn 便于逐用例断言调用参数 / 改写返回值
vi.mock("../lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/api")>();
  return {
    ...orig,
    fileFingerprints: vi.fn(),
  };
});

import { fileFingerprints } from "../lib/api";
const spy = vi.mocked(fileFingerprints);

const mk = (dest: string): TransferConflict => ({
  src: `/src/${dest}`,
  dest: `/dst/${dest}`,
  srcKind: "file",
  destKind: "file",
  suggest: `${dest}_1`,
});

beforeEach(() => {
  spy.mockReset();
  spy.mockImplementation(async (paths) => paths.map((p) => fp(p, `md5-of-${p}`, 1234)));
});

describe("ConflictDialog", () => {
  it("单条冲突点「覆盖」回调覆盖方案", () => {
    const onDone = vi.fn();
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={onDone} />);
    fireEvent.click(screen.getByText("覆盖"));
    expect(onDone).toHaveBeenCalledWith({ "/dst/a.txt": { action: "overwrite" } });
  });

  it("「全部覆盖」一次覆盖所有剩余冲突", () => {
    const onDone = vi.fn();
    render(<ConflictDialog conflicts={[mk("a.txt"), mk("b.txt")]} onDone={onDone} />);
    fireEvent.click(screen.getByText("全部覆盖"));
    expect(onDone).toHaveBeenCalledWith({
      "/dst/a.txt": { action: "overwrite" },
      "/dst/b.txt": { action: "overwrite" },
    });
  });

  it("改名使用输入框内容，默认预填 _1 建议名", () => {
    const onDone = vi.fn();
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={onDone} />);
    const input = screen.getByLabelText("改名") as HTMLInputElement;
    expect(input.value).toBe("a.txt_1");
    fireEvent.change(input, { target: { value: "a_2.txt" } });
    fireEvent.click(screen.getByText("改名"));
    expect(onDone).toHaveBeenCalledWith({
      "/dst/a.txt": { action: "rename", name: "a_2.txt" },
    });
  });

  it("「停止」回调 null", () => {
    const onDone = vi.fn();
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={onDone} />);
    fireEvent.click(screen.getByText("停止"));
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it("文件级冲突查询源/目标指纹并展示大小与 MD5（v0.37）", async () => {
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(["/src/a.txt", "/dst/a.txt"]);
    });
    await waitFor(() => {
      // formatSize(1234) = "1.2K"，MD5 桩值带路径前缀
      expect(screen.getByText(/MD5 md5-of-\/src\/a\.txt/)).toBeInTheDocument();
      expect(screen.getByText(/MD5 md5-of-\/dst\/a\.txt/)).toBeInTheDocument();
    });
    // 指纹行是单文本节点（`大小 · MD5 …`），两侧各一条
    expect(screen.getAllByText(/1\.2K/).length).toBe(2);
  });

  it("MD5 相同展示一致提示", async () => {
    spy.mockImplementation(async (paths) => paths.map((p) => fp(p, "same-md5", 7)));
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/MD5 一致/)).toBeInTheDocument();
    });
  });

  it("目录冲突不查询指纹", () => {
    const dirConflict: TransferConflict = { ...mk("a"), srcKind: "dir", destKind: "dir" };
    render(<ConflictDialog conflicts={[dirConflict]} onDone={vi.fn()} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(/第 1 \/ 1 项冲突/)).toBeInTheDocument();
  });

  it("逐条裁决时按当前条目查询，切下一条重新查询（不批量预查，v0.37）", async () => {
    render(<ConflictDialog conflicts={[mk("a.txt"), mk("b.txt")]} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(["/src/a.txt", "/dst/a.txt"]);
    });
    fireEvent.click(screen.getByText("覆盖"));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(["/src/b.txt", "/dst/b.txt"]);
    });
    // 首条 MD5 不再展示（状态随重挂载归零）
    expect(screen.queryByText(/md5-of-\/src\/a\.txt/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/md5-of-\/src\/b\.txt/)).toBeInTheDocument();
    });
  });

  it("指纹查询失败不阻塞裁决", async () => {
    spy.mockImplementation(async () => {
      throw new Error("boom");
    });
    const onDone = vi.fn();
    render(<ConflictDialog conflicts={[mk("a.txt")]} onDone={onDone} />);
    await waitFor(() => {
      expect(screen.getByText("覆盖")).toBeInTheDocument();
    });
    // 裁决不受指纹查询失败影响
    fireEvent.click(screen.getByText("覆盖"));
    expect(onDone).toHaveBeenCalledWith({ "/dst/a.txt": { action: "overwrite" } });
  });
});
