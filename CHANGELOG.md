# 更新日志

本文件按版本记录变更。发布时 `release.yml` 的 publish 步骤会自动把对应段落写入
GitHub Release 说明（release notes），因此每次发版前请先在这里补一段。

格式：`## vX.Y.Z (YYYY-MM-DD)`，段落之间用下一个 `## ` 标题分隔。

## v0.23.0 (2026-10-08)

- **SFTP 递归传输（文件夹拖拽/粘贴上传与下载）**：此前 SFTP 上传/下载是纯单文件实现（`session::upload` 循环读本地文件 / `session::download` 循环写本地文件，`mod` 路由层不判类型），拖拽或粘贴一个文件夹会直接报错（上传「读取本地失败：Is a directory」、下载被服务器拒绝打开目录）。现 `sftp::upload_path` / `sftp::download_to` 自动识别目录：上传远程逐级 mkdir（已存在并入，空目录同样创建）、本地逐级遍历（`metadata` 跟随软链，软链文件按文件传）；下载本地逐级 `create_dir_all`、远程逐级 `list_dir`、**逐段名称 sanitize**（远端名可能含 Windows 保留字符）；顶层同名沿用既有语义——粘贴自动加 " (n)" 后缀、拖拽先经覆盖确认（v0.22.0/v0.22.2 流程不变），目录在覆盖确认后并入已存在目标。前端粘贴/拖拽调用点零改动（后端透明递归）。
  - **两阶段进度**：先遍历统计文件数与总字节（上传为本地快扫 `upload_plan`；下载为远程树遍历 `download_plan`，期间响应取消旗标），再按总文件数上报 `doneFiles/totalFiles` + 当前文件字节进度，状态栏显示「上传中：sub/dir/file.txt 3/17」。
  - **接入传输取消**：SFTP 上传/下载注册 `transfer_cancels`，id 带 `sftp:` 前缀（前端取消路由据此判别——无前缀的 download 仍是 HTTP 断点续传取消，不再误路由）；`session` 层 download/upload 字节回调支持中止（返回 false 即关句柄并删除本地/远端半成品文件）；状态栏「上传」阶段新增停止按钮（compress 无 id 不受影响）。
  - 测试：Rust +3（`upload_plan` 单文件 / 嵌套树含空目录计数 / 缺失路径报错）；e2e R18 拖拽上传既有用例回归通过。
- **修复：右上角 ⋮ 菜单「新建标签页」无效**。Radix `DropdownMenuItem` 的 `onClick` 会把 MouseEvent 作为首参透传，而 AppMenu 对「新建标签页」直传了可选参函数 `onNewTab={newTab}`（`newTab(path?: string)`），事件对象被误当 path → `target.match(VIRTUAL_TAG_RE)` 抛 TypeError → `setTabs` 未执行，表现为菜单正常关闭但什么都没发生。其余菜单项全是零参函数或箭头包装所以无感，快捷键与命令面板走 `() => newTab()` 分发表也正常——只有菜单直传中招。现 `Item` 包装组件统一以零参调用回调（`onClick={() => onClick()}`，与组件契约 `onClick: () => void` 一致，根治所有现在与将来的菜单项参数泄漏），App 调用点同步改 `() => newTab()` 双保险。单测 +3（新建标签页/退出/开关项均断言零参触发）；e2e T2（⋮ → 新建标签页 → 标签数 +1）。
- **修复：退出不再静默，统一弹「保存会话布局？」确认**。此前三条退出路径里只有窗口 X 有确认（v0.3.0 `onCloseRequested`）：⋮ 菜单与命令面板的「退出」直调保存 + `exit(0)` 跳过询问；**macOS ⌘Q / Dock「退出」更完全绕过会话保存**——应用级退出不触发窗口级 `onCloseRequested`，Rust 侧只处理了 `RunEvent::Exit`（停分享），布局变更直接丢失。现全部汇入同一对话框：菜单/面板「退出」改为打开确认对话框（与 X 一致的三选项）；Rust 侧拦截 `RunEvent::ExitRequested`（仍有窗口可承载对话框时 `prevent_exit()` + emit `app-exit-requested`），前端监听后弹同一对话框，确认后经新增 `allow_exit` 命令置位守卫再 `exit(0)` 放行（防止 prevent 与 exit 相互死锁）；最后一扇窗真正关闭（code 无窗口场景）不拦。e2e T3（⋮ → 退出 → 确认框出现 → 取消后应用保持运行）。
- **标签栏右键菜单完善（空白处 + 单标签）**：此前只有单个标签右键菜单（关闭 / 重命名 / 移到最右），标签栏**空白处右键直接弹 WebView 系统菜单**（「重新载入 / 检查元素」）。现空白处右键接管为全局标签菜单——`新建标签页` / `恢复关闭的标签页`（无历史时置灰，`canReopen` 由关闭栈实时判定）/ `全部标签页…`（复用右上角下拉），并 `preventDefault` 屏蔽默认菜单；单个标签菜单补充「关闭其他标签页」「关闭右侧标签页」。空白菜单按光标定位，并以容器 `rect / offsetWidth` 比值把 zoom 后的视觉坐标换算回布局坐标（沿用 `--rdir-zoom` 方案），菜单仍走容器内绝对定位（非 portal）；`closest` 守卫保证只在真正空白处接管，标签/按钮/弹层内右键各自处理。`App` 新增 `closeOtherTabs` / `closeTabsToRight`：批量关闭同样把标签压入「恢复关闭的标签」栈（保留 20 条）并停止由此产生的目录分享，右侧批量关闭时活动标签若落在被关区间回落到源标签；关闭栈副作用改在事件阶段读 `tabsRef` 执行，避免 `StrictMode` 双调用重复入栈。TabBar +9 单测；e2e R20–R22（空白菜单三项与新建生效 / 关闭右侧 / 关闭后从空白菜单恢复）。
- 测试：Rust 107 通过（+3）；前端 355 通过（28 文件，+12：AppMenu 菜单项零参回归 +3、TabBar 标签/空白右键菜单 +9）；e2e 74 通过（新增 T2/T3 + R20–R22：标签栏右键菜单）。版本号 package.json / tauri.conf.json / Cargo.toml(+lock) 同步 0.22.0 → 0.23.0。

