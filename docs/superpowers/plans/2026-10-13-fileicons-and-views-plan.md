# 文件类型图标 + 大图标模式 + 画廊模式 实施计划（v0.27.0）

- 日期：2026-10-13
- 设计稿：`docs/superpowers/specs/2026-10-13-fileicons-and-views-design.md`
- 状态：已全部完成

## 任务清单

| # | 任务 | 状态 |
|---|---|---|
| 1 | git pull（本地与 origin 同步于 d081dd8f） | ✅ |
| 2 | 资产：origin 26 张全量分类 → 13 类选定来源（`selected/`） | ✅ |
| 3 | 资产：process_masters.py v2（Vision 分割 + 连通域去水印 + 羽化归一） | ✅ |
| 4 | 资产：export-fileicons.sh 导出 128/256/16/32 到 `src/assets/fileicons/`（52 个 PNG） | ✅ |
| 5 | 资产：16/32px 明暗背景对照验收（13 类全部可辨识，无需第二轮生成） | ✅ |
| 6 | `src/lib/filekind.ts` 13 类分类 + `FileIcon` 资产化（srcSet、lucide 回退） | ✅ |
| 7 | `PaneState.viewMode/iconSize` + SessionPane 序列化/恢复 + 越界校验 | ✅ |
| 8 | 切换入口：PaneHead 三段钮 / AppMenu / 命令面板 / Alt+1/2/3（keymap） | ✅ |
| 9 | `lib/virtual-scroll.ts` 网格纯函数（gridCell/gridCols/visibleGridRange）+ 单测 | ✅ |
| 10 | `IconGrid.tsx`：网格渲染、虚拟化、框选、慢速双击重命名、右键菜单、键盘导航 | ✅ |
| 11 | 自由摆放：layoutSlots 补位算法 + 拖动写入 + 整理图标 | ✅ |
| 12 | Rust `iconpos.rs`（icon_positions_load/save，原子写）+ api.ts 封装 + 防抖整表写回 | ✅ |
| 13 | 拖到文件夹图标移入/复制：App `transferPaths` 抽取 + `doDropIntoDir` | ✅ |
| 14 | Rust `thumbs.rs`（thumb_get，image crate + 磁盘缓存 + base64） | ✅ |
| 15 | `ThumbImage.tsx`（懒加载 + LRU + 占位回退） | ✅ |
| 16 | e2e 第 28 段（V1–V6）+ tauri-mock 桩（icon_positions_* / thumb_get） | ✅ |
| 17 | 测试：filekind / virtual-scroll-grid / layoutSlots / IconGrid 组件（新增 5 文件） | ✅ |
| 18 | 版本号四处同步 0.26.1 → 0.27.0；CHANGELOG v0.27.0 段；user-guide；FEATURE-REGRESSION | ✅ |

## 验证

- `pnpm vitest run`：35 文件 424 用例全过（含新增 filekind/grid/slots/IconGrid）
- `pnpm test:e2e`：91 用例全过（含新增 28 段 V1–V6）
- `npx tsc --noEmit` 干净；`pnpm build` 通过；`cargo check` 通过
- 图标验收：masters 明暗双底对照表 + 16/32px 放大对照表人工目检

## 已知边界（记录于设计稿「后续」）

QuickJump 未接入图标视图；图标视图不支持拖出到访达；SFTP 远程目录画廊模式显示类型图标；FileList 行菜单与共享菜单组件暂存双份。
