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

import {
  irohTunnelAvailable,
  irohTunnelBridge,
  irohTunnelDisconnect,
  irohTunnelEndpoint,
  resetIrohTunnelCache,
  resolveMachineWebSocketCandidates,
} from "./iroh-tunnel";

const dualMachine = {
  id: "m_studio",
  url: "wss://studio.example.org/_buzz-host",
  routes: [
    {
      type: "iroh" as const,
      nodeId: "node1234567890abcdef",
      endpointAddr: "eyJpZCI6ImFiYyJ9",
    },
    { type: "wss" as const, url: "wss://studio.example.org/_buzz-host" },
  ],
};

const irohOnlyMachine = {
  id: "m_iroh_only",
  url: "",
  routes: [
    {
      type: "iroh" as const,
      nodeId: "nodeabcdef1234567890",
      endpointAddr: "eyJpZCI6Imlyb2gifQ",
    },
  ],
};

beforeEach(() => {
  tauriMock.isTauri.mockReset();
  tauriMock.isTauri.mockReturnValue(false);
  tauriMock.invoke.mockReset();
  resetIrohTunnelCache();
});

afterEach(() => {
  resetIrohTunnelCache();
});

describe("iroh-tunnel", () => {
  it("registers the global bridge for plugins", () => {
    expect(globalThis.__BUZZ_IROH_TUNNEL__).toBe(irohTunnelBridge);
    expect(typeof globalThis.__BUZZ_IROH_TUNNEL__?.isAvailable).toBe(
      "function",
    );
    expect(typeof globalThis.__BUZZ_IROH_TUNNEL__?.resolveUrl).toBe("function");
    expect(typeof globalThis.__BUZZ_IROH_TUNNEL__?.resolveCandidates).toBe(
      "function",
    );
  });

  it("falls back cleanly outside Tauri (browser mode)", async () => {
    tauriMock.isTauri.mockReturnValue(false);

    expect(await irohTunnelAvailable()).toBe(false);
    expect(await irohTunnelEndpoint("m_1", "addr", "/desktop")).toBeNull();
    await irohTunnelDisconnect("m_1");
    expect(tauriMock.invoke).not.toHaveBeenCalled();

    expect(await resolveMachineWebSocketCandidates(dualMachine)).toEqual([
      { routeType: "wss", url: "wss://studio.example.org/_buzz-host" },
    ]);
    expect(
      await resolveMachineWebSocketCandidates(dualMachine, {
        path: "/desktop?ticket=abc",
      }),
    ).toEqual([
      {
        routeType: "wss",
        url: "wss://studio.example.org/_buzz-host/desktop?ticket=abc",
      },
    ]);
    expect(await resolveMachineWebSocketCandidates(irohOnlyMachine)).toEqual(
      [],
    );
    expect(await irohTunnelBridge.resolveUrl(irohOnlyMachine)).toBeNull();
  });

  it("caches native availability and clears cache on reset", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockResolvedValue(true);

    expect(await irohTunnelAvailable()).toBe(true);
    expect(await irohTunnelAvailable()).toBe(true);
    expect(tauriMock.invoke).toHaveBeenCalledTimes(1);
    expect(tauriMock.invoke).toHaveBeenCalledWith("iroh_tunnel_available");

    resetIrohTunnelCache();
    tauriMock.invoke.mockRejectedValueOnce(new Error("policy invalid"));
    expect(await irohTunnelAvailable()).toBe(false);
    expect(tauriMock.invoke).toHaveBeenCalledTimes(2);
  });

  it("resolves iroh first and appends wss fallback in desktop mode", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "iroh_tunnel_available") return true;
      if (cmd === "iroh_tunnel_endpoint") {
        const path = (args?.path as string | null) ?? "";
        return `ws://127.0.0.1:41234/t/secret/${String(args?.machineId)}${path}`;
      }
      return undefined;
    });

    const candidates = await resolveMachineWebSocketCandidates(dualMachine, {
      path: "/desktop?ticket=xyz",
    });
    expect(candidates).toEqual([
      {
        routeType: "iroh",
        url: "ws://127.0.0.1:41234/t/secret/m_studio/desktop?ticket=xyz",
      },
      {
        routeType: "wss",
        url: "wss://studio.example.org/_buzz-host/desktop?ticket=xyz",
      },
    ]);
    expect(tauriMock.invoke).toHaveBeenCalledWith("iroh_tunnel_endpoint", {
      machineId: "m_studio",
      endpointAddr: "eyJpZCI6ImFiYyJ9",
      path: "/desktop?ticket=xyz",
    });

    expect(
      await globalThis.__BUZZ_IROH_TUNNEL__?.resolveUrl(
        irohOnlyMachine,
        "/desktop",
      ),
    ).toBe("ws://127.0.0.1:41234/t/secret/m_iroh_only/desktop");

    expect(
      await globalThis.__BUZZ_IROH_TUNNEL__?.resolveCandidates(dualMachine),
    ).toEqual([
      {
        routeType: "iroh",
        url: "ws://127.0.0.1:41234/t/secret/m_studio",
      },
      {
        routeType: "wss",
        url: "wss://studio.example.org/_buzz-host",
      },
    ]);
  });

  it("falls back to wss when iroh_tunnel_endpoint rejects (e.g. relay policy) or lacks endpointAddr", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockImplementation(async (cmd) => {
      if (cmd === "iroh_tunnel_available") return true;
      if (cmd === "iroh_tunnel_endpoint") {
        throw new Error("unapproved relay URL");
      }
      return undefined;
    });

    expect(await resolveMachineWebSocketCandidates(dualMachine)).toEqual([
      { routeType: "wss", url: "wss://studio.example.org/_buzz-host" },
    ]);

    const nodeIdOnly = {
      id: "m_node",
      url: "wss://node.example.org/_buzz-host",
      routes: [
        { type: "iroh" as const, nodeId: "node-without-endpoint-addr" },
        { type: "wss" as const, url: "wss://node.example.org/_buzz-host" },
      ],
    };
    tauriMock.invoke.mockClear();
    expect(await resolveMachineWebSocketCandidates(nodeIdOnly)).toEqual([
      { routeType: "wss", url: "wss://node.example.org/_buzz-host" },
    ]);
    expect(tauriMock.invoke).not.toHaveBeenCalledWith(
      "iroh_tunnel_endpoint",
      expect.anything(),
    );
  });

  it("respects explicit irohAvailable: false override and handles disconnect errors gracefully", async () => {
    tauriMock.isTauri.mockReturnValue(true);
    tauriMock.invoke.mockRejectedValue(new Error("disconnect failed"));

    const candidates = await resolveMachineWebSocketCandidates(dualMachine, {
      irohAvailable: false,
    });
    expect(candidates).toEqual([
      { routeType: "wss", url: "wss://studio.example.org/_buzz-host" },
    ]);
    expect(tauriMock.invoke).not.toHaveBeenCalled();

    await expect(irohTunnelDisconnect("m_studio")).resolves.toBeUndefined();
    expect(tauriMock.invoke).toHaveBeenCalledWith("iroh_tunnel_disconnect", {
      machineId: "m_studio",
    });
  });
});
