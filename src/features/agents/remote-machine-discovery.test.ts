// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityReader } from "../communities/service";
import type { RelayData, RelaySnapshot } from "../relay/service";
import {
  DISCOVERY_FRESHNESS_MS,
  addRemoteMachine,
  agentHostMapSnapshot,
  refreshRemoteMachine,
  remoteMachineStatusesSnapshot,
  remoteMachinesSnapshot,
  resetRemoteMachinesCache,
} from "./remote-machines";
import {
  DISCOVERY_REFRESH_INTERVAL_MS,
  DISCOVERY_STATUS_KIND,
  DISCOVERY_STATUS_TOPIC,
  type VerifiedRemoteMachineStatus,
  type WireStatusEvent,
  createRemoteMachineDiscovery,
  selectLatestMachineStatuses,
  startRemoteMachineDiscovery,
} from "./remote-machine-discovery";

const VIEWER = "a".repeat(64);
const MACHINE_KEY = "b".repeat(64);

function makeWireEvent(
  overrides: Partial<WireStatusEvent> = {},
): WireStatusEvent {
  return {
    id: overrides.id ?? "1".repeat(64),
    pubkey: overrides.pubkey ?? MACHINE_KEY,
    created_at: overrides.created_at ?? 1_800_000_000,
    kind: overrides.kind ?? DISCOVERY_STATUS_KIND,
    tags: overrides.tags ?? [
      ["d", "buzz-host:m-1"],
      ["k", DISCOVERY_STATUS_TOPIC],
      ["p", VIEWER],
    ],
    content: overrides.content ?? "ciphertext",
    sig: overrides.sig ?? "2".repeat(128),
  };
}

function makeVerified(
  overrides: Omit<Partial<VerifiedRemoteMachineStatus>, "payload"> & {
    payload?: Partial<VerifiedRemoteMachineStatus["payload"]>;
  } = {},
): VerifiedRemoteMachineStatus {
  const createdAt = overrides.createdAt ?? 1_800_000_000;
  return {
    eventId: overrides.eventId ?? "1".repeat(64),
    pubkey: overrides.pubkey ?? MACHINE_KEY,
    createdAt,
    payload: {
      v: 1,
      status: "online",
      machineId: "m-1",
      name: "Omarchy",
      host: "omarchy.local",
      platform: "linux",
      runtimes: ["claude", "codex"],
      capabilities: { desktop: true, docker: false },
      routes: [
        { type: "iroh", nodeId: "node123", endpointAddr: "eyJpZCI6ImFiIn0" },
        { type: "wss", url: "wss://omarchy.example.org/_buzz-host" },
      ],
      agents: [{ pubkey: "c".repeat(64), name: "Builder" }],
      publicGuestUrl: null,
      updatedAt: createdAt,
      ...overrides.payload,
    },
  };
}

