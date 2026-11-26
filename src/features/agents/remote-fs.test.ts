// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tauriMock = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke:
    vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriMock.isTauri,
  invoke: tauriMock.invoke,
}));

import { resetIrohTunnelCache } from "./iroh-tunnel";
import {
  browsableRemoteMachines,
  cleanRemoteFsErrorMessage,
  deleteRemoteEntry,
  isRemoteFsAlreadyExists,
  isRemoteFsConflict,
  isRemoteFsUnsupported,
  joinRemotePath,
  listRemoteDirectory,
  mkdirRemoteDirectory,
  readRemoteFile,
  REMOTE_FS_UNSUPPORTED_MESSAGE,
  remotePathCrumbs,
  renameRemoteEntry,
  resetRemoteFsSessions,
  writeRemoteFile,
  type RemoteFsMachine,
} from "./remote-fs";
import type { RemoteMachine } from "./remote-machines";

class FakeWebSocket {
  static handler: (
    ws: FakeWebSocket,
    msg: { id: number; method: string; params?: Record<string, unknown> },
  ) => void = () => {};
  static instances: FakeWebSocket[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  sent: Array<{
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.();
    });
  }

  send(raw: string) {
    const parsed = JSON.parse(raw) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(parsed);
    FakeWebSocket.handler(this, parsed);
  }

  reply(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }

  fail(id: number, error: string) {
    this.onmessage?.({ data: JSON.stringify({ id, error }) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

const listing = {
  path: "/home/dev",
  displayPath: "~/dev",
  home: "/home/dev",
  parent: "/home",
  parentDisplay: "~",
  truncated: false,
  entries: [
    {
      name: "project",
      path: "/home/dev/project",
      displayPath: "~/dev/project",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 1_700_000_000_000,
      hidden: false,
      isGitRepo: true,
    },
    {
      name: "notes.txt",
      path: "/home/dev/notes.txt",
      displayPath: "~/dev/notes.txt",
      kind: "file",
      targetKind: null,
      size: 12,
      mtimeMs: 1_700_000_000_000,
      hidden: false,
      isGitRepo: false,
    },
  ],
};

const machine: RemoteFsMachine = {
  id: "box",
  url: "wss://box.example.org/_buzz-host",
  token: "bha_token",
  routes: [{ type: "wss", url: "wss://box.example.org/_buzz-host" }],
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.handler = () => {};
  resetRemoteFsSessions();
  resetIrohTunnelCache();
  tauriMock.isTauri.mockReset();
  tauriMock.isTauri.mockReturnValue(false);
  tauriMock.invoke.mockReset();
});

afterEach(() => {
  resetRemoteFsSessions();
  vi.useRealTimers();
});

it("authenticates, lists a directory, and parses the locked contract", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, { role: "admin" });
    if (msg.method === "fs.list") ws.reply(msg.id, listing);
  };
  const result = await listRemoteDirectory(
    machine,
    { path: "~/dev", dirsOnly: true, showHidden: true },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(FakeWebSocket.instances[0]?.sent.map((m) => m.method)).toEqual([
    "auth",
    "fs.list",
  ]);
  expect(FakeWebSocket.instances[0]?.sent[1]?.params).toEqual({
    path: "~/dev",
    dirsOnly: true,
    showHidden: true,
  });
  expect(result).toMatchObject({
    path: "/home/dev",
    displayPath: "~/dev",
    parent: "/home",
    parentDisplay: "~",
    truncated: false,
  });
  expect(result.entries[0]).toMatchObject({
    name: "project",
    kind: "dir",
    isGitRepo: true,
  });
  expect(result.entries[1]).toMatchObject({ name: "notes.txt", size: 12 });
});

it("reads a file and keeps image metadata", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.read")
      ws.reply(msg.id, {
        path: "/home/dev/picture.png",
        displayPath: "~/dev/picture.png",
        name: "picture.png",
        size: 2048,
        mtimeMs: 1_700_000_000_000,
        mimeType: "image/png",
        encoding: "base64",
        isBinary: true,
        isImage: true,
        truncated: false,
        content: "iVBORw0KGgo=",
      });
  };
  const result = await readRemoteFile(
    machine,
    { path: "~/dev/picture.png", maxBytes: 4096 },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]).toMatchObject({
    method: "fs.read",
    params: { path: "~/dev/picture.png", maxBytes: 4096 },
  });
  expect(result).toMatchObject({
    name: "picture.png",
    mimeType: "image/png",
    encoding: "base64",
    isImage: true,
    content: "iVBORw0KGgo=",
  });
});

