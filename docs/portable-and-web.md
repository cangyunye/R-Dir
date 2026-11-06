# 绿色版（便携模式）与 Web 子命令方案

> v0.43 规划落地基：本文记录两条产品线的架构决策与实施状态。
> 分支 `feat/portable-and-web-foundation` 已交付第 1、2 阶段。

## 1. 绿色版（Windows 免安装）

### 原理

Tauri 2 的 Windows 产物 = 单 exe + 系统 WebView2 Runtime。NSIS 安装器只做拷贝、
快捷方式、WebView2 检测，无注册表依赖 → 便携化只需把数据目录从 `%APPDATA%`
迁到 exe 旁。

### 便携模式机制（已实现）

- `src-tauri/src/paths.rs`：`config_dir()` / `data_dir()` 统一解析所有持久化路径。
  主程序同目录存在 `R-Dir.portable` 标记文件（存在且**为文件**）→ 全部数据落
  `exe_dir/data/{config,data}`（解析时确保目录存在）；否则回落 Tauri dirs，
  安装版行为不变。
- 标记只在 exe 直接父目录查找，祖先目录的标记不生效（防嵌套安装误判）。
- 收敛的调用点：session/prefs/favorites/servers/plugins/themes/openers/
  cmd-index（config_dir）；iconpos/thumbs（data_dir）；NFS 插件根（config_dir/plugins）。
- CI：release.yml 在 Windows 构建后打
  `R-Dir_<ver>_windows_x64_portable.zip`（exe + 标记 + `tools/portable-README.txt`），
  与五个安装包一起纳入 publish 资产门禁（缺一不可）。

### 边界说明

- WebView2 Runtime 缺失（个别精简版 Win10）→ README 引导装 Evergreen Runtime。
- 无文件关联 / 开始菜单 / 自动更新通道——更新 = 覆盖 exe（data\ 保留）。
- Tauri 2 在 MSVC 上静态链接 WebView2Loader，zip 内无需附带 dll。

## 2. Web 子命令（浏览器服务）

### 形态决策：独立二进制 `rdir-web`

- 同 binary 子命令的问题：release 版 `windows_subsystem = "windows"` 无控制台
  （URL/token 不可见）；且会拉起 Tauri/WebView2 依赖。
- 独立 bin（复刻 `crates/rdir-nfs` 先例）：console 子系统、无 WebView2 依赖、
  可跑在无桌面的 Windows Server / NAS；GUI 版二进制保持精简。
- 结构：`src-tauri/src/bin/rdir-web.rs` + `src-tauri/src/web/`（bridge/auth/assets）。

### 传输设计（核心取舍）

**不**把 ~100 个 command 翻译成 REST 路由，改单端点透传：

```
POST /api/invoke   {"cmd","args"} → {"ok":true,"data"} | {"ok":false,"error":"CODE|详情"}
WS   /api/events   帧 = {event, payload}（与 tauri emit 同构）
GET  /*            前端静态资源（rust-embed 内嵌进二进制）
```

- 前端契约零改动：`terr()` 的 `CODE|详情` 错误码链路、`camelCase` 参数映射
  （桥端 `serde rename_all = "camelCase"` 对齐）原样工作。
- 防漂移关键：`bridge_commands!` 声明式宏同时生成 tauri command 与 axum 路由，
  单一注册源。
- 缩略图/预览已是 base64 data URL、进度走事件帧——浏览器端零改动。

### 已交付的地基（本分支）

