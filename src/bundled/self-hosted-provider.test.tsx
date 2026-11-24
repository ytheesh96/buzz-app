// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addRemoteMachine,
  refreshRemoteMachine,
  remoteMachineStatusesSnapshot,
  resetRemoteMachinesCache,
} from "../features/agents/remote-machines";
import { CloudIcon } from "../shared/design-system/icons";
import {
  selfHostedProvider,
  withSelfHostedProvider,
} from "./self-hosted-provider";

/** A buzz-host that never answers: every probe ends offline. */
class ClosedWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    queueMicrotask(() => this.onclose?.());
  }
  send() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  vi.stubGlobal("WebSocket", ClosedWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetRemoteMachinesCache();
});

it("asks to connect a machine, is ready once one is configured, and asks to manage machines when all are offline", async () => {
  const listener = vi.fn();
  const stop = selfHostedProvider.subscribe(listener);
  expect(selfHostedProvider.snapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Connect a machine",
    attentionDescription: "Connect a Linux or macOS machine running buzz-host.",
  });
  // No machines: nothing to check.
  expect(selfHostedProvider.check()).toBeUndefined();

  const box = addRemoteMachine({
    name: "Box",
    url: "wss://box.example.org/_buzz-host",
  });
  expect(listener).toHaveBeenCalled();
  // Not checked yet: usable, and its snapshot is stable between reads.
  expect(selfHostedProvider.snapshot()).toEqual({ readiness: "ready" });
  expect(selfHostedProvider.snapshot()).toBe(selfHostedProvider.snapshot());

  await selfHostedProvider.check();
  expect(remoteMachineStatusesSnapshot()[box.id]?.state).toBe("offline");
  expect(selfHostedProvider.snapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Manage machines",
    attentionDescription: "Box is offline.",
  });

  const other = addRemoteMachine({
    name: "Other",
    url: "wss://other.example.org",
  });
  expect(selfHostedProvider.snapshot()).toEqual({ readiness: "ready" });
  await refreshRemoteMachine(other.id);
  expect(selfHostedProvider.snapshot()).toMatchObject({
    readiness: "attention",
    attentionDescription: "None of your machines are reachable.",
  });
  stop();
});

it("gives only the Self-hosted type the provider and icon, through a real plugin context", async () => {
  const register = vi.fn();
  const registerTab = vi.fn();
  const cleanup = vi.fn();
  const root = new Context();
  root.provide("agents", { register, registerTab });
  const fiber = root.plugin(
    withSelfHostedProvider({
      apply(ctx) {
        ctx.agents.register({ id: "omarchy", title: "Self-hosted" } as never);
        ctx.agents.register({ id: "other", title: "Other" } as never);
        ctx.agents.registerTab({ id: "tab" } as never);
        ctx.effect(() => cleanup);
      },
    }),
  );
  await fiber;
  expect(register).toHaveBeenNthCalledWith(1, {
    id: "omarchy",
    title: "Self-hosted",
    icon: CloudIcon,
    provider: selfHostedProvider,
  });
  expect(register).toHaveBeenNthCalledWith(2, { id: "other", title: "Other" });
  expect(registerTab).toHaveBeenCalledWith({ id: "tab" });
  expect(cleanup).not.toHaveBeenCalled();
  await fiber.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});
