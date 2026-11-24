/** SFTP/HTTP 路径判定与解析纯函数。抽出以便单测。 */

export function isSftpPath(p: string): boolean {
  return p.startsWith("sftp://");
}

export function isHttpPath(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
}

/** NFS 虚拟路径判定（v0.39）：nfs://host[:port]/export/path */
export function isNfsPath(p: string): boolean {
  return p.startsWith("nfs://");
}

export interface SftpAuthority {
  id: string;
  host: string;
  port: number;
  user: string;
  /** 远程路径部分（以 / 开头） */
  remotePath: string;
}

/** 解析 sftp://[user@]host[:port]/path 为结构。缺 user@ 也可解析（user=""，
 *  id 恒不与真实已连接 id 冲突——navigate 据此弹连接框预填 host/root，user
 *  留待用户补填）；host 段缺失返回 null。 */
export function parseSftpAuthority(path: string): SftpAuthority | null {
  const rest = path.startsWith("sftp://") ? path.slice("sftp://".length) : path;
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const remotePath = slash >= 0 ? rest.slice(slash) : "/";
  const [userPart, hostPort] = authority.includes("@")
    ? authority.split("@")
    : ["", authority];
  if (!hostPort) return null;
  const [host, portStr] = hostPort.includes(":") ? hostPort.split(":") : [hostPort, "22"];
  const port = Number(portStr) || 22;
  return { id: `${userPart}@${host}:${port}`, host, port, user: userPart, remotePath };
}

/**
 * 「host:/abs」scp 式写法归一为 sftp://host/abs（v0.51.1 用户诉求：路径栏直接
 * 输 `127.0.0.1:/home/user` 这类不带协议与端口的格式即可连 SFTP；user@host:/abs
 * 同样支持）。host 段首字母后至少还有 1 个字符——单字母 `C:` 的 `C:/Users`
 * 仍是 Windows 盘符本地路径，不误伤；已带 scheme / 标签 / ~ 路径原样返回。
 */
export function normalizeScpLikeSftp(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return path; // 已带 scheme
  if (path.startsWith("#") || path.startsWith("~")) return path; // 标签 / 主目录
  const m = path.match(/^([A-Za-z0-9][\w.@-]+):(\/.*)$/);
  return m ? `sftp://${m[1]}${m[2]}` : path;
}

/** 拼接远程路径：remoteDir 必须是纯远程路径（不以 sftp:// 开头）。 */
export function joinRemote(remoteDir: string, name: string): string {
  const base = remoteDir.endsWith("/") ? remoteDir : remoteDir + "/";
  return base + name;
}

/** 构造 sftp 虚拟路径；remotePath 缺省/不以 / 开头时补成绝对路径。 */
export function sftpUrl(
  user: string,
  host: string,
  port: number,
  remotePath: string,
): string {
  const p = remotePath && remotePath.startsWith("/") ? remotePath : `/${remotePath || ""}`;
  return `sftp://${user}@${host}:${port}${p}`;
}
