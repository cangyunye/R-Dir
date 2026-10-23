# 压缩包右键处理（解压）技术方案头脑风暴（v0.32.0 规划）

> 目标：右键 zip / tar / gz / rar / 7z 等压缩包，直接解压（本期）与浏览内容（后续）。
> 本文所有数据均为 2026-10-20 在本机（macOS arm64）实测或已查证来源，非拍脑袋估计。

## 一、现状前提

- `compress.rs`（v0.8）**只打包不解压**：zip/tar/tgz 走系统命令（ditto / powershell / tar / zip）。
- v0.9 从 Rust crate 切到系统命令的原因是**压缩（编码）速度**：大批量文件时 ditto 明显快于 zip crate 的编码器。**这个理由对解压不成立**（见 §三.3 实测：解压场景 crate 反而更快或持平）。
- 当前二进制体积基线：**10.9 MB**（macOS arm64，release，strip 后）。
- **DEFLATE 解压代码已经在二进制里**：`ureq`（gzip 特性）和 `image`→`png` 都在运行时链入 `flate2`（miniz_oxide 后端）+ `crc32fast`。`encoding_rs`（GBK/Big5/Shift_JIS）也已因 v0.21.1 文本比较在依赖里。这是体积评估的关键前提。

## 二、系统命令能力矩阵（实测 / 查证）

### macOS（bsdtar 3.5.3 + libarchive 3.7.4，全部系统自带）

| 格式 | 命令 | 备注 |
|---|---|---|
| zip | `ditto -x -k` / `tar -xf` / `unzip` | ditto **自动识别 GBK 文件名**；tar 默认遇 GBK 报 `Illegal byte sequence`，加 `--options hdrcharset=GBK` 可解 |
| tar / tgz / tbz / txz | `tar -xf` | libarchive 自动识别格式+过滤器 |
| 单文件 .gz/.bz2/.xz | `gunzip -c` 等 | ⚠️ `tar -xf x.gz` 会被误判为 mtree 留下垃圾文件，必须用 gunzip 系列 |
| 7z | `tar -xf` | libarchive 内建 7z 读取器（不支持加密 7z） |
| rar / rar5 | `tar -xf` | libarchive 内建 rar + rar5 读取器（不支持加密 rar） |
| 加密 zip | `tar --passphrase` / `unzip -P` | ditto 不支持；**不给密码时 tar 陷入 `Enter passphrase:` 无限循环**（GUI spawn 会卡死，必须先探测加密标志） |
| 加密 rar / 7z | 无 | 系统命令全线不支持 |

### Windows（tar.exe = bsdtar，随版本差异巨大）

| 版本 | libarchive | 能解 | 不能解 |
|---|---|---|---|
| Win10 1803+（已 EOL 但仍有存量） | 3.3.2，**仅 zlib** | zip / tar / tar.gz / rar(v4) | **7z**（LZMA 需 liblzma）、**tar.xz / tar.bz2**、**rar5**（rar5 读取器 3.4.0 才有，WinRAR 5+ 默认 rar5！） |
| Win11 近期版本 | 3.7.2，+liblzma+bz2lib(+zstd) | zip / tar 系 / 7z / rar / rar5（微软官方文档明示 .tar/.tar.gz/.zip/.7z） | 加密 rar/7z |
| PowerShell Expand-Archive | — | 仅 zip | 慢、无密码 |

