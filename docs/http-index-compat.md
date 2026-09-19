# HTTP 索引兼容方案（v0.7.2 规划）

> 目标：让 R-Dir 的 HTTP 目录访问不局限于 nginx `autoindex on` 的 HTML 格式，
> 兼容 JSON 索引 API、其他 web 服务，并可靠区分"目录页 / JSON 索引 / 普通网页 / 文件"。
> 本文件为方案设计，实现归入 v0.7.2。

## 现状（v0.6/v0.7）

- `http_autoindex::list_http_dir(url)`：无条件请求 URL → 按 nginx autoindex HTML 正则解析
  （`<a href="...">name</a>`）→ 非 autoindex 页面直接报错
- 无内容类型判断、无 JSON 支持、无插件化解析器

## 核心思路：三层判定 + 解析器注册表

```
请求 URL
  │
  ├─ ① 响应头快筛（低开销）
  │     Content-Type: application/json        → JSON 索引解析器
  │     Content-Type: text/html               → ② 体嗅探
  │     Content-Type: 文件类型(pdf/zip/mp4)   → 文件（下载/打开）
  │     Content-Disposition: attachment       → 文件
  │     X-Index-Type: autoindex|json (自定义) → 服务端显式声明，跳过嗅探（可选扩展）
  │
  ├─ ② 体特征嗅探（读前 8KB）
  │     HTML: 含 <h1>Index of ...</h1> + <a href=  → autoindex HTML 解析器
  │     HTML: 有 <html> 但无索引签名              → 普通网页（非目录，提示用浏览器打开）
  │     JSON: 顶层数组 / {entries|files|list:[...]} → JSON 索引解析器
  │
  └─ ③ 解析器注册表（v0.5 插件体系扩展）
        每个解析器声明：match 规则（Content-Type + 体签名）+ parse(body) → FileEntry[]
        内置：autoindex-html（现有）、json-index（v0.7.2 新增）
        未来：h5ai、Apache Directory、DAV-JSON 等按需注册
```

## 判定细节

### ① 响应头
| 响应头 | 判定 |
|---|---|
| `Content-Type: application/json` | JSON 索引（直接分发） |
| `Content-Type: text/html` | 需体嗅探（autoindex 或普通网页） |
| 其他 `Content-Type`（image/pdf/video/zip...） | 文件，走下载/打开 |
| `Content-Disposition: attachment` | 文件（即使 Content-Type 是 text/html 也按文件） |

### ② 体嗅探签名（防误判）
| 服务 | 强签名 |
|---|---|
| nginx autoindex | `<h1>Index of`（标题行）+ 大量 `<a href="...">` |
| JSON 索引（约定协议） | 顶层 `{` 或 `[`，解析后含 entries 结构 |
| 普通网页 | `<html>/<head>` 存在但无索引签名 |

**URL 形态不作为主判据**（SPA 路由也以 `/` 结尾），仅作为提示辅助。

### ③ JSON 索引约定协议（建议，web 服务可对接）
```json
{
  "path": "/dir/",
  "entries": [
    { "name": "assets", "type": "dir",  "size": null,      "modified": "2026-09-19T10:00:00Z" },
    { "name": "readme.md", "type": "file", "size": 7982,   "modified": "2026-09-19T08:50:00Z" }
  ]
}
```
**宽松兼容**（应对不同服务）：
- 顶层：数组 `[...]`、`{entries}`、`{files}`、`{list}` 均可
- 字段：`name`/`filename`、`type`/`is_dir`/`directory`/`kind`、`size`、`modified`/`mtime`
- 目录项：`type: "dir"` 或以 `/` 结尾的 name

## 用户显式指定（兜底）

地址栏支持强制前缀，绕过嗅探：
- `index+http://host/dir/` → 强制按目录索引解析
- `file+http://host/xxx.pdf` → 强制按文件下载
- 插件设置可配置"默认按 URL 后缀识别"（如 `.json` 结尾 → JSON）

## 测试方案（本机 nginx，8082 已有 autoindex）

### 方案 A：静态 JSON 文件（最简单，无需模块）
1. 在 autoindex 目录建 `index.json`（内容符合上述协议）
2. nginx 无需改动（静态文件直接返回）
3. R-Dir 地址栏访问 `http://localhost:8082/<目录>/index.json`
   → 预期：识别为 JSON 索引，显示文件列表

### 方案 B：njs 动态 JSON（模拟真实服务）
```nginx
load_module modules/ngx_http_js_module.so;
js_import list from /etc/nginx/json-index.js;
location /json/ {
    js_content list.index;
}
```
`json-index.js` 读取目录 → 返回 JSON（字段按约定协议）。
R-Dir 访问 `http://localhost:8082/json/<目录>/` → 预期同上。

### 方案 C：普通网页识别测试
访问任意非索引 URL（如站点首页）→ 预期：提示"非目录页，可用浏览器打开"，不误判为目录。

## 实现清单（v0.7.2）

1. `http_autoindex.rs`：`list_http_dir` 重构为"请求 → 头快筛 → 体嗅探 → 分发解析器"
2. 新增 `parse_json_index(body)`（宽松解析：数组/对象/字段别名）
3. 插件注册表：新增 `http-index-json` 解析器条目（`source: builtin`）
4. 前端：JSON 索引复用现有文件列表渲染（无改动）；非目录网页给 toast 提示
5. 回归：autoindex HTML 解析保持兼容（现有测试用例全绿）

## 风险与边界

| 风险 | 对策 |
|---|---|
| JSON 误判为目录（API 返回对象但非索引） | 解析失败回退为"非目录页"提示，不硬渲染 |
| 大 JSON / 大 HTML | 体嗅探只读前 8KB；解析器对超大响应限流 |
| 普通网页误判 | 强签名匹配（`<h1>Index of`），无签名一律不按目录 |
| Content-Type 缺失 | 按体嗅探兜底 |
