import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { basename } from "../lib/format";
import { applyConflictAction, type ConflictAction } from "../lib/transfer";
import type { ResolutionPlan, TransferConflict } from "../lib/types";

/**
 * 同名冲突裁决弹窗（Windows 风格）：覆盖 / 全部覆盖 / 改名 / 停止。
 * 目录同名已由后端递归合并，这里只处理文件级冲突。
 */
export function ConflictDialog({
  conflicts,
  onDone,
}: {
  conflicts: TransferConflict[];
  onDone: (plan: ResolutionPlan | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [plan, setPlan] = useState<ResolutionPlan>({});
  const [name, setName] = useState(conflicts[0]?.suggest ?? "");

  const cur = conflicts[index];
  if (!cur) return null;

  const act = (action: ConflictAction) => {
    const r = applyConflictAction(conflicts, index, plan, action);
    if (r.stopped) {
      onDone(null);
      return;
    }
    if (r.finished) {
      onDone(r.plan);
      return;
    }
    setPlan(r.plan);
    setIndex(r.nextIndex);
    setName(conflicts[r.nextIndex]?.suggest ?? "");
  };

  const doRename = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    act({ type: "rename", name: trimmed });
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(null);
      }}
    >
      <div className="w-[440px] max-w-[92vw] rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> 目标已存在同名项目
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          第 {index + 1} / {conflicts.length} 项冲突
          {cur.srcKind === "dir" ? "（同名目录内有同名文件）" : ""}
        </p>
        <div className="mt-2 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="truncate" title={cur.src}>
            <span className="text-muted-foreground">源：</span>
            {basename(cur.src)}
          </div>
          <div className="mt-1 truncate" title={cur.dest}>
            <span className="text-muted-foreground">目标：</span>
            {cur.dest}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doRename();
              }
            }}
            className="h-8 text-xs"
            aria-label="改名"
          />
          <Button variant="outline" size="sm" onClick={doRename} disabled={!name.trim()}>
            改名
          </Button>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => act({ type: "overwrite" })}>
            覆盖
          </Button>
          <Button variant="outline" size="sm" onClick={() => act({ type: "overwriteAll" })}>
            全部覆盖
          </Button>
          <Button variant="destructive" size="sm" onClick={() => act({ type: "stop" })}>
            停止
          </Button>
        </div>
      </div>
    </div>
  );
}
