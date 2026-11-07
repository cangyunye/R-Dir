# 交接文档：web 服务（rdir-web）——SFTP 上传与回归测试

> 交接基线：分支 `feat/portable-and-web-foundation` @ `ec411f0`（2026-11-07）。
> 前一阶段在 macOS 上完成 web 模式主体并用内置浏览器 + curl 做了验证；
> **SFTP 窗格拖拽上传**留给具备实操环境的 Windows 平台处理（见 §3，方案已给全）。
> 通读本文即可接手，无需回溯对话历史。姊妹文档：`docs/portable-and-web.md`（架构决策总账）。

## 1. 分支现状

### 1.1 提交清单（自 main 分叉起）

| 提交 | 内容 |
|---|---|
| `32abe5d` | 便携模式数据目录收敛（`paths.rs`）+ 前端 IPC 双传输适配层（`ipc.ts`） |
| `9c39749` | EventSink 事件出口抽象——模块层与 AppHandle 解耦 |
| `974d2bc` | `rdir-web` 无窗口 web 服务（invoke 透传 + WS 事件 + rust-embed 内嵌前端） |
| `cf0f70d` | `pnpm web` 一键启动脚本 |
| `242c3d8` | 修复浏览器白屏（`getCurrentWindow()` 同步抛错崩树） |
| `04e4081` | 桥表第二批：写类命令 + `--read-only` 服务端拦截 |
| `9f18342` | 桥表第三批：SFTP 全量 + 目录/文本比对 + 搜索/主题/插件开关（共享 core 重构） |
| `7c2ec86` | `/api/file` 文件流端点（Range + CSP sandbox）——双击打开链路 |
| `fe1ad18` | 文件对话框兜底（`fileDialog.ts`）+ 本机拖拽上传（`/api/upload`） |
| `ec411f0` | 猫头鹰 favicon 替换 Vite 默认 |

测试基线：`pnpm test` 744 / `cargo test` 234 / `cargo test --features web` 245，全绿。

### 1.2 环境与命令速查

```bash
pnpm web                  # 一键：构建前端 + cargo run --features web --bin rdir-web（默认 127.0.0.1:8420）
pnpm build                # 仅前端（tsc + vite build → dist/；rust-embed debug 模式运行时读盘，改前端免重启）
cd src-tauri && cargo build --features web --bin rdir-web   # 仅后端（改 Rust 后需重启服务）
```

- 前端测试 `pnpm test`（vitest）；Rust `cargo test`（默认 features = GUI 发行口径）与
  `cargo test --features web`（含 web/events 测试）都要跑。
- `rdir-web` 是 console 子系统二进制（无 `windows_subsystem` 声明，**故意**保留控制台
  输出启动 banner），不依赖 WebView2，可跑在无桌面环境。
- CLI：`--listen`（默认 127.0.0.1:8420）、`--token`（默认随机 32 hex）、
  `--data-dir`、`--read-only`。
- 数据目录三级解析：`--data-dir` > 便携标记（exe 旁 `R-Dir.portable` → `data/{config,data}`）
  > 用户配置目录（与 GUI 安装版同落点，Windows `%APPDATA%\com.rfm.app`）。
  GUI 与 web 可同时运行并共享同一份配置/主题/插件/SFTP 清单。

### 1.3 架构地图（改哪里前先看这）

```
src/lib/ipc.ts            前端唯一传输层：invoke/listen 双分支（isTauri() 探测）
src/lib/fileDialog.ts     文件对话框适配：桌面 plugin-dialog / 浏览器输入框兜底
src-tauri/src/paths.rs    数据目录收敛 + 便携标记（R-Dir.portable，只认 exe 直接父目录）
src-tauri/src/events.rs   EventSink（Emitter trait）；WebEmitter = broadcast → WS 帧
src-tauri/src/web/mod.rs  路由：/api/invoke /api/events(WS) /api/file /api/upload /login /*（静态）
src-tauri/src/web/bridge.rs  web_commands! 声明式分发表（77 命令）+ WRITE_COMMANDS 只读门禁
src-tauri/src/bin/rdir-web.rs  CLI + 数据目录解析
lib.rs 的 *_core()        共享核心：GUI 命令与 web 桥调同一份实现（零复制零漂移）——
                          新增桥接命令时优先抽 core，禁止把业务逻辑复制进 bridge.rs
```

- 鉴权：token 经 `/login?k=` 换 HttpOnly cookie（30 天）；fetch/WS 自动携带；
  `?k=` 查询串兜底（WS 直连用）。未授权 → 401 JSON（API）或引导页（页面）。
