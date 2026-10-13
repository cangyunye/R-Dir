# 文件类型图标全新设计 + 大图标模式 + 画廊模式（v0.27.0）设计稿

- 日期：2026-10-13
- 版本：v0.27.0
- 状态：已实现（本文件随实现同步修订）

## 目标

1. 全新 13 类文件类型图标（蓝紫渐变拟物风，与应用图标 v0.26 同源），大（128/256）小（16/32）两种尺寸。
2. **大图标模式**（icons）：访达式图标网格，图标可自由拖动摆放（吸附槽位、位置持久化）。
3. **画廊模式**（gallery）：缩略图墙，图片条目显示真实内容缩略图，其余渲染大类型图标。

## 资产管线（assets-src，仓库外）

```
assets-src/fileicons/
  origin/       26 张豆包生成原图（384×384，棋盘格底 + 平台水印）
  selected/     每类 1 张选定来源（语义命名，由 origin 复制）
  masters/      1024×1024 透明底主图（process_masters.py 产出）
  masters_v1/   旧版主图存档（洪泛算法吃穿白纸，仅存档）
  process_masters.py   v2 处理脚本（见下）
alternates/     落选候选
```

### process_masters.py（v2，macOS Vision 分割）

v1 的边界洪泛去背景在"白纸 vs 棋盘格浅格"上必然失败（色差 ~13，任何阈值要么吃掉纸面要么留底）。v2 改用 **macOS Vision `VNGenerateForegroundInstanceMaskRequest`**（PyObjC 桥接，无需下载模型）做语义主体分割：

- `obs.instanceMask()` 取 512×512 二值掩码（0/1），`CVPixelBufferGetBaseAddress().as_buffer(n)` 读缓冲，×255 后高斯 1.0 软化、BILINEAR 放大回 384；
- 后处理链（对两条路径共用）：最大连通域过滤（除豆包水印与棋盘残点）→ MinFilter(3) 腐蚀 ×erode → 高斯羽化 → bbox 裁切 → 1024 画布居中（9% padding）；
- PyObjC/Vision 不可用时自动降级为经典路径（gradient 门控 + 平坦度图案门 + 二遍阴影洪泛，键于直方图峰值法估计的暗格 tone）——该路径单独可用但边缘质量次于 Vision。

### 导出（tools/export-fileicons.sh）

PIL Lanczos 缩放出 4 档入仓库 `src/assets/fileicons/`：`{kind}-lg.png 128 / -lg@2x.png 256 / -sm.png 16 / -sm@2x.png 32`；若存在 `{kind}-sm-src.png` 简化版则小图优先用它。改动图标只需重跑该脚本，零代码变更。

**教训（首版踩坑，深色模式白纸图标只剩描边的根因）**：① 导出脚本最初用 sips——sips 缩放 RGBA 会损坏 alpha 通道（大面积不透明区域被错误半透明化）；② 更隐蔽的是脚本最初读的是仓库顶层遗留的 13 张旧 v1 master（上个会话残留），而非修复后的 `masters/`——两层问题叠加，验收时只看了 masters 明暗对照表没查导出物，被用户在真实深色模式下抓到。修复后验收必须包含「导出物中心 alpha 断言 + 深色底渲染对照」。

### 类型分类（src/lib/filekind.ts）

13 类：folder / image / video / audio / archive / code / doc / sheet / slide / text / **pdf（新增）** / **app（exe msi dmg app deb appimage apk rpm pkg，新增）** / file（兜底）。`fileKindOf()` 是图标渲染、缩略图资格（THUMBNAIL_KINDS，v0.27 仅 image）、画廊回退的统一依据。

## 视图模式基础设施

