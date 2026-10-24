#!/usr/bin/env bash
# v0.32 解压功能 GUI 手测夹具生成（REGRESSION.md 2.5 配套）
#
# 用法：tools/gen-archive-fixtures.sh [输出目录]
#   缺省输出到 /tmp/rdir-archive-fixtures，生成后用 R-Dir 打开该目录逐个右键自测。
#   产物与预期结果对照见目录内 README.md（本脚本末尾同步生成）。
set -euo pipefail

OUT="${1:-/tmp/rdir-archive-fixtures}"
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

# ---------- 源内容 ----------
mkdir -p src/sub
echo "hello world" > src/a.txt
echo "嵌套内容" > src/sub/b.txt
echo "根级文件" > top.txt

# ---------- zip：ditto 打包（含 __MACOSX AppleDouble，验证过滤） ----------
ditto -c -k --sequesterRsrc --keepParent src ditto-src.zip

# ---------- zip：GBK 文件名（模拟 Windows 资源管理器/旧 WinRAR，无 UTF-8 标志位） ----------
python3 - <<'EOF'
import zipfile
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode("gbk"), self.flag_bits)
with zipfile.ZipFile("gbk-names.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("中文目录/测试文档.txt", "内容")
    z.writestr("根文件.txt", "x")
EOF

# ---------- zip：传统 ZipCrypto 加密（密码 pw123） ----------
mkdir -p enc
echo "秘密内容" > enc/秘密.txt
zip -q -r -P pw123 zipcrypto-pw123.zip enc

# ---------- zip：损坏（截断） ----------
cp ditto-src.zip corrupted.zip
truncate -s 200 corrupted.zip

# ---------- tar 家族（多顶层条目 → 验证「解压到此处」建文件夹） ----------
tar -cf plain.tar src top.txt
gzip -kf plain.tar          # plain.tar.gz
bzip2 -kf plain.tar         # plain.tar.bz2
if tar -cJf tarxz.tar.xz src top.txt 2>/dev/null; then
  cp tarxz.tar.xz short.txz
else
  echo "（跳过 tar.xz：系统 tar 无 liblzma）"
fi

# ---------- 单文件 gz / bz2（非 tar 包，验证解出为同名文件） ----------
gzip -kf src/a.txt && mv src/a.txt.gz single.txt.gz
bzip2 -kf src/a.txt && mv src/a.txt.bz2 single.txt.bz2

# ---------- 大包（进度条 / 取消测试，约 200MB 低压缩比） ----------
DD=$(mktemp -d)
dd if=/dev/urandom of="$DD/rand.bin" bs=1m count=200 2>/dev/null || dd if=/dev/urandom of="$DD/rand.bin" bs=1M count=200 2>/dev/null
tar -czf big-200MB.tgz -C "$DD" rand.bin
rm -rf "$DD"

# ---------- 7z（本机有 sevenzip 时生成；rar 需官方工具，README 注明） ----------
if command -v 7zz >/dev/null 2>&1; then
  7zz a -bd -bso0 sevenzip.7z src top.txt
elif command -v 7z >/dev/null 2>&1; then
  7z a -bd sevenzip.7z src top.txt >/dev/null
fi

# ---------- 预期结果对照 ----------
cat > README.md <<'MD'
# v0.32 解压手测夹具（REGRESSION.md 2.5 配套）

在 R-Dir 中打开本目录，逐个右键自测。密码类夹具密码均为 **pw123**。

| 夹具 | 操作 | 预期 |
|---|---|---|
| ditto-src.zip | 解压到此处 | 单顶层 src/ → 直接解到当前目录；无 __MACOSX/._* 垃圾 |
| gbk-names.zip | 解压到此处 | 中文目录/测试文档.txt 不乱码（此前必乱码） |
| zipcrypto-pw123.zip | 解压到此处 | 弹密码框；错误密码框内提示可重试；pw123 解出 enc/秘密.txt |
| corrupted.zip | 解压到此处 | 报错（无法读取 zip / 数据损坏），无半成品残留 |
| plain.tar / .tar.gz / .tar.bz2 | 解压到此处 | 多顶层 → 建 plain/（或 plain.tar/）文件夹收纳 |
| tarxz.tar.xz / short.txz | 解压到此处 | macOS / Win11 可解；Win10 报系统 tar 不支持 |
| single.txt.gz / .bz2 | 解压到此处 | 解出 single.txt；同名再解自动 (2) |
| big-200MB.tgz | 解压到此处 | 进度条逐条目推进；中途点 × 取消，半成品被清理 |
| sevenzip.7z（有 7zz 时） | 解压到此处 | 系统 tar 兜底解出 |
| （自备任意 .rar） | 解压到此处 | macOS / Win11 可解（rar5 需 libarchive 3.4+，Win10 不支持） |

通用检查：解压完成浮层提示、列表自动刷新、同名落点自动 (2)、解压到… 的目录选择。
MD

echo "=== 夹具生成完毕：$OUT ==="
ls -lh "$OUT" | awk '{print $5, $NF}' | tail -n +2