- 只读口径：**修改被浏览的文件系统 = 写**（`WRITE_COMMANDS` + upload handler 双闸）；
  缓存性写入不算（缩略图、`sftp_download` 落临时目录供预览）。
- 事件：`fs://changed` / `volumes://changed` / `share://changed` /
  `transfer-progress` / `size-progress` / `diff-progress` 六类经 WebEmitter 广播；
  `app-exit-requested` 纯桌面概念不走抽象。
- **刻意不桥（41 个，勿"顺手补全"）**：NFS 12（产品决策）；服务端执行族 16
  （open_terminal/open_with/open_local_file 桌面分支/run_command/快捷工具/
  打开方式管理/detect_editors 等——远端执行无意义，将来统一归 `--allow-exec`）；
  桌面专属 9（剪贴板三件套已有应用内回退、drag_out、allow_exit、share 四件套
  ——会在服务器额外开 0.0.0.0 监听，将来 `--allow-share`）。

## 2. 已验证 / 未验证（诚实边界）

### 已实测通过（macOS，勿重复劳动）
- 登录/令牌/401；静态资源；favicon（应用页 + 401 页）。
- 桥命令 77 个中 60+ 的 curl 级验证：浏览/持久化/主题/插件/比对/文本/搜索/指纹。
- 写链路（自有实例 + /tmp 隔离）：create_dir → copy（递归）→ rename →
  scan_conflicts → delete → compress；`--read-only` 实例写命令全拒。
- 目录 diff（different/left-only/right-only）、文本 diff（segments 逐段），
  write_text→read_text 字节级往返（od 核验）、MD5 与系统工具一致。
- 事件链路：fs_watch_set → 改目录 → WS 收到 `fs://changed` 帧。
- 浏览器端到端（ZCode IAB）：白屏修复后完整 UI 渲染、`/api/file` 渲染内容、
  CSP sandbox 隔离实证（页面上下文 evaluate 无法执行）。
- 上传（curl）：单文件落盘、多文件重名 `(2)(3)`、只读 READ_ONLY、401、dir 非法 400。

### 未实测（macOS 环境所限，Windows 交接后必做）
- **带真实认证的 SFTP 会话**：连接→浏览→下载→上传→远端写→断开重连全环
  （管理链路与错误路径已验：save/group/connect 拒绝/`sftp://` 路由未连接报错）。
- master-key 加密保存 → 重启解锁 → 导出/导入环。
- Windows 便携模式（exe 旁标记）实机行为；WebView2 环境差异。
- 真实浏览器（Chrome/Edge）的拖拽上传手势与 favicon 缓存表现
  （ZCode IAB 拦截 window.open，双击弹新标签无法在该环境演示——真实浏览器
  手势内不拦，已用当前标签导航单独验证端点）。

### 2.1 Windows 实测结果（2026-11-07，headless Chromium + Playwright + 真实 SSH 服务器）

测试机器：WSL Ubuntu2604（kube@172.20.214.44:2222，密钥认证）+ 树莓派 kali
（192.168.31.100，密码认证）。脚本四件入库 `e2e-shots/`：`web-sftp-upload.mjs`（待办 A
验收）、`web-sftp-loop.mjs`（37 项）、`web-masterkey.mjs`（B20 两阶段）、
`web-cli-regression.mjs`（12 项）、`web-ui-local.mjs`（13 项）。

- **待办 A 完成**：SFTP 窗格拖拽上传两段式落地（commit `39a9129`）。验收全过：
  3 文件（中文名×2+ascii）拖拽上传远端 md5 一致、服务端临时目录零残留、重名覆盖
  （与桌面同语义）、断网拖拽明确报错页面不崩、清理无残留。实现中修了一个真 bug：
  临时目录在首次远程打开前不存在 → /api/upload 400（NOT_DIR），上传前 create_dir
  兜底（dts feat-web_sftp-upload-temp-dir-400）。
- **B 全表**：B1–B5（鉴权/CLI，B4 用随机 token 实例验证 401）✓；
  B6–B13（UI 环：导航/标签/右键建改名删撤销/冲突弹窗/压缩 tar/拖入本地 (2) 后缀/
  双击 /api-file/CSP 沙箱 fetch 被拒/搜索指纹 MD5）13 项 ✓；B14–B17 ✓；B19 ✓；
  B20 master-key 全环（设置→密文落盘→重启→未解锁拒连 NEED_MASTER_KEY→解锁重连）✓；
  B21 导出导入 ✓；B22 地址栏直连 ✓（弹连接对话框=预期流程）；B23 目录比对 ✓；
  B24 文本比对+回写往返 ✓；B25 GBK 编码比对 ✓；B28 只读实例 ✓（浏览/下载照常、
  写命令与上传全拒、banner 标注只读）；B29 便携标记 ✓（数据落 exe 旁 data/）；
  B32 0.0.0.0 banner 安全提示 ✓。**未跑：B26**（需同时构建 GUI 版做配置共享竞态，
  已知竞态为接受项）；B30/B31 降级路径由 WEB_UNSUPPORTED 报错覆盖（拖出/分享/
  终端在 UI 实测中按设计报错，浏览器内行为符合预期）。
