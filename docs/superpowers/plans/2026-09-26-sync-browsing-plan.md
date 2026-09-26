# 实现计划:同步浏览 + 实时比对面板(v0.18)

- 日期:2026-09-26
- 依据:已批准的 [设计 spec](../specs/2026-09-26-sync-browsing-design.md)(含用户 9 项决策 D1–D9)
- 基线:commit `1955b37`(v0.17.2);版本号不手动 bump(发布流程按 tag 写入)

## 总原则

- TDD:每个里程碑先写测试(或测试与实现同提交),既有 65 Rust + 267 前端 + 39 e2e 必须保持全绿。
- 复用:`diff-progress`/`cancel_diff` 取消机制、`DiffEntry/DiffOutcome` 类型、`list_dir` 的协议路由、persist 的 diff 偏好。
- 防御:后端能力钳制为权威,前端能力表只做显隐与提示。

## M1 后端:能力抽象 + 协议路由(Rust)

1. `src-tauri/src/diff.rs`:从 `compare` 抽出纯函数
   `compare_entries(id, left: Vec<FileEntry>, right: Vec<FileEntry>, opts, cancel, emit)`
   (map 构建 → classify → hash 阶段 → 排序 → done 全部内移);`compare` 变薄包装。
   新增纯函数单测(不经 fs 构造 FileEntry 断言状态)。
2. `src-tauri/src/lib.rs`:
   - 提取 `async fn list_side(&State<AppState>, path)` = 现 `list_dir` 命令的路由体;`list_dir` 命令与 `diff_dirs` 共用。
   - 新增 `BackendKind::{Local,Sftp,Http}` + `BackendCaps { max_diff_level, can_mkdir }`
     (Local={3,true} / Sftp={2,true} / Http={1,false});classify 按前缀。
   - `diff_dirs` 命令:`level = min(level, 两侧 max_diff_level)`;两侧条目经 `list_side`
     获取(串行;本地走 spawn_blocking)后 `spawn_blocking(compare_entries)`;取消注册/清理不变。
3. Rust 测试:compare_entries 纯函数(类型冲突/仅一侧/层2大小);BackendKind classify + caps 钳制表。

## M2 链接核心(TS)

1. `src/lib/backends.ts`:`backendKind(path)`、`backendCaps(kind)`、`pathScheme(path)`
   (Local 按 root 是否含 `\` 选 win/posix 变体;win 大小写不敏感;`under`/`join`)。
   **e2e 兼容**:mock 的本地路径是 posix 风格,故本地分隔符从路径形状探测而非 platform。
2. `src/lib/sync-link.ts`:`SyncLink { tabId, leftPaneId, rightPaneId, leftRoot, rightRoot }`、
   `relOf(link, side, path)`("/" 规范化相对路径或 null)、`mirrorPath(link, side, rel)`、
   `computeAlignment(link, leftPath, rightPath)` → `aligned{rel,leftDir,rightDir} |
   diverged{layer,missing,missingSide,leftDir,rightDir,outsideRoot?}`、
   `marksFromOutcome(entries)` → `Record<name, {status, reason}>`。
3. vitest:backends(各类路径 under/join)、sync-link(对齐/未对齐/越界/跨协议)、marks 映射。

## M3 App 接线 + 面板

1. App.tsx:
   - `syncLink` state + `syncLinkRef`;`toggleSyncDiff`(入口切换,校验恰好两个路径窗格,排除 http/tags)。
   - `navigate` 末尾挂镜像:活动窗格 ∈ link 时 `relOf(Q, root)` → `mirrorPath` → `listDir`
     成功则 patch 对侧(含历史),失败即未对齐(对侧不动)。镜像用直连 patch,不回调 navigate(防回环)。
   - `gotoPane(paneId, path)`:程序化导航任意窗格(加载条目+历史),供 [返回对齐]/[重新对齐]/新建后进入。
   - `ensureDirSequential(path, fromRel)`:逐级 createDir / sftpMkdir(「在对侧新建并进入」唯一远程写)。
   - 实时管线 effect:watch 两窗格 path/refreshKey → 防抖 120ms → `computeAlignment` 取 compareDirs →
     `cancelDiff(prevId)` → `diffDirs(id, l, r, min(2,两侧caps), caseSensitive, tol)` → seq 丢弃过期。
   - 断链自动清理 effect:任一窗格 id 不存在于任何标签 → `setSyncLink(null)` + cancelDiff。
2. `src/components/SyncDiffPanel.tsx`:底部横条(头部:标题/对齐徽标/两侧路径点标/状态文案/
   重新对齐/交换左右/只看差异/折叠/断开;主体:名称|左大小|右大小|状态 行列表,overflow 滚动;
   未对齐横幅:⚠ 文案 + [在对侧新建并进入](canMkdir 门控)[返回对齐][断开链接])。
   vitest:渲染/只看差异/横幅按钮/折叠。

## M4 内联标注

1. `FileList.tsx`:新 props `diffMarks?: DiffMarkMap`、`linkBadge?: "left" | "right"`。
   行首色条:首单元格加 `relative` + `absolute inset-y-0 left-0 w-[3px]` 色条
   (仅左 #f59e0b / 仅右 #0ea5e9 / 不同 #ef4444;相同无),`title` 悬停说明(含两侧大小);
   表头「名称」后追加 Link2 小图标 + 方位色点(链接标识)。
2. `SplitView.tsx`:props 增加 `diffMarksByPane` / `linkBadgeByPane`,透传 PaneView → FileList。

## M5 入口

1. `MenuBar.tsx`:`onOpenSyncDiff` + `syncDiffActive` props;工具菜单新增
   「同步比对(左右窗格)」/激活时「断开同步比对」。
2. `Toolbar.tsx`:搜索按钮旁新增 Link2 切换按钮(title 随状态)。
3. `FileList.tsx` 空白右键:新增「同步比对(左右窗格)」项(与差异比对相邻)。
4. App 渲染:主行与 StatusBar 之间挂 `SyncDiffPanel`(跨全宽)。

## M6 e2e + 文档

1. `e2e/tauri-mock.ts`:补 `create_dir` / `sftp_mkdir`(写虚拟 FS);diff_dirs mock 已支持 sftp 路径键。
2. `e2e/smoke.spec.ts` 新用例:
   - 开启同步比对 → 左侧进入子目录 → 右侧自动跟随 + 面板出现;
   - 左侧进入对侧不存在的目录 → 横幅 + 「仅左侧」标注;
   - [在对侧新建并进入] → 恢复对齐;
   - 断开链接 → 标注消失。
3. CHANGELOG v0.18.0 段;user-guide 补「同步比对」章。
4. 全量验证:`cargo test --lib`、`pnpm test`、`pnpm exec tsc --noEmit`、`pnpm test:e2e`。

## 已知取舍

- 面板行列表先不做虚拟滚动(>2000 行可能卡顿,列入后续);锚点不持久化(D8)。
- 镜像导航的目录探测 = 一次 listDir,成功即用其结果填充对侧(不二次请求)。
- `tags://` 参与判断靠 `tagId` 字段与路径前缀双保险;`http(s)://` 显式排除。
