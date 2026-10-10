# fzf 式玻璃窗快速定位（QuickJump）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把文件列表的“键盘快速定位”从大字提示升级为 fzf 式半透明玻璃浮层：对当前目录已加载条目做模糊匹配、匹配字符高亮、↑↓/鼠标实时驱动背后列表定位，回车定位（文件）/进入（目录），Esc 还原。

**Architecture:** 三层解耦——`lib/fuzzy.ts` 纯函数打分器（无 React）；`components/QuickJump.tsx` 受控展示组件（无业务状态）；`components/FileList.tsx` 唯一状态机（打开/查询/高亮项）并复用现有“`primary` 变化滚动”effect 做实时跟随。

**Tech Stack:** React 19 + TypeScript、Tailwind v4（`tw-animate-css`）、vitest + @testing-library/react、Playwright E2E、lucide-react。

**Spec:** `docs/superpowers/specs/2026-10-10-quick-jump-fuzzy-design.md`

## Global Constraints

- 仅对当前目录**已加载**条目（`FileList` 的 `sorted`）做纯前端模糊过滤，**不做**递归、**不引第三方模糊库**、**不加** debounce / Worker。
- 排序：分数降序，**同分保持当前列表顺序**（稳定排序）；**不**对目录强制置顶。
- 匹配大小写不敏感；query 字符须按顺序出现在 target 中（子序列匹配）。
- 交互：直接键入开窗（不新增快捷键）；↑↓ 环绕；回车=文件定位/目录进入；Esc=还原打开前选中；鼠标悬停高亮 + 单击确认 + 点窗外提交关闭。
- 浮层位于 `FileList` 内部（非 portal），无需 `--rdir-zoom` 补偿；尊重 `motion-reduce`。
- 复用现有滚动 effect 与 `FileIcon`、`formatSize`、`formatTime`、`cn`。
- 测试命令：`pnpm test`（vitest，`src/**/*.{test,spec}.{ts,tsx}`）；E2E：`pnpm test:e2e`。

---

### Task 1: 模糊打分器 `lib/fuzzy.ts`

**Files:**
- Create: `src/lib/fuzzy.ts`
- Test: `src/lib/fuzzy.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface FuzzyMatch { score: number; positions: number[] }`
  - `interface Ranked<T> { item: T; score: number; positions: number[] }`
  - `fuzzyMatch(query: string, target: string): FuzzyMatch | null`
  - `rank<T>(items: readonly T[], query: string, toText: (item: T) => string): Ranked<T>[]`

- [ ] **Step 1: 写失败测试 `src/lib/fuzzy.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { fuzzyMatch, rank } from "./fuzzy";

describe("fuzzyMatch 模糊匹配", () => {
  it("空 query 匹配一切且无高亮", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("返回命中位置（升序，用于高亮）", () => {
    // main.rs -> m(0) … n(3)
    expect(fuzzyMatch("mn", "main.rs")!.positions).toEqual([0, 3]);
  });

  it("大小写不敏感", () => {
    // main.rs -> m(0) … r(5)
    expect(fuzzyMatch("MR", "main.rs")!.positions).toEqual([0, 5]);
  });

  it("顺序不匹配时返回 null", () => {
    expect(fuzzyMatch("zz", "main.rs")).toBeNull();
    expect(fuzzyMatch("na", "main.rs")).toBeNull();
  });

  it("整段前缀优于间断命中", () => {
    const prefix = fuzzyMatch("main", "main.rs")!;
    const gap = fuzzyMatch("main", "m_a_i_n.rs")!;
    expect(prefix.score).toBeGreaterThan(gap.score);
  });

  it("连续命中优于断开命中", () => {
    const cont = fuzzyMatch("ab", "xxab")!;
    const broken = fuzzyMatch("ab", "axxb")!;
    expect(cont.score).toBeGreaterThan(broken.score);
  });

  it("分隔符后的命中获得词首奖励", () => {
    const boundary = fuzzyMatch("b", "a_b")!;
    const inner = fuzzyMatch("b", "ab_")!;
    expect(boundary.score).toBeGreaterThan(inner.score);
  });

  it("驼峰边界获得词首奖励并返回位置", () => {
    expect(fuzzyMatch("mh", "mainHandle")!.positions).toEqual([0, 4]);
  });

  it("支持中文子序列", () => {
    // 我的文档.txt -> 文(2) 档(3)
    expect(fuzzyMatch("文档", "我的文档.txt")!.positions).toEqual([2, 3]);
  });
});

describe("rank 排名", () => {
  const items = ["main.rs", "lib.rs", "mod.rs"];

  it("空 query 保持输入顺序、无高亮", () => {
    const r = rank(items, "", (s) => s);
    expect(r.map((x) => x.item)).toEqual(items);
    expect(r.every((x) => x.positions.length === 0)).toBe(true);
  });

  it("按分数降序，短名在前（同结构时）", () => {
    // "rs" 在 lib.rs / mod.rs / main.rs 均为 .rs 段连续命中，短名分高
    expect(rank(items, "rs", (s) => s).map((x) => x.item)).toEqual([
      "lib.rs",
      "mod.rs",
      "main.rs",
    ]);
  });

  it("不匹配的条目被剔除", () => {
    expect(rank(["a.txt", "b.rs"], "b", (s) => s).map((x) => x.item)).toEqual(["b.rs"]);
  });

  it("同分保持输入顺序（稳定）", () => {
    const r = rank(["ab", "ab"], "ab", (s) => s);
    expect(r.map((x) => x.item)).toEqual(["ab", "ab"]);
    expect(r[0].positions).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/lib/fuzzy.test.ts`
