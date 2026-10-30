import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { basename, formatSize } from "../lib/format";
import { applyConflictAction, type ConflictAction } from "../lib/transfer";
import { fileFingerprints, type FileFingerprint } from "../lib/api";
import type { ResolutionPlan, TransferConflict } from "../lib/types";
import { useModalLayer } from "../hooks/useModalLayer";

/**
 * 同名冲突裁决弹窗（Windows 风格）：覆盖 / 全部覆盖 / 改名 / 停止。
 * 目录同名已由后端递归合并，这里只处理文件级冲突。
 *
 * v0.37 大小 + MD5 指纹：文件级冲突展示源/目标的大小与 MD5 对比，帮助判断覆盖
 * 是否丢内容。只查询**当前展示的这一条**（用户逐条确认 → 每条按需查询一次），
 * 不预先批量查询整批——「全部覆盖」直接关窗，剩余文件不再查询。
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

  // v0.34.1 弹层栈登记（条件渲染，挂载即打开）：本框打开期间 App 暂停全局分发
  useModalLayer("conflict", 65, true);

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
  };

  return (
    <ConflictDialogBody
      // 换条目即重挂载：指纹状态归零重新查询，改名框回填下一条建议名
      key={cur.dest}
      cur={cur}
      index={index}
      total={conflicts.length}
      act={act}
      onDone={onDone}
    />
  );
}

/** v0.37 指纹行文案：`12.5K · MD5 …`；字段缺失（目录/不可读）时整行隐藏 */
function FingerprintLine({ fp }: { fp: FileFingerprint | undefined }) {
  if (!fp) return null;
  const parts: string[] = [];
  if (fp.size != null) parts.push(formatSize(fp.size));
  if (fp.md5) parts.push(`MD5 ${fp.md5}`);
  if (parts.length === 0) return null;
  return (
    <div
      className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
      title={fp.md5 ?? undefined}
    >
      {parts.join("  ·  ")}
    </div>
  );
}

/** 弹窗主体（每条冲突一个实例，key = cur.dest） */
function ConflictDialogBody({
  cur,
  index,
  total,
  act,
  onDone,
}: {
  cur: TransferConflict;
  index: number;
  total: number;
  act: (action: ConflictAction) => void;
  onDone: (plan: ResolutionPlan | null) => void;
}) {
  const [name, setName] = useState(cur.suggest ?? "");
  const [fps, setFps] = useState<[FileFingerprint, FileFingerprint] | null>(null);
  const [fpLoading, setFpLoading] = useState(false);

  const pairable = cur.srcKind === "file" && cur.destKind === "file";

  // 只查当前展示条目（本地路径；SFTP 冲突不经此弹窗）。单文件流式哈希在后端
  // spawn_blocking 执行，弹窗期间展示「计算中」，不卡 UI。
  useEffect(() => {
    if (!pairable) return;
    let stale = false;
    setFps(null);
    setFpLoading(true);
    fileFingerprints([cur.src, cur.dest])
      .then(([s, d]) => {
        if (stale) return;
        setFps([s, d]);
        setFpLoading(false);
      })
      .catch(() => {
        if (!stale) setFpLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [pairable, cur.src, cur.dest]);

  const doRename = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    act({ type: "rename", name: trimmed });
  };

  const sameContent =
    fps?.[0].md5 != null && fps?.[1].md5 != null && fps[0].md5 === fps[1].md5;

  return (
    <div
      data-conflict-dialog=""
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
          第 {index + 1} / {total} 项冲突
          {cur.srcKind === "dir" ? "（同名目录内有同名文件）" : ""}
        </p>
        <div className="mt-2 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="truncate" title={cur.src}>
            <span className="text-muted-foreground">源：</span>
            {basename(cur.src)}
          </div>
          <FingerprintLine fp={fps?.[0]} />
          <div className="mt-1 truncate" title={cur.dest}>
            <span className="text-muted-foreground">目标：</span>
            {cur.dest}
          </div>
          <FingerprintLine fp={fps?.[1]} />
          {fpLoading && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              正在计算大小与 MD5…
            </div>
          )}
          {sameContent && (
            <div className="mt-1 text-[11px] font-medium text-emerald-600">
              MD5 一致：两个文件内容相同
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合中的回车是确认候选词，不作为改名提交
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
