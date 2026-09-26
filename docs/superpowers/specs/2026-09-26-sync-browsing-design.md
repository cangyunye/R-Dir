# 设计文档:SFTP 同层比对 + 同步浏览 + 实时比对面板

- 日期:2026-09-26
- 状态:**待用户 review**(批准前不写实现代码)
- 来源:2026-09-26 交接文档 + 本会话用户拍板
- 目标版本:v0.18.0
- 基线:commit `1955b37`(v0.17.2)

---

## 1. 背景与目标

v0.17.0 的差异比对(`DiffDialog` 模态窗)只支持**两个本地目录**的三层静态比对。用户需要:

1. **SFTP 参与比对**,但受协议能力限制,降级为**同目录、非递归**的一层(名称/类型)+ 二层(大小);不做远程内容 hash。
2. **同步浏览**:左右两个窗格按一个根映射绑定,一侧进入子目录时另一侧自动进入同名相对子路径;本地/本地 与 本地/SFTP 行为一致。
3. **实时比对**:开启比对即开启同步浏览,比对只针对"当前这一层",随导航**实时重算**——核心是"边浏览边比对",不是"先比对再静态看结果"。

## 2. 范围与非目标

**做**:
- 任意两个路径窗格之间的链接:本地↔本地、本地↔SFTP、SFTP↔SFTP(不同主机亦可)。
- 实时同层比对:一层(名称/类型,含类型冲突)+ 二层(大小)。
- 底部横条比对面板 + 文件列表行首内联色条标注。
- **后端能力抽象**(§5.5):本版只实现 local/sftp 两种后端,但"列目录调度、比对深度钳制、写入门控、路径规则"收敛为显式抽象点,S3/网盘等未来后端按能力表接入,不改动比对内核与 UI。

**不做(本版)**:
- 远程写入(除「在对侧新建并进入」这一个显式按钮外,不做任何远程增删改;远程删除不碰)。
- SFTP 三层 hash 比对(无 SSH exec 通道,下载实现成本高,列 P2+)。
- `http(s)://` 自动索引目录与 `tags://` 虚拟标签视图参与链接/比对。
- 链接状态随会话持久化(用户已拍板:不做)。
- 递归(跨层)比对:面板永远只比"当前对齐层"。

## 3. 决策记录

| # | 决策点 | 结论 | 来源 |
|---|--------|------|------|
| D1 | SFTP 比对深度 | 一层 + 二层,同目录非递归,无 hash | 上会话用户 |
| D2 | 显示形态 | 底部面板 **和** 内联色条 都要 | 上会话用户 |
| D3 | 对侧无同名目录 | 对侧停原地,面板标「仅本侧」,不报错页 | 上会话用户 |
| D4 | 面板停靠 | 底部横条,跨全宽,可折叠 | 上会话用户 |
| D5 | 内联标注样式 | 行首细色条 + 悬停 tooltip,不改列结构 | 上会话用户 |
| D6 | 未对齐态 | 面板回退最近共同层 + 顶部横幅三按钮(§5.3) | 本会话用户(2026-09-26) |
| D7 | 与模态比对窗关系 | **并存**:模态窗留给本地↔本地三层 hash 深比对,面板负责实时同层 | 本会话用户 |
| D8 | 链接持久化 | **不保存**,每次手动开启 | 本会话用户 |
| D9 | v0.17.2 提交 | 先提交(已完成:`1955b37`) | 本会话用户 |

## 4. 术语

- **链接(link)**:两个窗格之间的同步绑定关系。
- **锚点(root)**:开启链接时两侧窗格各自的当前路径,作为相对路径映射的基准。
- **对齐(aligned)**:两侧当前路径相对各自锚点的相对路径相同。
- **未对齐(diverged)**:一侧进入了另一侧不存在的相对子路径,或一侧离开了自己锚点的子树。
- **共同层(common layer)**:未对齐时,两侧相对路径的最长公共祖先目录,面板回退到这一层比对。

## 5. 总体设计

### 5.1 链接状态模型(方案 A1:锚点相对路径镜像)

前端新增模块 `src/lib/sync-link.ts`(纯函数,便于单测)+ App 级状态:

```ts
// App 中的链接状态(不持久化)
interface SyncLink {
  leftPaneId: number;
  rightPaneId: number;
  leftRoot: string;   // 锚点,原样保留协议前缀(sftp://... 或本地绝对路径)
  rightRoot: string;
}
```

纯函数助手(全部在 `sync-link.ts`,vitest 覆盖):

