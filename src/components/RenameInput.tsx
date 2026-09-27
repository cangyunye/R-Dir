import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** 行内重命名输入框（FileList 行 / 搜索结果行共用） */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 右键菜单关闭时 radix 会把焦点恢复到触发行，若晚于本输入框聚焦就会把焦点抢走
    // （onBlur 以未修改的名字提交 → 静默关闭，看起来"重命名失败"）。
    // 按 0/120/300ms 重试聚焦直到拿稳；已持焦时跳过，避免打断用户光标。
    const attempts = [0, 120, 300].map((ms) =>
      window.setTimeout(() => {
        if (document.activeElement === ref.current) return;
        ref.current?.focus();
        ref.current?.select();
      }, ms),
    );
    return () => attempts.forEach((t) => window.clearTimeout(t));
  }, []);
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(value)}
      className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
      spellCheck={false}
    />
  );
}
