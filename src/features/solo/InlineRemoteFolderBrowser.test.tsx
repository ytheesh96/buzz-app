// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RemoteMachine } from "../agents/remote-machines";
import {
  listRemoteDirectory,
  mkdirRemoteDirectory,
  RemoteFsUnsupportedError,
  type RemoteFsListResult,
} from "../agents/remote-fs";
import { InlineRemoteFolderBrowser } from "./InlineRemoteFolderBrowser";

vi.mock("../agents/remote-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/remote-fs")>();
  return {
    ...actual,
    listRemoteDirectory: vi.fn(),
    mkdirRemoteDirectory: vi.fn(),
  };
});

const list = vi.mocked(listRemoteDirectory);
const mkdir = vi.mocked(mkdirRemoteDirectory);

const machine: RemoteMachine = {
  id: "m1",
  name: "Studio",
  url: "wss://studio.example.org/_buzz-host",
  token: "",
  routes: [{ type: "wss", url: "wss://studio.example.org/_buzz-host" }],
  source: "manual",
};

const lab: RemoteMachine = {
  ...machine,
  id: "m2",
  name: "Lab",
  url: "wss://lab.example.org/_buzz-host",
  routes: [{ type: "wss", url: "wss://lab.example.org/_buzz-host" }],
};

const dev: RemoteFsListResult = {
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
      mtimeMs: 0,
      hidden: false,
      isGitRepo: true,
    },
    {
      name: "notes",
      path: "/home/dev/notes",
      displayPath: "~/dev/notes",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 0,
      hidden: false,
      isGitRepo: false,
    },
  ],
};

const project: RemoteFsListResult = {
  ...dev,
  path: "/home/dev/project",
  displayPath: "~/dev/project",
  parent: "/home/dev",
  parentDisplay: "~/dev",
  entries: [
    {
      name: "stale",
      path: "/home/dev/project/stale",
      displayPath: "~/dev/project/stale",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 0,
      hidden: false,
      isGitRepo: false,
    },
  ],
};

const fresh: RemoteFsListResult = {
  ...project,
  entries: [
    {
      name: "brand-new",
      path: "/home/dev/project/brand-new",
      displayPath: "~/dev/project/brand-new",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 1_700_000_000_000,
      hidden: false,
      isGitRepo: false,
    },
  ],
};

function deferred() {
  let resolve:
    | ((value: RemoteFsListResult | PromiseLike<RemoteFsListResult>) => void)
    | undefined;
  const promise = new Promise<RemoteFsListResult>((done) => {
    resolve = done;
  });
  return { promise, resolve: resolve as (value: RemoteFsListResult) => void };
}

beforeEach(() => {
  list.mockReset();
  mkdir.mockReset();
});
afterEach(() => cleanup());

function renderBrowser({
  machines = [machine],
  initialPath,
  onSelect = vi.fn(),
  onClose = vi.fn(),
}: {
  machines?: RemoteMachine[];
  initialPath?: string;
  onSelect?: (path: string) => void;
  onClose?: () => void;
} = {}) {
  render(
    <InlineRemoteFolderBrowser
      machines={machines}
      initialPath={initialPath}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose };
}

it("lists folders, filters them, and selects the current display path", async () => {
  list.mockResolvedValue(dev);
  const { onSelect, onClose } = renderBrowser();
  const user = userEvent.setup();

  expect(await screen.findByRole("button", { name: /project/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /notes/ })).toBeVisible();
  expect(screen.getByText("Git")).toBeVisible();
  expect(screen.getByText("Studio")).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
  expect(list).toHaveBeenCalledWith(
    machine,
    { dirsOnly: true, showHidden: false },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );

  await user.type(
    screen.getByRole("textbox", { name: "Filter folders" }),
    "pro",
  );
  expect(screen.getByRole("button", { name: /project/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /notes/ })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(onSelect).toHaveBeenCalledWith("~/dev");
  expect(onClose).not.toHaveBeenCalled();
});

it("opens a folder on double-click or Enter and selects a child row", async () => {
  list.mockResolvedValueOnce(dev).mockResolvedValue(project);
  const { onSelect } = renderBrowser();
  const user = userEvent.setup();
  const row = await screen.findByRole("button", { name: /project/ });

  await user.dblClick(row);
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      machine,
      { path: "~/dev/project", dirsOnly: true, showHidden: false },
      expect.anything(),
    ),
  );
  expect(screen.getByRole("button", { name: /stale/ })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Select" }));
  expect(onSelect).toHaveBeenCalledWith("~/dev/project/stale");
});

