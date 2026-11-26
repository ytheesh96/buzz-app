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

const tabTitle = vi.hoisted(() => vi.fn());
vi.mock("../../features/panels/PanelWorkspace", () => ({
  usePanelTabTitle: tabTitle,
}));

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
  mtimeMs: 1000,
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
let canvasSave: ReturnType<typeof vi.fn>;
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
  screen.findByRole(
    "button",
    // Per-row action menus ("Actions for …") must not count as the row itself.
    { name: (label) => name.test(label) && !label.startsWith("Actions for ") },
    { timeout: 5_000 },
  );

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
        id: "head-1",
        content: workspaceCanvas({ folders, canvas: "Read-only files." }),
      })),
      save: canvasSave,
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
  tabTitle.mockClear();
  canvasSave = vi.fn(async (_channelId: string, content: string) => ({
    id: "head-2",
    content,
  }));
  FakeWebSocket.instances = [];
  FakeWebSocket.handler = (ws, msg) => {
    const display = (path: unknown) =>
      String(path).replace(/^\/home\/dev/, "~");
    const name = (path: unknown) => String(path).split("/").at(-1);
    if (msg.method === "fs.write") {
      const path = msg.params?.path;
      ws.reply(msg.id, {
        path,
        displayPath: display(path),
        name: name(path),
        size: String(msg.params?.content ?? "").length,
        mtimeMs: 2000,
      });
    }
    if (msg.method === "fs.mkdir") {
      const path = msg.params?.path;
      ws.reply(msg.id, {
        path,
        displayPath: display(path),
        name: name(path),
        kind: "dir",
        mtimeMs: 1,
      });
    }
    if (msg.method === "fs.rename") {
      const to = msg.params?.to;
      ws.reply(msg.id, {
        from: msg.params?.from,
        to,
        path: to,
        displayPath: display(to),
        name: name(to),
      });
    }
    if (msg.method === "fs.delete") {
      const path = msg.params?.path;
      ws.reply(msg.id, { path, displayPath: display(path), deleted: true });
    }
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
  expect(
    screen.getByRole("button", {
      name: (label) =>
        /README\.md/.test(label) && !label.startsWith("Actions for "),
    }),
  ).toBeVisible();
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

  await user.click(await findRow(/^README\.md/));
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

  await user.click(await findRow(/^archive\.zip/));
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

const sent = (method: string) =>
  FakeWebSocket.instances
    .flatMap((socket) => socket.sent)
    .filter((call) => call.method === method);

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await findRow(/^README\.md/));
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const editor = await screen.findByRole("textbox", { name: "Edit README.md" });
  await user.type(editor, "!");
  return editor;
}

it("registers the folder icon as the tab identity", async () => {
  renderPanel();
  await findRow(/^src/);
  const [label, icon] = tabTitle.mock.calls[0] ?? [];
  expect(label).toBe("Files");
  const { container } = render(icon);
  expect(container.querySelector(".tabler-icon-folder-open")).not.toBeNull();
  expect(container.querySelector(".tabler-icon-info-circle")).toBeNull();
});

it("edits a text file and saves it with the expected mtime", async () => {
  renderPanel();
  const user = userEvent.setup();
  await openEditor(user);

  expect(screen.getByText("Unsaved changes")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(sent("fs.write")).toHaveLength(1));
  expect(sent("fs.write")[0]?.params).toEqual({
    path: "/home/dev/project/README.md",
    content: "# Hello\n\nWorld!",
    expectedMtimeMs: 1000,
  });
  await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
});

it("saves with Ctrl+S from the editor", async () => {
  renderPanel();
  const user = userEvent.setup();
  await openEditor(user);

  await user.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(sent("fs.write")).toHaveLength(1));
  expect(sent("fs.write")[0]?.params).toMatchObject({
    content: "# Hello\n\nWorld!",
    expectedMtimeMs: 1000,
  });
});

it("discards edits and returns to the saved contents", async () => {
  renderPanel();
  const user = userEvent.setup();
  await openEditor(user);

  await user.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Edit README.md" })).toBeNull();
  expect(sent("fs.write")).toHaveLength(0);
});

it("offers to overwrite when the file changed on disk", async () => {
  renderPanel();
  const user = userEvent.setup();
  const previous = FakeWebSocket.handler;
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "fs.write" && msg.params?.expectedMtimeMs !== undefined)
      return ws.fail(msg.id, "CONFLICT: README.md changed on disk");
    previous(ws, msg);
  };
  await openEditor(user);

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/changed on disk since/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Overwrite anyway" }));
  await waitFor(() => expect(sent("fs.write")).toHaveLength(2));
  expect(sent("fs.write")[1]?.params).toEqual({
    path: "/home/dev/project/README.md",
    content: "# Hello\n\nWorld!",
  });
  await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
});

it("reloads the file from disk after a conflict", async () => {
  renderPanel();
  const user = userEvent.setup();
  const previous = FakeWebSocket.handler;
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "fs.write")
      return ws.fail(msg.id, "CONFLICT: README.md changed on disk");
    if (msg.method === "fs.read" && sent("fs.read").length > 1)
      return ws.reply(msg.id, {
        ...markdown,
        content: "# Fresh",
        mtimeMs: 3000,
      });
    previous(ws, msg);
  };
  await openEditor(user);

  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(
    await screen.findByRole("button", { name: "Reload from disk" }),
  );

  const editor = await screen.findByRole("textbox", { name: "Edit README.md" });
  await waitFor(() => expect(editor).toHaveValue("# Fresh"));
  expect(screen.queryByText(/changed on disk since/)).toBeNull();
});

