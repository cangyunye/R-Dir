# 轻量编译说明（Feature 裁剪）

> R-Dir 官方 Release 只提供**完整版本**（包含全部内置插件）。
> 本文面向自行编译的用户：如何通过 Cargo feature 裁剪内置插件，得到更小的二进制。
> 完整版 vs 轻量版的差别仅是**编译期是否包含对应插件代码**，不影响基础文件管理功能。

## 内置插件与 feature 对照

| 插件 | feature | 依赖 | 说明 |
|---|---|---|---|
| SFTP / SSH 远程文件 | `sftp` | russh、aes-gcm、tokio 等 | 远程目录读写、密钥/密码连接 |
| 窗口分享（v0.7） | `share` | axum、tokio 等 | 分享当前目录（HTTP 服务 + 断点续传） |
| HTTP autoindex（nginx） | `http`（计划中） | ureq（rustls） | 解析 `autoindex on` 索引页、下载 |

**现状说明**：`sftp` 与 `share` 已 feature 化（可裁剪）；`http_autoindex` 目前
无条件编译（未做 feature 门控）。下方"裁掉 http"一节暂不可用，仅作未来规划。

## 编译命令

```bash
# 完整版（默认，与官方 Release 一致）
cargo build --release
# 或显式指定：
cargo build --release --features "sftp,share"

# 纯基础版（无 SFTP / 分享 / HTTP）
cargo build --release --no-default-features

# 只带 SFTP（适合需要远程管理、不需要分享的用户）
cargo build --release --no-default-features --features sftp

# 只带窗口分享（适合只做局域网共享的用户）
cargo build --release --no-default-features --features share
```

## 裁剪后的差异

| 项 | 完整版 | 纯基础版（示例） |
|---|---|---|
| 二进制体积 | ~9MB | 明显更小 |
| 侧边栏 SFTP 入口 | 有 | 无 |
| 分享（Share）菜单 | 有 | 无 |
| HTTP 地址栏访问 | 有 | 无 |

> ⚠️ 前端契约：后端未编译的命令，前端 `invoke` 会返回错误。裁剪版本中，
> 侧边栏 SFTP 分组、分享入口等 UI 仍会显示，点击后提示命令不可用。
> 这是当前"编译期裁剪"与"前端感知"的已知差距——`list_plugins` 未来将改为
> 返回编译期实际存在的插件，让前端自动隐藏不可用入口（v0.5 插件注册表规划）。

## 官方 Release 策略

- 官方只发布**完整版**（`default = ["sftp", "share"]`），保证功能一致性。
- 未来如需多变体发布（完整版 / 轻量版），在 CI matrix 中追加
  `--no-default-features` 组合并区分产物命名即可，仓库已预留该能力。

## 验证裁剪是否生效

```bash
# 查看当前 feature 树
cargo tree -e features --features sftp
cargo tree -e features --no-default-features

# 产物内检索符号（PowerShell）
python -c "d=open(r'target\release\R-Dir.exe','rb').read(); print(b'sftp_list_servers' in d)"
```

## 已知限制

1. `http_autoindex` 尚未 feature 化（依赖 ureq 非 optional），未来需要时补 `http` feature。
2. 裁剪版本前端未隐藏不可用入口（见上表提示）。
3. `tokio` 由 sftp/share 共享，裁掉两者后 tokio 也会被剔除，体积收益最大。