Expected: FAIL —— 无法解析模块 `./fuzzy`（文件不存在）。

- [ ] **Step 3: 实现最小代码 `src/lib/fuzzy.ts`**

```ts
/** 模糊匹配（fzf 思路）纯函数。query 的字符须按顺序出现在 target 中（大小写不敏感）。
 * 返回命中位置（升序，用于高亮）与分数；不匹配返回 null。空 query 视为匹配全部。 */

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/** 词边界分隔符 */
const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

// —— 评分常数（相对关系由 fuzzy.test.ts 锁定，非绝对值）——
const MATCH_BASE = 1; // 每命中一个字符的基础分
const FIRST_CHAR_BONUS = 6; // 命中 target 首字符
const BOUNDARY_BONUS = 10; // 命中分隔符之后 / 驼峰边界
const CONSECUTIVE_BONUS = 8; // 紧跟上一个命中
const GAP_PENALTY = -3; // 间隔起始惩罚
const GAP_EXTEND = -1; // 间隔每多一个字符的额外惩罚
const PREFIX_BONUS = 12; // 整段前缀命中
const LENGTH_PENALTY = -0.5; // 目标越长越轻微降权

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -1;
  // 贪心左到右子序列（YAGNI：不做最优子序列搜索，相对排序由测试锁定）
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = MATCH_BASE;
    if (prev === ti - 1) {
      bonus += CONSECUTIVE_BONUS;
    } else if (prev >= 0) {
      const gap = ti - prev - 1;
      bonus += GAP_PENALTY + GAP_EXTEND * (gap - 1);
    }
    if (ti === 0) {
      bonus += FIRST_CHAR_BONUS;
    } else if (SEPARATORS.has(target[ti - 1])) {
      bonus += BOUNDARY_BONUS;
    } else if (/[a-z]/.test(target[ti - 1]) && /[A-Z]/.test(target[ti])) {
      bonus += BOUNDARY_BONUS;
    }
    score += bonus;
    positions.push(ti);
    prev = ti;
    qi++;
  }
  if (qi < q.length) return null;
  // 整段前缀：首字符命中且后续完全连续
  if (positions[0] === 0) {
    let contiguous = true;
    for (let k = 1; k < positions.length; k++) {
      if (positions[k] !== positions[k - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (contiguous) score += PREFIX_BONUS;
  }
  score += LENGTH_PENALTY * target.length;
  return { score, positions };
}

export function rank<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): Ranked<T>[] {
  if (!query) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const scored: { r: Ranked<T>; i: number }[] = [];
  items.forEach((item, i) => {
    const m = fuzzyMatch(query, toText(item));
    if (m) scored.push({ r: { item, score: m.score, positions: m.positions }, i });
  });
  // 稳定排序：分数降序，同分保持输入顺序
  scored.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  return scored.map((s) => s.r);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/lib/fuzzy.test.ts`
