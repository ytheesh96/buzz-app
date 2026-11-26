// SSH machines: set up buzz-host on a computer over the system `ssh`, and keep
// one `ssh -L` forward per SSH machine open while the app runs. The native
// side (src-tauri/src/ssh_machines.rs) owns the ssh processes; this module
// asks for them to match the machine registry and mirrors their state.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import {
  refreshRemoteMachine,
  remoteMachinesSnapshot,
  type SshMachineRoute,
  sshRoute,
  subscribeRemoteMachines,
  updateRemoteMachine,
} from "./remote-machines";

export type SshTunnelState = Readonly<{
  machineId: string;
  state: "connecting" | "connected" | "reconnecting";
  localPort: number;
  error?: string;
}>;

export type SshSetupStep = "connect" | "upload" | "install" | "start";

export type SshSetupProgress =
  | Readonly<{ kind: "step"; step: SshSetupStep }>
  | Readonly<{ kind: "log"; line: string }>;

/** `buzz-host up --json`'s contract, plus what setup did. */
export type SshSetupResult = Readonly<{
  version: string;
  url: string;
  token: string;
  pubkey?: string;
  previousVersion: string | null;
  installed: boolean;
  platform: string;
  /** The remote port to forward; null when `url` is a public address. */
  tunnelPort: number | null;
}>;

/** Concrete host aliases from ~/.ssh/config, in file order. */
export async function sshConfigHosts(): Promise<readonly string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("ssh_config_hosts").catch(() => []);
}

/** Installs (with `releaseDir`) or starts buzz-host on `target`. */
export async function setupSshMachine(
  target: string,
  releaseDir: string | undefined,
  onProgress: (event: SshSetupProgress) => void,
): Promise<SshSetupResult> {
  if (!isTauri()) throw new Error("SSH machines need the Buzz desktop app.");
  const channel = new Channel<SshSetupProgress>();
  channel.onmessage = onProgress;
  return invoke<SshSetupResult>("ssh_machine_setup", {
    target,
    releaseDir: releaseDir?.trim() || null,
    onProgress: channel,
  });
}

/** Opens (or keeps) the machine's forward and waits briefly for it. */
export function openSshTunnel(
  machineId: string,
  route: Pick<SshMachineRoute, "target" | "remotePort"> &
    Partial<Pick<SshMachineRoute, "localPort">>,
): Promise<SshTunnelState> {
  return invoke<SshTunnelState>("ssh_tunnel_open", {
    machineId,
    target: route.target,
    remotePort: route.remotePort,
    localPort: route.localPort ?? null,
  });
}

function closeSshTunnel(machineId: string): void {
  void invoke("ssh_tunnel_close", { machineId }).catch(() => {});
}

const EMPTY: Readonly<Record<string, SshTunnelState>> = Object.freeze({});
let states = EMPTY;
const listeners = new Set<() => void>();

function setStates(next: Readonly<Record<string, SshTunnelState>>) {
  states = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tunnel state per SSH machine id, while supervision runs. */
export function useSshTunnelStates(): Readonly<Record<string, SshTunnelState>> {
  return useSyncExternalStore(
    subscribe,
    () => states,
    () => EMPTY,
  );
}

/**
 * Keeps one tunnel open per SSH machine in the registry until the returned
 * stop function runs: opens tunnels for added machines, closes them for
 * removed ones, re-checks a machine when its tunnel connects, and stores a
 * new local port when the saved one was taken.
 */
export function startSshTunnelSupervision(): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  // Machine id -> the target and remote port its tunnel was opened for.
  const open = new Map<string, string>();

  const apply = (state: SshTunnelState) => {
    if (stopped || !open.has(state.machineId)) return;
    const previous = states[state.machineId];
    setStates(Object.freeze({ ...states, [state.machineId]: state }));
    const machine = remoteMachinesSnapshot().find(
      (item) => item.id === state.machineId,
    );
    const route = machine && sshRoute(machine);
    if (machine && route && route.localPort !== state.localPort) {
      updateRemoteMachine(machine.id, {
        routes: machine.routes.map((item) =>
          item === route ? { ...route, localPort: state.localPort } : item,
        ),
      });
    }
    if (state.state === "connected" && previous?.state !== "connected")
      void refreshRemoteMachine(state.machineId);
  };

  const unlisten = listen<SshTunnelState>("ssh-tunnel-state", (event) =>
    apply(event.payload),
  );

  const sync = () => {
    if (stopped) return;
    const wanted = new Map<string, SshMachineRoute>();
    for (const machine of remoteMachinesSnapshot()) {
      const route = sshRoute(machine);
      if (route) wanted.set(machine.id, route);
    }
    let next: Record<string, SshTunnelState> | undefined;
    for (const id of open.keys()) {
      if (wanted.has(id)) continue;
      open.delete(id);
      closeSshTunnel(id);
      next ??= { ...states };
      delete next[id];
    }
    if (next) setStates(Object.freeze(next));
    for (const [id, route] of wanted) {
      const key = `${route.target}\0${route.remotePort}`;
      if (open.get(id) === key) continue;
      open.set(id, key);
      openSshTunnel(id, route).then(apply, (error: unknown) =>
        apply({
          machineId: id,
          state: "reconnecting",
          localPort: route.localPort,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  sync();
  const unsubscribe = subscribeRemoteMachines(sync);
  return () => {
    stopped = true;
    unsubscribe();
    void unlisten.then((stop) => stop()).catch(() => {});
    for (const id of open.keys()) closeSshTunnel(id);
    open.clear();
    setStates(EMPTY);
  };
}