it("falls back from a failed Iroh tunnel to the machine's wss route", async () => {
  tauriMock.isTauri.mockReturnValue(true);
  tauriMock.invoke.mockImplementation(async (cmd) => {
    if (cmd === "iroh_tunnel_available") return true;
    if (cmd === "iroh_tunnel_endpoint")
      return "ws://127.0.0.1:44444/t/abc/m_box";
    return undefined;
  });
  const attempts: string[] = [];
  class RouteWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    url: string;

    constructor(url: string) {
      this.url = url;
      attempts.push(url);
      queueMicrotask(() => {
        if (url.startsWith("ws://127.0.0.1:")) this.onclose?.();
        else this.onopen?.();
      });
    }

    send(raw: string) {
      const msg = JSON.parse(raw) as { id: number; method: string };
      if (msg.method === "auth")
        this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: {} }) });
      if (msg.method === "fs.list")
        this.onmessage?.({
          data: JSON.stringify({ id: msg.id, result: listing }),
        });
    }

    close() {
      this.onclose?.();
    }
  }
  const result = await listRemoteDirectory(
    {
      id: "box",
      url: "wss://good.example.org/_buzz-host",
      token: "bha_token",
      routes: [
        { type: "iroh", nodeId: "abc", endpointAddr: "endpoint.example.org" },
        { type: "wss", url: "wss://good.example.org/_buzz-host" },
      ],
    },
    {},
    { WebSocketImpl: RouteWebSocket as unknown as typeof WebSocket },
  );
  expect(attempts).toEqual([
    "ws://127.0.0.1:44444/t/abc/m_box",
    "wss://good.example.org/_buzz-host",
  ]);
  expect(result.displayPath).toBe("~/dev");
});

it("maps an older host's unknown method to the upgrade message", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.list") ws.fail(msg.id, "Unknown method: fs.list");
  };
  const error = await listRemoteDirectory(
    machine,
    {},
    {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    },
  ).catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    name: "RemoteFsUnsupportedError",
    message: REMOTE_FS_UNSUPPORTED_MESSAGE,
  });
  expect(isRemoteFsUnsupported(error)).toBe(true);
});

it("rejects a malformed listing instead of rendering it", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.list") ws.reply(msg.id, { entries: "nope" });
  };
  await expect(
    listRemoteDirectory(
      machine,
      {},
      {
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      },
    ),
  ).rejects.toThrow(/invalid file listing/);
});

it("reuses one socket for consecutive calls and closes it when idle", async () => {
  vi.useFakeTimers();
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.list") ws.reply(msg.id, listing);
  };
  const options = {
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  };
  await listRemoteDirectory(machine, {}, options);
  await listRemoteDirectory(machine, { path: "~" }, options);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(
    FakeWebSocket.instances[0]?.sent.filter((m) => m.method === "auth"),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(FakeWebSocket.instances[0]?.closed).toBe(true);

  await listRemoteDirectory(machine, {}, options);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("aborts an in-flight request without closing the pool", async () => {
  let started: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.list") started?.();
  };
  const controller = new AbortController();
  const pending = listRemoteDirectory(
    machine,
    {},
    {
      signal: controller.signal,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    },
  );
  await sent;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWebSocket.instances[0]?.closed).toBe(false);
});

it("offers admin, guest, and unresolved manual machines, online first", () => {
  const base = {
    url: "wss://box.example.org/_buzz-host",
    token: "",
    routes: [] as const,
  };
  const machines: RemoteMachine[] = [
    { ...base, id: "guest", name: "Guest", role: "guest", source: "manual" },
    { ...base, id: "manual", name: "Manual", source: "manual" },
    {
      ...base,
      id: "admin",
      name: "Admin",
      role: "admin",
      source: "discovered",
    },
  ];
  expect(
    browsableRemoteMachines(machines, {
      admin: { state: "online" },
      manual: { state: "offline" },
    }).map(({ id }) => id),
  ).toEqual(["admin", "guest", "manual"]);
});

it("builds breadcrumbs for home-relative and absolute display paths", () => {
  expect(remotePathCrumbs("~/dev/app")).toEqual([
    { label: "~", path: "~" },
    { label: "dev", path: "~/dev" },
    { label: "app", path: "~/dev/app" },
  ]);
  expect(remotePathCrumbs("/home/dev")).toEqual([
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "dev", path: "/home/dev" },
  ]);
});

it("writes a file and parses the locked contract", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.write")
      ws.reply(msg.id, {
        path: "/home/dev/notes.txt",
        displayPath: "~/dev/notes.txt",
        name: "notes.txt",
        size: 42,
        mtimeMs: 1_700_000_000_500,
      });
  };
  const result = await writeRemoteFile(
    machine,
    {
      path: "~/dev/notes.txt",
      content: "hello",
      expectedMtimeMs: 1_700_000_000_000,
    },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]).toMatchObject({
    method: "fs.write",
    params: {
      path: "~/dev/notes.txt",
      content: "hello",
      expectedMtimeMs: 1_700_000_000_000,
    },
  });
  expect(result).toMatchObject({
    path: "/home/dev/notes.txt",
    displayPath: "~/dev/notes.txt",
    name: "notes.txt",
    size: 42,
    mtimeMs: 1_700_000_000_500,
  });
});