Expected: PASS（全部用例通过）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/fuzzy.ts src/lib/fuzzy.test.ts
git commit -m "feat(quickjump): 零依赖模糊打分器 lib/fuzzy(子序列匹配 + fzf 风格评分)"
```

---

### Task 2: 展示组件 `components/QuickJump.tsx`

**Files:**
- Create: `src/components/QuickJump.tsx`
- Test: `src/components/QuickJump.test.tsx`

**Interfaces:**
- Consumes: `FileEntry`（`@/lib/types`）、`FileIcon`、`formatSize`/`formatTime`（`@/lib/format`）、`cn`（`@/lib/utils`）。
- Produces:
  - `interface QuickJumpRow { entry: FileEntry; positions: number[] }`
  - `interface QuickJumpProps { query; rows; activeIndex; totalMatches; onQueryChange; onMove; onConfirm; onHover; onActivate; onCancel; onOutsideDown }`
  - `function QuickJump(props: QuickJumpProps): JSX.Element`
  - DOM 约定（供测试与 E2E）：外层遮罩 `[data-quickjump-backdrop]`、面板 `[data-quickjump]`、行 `[data-quickjump-row="i"]`、活动行 `[data-quickjump-active="true"]`、输入 `[data-quickjump-input]`（`aria-label="快速定位查询"`）。

- [ ] **Step 1: 写失败测试 `src/components/QuickJump.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickJump, type QuickJumpRow, type QuickJumpProps } from "./QuickJump";
import type { FileEntry } from "@/lib/types";

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 1234,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
  };
}

const rows: QuickJumpRow[] = [
  { entry: entry("main.rs"), positions: [0, 1] },
  { entry: entry("Documents", true), positions: [] },
];

function setup(overrides: Partial<QuickJumpProps> = {}) {
  const props: QuickJumpProps = {
    query: "ma",
    rows,
    activeIndex: 0,
    totalMatches: 2,
    onQueryChange: vi.fn(),
    onMove: vi.fn(),
    onConfirm: vi.fn(),
    onHover: vi.fn(),
    onActivate: vi.fn(),
    onCancel: vi.fn(),
    onOutsideDown: vi.fn(),
    ...overrides,
  };
  render(<QuickJump {...props} />);
  return props;
}