```ts
// p 在 root 子树内时返回相对路径(规范化分隔符),否则 null。
// 本地 Windows 路径不区分大小写比较(与 diff caseSensitive 默认一致);sftp:// 区分大小写,分隔符恒为 "/"。
relUnder(p: string, root: string): string | null

// joinRoot(root, rel):把相对路径拼回另一侧锚点(沿用各自协议的分隔符规则)
joinRoot(root: string, rel: string): string

// 未对齐时求共同层:最长公共目录前缀;并给出横幅用的缺失相对段
commonLayer(relA: string, relB: string): { layer: string; missing?: string }
```

路径规则按协议注册为 **PathScheme**(由 `src/lib/backends.ts` 提供,`relUnder`/`joinRoot` 驱动,自身不含协议特判):

```ts
interface PathScheme {
  separator: "/" | "\\";
  caseSensitive: boolean;   // 本地 Windows = false,其余 true
  under(p: string, root: string): string | null;  // = relUnder
  join(root: string, rel: string): string;
}
```

**镜像导航算法**(挂接点:`App.tsx::navigate` 成功 `patchPane` 之后):

```
navigatePane(P → Q) 且存在 link 且 P ∈ {left, right}:
  rel = relUnder(Q, rootP)
  若 rel == null:            # 一侧离开锚点子树 → 未对齐,不镜像
    进入未对齐态(横幅:一侧已离开链接根目录),重算面板(共同层回退到 "")
  否则:
    candidate = joinRoot(rootOther, rel)
    探测 listDir(candidate):
      成功 → patchPane(other → candidate)(镜像导航,推入对侧历史;
               mirroringRef 防回环:navigate() 对同路径本就短路,再加 ref 双保险)
      失败 → 对侧不动,进入未对齐态
  防抖 120ms 后触发面板重算(§5.4)
```

- 对侧的**手动导航**(包括前进/后退)同样走上述逻辑,即任何一侧都是"主动侧"。
- 回到共同祖先时,派生状态自然恢复对齐,无需显式"重对齐"动作;面板提供的手动按钮见 §6.1。
- 链接的 `left/right` 只是面板展示方位;镜像能力两侧对等,不区分主从。

### 5.2 比对深度与协议钳制

| 两侧协议 | 面板比对深度 | 说明 |
|----------|--------------|------|
| 本地 ↔ 本地 | 层 2(名称/类型 + 大小) | 三层 hash 深比对仍走模态窗(D7 并存) |
| 任一侧为 sftp:// | 层 2(同上,后端强制 `level ≤ 2`) | 无 hash,无 mtime 比较(SFTP mtime 秒精度) |

面板固定 level 2,不提供层级选择;名称匹配大小写沿用现有 `rfm.diff-case-sensitive` 偏好。该深度不是写死 2,而是取 `min(2, 两侧后端 max_diff_level)`(§5.5 能力表)——本版两种后端均 ≥ 2 故恒为 2;未来接入能力更低的后端(如仅层 1 的网盘)时面板自动降级,无需改面板代码。

### 5.3 未对齐态(D6,按推荐实现)

派生状态(不由导航事件单独维护,每次重算时从两侧当前路径推导):

- **比对目标回退**:取两侧相对路径的**共同层** `layer`,面板比对 `joinRoot(leftRoot, layer)` vs `joinRoot(rightRoot, layer)`; wanderer 更深层的目录条目在该层显示为「仅左侧/仅右侧」。
- **顶部横幅**:`⚠ 两侧不同层:对侧无 "<missing>"`(missing = wanderer 相对共同层的剩余段;一侧离开锚点子树时显示 `一侧已离开链接根目录`),按钮:
  - **[在对侧新建并进入]**:在 joinRoot(rootOther, wandererRel) **逐级创建缺失段**(本地 `create_dir` / SFTP `mkdir`,逐段 ensure),成功后镜像导航对侧、恢复对齐、立即重算。SFTP 侧这是本特性唯一的远程写入点。
  - **[返回对齐]**:把 wanderer 导航回 `joinRoot(rootWanderer, otherRel)`(镜像对侧当前位置)。
  - **[断开链接]**:等同关闭面板(§6.1)。
- **更深层暂不比对**(D6 原话)。
- 面板状态徽标:已对齐(绿色)/ 未对齐(琥珀)。

### 5.4 实时比对管线

