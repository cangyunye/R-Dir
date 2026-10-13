import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 应用内确认对话框（v0.28.0）：替代 Tauri 原生 confirm 弹窗。
 * 此前「永久删除」「回收站失败转永久删除」走 plugin-dialog 的系统消息框——
 * Windows 上表现为经典样式弹窗，与应用内自绘的删除确认框割裂。
 * 统一为应用内卡片：Esc/点遮罩 = 取消，Enter = 确认。
 */
export interface AppConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function AppConfirmDialog({
  req,
  onConfirm,
  onCancel,
}: {
  req: AppConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      data-app-confirm=""
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[360px] max-w-[92vw] rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <TriangleAlert
            className={`h-4 w-4 ${req.danger ? "text-destructive" : "text-amber-500"}`}
          />
          {req.title}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {req.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {req.cancelLabel ?? "取消"}
          </Button>
          <Button
            variant={req.danger ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
            autoFocus
          >
            {req.confirmLabel ?? "确定"}
          </Button>
        </div>
      </div>
    </div>
  );
}
