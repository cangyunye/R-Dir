import { useEffect } from "react";
import { popModalLayer, pushModalLayer } from "../lib/modal-stack";

/**
 * 弹层按键仲裁登记：active 期间把 (id, z) 压入全局弹层栈，
 * 弹层的 window 级 Esc/Enter 处理器据此用 isTopModalLayer(id) 判断是否响应。
 */
export function useModalLayer(id: string, z: number, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    pushModalLayer(id, z);
    return () => popModalLayer(id);
  }, [id, z, active]);
}