```
触发:任一链接窗格 path/refreshKey 变化(含镜像导航、F5 刷新、新建并进入)
  → 防抖 120ms(导航连跳时只算最后一次)
  → 计算 compareDirs(对齐层或共同层);与上次相同则跳过
  → cancelDiff(prevDiffId) 取消在途任务
  → diffDirs(newId, leftDir, rightDir, level=2, caseSensitive, tolerance)
  → 结果按 runSeq 丢弃过期响应(只应用最新一次)
```

- 复用现有取消机制:`AppState.diff_cancels` + `cancel_diff`(lib.rs:44、:636)。
- 面板头部显示轻量状态:`比对中… / N 项 / 已取消 / 失败`;不弹进度窗(同层目录列表很快,进度事件仅用于状态文案)。
- 失败(如 SFTP 掉线):面板错误态 + [重试] 按钮;不自动断链(网络恢复可直接重试)。

### 5.5 后端改动:diff 引擎协议路由

现状:`diff.rs::compare`(diff.rs:148)只调 `fs_ops::list_dir`(纯本地);Tauri 命令 `diff_dirs`(lib.rs:601)无协议路由。而 `list_dir` **命令**(lib.rs:54)已有三协议路由,且 `sftp::list_dir` 返回与本地**同一** `FileEntry` 结构(sftp/mod.rs:16、:117)。

改动(保持模态窗行为完全不变):

1. **`diff.rs`:抽出纯函数 `compare_entries`**
   ```rust
   pub fn compare_entries(id: &str, left: Vec<FileEntry>, right: Vec<FileEntry>,
       opts: &DiffOptions, cancel: &AtomicBool, emit: &mut dyn FnMut(&DiffProgress))
       -> Result<DiffOutcome, String>
   ```
   现有 `compare` 变为薄包装(list 两地 → 调 `compare_entries` → hash 阶段),65 个既有 Rust 测试不动。
2. **统一后端调度 `list_side`(核心抽象点,新后端只改这里)**:
   - 把现有 `list_dir` **命令**(lib.rs:54-83)的内联前缀路由提取为共享函数 `async fn list_side(state, path) -> Result<Vec<FileEntry>, String>`,`list_dir` 命令与 `diff_dirs` 共用——"哪些后端能列目录"从此只有一个权威答案,`diff_dirs` 不再自带特判。
   - `BackendKind::{Local, Sftp, Http, …}`(按路径前缀分类)挂**能力表**:
     ```rust
     struct Caps { max_diff_level: u8, can_mkdir: bool }
     // Local → { 3, true }   三层 hash 仅本地可行(std::fs 读取)
     // Sftp  → { 2, true }   秒精度 mtime、无 exec,内容 hash 不可行
     // Http  → { 1, false }  本版仍拒绝参与链接,仅作能力示例
     ```
     `tags://` 是虚拟视图,不算后端。**未来接 S3/网盘 = 增加一个分类臂 + 一条能力条目 + 一个 list 分支**,比对内核、同步浏览、面板 UI 零改动。
3. **能力驱动的钳制与写入门控**:
   - `diff_dirs` 钳制 `level = min(请求值, caps_left.max_diff_level, caps_right.max_diff_level)`(含 SFTP 侧自然落 2;本地↔本地 3 保持可用);hash 阶段仅当两侧均 Local 才执行。
   - 「在对侧新建并进入」按钮由对侧 `can_mkdir` 门控(无此能力的后端隐藏按钮并在横幅说明);创建走统一 `mkdir_p`(Local:逐级 `create_dir`;Sftp:逐级 `mkdir`;未来后端自行实现或声明 false)。
   - 前端 `src/lib/backends.ts` 维护同构能力表(maxDiffLevel/canMkdir/PathScheme),驱动按钮显隐与提示;后端钳制仍保留,双保险。
4. **命令名/事件不变**:仍用 `diff_dirs` + `diff-progress` + `cancel_diff`,e2e mock 与 api.ts 封装签名不变。

> **展望(本版不实现)**:接入 S3/网盘的最低要求 = 能按前缀列目录且条目含 name/is_dir/size(满足层 2;mtime 可选,层 2 不比较)。can_mkdir = false 时同步浏览仍可用,仅「新建并进入」按钮隐藏。连接/凭据管理(bucket 配置、密钥)复用 SFTP 连接对话框的交互模式,属于接入方自己的前置流程,与本特性无关。

## 6. UI 设计

### 6.1 底部同步比对面板(新组件 `src/components/SyncDiffPanel.tsx`)

