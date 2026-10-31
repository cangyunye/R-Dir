#!/usr/bin/env bash
set -e
for base in /srv/rdir-smb /srv/rdir-nfs; do
  mkdir -p "$base/文档"
  echo "hello from rdir" > "$base/文档/hello.txt"
done
chmod -R 777 /srv/rdir-smb /srv/rdir-nfs
ls /srv/rdir-nfs
echo CJK_OK
