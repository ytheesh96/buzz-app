// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMock = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke:
    vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriMock.isTauri,
  invoke: tauriMock.invoke,
}));

import { resetIrohTunnelCache } from "./iroh-tunnel";
import {
  ACTIVE_MACHINE_KEY,
  DISCOVERY_FRESHNESS_MS,
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
  mergeDiscoveredMachine,
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
  sweepStaleDiscoveredMachines,
  updateDiscoveredMachineStatus,
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
  resetIrohTunnelCache();
  tauriMock.isTauri.mockReset();
  tauriMock.isTauri.mockReturnValue(false);
  tauriMock.invoke.mockReset();
  FakeWebSocket.instances = [];
  FakeWebSocket.openImmediately = true;
  FakeWebSocket.handler = () => {};
});

afterEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  resetIrohTunnelCache();
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

  it("merges discovered machines by machineId or primary wss URL without clobbering manual fields", () => {
    const manual = addRemoteMachine({
      id: "manual-1",
      name: "Workstation",
      url: "wss://box.example.org/_buzz-host",
      token: "bha_manual_secret",
    });

    // Matched by primary wss URL (different machineId, trailing slash difference).
    const merged = mergeDiscoveredMachine({
      machineId: "host-uuid-99",
      name: "Auto Host Name",
      platform: "linux",
      host: "box.local",
      runtimes: ["claude", "codex"],
      capabilities: { desktop: true, docker: true },
      publicGuestUrl: "wss://guest.example.org/_buzz-host",
      routes: [
        { type: "iroh", nodeId: "nodeabc", endpointAddr: "eyJpZCI6ImFiIn0" },
        { type: "wss", url: "wss://box.example.org/_buzz-host/" },
      ],
      agents: [{ pubkey: "AA11", name: "Helper" }],
      lastSeen: 1_700_000_000_000,
    });

    expect(merged).toMatchObject({
      id: manual.id,
      source: "manual",
      name: "Workstation",
      token: "bha_manual_secret",
      platform: "linux",
      host: "box.local",
      runtimes: ["claude", "codex"],
      capabilities: { desktop: true, docker: true },
      publicGuestUrl: "wss://guest.example.org/_buzz-host",
      lastSeen: 1_700_000_000_000,
    });
    expect(merged?.routes).toHaveLength(2);
    expect(agentHostMapSnapshot()).toEqual({ aa11: manual.id });

    // Brand-new iroh-only discovered machine uses machineId as id and source: "discovered".
    const fresh = mergeDiscoveredMachine({
      machineId: "omarchy-2",
      name: "Omarchy",
      platform: "linux",
      routes: [{ type: "iroh", nodeId: "node777" }],
      agents: [{ pubkey: "BB22" }],
      lastSeen: 1_700_000_010_000,
    });
    expect(fresh).toMatchObject({
      id: "omarchy-2",
      source: "discovered",
      name: "Omarchy",
      url: "",
      routes: [{ type: "iroh", nodeId: "node777" }],
    });
    expect(agentHostMapSnapshot()).toEqual({
      aa11: manual.id,
      bb22: "omarchy-2",
    });

    // Subsequent update for discovered machine updates its name and routes.
    const renamed = mergeDiscoveredMachine({
      machineId: "omarchy-2",
      name: "Omarchy Studio",
      routes: [
        { type: "iroh", nodeId: "node777", endpointAddr: "addr2" },
        { type: "wss", url: "wss://omarchy.example.org/_buzz-host" },
      ],
      agents: [{ pubkey: "CC33" }],
      lastSeen: 1_700_000_020_000,
    });
    expect(renamed?.name).toBe("Omarchy Studio");
    expect(renamed?.url).toBe("wss://omarchy.example.org/_buzz-host");
    expect(agentHostMapSnapshot()).toEqual({
      aa11: manual.id,
      cc33: "omarchy-2",
    });
  });

  it("updates discovery statuses respecting 120s freshness, stopped state, and active manual probes", async () => {
    const base = 1_800_000_000_000;
    const discovered = mergeDiscoveredMachine({
      machineId: "disc-1",
      name: "Discovered Box",
      routes: [{ type: "iroh", nodeId: "node1" }],
      lastSeen: base,
    });
    expect(discovered).toBeDefined();

    // Fresh online heartbeat.
    updateDiscoveredMachineStatus("disc-1", {
      status: "online",
      observedAt: base,
      agentCount: 2,
      now: base + 60_000,
    });
    expect(remoteMachineStatusesSnapshot()["disc-1"]).toMatchObject({
      state: "online",
      agentCount: 2,
      checkedAt: base,
    });

    // Explicit stopped event immediately marks offline even when fresh.
    updateDiscoveredMachineStatus("disc-1", {
      status: "stopped",
      observedAt: base + 70_000,
      agentCount: 0,
      now: base + 70_000,
    });
    expect(remoteMachineStatusesSnapshot()["disc-1"]).toMatchObject({
      state: "offline",
      agentCount: 0,
    });

    // Stale online heartbeat (> 120s old) marks offline.
    updateDiscoveredMachineStatus("disc-1", {
      status: "online",
      observedAt: base,
      agentCount: 2,
      now: base + DISCOVERY_FRESHNESS_MS + 1,
    });
    expect(remoteMachineStatusesSnapshot()["disc-1"]?.state).toBe("offline");

    // Re-mark online and verify sweepStaleDiscoveredMachines marks it offline after 120s,
    // without clobbering a manually probed machine that has no discovery event.
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "hello") ws.reply(msg.id, { host: "manual.local" });
      if (msg.method === "list") ws.reply(msg.id, { agents: [] });
    };
    const manual = addRemoteMachine({
      id: "manual-probed",
      name: "Manual Box",
      url: "wss://manual.example.org/_buzz-host",
    });
    await refreshRemoteMachine(manual.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(remoteMachineStatusesSnapshot()[manual.id]?.state).toBe("online");

    updateDiscoveredMachineStatus("disc-1", {
      status: "online",
      observedAt: base,
      agentCount: 1,
      now: base,
    });
    expect(sweepStaleDiscoveredMachines(base + DISCOVERY_FRESHNESS_MS)).toBe(
      false,
    );
    expect(remoteMachineStatusesSnapshot()["disc-1"]?.state).toBe("online");

    expect(
      sweepStaleDiscoveredMachines(base + DISCOVERY_FRESHNESS_MS + 1),
    ).toBe(true);
    expect(remoteMachineStatusesSnapshot()["disc-1"]?.state).toBe("offline");
    expect(remoteMachineStatusesSnapshot()[manual.id]?.state).toBe("online");
  });

  it("gates loopback tunnel ws:// URLs unless allowLoopbackTunnel is enabled", async () => {
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "hello") {
        ws.reply(msg.id, {
          host: "iroh-box",
          platform: "linux",
          role: "admin",
        });
      }
      if (msg.method === "list") ws.reply(msg.id, { agents: [] });
    };

    const loopbackUrl = "ws://127.0.0.1:44444/t/deadbeef/m_1";
    await expect(
      probeRemoteMachine({
        url: loopbackUrl,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      }),
    ).rejects.toThrow(/wss:\/\//);

    const probed = await probeRemoteMachine({
      url: loopbackUrl,
      allowLoopbackTunnel: true,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(probed).toMatchObject({ host: "iroh-box", platform: "linux" });

    // Non-tunnel loopback and non-loopback ws:// URLs remain rejected even when gated on.
    await expect(
      probeRemoteMachine({
        url: "ws://127.0.0.1:44444/other",
        allowLoopbackTunnel: true,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      }),
    ).rejects.toThrow(/wss:\/\//);
    await expect(
      probeRemoteMachine({
        url: "ws://evil.example.org/t/deadbeef/m_1",
        allowLoopbackTunnel: true,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      }),
    ).rejects.toThrow(/wss:\/\//);
  });

  it("probes iroh first in desktop mode and records activeRoute: iroh", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "iroh_tunnel_available") return true;
      if (cmd === "iroh_tunnel_endpoint") {
        return `ws://127.0.0.1:51234/t/secret123/${String(args?.machineId)}`;
      }
      return undefined;
    });

    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "auth") ws.reply(msg.id, { role: "admin" });
      if (msg.method === "hello") {
        ws.reply(msg.id, {
          host: "omarchy.iroh",
          platform: "linux",
          role: "admin",
        });
      }
      if (msg.method === "list") {
        ws.reply(msg.id, { agents: [{ pubkey: "aabbcc", name: "IrohBot" }] });
      }
    };

    const machine = addRemoteMachine({
      id: "m_dual",
      name: "Omarchy Box",
      token: "bha_token",
      routes: [
        { type: "iroh", nodeId: "node-abc", endpointAddr: "eyJpZCI6ImFiYyJ9" },
        { type: "wss", url: "wss://omarchy.example.org/_buzz-host" },
      ],
    });

    const result = await refreshRemoteMachine(machine.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(result).toMatchObject({ host: "omarchy.iroh", platform: "linux" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://127.0.0.1:51234/t/secret123/m_dual",
    );
    expect(remoteMachineStatusesSnapshot()[machine.id]).toMatchObject({
      state: "online",
      agentCount: 1,
      activeRoute: "iroh",
    });

    removeRemoteMachine(machine.id);
    expect(tauriMock.invoke).toHaveBeenCalledWith("iroh_tunnel_disconnect", {
      machineId: machine.id,
    });
  });

  it("falls back automatically from iroh to wss when the iroh probe fails", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "iroh_tunnel_available") return true;
      if (cmd === "iroh_tunnel_endpoint") {
        return `ws://127.0.0.1:51235/t/secret123/${String(args?.machineId)}`;
      }
      return undefined;
    });

    FakeWebSocket.handler = (ws, msg) => {
      if (ws.url.startsWith("ws://127.0.0.1:")) {
        ws.close();
        return;
      }
      if (msg.method === "auth") ws.reply(msg.id, { role: "admin" });
      if (msg.method === "hello") {
        ws.reply(msg.id, {
          host: "fallback.example.org",
          platform: "darwin",
          role: "admin",
        });
      }
      if (msg.method === "list") ws.reply(msg.id, { agents: [] });
    };

    const machine = addRemoteMachine({
      id: "m_fallback",
      name: "Fallback Mac",
      token: "bha_token",
      routes: [
        { type: "iroh", nodeId: "node-xyz", endpointAddr: "eyJpZCI6Inh5eiJ9" },
        { type: "wss", url: "wss://fallback.example.org/_buzz-host" },
      ],
    });

    const result = await refreshRemoteMachine(machine.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(result).toMatchObject({ host: "fallback.example.org" });
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([
      "ws://127.0.0.1:51235/t/secret123/m_fallback",
      "wss://fallback.example.org/_buzz-host",
    ]);
    expect(remoteMachineStatusesSnapshot()[machine.id]).toMatchObject({
      state: "online",
      agentCount: 0,
      activeRoute: "wss",
    });
  });

  it("skips iroh in non-Tauri browser environments and marks iroh-only machines offline cleanly", async () => {
    tauriMock.isTauri.mockReturnValue(false);
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "auth") ws.reply(msg.id, { role: "admin" });
      if (msg.method === "hello") {
        ws.reply(msg.id, { host: "web.example.org", platform: "linux" });
      }
      if (msg.method === "list") ws.reply(msg.id, { agents: [] });
    };

    const dual = addRemoteMachine({
      id: "m_web_dual",
      name: "Web Dual",
      token: "bha_web",
      routes: [
        { type: "iroh", nodeId: "node-web", endpointAddr: "eyJpZCI6IndlYiJ9" },
        { type: "wss", url: "wss://web.example.org/_buzz-host" },
      ],
    });
    await refreshRemoteMachine(dual.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([
      "wss://web.example.org/_buzz-host",
    ]);
    expect(remoteMachineStatusesSnapshot()[dual.id]).toMatchObject({
      state: "online",
      activeRoute: "wss",
    });

    const irohOnly = addRemoteMachine({
      id: "m_web_iroh_only",
      name: "Iroh Only",
      source: "discovered",
      routes: [
        {
          type: "iroh",
          nodeId: "node-only-1234567890",
          endpointAddr: "eyJpZCI6Im9ubHkifQ",
        },
      ],
    });
    const res = await refreshRemoteMachine(irohOnly.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(res).toBeUndefined();
    expect(remoteMachineStatusesSnapshot()[irohOnly.id]).toMatchObject({
      state: "offline",
      error: "No reachable WebSocket route configured for this machine yet.",
    });
  });

  it("deduplicates a manual tailnet-port card with Nostr discovery via hello.machineId and publicGuestUrl without overwriting its WSS URL", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "iroh_tunnel_available") return true;
      if (cmd === "iroh_tunnel_endpoint") {
        return `ws://127.0.0.1:51236/t/secret123/${String(args?.machineId)}`;
      }
      return undefined;
    });

    const hostUuid = "536b772a-8524-487f-85ad-346ab412e5c4";
    const manual = addRemoteMachine({
      id: "default",
      name: "Workstation",
      url: "wss://box.example.org:8447",
      token: "",
    });

    // Startup race: discovery arrives before the manual card has been probed.
    const discovered = mergeDiscoveredMachine({
      machineId: hostUuid,
      name: "box",
      platform: "linux",
      host: "box",
      publicGuestUrl: "wss://box.example.org/_buzz-host",
      routes: [
        { type: "iroh", nodeId: "node-abc", endpointAddr: "eyJpZCI6ImFiYyJ9" },
        { type: "wss", url: "wss://box.example.org/_buzz-host" },
      ],
      agents: [{ pubkey: "aa11", name: "Bot" }],
      lastSeen: 1_700_000_000_000,
    });
    expect(discovered?.id).toBe(hostUuid);
    expect(remoteMachinesSnapshot()).toHaveLength(2);
    selectActiveMachine(hostUuid);

    // Probing the manual tailnet card learns hello.machineId and consolidates the discovered duplicate.
    FakeWebSocket.handler = (ws, msg) => {
      if (msg.method === "hello") {
        ws.reply(msg.id, {
          machineId: hostUuid,
          host: "box",
          platform: "linux",
          role: "admin",
          publicGuestUrl: "wss://box.example.org/_buzz-host",
        });
      }
      if (msg.method === "list") {
        ws.reply(msg.id, { agents: [{ pubkey: "aa11", name: "Bot" }] });
      }
    };

    await refreshRemoteMachine(manual.id, {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const machines = remoteMachinesSnapshot();
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      id: "default",
      machineId: hostUuid,
      name: "Workstation",
      source: "manual",
      url: "wss://box.example.org:8447",
      token: "",
      publicGuestUrl: "wss://box.example.org/_buzz-host",
    });
    // Keeps the manual :8447 WSS URL and absorbs the discovered Iroh route.
    expect(machines[0]?.routes).toEqual([
      { type: "iroh", nodeId: "node-abc", endpointAddr: "eyJpZCI6ImFiYyJ9" },
      { type: "wss", url: "wss://box.example.org:8447" },
    ]);
    expect(activeMachineIdSnapshot()).toBe("default");
    expect(agentHostMapSnapshot()).toEqual({ aa11: "default" });
    expect(remoteMachineStatusesSnapshot()[hostUuid]).toBeUndefined();
    expect(tauriMock.invoke).toHaveBeenCalledWith("iroh_tunnel_disconnect", {
      machineId: hostUuid,
    });

    // Subsequent discovery heartbeats match via machineId and never clobber :8447.
    const mergedAgain = mergeDiscoveredMachine({
      machineId: hostUuid,
      name: "box",
      publicGuestUrl: "wss://box.example.org/_buzz-host",
      routes: [
        { type: "iroh", nodeId: "node-abc", endpointAddr: "eyJpZCI6Im5ldyJ9" },
        { type: "wss", url: "wss://box.example.org/_buzz-host" },
      ],
      lastSeen: 1_700_000_050_000,
    });
    expect(mergedAgain?.id).toBe("default");
    expect(mergedAgain?.url).toBe("wss://box.example.org:8447");
    expect(mergedAgain?.routes).toEqual([
      { type: "iroh", nodeId: "node-abc", endpointAddr: "eyJpZCI6Im5ldyJ9" },
      { type: "wss", url: "wss://box.example.org:8447" },
    ]);
    expect(remoteMachinesSnapshot()).toHaveLength(1);

    // Tokenless manual card with a WSS URL skips unauthenticated Iroh probes.
    FakeWebSocket.instances = [];
    await refreshRemoteMachine("default", {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([
      "wss://box.example.org:8447",
    ]);
    expect(remoteMachineStatusesSnapshot().default).toMatchObject({
      state: "online",
      activeRoute: "wss",
    });
  });

  it("matches a manual card on publicGuestUrl and folds a pre-existing discovered duplicate preserving its token", () => {
    const hostUuid = "11111111-2222-3333-4444-555555555555";
    addRemoteMachine({
      id: "default",
      name: "My Server",
      url: "wss://server.example.org:8447",
      publicGuestUrl: "wss://server.example.org/_buzz-host",
      token: "",
      source: "manual",
    });
    // Pre-existing discovered duplicate (e.g. from an earlier version) that the user added a token to.
    addRemoteMachine({
      id: hostUuid,
      name: "server",
      url: "wss://server.example.org/_buzz-host",
      token: "bha_saved_on_discovered",
      source: "discovered",
      routes: [
        { type: "iroh", nodeId: "node-srv", endpointAddr: "eyJpZCI6InNydiJ9" },
        { type: "wss", url: "wss://server.example.org/_buzz-host" },
      ],
    });

    const merged = mergeDiscoveredMachine({
      machineId: hostUuid,
      name: "server",
      publicGuestUrl: "wss://server.example.org/_buzz-host",
      routes: [
        { type: "iroh", nodeId: "node-srv", endpointAddr: "eyJpZCI6InNydiJ9" },
        { type: "wss", url: "wss://server.example.org/_buzz-host" },
      ],
      lastSeen: 1_700_000_100_000,
    });

    expect(remoteMachinesSnapshot()).toHaveLength(1);
    expect(merged).toMatchObject({
      id: "default",
      machineId: hostUuid,
      name: "My Server",
      source: "manual",
      url: "wss://server.example.org:8447",
      token: "bha_saved_on_discovered",
    });
  });
});
