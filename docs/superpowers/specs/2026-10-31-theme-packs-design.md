# 主题包（可安装配色）设计

日期：2026-10-31
状态：已确认（金秋 / 红枫 / 桃花粉作为示例包，不内嵌）

## 目标

- 新增「主题包」：纯数据配色包，可从本地文件安装、删除，不重新编译应用。
- 主题包与内置的浅色 / 深色 / 跟随系统是同一层选择：选中包后由包决定整套配色。
- 设置面板皮肤（云舒云卷 / 黑金纹琉璃）跟随主题包配色，不出现「主界面金秋、设置面板还是蓝色」的割裂。
- 包内不含代码、不注入 CSS 文本，安装风险可控。

## 非目标

- 不做主题商店、URL 安装、zip + 预览图打包。
- 不允许包修改字体、圆角、动画、窗口行为、持久化键。
- 不为单个包提供浅色 / 深色两套配色（包自带 `base` 声明组件明暗变体）。
- 不追求内置默认主题也走包格式（无包 = 现状）。

## 包格式

文件名 `*.rdtheme.json`，UTF-8，≤ 64 KiB：

```json
{
  "$schema": "rdir-theme/1",
  "id": "autumn-gold",
  "name": "金秋",
  "author": "cangyunye",
  "version": "1.0.0",
  "base": "light",
  "tokens": {
    "--background": "oklch(0.975 0.018 85)",
    "--foreground": "oklch(0.27 0.03 65)",
    "--primary": "oklch(0.55 0.14 68)"
  }
}
```

- `id`：必填，`^[a-z0-9][a-z0-9-]{0,63}$`，同时作为磁盘文件名。
- `name`：必填，去首尾空白后非空，≤ 40 字符。
- `base`：`light` | `dark`，缺省 `light`。只用于决定 `<html>` 是否加 `.dark`（组件里 39 处 `dark:` 工具类、标签页与设置面板皮肤依赖该信号）。
- `author` / `version`：可选，仅展示。
- `tokens`：可选（可部分覆盖），key 必须在白名单内，value 为颜色（`--shadow` 为 box-shadow）。
- 缺省 token 回落到 `base` 对应的内置主题；示例包写全。

Token 白名单（与 `src/index.css` 的 `:root` 一致，共 23 个）：
`--background` `--foreground` `--card` `--card-foreground` `--popover` `--popover-foreground`
`--primary` `--primary-foreground` `--secondary` `--secondary-foreground` `--muted`
`--muted-foreground` `--accent` `--accent-foreground` `--destructive` `--border` `--input`
`--ring` `--sidebar` `--selected` `--folder` `--ok` `--shadow`。

## 存储与命令

目录：`app_config_dir()/themes/<id>.json`。

`src-tauri/src/themes.rs` 提供三个命令（复用 `json_store` 原子写）：

| 命令 | 行为 |
|---|---|
| `themes_list` | 扫描目录，返回 `{ packs, errors }`；坏包进 `errors`，不阻塞其他包 |
| `theme_install(path)` | 读取（≤ 64 KiB）→ 校验 → 原子写入 `<id>.json`；同 id 已存在报错「同名主题已安装」 |
| `theme_delete(id)` | id 先过正则再拼路径；文件不存在视为成功 |

安装 / 删除后前端重新拉取列表。当前选中的包 id 存 localStorage `rfm.themePack`（与 `rfm.theme` 同层）。启动时若该 id 不在列表中（被删或手工清理），静默回落颜色模式。

## 应用机制

`src/lib/themePacks.ts`：

- `applyThemePack(pack)`：清空上次写入的白名单变量 → 对包内每个白名单 key，值通过 `CSS.supports` 校验后 `documentElement.style.setProperty`；同时设置 `data-theme` 便于调试与测试。
- 内联变量优先级高于 `.dark { }`，因此包颜色总能压过当前模式，无需 `!important`。
- `clearThemePack()` 移除内联变量与 `data-theme`。
- 设置面板皮肤：由包的主色 / 表面色自动派生 `--glass-*` 变量（底色、卡片、边框、主色渐变、装饰光斑、阴影），`index.css` 的 `.settings-glass` / `.dark .settings-glass` 改为 `var(--glass-*, 原值)` 形式，默认值逐字保留。包不需要额外字段。

字体、圆角、`--radius` 不在白名单内。

## 外观设置 UI

- 「颜色模式」保留三个分段钮。
- 新增「主题包」行：默认块 + 已安装包的色块卡片；卡片用包内 `--background` / `--sidebar` / `--primary` 画缩略色，标注名称与明暗底。右上角垃圾桶删除。
- 选中包时颜色模式三个钮禁用（title：「主题包已自带配色」）；点任一颜色模式 = 取消包选中。
- 「安装主题包…」调 `plugin-dialog` 选文件；安装成功立即选中新包。
- 坏包在行尾给出「N 个主题包无法读取」提示（title 展示文件名与原因）。

## 安全

- 不执行包内代码、不把包内容拼进 `<style>`；CSSOM 赋值不会产生新规则。
- Rust 侧：id 正则、name 长度、文件大小、JSON 结构、token key 形态（`--` 前缀、无空白与 `;{}`）。值合法性由前端 `CSS.supports` 兜底（单一事实来源）。
- 包不能影响字体、持久化键或窗口行为。
- 删除命令只接受合法 id，杜绝路径穿越。

## 示例包

`examples/themes/`：
- `autumn-gold.rdtheme.json`（金秋，light）
- `maple-red.rdtheme.json`（红枫，dark）
- `peach-blossom.rdtheme.json`（桃花粉，light）

不随安装包内置，由用户从设置面板导入。

## 测试

- Rust：合法 / 非法 id、非法 JSON、超大文件、同 id 重复安装、`../` 删除、坏包进 errors。
- vitest：应用 / 清除变量、白名单外 key 忽略、非法颜色跳过但其余生效、`base` → `.dark`、active id 存取、列表缺失时回落。
- SettingsDialog：包卡片渲染、选中 / 删除 / 安装回调、包激活时颜色模式禁用。
- e2e mock 补 `themes_list`（空列表），保证现有 e2e 不因新命令失败。
- i18n：新增文案仅中文 key，语言包下版本补翻译（缺失自动回落中文）。
