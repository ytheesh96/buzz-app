// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "@deepseek-ai/cordis";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  addRemoteMachine,
  resetRemoteMachinesCache,
  setAgentMachine,
  type RemoteMachine,
} from "../../features/agents/remote-machines";
import { resetRemoteFsSessions } from "../../features/agents/remote-fs";
import { workspaceCanvas } from "../../features/solo/workspace";
import { registerRemoteFiles } from "./remote-files-panel";

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

const channelId = "11111111-1111-4111-8111-111111111111";
const agent = "a".repeat(64);

const project = {
  path: "/home/dev/project",
  displayPath: "~/dev/project",
  home: "/home/dev",
  parent: "/home/dev",
  parentDisplay: "~/dev",
  truncated: false,
  entries: [
    {
      name: "src",
      path: "/home/dev/project/src",
      displayPath: "~/dev/project/src",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 0,
      hidden: false,
      isGitRepo: true,
    },
    {
      name: "README.md",
      path: "/home/dev/project/README.md",
      displayPath: "~/dev/project/README.md",
      kind: "file",
      targetKind: null,
      size: 2048,
      mtimeMs: 0,
      hidden: false,
      isGitRepo: false,
    },
    {
      name: "archive.zip",
      path: "/home/dev/project/archive.zip",
      displayPath: "~/dev/project/archive.zip",
      kind: "file",
      targetKind: null,
      size: 4096,
      mtimeMs: 0,
      hidden: false,
      isGitRepo: false,
    },
  ],
};

const home = {
  ...project,
  path: "/home/dev",
  displayPath: "~",
  parent: "/home",
  parentDisplay: "/",
  entries: [],
};

const markdown = {
  path: "/home/dev/project/README.md",
  displayPath: "~/dev/project/README.md",
  name: "README.md",
  size: 2048,
  mtimeMs: 0,
  mimeType: "text/markdown",
  encoding: "utf8",
  isBinary: false,
  isImage: false,
  truncated: false,
  content: "# Hello\n\nWorld",
};

const archive = {
  path: "/home/dev/project/archive.zip",
  displayPath: "~/dev/project/archive.zip",
  name: "archive.zip",
  size: 4096,
  mtimeMs: 0,
  mimeType: "application/zip",
  encoding: "binary",
  isBinary: true,
  isImage: false,
  truncated: false,
  content: null,
};

let snapshot: unknown;
let originalWebSocket: typeof WebSocket;

function panelFor(): RegisteredPanel {
  let registered: RegisteredPanel | undefined;
  const ctx = {
    panels: {
      register(panel: RegisteredPanel) {
        registered = panel;
      },
    },
    relay: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
    },
  } as unknown as Context;
  registerRemoteFiles(ctx);
  if (!registered) throw new Error("Files panel did not register");
  return registered;
}

const findRow = (name: RegExp) =>
  // A cold worker can take over a second to finish the canvas read and first RPC.
  screen.findByRole("button", { name }, { timeout: 5_000 });

function renderPanel() {
  const panel = panelFor();
  const Panel = panel.component;
  render(
    <Panel
      target="buzz.files"
      close={() => {}}
      channelContext={{
        scope: "scope",
        channelId,
        channelName: "Remote work",
        viewer: "viewer",
        relayUrl: "https://relay.example.org",
      }}
    />,
  );
  return panel;
}

function connect({
  members = [agent],
  folders = ["~/dev/project"],
}: {
  members?: string[];
  folders?: string[];
} = {}) {
  const session = {
    canvas: {
      read: vi.fn(async () => ({
        content: workspaceCanvas({ folders, canvas: "Read-only files." }),
      })),
    },
    channels: {
      list: () => ({
        status: "ready",
        channels: [{ id: channelId, name: "Remote work", members }],
      }),
    },
  };
  snapshot = { status: "ready", scope: "scope", generation: 1, session };
}

let studio: RemoteMachine;
let lab: RemoteMachine;

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  resetRemoteFsSessions();
  FakeWebSocket.instances = [];
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "fs.list") {
      const path = msg.params?.path;
      ws.reply(
        msg.id,
        path === "~/dev/project" || path === "/home/dev/project"
          ? project
          : home,
      );
    }
    if (msg.method === "fs.read") {
      const path = msg.params?.path;
      ws.reply(
        msg.id,
        path === "/home/dev/project/README.md" ? markdown : archive,
      );
    }
  };
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  studio = addRemoteMachine({
    name: "Studio",
    url: "wss://studio.example.org/_buzz-host",
  });
  lab = addRemoteMachine({
    name: "Lab",
    url: "wss://lab.example.org/_buzz-host",
  });
  setAgentMachine(agent, studio.id);
  connect();
});

