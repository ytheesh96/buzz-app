// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as plugin from "../../plugins/remote-agents/plugin.js";
import {
  addRemoteMachine,
  resetRemoteMachinesCache,
} from "../features/agents/remote-machines";

type Json = Record<string, unknown>;

/** A buzz-host that answers each request from `handlers`. */
function stubHost(handlers: Record<string, (params: Json) => unknown>) {
  const calls: { method: string; params: Json }[] = [];
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    constructor(_url: string) {
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const handler = handlers[method];
      const reply = handler
        ? { id, result: handler(params) }
        : { id, error: `unhandled ${method}` };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return calls;
}

/** Applies the plugin to a stand-in context and returns its Settings card. */
async function mountCard({
  dm,
}: {
  dm?: { people: unknown[]; send: ReturnType<typeof vi.fn> };
} = {}) {
  const open = vi.fn();
  let Card: React.ComponentType | undefined;
  const noop = () => {};
  const snapshot = {
    status: "ready",
    session: {
      directMessages: {
        available: true,
        people: async () => ({ people: dm?.people ?? [] }),
        open: async () => "dm-1",
      },
      messages: { send: dm?.send },
    },
  };
  const relay = dm
    ? { subscribe: () => noop, snapshot: () => snapshot }
    : undefined;
  const ctx = new Proxy(
    {
      react: React,
      effect: noop,
      navigation: { open },
      reflect: { get: (key: string) => (key === "relay" ? relay : undefined) },
      settingsCards: {
        register: (card: { component: React.ComponentType }) => {
          Card = card.component;
        },
      },
      inject: noop,
    } as Record<string, unknown>,
    {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : new Proxy(noop, { get: () => noop, apply: () => undefined }),
    },
  );
  await plugin.apply(ctx as never);
  if (!Card) throw new Error("the plugin registered no Settings card");
  render(<Card />);
  return { open };
}

const hello = (extra: Json = {}) => ({
  host: "omarchy",
  role: "admin",
  runtimes: [
    { title: "Claude", available: true },
    { title: "Codex", available: true },
    { title: "Gemini", available: false },
  ],
  runners: [{ title: "Docker", available: true }],
  publicGuestUrl: "wss://omarchy.example.org/_buzz-host",
  ...extra,
});
const agentsList = {
  agents: [
    { name: "a", runtime: "claude", status: "idle" },
    { name: "b", runtime: "codex", status: "idle" },
  ],
};
const token = (extra: Json) => ({
  id: "t1",
  label: "Anu",
  role: "guest",
  maxAgents: 2,
  maxConcurrency: 2,
  agentCount: 0,
  allowedRuntimes: ["claude"],
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetRemoteMachinesCache();
});

it("shows a connect call-to-action instead of a form when no machine is set up", async () => {
  stubHost({});
  const { open } = await mountCard();
  expect(screen.getByText("No machine connected")).toBeVisible();
  expect(screen.queryByLabelText(/Server/)).toBeNull();
  expect(screen.queryByLabelText(/Access token/)).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Connect a machine" }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "omarchy",
  });
});

it("shows a compact status banner with a link to Agent setup and no chat-command tutorial", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  stubHost({
    hello: () => hello(),
    list: () => agentsList,
    "tokens.list": () => ({ tokens: [] }),
  });
  const { open } = await mountCard();
  expect(await screen.findByText("Online")).toBeVisible();
  expect(screen.getByText("omarchy")).toBeVisible();
  expect(screen.getByText("2 agents · Claude, Codex")).toBeVisible();
  expect(document.body.textContent).not.toMatch(/\/model|\/effort|\/runtime/);
  expect(screen.queryByLabelText(/Server/)).toBeNull();
  expect(screen.queryByLabelText(/Access token/)).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Manage machines" }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "omarchy",
  });
});

it("says Offline with a retry when the machine cannot be reached", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  stubHost({});
  await mountCard();
  expect(await screen.findByText("Offline")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByText("Shared access")).toBeNull();
});

it("shows a guest only their account, without admin controls", async () => {
  addRemoteMachine({
    name: "Friend's",
    url: "wss://friend.example.org/_buzz-host",
    token: "bhg_x",
  });
  stubHost({
    auth: () => ({}),
    hello: () =>
      hello({
        role: "guest",
        label: "Me",
        limits: { maxAgents: 2, maxConcurrency: 2 },
      }),
    list: () => agentsList,
  });
  await mountCard();
  expect(await screen.findByText("Online")).toBeVisible();
  expect(screen.getByText(/Guest account: Me · 2\/2 agents/)).toBeVisible();
  expect(screen.queryByText("Shared access")).toBeNull();
  expect(screen.queryByRole("button", { name: "+ Invite" })).toBeNull();
});