- **位置**:主区底部横条,跨全宽(SplitView 之下),与右侧搜索面板互不重叠;高度约 220px(可拖拽调高列为 P2,先固定)。
- **头部**(折叠后仅存此行):
  - 标题「同步比对」+ 对齐徽标(`已对齐` / `未对齐`)。
  - 两侧路径缩略(左锚点→当前相对路径,右同),各配 §6.2 同色小圆点。
  - 按钮:`重新对齐`(两侧各跳回锚点)、`交换左右`(交换 link 的 left/right 后重算)、`只看差异` 开关、`折叠/展开`、`断开链接`(= 关闭面板,清理 marks 与在途任务)。
- **主体**:行列表 `名称 | 左大小 | 右大小 | 状态`,数据即 `DiffOutcome.entries`;状态列文案:仅左侧 / 仅右侧 / 类型不同 / 大小不同 / 相同;目录优先排序沿用后端。行数 > 2000 时复用 `@/lib/virtual-scroll`(实现时视工作量,可后补)。
- `只看差异`:过滤掉 status === "same" 的行(对齐与未对齐态都可用)。

### 6.2 内联标注(FileList 行首色条 + tooltip)

- `FileList` 新增 prop `diffMarks?: Record<string, { status: DiffStatus; reason?: string }>`(name → 判定),仅链接态由 App 传入。
- 渲染:行容器(FileList.tsx:794-802)加**行首 3px 左色条**(不改 COLUMNS 列模板,用 `box-shadow inset` 或首单元格前绝对定位小条,避免扰动 grid):
  - 仅左侧 = 琥珀 `amber-500`;仅右侧 = 天蓝 `sky-500`;不同 = 红 `red-500`(reason 区分 tooltip 文案);相同 = 无条。
  - **tooltip**:悬停显示「仅左侧有此条目 / 仅右侧有此条目 / 两侧大小不同(左 1.2 MB · 右 0.9 MB)/ 类型不同(一侧为文件夹)」。
- **作用域**:某侧 `diffMarks` 仅在该窗格当前路径 === 该侧被比对目录时传入;wanderer 更深层窗格不显示 marks(它不在比对层)。
- 复用项目现有 tooltip 模式(右键菜单同源的浮层方案,注意 v0.16.0 的 zoom 补偿已有封装)。

### 6.3 链接标识

每侧窗格列表**表头行右端**(FileList.tsx:661-694)显示一个小链接图标 + 对应方位色点,表示"此窗格已参与同步比对";无每窗格独立路径栏(全局单地址栏),故标识落在表头。

### 6.4 入口与门槛

新增动作「同步比对(左右窗格)」:

- 菜单栏「工具 → 同步比对(左右窗格)」;
- 窗格空白处右键菜单项(与现有「与另一窗格差异比对…」相邻);
- 工具栏地址栏右侧图标按钮(与现有动作按钮风格一致)。

开启时校验:**活动标签恰好两个路径窗格**(排除 `tags://` 与 `http(s)://`;sftp 允许),否则 toast 提示「同步比对需要当前标签恰好两个路径窗格」。开启即:两侧当前路径记为锚点 → 打开底部面板 → 立即首算 → 表头出现链接标识。

再次触发同一动作 = 断开链接(切换语义),菜单项文案随状态变「断开同步比对」。

## 7. 与模态比对窗口的分工(D7 并存)

| | 底部实时面板(新) | 模态比对窗口(v0.17,保留) |
|---|---|---|
| 定位 | 边浏览边巡检,实时重算 | 一次性深比对 + 批量同步 |
| 协议 | 本地/SFTP 任意两侧 | 仅本地↔本地(现状不变) |
| 深度 | 层 2(受后端能力钳制,本版恒为 2) | 层 1/2/3(hash + mtime) |
| 同步(复制/删除) | 不提供 | 保留(双向同步 + 日志) |
| 关系 | 面板的「在模态窗中深比对」入口列为 P2 | 不感知面板 |

## 8. 错误处理与边界

