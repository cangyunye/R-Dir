/**
 * v0.52 导航诊断浮层（dev 构建常驻左下角）：当前路径 / 加载状态 / 原始输入事件流
 * （按下·单击·双击，含目标行路径与连击序号 e.detail）/ 导航与加载触发流程。
 * 输入监听挂在 window 捕获阶段（先于应用处理器，专抓「事件到了但没触发导航」）。
 * 只读不拦截（pointer-events-none）；正式包默认隐藏（localStorage rfm.debug-nav=1 打开）。
 * 文案过 t()（i18n）；事件类别 token 仅在显示层映射翻译——数据层保持原样
 * （navDebugPush 的 kind 与 window.__navLog 镜像供自动化读取，不做国际化改写）。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useT } from "@/lib/LanguageProvider";
import { navDebugPush, navDebugSnapshot, navDebugSubscribe } from "@/lib/nav-debug";
import { cn } from "@/lib/utils";

/** 展示用压缩：≥4 段的长路径只留末三段（单行截断时保住最有信息量的尾部） */
function shorten(s: string): string {
  return s.replace(/(?:\/[^\s/]+){4,}/g, (m) => "…" + m.split("/").slice(-3).join("/"));
}

export function NavDebugOverlay({
  panePath,
  loading,
  selection,
}: {
  panePath: string;
  loading: boolean;
  selection: string[];
}) {
  const t = useT();
  const snap = useSyncExternalStore(navDebugSubscribe, navDebugSnapshot);

  // 事件类别显示名：数据层 token（含 gotoDir/load.* 等代码记号）→ 界面 key。
  // 映射值必须是 t 加中文字面量的直接调用（如 t("打开")），i18n 提取器才能扫到；
  // 未登记的 token 原样回退。detail（路径/坐标/标记）是诊断数据，不过翻译。
  const kindLabel = useMemo(() => {
    const map: Record<string, string> = {
      "按下": t("按下"),
      "单击": t("单击"),
      "dblclick事件": t("双击事件"),
      "按键": t("按键"),
      gotoDir: t("跳转目录"),
      navigatePane: t("切换窗格"),
      open: t("打开"),
      "rename-start": t("开始重命名"),
      "load.新加载": t("新加载"),
      "load.同路合并": t("同路合并"),
      "load.取消旧路径": t("取消旧加载"),
      "load.失败": t("加载失败"),
      "load.done": t("加载完成"),
    };
    return (kind: string) => map[kind] ?? kind;
  }, [t]);

  // 原始输入事件捕获：按下 / 单击（带连击序号）/ 双击 / 刷新键
  useEffect(() => {
    const tag = (e: Event) => {
      const el = e.target as HTMLElement | null;
      const row = el?.closest?.("[data-path]")?.getAttribute("data-path");
      if (row) return row.split("/").pop() ?? row;
      return el?.closest?.("[data-view-switch]") ? "[视图切换]"
        : el?.closest?.("[data-pathbar]") ? "[路径栏]"
        : (el?.tagName ?? "?");
    };
    const onDown = (e: MouseEvent) =>
      navDebugPush("按下", `${tag(e)} d=${e.detail} @${Math.round(e.clientX)},${Math.round(e.clientY)}`);
    const onClick = (e: MouseEvent) => navDebugPush("单击", `${tag(e)} d=${e.detail}`);
    const onDbl = (e: MouseEvent) => navDebugPush("dblclick事件", tag(e));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.key.toLowerCase() === "r" && (e.metaKey || e.ctrlKey)))
        navDebugPush("按键", `刷新 ${e.key}`);
    };
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("mousedown", onDown, opts);
    window.addEventListener("click", onClick, opts);
    window.addEventListener("dblclick", onDbl, opts);
    window.addEventListener("keydown", onKey, opts);
    return () => {
      window.removeEventListener("mousedown", onDown, opts);
      window.removeEventListener("click", onClick, opts);
      window.removeEventListener("dblclick", onDbl, opts);
      window.removeEventListener("keydown", onKey, opts);
    };
  }, []);

  const entries = useMemo(() => [...snap.entries].reverse(), [snap]);
  const newest = entries[0]?.t ?? 0;

  return (
    <div
      data-nav-debug=""
      className="pointer-events-none fixed bottom-2 left-2 z-[200] w-[470px] max-w-[92vw] rounded border border-primary/50 bg-background/95 p-2 font-mono text-[11px] leading-[15px] text-foreground/90 shadow-elevate"
    >
      <div className="mb-0.5 font-semibold text-primary">{t("导航诊断 NAV DEBUG（只读，不拦截操作）")}</div>
      <div className="truncate">{t("当前路径")} {shorten(panePath) || "—"}</div>
      <div className={cn(loading ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
        {t("加载中 {s} · 选中 {n} 项 · 事件 {m} 条", {
          s: loading ? t("是") : t("否"),
          n: selection.length,
          m: snap.seq,
        })}
      </div>
      <div className="mt-1 max-h-[210px] overflow-hidden border-t pt-1">
        {entries.length === 0 && <div className="text-muted-foreground">{t("（尚无事件——在列表里点几下）")}</div>}
        {entries.map((e, i) => (
          <div key={`${e.t}-${snap.entries.length - i}`} className="truncate">
            <span className={cn("inline-block w-[58px]", e.t - newest < 0 ? "text-muted-foreground" : "text-primary")}>
              {e.t - newest}ms
            </span>
            <span className="font-medium">{kindLabel(e.kind)}</span> {shorten(e.detail)}
          </div>
        ))}
      </div>
    </div>
  );
}
