import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { t } from "@/lib/i18n";

/**
 * 自研鼠标拖拽（复制/移动跨窗格投放）+ 橡皮筋框选的共用引擎
 * （FileList 详情列表 / IconGrid 大图标网格，v0.35.0 前为两份逐行级重复实现）。
 *
 * 背景：WKWebView 的 HTML5 DnD 不可靠，应用内拖拽走 window 级 mouse 事件链路；
 * 投放收口在 App 的 window drop / doDropPaths（HTML5/原生链路），本 hook 只管
 * 「按下 → 移动 → 抬起」的拖拽候选与框选数学。
 *
 * 两侧行为差异全部以参数注入（合并时逐条保留的分叉点）：
 * - resolveTarget：命中解析。FileList 返回窗格级目标（**含本窗格**——悬停上报
 *   语义与基线一致，App 按 dragOver.targetPaneId === pane.id 决定提示条显示）；
 *   IconGrid 先解析文件夹图标（dirPath，排除被拖路径自身），窗格级排除本窗格。
 * - hitSelector / hitRootRef：框选命中元素（[data-path] 行 vs [data-grid-item]
 *   图标）与遍历根（FileList=容器，IconGrid=滚动内容）。
 * - onDropIntoDir / onSlotDrop / onHoverChange：仅 IconGrid 注入（文件夹投放、
 *   空槽重摆回落、folderHover 高亮）；FileList 不传即无此行为。
 * - 按压语义（startRowPress 的「未选中=按下即选中+框选起点」 vs startItemPress
 *   的「按下未选中=立即选中并成为拖拽候选」）差异大，留在两侧组件内，
 *   通过 beginDragCandidate / beginRubber / armDragListeners 驱动引擎。
 */
export interface DragTargetHit {
  /** 命中的窗格 id（语义由注入方决定：FileList 侧含本窗格，IconGrid 侧已排除） */
  paneId: number | null;
  /** 命中的文件夹路径（仅 IconGrid 文件夹图标）；无则 null */
  dirPath: string | null;
}

/** 有效缩放比量测（根 zoom × 窗格 zoom）：把视觉像素偏移折回 rectRef 布局空间。
 *  框选矩形 div 的定位基准是 rectRef（窗格根，自身带 zoom），其布局 px 渲染时会被
 *  (根 zoom × 窗格 zoom) 整体放大——不折算时画的框偏离鼠标，且偏得越远越夸张
 *  （v0.49 大图标框选错位的根因：选中的图标跟手、画的框歪）。
 *  rectRef 自身带 zoom，offsetWidth 的「自身 zoom」语义不可靠，改用一次性探针
 *  子元素量：探针无自身 zoom，rect.width/1000 恰为 rectRef 子树被放大的倍数
 *  （与 v0.44 列宽拖拽 rect/offsetWidth 同源做法，FileList.tsx:388-395）。
 *  jsdom 等无布局环境量到 0 → 回退 1（不折算，单测桩全走布局=视觉）。 */
function measureZoomRatio(el: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;width:1000px;height:0;visibility:hidden;pointer-events:none;";
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  el.removeChild(probe);
  const ratio = w / 1000;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
}

export interface DragRubberBandOptions {
  /** 橡皮筋选框坐标系原点（两侧的根容器，带 data-pane-id） */
  rectRef: RefObject<HTMLElement | null>;
  /** 框选命中测试的遍历根 */
  hitRootRef: RefObject<HTMLElement | null>;
  /** 框选命中元素选择器：[data-path]（详情行）vs [data-grid-item]（图标） */
  hitSelector: string;
  paneId: number;
  /** 最新选中（additive 框选合并用；经 ref 每帧取新值） */
  selection: string[];
  /** 空白按压判定（可选注入，IconGrid 用）：注入后替代「target===currentTarget」严格门。
   *  IconGrid 的滚动内容被全尺寸内层 relative div 盖住（v0.49 框选起不来的根因），
   *  图标间缝隙按压的 target 是该 div——注入「target 不在条目内」判定让缝隙/边缘
   *  可起框；FileList 不注入，维持原严格门行为不变。 */
  isBlankPress?: (target: EventTarget | null) => boolean;
  /** 拖拽悬停/投放的落点解析（见 DragTargetHit） */
  resolveTarget: (x: number, y: number, draggedPaths: readonly string[]) => DragTargetHit;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  onDropPaths: (
    srcPaneId: number,
    paths: string[],
    op: "copy" | "move",
    targetPaneId: number,
  ) => void;
  /** 落到文件夹图标的投放（仅 IconGrid） */
  onDropIntoDir?: (paths: string[], op: "copy" | "move", dirPath: string) => void;
  /** 非文件夹、非跨窗格落点的空槽重摆回落（仅 IconGrid；经 ref 换新闭包） */
  onSlotDrop?: (paths: string[], clientX: number, clientY: number) => void;
  /** 文件夹悬停高亮同步（仅 IconGrid 的 setFolderHover） */
  onHoverChange?: (path: string | null) => void;
  onDragOverChange: (target: { targetPaneId: number; op: "copy" | "move" } | null) => void;
}

