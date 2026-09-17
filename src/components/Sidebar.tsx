import {
  Download,
  Film,
  Folder,
  FolderHeart,
  HardDrive,
  Home,
  Image,
  Music,
  Star,
  Tag,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickAccessItem, VolumeInfo } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TAG_DEFS } from "@/lib/persist";
import { basename } from "@/lib/format";

const QUICK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  home: Home,
  desktop: User,
  documents: Folder,
  downloads: Download,
  pictures: Image,
  music: Music,
  movies: Film,
};

const QUICK_LABELS: Record<string, string> = {
  home: "主目录",
  desktop: "桌面",
  documents: "文档",
  downloads: "下载",
  pictures: "图片",
  music: "音乐",
  movies: "影片",
};

function isActive(current: string, target: string): boolean {
  if (current === target) return true;
  // macOS 根目录 "/" 前缀匹配所有路径，特殊处理
  if (target === "/") return false;
  return current.startsWith(target + "/") || current.startsWith(target + "\\");
}

export function Sidebar({
  quickAccess,
  volumes,
  currentPath,
  onNavigate,
  customQuick,
  onRemoveQuick,
  tagCounts,
  activeTagId,
  onSelectTag,
}: {
  quickAccess: QuickAccessItem[];
  volumes: VolumeInfo[];
  currentPath: string;
  onNavigate: (path: string) => void;
  /** 用户自定义快捷访问（右键文件 → 添加到快捷访问） */
  customQuick: string[];
  onRemoveQuick: (path: string) => void;
  /** 每个标签下的文件数量 */
  tagCounts: Record<string, number>;
  activeTagId: string | null;
  onSelectTag: (tagId: string) => void;
}) {
  return (
    <ScrollArea className="w-44 shrink-0 border-r bg-muted/20">
      <div className="flex flex-col gap-4 p-2">
        {/* 快速访问（内置 + 用户自定义） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <FolderHeart className="h-3.5 w-3.5" /> 快速访问
          </div>
          {quickAccess.map((item) => {
            const Icon = QUICK_ICONS[item.key] ?? Folder;
            const label = QUICK_LABELS[item.key] ?? item.path;
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.path)}
                title={item.path}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  isActive(currentPath, item.path)
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
          {/* 用户自定义快捷访问（在快捷访问下方） */}
          {customQuick.length > 0 && (
            <div className="mt-1 border-t pt-1">
              {customQuick.map((p) => {
                const name = basename(p) || p;
                return (
                  <div
                    key={p}
                    className="group relative"
                  >
                    <button
                      onClick={() => onNavigate(p)}
                      title={p}
                      className={cn(
                        "flex w-full items-center gap-2 rounded py-1.5 pr-6 pl-2 text-left text-xs transition-colors",
                        isActive(currentPath, p)
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50",
                      )}
                    >
                      <Star className="h-4 w-4 shrink-0 text-amber-500/90" />
                      <span className="truncate">{name}</span>
                    </button>
                    <button
                      onClick={() => onRemoveQuick(p)}
                      title="从快捷访问移除"
                      className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 标签（Finder 风格，位于快捷访问下方、磁盘上方） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <Tag className="h-3.5 w-3.5" /> 标签
          </div>
          {TAG_DEFS.map((t) => {
            const count = tagCounts[t.id] ?? 0;
            const active = activeTagId === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onSelectTag(t.id)}
                title={`查看「${t.label}」标签的文件${count > 0 ? `（${count} 项）` : ""}`}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : count === 0
                      ? "text-muted-foreground/70 hover:bg-accent/50"
                      : "text-foreground hover:bg-accent/50",
                )}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: t.color }}
                />
                <span className="flex-1 truncate">{t.label}</span>
                {count > 0 && (
                  <span className="tabular-nums text-[10px] text-muted-foreground">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" /> 磁盘 / 卷
          </div>
          {volumes.map((vol) => (
            <button
              key={vol.path}
              onClick={() => onNavigate(vol.path)}
              title={vol.path}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                isActive(currentPath, vol.path)
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50",
              )}
            >
              <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{vol.name}</span>
            </button>
          ))}
          {volumes.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">未检测到磁盘</div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
