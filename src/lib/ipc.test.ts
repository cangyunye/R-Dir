import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri, listen } from "./ipc";

// Tauri 传输两端各 mock 一个最小模块：isTauri() 为真时 ipc 转发到这里
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    return { tauri: true, cmd, args };
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

/** 记录实例的可控 WebSocket 桩：测试里手动驱动 onmessage/onclose */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  /** 测试驱动：模拟服务端推帧 */
  emit(event: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, payload }) });
  }
  /** 测试驱动：模拟服务端断开 */
  drop() {
    this.onclose?.();
  }
}

const WIN = window as unknown as Record<string, unknown>;

function goWeb() {
  delete WIN.__TAURI_INTERNALS__;
  MockWebSocket.reset();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn();
}

/** 取最后一个新建的 WS 桩（webListen 懒建连） */
function lastSocket(): MockWebSocket {
  return MockWebSocket.instances.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认按桌面环境处理；web 用例经 goWeb() 删除探测键切换传输分支
  WIN.__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  WIN.__TAURI_INTERNALS__ = {};
});

describe("isTauri 传输探测", () => {
  it("有 __TAURI_INTERNALS__ → Tauri；无 → Web", () => {
    WIN.__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
    delete WIN.__TAURI_INTERNALS__;
    expect(isTauri()).toBe(false);
  });
});

describe("invoke 双传输", () => {
  it("Tauri 环境：原样转发命令与参数", async () => {
    const { invoke: tauriInvokeMock } = await import("@tauri-apps/api/core");
    const out = await invoke<string[]>("list_dir", { path: "/tmp" });
    expect(tauriInvokeMock).toHaveBeenCalledWith("list_dir", { path: "/tmp" });
    expect(out).toEqual({ tauri: true, cmd: "list_dir", args: { path: "/tmp" } });
  });

  it("Web 环境：POST /api/invoke，成功帧返回 data", async () => {
    goWeb();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: [1, 2] }), { status: 200 }),
    );
    await expect(invoke<number[]>("get_volumes")).resolves.toEqual([1, 2]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/invoke",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body).toEqual({ cmd: "get_volumes", args: {} });
  });

  it("Web 环境：错误帧按原始字符串 reject（terr 契约，不得包一层 Error）", async () => {
    goWeb();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "CANCELLED|传输已取消" }), {
        status: 200,
      }),
    );
    await expect(invoke("copy_entries")).rejects.toBe("CANCELLED|传输已取消");
  });

  it("Web 环境：网络失败/非法响应 → 码化字符串（WEB_OFFLINE / WEB_BAD_RESPONSE）", async () => {
    goWeb();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(invoke("list_dir")).rejects.toMatch(/^WEB_OFFLINE\|/);
    globalThis.fetch = vi.fn(async () => new Response("not json", { status: 502 }));
    await expect(invoke("list_dir")).rejects.toMatch(/^WEB_BAD_RESPONSE\|/);
  });
});

describe("listen 双传输", () => {
  it("Tauri 环境：转发到事件模块并透传退订函数", async () => {
    const { listen: tauriListenMock } = await import("@tauri-apps/api/event");
    const handler = vi.fn();
    const un = await listen<string>("fs://changed", handler);
    expect(tauriListenMock).toHaveBeenCalled();
    expect(typeof un).toBe("function");
  });

  it("Web 环境：同事件多订阅者扇出 payload，退订后不再接收", async () => {
    goWeb();
    const a = vi.fn();
    const b = vi.fn();
    const unA = await listen<number>("transfer-progress", a);
    const unB = await listen<number>("transfer-progress", b);
    lastSocket().emit("transfer-progress", 42);
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ payload: 42 }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ payload: 42 }));
    unA();
    lastSocket().emit("transfer-progress", 43);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    // 其他事件不受影响；帧解析失败静默
    lastSocket().emit("fs://changed", ["x"]);
    lastSocket().onmessage?.({ data: "not json" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unB(); // 用例收尾退订干净，模块级单例 socket 不泄漏到下一用例
  });

  it("Web 环境：全部退订后断开连接；仍有订阅者时服务端断开触发指数退避重连", async () => {
    vi.useFakeTimers();
    try {
      goWeb();
      const un1 = await listen("fs://changed", () => {});
      const un2 = await listen("volumes://changed", () => {});
      expect(MockWebSocket.instances).toHaveLength(1);
      un1();
      lastSocket().drop(); // 服务端断开，仍有订阅者 → 安排重连
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(500); // 首次退避 500ms
      expect(MockWebSocket.instances).toHaveLength(2);
      lastSocket().drop();
      vi.advanceTimersByTime(1000); // 二次退避翻倍
      expect(MockWebSocket.instances).toHaveLength(3);
      un2(); // 全部退订 → 主动断开，不再重连
      expect(lastSocket().closed).toBe(true);
      lastSocket().drop();
      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