export interface DragRubberBand {
  /** 橡皮筋选框（渲染在容器内，坐标相对 rectRef 容器） */
  rubber: { left: number; top: number; right: number; bottom: number } | null;
  /** 框选激活后抑制随后的 click（避免单行选择覆盖框选结果） */
  suppressClickRef: RefObject<boolean>;
  /** 拖拽幽灵标签（常驻 DOM，拖动时显示） */
  ghostRef: RefObject<HTMLDivElement | null>;
  /** 空白处按下开框选（两侧逐行一致） */
  startRubber: (e: ReactMouseEvent) => void;
  /** 设立拖拽候选（已选中项按下 / onDragStart 升级虚拟路径拖拽） */
  beginDragCandidate: (x: number, y: number, paths: string[]) => void;
  /** 设立框选起点（详情列表从未选中行按下时 fromItem=true） */
  beginRubber: (x: number, y: number, additive: boolean, fromItem: boolean) => void;
  /** 仅清橡皮筋手势（onDragStart 把框选升级为拖拽候选前调用） */
  resetRubber: () => void;
  /** 挂 window 级 mousemove/mouseup（按压处理器收尾调用） */
  armDragListeners: () => void;
  /** 全量清理（自研松手收尾 / dragstart 接管时交棒） */
  cleanupDrag: () => void;
}