function createFakeRelay(initial: Partial<RelaySnapshot>) {
  const listeners = new Set<() => void>();
  let current = initial as RelaySnapshot;
  const relay: RelayData = {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: () => Promise.resolve(),
  };
  return {
    relay,
    setSnapshot(next: Partial<RelaySnapshot>) {
      current = next as RelaySnapshot;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function createFakeCommunityReader(options: {
  viewer?: string;
  memberships?: Array<{ id: string; name: string }>;
  retainedMap?: Record<string, Partial<RelaySnapshot>>;
}) {
  const listeners = new Set<() => void>();
  let viewer = options.viewer;
  let memberships = options.memberships ?? [];
  const retainedMap = new Map(Object.entries(options.retainedMap ?? {}));

  const reader: CommunityReader = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      ...(viewer !== undefined ? { viewer } : {}),
      profile: { name: "Viewer", picture: "" },
      memberships,
      selected: memberships[0]?.id ?? null,
      sync: { outbox: [], settledAt: 0 } as never,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retained({ viewer: v, communityOrigin }) {
      if (v !== viewer) return undefined;
      return retainedMap.get(communityOrigin) as RelaySnapshot | undefined;
    },
  };

  return {
    reader,
    emit() {
      for (const listener of [...listeners]) listener();
    },
    setState(next: {
      viewer?: string;
      memberships?: Array<{ id: string; name: string }>;
      retained?: Record<string, Partial<RelaySnapshot>>;
    }) {
      if ("viewer" in next) viewer = next.viewer;
      if (next.memberships) memberships = next.memberships;
      if (next.retained) {
        retainedMap.clear();
        for (const [k, v] of Object.entries(next.retained)) {
          retainedMap.set(k, v);
        }
      }
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  resetRemoteMachinesCache();
});

describe("remote-machine-discovery", () => {
  it("no-ops gracefully outside Tauri without subscribing or reading relays", async () => {
    const read = vi.fn();
    const { relay, listenerCount } = createFakeRelay({
      status: "ready",
      viewer: VIEWER,
      session: { read } as never,
    });
    const decryptStatuses = vi.fn();

    const controller = createRemoteMachineDiscovery({
      relay,
      isTauri: () => false,
      decryptStatuses,
    });
    await controller.refresh();

    expect(read).not.toHaveBeenCalled();
    expect(decryptStatuses).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    controller.stop();
  });

  it("reads kind 30003 status events across active and retained communities and applies the latest per machineId", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldEvent = makeWireEvent({
      id: "1".repeat(64),
      created_at: nowSec - 30,
    });
    const newEvent = makeWireEvent({
      id: "2".repeat(64),
      created_at: nowSec - 5,
    });

    const activeRead = vi.fn().mockResolvedValue([oldEvent]);
    const retainedRead = vi.fn().mockResolvedValue([oldEvent, newEvent]);

    const { relay } = createFakeRelay({
      status: "ready",
      viewer: VIEWER,
      origin: "https://relay-a.example.org",
      session: { read: activeRead } as never,
    });
    const { reader } = createFakeCommunityReader({
      viewer: VIEWER,
      memberships: [
        { id: "https://relay-a.example.org", name: "Relay A" },
        { id: "https://relay-b.example.org", name: "Relay B" },
      ],
      retainedMap: {
        "https://relay-b.example.org": {
          status: "ready",
          viewer: VIEWER,
          origin: "https://relay-b.example.org",
          session: { read: retainedRead } as never,
        },
      },
    });

    const decryptStatuses = vi.fn().mockResolvedValue([
      makeVerified({
        eventId: oldEvent.id,
        createdAt: nowSec - 30,
        payload: {
          name: "Old Name",
          updatedAt: nowSec - 30,
          agents: [{ pubkey: "d".repeat(64) }],
        },
      }),
      makeVerified({
        eventId: newEvent.id,
        createdAt: nowSec - 5,
        payload: {
          name: "Fresh Name",
          updatedAt: nowSec - 5,
          agents: [{ pubkey: "e".repeat(64) }],
        },
      }),
    ]);

    const stop = startRemoteMachineDiscovery({
      relay,
      communityReader: reader,
      isTauri: () => true,
      decryptStatuses,
    });
    await flushMicrotasks();

    const expectedFilter = [
      {
        kinds: [DISCOVERY_STATUS_KIND],
        "#k": [DISCOVERY_STATUS_TOPIC],
        "#p": [VIEWER],
        limit: 64,
      },
    ];
    expect(activeRead).toHaveBeenCalledWith(
      expectedFilter,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(retainedRead).toHaveBeenCalledWith(
      expectedFilter,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Deduplicated by event id before passing to native decrypt.
    expect(decryptStatuses).toHaveBeenCalledWith([newEvent, oldEvent]);

    expect(remoteMachinesSnapshot()).toHaveLength(1);
    expect(remoteMachinesSnapshot()[0]).toMatchObject({
      id: "m-1",
      name: "Fresh Name",
      source: "discovered",
      platform: "linux",
      host: "omarchy.local",
      runtimes: ["claude", "codex"],
      capabilities: { desktop: true, docker: false },
    });
    expect(agentHostMapSnapshot()).toEqual({ ["e".repeat(64)]: "m-1" });
    expect(remoteMachineStatusesSnapshot()["m-1"]).toMatchObject({
      state: "online",
      agentCount: 1,
    });
    stop();
  });

  it("breaks created_at ties by updatedAt and keeps newer events from being overwritten by older ones", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const selected = selectLatestMachineStatuses([
      makeVerified({
        eventId: "a".repeat(64),
        createdAt: nowSec,
        payload: { name: "Earlier Update", updatedAt: nowSec - 2 },
      }),
      makeVerified({
        eventId: "b".repeat(64),
        createdAt: nowSec,
        payload: { name: "Later Update", updatedAt: nowSec },
      }),
    ]);
    expect(selected.get("m-1")?.payload.name).toBe("Later Update");

    const evNew = makeWireEvent({ id: "2".repeat(64), created_at: nowSec });
    const evOld = makeWireEvent({
      id: "1".repeat(64),
      created_at: nowSec - 20,
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce([evNew])
      .mockResolvedValueOnce([evOld]);

    const decryptStatuses = vi
      .fn()
      .mockResolvedValueOnce([
        makeVerified({
          eventId: evNew.id,
          createdAt: nowSec,
          payload: { name: "Newest", updatedAt: nowSec },
        }),
      ])
      .mockResolvedValueOnce([
        makeVerified({
          eventId: evOld.id,
          createdAt: nowSec - 20,
          payload: { name: "Stale Replay", updatedAt: nowSec - 20 },
        }),
      ]);

    const { relay } = createFakeRelay({
      status: "ready",
      viewer: VIEWER,
      session: { read } as never,
    });

    const controller = createRemoteMachineDiscovery({
      relay,
      isTauri: () => true,
      decryptStatuses,
    });
    await flushMicrotasks();
    expect(remoteMachinesSnapshot()[0]?.name).toBe("Newest");

    await controller.refresh();
    expect(remoteMachinesSnapshot()[0]?.name).toBe("Newest");
    controller.stop();
  });

  it("refreshes every 45s, responds to relay/community changes, and sweeps stale discovered machines offline at 120s without clobbering manual probes", async () => {
    const startMs = Date.now();
    const startSec = Math.floor(startMs / 1000);
    const ev = makeWireEvent({ id: "3".repeat(64), created_at: startSec });
    const read = vi.fn().mockResolvedValue([ev]);
    const decryptStatuses = vi.fn().mockResolvedValue([
      makeVerified({
        eventId: ev.id,
        createdAt: startSec,
        payload: { status: "online", updatedAt: startSec },
      }),
    ]);

    // Add a manually probed machine with no discovery event.
    class OkWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        void Promise.resolve().then(() => this.onopen?.());
      }
      send(raw: string) {
        const msg = JSON.parse(raw) as { id: number; method: string };
        if (msg.method === "auth") {
          this.onmessage?.({
            data: JSON.stringify({ id: msg.id, result: { role: "admin" } }),
          });
        }
        if (msg.method === "hello") {
          this.onmessage?.({
            data: JSON.stringify({ id: msg.id, result: { host: "man.local" } }),
          });
        }
        if (msg.method === "list") {
          this.onmessage?.({
            data: JSON.stringify({ id: msg.id, result: { agents: [] } }),
          });
        }
      }
      close() {}
    }
    const manual = addRemoteMachine({
      id: "manual-1",
      name: "Manual Only",
      url: "wss://manual.example.org/_buzz-host",
      token: "bha_keep",
    });
    await refreshRemoteMachine(manual.id, {
      WebSocketImpl: OkWebSocket as unknown as typeof WebSocket,
    });
    expect(remoteMachineStatusesSnapshot()[manual.id]?.state).toBe("online");

    const {
      relay,
      setSnapshot,
      listenerCount: relayListeners,
    } = createFakeRelay({
      status: "connecting",
      viewer: VIEWER,
      session: { read } as never,
    });
    const {
      reader,
      emit,
      listenerCount: communityListeners,
    } = createFakeCommunityReader({ viewer: VIEWER });

    const stop = startRemoteMachineDiscovery({
      relay,
      communityReader: reader,
      isTauri: () => true,
      decryptStatuses,
    });
    await flushMicrotasks();
    expect(read).not.toHaveBeenCalled();

    // Relay becomes ready -> triggers refresh.
    setSnapshot({
      status: "ready",
      viewer: VIEWER,
      session: { read } as never,
    });
    await flushMicrotasks();
    expect(read).toHaveBeenCalledTimes(1);
    expect(remoteMachineStatusesSnapshot()["m-1"]?.state).toBe("online");

    // Community change triggers another refresh.
    emit();
    await flushMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);

    // 45s periodic refresh fires.
    await vi.advanceTimersByTimeAsync(DISCOVERY_REFRESH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(remoteMachineStatusesSnapshot()["m-1"]?.state).toBe("online");

    // Advance past 120s freshness window (relay returns same old heartbeat).
    await vi.advanceTimersByTimeAsync(
      DISCOVERY_FRESHNESS_MS - DISCOVERY_REFRESH_INTERVAL_MS + 10,
    );
    expect(remoteMachineStatusesSnapshot()["m-1"]?.state).toBe("offline");
    // Manual probed machine with no discovery event stays online!
    expect(remoteMachineStatusesSnapshot()[manual.id]?.state).toBe("online");

    // Stop unsubscribes and stops periodic refreshes.
    const callsBeforeStop = read.mock.calls.length;
    stop();
    expect(relayListeners()).toBe(0);
    expect(communityListeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(DISCOVERY_REFRESH_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it("marks discovered machines offline immediately on status: stopped", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const evOnline = makeWireEvent({ id: "4".repeat(64), created_at: nowSec });
    const evStopped = makeWireEvent({
      id: "5".repeat(64),
      created_at: nowSec + 1,
    });

    const read = vi
      .fn()
      .mockResolvedValueOnce([evOnline])
      .mockResolvedValueOnce([evStopped]);
    const decryptStatuses = vi
      .fn()
      .mockResolvedValueOnce([
        makeVerified({
          eventId: evOnline.id,
          createdAt: nowSec,
          payload: { status: "online", updatedAt: nowSec },
        }),
      ])
      .mockResolvedValueOnce([
        makeVerified({
          eventId: evStopped.id,
          createdAt: nowSec + 1,
          payload: { status: "stopped", updatedAt: nowSec + 1, agents: [] },
        }),
      ]);

    const { relay } = createFakeRelay({
      status: "ready",
      viewer: VIEWER,
      session: { read } as never,
    });

    const controller = createRemoteMachineDiscovery({
      relay,
      isTauri: () => true,
      decryptStatuses,
    });
    await flushMicrotasks();
    expect(remoteMachineStatusesSnapshot()["m-1"]?.state).toBe("online");

    await controller.refresh();
    expect(remoteMachineStatusesSnapshot()["m-1"]).toMatchObject({
      state: "offline",
      agentCount: 0,
    });
    controller.stop();
  });
});