## v0.22.0 (2026-10-08)

- **地址栏命令执行（路径优先、命令兜底，既有路径行为零变化）**：路径栏升级为「路径 + 命令」双用途输入框。
  - **PATH 可执行扫描与补全**：后端新增 `cmdrun` 模块——扫描进程 PATH ∪（macOS）`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`、`~/.local/bin`、`~/bin` 兜底目录（Finder/启动台启动的 GUI 应用拿到的 launchd PATH 常缺家酿目录）；unix 校验任一执行位（`fs::metadata` 跟随软链）、Windows 按 PATHEXT 扩展表匹配；同名命令按 PATH 顺序先到先得（与 shell 一致）。扫描结果进程内缓存（PATH 签名变化或 10 分钟 TTL 自动重建），补全大小写不敏感前缀匹配、上限 20 条。
  - **混合下拉**：输入无分隔符的单个裸词（如 `git`）时，目录补全下方追加「命令」分组（终端图标 + 命令名 + 右侧暗色可执行路径，`data-cmd-suggest` / `data-dir-suggest` 可测），键盘 ↑↓ 跨组平铺遍历；`Tab` 补全命令名 + 尾随空格（便于补参数，不执行）；`Enter` / 点击命令项立即执行。多词输入不再弹命令组（参数交给 shell）。
  - **回车解析顺序（路径永远优先，带空格的路径不受影响）**：scheme 前缀走导航 → 整串按路径校验（文件跳父选中 / 目录导航）→ 不是路径且首 token 是裸词时按 PATH 命令兜底：**新开终端窗口、cd 到当前窗格目录、执行整条命令串**（mac 经 AppleScript 在 Terminal 执行——命令串是用户输入给 shell 的原样内容，仅做 AppleScript 字符串层转义，授权失败 -1743 人话化提示复用打开终端的文案；win 走 `powershell -NoExit -Command`，工作目录由 OS 设置零转义）。**执行后 Terminal 前台化**：`do script` 只开窗不激活应用，Terminal 已在程序坞时新窗会藏在当前应用后面需手动点击——脚本末尾追加 `activate` 调到前台（右键终端 zsh/nu 分支同样的隐患一并修复；`open -a` 路径本就激活不受影响）。执行前先在 PATH 校验首 token，未命中不开报错终端就地提示；两者都不是时红字合并为「路径不存在，也不是 PATH 中的命令：xxx」。SFTP / HTTP / 标签窗格不启用命令兜底。
  - **插件开关与细节**：内置插件「地址栏命令」（id `cmdrun`，默认启用，设置 → 插件可停用，停用时补全返回空、执行报错）；输入框内刷新按钮在输入为「含空格裸词命令行」时回落为普通刷新（不再误当路径导航）。前端命令判定收敛在纯函数 `src/lib/cmdline.ts`（scheme / 单裸词 / 首 token 三判定）。