- `PaneState.viewMode: "details" | "icons" | "gallery"`（每窗格独立，默认 details）+ `iconSize: 48|64|96|128`（默认 64）。
- 会话持久化：`SessionPane.viewMode/iconSize`（serialize/restore 带越界校验）。
- 切换入口四处：PaneHead 右侧三段钮（`data-view-switch`）、AppMenu 查看 组（勾选态）、命令面板（ACTIONS 自动进入）、快捷键 `viewDetails/viewIcons/viewGallery` = **Alt+1/2/3**（⌘1-9 已被标签跳转占用）。

## 大图标模式（src/components/IconGrid.tsx）

- **布局**：槽位坐标 `{列,行}` 绝对定位网格（非 CSS grid，便于自由摆放与按行带虚拟化）；单元尺寸由图标档位推出（`gridCell`），列数随容器宽（`gridCols`）；按行带虚拟滚动（`visibleGridRange`，±4 行），三者均为 lib/virtual-scroll 纯函数（有单测）。
- **自由摆放**：`layoutSlots()` 已存记录优先落位、其余首个空槽补位；拖动松手按落点槽位写入（多选按序展开、被占槽跳过、原位拖动零写入）；空白右键「整理图标」清空该目录记录回自动排列。
- **位置存储**：访达用 .DS_Store，本应用选择**集中存储**（不污染被浏览目录、SFTP 远程目录同样生效）：应用数据目录 `icon-positions.json`，结构 `目录路径 → 条目名 → [列,行]`；Rust `iconpos.rs` 提供 `icon_positions_load/save`（写侧临时文件+原子改名）；App 集中持表 + 600ms 防抖整表写回。目录改名/移动后记录失效 → 自动退回自动排列（无副作用）。
- **拖拽**（自研鼠标拖拽，同 FileList 骨架）：按下未选中图标 = 立即选中并成为拖拽候选（访达语义，与列表视图的"未选中按下=框选"不同）；落点三分类——文件夹图标（`data-drop-dir`，悬停高亮）→ `onDropIntoDir` 移入/复制（Alt=移动）；其他窗格 → 既有 `onDropPaths`；同窗格空槽 → 重摆。App 侧 `transferPaths`（从 doDropPaths 抽出，dest 显式给定）承载前两类。
- **键盘**：方向键槽位导航（左右越界不动、上下跨行跳空洞）、Enter 打开、Space 加选；全局 ⌘A/F2/Esc 等经既有动作分发自然生效。
- **复用**：条目右键菜单抽为 `EntryContextMenuContent`（与 FileList 行菜单同内容，含打开方式/终端/压缩/比较/标签组）；慢速双击重命名 + RenameInput、橡皮筋框选（几何命中）、TagDots、Ctrl+滚轮切图标档位（带 px 提示浮层）均保留。
- **v0.27 明确不做**：图标视图拖出到访达（条目未启用 HTML5 draggable，规避 macOS 双拖拽体系冲突）、QuickJump、视频帧缩略图。

## 画廊模式

- 与大图标共用 IconGrid，仅单元格内容不同：`THUMBNAIL_KINDS`（image）→ `ThumbImage`，其余 → 大类型图标。
- **Rust `thumbs.rs`**：`thumb_get(path, size)`，`image` crate（png/jpeg/gif/webp/bmp/tiff 特性）解码 → `thumbnail(size)` → PNG → base64 data URL 返回（**不启用 asset protocol、不改 capabilities**）；缓存 `app_data_dir/thumbs/{hash(路径|mtime|尺寸)}.png`（写侧原子改名）；解码失败返回 `Ok(None)` 前端回退图标；`spawn_blocking` 不卡主线程；SFTP/HTTP 路径直接 None（远程缩略图后续版本接 sftp_download 链路）。
- **前端 `ThumbImage`**：IntersectionObserver 懒加载（rootMargin 256px；无 IO 环境直接可见）+ 内存 LRU 256 条（key=路径|mtime）+ 脉冲占位。

## 交付顺序（实际执行）

