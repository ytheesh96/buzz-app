// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { WorkspaceFields } from "./WorkspaceFields";
import type { Workspace } from "./workspace";
import {
  addRemoteMachine,
  resetRemoteMachinesCache,
} from "../agents/remote-machines";

vi.mock("./RemoteFolderPickerDialog", () => ({
  RemoteFolderPickerDialog: ({
    open,
    title,
    onSelect,
    onOpenChange,
  }: {
    open: boolean;
    title?: string;
    onSelect(path: string): void;
    onOpenChange(open: boolean): void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button
          type="button"
          onClick={() => {
            onSelect("~/remote/project");
            onOpenChange(false);
          }}
        >
          Pick remote folder
        </button>
      </div>
    ) : null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  localStorage.clear();
  resetRemoteMachinesCache();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetRemoteMachinesCache();
  vi.resetAllMocks();
});
function Form({ folders = ["~/original"] }: { folders?: string[] }) {
  const [value, setValue] = useState<Workspace>({
    folders,
    worktree: { location: "~/worktrees", baseBranch: "main" },
    canvas: "Keep this",
  });
  return <WorkspaceFields value={value} onChange={setValue} />;
}
it("adds a picked folder, preserves other fields, ignores cancellation and duplicates", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("~/chosen")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("~/chosen");
  render(<Form />);
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "Add folder…" });
  await user.click(add);
  expect(invoke).toHaveBeenCalledWith("workspace_pick_folder", {
    title: "Add a folder",
  });
  expect(screen.getByRole("button", { name: "Remove chosen" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep this",
  );
  expect(add).toHaveFocus();
  await user.click(add);
  expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
  await user.click(add);
  expect(await screen.findByRole("alert")).toHaveTextContent("Already added.");
  expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
});
it("removing a folder moves focus to the next remove button, then to Add", async () => {
  vi.mocked(invoke).mockResolvedValueOnce("~/second");
  render(<Form />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add folder…" }));
  await user.click(screen.getByRole("button", { name: "Remove original" }));
  expect(screen.getByRole("button", { name: "Remove second" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Remove second" }));
  expect(screen.getByRole("button", { name: "Add folder…" })).toHaveFocus();
});
it("opens the worktree picker at the current location and keeps it when the picker fails", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Picker unavailable"));
  render(<Form />);
  const location = screen.getByRole("button", {
    name: "Worktree location: ~/worktrees",
  });
  await userEvent.setup().click(location);
  expect(invoke).toHaveBeenCalledWith("workspace_pick_folder", {
    title: "Choose a worktree location",
    start: "~/worktrees",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Picker unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Worktree location: ~/worktrees" }),
  ).toBeEnabled();
  expect(location).toHaveFocus();
});

it.each([true, false])(
  "shows the folder requirement and clears it on either recovery path (native: %s)",
  async (native) => {
    vi.mocked(isTauri).mockReturnValue(native);
    vi.mocked(invoke).mockResolvedValue("~/chosen");
    render(<Form folders={["  "]} />);
    const user = userEvent.setup();
    const toggle = screen.getByRole("switch", {
      name: "Work in a new worktree",
    });
    const label = screen.getByText(/^Folders/);
    const message = "Add at least one folder to use a new worktree.";
    const control = native
      ? screen.getByRole("button", { name: "Add folder…" })
      : screen.getByRole("textbox", { name: /^Folders/ });

    expect(label).not.toHaveTextContent("Optional");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(control).toHaveAccessibleDescription(message);
    await user.click(toggle);
    expect(label).toHaveTextContent("Optional");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(control).not.toHaveAccessibleDescription(message);
    await user.click(toggle);
    expect(screen.getByRole("alert")).toHaveTextContent(message);

    if (native) await user.click(control);
    else {
      await user.type(control, "~/chosen{Enter}");
      expect(control).toHaveValue("");
    }
    expect(screen.getByRole("button", { name: "Remove chosen" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(control).not.toHaveAccessibleDescription(message);
    expect(label).not.toHaveTextContent("Optional");
    await user.click(screen.getByRole("button", { name: "Remove chosen" }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(control).toHaveAccessibleDescription(message);
  },
);

it("keeps the requirement after picker cancellation and preserves picker failures", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("Picker unavailable"))
    .mockResolvedValueOnce("~/chosen");
  render(<Form folders={[]} />);
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "Add folder…" });
  await user.click(add);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Add at least one folder to use a new worktree.",
  );
  expect(add).toHaveFocus();
  await user.click(add);
  expect(screen.getByRole("alert")).toHaveTextContent("Picker unavailable");
  expect(add).toHaveAccessibleDescription("Picker unavailable");
  await user.click(add);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Remove chosen" })).toBeVisible();
});

it("offers remote browsing only when a machine that is not a guest is configured", () => {
  const { unmount } = render(<Form />);
  expect(screen.queryByRole("button", { name: "Browse remote…" })).toBeNull();
  unmount();
  addRemoteMachine({
    name: "Studio",
    url: "wss://studio.example.org/_buzz-host",
  });
  render(<Form />);
  expect(screen.getByRole("button", { name: "Browse remote…" })).toBeVisible();
});

it("adds a folder selected on a remote machine", async () => {
  addRemoteMachine({
    name: "Studio",
    url: "wss://studio.example.org/_buzz-host",
  });
  render(<Form folders={[]} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Browse remote…" }));
  await user.click(screen.getByRole("button", { name: "Pick remote folder" }));
  expect(screen.getByRole("button", { name: "Remove project" })).toBeVisible();
  expect(screen.getByText("~/remote/project")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers this computer and the remote machines for the worktree location", async () => {
  addRemoteMachine({
    name: "Studio",
    url: "wss://studio.example.org/_buzz-host",
  });
  render(<Form />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Worktree location: ~/worktrees" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "This computer" }),
  ).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Studio" }));
  await user.click(
    await screen.findByRole("button", { name: "Pick remote folder" }),
  );
  expect(
    screen.getByRole("button", {
      name: "Worktree location: ~/remote/project",
    }),
  ).toBeVisible();
});