- **修复：macOS 只读卷「移入废纸篓」报错误导**：外置克隆系统盘（APFS 卷组：sealed 系统卷 + 数据卷 firmlink）的系统卷只读挂载、卷上无 `.Trashes`，`trash` crate 在 macOS 经 AppleScript 让访达移动，必报 -5000「没有必要的权限」——该报错不含「拒绝访问 / Permission denied / access」字样，此前落入通用分支原样透传（且既有「权限不足→以管理员身份运行」提示对只读卷无效，管理员也写不进只读卷）。现错误分类抽为 `map_trash_error` 并新增只读卷分支（匹配 osascript 报错尾缀错误码 `-5000`——与系统语言无关——及「没有必要的权限」/ `Read-only`），提示「该磁盘可能为只读……可改用永久删除，或先把文件移到可写磁盘」（永久删除走 unlink 不经访达，firmlink 数据区可正常删除）。
  - 测试：Rust 98 通过（+10：引号 tokenize / PATHEXT 匹配 / 执行位过滤 / 同名先到先得 / 前缀截断 / 未知命令拒绝 / 只读卷 -5000 错误映射（中英文）/ 既有错误分支回归）；前端 343 通过（27 文件，+5）；e2e 新增 R11–R15（命令分组与 Enter 执行记录 input+cwd / Tab 补全与点击执行 / 带参数整串传递 / 合并错误提示 / 带分隔符不弹命令组），全量 65 通过。


- **标签切换性能：零重读目录（方案A）+ 非活动标签 keep-alive（方案B），点击标签不再卡顿**。此前每次点击标签：列目录 effect 因依赖 `activeId` 而重跑——先置 `loading` 渲染一遍、发起一次完全多余的 `list_dir` IPC+磁盘 IO（即使目录刚看过）、返回后换新 `entries` 数组再全量渲染一遍；同时整个 SplitView/虚拟列表/每行右键菜单子树被卸载重建，大目录下点击顿挫明显。
  - **方案A（多余 IO 消除）**：`loadedPaneKeysRef`（`Map<paneId, "path:refreshKey">`）记住每个窗格**当前 entries 属于哪次加载**——标签/分屏间切换回来时 key 未变直接用内存 entries（零 IO、少两轮渲染）；导航离开后 entries 已被替换，回来 key 不匹配正常重读（首版用"曾加载过"的全局 Set 会把「面包屑回上一级」误判为已加载，显示成另一目录的旧列表，e2e R7 抓出后改为按 paneId 记最近一次）；`F5`/同路径回车 bump `refreshKey` 必然重读；加载失败不记录、再次激活自动重试。
  - **方案B（卸载重建消除）**：React 19 `<Activity mode="hidden">` 保留最近 `KEEP_ALIVE_MAX = 8` 个标签的窗格树（LRU，激活置顶、超限淘汰最旧——淘汰后再次激活只付一次挂载成本，仍不重读目录）；隐藏树 effects 自动暂停、滚动/选中/排序等 `useMemo` 与状态全部保留。SplitView 按 tabs.map 渲染、每标签独立 `Activity` 包裹（`canPaste`/`highlight` 改用各标签自身数据）。隐藏标签内存增量约 1–3 MB/个（虚拟滚动行数有界），对照浏览器"后台标签保留文档、跳过绘制"的同款策略。
  - e2e：mock 记录 `list_dir` 调用（`__RDIR_E2E_MOCK__.listDirCalls`），新增 R16（切标签断言调用数不增 + 隐藏树行存在且不可见）/ R17（`F5`/`⌘R` 仍重读）；既有 R7 因 keep-alive 后同名行在两个标签树各一份改为 `:visible` 限定双击目标。全量 69 e2e + 343 前端（27 文件）通过。


