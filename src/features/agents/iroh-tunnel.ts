import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RemoteMachine } from "./remote-machines";

export type MachineRouteType = "iroh" | "ssh" | "wss";

export type MachineWebSocketCandidate = Readonly<{
  routeType: MachineRouteType;
  url: string;
}>;

type TunnelMachine = Pick<RemoteMachine, "id" | "url" | "routes">;

let available: Promise<boolean> | undefined;

/** Whether the native Iroh loopback tunnel can be used (desktop app only). */
export function irohTunnelAvailable(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  available ??= invoke<boolean>("iroh_tunnel_available").catch(() => false);
  return available;
}

/**
 * Registers the machine's Iroh endpoint with the native tunnel and returns
 * its `ws://127.0.0.1:<port>/t/…` URL, or null outside the desktop app.
 * Rejects when the endpoint is invalid or not allowed by the relay policy.
 */
export async function irohTunnelEndpoint(
  machineId: string,
  endpointAddr: string,
  path?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("iroh_tunnel_endpoint", {
    machineId,
    endpointAddr,
    path: path ?? null,
  });
}

/** Drops the machine's pooled Iroh connection, if any. */
export async function irohTunnelDisconnect(machineId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("iroh_tunnel_disconnect", { machineId }).catch(() => {});
}

function withPath(wssUrl: string, path: string | undefined): string {
  if (!path) return wssUrl;
  try {
    const base = new URL(wssUrl);
    const target = new URL(path, "ws://path.invalid");
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${target.pathname}`;
    base.search = target.search;
    return base.toString();
  } catch {
    return wssUrl;
  }
}

/**
 * WebSocket URLs to try for a machine, best first: the Iroh tunnel when it is
 * available and the machine advertises an endpoint, then its SSH forward,
 * then its `wss` route.
 */
export async function resolveMachineWebSocketCandidates(
  machine: TunnelMachine,
  options?: Readonly<{ path?: string; irohAvailable?: boolean }>,
): Promise<readonly MachineWebSocketCandidate[]> {
  const path = options?.path;
  const candidates: MachineWebSocketCandidate[] = [];
  const iroh = machine.routes.find(
    (route) => route.type === "iroh" && route.endpointAddr,
  );
  if (
    iroh?.type === "iroh" &&
    iroh.endpointAddr &&
    (options?.irohAvailable ?? (await irohTunnelAvailable()))
  ) {
    try {
      const url = await irohTunnelEndpoint(machine.id, iroh.endpointAddr, path);
      if (url) candidates.push(Object.freeze({ routeType: "iroh", url }));
    } catch {
      // An endpoint the relay policy rejects falls back to wss.
    }
  }
  // An SSH machine's forward, which the app keeps open (ssh-machines.ts).
  const ssh = machine.routes.find((route) => route.type === "ssh");
  if (ssh?.type === "ssh") {
    candidates.push(
      Object.freeze({
        routeType: "ssh",
        url: withPath(`ws://127.0.0.1:${ssh.localPort}`, path),
      }),
    );
  }
  const wss =
    machine.routes.find((route) => route.type === "wss")?.url ??
    (ssh ? "" : machine.url);
  if (wss) {
    candidates.push(
      Object.freeze({ routeType: "wss", url: withPath(wss, path) }),
    );
  }
  return Object.freeze(candidates);
}

export type IrohTunnelBridge = Readonly<{
  isAvailable(): Promise<boolean>;
  resolveUrl(machine: TunnelMachine, path?: string): Promise<string | null>;
  resolveCandidates(
    machine: TunnelMachine,
    path?: string,
  ): Promise<readonly MachineWebSocketCandidate[]>;
}>;

declare global {
  var __BUZZ_IROH_TUNNEL__: IrohTunnelBridge | undefined;
}

/** Lets bundled plugins (Remote Agents, Viewport) resolve the same routes. */
export const irohTunnelBridge: IrohTunnelBridge = Object.freeze({
  isAvailable: irohTunnelAvailable,
  resolveCandidates: (machine: TunnelMachine, path?: string) =>
    resolveMachineWebSocketCandidates(machine, path ? { path } : undefined),
  resolveUrl: async (machine: TunnelMachine, path?: string) =>
    (
      await resolveMachineWebSocketCandidates(
        machine,
        path ? { path } : undefined,
      )
    )[0]?.url ?? null,
});

globalThis.__BUZZ_IROH_TUNNEL__ = irohTunnelBridge;

/** Forget the cached availability (for tests). */
export function resetIrohTunnelCache(): void {
  available = undefined;
}
