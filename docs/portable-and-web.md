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
pnpm build                       # 先产出 dist/（rust-embed 编译期内嵌）
cargo build --release --features web --bin rdir-web
./target/release/rdir-web --listen 127.0.0.1:8420
# → 打印带令牌进站链接：http://127.0.0.1:8420/login?k=<32位hex>
```

- 数据目录：`--data-dir` > 便携标记（exe 旁 `R-Dir.portable`）> 用户配置目录（与 GUI 同落点）
- 与 GUI 版共用同一套配置（session/prefs/favorites/themes/plugins），可互启
- 默认监听 127.0.0.1；`--listen 0.0.0.0` 显式开放局域网；无内置 TLS，外网暴露需反代
- 事件链路已验证：fs_watch 线程 → WebEmitter broadcast → WS → 前端 `fs://changed` 刷新

### 待实施阶段

1. **桥表扩容**：写类命令（复制/移动/改名/删除/压缩/解压/搜索/find/diff）接入
   `--read-only` 服务端拦截；SFTP/NFS 后端路由（sftp:// 路径走既有模块，零 AppHandle 已就绪）。
2. **能力降级**：`/api/caps` 能力位（含 `bridge::COMMANDS`）；OLE 拖出/系统剪贴板文件/回收站禁用，
   原生对话框换浏览器实现，终端/`open_local_file`/`open_with` 默认禁用
   （`--allow-exec` 显式开启，服务端执行对外网暴露有风险）。
3. **安全加固**：写类命令服务端白名单拦截（比 UI 隐藏更可靠）；`--read-only` 接入已有开关。
4. **CI**：web feature 构建矩阵 + `rdir-web` 独立产物（GUI/绿色版/web 三形态）。

### 测试约定（与 ipc.ts 配套）

- `src/test/setup.ts` **不**预置 `__TAURI_INTERNALS__` stub——该键是桌面专属 API
  （WindowControls 等）的能力探测信号，全局 stub 会误触发真实 Tauri 调用路径。
- 涉及 `listen` 的组件测试直接 `vi.mock("@/lib/ipc")`（三个对话框测试已改造）；
  `ipc.test.ts` 自管探测键（beforeEach 置位 / goWeb() 删除）模拟两种环境。
