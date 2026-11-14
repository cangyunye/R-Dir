import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** 点击坐标 → 输入框字符偏移：canvas 按输入框实际计算字体量前缀宽 + 二分定位
 *  （与 fitWidth 同一款字体串量法）。canvas 不可用（jsdom 裸环境）返回 0。
 *  zoom≠1 折算：clientX 与 rect 是视觉像素、measureText/scrollLeft 是布局像素，
 *  按 rect.width/offsetWidth 比值把视觉位移折回布局空间（v0.44 列宽 zoom 换算同款
 *  做法；不折算时塌缩锚点按 zoom 比例偏移，拖选起点错位）。 */
function caretOffsetAt(el: HTMLInputElement, clientX: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const padL = Number.parseFloat(cs.paddingLeft) || 0;
  const rect = el.getBoundingClientRect();
  const ratio = rect.width / el.offsetWidth || 1;
  const x = (clientX - rect.left) / ratio - padL + el.scrollLeft;
  let lo = 0;
  let hi = el.value.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(el.value.slice(0, mid)).width <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

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
  /** 接管中的框内拖选（按在选区内的按下）：anchor = 塌缩后的选区起点 */
  const dragSelRef = useRef<{ anchor: number } | null>(null);
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
  /** 起手安定窗口截止时刻：窗口内的失焦视作程序性抢焦（radix 关菜单回焦迟到等），
      不收口、交给重试聚焦；窗口外的失焦才是正常结束信号 */
  const settleUntilRef = useRef(Date.now() + 1100);
  /** 最新值（window mousedown 监听只注册一次，经此读取当前值） */
  const valueRef = useRef(value);
  valueRef.current = value;
  /** 会话只结束一次：失焦与全局 mousedown 可能先后到达，也可能只来其一 */
  const doneRef = useRef(false);
  /** 用户是否已在框内按过鼠标：接管拖选中重试聚焦链不得再 select()（见重试注释） */
  const everPressedRef = useRef(false);
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
    // 按多档延迟重试聚焦直到拿稳；已持焦时跳过，避免打断用户光标。
    // 末档覆盖 radix 回焦迟到的场景（动画帧后才恢复触发元素焦点）。
      const attempts = [0, 120, 300, 600, 1000].map((ms) =>
        window.setTimeout(() => {
          if (document.activeElement === ref.current) return;
          ref.current?.focus();
          // 用户已在框内按过（接管拖选中）：只补焦点不再 select()——接管的 mousedown
          // preventDefault 会取消原生聚焦，重试补焦点后若再全选，会把正在进行的
          // 拖选锚点与选区整个重置（F2 起手快速按压拖选必中招，实测失效根因）
          if (!everPressedRef.current) ref.current?.select();
          // 全选会把溢出内容的输入框滚到串尾（用户只看到名字尾部）；拨回串首
          if (ref.current && !everPressedRef.current) ref.current.scrollLeft = 0;
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
        // 挂载后约 1 秒的安定窗口内同理：radix 关菜单回焦等程序性抢焦可能落在
        // 首次持焦之后、重试聚焦之前，此时收口会把会话误杀（表现为"输入框瞬闪即关"）。
        // 真实点击收口走 window mousedown（先于 blur），不依赖本回调。
        // 安定窗口外的正常失焦：改过名 → 提交；没改过 → 取消（对齐访达"点空白关闭"）
        if (!everFocusedRef.current) return;
        if (Date.now() < settleUntilRef.current) return;
        finishRef.current(valueRef.current !== initial);
      }}
      // select-text：列表/网格滚动容器挂了 select-none（防误选行文本），WKWebView 会把它
      // 继承进 input——鼠标拖选/双击选词全部失效（初始 JS select() 不受影响，表现为
      // "已全选但拖不动"）。必须显式放行（同 TextView v0.41 的处理）。
      className="h-6 min-w-0 flex-1 select-text px-1.5 text-[13px]"
      onMouseDown={(e) => {
        // 「按在选区内的按下」手势规避（v0.48 实测 WebView2/Edge 157 与 WKWebView
        // 同样存在：起手 select() 的全选让框内按下永远落在选区内，引擎对这种按下
        // 走「拖动既有选区」默认手势——只塌缩光标、拖不出新选区；光标态/选区外按下
        // 原生即新选区拖动，v2 探针证实）。裸 setSelectionRange 塌缩又会打断引擎的
        // 原生拖选手势——所以这条路径整个接管：preventDefault 拦掉默认手势与原生
        // 聚焦，mousedown 塌缩到按点 + window mousemove 手动扩展选区（Finder 语义）。
        // 其余按压全部留给原生：光标态按下、按在选区外、双击/三击（e.detail>1 的
        // 选词/全选）、非左键。
        // 接管取消原生聚焦的代价：重试聚焦链补焦点时不得再 select()（everPressedRef
        // 守卫，见重试注释），否则拖选被重置——F2 起手快速按压拖选失效的实测根因。
        if (e.button !== 0 || e.detail > 1) return;
        everPressedRef.current = true;
        const el = ref.current;
        if (!el) return;
        const selStart = el.selectionStart ?? 0;
        const selEnd = el.selectionEnd ?? 0;
        if (selStart === selEnd) return; // 光标态：原生行为即正确
        const offset = caretOffsetAt(el, e.clientX);
        if (offset < selStart || offset > selEnd) return; // 选区外：原生即新选区
        e.preventDefault();
        el.setSelectionRange(offset, offset);
        dragSelRef.current = { anchor: offset };
        const onMove = (ev: MouseEvent) => {
          const cur = ref.current;
          if (!cur || !dragSelRef.current) return;
          const pos = caretOffsetAt(cur, ev.clientX);
          cur.setSelectionRange(
            Math.min(dragSelRef.current.anchor, pos),
            Math.max(dragSelRef.current.anchor, pos),
          );
        };
        const onUp = () => {
          dragSelRef.current = null;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
      spellCheck={false}
    />
  );
}