export function useDragRubberBand(options: DragRubberBandOptions): DragRubberBand {
  // window 监听器持有旧帧闭包，直引 props/callback 会拿到过期值——
  // 与两侧原实现相同，全部经 ref 每帧换新
  const optsRef = useRef(options);
  optsRef.current = options;

  const ghostRef = useRef<HTMLDivElement>(null);
  const dragCandRef = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  const dragActiveRef = useRef(false);
  const lastTargetRef = useRef<number | null>(null);
  const lastOpRef = useRef<"copy" | "move">("copy");
  const rubberRef = useRef<{ x0: number; y0: number; additive: boolean; fromItem: boolean } | null>(
    null,
  );
  /** 文件夹落点悬停（仅 IconGrid 消费；FileList 的 resolveTarget 恒返回 dirPath=null） */
  const hoverRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const [rubber, setRubber] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  /** 本手势的有效缩放比（懒量：首次画框时量一次；zoom 在手势中途不变） */
  const zoomRatioRef = useRef<number | null>(null);

  const cleanupDrag = () => {
    window.removeEventListener("mousemove", onWinMouseMove);
    window.removeEventListener("mouseup", onWinMouseUp);
    document.body.style.userSelect = "";
    dragActiveRef.current = false;
    // dragstart 接管（原生/HTML5 拖拽）时手势可能已画出橡皮筋选框或留下按压候选——
    // 不清掉的话选框滞留整个拖拽过程，下一次空白框选还会被过期 dragCandRef 劫持成幽灵拖拽
    dragCandRef.current = null;
    rubberRef.current = null;
    setRubber(null);
    lastTargetRef.current = null;
    lastOpRef.current = "copy";
    zoomRatioRef.current = null;
    if (hoverRef.current !== null) {
      hoverRef.current = null;
      optsRef.current.onHoverChange?.(null);
    }
    if (ghostRef.current) ghostRef.current.style.opacity = "0";
    optsRef.current.onDragOverChange(null);
  };

  const onWinMouseMove = (e: MouseEvent) => {
    const opts = optsRef.current;
    const cand = dragCandRef.current;
    if (cand) {
      if (Math.hypot(e.clientX - cand.x, e.clientY - cand.y) > 5) {
        if (!dragActiveRef.current) {
          dragActiveRef.current = true;
          document.body.style.userSelect = "none";
          if (ghostRef.current) ghostRef.current.style.opacity = "1";
        }
        e.preventDefault();
        const op: "copy" | "move" = e.altKey ? "move" : "copy";
        if (ghostRef.current) {
          ghostRef.current.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
          ghostRef.current.textContent =
            op === "move"
              ? t("移动 {n} 项", { n: cand.paths.length })
              : t("复制 {n} 项", { n: cand.paths.length });
        }
        // 目标检测（仅变化时通知，避免高频重渲染）
        const hit = opts.resolveTarget(e.clientX, e.clientY, cand.paths);
        const folder = hit.dirPath;
        if (folder !== hoverRef.current) {
          hoverRef.current = folder;
          opts.onHoverChange?.(folder);
        }
        if (hit.paneId !== lastTargetRef.current || op !== lastOpRef.current) {
          lastTargetRef.current = hit.paneId;
          lastOpRef.current = op;
          opts.onDragOverChange(
            hit.paneId !== null ? { targetPaneId: hit.paneId, op } : null,
          );
        }
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      const cRect = opts.rectRef.current?.getBoundingClientRect();
      if (cRect) {
        // 画的框以布局像素写进 zoomed 子树，视觉偏移须折回布局空间（每手势量一次）。
        // mouseup 的命中测试保持视觉空间不动——条目 rect 也是视觉像素，天然自洽
        if (zoomRatioRef.current === null) {
          zoomRatioRef.current = opts.rectRef.current
            ? measureZoomRatio(opts.rectRef.current)
            : 1;
        }
        const ratio = zoomRatioRef.current;
        setRubber({
          left: (Math.min(rb.x0, e.clientX) - cRect.left) / ratio,
          top: (Math.min(rb.y0, e.clientY) - cRect.top) / ratio,
          right: (Math.max(rb.x0, e.clientX) - cRect.left) / ratio,
          bottom: (Math.max(rb.y0, e.clientY) - cRect.top) / ratio,
        });
      }
    }
  };

  const onWinMouseUp = (e: MouseEvent) => {
    const opts = optsRef.current;
    const cand = dragCandRef.current;
    if (cand) {
      dragCandRef.current = null;
      if (dragActiveRef.current) {
        const hit = opts.resolveTarget(e.clientX, e.clientY, cand.paths);
        const op = lastOpRef.current;
        const folder = hoverRef.current;
        cleanupDrag();
        if (hit.dirPath !== null) {
          opts.onDropIntoDir?.(cand.paths, op, hit.dirPath);
        } else if (
          hit.paneId !== null &&
          hit.paneId !== opts.paneId &&
          cand.paths.length > 0
        ) {
          opts.onDropPaths(opts.paneId, cand.paths, op, hit.paneId);
        } else if (opts.onSlotDrop && folder === null) {
          opts.onSlotDrop(cand.paths, e.clientX, e.clientY);
        }
      } else {
        cleanupDrag();
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      rubberRef.current = null;
      const cRect = opts.rectRef.current?.getBoundingClientRect();
      setRubber(null);
      cleanupDrag();
      if (!cRect) return;
      const rx0 = Math.min(rb.x0, e.clientX) - cRect.left;
      const rx1 = Math.max(rb.x0, e.clientX) - cRect.left;
      const ry0 = Math.min(rb.y0, e.clientY) - cRect.top;
      const ry1 = Math.max(rb.y0, e.clientY) - cRect.top;
      const moved = Math.hypot(e.clientX - rb.x0, e.clientY - rb.y0) > 3;
      if (!moved) {
        // 单击空白 → 取消选择；单击条目 → 交给 click 正常选择
        if (!rb.fromItem) opts.onClearSelection();
        return;
      }
      // 框选已发生，抑制随后的 click（否则单行选择会覆盖框选结果）
      suppressClickRef.current = true;
      const hit: string[] = [];
      opts.hitRootRef.current?.querySelectorAll<HTMLElement>(opts.hitSelector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const rel = {
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          right: r.right - cRect.left,
          bottom: r.bottom - cRect.top,
        };
        if (rel.right >= rx0 && rel.left <= rx1 && rel.bottom >= ry0 && rel.top <= ry1) {
          const p = el.dataset.path;
          if (p) hit.push(p);
        }
      });
      if (rb.additive) {
        opts.onSelectRange([...new Set([...opts.selection, ...hit])]);
      } else {
        opts.onSelectRange(hit);
      }
      return;
    }
    cleanupDrag();
  };

  const beginDragCandidate = (x: number, y: number, paths: string[]) => {
    dragCandRef.current = { x, y, paths };
  };

  const beginRubber = (x: number, y: number, additive: boolean, fromItem: boolean) => {
    rubberRef.current = { x0: x, y0: y, additive, fromItem };
  };

  const resetRubber = () => {
    rubberRef.current = null;
    setRubber(null);
  };

  const armDragListeners = () => {
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  const startRubber = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // 空白判定：注入 isBlankPress 的视图按注入逻辑判（IconGrid 缝隙按压的
    // target 是全尺寸内层 div）；未注入维持「target===currentTarget」严格门
    const blank = optsRef.current.isBlankPress;
    if (blank ? !blank(e.target) : e.target !== e.currentTarget) return;
    e.preventDefault();
    beginRubber(e.clientX, e.clientY, e.metaKey || e.ctrlKey || e.shiftKey, false);
    armDragListeners();
  };

  return {
    rubber,
    suppressClickRef,
    ghostRef,
    startRubber,
    beginDragCandidate,
    beginRubber,
    resetRubber,
    armDragListeners,
    cleanupDrag,
  };
}
