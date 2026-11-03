#!/usr/bin/env node
/**
 * v0.40 NFS 伴生进程插件打包（CI 与本地共用，纯 Node stdlib，跨平台一致）：
 *   node tools/pack-nfs-plugin.mjs <binary> <version> <target> <out.rdplugin> <out-manifest.json>
 *
 * 产物 1：<out.rdplugin> —— zip 容器（deflate）：manifest.json + 二进制。
 * 产物 2：<out-manifest.json> —— 独立校验清单（整包 sha256，来源独立于包本体），
 *        上传为 Release 资产 rdir-nfs-manifest-<target>.json，宿主在线获取时先取它校验整包。
 *
 * 包内 manifest 的 sha256 = 二进制 sha256；清单的 sha256 = 整包 sha256。
 * host 侧校验链见 src-tauri/src/nfs_plugin.rs（id/协议版本/最低宿主版本/目标三元组/双 sha256）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { basename } from "node:path";

// ---- CRC32（zip 标准要求；zlib.crc32 需 Node ≥20.15，自带实现不挑版本） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 极简 zip 写入器：deflate 条目 + 中央目录（所有平台产出字节级一致的标准 zip） */
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 = deflate)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mtime
    local.writeUInt16LE(0x21, 12); // mdate (1980-01-01，确定性输出)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    parts.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags: UTF-8
    cd.writeUInt16LE(8, 10); // method: deflate
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const [binPath, version, target, outPkg, outManifest] = process.argv.slice(2);
if (!binPath || !version || !target || !outPkg || !outManifest) {
  console.error("用法: node tools/pack-nfs-plugin.mjs <binary> <version> <target> <out.rdplugin> <out-manifest.json>");
  process.exit(1);
}

const bin = readFileSync(binPath);
const exeName = basename(binPath);
const binSha = (await import("node:crypto")).createHash("sha256").update(bin).digest("hex");

const manifest = {
  id: "nfs",
  version,
  protocolVersion: 1,
  minHostVersion: version,
  target,
  sha256: binSha,
  exeName,
};
const pkg = makeZip([
  { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
  { name: exeName, data: bin },
]);
writeFileSync(outPkg, pkg);

const pkgSha = (await import("node:crypto")).createHash("sha256").update(pkg).digest("hex");
writeFileSync(
  outManifest,
  JSON.stringify(
    {
      version,
      protocolVersion: 1,
      minHostVersion: version,
      target,
      file: basename(outPkg),
      sha256: pkgSha,
    },
    null,
    2,
  ) + "\n",
);
console.log(`packed ${outPkg} (${pkg.length} bytes, binary sha256 ${binSha.slice(0, 12)}…, package sha256 ${pkgSha.slice(0, 12)}…)`);
