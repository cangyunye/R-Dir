# Rust 版生产级文件检索工具（对标 Everything）设计方案

> 
> 定位：Windows 平台，NTFS 优先使用 MFT + USN Journal，非 NTFS 回退目录遍历；服务/UI 分离；生产级稳定性、内存可控、低延迟、可配置。
> 约束：只讲**架构、模块划分、索引模型、算法原理、数据结构、一致性策略**，不写 Tauri/UI 胶水代码，不做入门玩具实现。

## 一、核心设计总纲

### 1. 核心目标

1. 索引对象：**文件名 + 路径元数据**（不索引文件内容）
2. 查询语义：**子串包含匹配（任意位置）、大小写不敏感、支持布尔/通配符/过滤条件**
3. 刷新策略：
   - 全量初始化：NTFS → 解析 `$MFT`；FAT32/exFAT/网络盘 → 递归目录遍历
   - 增量更新：NTFS → USN Journal 增量消费；非 NTFS → 定时增量扫描
4. SLA 指标（对标 Everything）
   - 百万文件：索引内存 < 80MB；查询 P99 < 5ms
   - USN 事件延迟 < 200ms
   - 后台索引不抢占磁盘IO、可限流、可暂停
   - 崩溃恢复：索引持久化快照 + 未消费 USN 序列号断点

### 2. 架构分层（单向依赖）

```
┌─────────────────────────────────────────────────────────┐
│  【UI 进程】Tauri / 独立GUI：查询、配置、托盘、全局快捷键 │
└───────────────────────命名管道(IPC)──────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  【后台服务进程】（Windows Service，管理员权限）          │
│  ├─ IPC Server 层：请求解析、权限校验、限流、结果序列化  │
│  ├─ Query Engine 层：索引查询、语法解析、过滤、排序      │
│  ├─ Index Manager 层：索引读写、快照、版本、内存池管理  │
│  ├─ Source Adapter 层：数据源抽象（NTFS-MFT / USN / 普通遍历）
│  ├─ Disk IO Controller：IO 限流、重试、分区状态管理、BitLocker/异常盘隔离
│  └─ Persist 层：快照持久化、断点存储、WAL（可选）        │
└─────────────────────────────────────────────────────────┘
```

> 
> 关键隔离：**服务进程负责索引和磁盘原生读取；UI 进程只做查询展示，不碰 MFT/USN**。
> 理由：MFT/USN 需要管理员权限，UI 不需要管理员；UI 崩溃不影响索引；支持多客户端连接同一个检索服务。

### 3. 分区模型（Partition 抽象）

每个分区是独立隔离单元，单独维护索引、USN 断点、排除规则：

```
struct Partition {
    volume_path: String,       // "\\.\C:"
    fs_type: FsType,           // Ntfs / Fat32 / ExFat / Network
    is_encrypted: bool,        // BitLocker 标记
    state: PartitionState,      // Idle / Indexing / Paused / Error
    index: Arc<Index>,
    usn_bookmark: Option<UsnBookmark>, // NTFS 专属：上次消费的USN序列号
    exclude_rules: ExcludeRuleSet,
    io_quota: IoQuota,
}
```

- 分区独立锁、独立索引；一个盘异常不拖垮全盘
- 加密盘（BitLocker）：MFT 读取直接跳过，降级为普通目录遍历，或者直接禁用该盘索引（可配置）

---

## 二、数据源模块原理（Source Adapter）

### 2.1 NTFS：MFT 全量扫描

NTFS `$MFT` 是一个文件，每个 MFT Record 描述一个文件/目录。

- 打开卷：`CreateFileW(L"\\\\.\\C:", GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL)`
- 读取 MFT 记录：每条记录包含 `MFT_REF、父目录MFT_REF、文件名、时间戳、大小、标志位`
- 核心难点：**MFT 记录本身只存父MFT编号，不是完整路径**
→ 构建一个 `parent_mft_ref → name` 的映射表，后序递归拼接路径。
- 过滤规则在 MFT 解析阶段前置：跳过系统元文件 `$MFT、$LogFile、$UsnJrnl` 等，跳过排除目录。
- 限流：按块读取，每N条记录sleep，避免抢占磁盘IO。

