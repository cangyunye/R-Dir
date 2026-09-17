/** lsd 风格的人类可读大小：1.4K / 2.3M / 1.2G */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0B";
  const units = ["B", "K", "M", "G", "T", "P"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const v = bytes / Math.pow(1024, i);
  const s =
    i === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${s}${units[i]}`;
}

/** 友好时间：今年内 "MM-DD HH:mm"，跨年 "YYYY-MM-DD" */
export function formatTime(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${md}`;
}

/** 取路径末级名称（标签标题用） */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