describe("QuickJump 玻璃浮层", () => {
  it("渲染结果、活动行与匹配计数", () => {
    setup();
    expect(document.querySelector('[data-quickjump]')).toBeTruthy();
    expect(document.querySelectorAll("[data-quickjump-row]")).toHaveLength(2);
    expect(document.querySelector('[data-quickjump-row="0"]')!.getAttribute("data-quickjump-active")).toBe("true");
    expect(screen.getByText("2 项匹配")).toBeInTheDocument();
  });

  it("只高亮匹配字符", () => {
    setup();
    // active 行 positions [0,1] → 'm','a' 两个加粗 span
    const marks = document.querySelectorAll("[data-quickjump] .font-semibold");
    expect(marks.length).toBe(2);
  });

  it("↑↓ 触发 onMove", () => {
    const p = setup();
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(p.onMove).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(p.onMove).toHaveBeenCalledWith(-1);
  });

  it("回车确认 / Esc 取消", () => {
    const p = setup();
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onConfirm).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("输入变更触发 onQueryChange", () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText("快速定位查询"), { target: { value: "mai" } });
    expect(p.onQueryChange).toHaveBeenCalledWith("mai");
  });

  it("鼠标悬停 / 点击行转发", () => {
    const p = setup();
    const r1 = document.querySelector('[data-quickjump-row="1"]')!;
    fireEvent.mouseEnter(r1);
    expect(p.onHover).toHaveBeenCalledWith(1);
    fireEvent.mouseDown(r1);
    expect(p.onActivate).toHaveBeenCalledWith(1);
  });

  it("点窗外（遮罩）触发 onOutsideDown", () => {
    const p = setup();
    fireEvent.mouseDown(document.querySelector("[data-quickjump-backdrop]")!);
    expect(p.onOutsideDown).toHaveBeenCalled();
  });

  it("零匹配显示空状态", () => {
    setup({ rows: [], totalMatches: 0 });
    expect(screen.getByText("无匹配项")).toBeInTheDocument();
    expect(screen.getByText("0 项匹配")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/components/QuickJump.test.tsx`
Expected: FAIL —— 无法解析模块 `./QuickJump`。

- [ ] **Step 3: 实现 `src/components/QuickJump.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSize, formatTime } from "@/lib/format";
import { FileIcon } from "./FileIcon";
import type { FileEntry } from "@/lib/types";

export interface QuickJumpRow {
  entry: FileEntry;
  /** 命中字符下标（升序，针对 entry.name，UTF-16 code unit） */
  positions: number[];
}

export interface QuickJumpProps {
  query: string;
  rows: QuickJumpRow[];
  activeIndex: number;
  totalMatches: number;
  onQueryChange: (query: string) => void;
  onMove: (delta: 1 | -1) => void;
  onConfirm: () => void;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
  onCancel: () => void;
  onOutsideDown: () => void;
}

/** 高亮匹配字符。positions 与 fuzzyMatch 同为 UTF-16 code unit 口径，故用 split("") 对齐。 */
function Highlight({
  text,
  positions,
  active,
}: {
  text: string;
  positions: number[];
  active: boolean;
}) {
  const set = new Set(positions);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <span
            key={i}
            className={cn(
              "font-semibold",
              active ? "text-primary-foreground underline" : "text-primary",
            )}
          >
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/**
 * 快速定位玻璃浮层（受控）。仅负责外观 + 匹配高亮 + 事件转发，
 * 不持有业务状态、不直接操作文件列表。
 */
export function QuickJump({
  query,
  rows,
  activeIndex,
  totalMatches,
  onQueryChange,
  onMove,
  onConfirm,
  onHover,
  onActivate,
  onCancel,
  onOutsideDown,
}: QuickJumpProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦隐藏输入：获得退格 / 粘贴 / 中文 IME 的原生支持
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      data-quickjump-backdrop=""
      className="absolute inset-0 z-30"
      onMouseDown={onOutsideDown}
    >
      <div
        data-quickjump=""
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-[6%] flex w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-white/15 bg-background/70 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl backdrop-saturate-150 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150 motion-reduce:animate-none dark:border-white/10 dark:ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            data-quickjump-input=""
            aria-label="快速定位查询"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                onMove(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                onMove(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                onConfirm();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            className="sr-only"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {query || <span className="text-muted-foreground">输入以筛选…</span>}
          </span>
        </div>

        <div className="max-h-[min(60vh,392px)] overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              无匹配项
            </div>
          ) : (
            rows.map((row, i) => {
              const active = i === activeIndex;
              return (
                <div
                  key={row.entry.path}
                  data-quickjump-row={i}
                  data-quickjump-active={active ? "true" : undefined}
                  onMouseEnter={() => onHover(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onActivate(i);
                  }}
                  className={cn(
                    "flex cursor-default items-center gap-2 px-3 py-1.5 text-[13px]",
                    active ? "bg-primary/90 text-primary-foreground" : "hover:bg-muted/60",
                  )}
                >
                  <FileIcon entry={row.entry} size={16} className="shrink-0" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      row.entry.is_dir && "font-medium",
                    )}
                  >
                    <Highlight text={row.entry.name} positions={row.positions} active={active} />
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {row.entry.is_dir ? "—" : formatSize(row.entry.size)}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {formatTime(row.entry.modified)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{totalMatches} 项匹配</span>
          <span>↑↓ 选择 · ↵ 定位/进入 · Esc 取消</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/components/QuickJump.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/QuickJump.tsx src/components/QuickJump.test.tsx
git commit -m "feat(quickjump): 玻璃拟态快速定位浮层组件 QuickJump(受控)"
```

---

### Task 3: FileList 接入——打开 / 输入 / 过滤 / ↑↓ / 实时跟随

**Files:**
- Modify: `src/components/FileList.tsx`
- Test: `src/components/FileList.test.tsx`（新建）

**Interfaces:**
- Consumes: `rank`（Task 1）、`QuickJump` + `QuickJumpRow` + `QuickJumpProps`（Task 2）、既有 `sorted`、既有“`primary` 变化滚动”effect（`FileList.tsx` 内 `useEffect(..., [primary])`）。
- Produces（供 Task 4 使用，均为 `FileList` 内部符号）：
  - 状态：`qjOpen`、`qjQuery`、`qjActive`、`qjRestoreRef`（`useRef<string[]>`）
  - 派生：`qjMatches: Ranked<FileEntry>[]`、`qjRows: QuickJumpRow[]`
  - 处理函数：`openQuickJump(seed: string)`、`closeQuickJump()`、`focusListBody()`、`handleListKeyDown(e)`、`qjMove(delta)`、`qjConfirm(index)`、`qjCancel()`
  - 常量：`QJ_MAX_ROWS = 200`

> 本任务只做“打开 + 输入 + 过滤 + ↑↓ + 实时跟随 + 渲染浮层 + 移除旧覆盖层”。`qjConfirm`/`qjCancel` 在本任务先以最小实现落地（见 Step 3），其完整语义（目录进入、Esc 还原、点窗外）在 Task 4 补齐并加固。

- [ ] **Step 1: 在 `src/components/FileList.tsx` 顶部新增导入**

在 `import { openersForEntry } from "@/lib/openers";`（约 L57）之后追加：

```ts
import { rank } from "@/lib/fuzzy";
import { QuickJump, type QuickJumpRow } from "@/components/QuickJump";
```

- [ ] **Step 2: 用新状态/处理器替换旧 `typeAhead` 代码块**

删除旧代码（现状约 L355–L405）：

```ts
  const typeAheadRef = useRef("");
  const typeAheadTimer = useRef<number | null>(null);
  const [typeAhead, setTypeAhead] = useState("");
  const [typeAheadFading, setTypeAheadFading] = useState(false);
  ...
  const handleTypeAhead = (e: React.KeyboardEvent) => {
    ...（整段，直到 L405 的闭合 `};`）
  };
```

替换为：

```ts
  // ---- v0.24 快速定位浮层（QuickJump）：直接键入开窗，模糊过滤当前目录 ----
  const QJ_MAX_ROWS = 200;
  const [qjOpen, setQjOpen] = useState(false);
  const [qjQuery, setQjQuery] = useState("");
  const [qjActive, setQjActive] = useState(0);
  const qjRestoreRef = useRef<string[]>([]);

  const qjMatches = useMemo(
    () => (qjOpen ? rank(sorted, qjQuery, (e) => e.name) : []),
    [qjOpen, sorted, qjQuery],
  );
  const qjRows: QuickJumpRow[] = useMemo(
    () =>
      qjMatches
        .slice(0, QJ_MAX_ROWS)
        .map((m) => ({ entry: m.item, positions: m.positions })),
    [qjMatches],
  );

  const focusListBody = () => listScrollRef.current?.focus({ preventScroll: true });

  const openQuickJump = (seed: string) => {
    qjRestoreRef.current = propsRef.current.selection;
    setQjQuery(seed);
    setQjActive(0);
    setQjOpen(true);
  };

  const closeQuickJump = () => {
    setQjOpen(false);
    setQjQuery("");
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (qjOpen) return; // 浮层打开时按键由浮层内 input 处理
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea")) return;
    e.preventDefault();
    openQuickJump(e.key);
  };

  const qjMove = (delta: 1 | -1) => {
    setQjActive((a) => {
      const n = qjMatches.length;
      if (!n) return 0;
      return (a + delta + n) % n;
    });
  };

  // 最小确认/取消（完整语义见 Task 4）
  const qjConfirm = (index: number) => {
    const m = qjMatches[index];
    closeQuickJump();
    if (m && !m.item.is_dir) propsRef.current.onSelect(m.item, false);
    focusListBody();
  };

  const qjCancel = () => {
    closeQuickJump();
    focusListBody();
  };

  // 高亮项变化即实时跟随（复用 primary 变化滚动 effect，不另写滚动）
  useEffect(() => {
    if (!qjOpen) return;
    const m = qjMatches[qjActive];
    if (m) propsRef.current.onSelect(m.item, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qjOpen, qjActive, qjMatches]);

  // 结果变少时把高亮夹紧到有效范围
  useEffect(() => {
    setQjActive((a) => Math.min(a, Math.max(0, qjMatches.length - 1)));
  }, [qjMatches.length]);

  // 目录切换时关窗
  useEffect(() => {
    setQjOpen(false);
    setQjQuery("");
  }, [currentDir]);
```

> 注意：`propsRef` 已在文件内定义（含 `onSelect` / `selection` / `onSelectRange` / `onClearSelection`），此处直接复用。若 `propsRef` 的初始化对象缺少 `onClearSelection`，在 Task 4 一起补（Task 4 Step 1 会确认）。

- [ ] **Step 3: 替换旧覆盖层 JSX 为 QuickJump**

删除（现状约 L686–L696）：

```tsx
      {/* 键盘快速定位提示：面板中央大字号，输入后 2 秒淡出 */}
      {typeAhead && (
        <div ...>
          定位：{typeAhead}
        </div>
      )}
```

替换为：

```tsx
      {/* v0.24 快速定位玻璃浮层 */}
      {qjOpen && (
        <QuickJump
          query={qjQuery}
          rows={qjRows}
          activeIndex={qjActive}
          totalMatches={qjMatches.length}
          onQueryChange={(q) => {
            setQjQuery(q);
            setQjActive(0);
          }}
          onMove={qjMove}
          onConfirm={() => qjConfirm(qjActive)}
          onHover={setQjActive}
          onActivate={qjConfirm}
          onCancel={qjCancel}
          onOutsideDown={() => {
            closeQuickJump();
            focusListBody();
          }}
        />
      )}
```

- [ ] **Step 4: 切换列表 body 的按键处理器**

将列表 body 上的 `onKeyDown={handleTypeAhead}`（约 L771）改为：

```tsx
        onKeyDown={handleListKeyDown}
```

并在同处 `onMouseDownCapture` 内（现状约 L764–L770）新增一条守卫，避免点击浮层时抢焦点：

```tsx
        onMouseDownCapture={(e) => {
          // 地址栏聚焦时保持光标；点击输入框/文本域不抢焦点；浮层内不抢焦点；否则聚焦列表
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.id === "rdir-addr-input") return;
          if ((e.target as HTMLElement).closest("input,textarea,[data-quickjump]")) return;
          listScrollRef.current?.focus({ preventScroll: true });
        }}
```

- [ ] **Step 5: 写失败集成测试 `src/components/FileList.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FileList } from "./FileList";
import type { FileEntry } from "@/lib/types";

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/mock/dir/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 100,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
  };
}

const ENTRIES: FileEntry[] = [
  entry("Documents", true),
  entry("main.rs"),
  entry("photo.png"),
];

function makeProps(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return {
    paneId: 1,
    entries: ENTRIES,
    sortKey: "name",
    sortDir: "asc",
    onSort: noop,
    selection: [],
    onSelect: vi.fn(),
    onSelectRange: vi.fn(),
    onClearSelection: vi.fn(),
    onOpen: vi.fn(),
    onMiddleOpen: noop,
    onCopy: noop,
    onCut: noop,
    onDelete: noop,
    onRename: noop,
    onCopyPath: noop,
    onRefresh: noop,
    onDropPaths: noop,
    onDragOverChange: noop,
    onNewFolder: noop,
    onNewFile: noop,
    onShareDir: noop,
    onPaste: noop,
    canPaste: false,
    onUndo: noop,
    onRedo: noop,
    canUndo: false,
    canRedo: false,
    onSelectAll: noop,
    onInvertSelection: noop,
    fileTags: {},
    tagNames: {},
    onRenameTag: noop,
    customQuick: [],
    onToggleTag: noop,
    onToggleQuick: noop,
    currentDir: "/mock/dir",
    pluginOpener: false,
    pluginTerminal: false,
    openers: [],
    shells: [],
    onOpenWith: noop,
    onOpenTerminal: noop,
    onAddCustomOpener: vi.fn(async () => {}),
    dragTarget: false,
    dragOp: "copy" as const,
    showHidden: false,
    showExtensions: true,
    renaming: null,
    onRenameCommit: noop,
    onRenameCancel: noop,
    isActive: true,
    onActivate: noop,
    zoom: 1,
    onZoomChange: noop,
    onBack: noop,
    onForward: noop,
    onCompress: noop,
    onProperties: noop,
    onPropertiesDir: noop,
    onDiff: noop,
    onSyncDiff: noop,
    compareBase: null,
    onSetCompareBase: noop,
    onCompareWithBase: noop,
    onComparePick: noop,
    onCompareSelected: noop,
    onViewPatch: noop,
    ...overrides,
  };
}

function renderList(overrides: Record<string, unknown> = {}) {
  const props = makeProps(overrides);
  const utils = render(<FileList {...(props as never)} />);
  const body = utils.container.querySelector("[data-filelist-body]") as HTMLElement;
  return { ...utils, props, body };
}

describe("FileList 快速定位集成", () => {
  it("键入可打印字符弹出玻璃窗并实时跟随首个命中", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    expect(document.querySelector("[data-quickjump]")).toBeTruthy();
    // "p" 命中 photo.png（唯一以 p 开头者）
    const last = props.onSelect.mock.calls.at(-1);
    expect(last?.[0]).toMatchObject({ name: "photo.png" });
  });

  it("输入变化过滤结果并重置到首项", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "m" });
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.change(input, { target: { value: "mai" } });
    const last = props.onSelect.mock.calls.at(-1);
    expect(last?.[0]).toMatchObject({ name: "main.rs" });
  });

  it("浮层打开时列表 body 不再吞键", () => {
    const { body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    const before = document.querySelectorAll("[data-quickjump]").length;
    fireEvent.keyDown(body, { key: "h" }); // 应被忽略（handleListKeyDown 早退）
    expect(document.querySelectorAll("[data-quickjump]").length).toBe(before);
    // 查询串未变（仍是 "p"，由浮层展示）
    expect(document.querySelector("[data-quickjump]")!.textContent).toContain("p");
  });
});
```

- [ ] **Step 6: 运行集成测试**

Run: `pnpm vitest run src/components/FileList.test.tsx`
Expected: PASS。若首次失败，按报错核对：浮层选择器拼写、`data-filelist-body` 存在、`onSelect` 调用参数。

- [ ] **Step 7: 全量单测回归**

Run: `pnpm test`
Expected: 全部通过（无因移除 `typeAhead` 产生的编译错误 / 未用变量警告）。

- [ ] **Step 8: 提交**

```bash
git add src/components/FileList.tsx src/components/FileList.test.tsx
git commit -m "feat(quickjump): FileList 接入玻璃浮层(直接键入开窗 + 模糊过滤 + ↑↓ 实时跟随)"
```

---

### Task 4: FileList 完整确认 / 取消语义与边界

**Files:**
- Modify: `src/components/FileList.tsx`
- Modify: `src/components/FileList.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `qjConfirm` / `qjCancel` / `qjRestoreRef` / `propsRef`；`QuickJump` 的 `onActivate` / `onOutsideDown` / `onCancel`。
- Produces: 最终行为——回车文件定位、目录进入；Esc 还原打开前选中（含多选与空选）；点窗外提交关闭；`currentDir` 变化关窗；`activeIndex` 夹紧。

- [ ] **Step 1: 确认 `propsRef` 含所需回调**

打开 `FileList.tsx` 中 `propsRef` 定义（约 L417–L427）。确保初始化对象与每帧赋值都包含 `onClearSelection`、`onSelectRange`、`onSelect`、`selection`。现状已含（`onClearSelection` 在 L420）。无需改动；若缺失则补入。

- [ ] **Step 2: 用完整实现覆盖 Task 3 的 `qjConfirm` / `qjCancel`**

将 Task 3 中“最小确认/取消”两段替换为：

```ts
  const qjConfirm = (index: number) => {
    const m = qjMatches[index];
    closeQuickJump();
    if (m) {
      if (m.item.is_dir) propsRef.current.onOpen(m.item);
      else propsRef.current.onSelect(m.item, false);
    }
    focusListBody();
  };

  const qjCancel = () => {
    closeQuickJump();
    const restore = qjRestoreRef.current;
    if (restore.length) propsRef.current.onSelectRange(restore);
    else propsRef.current.onClearSelection();
    focusListBody();
  };
```

- [ ] **Step 3: 追加失败测试到 `src/components/FileList.test.tsx`**

在 `describe("FileList 快速定位集成", ...)` 内追加：

```tsx
  it("目录上回车 → 调 onOpen 进入目录并关窗", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "d" });
    fireEvent.change(screen.getByLabelText("快速定位查询"), { target: { value: "doc" } });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Documents", is_dir: true }),
    );
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("文件上回车 → onSelect 定位并关窗", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "photo.png" }),
      false,
    );
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("Esc → 还原打开前的选中并关窗", () => {
    const { props, body } = renderList({ selection: ["/mock/dir/main.rs"] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Escape" });
    expect(props.onSelectRange).toHaveBeenCalledWith(["/mock/dir/main.rs"]);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("打开前无选中时 Esc → onClearSelection", () => {
    const { props, body } = renderList({ selection: [] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Escape" });
    expect(props.onClearSelection).toHaveBeenCalled();
  });

  it("点窗外（遮罩）→ 提交关闭且不还原", () => {
    const { props, body } = renderList({ selection: ["/mock/dir/main.rs"] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.mouseDown(document.querySelector("[data-quickjump-backdrop]")!);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
    expect(props.onSelectRange).not.toHaveBeenCalled();
  });

  it("退格删空 query → 显示全量条目", () => {
    const { body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.change(input, { target: { value: "" } });
    expect(document.querySelector("[data-quickjump]")!.textContent).toContain("3 项匹配");
  });

  it("currentDir 变化 → 自动关窗", () => {
    const { body, rerender } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    expect(document.querySelector("[data-quickjump]")).toBeTruthy();
    rerender(<FileList {...(makeProps({ currentDir: "/mock/other" }) as never)} />);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });
```

> 若 `renderList` 未返回 `rerender`：`render` 已返回，确认 `return { ...utils, props, body }` 展开含 `rerender`（是）。

- [ ] **Step 4: 运行集成测试**

Run: `pnpm vitest run src/components/FileList.test.tsx`
Expected: PASS。

- [ ] **Step 5: 全量单测回归**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/components/FileList.tsx src/components/FileList.test.tsx
git commit -m "feat(quickjump): 回车文件定位/目录进入、Esc 还原、点窗外提交等完整语义"
```

---

### Task 5: E2E 冒烟（Playwright）

**Files:**
- Modify: `e2e/smoke.spec.ts`
- Test: 同上（新增一个 `describe` 块）

**Interfaces:**
- Consumes: Task 2 的 DOM 约定（`[data-quickjump]`、`[data-quickjump-row]`）、Task 3/4 的 FileList 行为；`e2e/tauri-mock.ts` 虚拟文件系统（`/mock/home` 含 `Documents`、`Projects`、`Notes.txt`、`photo.png`、`link-to-docs`）。

- [ ] **Step 1: 在 `e2e/smoke.spec.ts` 末尾追加用例**

```ts
test.describe("11. 快速定位（QuickJump）", () => {
  test("QJ1 键入弹出玻璃窗，回车定位到匹配文件", async ({ page }) => {
    // 聚焦文件列表：单击一行
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    // 键入 "ph"：仅命中 photo.png（Projects 无 h）
    await page.keyboard.press("p");
    await page.keyboard.press("h");
    const win = page.locator("[data-quickjump]");
    await expect(win).toBeVisible();
    await expect(win).toContainText("photo.png");
    await page.keyboard.press("Enter");
    await expect(win).toBeHidden();
    // photo.png 行被主选中（ring 高亮）
    await expect(page.locator(`[data-path="${HOME}/photo.png"]`)).toHaveClass(/ring-inset/);
  });

  test("QJ2 Esc 取消并还原选中", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("p");
    await expect(page.locator("[data-quickjump]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-quickjump]")).toBeHidden();
    // Notes.txt 仍是选中项（Primary ring）
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveClass(/ring-inset/);
  });
});
```

- [ ] **Step 2: 运行 E2E**

Run: `pnpm test:e2e -- e2e/smoke.spec.ts`
前置（首次）：`pnpm exec playwright install chromium`
Expected: PASS（新增 2 条 + 原有用例全绿）。若 QJ1 失败，先用 `pnpm dev` 手动键入 `p`→`h` 核对浮层选择器与命中项。

- [ ] **Step 3: 提交**

```bash
git add e2e/smoke.spec.ts
git commit -m "test(e2e): 快速定位玻璃窗冒烟（键入开窗 / 回车定位 / Esc 还原）"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §5 组件边界（fuzzy/QuickJump/FileList） | Task 1 / 2 / 3 |
| §6 匹配排序（子序列、前缀、连续、词首、间隔、短名、稳定、空 query） | Task 1 |
| §7.1 隐藏 input + IME | Task 2（input `sr-only` + 打开聚焦） |
| §7.2 打开即跳 | Task 3（openQuickJump 设 seed + 实时跟随 effect） |
| §7.3 实时跟随（复用滚动 effect） | Task 3 |
| §7.4 鼠标（hover/单击/点窗外） | Task 2（转发）+ Task 4（点窗外提交） |
| §7.5 Esc 还原 | Task 4 |
| §7 Enter 文件/目录 | Task 4 |
| §8 玻璃拟态/布局/高亮/动效/页脚 | Task 2 |
| §9 边界（零匹配、删空、夹紧、currentDir、多选还原、失焦） | Task 3（夹紧/currentDir）+ Task 4（还原/点窗外） |
| §10 测试策略 | Task 1/2/3/4（vitest）+ Task 5（E2E） |
| §11 回归风险 | Global Constraints + Task 3 Step 7 / Task 4 Step 5 |

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤均含完整代码与确切命令/预期。

**3. Type consistency**：`FuzzyMatch`/`Ranked<T>`/`fuzzyMatch`/`rank`（Task 1）→ Task 3 导入一致；`QuickJumpRow{entry,positions}`、`QuickJumpProps`（Task 2）→ Task 3 `qjRows` 构造与 `<QuickJump>` 传参一致；`qjConfirm/index`、`qjMove(delta: 1|-1)`、`onActivate(i)`、`onHover(i)` 全程一致；DOM 选择器（`data-quickjump*`）在 Task 2/4/5 一致。
