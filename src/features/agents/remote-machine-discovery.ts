import { invoke, isTauri as defaultIsTauri } from "@tauri-apps/api/core";
import { communityDestination } from "../communities/destination";
import type { CommunityReader } from "../communities/service";
import type { ReadFilter } from "../relay/events";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  DISCOVERY_FRESHNESS_MS,
  mergeDiscoveredMachine,
  remoteMachinesSnapshot,
  remoteMachineStatusesSnapshot,
  sweepStaleDiscoveredMachines,
  updateDiscoveredMachineStatus,
  type RemoteMachineCapabilities,
  type RemoteMachineRoute,
} from "./remote-machines";

export const DISCOVERY_STATUS_KIND = 30003;
export const DISCOVERY_STATUS_TOPIC = "buzz-host-status";
export const DISCOVERY_REFRESH_INTERVAL_MS = 45_000;
const MAX_CANDIDATE_EVENTS = 64;

export type WireStatusEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
}>;

export type VerifiedRemoteMachineStatus = Readonly<{
  eventId: string;
  pubkey: string;
  createdAt: number;
  payload: Readonly<{
    v: number;
    status: "online" | "stopped";
    machineId: string;
    name: string;
    host?: string;
    platform?: string;
    runtimes: readonly string[];
    capabilities?: RemoteMachineCapabilities;
    routes: readonly RemoteMachineRoute[];
    agents: readonly Readonly<{ pubkey: string; name?: string }>[];
    publicGuestUrl?: string | null;
    updatedAt: number;
  }>;
}>;

export type RemoteMachineDiscoveryOptions = Readonly<{
  relay?: RelayData;
  communityReader?: CommunityReader;
  refreshIntervalMs?: number;
  isTauri?: () => boolean;
  decryptStatuses?: (
    events: readonly WireStatusEvent[],
  ) => Promise<readonly VerifiedRemoteMachineStatus[]>;
  now?: () => number;
}>;

export type RemoteMachineDiscoveryController = Readonly<{
  refresh: () => Promise<void>;
  stop: () => void;
}>;

type StatusVersion = Readonly<{
  createdAt: number;
  updatedAt: number;
  eventId: string;
}>;

function toEpochMs(ts: number): number {
  return ts >= 1e12 ? ts : ts * 1000;
}

function observedAtMs(status: VerifiedRemoteMachineStatus): number {
  const raw =
    status.payload.updatedAt > 0 ? status.payload.updatedAt : status.createdAt;
  return toEpochMs(raw);
}

/** True when `candidate` supersedes `current` by created_at, then updatedAt, then NIP-01 id tie-break. */
export function isNewerMachineStatus(
  current: StatusVersion | undefined,
  candidate: StatusVersion,
): boolean {
  if (!current) return true;
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt;
  }
  return candidate.eventId < current.eventId;
}

/** Collapse a batch of verified statuses to the latest event per `machineId`. */
export function selectLatestMachineStatuses(
  statuses: readonly VerifiedRemoteMachineStatus[],
): Map<string, VerifiedRemoteMachineStatus> {
  const latest = new Map<string, VerifiedRemoteMachineStatus>();
  for (const status of statuses) {
    const machineId = status.payload.machineId;
    const existing = latest.get(machineId);
    if (
      !existing ||
      isNewerMachineStatus(
        {
          createdAt: existing.createdAt,
          updatedAt: existing.payload.updatedAt,
          eventId: existing.eventId,
        },
        {
          createdAt: status.createdAt,
          updatedAt: status.payload.updatedAt,
          eventId: status.eventId,
        },
      )
    ) {
      latest.set(machineId, status);
    }
  }
  return latest;
}

function toWireEvent(event: unknown): WireStatusEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const raw = event as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.pubkey !== "string" ||
    typeof raw.created_at !== "number" ||
    typeof raw.kind !== "number" ||
    typeof raw.content !== "string" ||
    typeof raw.sig !== "string" ||
    !Array.isArray(raw.tags)
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    tags: raw.tags as readonly (readonly string[])[],
    content: raw.content,
    sig: raw.sig,
  };
}