git pull → 资产分类 + Vision 处理脚本 → 导出验收（16/32px 明暗对照表）→ filekind/FileIcon → viewMode 基础设施 → IconGrid + 位置存储 → 缩略图 → 测试（单测 424 / e2e 91 全绿）→ 版本号/CHANGELOG。

## 三轮修订（用户反馈，2026-10-13）

1. **26 张生成图全部盘点并利用 24 张**：首轮只用 13 张（每类一张），其余躺在 origin/alternates。逐张目检后重新分配：13 张做各类型大图；11 张更简洁/粗轮廓的变体做 16px 专用小图源（`selected/{kind}-sm.png` → `masters/{kind}-sm-src.png`，处理管线与导出自动优先）——文件夹用干净闭合版（ea4742fa）、代码用粗箭头贴片版（3f4e6f03）、音频用亮色版（7b0ffaf5）、图片用绿框版（55cb1515）等；仅 app 色相反转版（3e8772f0）与 pdf 华丽绶带版（009629f0）因与在用大小尺寸设计不一致留作存档。16px 辨识度验收明显优于直接降采样。
2. **画廊模式暂不开放**：内测在无媒体目录里与大图标观感无差。切换器/菜单/快捷键全部不出现（keymap 移除 viewGallery，Alt+3 无绑定），旧会话 gallery 归化为 icons；缩略图管线（含 QuickLook PDF/视频/文档）与 IconGrid gallery 分支完整保留，放开 = 切换器数组加回一项。

## 二轮修订（用户反馈，2026-10-13）

1. **深色模式 file/pdf 图标只剩描边**：见上（sips alpha 损坏 + 顶层旧 master 污染导出链路）。
2. **大图标右键「自动排列」**：访达「保持排列方式」语义——按目录记忆（localStorage `rfm.icon-auto-arrange`），开启后忽略摆放记录、拖动不再改位；「整理图标」保留（清空记录）。
3. **文件名截断观感**：`break-all` 逐字符断行改为 `break-words` 按词断行 + 两行截断 + title 悬停全名。
4. **画廊与大图标无区分**：纯配置文件目录下两者本来就只能显示类型图标（语义如此）；缩略图类型从 image 扩展到 **video/pdf/doc/sheet/slide**——走 macOS QuickLook（`QLThumbnailGenerator.saveBestRepresentation` 落临时 PNG），单测用手工最小 PDF 验证。视频帧缩略图因此顺带实现（macOS）。

## 踩坑记录

1. 洪泛去背景对"白纸 on 浅棋盘格"无解（色差过小），v1 主图 5 类纸面被吃穿 —— 换 Vision 分割根治。
2. 豆包水印（右下角"豆包AI生成"）与棋盘格假阴影必须由连通域过滤清除，不能靠阈值。
3. PyObjC 的 `void*` 返回 `objc.varlist`，要 `.as_buffer(n)` 取字节；`instanceMask` 是二值 {0,1} 而非 0-255 软掩码。
4. 重构 `doDropPaths` → `transferPaths` 时把 useCallback 依赖误改为 `[transferPaths]` 丢失 `tabs`，跨窗格拖拽全部静默失效 —— 被 e2e R18 抓住。教训：抽函数时闭包依赖要逐个核对。
5. objc2 生成 crate 的方法可见性受特性门控（如 QL 的 `initWithFileAtURL...` 需 `objc2-core-foundation` 特性），特性开齐后个别方法仍不可见时（本例 init）用 `objc2::msg_send!` 直发等价消息绕过；`void*` 返回的 varlist 用 `.as_buffer(n)` 取字节。
5. jsdom 无 IntersectionObserver，ThumbImage 需守卫。

## 后续（未排期）

FileList 行菜单与 EntryContextMenuContent 合并（当前双份）；QuickJump 接入图标视图；SFTP 远程缩略图（复用 sftp_download 临时文件链路）；视频帧缩略图（ffmpeg 依赖需评估）；图标位置表随目录改名迁移。