it("navigates from breadcrumbs and the up button", async () => {
  list
    .mockResolvedValueOnce(dev)
    .mockResolvedValueOnce(project)
    .mockResolvedValueOnce(dev);
  renderBrowser();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /project/ });

  await user.click(screen.getByRole("button", { name: "Go up" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      machine,
      { path: "/home", dirsOnly: true, showHidden: false },
      expect.anything(),
    ),
  );

  await user.click(screen.getByRole("button", { name: "~" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      machine,
      { path: "~", dirsOnly: true, showHidden: false },
      expect.anything(),
    ),
  );
});

it("creates a folder inline and navigates into it", async () => {
  list.mockResolvedValueOnce(dev).mockResolvedValueOnce(fresh);
  mkdir.mockResolvedValue({
    path: "/home/dev/project/brand-new",
    displayPath: "~/dev/project/brand-new",
    name: "brand-new",
    kind: "dir",
    mtimeMs: 1_700_000_000_000,
  });
  renderBrowser();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /project/ });

  await user.click(screen.getByRole("button", { name: "New folder" }));
  const name = screen.getByRole("textbox", { name: "New folder name" });
  await user.type(name, "brand-new{Enter}");
  await waitFor(() =>
    expect(mkdir).toHaveBeenCalledWith(machine, { path: "~/dev/brand-new" }),
  );
  expect(
    await screen.findByRole("button", { name: /brand-new/ }),
  ).toBeVisible();
});

it("offers a machine selector with several machines", async () => {
  list.mockResolvedValue(dev);
  renderBrowser({ machines: [machine, lab] });
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /project/ });

  await user.click(screen.getByRole("combobox", { name: "Machine" }));
  await user.click(await screen.findByRole("option", { name: "Lab" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      lab,
      { dirsOnly: true, showHidden: false },
      expect.anything(),
    ),
  );
});

it("reloads with hidden folders after the toggle", async () => {
  list.mockResolvedValue(dev);
  renderBrowser();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /project/ });

  await user.click(screen.getByRole("button", { name: "Show hidden folders" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      machine,
      { dirsOnly: true, showHidden: true },
      expect.anything(),
    ),
  );
});

it("starts at the requested path", async () => {
  list.mockResolvedValue(project);
  renderBrowser({ initialPath: "~/dev/project" });
  expect(await screen.findByRole("button", { name: /stale/ })).toBeVisible();
  expect(list).toHaveBeenCalledWith(
    machine,
    { path: "~/dev/project", dirsOnly: true, showHidden: false },
    expect.anything(),
  );
});

it("shows the buzz-host upgrade notice when the host lacks fs.list", async () => {
  list.mockRejectedValue(new RemoteFsUnsupportedError());
  renderBrowser();
  expect(
    await screen.findByText(
      "Update buzz-host on this machine to browse files.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Files are unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Use this folder" }),
  ).toBeDisabled();
});

it("keeps the newest directory when an older request resolves late", async () => {
  const first = deferred();
  const second = deferred();
  list
    .mockResolvedValueOnce(dev)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  renderBrowser();
  const user = userEvent.setup();

  await user.dblClick(await screen.findByRole("button", { name: /project/ }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

  await user.click(screen.getByRole("button", { name: "~" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

  second.resolve(fresh);
  expect(
    await screen.findByRole("button", { name: /brand-new/ }),
  ).toBeVisible();

  first.resolve(project);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /brand-new/ })).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: /stale/ })).toBeNull();
});