> 
> 对比普通 `FindFirstFileW`：MFT 是顺序读，不需要遍历目录树，**初始化速度快一个数量级**。

### 2.2 NTFS：USN Journal 增量更新（Everything 实时核心）

USN Journal 是 NTFS 内核维护的变更日志，文件增删改、重命名都会写入一条 `USN_RECORD`。
结构体关键字段：

- `usn`：单调递增序列号（断点核心）
- `reason`：变更类型（CREATE / DELETE / RENAME_OLD / RENAME_NEW / MODIFY）
- `file_ref_number`：对应 MFT 编号
- `parent_file_ref_number`：父目录MFT编号
- `file_name`：文件名

消费逻辑：

1. 全量MFT扫描结束后，记录当前最大 `usn` 作为 `bookmark`
2. 轮询 `DeviceIoControl` 读取 USN 日志，从 bookmark 之后读
3. 对每条 USN 记录，转换为索引变更事件：
   - CREATE：新增文件记录
   - DELETE：删除索引条目
   - RENAME：**先删旧路径条目，再新增新路径条目**（重命名是两条USN：OLD + NEW）
4. 处理乱序、重复、已删除MFT记录：校验MFT记录是否存在，不存在则丢弃事件
5. 持久化 bookmark：每次消费一批事件后落地，崩溃重启从该usn继续，不需要全量重扫

> 
> 重要坑：USN 日志是环形缓冲区，日志会被覆盖。如果长时间离线，bookmark 对应的记录已经被覆盖 → 触发该分区**全量MFT重扫**。这个逻辑必须写在 Partition 状态机里。

### 2.3 非NTFS（FAT32/exFAT/网络盘）

没有 MFT、没有 USN Journal。

- 初始化：递归 `FindFirstFileW`
- 增量：定时增量扫描（可配置间隔，默认 30s~5min），对比上次快照，生成变更事件
- 性能弱，设计上把它作为二等公民，不追求毫秒级实时。

### 2.4 统一事件模型

所有数据源输出统一 `IndexEvent`，上层索引引擎不需要区分是MFT/USN/目录遍历：

```
enum IndexEvent {
    Add(FileMeta),
    Remove(FileMetaId),
    UpdateMeta(FileMeta), // 大小/修改时间变化，文件名不变，不需要改倒排索引
}
struct FileMeta {
    id: FileMetaId,       // 全局唯一ID：partition_id + mft_ref / 目录遍历自增id
    name: String,         // 文件名（小写归一化，用于索引）
    raw_name: String,     // 原始大小写，用于展示
    full_path: String,
    size: u64,
    modified: i64,
    is_dir: bool,
}
```

---

## 三、索引层：核心数据结构与算法原理（重点）

> 
> 需求：**子串查询**（输入 `abc` 匹配 `xabc.txt` / `aabcc.mp4`），不是前缀匹配。
> 方案选型：**N-Gram 倒排索引（2-gram 为主，可选3-gram增强）**，这是生产级子串检索工业方案，也是 Everything 同类工具的主流实现。

### 3.1 为什么不直接用 contains 遍历？

百万文件下，线性扫描 `O(N)`，P99 会飙升到几十ms甚至上百ms，无法做到毫秒响应。
N-Gram 倒排：查询变成**求多个倒排链表的交集**，复杂度和命中文档数相关，不是总文件数。

### 3.2 2-Gram 索引原理

把归一化后的文件名（小写）拆成连续二元字符窗口：
示例：`readme`

```
readme → re, ea, ad, dm, me
```

索引结构：

```
Gram(2) → 有序 FileMetaId 列表
```

查询：`ead`

1. 关键词归一化小写：`ead`
2. 拆gram：`ea, ad`
3. 取出 `ea` 对应的id列表、`ad` 对应的id列表
4. 求两个有序列表的**交集** → 候选集合
5. 对候选集合做一次精确 contains 校验（过滤 gram 误匹配）
6. 再应用过滤条件（大小、时间、目录、是否文件夹）

