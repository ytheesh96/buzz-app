// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RemoteMachine } from "../agents/remote-machines";
import {
  listRemoteDirectory,
  RemoteFsUnsupportedError,
  type RemoteFsListResult,
} from "../agents/remote-fs";
import { RemoteFolderPickerDialog } from "./RemoteFolderPickerDialog";

vi.mock("../agents/remote-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/remote-fs")>();
  return { ...actual, listRemoteDirectory: vi.fn() };
});

const list = vi.mocked(listRemoteDirectory);

const machine: RemoteMachine = {
  id: "m1",
  name: "Studio",
  url: "wss://studio.example.org/_buzz-host",
  token: "",
  routes: [{ type: "wss", url: "wss://studio.example.org/_buzz-host" }],
  source: "manual",
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

const home: RemoteFsListResult = {
  ...dev,
  path: "/home",
  displayPath: "~",
  parent: "/",
  parentDisplay: "/",
  entries: [
    {
      name: "newest",
      path: "/home/newest",
      displayPath: "~/newest",
      kind: "dir",
      targetKind: null,
      size: 4096,
      mtimeMs: 0,
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
});
afterEach(() => cleanup());

function renderPicker({
  machines = [machine],
  onSelect = vi.fn(),
  onOpenChange = vi.fn(),
}: {
  machines?: RemoteMachine[];
  onSelect?: (path: string) => void;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  render(
    <RemoteFolderPickerDialog
      open
      onOpenChange={onOpenChange}
      machines={machines}
      onSelect={onSelect}
    />,
  );
  return { onSelect, onOpenChange };
}

it("lists folders, filters them, and returns the current display path", async () => {
  list.mockResolvedValue(dev);
  const { onSelect, onOpenChange } = renderPicker();
  const user = userEvent.setup();

  expect(await screen.findByRole("button", { name: /project/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /notes/ })).toBeVisible();
  expect(screen.getByText("Git")).toBeVisible();
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

  await user.click(screen.getByRole("button", { name: "Select folder" }));
  expect(onSelect).toHaveBeenCalledWith("~/dev");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("opens a folder on double-click or Enter and selects a highlighted row", async () => {
  list.mockResolvedValueOnce(dev).mockResolvedValue(project);
  const { onSelect } = renderPicker();
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
  expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue(
    "~/dev/project",
  );
  expect(screen.getByRole("button", { name: /stale/ })).toBeVisible();

  list.mockResolvedValueOnce(dev);
  const up = screen.getByRole("button", { name: "Go up" });
  await user.click(up);
  const notes = await screen.findByRole("button", { name: /notes/ });
  await user.click(notes);
  expect(notes).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Select folder" }));
  expect(onSelect).toHaveBeenLastCalledWith("~/dev/notes");
});

it("navigates from an edited path on Enter", async () => {
  list.mockResolvedValueOnce(dev).mockResolvedValueOnce(project);
  renderPicker();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /project/ });
  const path = screen.getByRole("textbox", { name: "Path" });
  await user.clear(path);
  await user.type(path, "~/dev/project{Enter}");
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      machine,
      { path: "~/dev/project", dirsOnly: true, showHidden: false },
      expect.anything(),
    ),
  );
});

it("shows the buzz-host upgrade notice when the host lacks fs.list", async () => {
  list.mockRejectedValue(new RemoteFsUnsupportedError());
  renderPicker();
  expect(
    await screen.findByText(
      "Update buzz-host on this machine to browse files.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Files are unavailable")).toBeVisible();
});

it("keeps the newest directory when an older request resolves late", async () => {
  const first = deferred();
  const second = deferred();
  list
    .mockResolvedValueOnce(dev)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  renderPicker();
  const user = userEvent.setup();

  await user.dblClick(await screen.findByRole("button", { name: /project/ }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

  await user.click(screen.getByRole("button", { name: "~" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

  second.resolve(home);
  expect(await screen.findByRole("button", { name: /newest/ })).toBeVisible();

  first.resolve(project);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /newest/ })).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: /stale/ })).toBeNull();
});
