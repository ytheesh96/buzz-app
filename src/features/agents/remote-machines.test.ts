// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_MACHINE_KEY,
  LEGACY_TOKEN_KEY,
  LEGACY_URL_KEY,
  REMOTE_MACHINES_KEY,
  activeMachineIdSnapshot,
  addRemoteMachine,
  agentHostMapSnapshot,
  deriveMachineName,
  formatPlatformLabel,
  machineForAgent,
  mergeAgentMachines,
  parseMachineInput,
  preferredRoute,
  primaryWssUrl,
  probeRemoteMachine,
  refreshRemoteMachine,
  remoteMachineNameForAgent,
  remoteMachineStatusesSnapshot,
  remoteMachinesSnapshot,
  removeRemoteMachine,
  resetRemoteMachinesCache,
  selectActiveMachine,
  setAgentMachine,
  updateRemoteMachine,
  upsertDiscoveredMachine,
} from "./remote-machines";

class FakeWebSocket {
  static handler: (
    ws: FakeWebSocket,
    msg: { id: number; method: string; params?: Record<string, unknown> },
  ) => void = () => {};
  static openImmediately = true;
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
    if (FakeWebSocket.openImmediately) {
      queueMicrotask(() => {
        if (!this.closed) this.onopen?.();
      });
    }
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

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  FakeWebSocket.instances = [];
  FakeWebSocket.openImmediately = true;
  FakeWebSocket.handler = () => {};
});

afterEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
});

