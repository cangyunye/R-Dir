R-Dir 绿色版（免安装）
========================

【使用方式】
双击 R-Dir.exe 即可运行，无需安装、不写注册表、无后台服务。

【数据存放（便携模式）】
本目录下的 R-Dir.portable 是便携模式标记文件（内容为空，请勿删除）：
- 全部配置（会话 / 标签 / 收藏夹 / 服务器清单 / 主题 / 插件）都保存在
  本目录的 data\ 文件夹内，随目录整体搬迁、复制即迁移；
- 删除整个目录 = 完全卸载，不留残余；
- 删除标记文件则回到安装版行为，数据改用 %APPDATA%\com.rfm.app。

【系统要求】
- Windows 10 / 11（x64）；
- 需系统已有 WebView2 Runtime（Win11 自带；个别精简版 Win10 缺失时，
  请安装 Evergreen Runtime：https://developer.microsoft.com/microsoft-edge/webview2/ ）。

【注意】
- 请勿在只读介质（部分网络盘 / 写保护 U 盘）上运行，便携模式需要写入 data\ 目录；
- 程序未做代码签名，首次运行可能触发 SmartScreen 提示，点「仍要运行」即可；
- 更新请前往项目 Releases 页下载新版绿色包，解压覆盖（data\ 目录会保留）。