- **Windows 基线修复**（commit `ff15e37`）：cargo test --features web 首跑 2 failed
  ——nfs_plugin 夹具三元组写死 + smb 活体测试跳过门不认新错误文案，均为测试
  可移植性问题；修后 241 passed / 0 failed / 8 ignored；vitest 744 / tsc 0 错。
- **顺手修的产品级问题**（commit `fad18ca`）：sftp_save_server 传自定义 id 时盲追加
  重复条目 + disconnect 按非池键 id 静默空操作——id 契约归一为 user@host:port，
  disconnect 抽 core 带存盘清单回退（dts feat-web_sftp-server-id-not-normalized）。
- **i18n（待办 C.1 完成）**：L10n 仓库 main 新增 web 批次词条（+2 strings ×6 包、
  +10 errors ×6 包、CANONICAL_CODES 补 WEB_OFFLINE/WEB_BAD_RESPONSE，check 六包
  899 strings / 17 errors 全绿，commit c0efb1f）。**注意：L10n main 领先 origin 2 个
  提交未推送、未打 tag——主仓库依赖仍锁 #v0.4.2，非中文界面在本批次词条上会回退
  中文详情，推 tag + bump 后消除**（zh 界面不受影响，terr 剥前缀显示详情）。
- 测试环境坑（供后人）：WSL2 发行版空闲自停，TCP SYN 唤不醒，须 wsl.exe 调用
  或常驻会话钉住；node v24 Windows 同进程多次 fs.rmSync 硬崩（exit 127 零输出，
  libuv UV_HANDLE_CLOSING 断言），测试脚本一律 execSync rm（dts
  infra-build_node-rmsync-uv-assert-crash）。

## 3. ✅ 待办 A（2026-11-07 已完成）：SFTP 窗格拖拽上传

现状：`App.tsx` 的 web 拖放 effect（`refreshPanes` 定义之后，搜「web 模式外部文件拖入」）
对 `sftp://` 活动窗格只弹「暂不支持」。方案已设计好，**零新增后端命令**，全部用已桥接命令拼装：

### 3.1 实现方案（两段式）

```
用户拖文件到 SFTP 活动窗格
① 取服务端临时目录：invoke("remote_temp_info", { localDir: loadRemoteTempDir() || null }) → data.path
   （persist.ts 的 loadRemoteTempDir 与桌面「打开」链路同一配置源）
② 上传到临时目录：fetch(`/api/upload?dir=${encodeURIComponent(tempDir)}`, FormData) → 返回落盘路径数组
③ 转传远程：逐个 invoke("sftp_upload", { local: <落盘路径>, dest: <窗格远程目录>, name: <文件名> })
   （pool 是 Mutex，顺序执行即可；与桌面拖拽上传同一命令）
④ 清理临时文件：invoke("permanent_delete_entries", { paths: [<落盘路径>] })
   （已桥接的本地删除命令，无需新端点；务必 try/finally——sftp_upload 失败也要清理）
⑤ refreshPane(pane.id)
```

### 3.2 实现要点 / 坑位

- 改的就是现有 drop handler 里的 sftp 分支（`dir.startsWith("sftp://")` 那个
  `showError` 早退），不要另起第二个监听器。
- `sftp_upload` 的重名语义需先核实（看 `src/hooks/useSftp.ts` 桌面拖拽上传怎么处理
  ——桌面直接调同一命令，保持一致即可；若远端重名报错，考虑对齐桌面行为）。
- 上传中无进度条（v1 全链路无进度事件）：LAN 可接受；如要做，方向是
  `/api/upload` 逐字段完成后经 `ctx.sink` 发 `transfer-progress` 帧（done=false/true），
  前端进度面板零改动即可显示——顺手但非必须。
- `remote_temp_info` 返回的临时目录在服务端重启间共享；临时文件名已有
  末段安全化 + 重名 `(n)`（`web/mod.rs::sanitize_upload_name / unique_upload_target`，
  含单测），勿重复实现。
