// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { MachineEditorDialog } from "./RemoteMachinesSettings";
import { ProviderDialog } from "../bundled/agents/ProviderDialog";
import { selfHostedProvider } from "../bundled/self-hosted-provider";
import type { RegisteredAgentType } from "../features/agents/service";
import { CloudIcon } from "../shared/design-system/icons";
import {
  addRemoteMachine,
  remoteMachinesSnapshot,
  resetRemoteMachinesCache,
  SELF_HOSTED_TYPE_KEY,
} from "../features/agents/remote-machines";

class StubWebSocket {
  static mode: "ok" | "fail" = "ok";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(_url: string) {
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.();
    });
  }

  send(raw: string) {
    const msg = JSON.parse(raw) as { id: number; method: string };
    if (StubWebSocket.mode === "fail") {
      this.onmessage?.({
        data: JSON.stringify({ id: msg.id, error: "connection refused" }),
      });
      return;
    }
    if (msg.method === "auth") {
      this.onmessage?.({
        data: JSON.stringify({ id: msg.id, result: { role: "admin" } }),
      });
    } else if (msg.method === "hello") {
      this.onmessage?.({
        data: JSON.stringify({
          id: msg.id,
          result: {
            host: "mac-mini.local",
            platform: "darwin",
            role: "admin",
            capabilities: { desktop: false },
          },
        }),
      });
    } else if (msg.method === "list") {
      this.onmessage?.({
        data: JSON.stringify({
          id: msg.id,
          result: { agents: [{ pubkey: "abc123", name: "MacBot" }] },
        }),
      });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  StubWebSocket.mode = "ok";
  vi.stubGlobal("WebSocket", StubWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetRemoteMachinesCache();
});

const selfHosted = {
  key: SELF_HOSTED_TYPE_KEY,
  pluginId: "local.buzz-host",
  revision: "bundled",
  id: "omarchy",
  title: "Self-hosted",
  icon: CloudIcon,
  defaults: () => ({ config: {} }),
  provider: selfHostedProvider,
} satisfies RegisteredAgentType;

function renderManager() {
  return render(
    <ProviderDialog
      type={selfHosted}
      finalFocus={createRef<HTMLElement>()}
      onClose={() => {}}
    />,
  );
}

it("adds a machine from a 1-paste pairing link, shows platform/online status, and removes it inside one dialog", async () => {
  const user = userEvent.setup();
  renderManager();

  expect(screen.getByRole("dialog", { name: "Self-hosted" })).toBeVisible();
  expect(screen.getByText("No remote machines connected")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add machine" }));

  // Add replaces the list in place rather than stacking a second modal.
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  const urlInput = screen.getByLabelText("Server URL or pairing link");
  expect(urlInput).toHaveFocus();
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  expect(urlInput).toHaveValue("wss://mac-mini.example.org/_buzz-host");
  expect(screen.getByLabelText(/Machine name/)).toHaveAttribute(
    "placeholder",
    "Mac Mini",
  );
  expect(screen.getByLabelText(/Access token/)).toHaveValue("bha_secret123");

  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  expect(await screen.findByText("Mac Mini")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Self-hosted" })).toBeVisible();
  expect(screen.queryByLabelText("Server URL or pairing link")).toBeNull();
  expect(screen.getByText("macOS")).toBeVisible();
  expect(await screen.findByText("Online")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "Remove Mac Mini" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen.getByRole("heading", { name: "Remove Mac Mini?" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText("No remote machines connected")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(0);
});

it("returns to the list when editing is cancelled, focusing the row's Edit button", async () => {
  const user = userEvent.setup();
  renderManager();
  await user.click(screen.getByRole("button", { name: "Add machine" }));
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  await user.click(screen.getByRole("button", { name: "Connect and save" }));
  const edit = await screen.findByRole("button", { name: "Edit Mac Mini" });

  await user.click(edit);
  expect(screen.getByRole("heading", { name: "Edit Mac Mini" })).toBeVisible();
  expect(screen.getByLabelText("Server URL or pairing link")).toHaveValue(
    "wss://mac-mini.example.org/_buzz-host",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Edit Mac Mini" })).toHaveFocus();
});

it("lets the user save an offline machine anyway when the initial probe fails", async () => {
  StubWebSocket.mode = "fail";
  const user = userEvent.setup();
  renderManager();

  await user.click(screen.getByRole("button", { name: "Add machine" }));
  await user.type(
    screen.getByLabelText("Server URL or pairing link"),
    "wss://offline-box.example.org/_buzz-host#token=bha_offline",
  );
  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "connection refused",
  );
  await user.click(screen.getByRole("button", { name: "Save anyway" }));

  expect(await screen.findByText("Offline Box")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(1);
  expect(remoteMachinesSnapshot()[0]?.token).toBe("bha_offline");
});

it("moves a typed pairing link's token into the token field on blur, not while typing", async () => {
  const user = userEvent.setup();
  render(<MachineEditorDialog onClose={() => {}} />);

  const urlInput = screen.getByLabelText("Server URL or pairing link");
  await user.type(urlInput, "wss://box.example.org/_buzz-host#token=bha_typed");
  // Typing is never interrupted mid-entry.
  expect(urlInput).toHaveValue(
    "wss://box.example.org/_buzz-host#token=bha_typed",
  );
  expect(urlInput).toHaveFocus();

  await user.tab();
  expect(urlInput).toHaveValue("wss://box.example.org/_buzz-host");
  expect(screen.getByLabelText(/Access token/)).toHaveValue("bha_typed");
});

it("adds a machine from the standalone dialog used by Create agent", async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<MachineEditorDialog onClose={onClose} onSaved={onSaved} />);

  expect(screen.getByRole("dialog", { name: /Add machine/ })).toBeVisible();
  await user.click(screen.getByLabelText("Server URL or pairing link"));
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onSaved).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Mac Mini", token: "bha_secret123" }),
  );
});

it("renders Discovered and Iroh badges for an iroh-only machine and lets the user edit it without a wss:// URL", async () => {
  const user = userEvent.setup();
  addRemoteMachine({
    id: "m_iroh_only",
    name: "Omarchy Mesh",
    source: "discovered",
    platform: "linux",
    routes: [
      {
        type: "iroh",
        nodeId: "abcdef0123456789fedcba",
        endpointAddr: "eyJpZCI6ImFiYyJ9",
      },
    ],
  });

  renderManager();

  expect(screen.getByText("Omarchy Mesh")).toBeVisible();
  expect(screen.getByText("Linux")).toBeVisible();
  expect(screen.getByText("Iroh")).toBeVisible();
  expect(screen.getByText("Discovered")).toBeVisible();
  expect(screen.getByText("abcdef012345…")).toBeVisible();
  expect(screen.queryByText("WSS")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Edit Omarchy Mesh" }));
  expect(
    screen.getByRole("heading", { name: "Edit Omarchy Mesh" }),
  ).toBeVisible();
  expect(screen.getByLabelText(/Server URL or pairing link/)).toHaveValue("");

  await user.clear(screen.getByLabelText(/Machine name/));
  await user.type(screen.getByLabelText(/Machine name/), "Omarchy Studio");
  await user.type(screen.getByLabelText(/Access token/), "bha_iroh_secret");
  await user.click(screen.getByRole("button", { name: "Save" }));

  // In non-Tauri jsdom, probing an Iroh-only machine fails gracefully and offers Save anyway.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /Iroh tunnel is unavailable/,
  );
  await user.click(screen.getByRole("button", { name: "Save anyway" }));

  expect(await screen.findByText("Omarchy Studio")).toBeVisible();
  const saved = remoteMachinesSnapshot()[0];
  expect(saved).toMatchObject({
    id: "m_iroh_only",
    name: "Omarchy Studio",
    url: "",
    token: "bha_iroh_secret",
    routes: [
      {
        type: "iroh",
        nodeId: "abcdef0123456789fedcba",
        endpointAddr: "eyJpZCI6ImFiYyJ9",
      },
    ],
  });
});

it("shows the active WSS badge for a wss-backed machine when online", async () => {
  const user = userEvent.setup();
  renderManager();

  await user.click(screen.getByRole("button", { name: "Add machine" }));
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  expect(await screen.findByText("Online")).toBeVisible();
  expect(screen.getByText("WSS")).toBeVisible();
  expect(screen.queryByText("Discovered")).toBeNull();
});