- **SFTP 掉线**:面板错误态 + 重试;镜像导航探测失败按"对侧无目录"处理会误导——探测错误需区分 `Err`(网络/会话问题,横幅显示错误并阻断镜像)与"列表成功但无此目录"(正常未对齐)。实现上以 `list_dir` 返回 Ok/Err 区分。
- **关闭链接窗格 / 关闭标签 / 关闭程序**:自动断链,清理面板与 marks(含 `useEffect` cleanup 调 `cancelDiff`)。
- **两侧锚点相同主机同一路径**(SFTP↔SFTP 同 authority):允许,pool 互斥串行,只是慢;面板可用。
- **大目录**:层 2 纯内存比对,数千条目 < 100ms 量级;SFTP 侧 `list_dir` 受 64KB/包串行 READDIR 限制,大目录可能数秒——面板状态显示「比对中…」即为此设计;比对期间不阻塞其它窗格浏览(除同 authority 的 SFTP 窗格)。
- **符号链接**:沿用 FileEntry.is_symlink 展示,不做跟随特殊处理。
- **重命名/删除等导致锚点失效**:下次重算 list 失败 → 面板错误态;横幅提供「重新对齐」跳回锚点方向,锚点本身不自动改写。

## 9. 测试计划

| 层 | 内容 |
|----|------|
| Rust 单测 | `compare_entries` 抽取后既有 65 测试全绿;新增:能力表钳制(Local=3/Sftp=2/Http=1)、`list_side` 对 http/tags 报错、类型冲突在层 2 的判定保持 |
| vitest 单测 | `backends.ts`(能力表与 PathScheme);`sync-link.ts`(relUnder/joinRoot/commonLayer,含 Windows 大小写、sftp 分隔符、越界 null,全部经 PathScheme 驱动);`SyncDiffPanel`(渲染、只看差异、横幅三按钮、can_mkdir=false 时隐藏新建);`FileList` diffMarks 色条与 tooltip;App 断链清理 |
| e2e(`tauri-mock.ts`) | mock 补:`sftp://` 虚拟 FS 的 list_dir 路由(若现有虚拟 FS 未覆盖)、diff_dirs 对 sftp 路径返回层 2 结果;用例:①开启链接→左侧进子目录→右侧自动跟随→面板出现;②对侧无目录→横幅+仅左侧标注;③[在对侧新建并进入]→对齐恢复;④断链后 marks 清空 |
| 手动回归 | 模态窗三层 hash 比对不回归;搜索面板与底部面板同开不重叠;zoom 缩放下 tooltip 不溢出(v0.16.0 同类问题) |

## 10. 实现里程碑(批准后由实现计划细化)

1. **M1 后端路由与能力抽象**:`compare_entries` 抽取 + `list_side` 统一调度(提取自 `list_dir` 命令)+ `BackendKind`/`Caps` 能力表与钳制 + Rust 测试。
2. **M2 链接核心**:`backends.ts`(能力表 + PathScheme)+ `sync-link.ts` 纯函数 + App 链接状态与镜像导航 + vitest。
3. **M3 面板**:`SyncDiffPanel` + 实时管线(防抖/取消/seq)+ 只看差异 + 折叠。
4. **M4 内联标注**:FileList `diffMarks` + tooltip + 表头链接标识。
5. **M5 入口与清理**:菜单/右键/工具栏入口 + 两窗格校验 + 关 pane/标签断链。
6. **M6 e2e + 回归 + 文档**:mock 扩展、e2e 用例、CHANGELOG、user-guide 补章。

## 11. 现状代码锚点(实现时对照)

- 窗格/标签模型:`src/lib/types.ts:30-77`(PaneState/PaneNode/TabState);协议判定 `src/lib/sftp-path.ts:3-50`。
- 导航:`src/App.tsx:760-820`(`navigate`),目录加载 effect `:690-737`;现有 diff 入口 `openDiff` `:440-459`(排除 sftp/http/tag,面板入口不复用其过滤)。
- diff 引擎:`src-tauri/src/diff.rs:148-155`(compare)、`:251-298`(classify)、`:301-327`(hash,仅本地);命令 `src-tauri/src/lib.rs:601-641`(diff_dirs/cancel_diff);`list_dir` 命令的协议路由 `lib.rs:54-83`。
- SFTP:`src-tauri/src/sftp/mod.rs:21-60`(路径解析/pool key)、`:148-166`(list_dir,同一 FileEntry);pool 每会话互斥(sftp/pool.rs)。
- 前端 IPC:`src/lib/api.ts:14-15`(listDir)、`:177-195`(diffDirs/cancelDiff);偏好 `src/lib/persist.ts:353-410`(diff-case 等)。
- FileList 行渲染与色条插入点:`src/components/FileList.tsx:729-825`;表头 `:661-694`;右键 diff 菜单项 `:1074`。
- e2e mock:`e2e/tauri-mock.ts:158-188`(diff_dirs/cancel_diff)、`:44-70/:240`(SFTP 服务器与 connect)。
