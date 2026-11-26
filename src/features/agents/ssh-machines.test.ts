// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => true),
  invoke:
    vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  emit: undefined as ((payload: unknown) => void) | undefined,
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauri.isTauri,
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, handler: (event: unknown) => void) => {
    tauri.emit = (payload) => handler({ payload });
    return tauri.unlisten;
  },
}));

import {
  addRemoteMachine,
  remoteMachineStatusesSnapshot,
  remoteMachinesSnapshot,
  removeRemoteMachine,
  resetRemoteMachinesCache,
} from "./remote-machines";
import { startSshTunnelSupervision } from "./ssh-machines";

const sshMachine = {
  id: "m_ssh",
  name: "Mini",
  token: "bha_token",
  routes: [
    {
      type: "ssh" as const,
      target: "mini",
      remotePort: 8467,
      localPort: 40123,
    },
  ],
};

function calls(command: string) {
  return tauri.invoke.mock.calls.filter(([cmd]) => cmd === command);
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockReset();
  tauri.unlisten.mockReset();
  tauri.emit = undefined;
  // The re-check after a connect fails fast instead of dialing out.
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        throw new Error("offline in tests");
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetRemoteMachinesCache();
});

describe("SSH tunnel supervision", () => {
  it("opens a tunnel per SSH machine, keeps its port in sync and closes it on remove", async () => {
    addRemoteMachine({
      id: "m_wss",
      name: "Studio",
      url: "wss://studio.example.org/_buzz-host",
    });
    addRemoteMachine(sshMachine);
    // The saved port was taken, so the native side picked another.
    tauri.invoke.mockImplementation(async (cmd, args) =>
      cmd === "ssh_tunnel_open"
        ? {
            machineId: args?.machineId,
            state: "connecting",
            localPort: 40999,
          }
        : undefined,
    );

    const stop = startSshTunnelSupervision();
    expect(calls("ssh_tunnel_open")).toEqual([
      [
        "ssh_tunnel_open",
        {
          machineId: "m_ssh",
          target: "mini",
          remotePort: 8467,
          localPort: 40123,
        },
      ],
    ]);
    await vi.waitFor(() =>
      expect(remoteMachinesSnapshot().find((m) => m.id === "m_ssh")?.url).toBe(
        "ws://127.0.0.1:40999",
      ),
    );
    // Storing the new port does not reopen the tunnel.
    expect(calls("ssh_tunnel_open")).toHaveLength(1);

    // Connecting re-checks the machine so its Online badge follows.
    await vi.waitFor(() => expect(tauri.emit).toBeDefined());
    tauri.emit?.({ machineId: "m_ssh", state: "connected", localPort: 40999 });
    expect(remoteMachineStatusesSnapshot().m_ssh?.state).toBe("checking");

    removeRemoteMachine("m_ssh");
    expect(calls("ssh_tunnel_close")).toEqual([
      ["ssh_tunnel_close", { machineId: "m_ssh" }],
    ]);

    stop();
    expect(calls("ssh_tunnel_close")).toHaveLength(1);
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalled());
  });

  it("closes open tunnels when supervision stops, and does nothing outside the desktop app", async () => {
    addRemoteMachine(sshMachine);
    tauri.invoke.mockResolvedValue({
      machineId: "m_ssh",
      state: "connected",
      localPort: 40123,
    });
    const stop = startSshTunnelSupervision();
    stop();
    expect(calls("ssh_tunnel_close")).toEqual([
      ["ssh_tunnel_close", { machineId: "m_ssh" }],
    ]);

    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(false);
    startSshTunnelSupervision()();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
