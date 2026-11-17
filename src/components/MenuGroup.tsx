import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useT } from "@/lib/LanguageProvider";
import { getAnimLevel } from "@/lib/anim";

/**
 * 右键菜单二级「折叠组」：点组名在同级菜单内联展开子项。
 * 不用 Radix MenuSub —— 其在 Tauri WKWebView 下子项点击丢失
 * （radix-ui/primitives#4095，官方 onFocusOutside workaround 实测无效）。
 * onSelect preventDefault 让菜单保持打开，再切换展开状态。
 */
export function MenuGroup({
  id,
  label,
  icon,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = useT();
  // 展开后把新增子项滚进可视区：菜单内容受可用高度约束（展开不再顶破窗口）时，
  // 组往往在滚动边界之下，不滚就看不见刚展开的内容。
  // 雅模式延到 FLIP 动画结束后，且用平滑滚动——动画刚播完内容「啪」地跳一下
  // 是丝滑度的最大杀手
  useEffect(() => {
    if (!expanded) return;
    if (getAnimLevel() === "elegant") {
      const id = window.setTimeout(
        () => bodyRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
        220,
      );
      return () => window.clearTimeout(id);
    }
    bodyRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  /** 雅·展开的合成器 FLIP：body 直接按最终布局挂载（grid 1fr，一帧到位），下方
   *  兄弟菜单项先瞬时上移 -H（不透明背景盖住新内容 = 第 0 帧即旧外观），然后整排
   *  transform 过渡滑回 0——滑动过程中逐渐露出 body 新内容。全程只动 transform
   *  （合成器），零重排——grid-template-rows 布局动画在弱机每帧重排整个菜单，
   *  4× CPU 节流实测 90-108ms 冻结（顿感根因）。素模式不 FLIP（瞬间展开）。 */
  useLayoutEffect(() => {
    if (!expanded || getAnimLevel() !== "elegant") return;
    const body = bodyRef.current;
    if (!body) return;
    const h = body.offsetHeight;
    if (h <= 0) return;
    const sibs: HTMLElement[] = [];
    let s = body.nextElementSibling as HTMLElement | null;
    while (s) {
      sibs.push(s);
      s = s.nextElementSibling as HTMLElement | null;
    }
    if (sibs.length === 0) return;
    // 第 0 帧（并入挂载任务的样式阶段）：下方兄弟上移 -H 且不透明背景盖住
    // body 新内容（= 旧外观）。不做强制同步 flush——挂载任务越短顿感越短
    sibs.forEach((el) => {
      el.style.backgroundColor = "var(--popover)";
      el.style.transform = `translateY(${-h}px)`;
    });
    // 下一帧再启动过渡：滑动帧与挂载任务分帧，互不叠加
    const raf = requestAnimationFrame(() => {
      sibs.forEach((el) => {
        el.style.transition = "transform var(--rdir-anim-dur) var(--rdir-anim-ease)";
        el.style.transform = "translateY(0)";
      });
    });
    // 动画结束清内联样式（hover 背景/定位回归常态）
    const id = window.setTimeout(() => {
      sibs.forEach((el) => {
        el.style.transition = "";
        el.style.transform = "";
        el.style.backgroundColor = "";
      });
    }, 340);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(id);
    };
  }, [expanded]);
  return (
    <>
      <ContextMenuItem
        data-testid={`menu-group-${id}`}
        onSelect={(e) => {
          e.preventDefault();
          onToggle(id);
        }}
      >
        {icon}
        <span className="flex-1">{t(label)}</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          style={{ transitionDuration: "var(--rdir-anim-dur)" }}
        />
      </ContextMenuItem>
      {/* 折叠组身体：外层 grid 1fr（雅=从 0fr 展开动画,见 index.css rdir-group-in；
          素=0ms 瞬时与旧「expanded && 挂载」零 diff）+ 内层 overflow-hidden 裁切。
          折叠仍维持卸载：Radix 箭头导航不能落进不可见子项。 */}
      {expanded && (
        <div ref={bodyRef} className="ml-3 border-l pl-1" style={{ display: "grid", gridTemplateRows: "1fr" }}>
          <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
      )}
    </>
  );
}