| 层 | 改动 |
|---|---|
| 前端 | `src/lib/ipc.ts`：`invoke`/`listen` 双传输适配（Tauri 直传；Web 走 `/api/invoke` fetch + `/api/events` WS 扇出、指数退避重连、退订即断开）。错误契约与 Tauri 一致（reject 原始 `CODE\|详情` 字符串；传输层自身失败以 `WEB_OFFLINE`/`WEB_BAD_RESPONSE` 码化） |
| 前端 | `api.ts`/`persist.ts`/`themePacks.ts`/`openerApi.ts` 的 invoke 与 App/三对话框的 listen 全部收敛到 ipc.ts；桌面专属 API（窗口控制、webview 拖放、原生对话框、app 元数据）保留直引 + 既有 `__TAURI_INTERNALS__` 能力探测 |
| 后端 | `src-tauri/src/paths.rs` 数据目录收敛（便携/Web 共用；web 模式无需 AppHandle 以外的目录来源） |
| 后端 | `src-tauri/src/events.rs` **EventSink**：`Emitter` trait（对象安全，收 `serde_json::Value`）+ `EventSink`（可克隆 Arc 出口）+ `TauriEmitter`（泛型 Runtime）。fs_watch/volumes/progress/compress/extract/http_autoindex/share 全部改为 sink 发射——**模块层已零 AppHandle**；`app-exit-requested`（窗口生命周期，纯桌面概念）仍直接 emit。18+ 处 lib.rs 命令边界 `EventSink::from(&app)` 接线 |
| 后端 | `src-tauri/src/web/` + `bin/rdir-web.rs`（web feature 门控，`required-features` 使默认构建自动跳过 bin）：`POST /api/invoke` 命令透传（bridge.rs 分发表，首批 27 命令 = 浏览/持久化/主题/插件/缩略图/预览/属性统计）、`WS /api/events` 事件广播（`events.rs::WebEmitter` broadcast → `{event,payload}` 帧）、rust-embed 内嵌 `../dist` 静态资源、cookie 鉴权（`/login?k=令牌` 换 HttpOnly cookie，fetch/WS 自动携带，ipc.ts 零改动）。未收录命令统一 `WEB_UNSUPPORTED\|...` 码化拒绝 |

### rdir-web 使用

```bash
pnpm web            # = pnpm build && (cd src-tauri) cargo run --features web --bin rdir-web
# 或手动（注意 cargo 在 src-tauri/ 层）：
pnpm build
cd src-tauri
cargo build --release --features web --bin rdir-web
./target/release/rdir-web --listen 127.0.0.1:8420
# → 打印带令牌进站链接：http://127.0.0.1:8420/login?k=<32位hex>
```

- 数据目录：`--data-dir` > 便携标记（exe 旁 `R-Dir.portable`）> 用户配置目录（与 GUI 同落点）
- 与 GUI 版共用同一套配置（session/prefs/favorites/themes/plugins），可互启
- 默认监听 127.0.0.1；`--listen 0.0.0.0` 显式开放局域网；无内置 TLS，外网暴露需反代
- 事件链路已验证：fs_watch 线程 → WebEmitter broadcast → WS → 前端 `fs://changed` 刷新

### 文件打开（双击/外部打开链路）

- `GET /api/file?path=<绝对路径>[&dl=1]`：服务端文件流。Content-Type 按扩展名
  （图/文/PDF/音视频/字体/vite 产物全覆盖）；`dl=1` 强制 attachment，否则 inline
  （浏览器内联展示或按 octet-stream 落下载）；Range 单段断点（视频拖动，
  解析失败整文件 200 兜底）；流式 unfold 不占内存。
