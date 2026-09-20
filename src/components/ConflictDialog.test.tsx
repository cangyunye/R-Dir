import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConflictDialog } from "./ConflictDialog";
import type { TransferConflict } from "../lib/types";

const mk = (dest: string): TransferConflict => ({
  src: `/src/${dest}`,
  dest: `/dst/${dest}`,
  srcKind: "file",
  destKind: "file",
  suggest: `${dest}_1`,
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
});
