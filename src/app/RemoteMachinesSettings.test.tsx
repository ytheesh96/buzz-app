// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteMachinesSettings } from "./RemoteMachinesSettings";
import {
  remoteMachinesSnapshot,
  resetRemoteMachinesCache,
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

it("adds a machine from a 1-paste pairing link, shows platform/online status, and removes it", async () => {
  const user = userEvent.setup();
  render(<RemoteMachinesSettings active />);

  expect(screen.getByText("No remote machines connected")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add machine" }));

  const urlInput = screen.getByLabelText("Server URL or pairing link");
  await user.click(urlInput);
  await user.paste("wss://mac-mini.example.org/_buzz-host#token=bha_secret123");
  expect(urlInput).toHaveValue("wss://mac-mini.example.org/_buzz-host");
  expect(screen.getByLabelText(/Machine name/)).toHaveAttribute(
    "placeholder",
    "Mac Mini",
  );
  expect(screen.getByLabelText(/Access token/)).toHaveValue("bha_secret123");

  await user.click(screen.getByRole("button", { name: "Connect and save" }));

  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Mac Mini")).toBeVisible();
  expect(screen.getByText("macOS")).toBeVisible();
  expect(await screen.findByText("Online")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "Remove Mac Mini" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText("No remote machines connected")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(0);
});

it("lets the user save an offline machine anyway when the initial probe fails", async () => {
  StubWebSocket.mode = "fail";
  const user = userEvent.setup();
  render(<RemoteMachinesSettings active />);

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

  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Offline Box")).toBeVisible();
  expect(remoteMachinesSnapshot()).toHaveLength(1);
});
