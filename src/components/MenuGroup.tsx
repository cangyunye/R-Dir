import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextMenuItem } from "@/components/ui/context-menu";

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
  // 展开后把新增子项滚进可视区：菜单内容受可用高度约束（展开不再顶破窗口）时，
  // 组往往在滚动边界之下，不滚就看不见刚展开的内容
  useEffect(() => {
    if (expanded) bodyRef.current?.scrollIntoView({ block: "nearest" });
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
        <span className="flex-1">{label}</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </ContextMenuItem>
      {expanded && (
        <div ref={bodyRef} className="ml-3 border-l pl-1">
          {children}
        </div>
      )}
    </>
  );
}
