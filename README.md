# R-Dir

**R-Dir** 是一款基于 **Tauri 2 + Rust + React** 构建的跨平台文件管理器（Windows / macOS），轻量快速、界面清爽。

> 📖 **使用手册与功能图解请移步 → [R-Dir 使用手册](https://cangyunye.github.io/R-Dir-Docs/)**（[使用指南](https://cangyunye.github.io/R-Dir-Docs/guide.html) · [功能演示截图](https://cangyunye.github.io/R-Dir-Docs/shots.html) · [快捷键速查](https://cangyunye.github.io/R-Dir-Docs/keys.html)）
> 🚀 安装包下载见 [Releases](https://github.com/cangyunye/R-Dir/releases)，逐版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 界面预览

| 主界面 | 深色主题 · 大图标视图 |
| --- | --- |
| ![主界面](https://cangyunye.github.io/R-Dir-Docs/shots/01-main-light.png) | ![深色主题](https://cangyunye.github.io/R-Dir-Docs/shots/19-dark-main.png) |
| **左右分屏 · 彩色标签页** | **SFTP 远程连接** |
| ![左右分屏](https://cangyunye.github.io/R-Dir-Docs/shots/07-split-row.png) | ![SFTP 远程](https://cangyunye.github.io/R-Dir-Docs/shots/21-sftp-kali-connected.png) |

## 功能一览

- **多标签 + 分屏**：彩色标签页、拖拽排序、双击重命名；VSCode 式左右 / 上下 / 四宫格分屏，跨窗格拖拽即复制（按 Option/Alt 移动）。
- **浏览与导航**：面包屑地址栏与路径补全、QuickJump 键入即达的模糊定位、侧边栏快速访问 / 磁盘 / Finder 式彩色标签 / 远程服务器、大目录虚拟滚动。
- **文件操作**：复制 / 剪切 / 粘贴（与系统剪贴板互通）、撤销 / 重做、同名冲突裁决、传输进度与取消、压缩为 zip / tar / tgz、回收站删除、目录属性递归统计。
- **双引擎搜索**：文件名递归检索（fd 引擎，尊重 `.gitignore`）+ VSCode 风格内容搜索（行号高亮），大小写 / 正则 / 隐藏文件随心切换。
- **比较与同步**：目录差异比对与多选双向同步、按标签同步浏览联动导航、任意两文件行级文本 diff（UTF-8 / GBK / Big5 / Shift_JIS 等多编码）。
- **远程与网络**：SFTP / SSH 双认证（密码 AES-GCM 加密存储）、HTTP autoindex 目录浏览与断点续传下载、目录 HTTP 分享（token 凭证 + 二维码 + 访问日志）。
- **打开方式与终端**：按扩展名自定义打开方式、右键在系统终端打开当前目录、地址栏直达 PATH 命令。
- **外观与效率**：深 / 浅 / 跟随系统主题、命令面板（`⌘/Ctrl+K`）、自定义快捷键（冲突检测）、窗口缩放、会话保存与恢复、应用内检查更新。
- **国际化**：简体中文 / 繁體中文 / English / Deutsch / 日本語 / Português / Español。

完整功能细节与操作图解见 [使用手册](https://cangyunye.github.io/R-Dir-Docs/guide.html)。

## 安装

从 [Releases](https://github.com/cangyunye/R-Dir/releases) 下载对应平台安装包：

- **Windows**：`R-Dir_x.y.z_x64-setup.exe`（NSIS 安装包）。若从旧版 `.msi` 升级时弹出「Error launching installer」，先在系统设置中卸载旧版，再运行新的 `-setup.exe`，之后即可正常覆盖升级。
- **macOS**：应用未使用 Apple 证书签名，首次打开若提示「已损坏，无法打开」，执行 `xattr -cr /Applications/R-Dir.app`，或右键应用 →「打开」→ 确认。

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发模式（热更新）
pnpm tauri build    # 打包
```

测试：`pnpm test`（Vitest 单元）· `pnpm test:e2e`（Playwright）· `cargo test`（Rust，在 `src-tauri`）。

技术栈：Tauri 2 · Rust · React · TypeScript · Tailwind v4 · shadcn/ui。
