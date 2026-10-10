# 设计文档：fzf 式玻璃窗快速定位（QuickJump）

- 日期：2026-10-10
- 状态：**待用户 review**（批准前不写实现代码）
- 来源：本会话用户拍板
- 目标版本：v0.24.0（暂定）
- 基线：commit `1998baa`（v0.23.0）

---

## 1. 背景与目标

当前文件列表的“键盘快速定位”（`FileList.tsx` 的 `handleTypeAhead`）行为是：

- 列表获得焦点时直接键入字符 → 累积缓冲区；
- 在面板正中弹一个大字提示 `定位：{buf}`；
- 只做 `startsWith` 前缀匹配，命中即选中并滚动到该行；
- 1 秒无输入重置缓冲、提示淡出。

问题：只认前缀、只跳第一个命中、无候选列表、无法上下浏览、玻璃观感只是雏形。

目标：把这条交互升级为 **fzf 式半透明玻璃浮层**——录入任意字符串即对**当前目录已加载条目**做模糊匹配，按分数排序并高亮命中字符；↑↓ 实时驱动背后列表定位，鼠标可 hover/单击；回车定位（文件）或进入（目录）；Esc 还原。

一句话：**“加强版快速定位”，保留零学习成本的直接键入手感，同时给出所见即所得的候选与定位。**

## 2. 范围与非目标

**做**：

- 仅对**当前目录已加载的条目**（`FileList` 的 `sorted`）做纯前端模糊过滤，零延迟。
- 新增自研零依赖模糊打分器 `lib/fuzzy.ts`（子序列匹配 + fzf 风格评分）。
- 新增受控玻璃浮层组件 `QuickJump.tsx`：单列结果 + 文件图标 + 匹配高亮 + 右侧元数据 + 底部快捷键提示。
- `FileList.tsx` 用一个小状态机接管按键，替换旧 `定位：` 覆盖层；复用现有选中滚动 effect 做实时跟随。
- 键盘：直接键入开窗、退格编辑、↑↓ 环绕、Enter 确认、Esc 还原。
- 鼠标：hover 移动高亮（实时跟随）、单击确认、点窗外提交关闭。
- 单元 / 组件 / 集成 / E2E 冒烟测试。

**不做（本版）**：

- 递归子目录搜索（已有 `SearchPanel` 承担，本版不引入后端遍历）。
- 右侧内容 / 属性预览面板。
- 搜索历史、使用频次加权、目录强制置顶等额外排序信号。
- 把 `CommandPalette` 泛化成通用 fuzzy 选择器（作为未来单独项）。
- 引入第三方模糊库（`fuzzysort` / `fuse.js` 等）。

## 3. 决策记录

| # | 决策点 | 结论 | 来源 |
|---|--------|------|------|
| D1 | 搜索范围 | 仅当前目录已加载条目，纯前端 | 本会话用户 |
| D2 | 触发方式 | 保留“直接键入”触发，不引入新快捷键 | 本会话用户 |
| D3 | 窗口内容 | 单列列表 + 图标 + 匹配高亮 + 右侧元数据 + 底部快捷键提示 | 本会话用户 |
| D4 | 定位时机 | 高亮项变化即实时跟随（背后列表滚动并选中） | 本会话用户 |
| D5 | 回车语义 | 文件 → 定位选中并关闭；目录 → 直接进入 | 本会话用户 |
| D6 | 鼠标语义 | 悬停即高亮 + 单击确认 + 点窗外提交关闭（推荐默认，用户未反驳） | 本会话用户 |
| D7 | 匹配算法 | 自研零依赖 fzf 思路打分器 | 本会话用户（选路线 A） |
| D8 | 排序稳定性 | 同分保持当前列表顺序；目录不强制置顶 | 本会话用户 |
| D9 | Esc 行为 | 关闭并还原到打开前的选中 | 本会话设计 |
| D10 | IME / 输入 | 浮层内置隐藏受控 input，打开即聚焦并写入首字符 | 本会话设计 |

## 4. 术语

- **QuickJump（快捷定位浮层）**：本版新增的玻璃浮层，fzf 式候选与定位 UI。
- **query**：用户在浮层里输入的模糊查询串。
- **activeIndex**：浮层内当前高亮项的序号（环绕）。
- **实时跟随**：activeIndex 变化时，背后文件列表立即滚动并选中对应条目。
- **匹配位置（positions）**：命中字符在目标字符串中的下标，用于高亮渲染。

## 5. 架构与组件边界

