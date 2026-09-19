/** SFTP/HTTP 路径判定与解析纯函数。抽出以便单测。 */

export function isSftpPath(p: string): boolean {
  return p.startsWith("sftp://");
}

export function isHttpPath(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
}

export interface SftpAuthority {
  id: string;
  host: string;
  port: number;
  user: string;
  /** 远程路径部分（以 / 开头） */
  remotePath: string;
}

/** 解析 sftp://user@host:port/path 为结构。返回 null 表示缺 user@host。 */
export function parseSftpAuthority(path: string): SftpAuthority | null {
  const rest = path.startsWith("sftp://") ? path.slice("sftp://".length) : path;
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const remotePath = slash >= 0 ? rest.slice(slash) : "/";
  const [userPart, hostPort] = authority.includes("@")
    ? authority.split("@")
    : ["", authority];
  if (!userPart || !hostPort) return null;
  const [host, portStr] = hostPort.includes(":") ? hostPort.split(":") : [hostPort, "22"];
  const port = Number(portStr) || 22;
  return { id: `${userPart}@${host}:${port}`, host, port, user: userPart, remotePath };
}

/** 拼接远程路径：remoteDir 必须是纯远程路径（不以 sftp:// 开头）。 */
export function joinRemote(remoteDir: string, name: string): string {
  const base = remoteDir.endsWith("/") ? remoteDir : remoteDir + "/";
  return base + name;
}
