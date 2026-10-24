import type { Page } from "@playwright/test";

/**
 * 在浏览器里装一个 Tauri IPC 桩。
 *
 * 等价于 `@tauri-apps/api/mocks` 的 `mockIPC`，但用 `addInitScript` 同步安装，
 * 不依赖动态 import，避免和页面模块图抢加载时序。
 *
 * 没有这个桩，`invoke()` 在浏览器里全部 reject，App 只剩空壳，
 * e2e 就只能断言 "body 可见" —— 那是恒过的假测试。
 *
 * 这里提供一个固定的虚拟文件系统，让用例能断言真实的列表内容与交互结果。
 */
export async function installTauriMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const HOME = "/mock/home";
    // 1x1 透明 PNG（preview_data 桩用）
    const PREVIEW_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    // 文本预览内容（read_text_file 桩用）
    const TEXTS: Record<string, string> = {
      [`${HOME}/Notes.txt`]: "R-Dir 预览文本第一行\n第二行",
      [`${HOME}/Documents/readme.md`]: "# readme",
      // v0.30 简单文本格式全覆盖夹具
      [`${HOME}/Documents/configs/app.ini`]: "[app]\nname=R-Dir\n",
      [`${HOME}/Documents/configs/settings.json`]: '{\n  "name": "r-dir"\n}\n',
      [`${HOME}/Documents/configs/.gitignore`]: "node_modules\ndist\n",
      [`${HOME}/Documents/configs/Makefile`]: "all:\n\techo built\n",
      [`${HOME}/Documents/configs/.env.local`]: "RDIR_MODE=test\n",
    };

    type Fake = { name: string; dir?: boolean; size?: number; symlink?: boolean };

    const FS: Record<string, Fake[]> = {
      "/mock": [{ name: "home", dir: true }],
      // v0.32 解压夹具：zip/tgz/7z 可解压，裸 xz 例外（后端不支持 → 菜单不出现）。
      // 独立顶层目录，不动家目录（smoke 用例固定断言家目录 6 项）
      "/mock/archives": [
        { name: "sample.zip", size: 8192 },
        { name: "backup.tar.gz", size: 4096 },
        { name: "legacy.7z", size: 2048 },
        { name: "bare.xz", size: 1024 },
      ],
      [HOME]: [
        { name: "Documents", dir: true },
        { name: "Projects", dir: true },
        { name: "Pictures", dir: true },
        { name: "Notes.txt", size: 1234 },
        { name: "photo.png", size: 204800 },
        { name: "link-to-docs", dir: true, symlink: true },
      ],
      // v0.28 预览/图文浏览模式夹具：多图 + 文档混排
      [`${HOME}/Pictures`]: [
        { name: "a.png", size: 100 },
        { name: "b.png", size: 200 },
        { name: "c.jpg", size: 300 },
        { name: "doc.pdf", size: 4096 },
        { name: "skip.zip", size: 500 },
      ],
      [`${HOME}/Documents`]: [
        { name: "readme.md", size: 42 },
        // v0.18 同步比对夹具：syncA/syncB 结构对齐，B 侧少 missing/onlyA.txt
        { name: "syncA", dir: true },
        { name: "syncB", dir: true },
        { name: "configs", dir: true },
      ],
      [`${HOME}/Documents/syncA`]: [
        { name: "common", dir: true },
        { name: "missing", dir: true },
        { name: "onlyA.txt", size: 11 },
      ],
      [`${HOME}/Documents/syncA/common`]: [
        { name: "same.txt", size: 5 },
        { name: "a-only.txt", size: 7 },
      ],
      [`${HOME}/Documents/syncA/missing`]: [{ name: "x.txt", size: 1 }],
      [`${HOME}/Documents/syncB`]: [{ name: "common", dir: true }],
      [`${HOME}/Documents/syncB/common`]: [{ name: "same.txt", size: 5 }],
      // v0.30 简单文本格式夹具：ini 同族 / json / 点文件 / Makefile + 二进制对照
      [`${HOME}/Documents/configs`]: [
        { name: "app.ini", size: 18 },
        { name: "settings.json", size: 22 },
        { name: ".gitignore", size: 18 },
        { name: "Makefile", size: 20 },
        { name: ".env.local", size: 14 },
        { name: "build.bin", size: 77 },
      ],
      // v0.30 code 类（.ts）已可文本预览：「无可预览条目」夹具换 exe
      [`${HOME}/Projects`]: [{ name: "app.exe", size: 900 }],
      "sftp://u@127.0.0.1:22/remote": [
        { name: "deploy.sh", size: 512 },
        { name: "logs", dir: true },
      ],
    };

    const NOW = 1_700_000_000_000;

    /**
     * 侧边栏 SFTP：一台有已保存密码（一键重连），一台需手输。
     * 注意 id 必须等于后端 `server_id(user, host, port)` = "user@host:port"，
     * 因为 navigate() 用 parseSftpAuthority(path).id 去 sftpConnectedRef 里查。
     */
    const SFTP_SERVERS = [
      {
        id: "u@127.0.0.1:22",
        name: "生产机",
        host: "127.0.0.1",
        port: 22,
        user: "u",
        root: null,
        defaultRemote: "/remote",
        group: "",
        auth: "password",
        hasSecret: true,
        connected: false,
      },
      {
        id: "tester@10.0.0.9:22",
        name: "测试机",
        host: "10.0.0.9",
        port: 22,
        user: "tester",
        root: null,
        defaultRemote: "/home/tester",
        group: "",
        auth: "password",
        hasSecret: false,
        connected: false,
      },
    ];
    // 扩展名规则对齐后端 Path::extension()：小写、不带点；点文件（.gitignore）与无点文件名为空串
    const extOf = (name: string) => {
      const dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    };
    const entry = (dir: string, f: Fake) => ({
      name: f.name,
      path: `${dir}/${f.name}`,
      is_dir: !!f.dir,
      is_symlink: !!f.symlink,
      size: f.dir ? 0 : (f.size ?? 0),
      modified: NOW,
      created: NOW,
      permissions: f.dir ? "drwxr-xr-x" : "-rw-r--r--",
      extension: f.dir ? "" : extOf(f.name),
    });

    const parentOf = (p: string) => {
      const i = p.lastIndexOf("/");
      return i <= 0 ? "/" : p.slice(0, i);
    };

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      get_home_dir: () => HOME,
      get_volumes: () => [{ name: "Macintosh HD", path: "/", kind: "disk" }],
      get_quick_access: () => [
        { key: "home", path: HOME },
        { key: "downloads", path: `${HOME}/Documents` },
      ],
      session_load: () => null,
      // v0.23 退出确认放行（真实后端置位守卫；浏览器环境无操作）
      allow_exit: () => null,
      // 目录内容监视集合上报（v0.26.1）：真实后端轮询后回推 fs://changed；浏览器 e2e 无后端
      fs_watch_set: () => null,
      // v0.27 图标自由摆放位置表 + 画廊缩略图（e2e 环境无应用数据目录/图像解码）
      icon_positions_load: () => ({}),
      icon_positions_save: () => null,
      thumb_get: () => null,
      // v0.28 预览原图：回 1x1 PNG（e2e 只断言预览区出现 <img>，不校验像素）
      preview_data: (a) => {
        const p = String(a.path ?? "");
        if (!p.startsWith("/mock/") || !/\.(png|jpg|jpeg|gif|webp|bmp|tiff|svg)$/i.test(p)) {
          return null;
        }
        return PREVIEW_PNG;
      },
      // v0.28 文本预览：虚拟 FS 内置内容（只覆盖夹具文件，其余回空串）
      read_text_file: (a) => {
        const p = String(a.path ?? "");
        return { path: p, localPath: p, isTemp: false, lossy: false, text: TEXTS[p] ?? "", encoding: "UTF-8" };
      },
      // 未知路径报错（与真实后端一致）：同步浏览的镜像探测依赖"列目录失败 = 对侧无此目录"
      list_dir: (a) => {
        const p = String(a.path);
        listDirCalls.push(p);
        const items = FS[p];
        if (!items) throw new Error(`ENOENT: ${p}`);
        return items.map((f) => entry(p, f));
      },
      parent_dir: (a) => parentOf(String(a.path)),
      // 行内重命名：直接改虚拟 FS（右键重命名焦点回归用）
      rename_entry: (a) => {
        const p = String(a.path);
        const newName = String(a.newName).trim();
        const parent = parentOf(p);
        const dir = FS[parent];
        if (!dir) throw new Error(`ENOENT: ${parent}`);
        if (newName === "" || dir.some((x) => x.name === newName)) {
          throw new Error(`EEXIST: ${newName}`);
        }
        const idx = dir.findIndex((x) => `${parent}/${x.name}` === p);
        if (idx < 0) throw new Error(`ENOENT: ${p}`);
        dir[idx] = { ...dir[idx], name: newName };
        return `${parent}/${newName}`;
      },
      // 按裁决表复制（粘贴用）：虚拟 FS 内追加条目，返回创建路径（rename 裁决改用新名）
      copy_entries_plan: (a) => {
        const paths = (a.paths as string[]) ?? [];
        const dest = String(a.dest);
        const resolutions = (a.resolutions as Record<string, { action: string; name?: string }>) ?? {};
        copyPlans.push({ paths, dest, resolutions });
        const d = FS[dest];
        if (!d) throw new Error(`ENOENT: ${dest}`);
        const created: string[] = [];
        for (const p of paths) {
          const parent = parentOf(p);
          const f = FS[parent]?.find((x) => `${parent}/${x.name}` === p);
          if (!f) continue;
          const resolution = resolutions[`${dest}/${f.name}`];
          if (resolution?.action === "overwrite" && d.some((x) => x.name === f.name)) {
            // 覆盖 = 合并/替换语义：目标已有同名条目时保留原条目（内容替换只发生在真实后端），不追加重复
            created.push(`${dest}/${f.name}`);
            continue;
          }
          const name =
            resolution?.action === "rename" && resolution.name ? resolution.name : f.name;
          d.push({ ...f, name });
          created.push(`${dest}/${name}`);
        }
        return created;
      },
      // 无同名冲突（夹具固定不冲突）；用例可经 __rdirConflicts 注入
      scan_conflicts: (a) => {
        const w = (
          window as unknown as {
            __rdirConflicts?: (a: { paths: string[]; dest: string }) => unknown[];
          }
        );
        return w.__rdirConflicts?.(a as { paths: string[]; dest: string }) ?? [];
      },
      // v0.28 顶层同名目录重复检测：默认无重复；用例经 __rdirDirDups 注入
      scan_dir_duplicates: (a) => {
        const paths = (a.paths as string[]) ?? [];
        const dest = String(a.dest);
        const w = (window as unknown as { __rdirDirDups?: (p: string[], d: string) => { src: string; suggest: string }[] });
        return w.__rdirDirDups?.(paths, dest) ?? [];
      },
      // v0.32 解压：记录调用并返回固定统计；用例经 __rdirExtract 注入脚本化行为
      // （返回 string = 抛该错误，如「需要密码」；返回 undefined = 走默认成功）
      extract_archive: (a) => {
        const call = {
          path: String(a.path ?? ""),
          targetDir: String(a.targetDir ?? ""),
          mode: a.mode == null ? undefined : String(a.mode),
          password: (a.password as string | null) ?? null,
        };
        extractCalls.push(call);
        const w = (
          window as unknown as {
            __rdirExtract?: (c: typeof call) => string | undefined;
          }
        );
        const scripted = w.__rdirExtract?.(call);
        // 真实 Tauri 的 invoke 拒绝时透传原始错误串（不是 Error 对象），这里保持一致
        if (typeof scripted === "string") throw scripted;
        const stem = call.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "out";
        return { dest: `${call.targetDir}/${stem}`, files: 3, skipped: 1, bytes: 12345 };
      },
      // 回收站删除：直接从虚拟 FS 移除（删除确认弹窗回归用）
      delete_entries: (a) => {
        const paths = (a.paths as string[]) ?? [];
        for (const p of paths) {
          const parent = parentOf(p);
          const dir = FS[parent];
          if (dir) {
            const idx = dir.findIndex((x) => `${parent}/${x.name}` === p);
            if (idx >= 0) dir.splice(idx, 1);
          }
          delete FS[p]; // 目录连带移除其子树清单
        }
      },
      // fd 递归检索：对虚拟 FS 做子串匹配（搜索面板内联重命名回归用）
      find_files: (a) => {
        const q = String(a.pattern).toLowerCase();
        const root = String(a.dir);
        const out: { path: string; rel_path: string; is_dir: boolean }[] = [];
        const walk = (dir: string) => {
          for (const f of FS[dir] ?? []) {
            const p = `${dir}/${f.name}`;
            if (f.name.toLowerCase().includes(q)) {
              out.push({ path: p, rel_path: p.slice(root.length + 1), is_dir: !!f.dir });
            }
            if (f.dir && out.length < 500) walk(p);
          }
        };
        walk(root);
        return out.slice(0, 500);
      },
      // 返回数组（真实后端为补全列表；空数组 = 不弹补全下拉）
      complete_path: () => [],
      stat_path: (a) => {
        const p = String(a.path);
        for (const dir of Object.keys(FS)) {
          if (dir === p) return "dir";
          if (FS[dir].some((f) => `${dir}/${f.name}` === p)) {
            const f = FS[dir].find((x) => `${dir}/${x.name}` === p)!;
            return f.dir ? "dir" : f.symlink ? "symlink" : "file";
          }
        }
        // 与真实后端一致：不存在即抛错（地址栏校验依赖该语义）
        throw new Error(`ENOENT: ${p}`);
      },
      stat_paths: (a) => {
        const paths = (a.paths as string[]) ?? [];
        return paths.map((p) => {
          for (const dir of Object.keys(FS)) {
            if (dir === p) return "dir";
            if (FS[dir].some((f) => `${dir}/${f.name}` === p)) {
              const f = FS[dir].find((x) => `${dir}/${x.name}` === p)!;
              return f.dir ? "dir" : f.symlink ? "symlink" : "file";
            }
          }
          return "missing";
        });
      },
      // ---- 目录大小统计（v0.16 右键「属性」）：按虚拟 FS 递归统计 ----
      compute_size: (a) => {
        const paths = (a.paths as string[]) ?? [];
        const roots = new Set(paths);
        let bytes = 0;
        let files = 0;
        let dirs = 0;
        const entryAt = (p: string): Fake | undefined => {
          for (const dir of Object.keys(FS)) {
            const f = FS[dir].find((x) => `${dir}/${x.name}` === p);
            if (f) return f;
          }
          return undefined;
        };
        const stack: string[] = [...paths];
        while (stack.length) {
          const p = stack.pop()!;
          if (FS[p]) {
            if (!roots.has(p)) dirs += 1;
            for (const f of FS[p]) stack.push(`${p}/${f.name}`);
          } else {
            const f = entryAt(p);
            if (f?.dir) {
              if (!roots.has(p)) dirs += 1;
              for (const c of FS[p] ?? []) stack.push(`${p}/${c.name}`);
            } else {
              files += 1;
              bytes += f?.size ?? 0;
            }
          }
        }
        return { bytes, files, dirs };
      },
      cancel_size: () => null,
      // ---- 目录差异比对（v0.17/v0.18）：按虚拟 FS 顶层比对（一层/二层） ----
      diff_dirs: (a) => {
        const level = Number(a.level ?? 1);
        const left = String(a.left ?? "");
        const right = String(a.right ?? "");
        const l = FS[left] ?? [];
        const r = FS[right] ?? [];
        const names = [...new Set([...l.map((f) => f.name), ...r.map((f) => f.name)])];
        const sideOf = (dir: string, f?: Fake) =>
          f
            ? { path: `${dir}/${f.name}`, size: f.dir ? 0 : (f.size ?? 0), modified: NOW, is_dir: !!f.dir }
            : null;
        const entries = names.map((name) => {
          const le = l.find((f) => f.name === name);
          const re = r.find((f) => f.name === name);
          if (le && !re) return { name, is_dir: !!le.dir, left: sideOf(left, le), right: null, status: "left-only" };
          if (!le && re) return { name, is_dir: !!re.dir, left: null, right: sideOf(right, re), status: "right-only" };
          const isDir = !!le?.dir && !!re?.dir;
          const typeConflict = !!le && !!re && !!le.dir !== !!re.dir;
          const sizeDiff = !isDir && !typeConflict && level >= 2 && (le?.size ?? 0) !== (re?.size ?? 0);
          return {
            name,
            is_dir: isDir,
            left: sideOf(left, le),
            right: sideOf(right, re),
            status: typeConflict || sizeDiff ? "different" : "same",
            ...(typeConflict ? { reason: "type" } : sizeDiff ? { reason: "size" } : {}),
          };
        });
        return { entries, cancelled: false };
      },
      cancel_diff: () => null,
      // ---- v0.18 同步浏览「在对侧新建并进入」：本地 / SFTP 新建目录（写虚拟 FS） ----
      create_dir: (a) => {
        const parent = String(a.parent);
        const name = String(a.name);
        FS[parent] = FS[parent] ?? [];
        if (!FS[parent].some((f) => f.name === name)) FS[parent].push({ name, dir: true });
        const created = `${parent}/${name}`;
        FS[created] = FS[created] ?? [];
        return created;
      },
      sftp_mkdir: (a) => {
        const dir = String(a.dir);
        const name = String(a.name);
        FS[dir] = FS[dir] ?? [];
        if (!FS[dir].some((f) => f.name === name)) FS[dir].push({ name, dir: true });
        const created = `${dir}/${name}`;
        FS[created] = FS[created] ?? [];
        return created;
      },
      // ---- 单路径元信息（v0.17 空白处「属性（当前目录）」） ----
      create_file: (a) => {
        const parent = String(a.parent);
        const name = String(a.name);
        FS[parent] = FS[parent] ?? [];
        if (!FS[parent].some((f) => f.name === name)) FS[parent].push({ name, size: 0 });
        return `${parent}/${name}`;
      },
      stat_entry: (a) => {
        const p = String(a.path);
        const name = p.split("/").filter(Boolean).pop() ?? p;
        const isDir = !!FS[p];
        let size = 0;
        let ext = "";
        if (!isDir) {
          for (const dir of Object.keys(FS)) {
            const f = FS[dir].find((x) => `${dir}/${x.name}` === p);
            if (f) {
              size = f.size ?? 0;
              ext = f.name.split(".").pop() ?? "";
              break;
            }
          }
        }
        return {
          name,
          path: p,
          is_dir: isDir,
          is_symlink: false,
          size,
          modified: NOW,
          created: NOW,
          permissions: isDir ? "drwxr-xr-x" : "-rw-r--r--",
          extension: isDir ? "" : ext,
        };
      },
      // ---- 偏好持久化（v0.14）：默认空，测试可用 window.__RDIR_PREFS__ 注入 ----
      prefs_load: () =>
        (window as unknown as { __RDIR_PREFS__?: unknown }).__RDIR_PREFS__ ?? {},
      prefs_save: () => null,
      list_plugins: () =>
        [
          { id: "sftp", name: "SFTP 远程文件", description: "", protocols: ["sftp"], operations: ["list", "read"] },
          { id: "http", name: "HTTP 索引", description: "", protocols: ["http", "https"], operations: ["list"] },
          { id: "share", name: "窗口分享", description: "", protocols: ["share"], operations: ["serve"] },
          { id: "opener", name: "打开方式", description: "", protocols: [], operations: ["open_with"] },
          { id: "terminal", name: "终端", description: "", protocols: [], operations: ["open_terminal"] },
          { id: "cmdrun", name: "地址栏命令", description: "", protocols: [], operations: ["run"] },
        ].map((p) => ({
          ...p,
          version: "0.12.0",
          source: "builtin",
          enabled: true,
          configurable: false,
        })),
      list_openers: () => [],
      list_shells: () => [],
      // ---- 文本比较（v0.29.1 双栏同屏回归用）：超长行 + 正常行混合 ----
      diff_text_files: () => ({
        left: { path: "/mock/home/Notes.txt", localPath: "", isTemp: false, lossy: false, bytes: 100, lines: 6, eol: "lf" },
        right: { path: "/mock/home/Notes.txt", localPath: "", isTemp: false, lossy: false, bytes: 120, lines: 6, eol: "lf" },
        segments: [
          { kind: "eq", leftStart: 1, rightStart: 1, lines: ['const config = {', "  name: 'rdir',"] },
          {
            kind: "del",
            leftStart: 3,
            rightStart: null,
            lines: [
              '  url: "https://example.com/api/v2/endpoint?with=a&very=long&query=string&that=overflows&any=column&width=constraint"',
            ],
          },
          {
            kind: "add",
            leftStart: null,
            rightStart: 3,
            lines: [
              '  url: "https://example.com/api/v3/endpoint?with=a&very=long&query=string&that=overflows&any=column&width=constraint&v=3"',
            ],
          },
          { kind: "eq", leftStart: 4, rightStart: 4, lines: ["}"] },
        ],
        additions: 1,
        deletions: 1,
        same: false,
        coarse: false,
      }),
      // ---- v0.29.0 右键 VSCode / Git 打开（mock 环境一律未安装，仅验证菜单渲染） ----
      vscode_detected: () => false,
      open_vscode: () => {},
      // 默认空；用例可经 __rdirGitTools 注入（如 Git Bash 空白终端组回归）
      list_git_tools: () => {
        const w = (window as unknown as { __rdirGitTools?: () => unknown[] });
        return w.__rdirGitTools?.() ?? [];
      },
      open_git_tool: () => {},
      // ---- v0.29.0 常用工具条：固定两项（VSCode 借稳定 slug 验证固定行去重） ----
      list_quick_tools: () => [
        { id: "vscode", name: "Visual Studio Code", exec: "/mock/Applications/Visual Studio Code.app", args: "", detected: true },
        { id: "zed", name: "Zed", exec: "/mock/Applications/Zed.app", args: "", detected: true },
      ],
      open_quick_tool: (a) => {
        opened.push(String(a.path));
      },
      add_quick_tool: () => [],
      remove_quick_tool: () => [],
      move_quick_tool: () => [],
      set_quick_tool_args: () => [],
      detect_editors: () => [],
      // ---- 地址栏命令（v0.22.0）：PATH 补全桩 + 执行记录（供用例断言） ----
      complete_commands: (a) => {
        const prefix = String(a.prefix ?? "").toLowerCase();
        return CMDS.filter((c) => c.name.toLowerCase().startsWith(prefix));
      },
      run_command: (a) => {
        const input = String(a.input ?? "");
        const head = input.trim().split(/\s+/)[0] ?? "";
        if (!CMDS.some((c) => c.name === head)) {
          // 与真实后端一致：首 token 不在 PATH → 报错（前端合并为「也不是 PATH 中的命令」）
          throw new Error(`未找到命令：${head}（不在 PATH 中）`);
        }
        runCmds.push({ input, cwd: String(a.cwd ?? "") });
        return null;
      },
      // ---- SFTP：一台"已保存密码"的服务器 + 一台需要手输的服务器 ----
      sftp_list_servers: () => SFTP_SERVERS.map((s) => ({ ...s })),
      sftp_connect: (a) => {
        const cfg = a.server as Record<string, unknown> | undefined;
        const id = cfg?.id ? String(cfg.id) : `${cfg?.user}@${cfg?.host}:${cfg?.port}`;
        sftpConnects.push(id);
        const s = SFTP_SERVERS.find((x) => x.id === id);
        if (s) s.connected = true;
        return { ...(s ?? SFTP_SERVERS[0]), connected: true };
      },
      // 仅保存/连接成功都会走这里：按 id 更新可编辑字段（名称/分组/根目录），
      // connected 状态与真实后端一致取自会话池（mock 里即条目自身），不因保存而连接
      sftp_save_server: (a) => {
        const cfg = a.server as Record<string, unknown> | undefined;
        const id = cfg?.id ? String(cfg.id) : `${cfg?.user}@${cfg?.host}:${cfg?.port}`;
        const s = SFTP_SERVERS.find((x) => x.id === id);
        if (s) {
          if (cfg?.name != null) s.name = String(cfg.name);
          if (cfg?.group != null) s.group = String(cfg.group);
          if (cfg?.root !== undefined) s.root = (cfg.root as string | null) ?? null;
        }
        return SFTP_SERVERS.map((x) => ({ ...x }));
      },
      // ---- SFTP 上传（v0.22.2 拖拽上传回归）：写虚拟 FS 并记录供用例断言 ----
      sftp_upload: (a) => {
        const dest = String(a.dest ?? "");
        const name = String(a.name ?? "");
        uploads.push({ local: String(a.local ?? ""), dest, name });
        FS[dest] = FS[dest] ?? [];
        if (!FS[dest].some((f) => f.name === name)) FS[dest].push({ name, size: 42 });
        return `${dest}/${name}`;
      },
      // ---- SFTP 下载（v0.22.0 拖拽对称覆盖回归）：overwrite=false 时同名自动 " (n)" ----
      sftp_download_to: (a) => {
        const localDir = String(a.localDir ?? "");
        const path = String(a.path ?? "");
        const overwrite = !!a.overwrite;
        downloads.push({ path, localDir, overwrite });
        const name = path.split("/").filter(Boolean).pop() ?? "download";
        FS[localDir] = FS[localDir] ?? [];
        let finalName = name;
        if (!overwrite) {
          let n = 1;
          while (FS[localDir].some((f) => f.name === finalName)) {
            finalName = `${name} (${n})`;
            n += 1;
          }
        } else {
          const idx = FS[localDir].findIndex((f) => f.name === name);
          if (idx >= 0) FS[localDir].splice(idx, 1);
        }
        FS[localDir].push({ name: finalName, size: 42 });
        return `${localDir}/${finalName}`;
      },
      sftp_remove_server: () => [],
      sftp_disconnect: (a) => {
        const s = SFTP_SERVERS.find((x) => x.id === String(a.id));
        if (s) s.connected = false;
        return null;
      },
      // ---- v0.31 服务器分组整理：拖拽换组 / 分组重命名（改夹具并记录调用） ----
      sftp_set_server_group: (a) => {
        const ids = (a.ids as string[]) ?? [];
        const group = String(a.group);
        for (const s of SFTP_SERVERS) {
          if (ids.includes(s.id)) s.group = group;
        }
        sftpSetGroup.push({ ids: [...ids], group });
        return SFTP_SERVERS.map((s) => ({ ...s }));
      },
      sftp_master_key_status: () => ({ configured: false, active: false }),
      // ---- v0.31 服务器清单导出/导入（浏览器环境无真实凭据，返回固定摘要并记录调用） ----
      sftp_export_servers: (a) => {
        // v0.31.1 用例经 __rdirExportNeedsKey 模拟「清单含明文密码且主密钥未解锁」：
        // 未给主密码 → NEED_MASTER_KEY；密码固定 mk1（其余 = 主密码不正确）
        const w = window as unknown as { __rdirExportNeedsKey?: boolean };
        if (w.__rdirExportNeedsKey && a.masterKey == null) {
          throw new Error("NEED_MASTER_KEY: 存在以明文保存的服务器密码，导出前需用主密码加密");
        }
        if (a.masterKey != null && String(a.masterKey) !== "mk1") {
          throw new Error("主密码不正确");
        }
        sftpExport.push({ target: String(a.target), hasKey: a.masterKey != null });
        return { exported: 3, encrypted: a.masterKey != null };
      },
      sftp_import_servers: (a) => {
        // 用例经 __rdirImportNeedsKey 模拟「文件含密文」：未给主密码 → NEED_MASTER_KEY；
        // 密码固定 mk1（其余 = 主密码不正确），覆盖导入主密码框的完整交互
        const w = window as unknown as { __rdirImportNeedsKey?: boolean };
        if (w.__rdirImportNeedsKey && a.masterKey == null) {
          throw new Error("NEED_MASTER_KEY: 导入文件包含加密密码，需要输入导出时使用的主密码");
        }
        if (a.masterKey != null && String(a.masterKey) !== "mk1") {
          throw new Error("主密码不正确");
        }
        sftpImport.push({ filePath: String(a.filePath), hasKey: a.masterKey != null });
        return { imported: 2, skipped: 1 };
      },
      // ---- v0.31 远程打开临时目录（虚拟占用：2 个文件 3MB） ----
      sftp_temp_info: () => ({ path: "/tmp/r-dir-sftp", files: 2, bytes: 3 * 1024 * 1024 }),
      sftp_clear_temp: () => 3 * 1024 * 1024,
      // ---- v0.31 双击打开远程文件：记录下载并回确定性临时路径（断言 open_path 落点） ----
      sftp_download: (a) => {
        const p = String(a.path);
        const name = p.split("/").filter(Boolean).pop() ?? "download";
        sftpDownloads.push(p);
        return `/tmp/r-dir-sftp/${name}`;
      },
      share_list: () => [],
      plugin: () => null,
      // 文件对话框：用例可经 __rdirDialogOpen / __rdirDialogSave 注入返回路径（缺省取消）
      "plugin:dialog|open": () =>
        (window as unknown as { __rdirDialogOpen?: string | null }).__rdirDialogOpen ?? null,
      "plugin:dialog|save": () =>
        (window as unknown as { __rdirDialogSave?: string | null }).__rdirDialogSave ?? null,
      // plugin-dialog 的 confirm() 底层复用 message 命令，返回值按点击的按钮判定：
      // (await messageCommand(...)) === 'Ok' → 这里恒返回 'Ok'（确认类对话框全部确认）
      "plugin:dialog|message": () => "Ok",
      "plugin:dialog|confirm": () => true,
      "plugin:dialog|ask": () => false,
      "plugin:app|name": () => "R-Dir",
      "plugin:app|version": () => "0.11.0",
      "plugin:app|identifier": () => "com.rfm.app",
      "plugin:opener|open_path": (a) => {
        opened.push(String(a.path));
        return null;
      },
      "plugin:opener|open_url": () => null,
      "plugin:opener|reveal_item_in_dir": () => null,
      "plugin:process|exit": () => null,
      // ---- 无边框窗口自绘控制（feat-titlebar）：记录命令供用例断言 ----
      "plugin:window|minimize": () => {
        winCmds.push("minimize");
        return null;
      },
      "plugin:window|toggle_maximize": () => {
        winCmds.push("toggle_maximize");
        return null;
      },
      "plugin:window|close": () => {
        winCmds.push("close");
        return null;
      },
      "plugin:window|start_dragging": () => null,
      "plugin:window|is_maximized": () => false,
    };

    const callbacks = new Map<number, (data: unknown) => unknown>();
    let nextId = 1;
    /** 记录 opener 打开过的路径，供用例断言"双击用关联程序打开" */
    const opened: string[] = [];
    /** 记录自绘窗口控制发出的窗口命令（minimize / toggle_maximize / close） */
    const winCmds: string[] = [];
    /** PATH 可执行桩：前缀过滤语义与真实后端一致 */
    const CMDS = [
      { name: "git", path: "/usr/bin/git" },
      { name: "gitui", path: "/opt/homebrew/bin/gitui" },
      { name: "grep", path: "/usr/bin/grep" },
    ];
    /** 地址栏执行的命令记录（input + cwd），供用例断言 */
    const runCmds: { input: string; cwd: string }[] = [];
    /** list_dir 调用记录（v0.22.1 标签切换零重读回归用） */
    const listDirCalls: string[] = [];
    /** sftp_upload 记录（v0.22.2 拖拽上传回归用） */
    const uploads: { local: string; dest: string; name: string }[] = [];
    /** sftp_download_to 记录（v0.22.0 拖拽覆盖对称回归用） */
    const downloads: { path: string; localDir: string; overwrite: boolean }[] = [];
    /** v0.31 服务器导出/导入调用记录 */
    const sftpExport: { target: string; hasKey: boolean }[] = [];
    const sftpImport: { filePath: string; hasKey: boolean }[] = [];
    /** v0.31 双击打开远程文件的下载记录 */
    const sftpDownloads: string[] = [];
    /** v0.31 服务器分组整理与连接调用记录（断言「保存」不连接） */
    const sftpSetGroup: { ids: string[]; group: string }[] = [];
    const sftpConnects: string[] = [];
    /** copy_entries_plan 调用记录（v0.32 同名目录「覆盖」裁决回归用） */
    const copyPlans: {
      paths: string[];
      dest: string;
      resolutions: Record<string, { action: string; name?: string }>;
    }[] = [];
    /** extract_archive 调用记录（v0.32 解压回归用） */
    const extractCalls: {
      path: string;
      targetDir: string;
      mode?: string;
      password: string | null;
    }[] = [];

    const internals = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === "plugin:event|listen") {
          const id = Number(args.handler);
          callbacks.set(id, () => undefined);
          return id;
        }
        if (cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return null;
        const h = handlers[cmd];
        if (!h) throw new Error(`[e2e mock] 未桩化的命令：${cmd}`);
        return h(args);
      },
      transformCallback: (cb: (data: unknown) => unknown) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      convertFileSrc: (p: string) => p,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
    };

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    };
    // 更新检测（启动静默检查）不走真实网络：GitHub API 一律返回 404，测试保持离线确定
    const origFetch = window.fetch?.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("api.github.com")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "mock" }), { status: 404 }),
        );
      }
      return origFetch ? origFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
    }) as typeof window.fetch;
    (window as unknown as Record<string, unknown>).__RDIR_E2E_MOCK__ = { HOME, FS, opened, winCmds, runCmds, listDirCalls, uploads, downloads, sftpExport, sftpImport, sftpDownloads, sftpSetGroup, sftpConnects, copyPlans, extractCalls, servers: SFTP_SERVERS };
  });
}