afterEach(() => {
  cleanup();
  resetRemoteFsSessions();
  globalThis.WebSocket = originalWebSocket;
  localStorage.clear();
  resetRemoteMachinesCache();
});

it("defaults to the chat's mapped machine and first workspace folder", async () => {
  renderPanel();

  expect(await findRow(/src/)).toBeVisible();
  expect(screen.getByText("Git")).toBeVisible();
  expect(screen.getByRole("button", { name: /README\.md/ })).toBeVisible();
  expect(screen.getByText("2.0 KB")).toBeVisible();
  const socket = FakeWebSocket.instances.at(-1);
  expect(socket?.url).toBe("wss://studio.example.org/_buzz-host");
  expect(socket?.sent[0]).toMatchObject({
    method: "fs.list",
    params: { path: "~/dev/project", showHidden: false },
  });
  expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent(
    "~/dev/project",
  );
});

it("previews Markdown and toggles the raw source", async () => {
  renderPanel();
  const user = userEvent.setup();

  await user.click(await findRow(/README\.md/));
  expect(
    await screen.findByRole("heading", { name: "Hello" }, { timeout: 5_000 }),
  ).toBeVisible();
  expect(FakeWebSocket.instances.at(-1)?.sent.at(-1)).toMatchObject({
    method: "fs.read",
    params: { path: "/home/dev/project/README.md" },
  });

  await user.click(screen.getByRole("button", { name: "Raw" }));
  expect(screen.getByText("# Hello")).toBeVisible();
});

it("shows a binary notice instead of preparing unsafe content", async () => {
  renderPanel();
  const user = userEvent.setup();

  await user.click(await findRow(/archive\.zip/));
  expect(
    await screen.findByText("Binary file", {}, { timeout: 5_000 }),
  ).toBeVisible();
  expect(screen.getByText("4.0 KB · application/zip")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy contents" })).toBeDisabled();
});

it("switches machines and starts at Home when the chat has no folders", async () => {
  connect({ folders: [] });
  renderPanel();
  const user = userEvent.setup();

  await waitFor(() =>
    expect(
      FakeWebSocket.instances
        .at(-1)
        ?.sent.find(({ method }) => method === "fs.list"),
    ).toMatchObject({ params: { path: "~", showHidden: false } }),
  );
  expect(FakeWebSocket.instances.at(-1)?.url).toBe(
    "wss://studio.example.org/_buzz-host",
  );

  await user.click(screen.getByRole("combobox", { name: "Machine" }));
  await user.click(await screen.findByRole("option", { name: "Lab" }));
  await waitFor(() =>
    expect(FakeWebSocket.instances.at(-1)?.url).toBe(lab.url),
  );
  expect(
    FakeWebSocket.instances
      .at(-1)
      ?.sent.find(({ method }) => method === "fs.list"),
  ).toMatchObject({ params: { path: "~" } });
});

it("shows the upgrade notice when buzz-host is too old", async () => {
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "fs.list") ws.fail(msg.id, "Unknown method: fs.list");
  };
  renderPanel();
  expect(
    await screen.findByText(
      "Update buzz-host on this machine to browse files.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Files are unavailable")).toBeVisible();
});

it("shows a setup state when no remote machine is configured", () => {
  resetRemoteMachinesCache();
  localStorage.clear();
  renderPanel();
  expect(screen.getByText("No remote machines")).toBeVisible();
});

it("launches the Files tab only when a browsable machine exists", () => {
  const panel = panelFor();
  const Launcher = panel.channelLauncher;
  if (!Launcher) throw new Error("Files launcher did not register");
  const context = {
    scope: "scope",
    channelId,
    channelName: "Remote work",
    viewer: "viewer",
    relayUrl: "https://relay.example.org",
  };
  const toggle = vi.fn();
  const props = {
    context,
    pressed: false,
    toggle,
    available: () => true,
    canOpen: () => false,
    open: () => false,
  };
  const { unmount } = render(<Launcher {...props} />);
  const launcher = screen.getByRole("button", { name: "Toggle files" });
  expect(launcher).toBeInTheDocument();
  launcher.click();
  expect(toggle).toHaveBeenCalledWith("buzz.files");
  unmount();

  resetRemoteMachinesCache();
  localStorage.clear();
  render(<Launcher {...props} />);
  expect(screen.queryByRole("button", { name: "Toggle files" })).toBeNull();
});
