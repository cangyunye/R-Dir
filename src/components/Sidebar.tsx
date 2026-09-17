import {
  Download,
  Film,
  Folder,
  FolderHeart,
  HardDrive,
  Home,
  Image,
  Music,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickAccessItem, VolumeInfo } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";

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
}: {
  quickAccess: QuickAccessItem[];
  volumes: VolumeInfo[];
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <ScrollArea className="w-44 shrink-0 border-r bg-muted/20">
      <div className="flex flex-col gap-4 p-2">
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
