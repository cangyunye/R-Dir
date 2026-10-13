/**
 * 画廊模式缩略图（v0.27.0）：进入视口后经 Rust thumb_get 取 PNG data URL，
 * 内存 LRU 缓存（key = 路径|mtime，刷新目录后 mtime 变化自然失效）。
 * 不支持/加载失败渲染 fallback（调用方传大类型图标）。
 */
import { useEffect, useRef, useState } from "react";
import { thumbGet } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_CACHE = 256;
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit); // 刷新 LRU 新鲜度
  }
  return hit;
}

function cacheSet(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function ThumbImage({
  path,
  mtime,
  size,
  className,
  fallback,
}: {
  path: string;
  mtime: number | null;
  /** 请求的缩略图边长（px，前端展示尺寸，后端等比内切） */
  size: number;
  className?: string;
  fallback: React.ReactNode;
}) {
  const key = `${path}|${mtime ?? 0}`;
  const [url, setUrl] = useState<string | null>(() => cacheGet(key) ?? null);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(url !== null);

  useEffect(() => {
    setUrl(cacheGet(`${path}|${mtime ?? 0}`) ?? null);
    setFailed(false);
  }, [path, mtime]);

  // 进入视口才开始取图（大量图片的目录避免一次性全量解码）。
  // 无 IntersectionObserver 的环境（jsdom 测试）直接视为可见。
  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "256px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || url || failed) return;
    let cancelled = false;
    thumbGet(path, Math.max(96, Math.min(512, size)))
      .then((data) => {
        if (cancelled) return;
        if (data) {
          cacheSet(key, data);
          setUrl(data);
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
  }, [visible, url, failed, path, size, key]);

  return (
    <div ref={hostRef} className={cn("flex items-center justify-center", className)}>
      {url ? (
        <img
          src={url}
          alt=""
          aria-hidden
          draggable={false}
          className="max-h-full max-w-full rounded-md object-contain shadow-md"
        />
      ) : failed ? (
        fallback
      ) : (
        <div className="h-full w-full animate-pulse rounded-md bg-muted/60" />
      )}
    </div>
  );
}