function collectReadySessions(
  relay: RelayData | undefined,
  communityReader: CommunityReader | undefined,
): { viewer: string | undefined; sessions: RelaySession[] } {
  const account = communityReader?.snapshot();
  const active = relay?.snapshot();
  const viewer = account?.viewer ?? active?.viewer;
  if (!viewer) return { viewer: undefined, sessions: [] };

  const seen = new Set<RelaySession>();
  const sessions: RelaySession[] = [];
  const add = (session: RelaySession | undefined) => {
    if (!session || seen.has(session)) return;
    seen.add(session);
    sessions.push(session);
  };

  if (
    active?.status === "ready" &&
    !active.cached &&
    active.viewer === viewer
  ) {
    add(active.session);
  }

  if (communityReader && account?.viewer === viewer) {
    for (const membership of account.memberships) {
      let communityOrigin: string;
      try {
        communityOrigin = communityDestination(membership.id).url;
      } catch {
        continue;
      }
      const retained = communityReader.retained({ viewer, communityOrigin });
      if (
        retained?.status === "ready" &&
        !retained.cached &&
        retained.viewer === viewer
      ) {
        add(retained.session);
      }
    }
  }

  return { viewer, sessions };
}

function defaultDecryptStatuses(
  events: readonly WireStatusEvent[],
): Promise<readonly VerifiedRemoteMachineStatus[]> {
  return invoke<VerifiedRemoteMachineStatus[]>(
    "remote_machine_decrypt_statuses",
    { events },
  );
}

/**
 * Create a Nostr NIP-44 remote-machine discovery loop.
 * Reads kind 30003 `buzz-host-status` events from all connected/retained
 * communities, decrypts and verifies them through the native Tauri host,
 * merges discovered machines into the registry, and sweeps stale discovered
 * machines offline after 120s.
 */
