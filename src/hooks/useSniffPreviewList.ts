/**
 * v0.42 浏览模式懒收录：在「扩展名可判定的可预览类型」基础上，对未知类型条目
 * （text-probe 门控）后台逐个内容探测——命中图片格式的追加进清单，恢复工具/中断
 * 传输产出的无扩展名图片目录由此获得画廊体验。文本/二进制/超大不收录，其余收录面不变。
 *
 * IO 约束：enabled=false 不发任何 IPC；开启时串行探测（16B/次，外置盘友好），
 * 探测结果会话缓存（lib/probe，key=path|mtime|size），同文件夹重复进出零重复读。
 */
import { useEffect, useMemo, useState } from "react";
import { sortEntries } from "@/lib/entry-sort";
import { isPreviewable, isRemotePath, previewKindOf } from "@/lib/preview";
import { probeFile } from "@/lib/probe";
import type { FileEntry, SortDir, SortKey } from "@/lib/types";

export function useSniffPreviewList(
  entries: FileEntry[],
  sortKey: SortKey,
  sortDir: SortDir,
  showHidden: boolean,
  /** 嗅探开关（App 侧 = 预览栏开启或浏览模式打开）：false 时仅返回扩展名可判定清单 */
  enabled: boolean,
): FileEntry[] {
  const base = useMemo(
    () => sortEntries(entries, sortKey, sortDir, showHidden).filter(isPreviewable),
    [entries, sortKey, sortDir, showHidden],
  );
  /** 未知类型候选（与列表同序）：text-probe 门控的本地文件 */
  const candidates = useMemo(
    () =>
      sortEntries(entries, sortKey, sortDir, showHidden).filter(
        (e) => !e.is_dir && !isRemotePath(e.path) && previewKindOf(e) === "text-probe",
      ),
    [entries, sortKey, sortDir, showHidden],
  );
  /** 嗅探命中图片的候选 path（探测完成即追加，清单渐进生长） */
  const [sniffed, setSniffed] = useState<string[]>([]);

  useEffect(() => {
    setSniffed([]);
    if (!enabled || candidates.length === 0) return;
    let cancelled = false;
    let pending: string[] = [];
    // 每 8 个命中落地一次：批量 setState，避免逐张重渲染抖动
    const flush = () => {
      if (pending.length === 0 || cancelled) return;
      const batch = pending;
      pending = [];
      setSniffed((prev) => [...prev, ...batch]);
    };
    void (async () => {
      for (const e of candidates) {
        if (cancelled) return;
        try {
          const r = await probeFile(e);
          if (r.kind === "image") pending.push(e.path);
        } catch {
          // 单文件探测失败（权限/竞态删除）不阻塞其余条目
        }
        if (pending.length >= 8) flush();
      }
      flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [candidates, enabled]);

  return useMemo(() => {
    if (sniffed.length === 0) return base;
    const hit = new Set(sniffed);
    return sortEntries(
      [...base, ...candidates.filter((e) => hit.has(e.path))],
      sortKey,
      sortDir,
      showHidden,
    );
  }, [base, candidates, sniffed, sortKey, sortDir, showHidden]);
}
