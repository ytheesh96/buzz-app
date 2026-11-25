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
  static helloExtra: Record<string, unknown> = {};
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
            ...StubWebSocket.helloExtra,
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
  StubWebSocket.helloExtra = {};
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
  const urlInput = screen.getByLabelText("Pairing link or server address");
  expect(urlInput).toHaveFocus();
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  expect(urlInput).toHaveValue("wss://mac-mini.example.org/_buzz-host");
  expect(screen.getByLabelText(/Machine name/)).toHaveAttribute(
    "placeholder",
    "Mac Mini",
  );
  expect(screen.getByText("Access token detected")).toBeVisible();
  expect(screen.queryByLabelText(/Access token/)).toBeNull();

  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  expect(await screen.findByText("Mac Mini")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Self-hosted" })).toBeVisible();
  expect(screen.queryByLabelText("Pairing link or server address")).toBeNull();
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
  expect(screen.getByLabelText("Pairing link or server address")).toHaveValue(
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
    screen.getByLabelText("Pairing link or server address"),
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

  const urlInput = screen.getByLabelText("Pairing link or server address");
  await user.type(urlInput, "wss://box.example.org/_buzz-host#token=bha_typed");
  // Typing is never interrupted mid-entry.
  expect(urlInput).toHaveValue(
    "wss://box.example.org/_buzz-host#token=bha_typed",
  );
  expect(urlInput).toHaveFocus();

  await user.tab();
  expect(urlInput).toHaveValue("wss://box.example.org/_buzz-host");
  expect(screen.getByText("Access token detected")).toBeVisible();
  // The token can still be reviewed or replaced.
  await user.click(screen.getByRole("button", { name: "Change" }));
  expect(screen.getByLabelText(/Access token/)).toHaveValue("bha_typed");
});

it("shows the manual address and an optional token field without CLI jargon", () => {
  render(<MachineEditorDialog onClose={() => {}} />);
  expect(screen.getByLabelText(/Access token/)).toHaveValue("");
  expect(screen.queryByText("Access token detected")).toBeNull();
  const form = screen.getByRole("dialog");
  expect(form.textContent).not.toMatch(
    /bha_|bhg_|buzz-host-tokens|Funnel|zrok/,
  );
});

it("adds a machine from the standalone dialog used by Create agent", async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<MachineEditorDialog onClose={onClose} onSaved={onSaved} />);

  expect(screen.getByRole("dialog", { name: /Add machine/ })).toBeVisible();
  await user.click(screen.getByLabelText("Pairing link or server address"));
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
  expect(screen.getByLabelText(/Pairing link or server address/)).toHaveValue(
    "",
  );

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

it("promotes a matching discovered card in place instead of creating a duplicate when adding manually", async () => {
  const hostUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  addRemoteMachine({
    id: hostUuid,
    name: "mac-mini",
    source: "discovered",
    platform: "darwin",
    routes: [
      {
        type: "iroh",
        nodeId: "node-mac-1234",
        endpointAddr: "eyJpZCI6Im1hYyJ9",
      },
      { type: "wss", url: "wss://mac-mini.example.org/_buzz-host" },
    ],
  });

  const user = userEvent.setup();
  renderManager();

  await user.click(screen.getByRole("button", { name: "Add machine" }));
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  expect(await screen.findByText("Mac Mini")).toBeVisible();
  const machines = remoteMachinesSnapshot();
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    id: hostUuid,
    name: "Mac Mini",
    source: "manual",
    url: "wss://mac-mini.example.org/_buzz-host",
    token: "bha_secret123",
  });
  expect(machines[0]?.routes).toEqual([
    {
      type: "iroh",
      nodeId: "node-mac-1234",
      endpointAddr: "eyJpZCI6Im1hYyJ9",
    },
    { type: "wss", url: "wss://mac-mini.example.org/_buzz-host" },
  ]);
});

it("keeps a tokened discovered card separate when adding a tokenless admin URL for the same host", async () => {
  const hostUuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  StubWebSocket.helloExtra = { machineId: hostUuid };
  addRemoteMachine({
    id: hostUuid,
    name: "mac-mini",
    source: "discovered",
    url: "wss://mac-mini.example.org/_buzz-host",
    token: "bha_guest",
  });

  const user = userEvent.setup();
  renderManager();

  await user.click(screen.getByRole("button", { name: "Add machine" }));
  await user.paste("wss://mac-mini.example.org:8447");
  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  await waitFor(() =>
    expect(
      remoteMachinesSnapshot().find((m) => m.id === hostUuid)?.source,
    ).toBe("manual"),
  );
  const machines = remoteMachinesSnapshot();
  expect(machines).toHaveLength(2);
  expect(machines.find((m) => m.id !== hostUuid)).toMatchObject({
    url: "wss://mac-mini.example.org:8447",
    token: "",
  });
  expect(machines.find((m) => m.id === hostUuid)).toMatchObject({
    url: "wss://mac-mini.example.org/_buzz-host",
    token: "bha_guest",
  });
});