- 安全：响应带 `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff`
  ——双击打开的文档（含不可信 HTML）运行在 opaque origin，拿不到应用 cookie、
  调不了 /api/*，杜绝「打开下载的网页 → 脚本以应用身份读全盘」的提权。
- 前端：`openLocalFile` 浏览器分支 → 新标签页 `/api/file`；`openExternal`（原
  plugin-opener 的 openUrl）同理。远程文件复用既有 ensureLocalCopy 链路：
  sftp_download 落服务端临时目录（桥接命令）→ 拿服务端路径 → 同一端点展示。
- 实测：curl 8 项（401/内联/类型/206 Range/attachment/404/400/Content-Length）+
  浏览器渲染确认 + CSP sandbox 隔离验证（页面上下文脚本无法执行）。
  注：ZCode IAB 自动化环境拦截 window.open（真实浏览器的双击手势内不拦）。

### 文件对话框与上传（web 模式补全）

- `src/lib/fileDialog.ts`：dialogOpen/dialogSave/dialogConfirm——桌面走 plugin-dialog
  原样透传；浏览器退化为输入框（手填**服务端机器**上的路径）/ window.confirm。
  覆盖：主题包安装与导出、解压「选择目标目录」、SFTP 密钥文件选择、服务器清单
  导入导出、设置里的远程临时目录选择。快捷工具/自定义打开方式保持原生对话框
  （属服务端执行族，web 默认禁用，后续 --allow-exec 统一处理）。
- `POST /api/upload?dir=`（multipart）：浏览器拖入本机文件 → 上传到指定目录。
  文件名末段安全化 + 重名自动 `(n)`（与桌面复制语义一致）；read_only 服务端拒绝；
  单请求 1GiB 上限（v1 整文件缓冲，LAN 场景足够）。前端 web 模式 window 级
  dragover/drop preventDefault（防浏览器整页打开被拖文件）+ 上传到活动窗格目录 +
  refreshPane。SFTP 窗格需「落临时目录 → sftp_upload」两段式，v1 暂提示不支持。

### 待实施阶段

1. **拖拽上传到 SFTP 窗格**（两段式：/api/upload 落服务端临时目录 → sftp_upload → 清理）。
2. **安全加固**：`READ_ONLY`/`WEB_UNSUPPORTED`/`ARG_*` 错误码入语言包；令牌失效重登
   引导页；`--allow-exec`/`--allow-share` 显式开关落地。
3. **CI**：web feature 构建矩阵 + `rdir-web` 独立产物（GUI/绿色版/web 三形态）。

### 已桥接命令（web/bridge.rs，共 77 个）

- 读类：浏览（list_dir/resolve/complete/stat/parent/volumes/quick/stat_entry，
  list_dir 与 stat_path 走 `list_side`/`stat_path_core` **全后端路由**：
  smb/sftp/nfs/http/local）、持久化（session/favorites/prefs/icon-positions）、
  主题管理（themes_list/install/delete/save/export）、插件开关
  （list_plugins/set_plugin_enabled，与 GUI 共用 plugins.json，启动时 `init_in` 载入）、
  thumb_get/preview_data/probe_local_file、compute_size/cancel_size、fs_watch_set、
  file_fingerprints、remote_temp_info/clear
- SFTP（18）：服务器管理（list/save/remove/group + master-key 三件套 + export/import，
  servers.json 与 GUI 同一份）、连接（connect/disconnect）、传输（download/download_to/
  upload）、远端写（mkdir/create_file/delete/rename）
- 比对 / 文本：diff_dirs/cancel_diff（层级按后端能力钳制）、diff_text_files/
  read_text_file/write_text_file（SFTP 侧自动落临时目录）
- 搜索：search_content/find_files；HTTP autoindex：http_download_to/cancel_http_download
- 写类（`--read-only` 服务端拒绝，READ_ONLY 码）：copy/move（+plan 变体与
  scan_conflicts/scan_dir_duplicates）、rename/create_dir/create_file、
  delete/permanent_delete/restore_from_trash、cancel_transfer、
  compress_items/extract_archive（NEED_PASSWORD 契约透传）、sftp_download_to/
  sftp_upload/sftp_mkdir/sftp_create_file/sftp_delete/sftp_rename/write_text_file、
  http_download_to、sftp_export_servers/theme_export（写用户指定路径）
- 进度/收尾帧与取消旗标同构：前端进度条、取消按钮、撤销（还原）经 WS 原样工作

**共享核心原则**：凡有内联业务逻辑的命令（SFTP 服务器管理合并/解密、diff 能力钳制、
文本家族、插件/主题持久化）都在 lib.rs/模块抽成 `*_core(&AppState, 路径/sink, …)`，
tauri 命令与 web 桥调**同一份实现**——零复制、零漂移。

**刻意不桥（41 个，均有明确理由）**：
- NFS 12 个：按产品决策不接（未初始化即调用也得到未安装错误）
- 服务端执行族 16 个：open_local_file/open_with/open_terminal/open_vscode/
  open_git_tool/open_quick_tool/run_command/complete_commands、打开方式管理
  （list_openers/自定义 opener/扩展名设置）、快捷工具条 5 个、detect_editors/
  vscode_detected/list_shells/list_git_tools——检测与执行的都是**服务端机器上的
  程序**，web 远端使用无意义且扩大安全面；默认禁用，将来统一归 `--allow-exec`
- 桌面专属 9 个：clipboard 三件套（前端已 catch → 回退应用内剪贴板，复制粘贴不受
  影响）、drag_out_files/query_modifiers（探针被拒恰好让前端走浏览器拖拽路径）、
  allow_exit（web 无退出语义）、share 四件套（会在服务器额外开 0.0.0.0 监听，
  web 默认 127.0.0.1 场景下等于让远程会话扩大暴露面——将来需显式 `--allow-share`）

### 测试约定（与 ipc.ts 配套）

- `src/test/setup.ts` **不**预置 `__TAURI_INTERNALS__` stub——该键是桌面专属 API
  （WindowControls 等）的能力探测信号，全局 stub 会误触发真实 Tauri 调用路径。
- 涉及 `listen` 的组件测试直接 `vi.mock("@/lib/ipc")`（三个对话框测试已改造）；
  `ipc.test.ts` 自管探测键（beforeEach 置位 / goWeb() 删除）模拟两种环境。
