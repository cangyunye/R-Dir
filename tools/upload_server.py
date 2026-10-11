"""超简单文件上传测试服务（仅本地测试用）。

用途：验证 R-Dir 能否像从 Windows 资源管理器拖文件那样，直接拖进网页上传。

用法：
    python tools/upload_server.py [端口]      # 默认 8765

浏览器打开 http://127.0.0.1:8765 ，把 R-Dir 里的文件拖进投放区：
- 光标出现"复制"标记、状态栏显示"检测到文件拖入（Files）"→ 拖出端提供了真实
  文件引用（CF_HDROP），松手即上传；
- 状态栏显示"文本拖拽（无 Files）"→ 拖出端只带了 text/uri-list 等文本格式，
  浏览器不会当作文件（修复前的表现）。

收到的文件按"原名-时分秒"保存在 tools/uploads/ 下。
"""

import http.server
import json
import pathlib
import time
import urllib.parse

SAVE_DIR = pathlib.Path(__file__).resolve().parent / "uploads"
SAVE_DIR.mkdir(exist_ok=True)

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>R-Dir 拖拽上传测试</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 720px; margin: 40px auto; color: #222; }
  #zone { border: 3px dashed #999; border-radius: 12px; padding: 64px 24px; text-align: center;
          font-size: 20px; color: #666; transition: all .15s; }
  #zone.over { border-color: #d97706; background: #fffbeb; color: #b45309; }
  #zone.files { border-color: #16a34a; background: #f0fdf4; color: #15803d; }
  #status { min-height: 28px; font-size: 15px; margin: 16px 0; white-space: pre-wrap; }
  ol { font-size: 14px; color: #555; line-height: 1.8; }
  #list { font-size: 13px; color: #444; }
</style>
</head>
<body>
<h2>R-Dir 拖拽上传测试</h2>
<div id="zone">把文件拖到这里（来自 R-Dir 或资源管理器）</div>
<div id="status"></div>
<p>已收到的文件（tools/uploads/）：</p>
<ul id="list"></ul>
<ol>
  <li>把文件从 R-Dir 拖到本页投放区，光标应出现"复制"标记而非禁止 🚫。</li>
  <li>松手后状态栏显示"检测到文件拖入（Files）"即拖出端提供了真实文件引用，随后逐个上传。</li>
  <li>若显示"文本拖拽（无 Files）"，说明拖出端只携带了 text/uri-list 等文本格式 —— 浏览器不会当作文件。</li>
</ol>
<input id="pick" type="file" multiple style="margin-top:16px">
<script>
const zone = document.getElementById("zone");
const status = document.getElementById("status");
const list = document.getElementById("list");

async function refresh() {
  const r = await fetch("/list");
  list.innerHTML = (await r.json()).map((n) => `<li>${n}</li>`).join("");
}

async function upload(files) {
  for (const f of files) {
    const r = await fetch("/upload?name=" + encodeURIComponent(f.name), { method: "POST", body: f });
    const j = await r.json();
    status.textContent += `${j.ok ? "✅" : "❌"} ${j.name}（${j.size} 字节）\\n`;
  }
  refresh();
}

zone.addEventListener("dragover", (e) => {
  e.preventDefault();
  const isFiles = e.dataTransfer.types.includes("Files");
  e.dataTransfer.dropEffect = isFiles ? "copy" : "none";
  zone.className = isFiles ? "files" : "over";
  const types = [...e.dataTransfer.types].join(", ");
  status.textContent = isFiles
    ? `检测到文件拖入（Files）✅ 松手即上传（types: ${types}）`
    : `文本拖拽（无 Files）❌ —— 拖出端未提供真实文件引用（types: ${types || "空"}）`;
});
zone.addEventListener("dragleave", () => { zone.className = ""; });
zone.addEventListener("drop", async (e) => {
  e.preventDefault();
  zone.className = "";
  status.textContent = "";
  const dt = e.dataTransfer;
  if (!dt || !dt.types.includes("Files")) {
    status.textContent = "❌ drop 里没有 Files：types = [" + [...dt.types].join(", ") + "]";
    return;
  }
  await upload([...dt.files]);
});
document.getElementById("pick").addEventListener("change", (e) => upload([...e.target.files]));
refresh();
</script>
</body>
</html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/list":
            names = sorted(p.name for p in SAVE_DIR.iterdir() if p.is_file())
            self._send(200, json.dumps(names, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        else:
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")

    def do_POST(self):
        if not self.path.startswith("/upload"):
            self._send(404, b"not found", "text/plain")
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        name = pathlib.Path(q.get("name", ["unnamed.bin"])[0]).name or "unnamed.bin"
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length)
        stem = pathlib.Path(name).stem or "unnamed"
        suffix = pathlib.Path(name).suffix
        # 时间戳后缀防同秒同名覆盖
        target = SAVE_DIR / f"{stem}-{time.strftime('%H%M%S')}-{time.time_ns() % 1000:03d}{suffix}"
        target.write_bytes(data)
        print(f"[upload] {target.name}  {len(data)} 字节")
        body = json.dumps({"ok": True, "name": target.name, "size": len(data)}, ensure_ascii=False).encode()
        self._send(200, body, "application/json; charset=utf-8")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # 常规访问静默，只打印上传记录


if __name__ == "__main__":
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"上传测试服务: http://127.0.0.1:{port}")
    print(f"保存目录: {SAVE_DIR}")
    print("Ctrl+C 退出")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
