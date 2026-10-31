#!/usr/bin/env bash
# R-Dir v0.39 WSL 测试服务搭建（在 Ubuntu2604 内以 root 执行）
set -e

for base in /srv/rdir-smb /srv/rdir-nfs; do
  rm -rf "$base"
  mkdir -p "$base/bn" "$base/nested/deep" "$base/empty-dir"
  echo "hello from rdir" > "$base/bn/hello.txt"
  echo "# rdir test share" > "$base/readme.md"
  head -c 8388608 /dev/urandom > "$base/big-8mb.bin"
  echo "deep file" > "$base/nested/deep/file.txt"
done
chmod -R 777 /srv/rdir-smb /srv/rdir-nfs

# Samba：真实用户（Win11 24H2 禁 guest + 强制签名）
id rdir >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin rdir
(echo rdir123; echo rdir123) | smbpasswd -a -s rdir >/dev/null
cat >> /etc/samba/smb.conf <<'EOF'

[rdir]
   path = /srv/rdir-smb
   browseable = yes
   read only = no
   guest ok = no
   valid users = rdir
   force user = rdir
EOF

# NFS：导出 + 固定 mountd 端口
mkdir -p /etc/exports.d /etc/nfs.conf.d
echo '/srv/rdir-nfs *(rw,insecure,no_root_squash,no_subtree_check)' > /etc/exports.d/rdir.exports
printf '[mountd]\nport=32767\n' > /etc/nfs.conf.d/mountd.conf

# 启动
service rpcbind start || rpcbind -w
modprobe nfsd 2>/dev/null || true
exportfs -ra
service nfs-kernel-server restart
service smbd restart
sleep 2

echo "== ports =="
ss -tlnp | grep -E ':445 |:2049 |:111 |:32767 ' | awk '{print $4}'
echo "== ip =="
hostname -I
echo "== exports =="
exportfs -v | head -3
echo "== files =="
ls /srv/rdir-nfs
echo SETUP_OK
