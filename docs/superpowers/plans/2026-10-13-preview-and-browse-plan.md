# 任务表：文件预览栏 + 图文浏览模式（v0.28.0）

设计稿：`specs/2026-10-13-preview-and-browse-design.md`

| # | 任务 | 状态 |
|---|------|------|
| 1 | 设计稿 + 任务表 | ✅ |
| 2 | Rust `preview.rs`（preview_data）+ lib.rs 注册 + e2e 桩 | ✅ |
| 3 | persist.ts `rfm.preview` + keymap togglePreview/toggleBrowse + api previewData | ✅ |
| 4 | SettingsDialog「预览」分区（总开关/键位/宽度） | ✅ |
| 5 | preview/ImageView（缩放平移）+ TextView + DocCard + PreviewBody | ✅ |
| 6 | PreviewDrawer（拉门/把手/拖宽） | ✅ |
| 7 | BrowseMode（沉浸壳 + 缩略图条 + capture 键盘 + 选中同步） | ✅ |
| 8 | App.tsx 接线（状态/分发/挂载；含 Space 让位 plumbing） | ✅ |
| 9 | 单测（persist/keymap/preview 门控）通过（451/38 文件） | ✅ |
| 10 | e2e 用例（开关/空格/浏览模式 7 项）通过（全量 98） | ✅ |
| 11 | Rust cargo test + build 通过（120） | ✅ |
| 12 | user-guide.md / FEATURE-REGRESSION.md 更新 | ✅ |
| 13 | CHANGELOG.md v0.28.0 段 + 四处版本号 0.28.0 | ✅ |

## 修订记录

- 追加：预览启用后 `Space` 让位（`previewSpace` 沿 SplitView→PaneView→FileList/IconGrid 下传），列表/网格空格加选在预览启用时不再触发。
- 追加：e2e 夹具 `Pictures` 目录（多图+文档混排），家目录 5→6 项，smoke 中依赖项数的断言同步更新（W2/L2/V 系列）。

## 验证

- `pnpm test`（vitest）全绿
- `pnpm test:e2e`（Playwright + tauri-mock）全绿
- `cargo test`（src-tauri）全绿
- `pnpm build`（tsc + vite）通过

## 已知边界

见设计稿「已知边界」。
