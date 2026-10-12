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
  /** 是否真正持过焦：起手焦点竞争（radix 菜单关闭回焦等）期间 input 可能从未拿到焦点 */
  const everFocusedRef = useRef(false);
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
      onFocus={() => {
        everFocusedRef.current = true;
      }}
      onKeyDown={(e) => {
        // 按键不冒泡到行（行的 Enter = 打开条目）与列表快捷键，重命名期间输入框独占键盘
        e.stopPropagation();
        // macOS 中文输入法：按回车确认候选词时 keydown 带 isComposing=true，
        // 此时提交会带着未上屏的拼音（或空串）提前结束会话——表现为"回车无法重命名"。
        // 组合中的 Enter/Esc 属输入法操作，交给 IME；上屏后再按 Enter 才提交。
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => {
        // 从未持过焦的 blur 是起手焦点竞争（重试聚焦会再拿），不提交也不结束会话；
        // 正常失焦：改过名 → 提交；没改过 → 取消（对齐访达"点空白关闭"）
        if (!everFocusedRef.current) return;
        if (value !== initial) onCommit(value);
        else onCancel();
      }}
      className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
      spellCheck={false}
    />
  );
}
