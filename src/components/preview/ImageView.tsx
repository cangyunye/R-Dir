/**
 * 预览原图查看器（v0.28.0）：preview_data 原字节 data URL。
 * - 滚轮缩放（以光标为中心，1–10 倍，1 = 适配）
 * - 拖拽平移；双击切换 适配 ⇄ 100%
 * - 内存 LRU 缓存（key = 路径|mtime），选中切换往返不重复加载
 * 逻辑尺寸说明：img 经 max-w/h 约束即为「适配」布局盒，transform
 * translate(px) scale(zoom) 中 zoom 是相对适配的倍率，pan 为屏幕像素。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { previewData } from "@/lib/api";
import { cn } from "@/lib/utils";

/** v0.34.1 内存缓存上限改按总字节数：base64 比原字节膨胀 33%，后端单图上限 30MB，
 *  此前按张数（24 张）缓存连翻大图最坏可驻留 ~1GB；256MB 上限 + 单图超限不缓存。 */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, url: string) {
  const bytes = url.length; // data URL 为 ASCII，length ≈ 字节数
  if (bytes > MAX_CACHE_BYTES) {
    // 超大单图不缓存，只展示
    cacheBytes -= cache.get(key)?.length ?? 0;
    cache.delete(key);
    return;
  }
  cacheBytes -= cache.get(key)?.length ?? 0;
  cache.delete(key);
  cache.set(key, url);
  cacheBytes += bytes;
  while (cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 10;
const ZOOM_STEP = 1.2;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export function ImageView({
  path,
  mtime,
  fallback,
  className,
}: {
  path: string;
  mtime: number | null;
  /** 原图不可预览（格式不支持/读取失败）时的回退渲染 */
  fallback: React.ReactNode;
  className?: string;
}) {
  const key = `${path}|${mtime ?? 0}`;
  const [url, setUrl] = useState<string | null>(() => cacheGet(key) ?? null);
  const [failed, setFailed] = useState(false);
  /** 适配百分比（自然尺寸 vs 容器），用于显示真实缩放比 */
  const [fitPercent, setFitPercent] = useState(100);
  /** zoom = 相对适配的倍率（1 = 适配）；pan 为屏幕像素平移 */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 路径/_mtime 变化：重置视图与加载态
  useEffect(() => {
    setUrl(cacheGet(`${path}|${mtime ?? 0}`) ?? null);
    setFailed(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [path, mtime]);

  useEffect(() => {
    if (url || failed) return;
    let cancelled = false;
    previewData(path)
      .then((d) => {
        if (cancelled) return;
        if (d) {
          cacheSet(key, d);
          setUrl(d);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url, failed, path, key]);

  const recomputeFit = useCallback(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img || !img.naturalWidth || !img.naturalHeight) return;
    const fit = Math.min(
      box.clientWidth / img.naturalWidth,
      box.clientHeight / img.naturalHeight,
    );
    setFitPercent(Math.max(1, Math.round(fit * 100)));
  }, []);

  useEffect(() => {
    if (!url) return;
    recomputeFit();
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recomputeFit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [url, recomputeFit]);

  const applyZoom = useCallback(
    (nextZoom: number, cx?: number, cy?: number) => {
      const nz = clampZoom(nextZoom);
      const box = boxRef.current;
      if (nz === zoom) return;
      if (cx === undefined || cy === undefined || !box) {
        setZoom(nz);
        return;
      }
      // 以光标为锚：保持光标下的图像点不动（相对容器中心推导）
      const r = box.getBoundingClientRect();
      const dx = cx - (r.left + r.width / 2);
      const dy = cy - (r.top + r.height / 2);
      const k = nz / zoom;
      setPan({ x: dx - (dx - pan.x) * k, y: dy - (dy - pan.y) * k });
      setZoom(nz);
    },
    [zoom, pan],
  );

  // React 根节点 wheel 是 passive，preventDefault 需原生监听
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !url) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), e.clientX, e.clientY);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [url, zoom, applyZoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: pan.x, y: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onDoubleClick = () => {
    // 适配 ⇄ 100%（中心为锚，pan 归零）
    if (zoom === 1) {
      setZoom(clampZoom(100 / fitPercent));
      setPan({ x: 0, y: 0 });
    } else {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  };

  const percent = zoom === 1 ? "适配" : `${Math.round(zoom * fitPercent)}%`;

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={boxRef}
        data-testid="preview-image"
        className="relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
        title="滚轮缩放 · 拖拽平移 · 双击 100%/适配"
      >
        {url ? (
          <img
            ref={imgRef}
            src={url}
            alt=""
            draggable={false}
            onLoad={recomputeFit}
            className="max-h-full max-w-full object-contain"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          />
        ) : failed ? (
          fallback
        ) : (
          <div className="h-full w-full animate-pulse bg-muted/40" />
        )}
      </div>
      {url && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/85 px-1.5 py-0.5 text-[11px] shadow backdrop-blur-sm">
          <button
            className="pointer-events-auto rounded-full px-1.5 hover:bg-accent"
            onClick={() => applyZoom(zoom / ZOOM_STEP)}
            title="缩小"
          >
            −
          </button>
          <span className="w-10 text-center font-mono text-muted-foreground">{percent}</span>
          <button
            className="pointer-events-auto rounded-full px-1.5 hover:bg-accent"
            onClick={() => applyZoom(zoom * ZOOM_STEP)}
            title="放大"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
