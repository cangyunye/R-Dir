import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";

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
  /** 可选第三选项（渲染在取消与确认之间，如目录同名复制时的「覆盖」） */
  altLabel?: string;
}

export function AppConfirmDialog({
  req,
  onConfirm,
  onCancel,
  onAlt,
}: {
  req: AppConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
  onAlt?: () => void;
}) {
  // v0.34.1 弹层栈登记：更高层弹层打开时本框不抢 Esc/Enter（与 DeleteConfirmDialog 同因）
  useModalLayer("appConfirm", 70, true);

  // 键位监听只订阅一次（回调走 ref）：onConfirm/onCancel 每次 App 渲染都是新引用，
  // 若作 effect 依赖会反复退订/重订，与真实按键派发撞车时按键被跳过。
  const actionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  actionRef.current = (e: KeyboardEvent) => {
    if (!isTopModalLayer("appConfirm")) return;
    // capture 阶段拦截并阻断传播：否则同一按键继续冒泡到全局 keymap
    // （Enter=打开选中项）——回车确认删除会顺带打开（刚删除的）选中文件，
    // 或全局「打开」抢先吞掉回车导致确认根本没执行。
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onConfirm();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => actionRef.current(e);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {req.altLabel && onAlt && (
            <Button variant="outline" size="sm" onClick={onAlt}>
              {req.altLabel}
            </Button>
          )}
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
