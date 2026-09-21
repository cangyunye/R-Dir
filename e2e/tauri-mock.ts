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

    type Fake = { name: string; dir?: boolean; size?: number; symlink?: boolean };

    const FS: Record<string, Fake[]> = {
      "/mock": [{ name: "home", dir: true }],
      [HOME]: [
        { name: "Documents", dir: true },
        { name: "Projects", dir: true },
        { name: "Notes.txt", size: 1234 },
        { name: "photo.png", size: 204800 },
        { name: "link-to-docs", dir: true, symlink: true },
      ],
      [`${HOME}/Documents`]: [{ name: "readme.md", size: 42 }],
      [`${HOME}/Projects`]: [{ name: "app.ts", size: 900 }],
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
    ];    const entry = (dir: string, f: Fake) => ({
      name: f.name,
      path: `${dir}/${f.name}`,
      is_dir: !!f.dir,
      is_symlink: !!f.symlink,
      size: f.dir ? 0 : (f.size ?? 0),
      modified: NOW,
      created: NOW,
      permissions: f.dir ? "drwxr-xr-x" : "-rw-r--r--",
      extension: f.dir ? "" : (f.name.split(".").pop() ?? ""),
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
      list_dir: (a) => (FS[String(a.path)] ?? []).map((f) => entry(String(a.path), f)),
      parent_dir: (a) => parentOf(String(a.path)),
      complete_path: (a) => String(a.path),
      stat_path: (a) => {
        const p = String(a.path);
        for (const dir of Object.keys(FS)) {
          if (dir === p) return "dir";
          if (FS[dir].some((f) => `${dir}/${f.name}` === p)) {
            const f = FS[dir].find((x) => `${dir}/${x.name}` === p)!;
            return f.dir ? "dir" : f.symlink ? "symlink" : "file";
          }
        }
        return "file";
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
      list_plugins: () => [
        { id: "sftp", name: "SFTP 远程文件", description: "", enabled: true, builtin: true },
        { id: "http", name: "HTTP 索引", description: "", enabled: true, builtin: true },
        { id: "share", name: "窗口分享", description: "", enabled: true, builtin: true },
        { id: "opener", name: "打开方式", description: "", enabled: true, builtin: true },
        { id: "terminal", name: "终端", description: "", enabled: true, builtin: true },
      ],
      list_openers: () => [],
      list_shells: () => [],
      // ---- SFTP：一台"已保存密码"的服务器 + 一台需要手输的服务器 ----
      sftp_list_servers: () => SFTP_SERVERS.map((s) => ({ ...s })),
      sftp_connect: (a) => {
        const cfg = a.config as Record<string, unknown> | undefined;
        const id = cfg?.id ? String(cfg.id) : `${cfg?.user}@${cfg?.host}:${cfg?.port}`;
        const s = SFTP_SERVERS.find((x) => x.id === id);
        return { ...(s ?? SFTP_SERVERS[0]), connected: true };
      },
      sftp_save_server: () => SFTP_SERVERS.map((s) => ({ ...s, connected: true })),
      sftp_remove_server: () => [],
      sftp_disconnect: () => null,
      sftp_master_key_status: () => ({ configured: false, active: false }),
      share_list: () => [],
      plugin: () => null,
      "plugin:dialog|open": () => null,
      "plugin:dialog|save": () => null,
      "plugin:dialog|message": () => null,
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
    };

    const callbacks = new Map<number, (data: unknown) => unknown>();
    let nextId = 1;
    /** 记录 opener 打开过的路径，供用例断言"双击用关联程序打开" */
    const opened: string[] = [];

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
    (window as unknown as Record<string, unknown>).__RDIR_E2E_MOCK__ = { HOME, FS, opened };
  });
}