> 
> 为什么 2-gram 而不是 3-gram：
> 
> 
> - 2-gram：gram 数量多、倒排链表短；容错强，输入片段短也能匹配；内存开销适中
> - 3-gram：gram 少、链表长；适合长关键词，短关键词容易无结果
> 工程策略：**主索引 2-gram；可选附加3-gram用于长词加速**

### 3.3 索引完整结构（一个 Partition 内）

```
struct Index {
    // 正向表：FileMetaId → 完整元数据（路径、大小、时间、原始名称）
    forward: DashMap<FileMetaId, FileMeta>,

    // 核心倒排索引：2-gram → 有序id数组
    gram2: DashMap<[u8;2], BTreeSet<FileMetaId>>,

    // 辅助：扩展名索引（快速过滤 .rs .txt）
    ext: DashMap<String, BTreeSet<FileMetaId>>,

    // 版本号：每次索引变更自增，用于查询快照隔离
    version: AtomicU64,
}
```

- 并发安全：`DashMap` 分片锁，支持**读多写少**；查询和增量更新可以并行
- 倒排链表：使用 `BTreeSet` 或者 排序 Vec；交集使用**有序数组双指针交集算法**（O(a+b)，无hash开销）

### 3.4 交集算法（有序数组双指针，生产级核心）

输入两个升序 id 列表 A、B，输出交集：

```
i=0, j=0
while i < len(A) && j < len(B):
    if A[i] == B[j]:
        add to result
        i +=1; j +=1
    elif A[i] < B[j]:
        i +=1
    else:
        j +=1
```

优点：无内存分配、无哈希、CPU cache友好，是gram检索的标准底层算法。

> 
> 当关键词长度 ≥ N 时，拆出的gram越多，交集之后候选集越小，查询越快。

### 3.5 索引更新逻辑（USN 事件驱动）

1. `Add(FileMeta)`
   - 写入 forward 表
   - 对 name 生成全部2-gram，把id插入每个gram对应的倒排链表
   - 提取扩展名，插入ext索引
2. `Remove(id)`
   - 从 forward 取出旧meta
   - 遍历旧meta.name的所有gram，从对应倒排链表删除id
   - 从ext索引删除id
   - 删除forward表记录
3. `UpdateMeta(id, new_meta)`：**文件名不变**
   - 只更新 forward 里的 size / modified，**不动倒排gram索引**（巨大性能收益）> 
   > 这是非常关键的优化：文件修改内容、改时间，只要名字不变，不需要碰倒排。

### 3.6 索引持久化 & 快照（崩溃恢复）

不做实时全量写盘（性能差），采用**快照 + 断点**模型：

1. 定时快照（默认 5min，可配置）：把整个 Index 序列化到磁盘（使用 bincode / postcard，Rust 首选）
2. 单独小文件持久化每个分区的 `UsnBookmark`（usn序列号）
3. 重启流程：
   - 加载最新快照
   - 读取 bookmark，从该usn继续消费USN日志
   - 如果journal已经覆盖该bookmark → 快照作废，触发全量MFT重扫
4. 可选增强：轻量 WAL（只记录IndexEvent），快照之间的增量事件写WAL，进一步降低丢数据窗口。

> 
> 快照是可选降级：如果不想加载大快照，也可以配置“每次启动全量索引”，但生产环境不推荐。

### 3.7 内存控制策略

- 每个gram倒排链表使用 `Vec<FileMetaId>` 而不是 `HashSet`，减少内存碎片
- 分区独立索引，支持**手动卸载分区索引**（比如不常用盘，释放内存）
- 配置最大索引文件数上限，超过上限拒绝新增索引
- 预分配、复用id结构，避免大量小对象分配

---

## 四、查询引擎（Query Engine）原理

### 4.1 查询语法解析器（递归下降，轻量）

支持语法：

- 空格 = AND
- `|` = OR
- `!` = NOT
- `* ?` 通配符
- 过滤器：`size:>100mb`、`date:2026-10`、`ext:rs`、`folder:true`

解析输出：抽象语法树 `QueryAst`，底层最终转化为一组 gram 子查询 + 过滤器。

### 4.2 查询执行流程