export function createRemoteMachineDiscovery(
  options: RemoteMachineDiscoveryOptions,
): RemoteMachineDiscoveryController {
  const isTauri = options.isTauri ?? defaultIsTauri;
  if (!isTauri()) {
    return {
      refresh: () => Promise.resolve(),
      stop: () => {},
    };
  }

  const refreshIntervalMs =
    options.refreshIntervalMs ?? DISCOVERY_REFRESH_INTERVAL_MS;
  const decryptStatuses = options.decryptStatuses ?? defaultDecryptStatuses;
  const now = options.now ?? (() => Date.now());

  let disposed = false;
  let activeViewer: string | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightAbort: AbortController | undefined;
  let pendingRefresh = false;
  let scheduledMicrotask = false;
  let stalenessTimer: ReturnType<typeof setTimeout> | undefined;
  const appliedByMachine = new Map<string, StatusVersion>();

  const scheduleStalenessSweep = () => {
    if (stalenessTimer !== undefined) {
      clearTimeout(stalenessTimer);
      stalenessTimer = undefined;
    }
    if (disposed) return;

    const currentNow = now();
    const statuses = remoteMachineStatusesSnapshot();
    let earliestDelay: number | undefined;

    for (const machine of remoteMachinesSnapshot()) {
      if (machine.source !== "discovered") continue;
      const status = statuses[machine.id];
      if (status?.state === "offline" || status?.state === "checking") continue;
      const lastSeen = machine.lastSeen ?? status?.checkedAt;
      if (lastSeen === undefined) continue;
      const delay = lastSeen + DISCOVERY_FRESHNESS_MS + 1 - currentNow;
      if (earliestDelay === undefined || delay < earliestDelay) {
        earliestDelay = delay;
      }
    }

    if (earliestDelay === undefined) return;
    stalenessTimer = setTimeout(
      () => {
        stalenessTimer = undefined;
        if (disposed) return;
        sweepStaleDiscoveredMachines(now());
        scheduleStalenessSweep();
      },
      Math.max(1, earliestDelay),
    );
  };

  const applyVerified = (verified: readonly VerifiedRemoteMachineStatus[]) => {
    const latestByMachine = selectLatestMachineStatuses(verified);
    const currentNow = now();

    for (const [machineId, status] of latestByMachine) {
      const version: StatusVersion = {
        createdAt: status.createdAt,
        updatedAt: status.payload.updatedAt,
        eventId: status.eventId,
      };
      const previous = appliedByMachine.get(machineId);
      const isSameEvent = previous?.eventId === version.eventId;
      if (
        previous &&
        !isSameEvent &&
        !isNewerMachineStatus(previous, version)
      ) {
        continue;
      }
      appliedByMachine.set(machineId, version);
      const observedAt = observedAtMs(status);
      const merged = mergeDiscoveredMachine({
        machineId,
        name: status.payload.name,
        routes: status.payload.routes,
        ...(status.payload.platform !== undefined
          ? { platform: status.payload.platform }
          : {}),
        ...(status.payload.host !== undefined
          ? { host: status.payload.host }
          : {}),
        runtimes: status.payload.runtimes,
        ...(status.payload.capabilities !== undefined
          ? { capabilities: status.payload.capabilities }
          : {}),
        ...(status.payload.publicGuestUrl !== undefined
          ? { publicGuestUrl: status.payload.publicGuestUrl }
          : {}),
        agents: status.payload.agents,
        lastSeen: observedAt,
      });
      if (merged) {
        updateDiscoveredMachineStatus(merged.id, {
          status: status.payload.status,
          observedAt,
          agentCount: status.payload.agents.length,
          now: currentNow,
        });
      }
    }
  };

  const runOnce = async () => {
    if (disposed) return;
    const { viewer, sessions } = collectReadySessions(
      options.relay,
      options.communityReader,
    );
    if (viewer !== activeViewer) {
      activeViewer = viewer;
      appliedByMachine.clear();
    }
    if (!viewer || sessions.length === 0) {
      sweepStaleDiscoveredMachines(now());
      scheduleStalenessSweep();
      return;
    }

    const filter: ReadFilter = {
      kinds: [DISCOVERY_STATUS_KIND],
      "#k": [DISCOVERY_STATUS_TOPIC],
      "#p": [viewer],
      limit: MAX_CANDIDATE_EVENTS,
    };

    const controller = new AbortController();
    inFlightAbort = controller;
    try {
      const results = await Promise.allSettled(
        sessions.map((session) =>
          session.read([filter], { signal: controller.signal }),
        ),
      );
      if (disposed || controller.signal.aborted) return;

      const byId = new Map<string, WireStatusEvent>();
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const event of result.value) {
          const wire = toWireEvent(event);
          if (wire && !byId.has(wire.id)) byId.set(wire.id, wire);
        }
      }

      if (byId.size > 0) {
        const candidates = [...byId.values()]
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, MAX_CANDIDATE_EVENTS);
        try {
          const verified = await decryptStatuses(candidates);
          if (
            !disposed &&
            !controller.signal.aborted &&
            viewer === activeViewer
          ) {
            applyVerified(verified);
          }
        } catch {
          // Native decrypt/verification errors are non-fatal; retry next cycle.
        }
      }
    } finally {
      if (inFlightAbort === controller) inFlightAbort = undefined;
      if (!disposed) {
        sweepStaleDiscoveredMachines(now());
        scheduleStalenessSweep();
      }
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      pendingRefresh = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await runOnce();
      } finally {
        inFlight = undefined;
      }
      if (pendingRefresh && !disposed) {
        pendingRefresh = false;
        await refresh();
      }
    })();
    return inFlight;
  };

  const scheduleRefresh = () => {
    if (disposed || scheduledMicrotask) return;
    scheduledMicrotask = true;
    void Promise.resolve().then(() => {
      scheduledMicrotask = false;
      if (!disposed) void refresh();
    });
  };

  const unsubRelay = options.relay?.subscribe(scheduleRefresh);
  const unsubCommunities = options.communityReader?.subscribe(scheduleRefresh);
  const refreshTimer = setInterval(() => {
    if (!disposed) void refresh();
  }, refreshIntervalMs);

  void refresh();

  return {
    refresh,
    stop() {
      if (disposed) return;
      disposed = true;
      pendingRefresh = false;
      clearInterval(refreshTimer);
      if (stalenessTimer !== undefined) {
        clearTimeout(stalenessTimer);
        stalenessTimer = undefined;
      }
      inFlightAbort?.abort();
      inFlightAbort = undefined;
      unsubRelay?.();
      unsubCommunities?.();
    },
  };
}

/** Start remote-machine Nostr discovery and return a disposer that stops it. */
export function startRemoteMachineDiscovery(
  options: RemoteMachineDiscoveryOptions,
): () => void {
  return createRemoteMachineDiscovery(options).stop;
}
