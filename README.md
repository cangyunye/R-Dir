# R-Dir

**R-Dir** 是一款基于 **Tauri 2 + Rust + React** 构建的跨平台文件管理器（Windows / macOS 桌面应用 + 浏览器 Web 服务 + 免安装便携版），轻量快速、界面清爽。

> 📖 **使用手册与功能图解请移步 → [R-Dir 使用手册](https://cangyunye.github.io/R-Dir-Docs/)**（[使用指南](https://cangyunye.github.io/R-Dir-Docs/guide.html) · [功能演示截图](https://cangyunye.github.io/R-Dir-Docs/shots.html) · [快捷键速查](https://cangyunye.github.io/R-Dir-Docs/keys.html)）
> 🚀 安装包下载见 [Releases](https://github.com/cangyunye/R-Dir/releases)，逐版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 界面预览

| 主界面 | 深色主题 · 大图标视图 |
| --- | --- |
| ![主界面](https://cangyunye.github.io/R-Dir-Docs/shots/01-main-light.png) | ![深色主题](https://cangyunye.github.io/R-Dir-Docs/shots/19-dark-main.png) |
| **左右分屏 · 彩色标签页** | **SFTP 远程连接** |
| ![左右分屏](https://cangyunye.github.io/R-Dir-Docs/shots/07-split-row.png) | ![SFTP 远程](https://cangyunye.github.io/R-Dir-Docs/shots/21-sftp-kali-connected.png) |

## 近期功能更新

| 双引擎搜索 · 灯芯开关 | 标签收藏夹 · 标签页布局快照 | 文件预览 · 图文浏览模式 |
| --- | --- | --- |
| ![搜索灯芯开关](https://cangyunye.github.io/R-Dir-Docs/shots/09-search-panel.png) | ![标签收藏夹](https://cangyunye.github.io/R-Dir-Docs/shots/27-favorites-panel-saved.png) | ![图文浏览模式](https://cangyunye.github.io/R-Dir-Docs/shots/05-browse-mode.png) |
| **SMB 网络共享直连** | **NFS 导出直连** | **标签视图 · Hero 横幅** |
| ![SMB 直连](https://cangyunye.github.io/R-Dir-Docs/shots/54-smb-share-contents.png) | ![NFS 直连](https://cangyunye.github.io/R-Dir-Docs/shots/56-nfs-browse.png) | ![标签视图](https://cangyunye.github.io/R-Dir-Docs/shots/58-tagview-hero.png) |

## 功能一览

- **多标签 + 分屏**：彩色标签页、拖拽排序、双击重命名；VSCode 式左右 / 上下 / 四宫格分屏，跨窗格拖拽即复制（按 Option/Alt 移动）。
- **标签收藏夹**：把整个标签页（含分屏树 / 各窗格路径 / 视图模式）存为命名收藏，`Ctrl+B` 打开面板模糊搜索、一键恢复。
- **标签视图**：Finder 式彩色标签聚合为 `tags://` 虚拟目录，Hero 横幅 / 卡片墙两种形态按标签色渲染，可正常浏览与打开。
- **浏览与导航**：面包屑地址栏与路径补全、QuickJump 键入即达的模糊定位、侧边栏快速访问 / 磁盘 / Finder 式彩色标签 / 远程服务器、大目录虚拟滚动。
- **文件操作**：复制 / 剪切 / 粘贴（与系统剪贴板互通）、撤销 / 重做、同名冲突裁决、传输进度与取消、压缩为 zip / tar / tgz、回收站删除、目录属性递归统计。
- **文件预览**：右侧预览栏拉门（全应用共用，内容跟随焦点窗格），标题栏一键全开 / 全关；图片原图 / GIF 与 txt / md / 代码、数据格式皆可预览，常见代码文件语法高亮（渐进增强、首屏零延迟），未知 / 无扩展名文件自动试探按文本或图片渲染；预览文本可选中复制；图文浏览模式（`Ctrl+Shift+E`）带底部缩略图条翻阅整个目录。
- **双引擎搜索**：文件名递归检索（fd 引擎，尊重 `.gitignore`）+ VSCode 风格内容搜索（行号高亮）；灯芯开关一排点亮递归 / 隐藏 / 大小写 / 正则，组合状态实时可见。
- **比较与同步**：目录差异比对与多选双向同步、按标签同步浏览联动导航、任意两文件行级文本 diff（UTF-8 / GBK / Big5 / Shift_JIS 等多编码）。
- **远程与网络**：SFTP / SSH 双认证（密码 AES-GCM 加密存储）、HTTP autoindex 目录浏览与断点续传下载、目录 HTTP 分享（token 凭证 + 二维码 + 访问日志）。
- **SMB / NFS 直连**：地址栏 `smb://host/share` 直连 Windows 网络共享（UNC 委托，浏览 / 搜索 / 比对 / 传输复用本地引擎全量能力）；`nfs://host/path` 直连 NFSv3 导出（纯 Rust 客户端，全平台可用），NFS 以伴生插件按需安装——设置 → 插件 在线获取或导入 `.rdplugin`。
- **Web 版（rdir-web）**：无窗口 Web 服务，浏览器获得与桌面一致的完整体验——浏览 / 写操作 / SFTP / 比对 / 搜索全量桥接，SFTP 窗格拖拽上传，会话与布局自动保存、跨会话恢复；token 登录（HttpOnly cookie）、可选 `--read-only` 只读门禁、WebSocket 实时事件，不依赖 WebView2、可跑无桌面环境。
- **便携模式**：exe 旁放 `R-Dir.portable` 标记即数据随盘——配置 / 插件 / SFTP 清单全部落在程序目录内，与安装版互不干扰；桌面端与 Web 端可并发运行并共享同一份数据目录。
- **打开方式与终端**：按扩展名自定义打开方式、右键在系统终端打开当前目录、地址栏直达 PATH 命令。
- **外观与效率**：深 / 浅 / 跟随系统主题，主题调色盘自定义色相、主题包导入导出；命令面板（`⌘/Ctrl+K`）、自定义快捷键（冲突检测）、窗口缩放、会话保存与恢复、应用内检查更新。
- **国际化**：简体中文 / 繁體中文 / English / Deutsch / 日本語 / Português / Español。

完整功能细节与操作图解见 [使用手册](https://cangyunye.github.io/R-Dir-Docs/guide.html)。

## 安装

从 [Releases](https://github.com/cangyunye/R-Dir/releases) 下载对应平台安装包：

- **Windows**：安装版 `R-Dir_x.y.z_x64-setup.exe`（NSIS），或免安装绿色版 `R-Dir_x.y.z_windows_x64_portable.zip`（解压即用，内含便携标记，数据随目录存放）。若从旧版 `.msi` 升级时弹出「Error launching installer」，先在系统设置中卸载旧版，再运行新的 `-setup.exe`，之后即可正常覆盖升级。
- **macOS**：应用未使用 Apple 证书签名，首次打开若提示「已损坏，无法打开」，执行 `xattr -cr /Applications/R-Dir.app`，或右键应用 →「打开」→ 确认。

## 开发

```bash
pnpm install
pnpm tauri dev      # 桌面开发模式（热更新）
pnpm tauri build    # 桌面打包
pnpm web            # 无窗口 Web 服务（构建前端 + rdir-web，默认 127.0.0.1:8420）
```

测试：`pnpm test`（Vitest 单元）· `pnpm test:e2e`（Playwright）· `cargo test`（Rust，在 `src-tauri`）。

技术栈：Tauri 2 · Rust · React · TypeScript · Tailwind v4 · shadcn/ui。
