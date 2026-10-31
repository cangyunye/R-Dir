# 主题包示例

装法：设置 → 外观 → 主题包 → 安装…，选 `.rdtheme.json` 文件。

| 文件 | 名称 | base |
|---|---|---|
| `autumn-gold.rdtheme.json` | 金秋 | light |
| `maple-red.rdtheme.json` | 红枫 | dark |
| `peach-blossom.rdtheme.json` | 桃花粉 | light |

## 格式

```json
{
  "$schema": "rdir-theme/1",
  "id": "my-theme",
  "name": "我的主题",
  "author": "可选",
  "version": "1.0.0",
  "base": "light",
  "tokens": { "--primary": "oklch(0.55 0.14 68)" }
}
```

- `id`：小写字母/数字/连字符，≤ 64 字符，同时作为磁盘文件名。
- `name`：≤ 40 字。
- `base`：`light` 或 `dark`，决定组件用哪套明暗变体（不是配色模式，配色由 `tokens` 决定）。
- `tokens`：可只写要覆盖的项，缺省回落到 `base` 内置主题；白名单见
  `src/lib/themePacks.ts` 的 `THEME_TOKEN_KEYS`（23 个颜色/阴影 token）。
  值须是浏览器认识的 CSS 颜色（`--shadow` 是 box-shadow），否则该项被跳过。

设置面板皮肤不用单独写：应用会从 `tokens` 自动派生底色、主色渐变与光斑。