it("passes createOnly and omits undefined optional params", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.write")
      ws.reply(msg.id, {
        path: "/home/dev/new.md",
        displayPath: "~/dev/new.md",
        name: "new.md",
        size: 0,
        mtimeMs: 1,
      });
  };
  await writeRemoteFile(
    machine,
    { path: "/home/dev/new.md", content: "", createOnly: true },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]?.params).toEqual({
    path: "/home/dev/new.md",
    content: "",
    createOnly: true,
  });
});

it("creates a directory and parses the locked contract", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.mkdir")
      ws.reply(msg.id, {
        path: "/home/dev/project/src",
        displayPath: "~/dev/project/src",
        name: "src",
        kind: "dir",
        mtimeMs: 1_700_000_000_500,
      });
  };
  const result = await mkdirRemoteDirectory(
    machine,
    { path: "~/dev/project/src" },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]).toMatchObject({
    method: "fs.mkdir",
    params: { path: "~/dev/project/src" },
  });
  expect(result).toMatchObject({
    path: "/home/dev/project/src",
    name: "src",
    kind: "dir",
  });
});

it("renames an entry and parses the locked contract", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.rename")
      ws.reply(msg.id, {
        from: "/home/dev/old.txt",
        to: "/home/dev/new.txt",
        path: "/home/dev/new.txt",
        displayPath: "~/dev/new.txt",
        name: "new.txt",
      });
  };
  const result = await renameRemoteEntry(
    machine,
    { from: "/home/dev/old.txt", to: "/home/dev/new.txt" },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]).toMatchObject({
    method: "fs.rename",
    params: { from: "/home/dev/old.txt", to: "/home/dev/new.txt" },
  });
  expect(result).toMatchObject({
    from: "/home/dev/old.txt",
    to: "/home/dev/new.txt",
    displayPath: "~/dev/new.txt",
  });
});

it("deletes an entry with recursive for directories", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.delete")
      ws.reply(msg.id, {
        path: "/home/dev/project",
        displayPath: "~/dev/project",
        deleted: true,
      });
  };
  const result = await deleteRemoteEntry(
    machine,
    { path: "/home/dev/project", recursive: true },
    { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket },
  );
  expect(FakeWebSocket.instances[0]?.sent[1]).toMatchObject({
    method: "fs.delete",
    params: { path: "/home/dev/project", recursive: true },
  });
  expect(result).toMatchObject({ deleted: true, displayPath: "~/dev/project" });
});

it("surfaces CONFLICT and ALREADY_EXISTS errors with clean messages", async () => {
  const conflict = new Error("CONFLICT: File changed on disk.");
  const exists = new Error("ALREADY_EXISTS: notes.txt exists.");
  const plain = new Error("Something else failed.");
  expect(isRemoteFsConflict(conflict)).toBe(true);
  expect(isRemoteFsConflict(exists)).toBe(false);
  expect(isRemoteFsAlreadyExists(exists)).toBe(true);
  expect(isRemoteFsAlreadyExists(conflict)).toBe(false);
  expect(isRemoteFsAlreadyExists(plain)).toBe(false);
  expect(isRemoteFsConflict(plain)).toBe(false);
  expect(cleanRemoteFsErrorMessage("CONFLICT: File changed on disk.")).toBe(
    "File changed on disk.",
  );
  expect(cleanRemoteFsErrorMessage("ALREADY_EXISTS: notes.txt exists.")).toBe(
    "notes.txt exists.",
  );
  expect(cleanRemoteFsErrorMessage("Keep me")).toBe("Keep me");
});

it("maps a guest-permission refusal to the upgrade notice", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "auth") ws.reply(msg.id, {});
    if (msg.method === "fs.list")
      ws.fail(msg.id, "not permitted for guest accounts");
  };
  const error = await listRemoteDirectory(
    machine,
    {},
    {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    },
  ).catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    name: "RemoteFsUnsupportedError",
    message: REMOTE_FS_UNSUPPORTED_MESSAGE,
  });
  expect(isRemoteFsUnsupported(error)).toBe(true);
});

it("joins names onto directory paths without double slashes", () => {
  expect(joinRemotePath("~/dev", "app")).toBe("~/dev/app");
  expect(joinRemotePath("~/dev/", "app")).toBe("~/dev/app");
  expect(joinRemotePath("~", "app")).toBe("~/app");
  expect(joinRemotePath("/", "etc")).toBe("/etc");
  expect(joinRemotePath("/home/dev", "notes.txt")).toBe("/home/dev/notes.txt");
  expect(joinRemotePath("", "etc")).toBe("/etc");
  expect(joinRemotePath("~/dev", "  ")).toBe("~/dev");
  expect(joinRemotePath("/home/dev/", "/notes.txt")).toBe(
    "/home/dev/notes.txt",
  );
});