1. 输入字符串 → 归一化（小写、去空白）
2. 语法解析生成 AST
3. 提取所有需要的 2-gram，拿到对应的倒排链表
4. 按 AND/OR/NOT 做集合运算（双指针交集/并集/差集），得到候选id集合
5. 遍历候选id，从 forward 取出 FileMeta，做**后校验**：
   - 原始文件名 contains 关键词（消除gram误匹配）
   - 通配符匹配、大小/时间/目录过滤、排除规则
6. 排序：默认按路径；支持按修改时间、大小排序
7. 分页、截断（避免一次性返回十万条结果阻塞IPC）

> 
> 后校验是必须的：gram 是近似索引，会存在假阳性，必须校验原始文件名。

### 4.3 并发与隔离

- 查询使用**版本快照**：查询开始时读取 index.version，查询过程中增量更新不影响本次查询结果
- 查询池：限制并发查询数，防止大量查询打满CPU
- 防抖交给UI层：UI输入停止后200ms再发查询请求，服务端不做防抖

---

## 五、排除规则、权限、一致性、容错设计（生产级重点）

1. **排除规则引擎**
支持全局排除、分区排除：按路径前缀、文件名、扩展名、正则。
两个阶段过滤：
   - 索引阶段：MFT/USN事件进来直接丢弃，不进索引（优先）
   - 查询阶段：过滤命中结果（临时排除，不改动索引）
2. **权限模型**
   - 服务：管理员权限（MFT/USN）
   - IPC：ACL 限制，只允许本机当前用户连接，拒绝远程匿名访问
   - 注意：管理员读到的文件，普通用户可能无访问权限，**索引只存元数据，打开文件时由资源管理器校验权限**，工具本身不做访问校验。
3. **USN 日志覆盖检测**
每次打开USN日志，读取journal的最低可用usn；如果 bookmark < 最低可用usn → 日志已覆盖，触发全量重扫。
4. **IO 容错**
MFT读取、USN读取遇到：磁盘离线、加密、IO错误、CRC错误 → 分区标记为Error，暂停索引，后台重试，日志上报，不panic整个服务。
5. **去重**
USN 可能重复投递同一条记录；每个事件带上 usn，服务内维护最近N条usn环形去重缓冲区。

---

## 六、性能瓶颈与优化清单（Rust 专属）

1. 字符归一化：提前把文件名转小写存入索引，查询时关键词同样小写，**查询阶段不做重复to_lowercase**
2. 内存分配热点：预分配gram集合、重用Vec，避免每次查询大量alloc
3. 并行：MFT扫描时可以多分区并行，但**同一个分区MFT读取是串行**（磁盘IO瓶颈，不是CPU）
4. 倒排压缩：FileMetaId 是u64，可以用 varint 压缩序列化快照，减少磁盘体积
5. 定时GC：删除长期无引用的gram链表（极少出现，主要是删除大量文件后）
6. 避免在查询路径上做锁争抢：DashMap分片、只读查询尽量不写

---

## 七、可选高级扩展（不影响核心基线）

1. 拼音辅助索引：文件名拼音预拆，额外一套拼音gram索引，单独分支，不混主索引
2. 正则检索：不走倒排，直接候选集后过滤（慢，标记为heavy query）
3. ETP 协议兼容：简易TCP服务，提供远程检索（额外认证、限流）
4. 统计指标：每个分区索引数量、查询耗时直方图、USN消费延迟、IO错误计数，对接prometheus

## 八、边界取舍（生产工程必须明确）

- ❌ 不索引文件内容：内容搜索走外部工具，本工具只做文件名检索
- ❌ 不做实时内容变更监听：只监听文件名/路径变更
- ✅ 接受USN日志覆盖时的全量重扫，这是NTFS本身机制带来的固有约束
- ✅ 非NTFS盘性能降级，文档明确告知用户

如果你需要，我下一步可以单独输出：

1. 该方案对应的 `Cargo.toml` 依赖清单 + 模块目录结构
2. 或者独立的：USN/NTFS MFT 解析的无UI纯Rust核心库模块定义（trait + 结构体签名）