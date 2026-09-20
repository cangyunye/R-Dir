import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { MenuGroup } from "./MenuGroup";

/**
 * 折叠组回归：点组名应在菜单内联展开且菜单不关闭（onSelect preventDefault），
 * 再次点收起；展开后的子项点击应触发回调。
 * 若去掉 preventDefault，点组名会关闭整个菜单 → 用例红。
 */
function Harness({ onPick }: { onPick: () => void }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger>row</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuGroup
          id="tags"
          label="标签"
          icon={null}
          expanded={expanded === "tags"}
          onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
        >
          <ContextMenuItem onSelect={onPick}>红色</ContextMenuItem>
        </MenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("MenuGroup 折叠组", () => {
  it("点组名内联展开/收起且菜单不关闭，子项可点", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);

    // 默认收起
    expect(screen.queryByText("红色")).toBeNull();

    // 展开：菜单未关闭，子项出现
    fireEvent.click(screen.getByTestId("menu-group-tags"));
    expect(screen.getByText("红色")).toBeInTheDocument();

    // 收起
    fireEvent.click(screen.getByTestId("menu-group-tags"));
    expect(screen.queryByText("红色")).toBeNull();

    // 再展开并点击子项
    fireEvent.click(screen.getByTestId("menu-group-tags"));
    fireEvent.click(screen.getByText("红色"));
    expect(onPick).toHaveBeenCalled();
  });
});
