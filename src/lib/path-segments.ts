/** 路径栏面包屑分段拆分（纯函数，便于单测）。
 * 支持：本地盘符/UNC/POSIX、sftp://、http(s)://、tags:// 虚拟视图。 */

export interface PathSegment {
  /** 展示文本 */
  label: string;
  /** 点击后应导航到的路径 */
  target: string;
}

export function splitPathSegments(path: string): PathSegment[] {
  if (!path) return [];

  // 标签虚拟视图：整体一段
  if (path.startsWith("tags://")) return [{ label: path, target: path }];

  // sftp:// / http(s)://：authority 为首段，其余按 / 拆
  const remote = path.match(/^(sftp|https?):\/\/([^/]*)(\/.*)?$/);
  if (remote) {
    const root = `${remote[1]}://${remote[2]}`;
    const segs: PathSegment[] = [{ label: remote[2] || root, target: root + "/" }];
    let acc = root;
    for (const part of (remote[3] ?? "").split("/").filter(Boolean)) {
      acc = `${acc}/${part}`;
      segs.push({ label: part, target: acc });
    }
    return segs;
  }

  // Windows 盘符（兼容 / 与 \ 分隔）
  const drive = path.match(/^([A-Za-z]:)((?:[\\/].*)?)$/);
  if (drive) {
    const root = `${drive[1]}\\`;
    const segs: PathSegment[] = [{ label: root, target: root }];
    let acc = root;
    for (const part of (drive[2] ?? "").split(/[\\/]/).filter(Boolean)) {
      acc = `${acc}${part}\\`;
      segs.push({ label: part, target: acc.slice(0, -1) });
    }
    return segs;
  }

  // UNC \\server\share\...
  const unc = path.match(/^\\\\([^\\/]+)([\\/][^\\/]+)((?:[\\/].*)?)$/);
  if (unc) {
    const root = `\\\\${unc[1]}${unc[2]}`;
    const segs: PathSegment[] = [{ label: root, target: root }];
    let acc = root;
    for (const part of (unc[3] ?? "").split(/[\\/]/).filter(Boolean)) {
      acc = `${acc}\\${part}`;
      segs.push({ label: part, target: acc });
    }
    return segs;
  }

  // POSIX 绝对路径
  if (path.startsWith("/")) {
    const segs: PathSegment[] = [{ label: "/", target: "/" }];
    let acc = "";
    for (const part of path.split("/").filter(Boolean)) {
      acc += `/${part}`;
      segs.push({ label: part, target: acc });
    }
    return segs;
  }

  // 相对路径兜底：整体一段
  return [{ label: path, target: path }];
}
