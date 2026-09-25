import type { ReactNode } from "react";
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
      {expanded && <div className="ml-3 border-l pl-1">{children}</div>}
    </>
  );
}