it("guards unsaved edits when another file is opened", async () => {
  renderPanel();
  const user = userEvent.setup();
  await openEditor(user);

  await user.click(await findRow(/^archive\.zip/));
  expect(
    await screen.findByText(/unsaved changes to README\.md/i),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: "Edit README.md" })).toHaveValue(
    "# Hello\n\nWorld!",
  );

  await user.click(screen.getByRole("button", { name: "Close preview" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("textbox", { name: "Edit README.md" })).toBeNull();
});

it("creates a folder in the current directory", async () => {
  renderPanel();
  const user = userEvent.setup();
  await findRow(/^src/);

  await user.click(screen.getByRole("button", { name: "New folder" }));
  await user.type(
    screen.getByRole("textbox", { name: "New folder name" }),
    "docs",
  );
  await user.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(sent("fs.mkdir")).toHaveLength(1));
  expect(sent("fs.mkdir")[0]?.params).toEqual({ path: "~/dev/project/docs" });
  await waitFor(() => expect(sent("fs.list").length).toBeGreaterThan(1));
});

it("creates a new file with createOnly and opens it in the editor", async () => {
  renderPanel();
  const user = userEvent.setup();
  await findRow(/^src/);

  await user.click(screen.getByRole("button", { name: "New file" }));
  await user.type(
    screen.getByRole("textbox", { name: "New file name" }),
    "notes.txt",
  );
  await user.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(sent("fs.write")).toHaveLength(1));
  expect(sent("fs.write")[0]?.params).toEqual({
    path: "/home/dev/project/notes.txt",
    content: "",
    createOnly: true,
  });
});

it("shows a friendly message when the new file already exists", async () => {
  renderPanel();
  const user = userEvent.setup();
  const previous = FakeWebSocket.handler;
  FakeWebSocket.handler = (ws, msg) => {
    if (msg.method === "fs.write")
      return ws.fail(msg.id, "ALREADY_EXISTS: notes.txt already exists");
    previous(ws, msg);
  };
  await findRow(/^src/);

  await user.click(screen.getByRole("button", { name: "New file" }));
  await user.type(
    screen.getByRole("textbox", { name: "New file name" }),
    "notes.txt",
  );
  await user.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByText("notes.txt already exists")).toBeVisible();
});

it("renames an entry from its actions menu", async () => {
  renderPanel();
  const user = userEvent.setup();
  await findRow(/^archive\.zip/);

  await user.click(
    screen.getByRole("button", { name: "Actions for archive.zip" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "Rename archive.zip" });
  await user.clear(input);
  await user.type(input, "backup.zip{Enter}");

  await waitFor(() => expect(sent("fs.rename")).toHaveLength(1));
  expect(sent("fs.rename")[0]?.params).toEqual({
    from: "/home/dev/project/archive.zip",
    to: "/home/dev/project/backup.zip",
  });
});

it("confirms inline before deleting an entry", async () => {
  const confirm = vi.spyOn(window, "confirm");
  renderPanel();
  const user = userEvent.setup();
  await findRow(/^archive\.zip/);

  await user.click(
    screen.getByRole("button", { name: "Actions for archive.zip" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(await screen.findByText("Delete archive.zip?")).toBeVisible();
  expect(sent("fs.delete")).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(sent("fs.delete")).toHaveLength(1));
  expect(sent("fs.delete")[0]?.params).toEqual({
    path: "/home/dev/project/archive.zip",
    recursive: false,
  });
  expect(confirm).not.toHaveBeenCalled();
});

it("adds a folder to the chat workspace without leaving the listing", async () => {
  renderPanel();
  const user = userEvent.setup();
  await findRow(/^src/);
  const listsBefore = sent("fs.list").length;

  await user.click(screen.getByRole("button", { name: "Actions for src" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Add to chat workspace" }),
  );

  await waitFor(() => expect(canvasSave).toHaveBeenCalledTimes(1));
  const [savedChannel, content, parent] = canvasSave.mock.calls[0] ?? [];
  expect(savedChannel).toBe(channelId);
  expect(parent).toBe("head-1");
  expect(content).toContain("~/dev/project/src");
  expect(await screen.findByText("In workspace")).toBeVisible();
  expect(sent("fs.list")).toHaveLength(listsBefore);
});

it("pins overflowing breadcrumbs to the end segment and tracks horizontal scroll edges", async () => {
  renderPanel();
  await findRow(/^src/);

  const nav = screen.getByRole("navigation", { name: "Folder path" });
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: 120 });
  Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 280 });

  // Trigger a path change so the breadcrumb layout effect pins to the trailing segment.
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "~" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "~" })).toHaveAttribute(
      "aria-current",
      "location",
    ),
  );

  expect(nav.scrollLeft).toBe(160);
  expect(nav).toHaveAttribute("data-overflow-start");
  expect(nav).not.toHaveAttribute("data-overflow-end");

  nav.scrollLeft = 0;
  nav.dispatchEvent(new Event("scroll"));
  expect(nav).not.toHaveAttribute("data-overflow-start");
  expect(nav).toHaveAttribute("data-overflow-end");
});