- read_only 模式：`/api/upload` 已被服务端拒绝，前端提示会自然出现，无需特判。
- **验收标准**：Windows 实机（Edge/Chrome）拖 3 个文件（含中文名、含重名）到
  SFTP 窗格 → 全部出现在远程目录、服务端临时目录无残留、窗格自动刷新、
  断网中途拖拽有明确错误提示不崩页。

### 3.3 Windows 上的 SFTP 测试环境搭法（如果没有现成 SSH 服务）

```powershell
# 管理员 PowerShell：装 OpenSSH Server（Win10 1809+/Win11 内置可选功能）
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd; Set-Service sshd -StartupType Automatic
# 本机连自己：sftp://<用户名>@127.0.0.1:22（密码 = Windows 登录密码；
# 公钥认证走 C:\Users\<user>\.ssh\authorized_keys，web 模式选密钥文件用输入框填服务端路径）
```

## 4. 待办 B：回归测试计划（Windows 交接后跑一遍）

约定：`pnpm web` 起服务（或 `--listen 0.0.0.0` 供第二台设备访问）；浏览器双开
（两个窗口同时登录）验证事件广播。以下每项给出操作与预期。

### 4.1 服务与鉴权
| # | 操作 | 预期 |
|---|---|---|
| B1 | 无令牌访问 `/` | 引导页（含猫头鹰 favicon） |
| B2 | `/login?k=<错误令牌>` | 同上引导页 |
| B3 | 正确 `/login?k=` | 303 → Set-Cookie → 进入完整 UI |
| B4 | 服务重启后旧 cookie | 401 → 引导页（token 重生成） |
| B5 | `--help` / `--listen 非法值` | 帮助文本 / 报错退出码 2 |

### 4.2 本地文件管理（核心环）
| # | 操作 | 预期 |
|---|---|---|
| B6 | 浏览/导航/面包屑/前进后退/多标签/分屏 | 全可用；标签跨会话恢复（session.json） |
| B7 | 新建目录/文件 → 改名 → 复制（跨窗格）→ 移动 → 删除 → 撤销 | 每步有进度帧；删除可还原；两窗口实时刷新 |
| B8 | 冲突复制（同名文件） | 冲突裁决弹窗出现，各选项生效 |
| B9 | 压缩 zip/tar/tgz → 解压（smart/folder/选目录） | 产物正确；密码 zip 触发密码框 |
| B10 | 从资源管理器拖 3 文件进窗口（含中文名、重名） | 落到活动窗格；重名 `(n)`；无残留 |
| B11 | 双击 txt/png/pdf/mp4 | 新标签内联展示；mp4 可拖进度（Range）；二进制落下载 |
| B12 | 双击不可信 .html | 内容展示但 **F12 里 fetch('/api/invoke') 必须失败**（CSP sandbox opaque origin） |
| B13 | 内容搜索/文件检索/属性统计/MD5 指纹 | 结果与桌面版一致 |

### 4.3 SFTP 全环（本次交接重点）
| # | 操作 | 预期 |
|---|---|---|
| B14 | 新增服务器（记住密码）→ 连接 → 浏览 | 连接成功；侧边栏出现连接项 |
| B15 | 远端 mkdir/新建文件/改名/删除 | 即时生效；`sftp://` 路径浏览正常 |
| B16 | 远程文件双击打开 | 下载到服务端临时目录 → `/api/file` 展示 |
| B17 | 远程→本地 拖拽/复制（sftp_download_to） | 落到本地窗格目录 |
| B18 | **本地→远程 拖拽上传（待办 A 新功能）** | 按 §3.2 验收标准 |
| B19 | 断开 → 一键重连（密码留空回退存盘配置） | 重连成功 |
| B20 | master-key：设置 → 重启服务 → 解锁 | 明文升级密文；重启后需解锁才能连「记住密码」的服务器 |
| B21 | 导出清单（输入框填服务端路径）→ 删除服务器 → 导入 | 导入合并按 id 去重；含密文时需主密码 |
| B22 | 地址栏 `sftp://user@host` 直连 | 触发连接流程 |

### 4.4 比对 / 文本
| # | 操作 | 预期 |
|---|---|---|
| B23 | 目录比对 local×local、local×SFTP（level 2/3） | 远端侧能力钳制 ≤2（无 hash）；进度帧可取消 |
| B24 | 文本比较 local×SFTP，编辑右侧保存 | SFTP 侧经临时文件回传；重新打开内容已更新 |
| B25 | GBK/Big5 编码文件比较 | 编码下拉生效 |

