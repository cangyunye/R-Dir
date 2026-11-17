import { useEffect, useRef, type ReactNode } from "react";
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
  // 雅模式延到展开动画之后（0fr 起步时量不到高度，立即滚会滚错位），且用平滑
  // 滚动——动画刚播完内容「啪」地跳一下是丝滑度的最大杀手
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
        <div ref={bodyRef} className="menu-group-body ml-3 border-l pl-1" style={{ display: "grid", gridTemplateRows: "1fr" }}>
          <div className="menu-group-inner min-h-0 overflow-hidden">{children}</div>
        </div>
      )}
    </>
  );
}