- **修复：SFTP 首次创建不再强制设置主密码**。此前首次连接勾选"记住密码"时后端因无 master-key 直接返回 `NEED_MASTER_KEY`，被迫先设置主密码——而此时没有任何已存记录需要解锁，没有意义。现主密码回归本位「只用于解锁既有密文」：未设置主密钥时记住的密码以明文存盘（`seal_auth_secrets` 不再阻断）；首次设置主密钥时把清单中已有明文密码/口令**回填加密**（`encrypt_all_plaintext`，之后的连接需解锁）；主密钥设置入口从"只有强制弹窗"改为 ⋮ 菜单「工具 → SFTP 主密钥…」，主密钥对话框按设置/解锁两种模式更新说明文案。Rust 新增 6 项单测（明文保留 / 加密往返 / 空密码与密文跳过 / 迁移只动明文条目）。
- **修复：本地 → SFTP 拖拽显示 🚫、松手后还要点一下才上传**。根因是行 `draggable=true` 的原生 HTML5 拖拽接管后 `mousemove/mouseup` 停发，自研鼠标拖拽收不到松手事件——拖动全程系统 🚫 光标（DOM 无 drop 处理器）、提示条滞留到松手后才出现、下一次点击的 mouseup 才误触发投放。现拖拽改由原生事件流驱动（`App` 挂 window 级 dragenter/dragover/dragleave/drop/dragend）：dragstart 写入应用内标记 `application/x-rdir-dnd` 并停掉自研拖拽；**dragover 实时驱动提示条 + `preventDefault` 让光标变 copy/move；松手（drop）即上传**；**真机补刀（第二层根因）**：Tauri `dragDropEnabled: true`（默认开启）会在原生层拦截 webview 内全部 DOM 拖拽事件——dragover/drop 根本不进入页面，自研拖拽与 window 事件流全部失效，表现为全程 🚫；e2e 的纯 Chromium 环境无法暴露此类平台行为。现窗口配置关闭 `dragDropEnabled`（应用无任何功能依赖 Tauri 原生拖拽事件，OS 拖出为浏览器源侧行为不受影响），HTML5 拖拽恢复标准行为；dragend + 最近坐标兜底保留作安全网；`dragend` 阶段 dataTransfer 已进保护模式，paths 从源窗格当前选中恢复。**补齐双向覆盖确认**：本地→远程 SFTP 上传（FXF_TRUNC 静默覆盖）与远程→本地下载（`download_to` 新增 `overwrite` 参数，`sftp_download_to` 透传）拖拽前都先列目标目录核对同名条目，存在则弹确认，取消即不传——此前 远程→本地 无提示直接按 " (n)" 序号改名新增，两个方向体验不一致；**粘贴流程的自动改名保持不变**。e2e R18（Playwright dragTo 真实 HTML5 拖拽：松手即上传 + 重复拖拽走确认）；顺带修正 mock 的 `plugin:dialog|message` 返回值——该插件 `confirm()` 复用 message 命令且按返回的按钮名（`'Ok'`）判定，此前恒 null 导致所有确认类对话框在 e2e 里等于"取消"。
- **修复：上传到 SFTP 过程中同步比对面板反复闪「比对中…」**。拖拽/粘贴后的源+目标双窗格刷新此前是两次独立 setTabs，比对管线被取消重启两轮；现新增 `refreshPanes` 批量刷新（一轮更新），并让比对管线在传输（上传/下载/复制/移动/压缩）进行中挂起——`transfer-progress` done 后统一补比对一轮（`syncKick`），传输期间面板保持既有结果不再闪烁。
- **修复：tar/zip 打包使用了绝对路径**。此前 tar/zip/ditto/Compress-Archive 直接以绝对路径为参数，归档内条目带完整层级（解压出 `Users/…/a.txt`）。现压缩命令以目标目录为工作目录、条目转为目录内相对路径（`relativize`），归档内容与 Finder/资源管理器右键压缩一致（`a.txt`、`sub/b.txt`）；不在目标目录内的条目保持原路径。Rust 新增相对化断言与真实 tar 条目校验用例。
- **修复：Windows 小窗口多标签时右上角按钮被挤走**。标签区改为可收缩容器（`min-w-0 overflow-hidden`），空间不足时标题截断为省略号、关闭按钮 `shrink-0` 不再挤压；右上角常驻按钮（设置/主题/⋮/窗口控制）固定可见。新增 **「全部标签」下拉**（Excel 式，☰ 按钮）：列出全部标签（序号 + 活动标记 + 行内 ✕ 关闭），点击切换；标签栏空白处的标题栏拖动区与双击最大化在重构后保留（包装层补 `data-tauri-drag-region` + 双击处理）。e2e R19（下拉列出/切换/关闭）。
- 测试：Rust 102 通过（地址栏命令 +8、主密钥策略 +6）；前端 343 通过（27 文件，cmdline 判定 +5）；e2e 69 通过（新增 R11–R19：地址栏命令 5、零重读/keep-alive 2、拖拽上传/全部标签下拉 2）；`tauri-mock` 补 `sftp_upload` 桩与 `list_dir`/`uploads` 调用记录。

