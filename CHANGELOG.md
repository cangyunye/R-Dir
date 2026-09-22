# 更新日志

本文件按版本记录变更。发布时 `release.yml` 的 publish 步骤会自动把对应段落写入
GitHub Release 说明（release notes），因此每次发版前请先在这里补一段。

格式：`## vX.Y.Z (YYYY-MM-DD)`，段落之间用下一个 `## ` 标题分隔。

## v0.12.2 (2026-09-22)

- **修复 Windows 升级安装失败**：此前同时发布 MSI 与 NSIS 两种安装包，用户若先装 MSI、再用 NSIS 安装包升级，NSIS 会去卸载 MSI（`msiexec` 需要提权）而失败并弹出「Error launching installer」。现 Windows **只发布 NSIS `-setup.exe`**，从源头避免两种安装包混装。
- **发布说明自动带变更日志**：Release 页面现在会显示本文件对应版本的变更段落，不再只有通用功能清单。

## v0.12.1 (2026-09-22)

- 设置对话框新增「关于」分区：显示应用名与版本（取自应用元数据，随发布 tag 同步），并提供「检查更新 / GitHub 仓库」入口；底部状态栏显示 `R-Dir vX.Y.Z`。
- 发布流程新增「版本以 tag 为准」步骤：打 tag 时自动把 `vX.Y.Z` 写入 `package.json / tauri.conf.json / Cargo.toml`，杜绝程序内版本与 tag 不一致。

## v0.12.0 (2026-09-21)

- 搜索结果右键菜单：定位到文件/文件夹、打开（默认应用）、复制绝对路径、复制相对路径；双击按扩展名用系统关联程序打开。
- 标签视图右键菜单：打开 / 默认应用打开 / 定位 / 标签 / 复制路径 / 快捷访问 / 移除此标签；正确区分标签内的文件夹与文件。
- Windows 应用名识别：标题统一为 R-Dir，补全可执行文件版本元数据，并在启动时设置 AppUserModelID。
- 帮助菜单：GitHub 仓库 + 基于 GitHub Releases 的更新检测。
- 内部重构：移除未使用的 shadcn 组件与死代码，抽取 `useSftp`，补齐测试基建。
