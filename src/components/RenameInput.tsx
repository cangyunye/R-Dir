import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** 行内重命名输入框（FileList 行 / 搜索结果行 / 图标网格共用） */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
  fitWidth,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  /** 图标网格用：宽度随内容自适应并钳到 [min, max]。格子远窄于长名，单行输入框
      只能露出一角（全选后浏览器滚到串尾，看起来"名字只剩尾巴"）；
      不传则维持 w-full/flex-1 铺满容器的详情行/搜索行行为。 */
  fitWidth?: { min: number; max: number };
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const fitMin = fitWidth?.min;
  const fitMax = fitWidth?.max;
  /** 自适应宽 = canvas 按输入框实际计算字体测的文本宽 + 内边距 12px + 边框 2px + 2px 余量，
      钳到区间。不能拿同字号 span 量：基础 Input 的 md:text-sm 在级联中会覆盖 text-[13px]，
      实际渲染字号与类名字面不符，按类名量会窄出约一个字宽。 */
  const [fitW, setFitW] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (fitMin === undefined || fitMax === undefined) return;
    let textW = 0;
    const el = ref.current;
    // 每次现建 canvas（重命名会话内每击键一次，量级可忽略）：不做模块级缓存，
    // 否则测试替身/环境切换会串味
    const ctx = document.createElement("canvas").getContext("2d");
    if (el && ctx) {
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      textW = ctx.measureText(value).width;
    }
    setFitW(Math.min(Math.max(Math.ceil(textW + 2) + 14, fitMin), fitMax));
  }, [fitMin, fitMax, value]);
  /** 是否真正持过焦：起手焦点竞争（radix 菜单关闭回焦等）期间 input 可能从未拿到焦点 */
  const everFocusedRef = useRef(false);
  /** 最新值（window mousedown 监听只注册一次，经此读取当前值） */
  const valueRef = useRef(value);
  valueRef.current = value;
  /** 会话只结束一次：失焦与全局 mousedown 可能先后到达，也可能只来其一 */
  const doneRef = useRef(false);
  const finishRef = useRef<(commit: boolean) => void>(() => {});
  useEffect(() => {
    finishRef.current = (commit: boolean) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (commit) onCommit(valueRef.current);
      else onCancel();
    };
  });

  useEffect(() => {
    // 右键菜单关闭时 radix 会把焦点恢复到触发行，若晚于本输入框聚焦就会把焦点抢走
    // （onBlur 以未修改的名字提交 → 静默关闭，看起来"重命名失败"）。
    // 按 0/120/300ms 重试聚焦直到拿稳；已持焦时跳过，避免打断用户光标。
      const attempts = [0, 120, 300].map((ms) =>
        window.setTimeout(() => {
          if (document.activeElement === ref.current) return;
          ref.current?.focus();
          ref.current?.select();
          // 全选会把溢出内容的输入框滚到串尾（用户只看到名字尾部）；拨回串首
          if (ref.current) ref.current.scrollLeft = 0;
        }, ms),
      );
    return () => attempts.forEach((t) => window.clearTimeout(t));
  }, []);

  useEffect(() => {
    // 仅靠失焦结束会话有盲区：Tauri 拖拽区（标签栏空白）的 mousedown 被 preventDefault
    // 走原生拖动、滚动条交互不产生 DOM 事件——两者都不触发 blur，编辑框会一直挂着。
    // 资源管理器/Finder 语义是"点哪里都结束重命名"，故在 window 捕获阶段直接收口。
    const onWinMouseDown = (e: MouseEvent) => {
      if (!everFocusedRef.current) return; // 起手焦点竞争窗口，交给重试聚焦
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      finishRef.current(valueRef.current !== initial);
    };
    window.addEventListener("mousedown", onWinMouseDown, true);
    return () => window.removeEventListener("mousedown", onWinMouseDown, true);
  }, [initial]);

  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      style={fitW !== null ? { width: fitW } : undefined}
      onFocus={() => {
        everFocusedRef.current = true;
      }}
      onKeyDown={(e) => {
        // 按键不冒泡到行（行的 Enter = 打开条目）与列表快捷键，重命名期间输入框独占键盘
        e.stopPropagation();
        // macOS 中文输入法：按回车确认候选词时 keydown 带 isComposing=true，
        // 此时提交会带着未上屏的拼音（或空串）提前结束会话——表现为"回车无法重命名"。
        // 组合中的 Enter/Esc 属输入法操作，交给 IME；上屏后再按 Enter 才提交。
        // keyCode 229 = IME 处理中（WKWebView 等引擎确认候选的 Enter 可能 isComposing=false
        // 但仍带 229），一并交给 IME，避免组合确认回车被误当提交。
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") finishRef.current(true);
        if (e.key === "Escape") finishRef.current(false);
      }}
      onBlur={() => {
        // 从未持过焦的 blur 是起手焦点竞争（重试聚焦会再拿），不提交也不结束会话；
        // 正常失焦：改过名 → 提交；没改过 → 取消（对齐访达"点空白关闭"）
        if (!everFocusedRef.current) return;
        finishRef.current(valueRef.current !== initial);
      }}
      className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
      spellCheck={false}
    />
  );
}