### 4.5 配置同步 / 降级 / 安全
| # | 操作 | 预期 |
|---|---|---|
| B26 | 桌面版与 web 同时运行：web 改主题/开关插件 → 桌面重启 | 共享同一份配置；**注意已知竞态**（§5） |
| B27 | 主题包安装/导出（输入框填路径）、调色盘保存 | 输入框兜底可用 |
| B28 | `--read-only` 起服务 | 写命令/上传全 `READ_ONLY|`；浏览/预览/双击打开/`sftp_download` 照常 |
| B29 | 便携：`R-Dir.exe` 与 `R-Dir.portable` 同目录（连 `rdir-web.exe` 也放同目录） | 两者数据都落 `data/{config,data}` 且互相共享 |
| B30 | 剪贴板跨应用复制粘贴 | 应用内回退可用（系统剪贴板文件格式是桌面专属） |
| B31 | 拖出到资源管理器 / 右键打开方式执行 | 不可用（设计如此）；错误提示明确 |
| B32 | 外网暴露场景 | 文档要求套反代（无内置 TLS）——检查 0.0.0.0 监听时 banner 有提示 |

### 4.6 已知自动化环境限制（别当 bug）
- ZCode IAB 拦截 `window.open`：双击弹新标签、openExternal 在该环境无法演示；
  真实浏览器不受影响。
- favicon 缓存顽固：改图标后需强刷。

## 5. 待办 C：其余工程项（非 SFTP，按优先级）

1. **错误码入语言包**（i18n 硬规则，见根 AGENTS.md §国际化）：新增 key
   `READ_ONLY` / `WEB_UNSUPPORTED` / `WEB_OFFLINE` / `WEB_BAD_RESPONSE` /
   `ARG_MISSING` / `ARG_TYPE` / `UNAUTHORIZED` / `NOT_FOUND` / `NOT_DIR` /
   `UPLOAD_FAILED` / `READ_FAILED`，以及新 UI 文案
   「web 模式暂只支持拖拽上传到本地窗格」「上传失败：{msg}」。
   在 [R-Dir-L10n](https://github.com/cangyunye/R-Dir-L10n) 仓库跑 check-coverage
   （key × 六包 + 占位符一致性硬校验）；zh 无需包（terr() 未知码剥前缀显示详情，
   中文用户现状已可读，但这批码应正式入库）。
2. **CI 三形态产物**：`release.yml` 增 web 构建 job（Windows runner：
   `pnpm build && cargo build --release --features web --bin rdir-web`，注意
   rust-embed 编译期内嵌 dist 的先后依赖），产物 `rdir-web_<ver>_windows_x64.zip`
   + 使用说明（对齐 `tools/portable-README.txt` 风格）；publish 资产门禁
   （现有六资产 + web 包）同步扩。
3. **上传流式化**（可选）：`/api/upload` v1 整文件缓冲（1GiB 上限），超大文件
   改逐块写盘（axum multipart field 是 AsyncRead，可直接流到 File）。
4. **`--allow-exec` / `--allow-share` 显式开关**（可选）：按 §1.3 的留口把执行族
   /share 四件套挂到开关后面；share 桥接时注意 share_create 用的 `lan_ip()` 广播
   与 web 场景的语义差异。
5. **`/api/caps` 能力位**（可选）：`bridge::COMMANDS` + `WRITE_COMMANDS` 已就绪，
   前端按位隐藏不可用入口（当前是「点了报错」的降级形态）。
6. **拖放按窗格命中**（可选）：web v1 上传只落**活动**窗格；桌面是按坐标命中
   窗格（Tauri 事件）。可在浏览器分支加每窗格 HTML5 drop zone 对齐体验。

## 6. 已知限制与设计决策备忘（防"修复"已有决策）

- **配置共享竞态**：GUI 与 web 同时运行共享 config 目录，json_store 原子写是
  rename 语义，并发写同一文件 = last-write-wins（session.json 双端自动保存可能
  互相覆盖）。当前接受；若要解决，方向是 web 端会话保存加节流或文件锁。
- `window.open`（双击打开）**不加** `noopener` 以外的方式回退同页导航——离开
  应用的体验不可接受。
- `/api/file` 的 `CSP: sandbox` 是安全底线，**不可移除**（否则下载的 HTML 能以
  应用身份调 /api/invoke 读全盘）。
- 临时文件清理依赖调用方（`permanent_delete_entries`）；`remote_temp_clear`
  清整个目录，勿在会话中途调用。
- 我方测试遗留：无（临时实例/目录均已清理）。仓库根目录的 `猫头鹰图标.png`
  是用户放置的源素材，**未入库**，favicon 派生源在 `public/favicon.png`。