### 5.1 新增 / 改动文件

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/lib/fuzzy.ts` | 新增 | 纯函数模糊打分器 + 排名。无 React、无 IO，可独立单测 |
| `src/components/QuickJump.tsx` | 新增 | **受控**玻璃浮层展示组件，只负责外观 / 匹配高亮 / hover·click 事件转发 |
| `src/components/FileList.tsx` | 改动 | 唯一状态持有者：按键分派、实时跟随、确认、Esc 还原；替换旧 `定位：` 覆盖层 |
| `src/lib/fuzzy.test.ts` | 新增 | 评分与排序单测 |
| `src/components/QuickJump.test.tsx` | 新增 | 键盘 / 鼠标交互与高亮单测 |
| `src/components/FileList.test.tsx` | 新增（若无则新建） | QuickJump 集成行为测试 |

### 5.2 边界原则

- `fuzzy.ts` 只做“字符串进、分数与命中位置出”，无副作用。
- `QuickJump` 无业务状态、不碰文件列表，全靠 props 驱动（受控）；可脱离 `FileList` 单独渲染与测试。
- `FileList` 是唯一知道“当前目录、选中、滚动”的地方。
- 三层各自可独立理解与测试；改动 `fuzzy` 的评分不会影响 `QuickJump` 的渲染。

### 5.3 复用点

- 滚动定位**复用**现有“`primary` 选中变化 → 滚动进可视区” effect（`FileList.tsx` 约 L286），不新增第二条滚动路径。
- 图标复用 `FileIcon`；选中/高亮配色沿用主题 token（`primary` / `accent`）。
- 目录进入复用 `onOpen(entry)`（与双击、行内 Enter 同源）。

## 6. 匹配与排序算法（`fuzzy.ts`）

### 6.1 接口

```ts
export interface FuzzyMatch {
  score: number;
  /** 命中字符在 target 中的下标，升序，用于高亮 */
  positions: number[];
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/** 子序列匹配；不匹配返回 null */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null;

/** 对条目数组打分并排序 */
export function rank<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): Ranked<T>[];
```

### 6.2 匹配模型

- query 的字符须按顺序出现在 target 中（大小写不敏感），记录每个命中字符下标。
- 任一 query 字符匹配不上 → 返回 `null`（不入选）。
- 空 query → 返回全部条目、`score = 0`、`positions = []`、**保持输入顺序**。

### 6.3 评分规则（累加奖励 − 间隔惩罚）

| 规则 | 说明 |
|---|---|
| 词首奖励 | 命中落在 target 开头、分隔符（`/ _ - . 空格`）之后、或驼峰边界（小写→大写） |
| 连续奖励 | 紧跟上一个命中的字符，奖励随连击递增 |
| 前缀奖励 | 命中从 index 0 开始整段前缀，额外高奖励（保留“敲 `main` 秒定位”旧手感） |
| 间隔惩罚 | 两命中之间跳过的字符每个扣分；首段间隔惩罚轻、后续更重 |
| 短名偏好 | 同分时更短的名字略优先 |

- 具体常数为实现细节，须集中在常量块并写注释，由 `fuzzy.test.ts` 锁定相对关系（不锁绝对值）。
- 大小写不敏感；CJK 作为可匹配字符处理，不假设拉丁词边界。

### 6.4 排序

- 分数降序；**同分保持当前列表顺序**（即用户当前排序键顺序）。
- **不做**“目录强制置顶”，避免把精确的文件命中压下去。
- `positions` 随结果一并返回，供高亮。

### 6.5 性能

- 当前目录通常 ≤ 数千条，每次按键 O(n·m) 打分在 `useMemo([sorted, query])` 内运行，零延迟。
- 浮层仅渲染前 ~200 行；`totalMatches` 单独计数供底部显示。
- 本版**不加** debounce / Web Worker（YAGNI）。

## 7. 交互状态机

挂在列表 body 的 `onKeyDown`（沿用现有 `handleTypeAhead` 挂载点）：

```
closed + 可打印字符(非修饰键 / 非输入框聚焦)  → 打开，query = 该字符，activeIndex = 0
open   + 字符 / 退格 / 光标 / 粘贴            → 更新 query，activeIndex 归 0
open   + ↑ / ↓                               → activeIndex 环绕增减，实时跟随
open   + Enter                               → 文件: onSelect + 关闭；目录: onOpen + 关闭
open   + Esc                                 → 关闭并还原到打开前的选中
关闭                                          → 清空 query，焦点交回列表 body
```

### 7.1 焦点与 IME

- 浮层内置一个视觉隐藏的受控 `<input>`，打开时聚焦并把首个字符写入其值。
- 由此获得退格、粘贴、中文 IME 组合输入的原生支持（优于现有只认 `e.key.length === 1`）。
- 关闭时 blur 并重聚焦列表容器。
- 浮层内消费的按键 `stopPropagation`，避免与 App 级快捷键（如全局 Esc）冲突。

### 7.2 打开即跳

- 第一个字符既开窗、又作 query、又立即实时跟随到首个命中项（完整保留旧“敲字母→跳过去”）。
- 打开瞬间快照当前选中（供 Esc 还原）。

### 7.3 实时跟随

- activeIndex 变化 → `onSelect(matches[activeIndex].item, false)`。
- 滚动复用 §5.3 的现有 effect，不再另写滚动代码。

### 7.4 鼠标

- **hover 行** → 设为 activeIndex（实时跟随）。
- **单击行** → 确认（等同回车）。
- **点窗外** → 关闭并保留当前位置（提交）。

### 7.5 Esc

- 关闭并 `onSelectRange(打开前快照)` 精确还原多选状态。

## 8. 视觉设计

### 8.1 容器

- `bg-background/70 backdrop-blur-xl backdrop-saturate-150`
- `border border-white/15 dark:border-white/10` + `ring-1 ring-black/5 dark:ring-white/10`
- `shadow-2xl`，圆角 `rounded-xl`。

### 8.2 布局

- 顶部居中：`absolute left-1/2 top-[6%] -translate-x-1/2 z-30 w-[min(560px, calc(100%-2rem))]`。
- 位于 `FileList` 内部（非 portal），根级 zoom 已生效，**无需** `--rdir-zoom` 补偿。
- 最大约 14 行，内部滚动。

### 8.3 行

- `[FileIcon] 名称(高亮) ……… [大小] [修改日期] [类型]`
- 元数据右对齐、`tabular-nums`、`text-xs text-muted-foreground`。
- 选中行 `bg-primary/90 text-primary-foreground`；未选中行匹配字符 `text-primary font-semibold`；选中行内匹配字符改用下划线 / 更亮色保证对比。
- 超长名称 `truncate`（高亮下标基于原名，先渲染后 CSS 截断）。

### 8.4 动效

- 入场/退场：`animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150`（`tw-animate-css` 已在用）。
- `motion-reduce:animate-none` 尊重系统“减弱动效”。

### 8.5 底部状态栏

- 左：`N 项匹配`。
- 右：`↑↓ 选择 · ↵ 定位/进入 · Esc 取消`。

## 9. 边界情况

| 场景 | 处理 |
|---|---|
| 空目录 / 零匹配 | 居中“无匹配项”，退格可继续改 |
| 退格删空 query | 显示全量条目（保持列表顺序），↑↓ 顺序走 |
| 目录刷新 | `sorted` 变化 → 重算；active 项消失则 activeIndex 夹紧到有效范围 |
| 目录切换 | `currentDir` 变化 → 自动关窗 |
| 打开时多选 | 快照；Esc 用 `onSelectRange` 还原；确认后清空快照 |
| 中文 / IME | 走隐藏 input，原生支持 |
| 10k+ 条目 | 打分毫秒级；窗口只渲染前 ~200 行；不加 debounce |
| input 失焦（点到别处） | 视作提交关闭，避免浮层“卡死” |
| 隐藏文件 | 遵循当前 `showHidden`（`sorted` 已过滤），行为一致 |

## 10. 测试策略

- **`fuzzy.test.ts`**：前缀 > 间断；连续加分；分隔符 / 驼峰词首加分；大小写不敏感；同分保持输入顺序；空 query 返回全量且顺序不变；不匹配返回 null；中文子序列；`positions` 正确且升序。
- **`QuickJump.test.tsx`**：匹配字符被高亮包裹；↑↓ 触发回调且环绕；Enter 确认；Esc 关闭；点窗外；零匹配文案；hover / click 转发。
- **`FileList` 集成（RTL）**：键入开窗并实时跟随；Esc 还原；目录 Enter 调 `onOpen`；退格删空显示全量。
- **E2E 冒烟（Playwright）**：键入 → 出现玻璃窗 → `↓` → `Enter` → 列表定位选中。

## 11. 回归风险

- **`CommandPalette` 独立**：本次不改动命令面板，避免顺带重构风险。
- **旧 `typeAhead` 行为**：直接键入仍会跳转（首个命中），语义向后兼容；仅新增候选窗与编辑能力。
- **虚拟滚动**：复用既有滚动 effect，无新增滚动路径，降低错位风险。
- **全局快捷键**：浮层内 `stopPropagation`，防止 Esc/方向键泄漏到 App 级分发。