describe("remote-machines", () => {
  it("parses wss:// URLs and 1-paste pairing links while rejecting insecure schemes", () => {
    expect(
      parseMachineInput("wss://host.example.org/_buzz-host#token=bha_abc123"),
    ).toEqual({
      url: "wss://host.example.org/_buzz-host",
      token: "bha_abc123",
    });
    expect(parseMachineInput("wss://box.example.org:8447")).toEqual({
      url: "wss://box.example.org:8447",
      token: undefined,
    });
    expect(parseMachineInput("http://box.example.org").error).toMatch(
      /wss:\/\//,
    );
    expect(parseMachineInput("   ").error).toMatch(/Enter a server URL/);
  });

  it("derives readable machine names and platform labels", () => {
    expect(deriveMachineName("wss://mac-mini.example.org/_buzz-host")).toBe(
      "Mac Mini",
    );
    expect(formatPlatformLabel("darwin")).toBe("macOS");
    expect(formatPlatformLabel("linux")).toBe("Linux");
    expect(formatPlatformLabel(undefined)).toBe("");
  });

  it("auto-migrates legacy single-URL storage into the multi-route machines list", () => {
    localStorage.setItem(LEGACY_URL_KEY, "wss://box.example.org:8447");
    localStorage.setItem(LEGACY_TOKEN_KEY, "bha_legacy");
    resetRemoteMachinesCache();

    const machines = remoteMachinesSnapshot();
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      id: "default",
      name: "Box",
      url: "wss://box.example.org:8447",
      token: "bha_legacy",
      source: "manual",
      routes: [{ type: "wss", url: "wss://box.example.org:8447" }],
    });
    expect(localStorage.getItem(REMOTE_MACHINES_KEY)).not.toBeNull();
  });

  it("supports multi-route selection preferring iroh only when available", () => {
    const machine = addRemoteMachine({
      name: "Studio Mac",
      routes: [
        { type: "iroh", nodeId: "node1234567890", endpointAddr: "addr-1" },
        { type: "wss", url: "wss://studio.example.org/_buzz-host" },
      ],
      token: "bha_token",
    });
    expect(primaryWssUrl(machine)).toBe("wss://studio.example.org/_buzz-host");
    expect(preferredRoute(machine, { irohAvailable: false })).toEqual({
      type: "wss",
      url: "wss://studio.example.org/_buzz-host",
    });
    expect(preferredRoute(machine, { irohAvailable: true })).toEqual({
      type: "iroh",
      nodeId: "node1234567890",
      endpointAddr: "addr-1",
    });
  });

  it("tracks active machine selection and keeps legacy keys mirrored for single-host compatibility", () => {
    const linux = addRemoteMachine({
      name: "Linux Box",
      url: "wss://linux.example.org:8447",
      token: "bha_linux",
    });
    const mac = addRemoteMachine({
      name: "Mac Mini",
      url: "wss://mac.example.org/_buzz-host",
      token: "bha_mac",
    });
    expect(activeMachineIdSnapshot()).toBe(linux.id);
    expect(localStorage.getItem(LEGACY_URL_KEY)).toBe(
      "wss://linux.example.org:8447",
    );

    selectActiveMachine(mac.id);
    expect(activeMachineIdSnapshot()).toBe(mac.id);
    expect(localStorage.getItem(ACTIVE_MACHINE_KEY)).toBe(mac.id);
    expect(localStorage.getItem(LEGACY_URL_KEY)).toBe(
      "wss://mac.example.org/_buzz-host",
    );
    expect(localStorage.getItem(LEGACY_TOKEN_KEY)).toBe("bha_mac");

    removeRemoteMachine(mac.id);
    expect(activeMachineIdSnapshot()).toBe(linux.id);
    expect(localStorage.getItem(LEGACY_URL_KEY)).toBe(
      "wss://linux.example.org:8447",
    );
  });

  it("merges discovered machines without overwriting manual name or token", () => {
    const manual = addRemoteMachine({
      id: "studio",
      name: "My Custom Studio",
      url: "wss://studio.example.org/_buzz-host",
      token: "bha_secret",
    });
    const updated = upsertDiscoveredMachine({
      id: manual.id,
      name: "Auto Name",
      platform: "darwin",
      capabilities: { desktop: false, docker: true },
      routes: [
        { type: "iroh", nodeId: "node999" },
        { type: "wss", url: "wss://studio.example.org/_buzz-host" },
      ],
    });
    expect(updated.name).toBe("My Custom Studio");
    expect(updated.token).toBe("bha_secret");
    expect(updated.platform).toBe("darwin");
    expect(updated.routes).toHaveLength(2);
  });

  it("maps agents to machines and cleans up mappings when a machine is removed", () => {
    const box = addRemoteMachine({
      name: "Linux Box",
      url: "wss://linux.example.org:8447",
    });
    setAgentMachine("AABB", box.id);
    expect(machineForAgent("aabb")?.id).toBe(box.id);
    expect(remoteMachineNameForAgent("aabb")).toBe("Linux Box");

    mergeAgentMachines(box.id, ["ccdd", "eeff"]);
    expect(agentHostMapSnapshot()).toEqual({ ccdd: box.id, eeff: box.id });

    removeRemoteMachine(box.id);
    expect(agentHostMapSnapshot()).toEqual({});
  });

  it("probes a buzz-host endpoint with auth + hello + list and updates machine metadata", async () => {
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "auth") ws.reply(msg.id, { role: "admin" });
      if (msg.method === "hello") {
        ws.reply(msg.id, {
          host: "mac-mini.local",
          platform: "darwin",
          role: "admin",
          capabilities: { desktop: false },
          runtimes: ["claude", "codex"],
        });
      }
      if (msg.method === "list") {
        ws.reply(msg.id, {
          agents: [{ pubkey: "112233", name: "Builder" }],
        });
      }
    };

    const machine = addRemoteMachine({
      name: "Mac Mini",
      url: "wss://mac.example.org/_buzz-host",
      token: "bha_testtoken",
    });

    const result = await refreshRemoteMachine(machine.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(result).toMatchObject({
      host: "mac-mini.local",
      platform: "darwin",
      role: "admin",
      capabilities: { desktop: false },
      runtimes: ["claude", "codex"],
    });
    expect(FakeWebSocket.instances[0]?.sent.map((m) => m.method)).toEqual([
      "auth",
      "hello",
      "list",
    ]);
    const refreshed = remoteMachinesSnapshot().find((m) => m.id === machine.id);
    expect(refreshed?.platform).toBe("darwin");
    expect(refreshed?.capabilities).toEqual({ desktop: false });
    expect(remoteMachineNameForAgent("112233")).toBe("Mac Mini");
    expect(remoteMachineStatusesSnapshot()[machine.id]).toMatchObject({
      state: "online",
      agentCount: 1,
    });
  });

  it("records offline status when probing fails", async () => {
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "auth") ws.fail(msg.id, "invalid token");
    };
    const machine = addRemoteMachine({
      name: "Broken Box",
      url: "wss://broken.example.org/_buzz-host",
      token: "bha_bad",
    });
    const result = await refreshRemoteMachine(machine.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(result).toBeUndefined();
    expect(remoteMachineStatusesSnapshot()[machine.id]).toMatchObject({
      state: "offline",
      error: "invalid token",
    });

    await expect(
      probeRemoteMachine({
        url: "wss://broken.example.org/_buzz-host",
        token: "bha_bad",
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      }),
    ).rejects.toThrow("invalid token");

    // Updating URL preserves existing non-wss routes.
    const dual = addRemoteMachine({
      name: "Dual",
      routes: [
        { type: "iroh", nodeId: "node-1" },
        { type: "wss", url: "wss://old.example.org/_buzz-host" },
      ],
    });
    const changed = updateRemoteMachine(dual.id, {
      url: "wss://new.example.org/_buzz-host",
    });
    expect(changed?.routes).toEqual([
      { type: "iroh", nodeId: "node-1" },
      { type: "wss", url: "wss://new.example.org/_buzz-host" },
    ]);
  });
});