- Windows 无 gunzip/bunzip2/xz：单文件 .gz 只能 PowerShell `GZipStream`，.bz2/.xz 无解。
- 文件名编码：libarchive on Windows 用系统 ANSI 代码页 → **简中系统上 GBK zip 天然正常**（与资源管理器行为一致）。
- 参考：[Microsoft Learn – tar on Windows](https://learn.microsoft.com/en-us/windows/tar)、[Windows 11 23H2 libarchive 原生 rar/7z 公告](https://www.techzine.eu/news/applications/112664/windows-11-finally-adds-native-rar-and-7-zip-support-after-nearly-30-years)。

## 三、Rust crate 路线实测数据

### 1. 增量体积（基准工程实测，与项目相同 release profile：lto=thin / codegen-units=1 / opt-level=3 / panic=abort / strip）

基准 `base` = flate2(miniz_oxide) + crc32fast（**这两样已因 image/ureq 链入主程序**），384 KB。

| 组合 | 二进制 | 相对 base 增量 | 占当前 10.9MB |
|---|---|---|---|
| + `tar`（tar/tgz 读取） | 437 KB | **+52 KB** | 0.5% |
| + `zip`（`default-features=false, features=["deflate-flate2"]`） | 471 KB | **+85 KB** | 0.8% |
| + `zip`（**默认全特性**：zopfli、zlib-rs、aes、bzip2、lzma、zstd、ppmd…） | 738 KB | +346 KB ⚠️ 且引入第二套 DEFLATE（zlib-rs） | 3.2% |
| + `sevenz-rust2`（lean：`default-features=false, features=["util"]`） | 555 KB | +167 KB | 1.5% |
| + `sevenz-rust2`（默认含压缩器/aes/ppmd） | 622 KB | +232 KB | 2.1% |
| + `unrar`（官方 unrar C++ 源码经 cc 编入） | 558 KB | **+170 KB** | 1.6% |
| 全家桶 lean（tar + bzip2 + liblzma(static) + zip lean + 7z lean + unrar） | 1068 KB | **+668 KB ≈ 6.1%** | 6.1% |

**重点结论**：
- 最小可用集（zip + tar + gz）只需 **+140 KB（1.3%）**——DEFLATE 已在，几乎白送。
- 全格式也只 **+668 KB（6.1%）**，DMG/MSI 压缩后约 +300 KB，相对 WebView 可忽略。
- **必须手动指定 feature**：zip 9 默认 `deflate` 走 `flate2/zlib-rs`，会与项目现有的 miniz_oxide 形成**两套 DEFLATE 并存**（+260 KB 纯浪费）。lean 写法：`zip = { default-features = false, features = ["deflate-flate2"] }`（flate2 默认落 miniz_oxide 后端，与现状共享）。
- zip 9.x 的 `name()` 返回 `Result<Cow<str>>`：文件名解码可能失败——正好配合 `name_raw()` + 项目已有的 `encoding_rs` 做 GBK/Big5/SJIS 解码与自动探测。

### 2. 许可

- `zip` / `tar` / `flate2` / `bzip2`(libbz2-rs) / `sevenz-rust2`：MIT/Apache，无问题。
- `unrar`：包装是 MIT/Apache，内嵌官方 unrar C++ 是 **unrar 许可**——免费用于解压、禁止用于重建 RAR 压缩算法。**只做解压分发无问题**。需要 C++ 工具链（Tauri 本来就要求 MSVC / Xcode CLT，无新增门槛）。

### 3. 解压速度实测（秒，本机）

| 负载 | ditto | tar(libarchive) | unzip | zip crate(lean) | tar crate+flate2 |
|---|---|---|---|---|---|
| 5000 个小文件 zip | 2.75 | 1.98 | 1.30 | **0.76** | — |
| 150MB 单文件 zip | 0.18 | **0.17** | 0.67 | 0.28 | — |
| 5000 个小文件 tgz | — | 1.52 | — | — | **1.06** |
| 150MB 单文件 tgz | — | **0.10** | — | — | 0.15 |

v0.9「系统命令快很多」**只对压缩成立**；解压场景 crate 在大批小文件上快 2–3 倍（系统工具逐文件处理 xattr/元数据开销大），大文件差距 ±0.1s 量级，可忽略。

### 4. 边缘行为实测

| 场景 | 系统命令 | Rust crate |
|---|---|---|
| GBK 文件名 zip（简中系统） | macOS ditto ✓（单一传统编码回退，Big5/SJIS ✗）；tar 需 hdrcharset 重试；unzip ✗ | 默认 cp437 乱码；**`name_raw()`+`encoding_rs` 可修正并做自动探测（UTF-8→GBK→Big5→SJIS）** ✓ |
| macOS `__MACOSX/._*` 元数据 | 系统 tar/ditto 自动还原为 xattr/不落地 | **会当普通文件释放**，需手动过滤（后缀/前缀规则，十几行代码） |
| zip-slip（`../` 路径穿越） | bsdtar 有防护 | `zip::extract()` / `tar::unpack()` 内建防护 |
| 加密 zip | tar `--passphrase` ✓，但**不传密码会无限交互循环**（需先探测 flag bit 0） | `aes-crypto`/`aes256` feature 直接支持，报错可控，可弹密码框重试 |
| 进度/取消 | 仅起止两次事件（v0.8 压缩同款限制） | 逐条目回调，天然接 `TransferProgress` 与取消 |
| 结构化列表（浏览/预览） | 只能解析 `tar -tv` 文本输出，脆弱（ditto 无列表模式） | 天然结构化（名称/大小/时间/是否目录） |
| Win10 兼容 | 7z/xz/bz2/rar5 硬缺口 | 无缺口，全版本一致 |

## 四、三条路线评估

### 路线 A：纯系统命令（延续 v0.8/0.9 压缩的做法）
- ✅ 体积 +0；macOS/Win11 格式覆盖意外地全（连 rar/7z 都能解）。
- ❌ Win10 硬缺口（7z/xz/bz2/rar5）；单文件 gz 要 gunzip；rar5 在 Win10 不支持。
- ❌ 无列表 → 「智能解压」「查看内容」「归档浏览」全做不了；进度只有起止；密码要先探测否则死循环——探测本身就得读 zip 头，等于半只脚踏进 crate 路线。
- ❌ 编码策略拼凑（ditto 回退 + tar hdrcharset 重试），且 ditto 的回退只认系统区域一种传统编码。

### 路线 B：纯 Rust crate
- ✅ +140 KB 起（1.3%），全格式 +668 KB（6.1%）——**体积根本不是问题**，这是本次评估推翻的最大预设。
- ✅ 列表/进度/取消/密码/编码全部结构化可控，Win/mac 版本行为一致。
- ✅ 速度不输甚至更快。
- ❌ 要自己处理 `__MACOSX` 过滤等 macOS 细节；unrar 需 C++ 工具链与 unrar 许可声明。

### 路线 C：混合（推荐）
1. **zip / tar 家族 / 单文件 gz 用 crate**：`zip(lean)` + `tar` + 复用已有 `flate2`，+140 KB；需要 bz2/xz 再各加 `bzip2` + `liblzma`（约 +150 KB）。
2. **rar / 7z 低频格式本期走系统 `tar -xf`**（macOS/Win11 均可用），失败或 Win10 环境给出明确「不支持/建议装解压工具」提示；后续按用户反馈决定是否上 `unrar` / `sevenz-rust2`（各 +170 KB，做成 feature，照 `sftp`/`share` 的 `lightweight-build` 惯例）。
3. **压缩（打包）保持系统命令不动**——v0.9 的结论对压缩仍然成立，本次只改解压。

## 五、交互设计思路

右键压缩包（`filekind.ts` 的 `archive` 判定已覆盖 zip/rar/7z/tar/gz/bz2/xz/tgz）：

- **解压到此处**：智能策略——归档只有一个顶层目录 → 就地释放；多顶层条目 → 建 `<归档名>/` 再释放（防 tar 炸弹，与 Finder 归档实用工具/WinRAR 一致）。
- **解压到 `<归档名>/`**：显式同名文件夹（WinRAR 惯例）。
- **解压到…**：目录选择（`tauri-plugin-dialog` 已有）。
- 同名冲突：复用 `unique_dest`（`name (2)` 惯例）；可选接现有 ConflictDialog。
- 加密包：解压前探测（crate 直接报错类型 / zip 头 flag bit 0）→ 复用现有 `PasswordDialog` 组件，密码错可重试。
- 进度：`progress.rs` 新增 `extract` 类型，逐条目回调，状态栏/浮层复用现有管线。
- 菜单位置：`EntryContextMenu.tsx`「压缩为」MenuGroup 旁加「解压」组（`FileList.tsx` 里还有一处折叠菜单同步）；仅 `archive` 类型且非目录时显示。
- 后续版本：「查看内容」预览弹窗（crate 结构化列表免费）；更远期「进入压缩包像目录一样浏览」做 `archive://` 协议内置插件（`plugins.rs` 注册表现成，与 sftp/http 同构）。
- 可选项（设置）：解压后归档移入回收站（`trash` crate 已有）。

## 六、坑清单（实现时必须处理）

1. zip lean feature 写法，避免 zlib-rs 双 DEFLATE。
2. `__MACOSX/` 与 `._*` AppleDouble 过滤。
3. GBK/Big5/SJIS 文件名：UTF-8 标志位优先，无标志走 `name_raw()` + `encoding_rs` 自动探测；探测失败回退 cp437。
4. zip-slip：依赖 crate 内建防护 + 释放路径二次校验。
5. 超大归档解压放 `spawn_blocking`（同 compress 模式），进度逐条目 emit 节流。
6. rar/7z 系统命令回退时：先探测是否加密（不支持时直接提示，别让 tar 陷入密码循环）；Win10 无 liblzma 时 7z 失败要给可读错误。
7. 单文件 .gz（非 tar 包）：flate2 `GzDecoder` 直解，别用 `tar -xf`。
8. feature 化（`archive` 或并入现有结构），`--no-default-features` 四组合照 `lightweight-build.md` 惯例回归。

## 七、建议版本切分

- **v0.32.0（本期）**：路线 C 第 1+2 步。解压 zip/tar/tgz/tbz/txz/gz（crate）+ rar/7z（系统 tar，可用性探测）+ 智能「解压到此处」/「解压到同名文件夹」/「解压到…」+ 进度 + GBK 修正 + 密码 zip（含 AES）+ `__MACOSX` 过滤。体积增量约 **+140–290 KB（1.3–2.7%）**。
- **v0.33+**：「查看内容」预览弹窗；`unrar` / `sevenz-rust2` feature（各 +170 KB）补齐 Win10 与加密 rar/7z；`archive://` 浏览插件。

---
*基准工程留存于 `/tmp/rdir-archive-bench/`（base / w_tar / w_zip_lean / w_zip_default / w_7z_lean / w_7z_default / w_rar / w_all_lean），可 `cargo build --release -p <name>` 复测。注意必须逐包单独构建，工作区整建会把 feature 统一掉，测不出 lean 差异。*