it("lists shared access as readable rows, hides admin tokens and collapses revoked invites", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  const tokens = [
    token({ id: "a", label: "Anu", agentCount: 1 }),
    token({
      id: "b",
      label: "Ben",
      ownerPubkey: "ab".repeat(32),
      allowHostDesktop: true,
    }),
    token({ id: "c", label: "Cy" }),
    token({ id: "d", label: "Dee", revokedAt: 1 }),
    token({ id: "e", label: "Admin token", role: "admin" }),
  ];
  stubHost({
    hello: () => hello(),
    list: () => agentsList,
    "tokens.list": () => ({ tokens }),
  });
  await mountCard();
  expect(await screen.findByText("Anu")).toBeVisible();
  expect(screen.getByText("1/2 agents · Sandboxed · In use")).toBeVisible();
  expect(
    screen.getByText("0/2 agents · Trusted host access · Invited via Buzz DM"),
  ).toBeVisible();
  expect(
    screen.getByText("0/2 agents · Sandboxed · Not used yet"),
  ).toBeVisible();
  expect(document.body.textContent).not.toMatch(/unbound|binds on first/);
  expect(screen.queryByText("Admin token")).toBeNull();
  expect(screen.queryByText("Dee")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Show revoked invites (1)" }),
  );
  expect(screen.getByText(/Dee · 0\/2 agents · revoked/)).toBeVisible();
});

it("revokes an invite", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  let tokens = [token({ id: "a", label: "Anu" })];
  const calls = stubHost({
    hello: () => hello(),
    list: () => agentsList,
    "tokens.list": () => ({ tokens }),
    "tokens.revoke": ({ id }) => {
      tokens = tokens.map((t) => (t.id === id ? { ...t, revokedAt: 1 } : t));
      return {};
    },
  });
  await mountCard();
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke Anu" }),
  );
  await waitFor(() =>
    expect(calls.some((c) => c.method === "tokens.revoke")).toBe(true),
  );
  expect(
    await screen.findByRole("button", { name: "Show revoked invites (1)" }),
  ).toBeVisible();
});

it("invites a Buzz member in two steps and hides limits until asked", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  const send = vi.fn(() => "event-1");
  const calls = stubHost({
    hello: () => hello(),
    list: () => agentsList,
    "tokens.list": () => ({ tokens: [] }),
    "tokens.create": (p) => ({
      token: "bhg_0123456789abcdef",
      inviteUrl:
        "wss://omarchy.example.org/_buzz-host#token=bhg_0123456789abcdef",
      record: { label: p.label },
    }),
  });
  await mountCard({
    dm: {
      people: [{ pubkey: "cd".repeat(32), name: "Anu", username: "anu" }],
      send,
    },
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "+ Invite" }),
  );
  // Primary flow: no pubkey field, limits collapsed.
  expect(document.body.textContent).not.toMatch(/64-char|hex pubkey/);
  expect(
    screen.getByText("Limits & permissions").closest("details"),
  ).not.toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "Send Invite" })).toBeDisabled();
  await userEvent.click(await screen.findByRole("button", { name: /^Anu/ }));
  await userEvent.click(screen.getByRole("button", { name: "Send Invite" }));
  await waitFor(() => expect(send).toHaveBeenCalled());
  const create = calls.find((c) => c.method === "tokens.create");
  expect(create?.params).toMatchObject({
    label: "Anu",
    ownerPubkey: "cd".repeat(32),
    maxAgents: 2,
    maxConcurrency: 2,
    allowHostDesktop: false,
    allowSandboxDesktop: true,
  });
  expect(await screen.findByText(/Invite sent to Anu in Buzz/)).toBeVisible();
});

it("offers a shareable link instead, with the optional key tucked under limits", async () => {
  addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org/_buzz-host",
  });
  const calls = stubHost({
    hello: () => hello(),
    list: () => agentsList,
    "tokens.list": () => ({ tokens: [] }),
    "tokens.create": (p) => ({
      token: "bhg_fedcba9876543210",
      inviteUrl:
        "wss://omarchy.example.org/_buzz-host#token=bhg_fedcba9876543210",
      record: { label: p.label },
    }),
  });
  await mountCard({ dm: { people: [], send: vi.fn() } });
  await userEvent.click(
    await screen.findByRole("button", { name: "+ Invite" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Create a shareable link instead" }),
  );
  await userEvent.type(screen.getByLabelText(/Friend's name/), "Zed");
  await userEvent.click(screen.getByText("Limits & permissions"));
  const trusted = screen.getByLabelText(/Allow host access & remote desktop/);
  await userEvent.click(trusted);
  await userEvent.click(screen.getByRole("button", { name: "Create link" }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "tokens.create")).toBe(true),
  );
  expect(calls.find((c) => c.method === "tokens.create")?.params).toMatchObject(
    {
      label: "Zed",
      allowHostDesktop: true,
    },
  );
  expect(await screen.findByLabelText("Invite link")).toHaveValue(
    "wss://omarchy.example.org/_buzz-host#token=bhg_fedcba9876543210",
  );
});
