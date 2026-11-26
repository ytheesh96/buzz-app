import { useSyncExternalStore } from "react";
import {
  irohTunnelDisconnect,
  type MachineRouteType,
  resolveMachineWebSocketCandidates,
} from "./iroh-tunnel";

export const REMOTE_MACHINES_KEY = "local.buzz-host.machines.v1";
export const REMOTE_AGENT_HOSTS_KEY = "local.buzz-host.agent-hosts.v1";
export const ACTIVE_MACHINE_KEY = "local.buzz-host.active-machine.v1";
export const LEGACY_URL_KEY = "local.buzz-host.url";
export const LEGACY_TOKEN_KEY = "local.buzz-host.token";
export const REMOTE_MACHINES_CHANGED = "buzz-host:machines-changed";
export const REMOTE_AGENT_HOSTS_CHANGED = "buzz-host:agent-hosts-changed";
export const SELF_HOSTED_TYPE_KEY = "local.buzz-host/omarchy";
export const DISCOVERY_FRESHNESS_MS = 120_000;

export type RemoteMachineRoute =
  | Readonly<{ type: "wss"; url: string }>
  | Readonly<{ type: "iroh"; nodeId: string; endpointAddr?: string }>
  | SshMachineRoute;

/** A machine reached through the app's own `ssh -L` forward: `localPort` on
 * this computer to `remotePort` on the remote's loopback. */
export type SshMachineRoute = Readonly<{
  type: "ssh";
  target: string;
  remotePort: number;
  localPort: number;
}>;

export type RemoteMachineSource = "manual" | "discovered";

export type RemoteMachineCapabilities = Readonly<{
  desktop?: boolean;
  docker?: boolean;
  /** buzz-host can list and read files over `fs.list`/`fs.read`. Older hosts
   * omit it, so absence is not proof the capability is missing. */
  fs?: boolean;
  /** buzz-host can create, write, rename, and delete entries over
   * `fs.write`/`fs.mkdir`/`fs.rename`/`fs.delete`. Older hosts omit it, so
   * absence is not proof the capability is missing. */
  fsWrite?: boolean;
}>;

export type RemoteMachine = Readonly<{
  id: string;
  /** Stable host UUID reported by `hello.machineId` and Nostr discovery. */
  machineId?: string;
  name: string;
  /** Primary wss:// URL (mirrors the first `wss` route, or empty for iroh-only machines). */
  url: string;
  token: string;
  routes: readonly RemoteMachineRoute[];
  source: RemoteMachineSource;
  platform?: string;
  host?: string;
  role?: "admin" | "guest";
  runtimes?: readonly string[];
  capabilities?: RemoteMachineCapabilities;
  publicGuestUrl?: string | null;
  lastSeen?: number;
}>;

export type RemoteMachineStatus = Readonly<{
  state: "idle" | "checking" | "online" | "offline";
  error?: string;
  agentCount?: number;
  checkedAt?: number;
  /** The route the last successful check connected over. */
  activeRoute?: MachineRouteType;
}>;

export type RemoteMachineProbeResult = Readonly<{
  machineId?: string;
  platform?: string;
  host?: string;
  role?: "admin" | "guest";
  runtimes?: readonly string[];
  capabilities?: RemoteMachineCapabilities;
  publicGuestUrl?: string | null;
  agents: readonly Readonly<{ pubkey: string; name?: string }>[];
}>;

export type ParsedMachineInput = Readonly<{
  url: string;
  token: string | undefined;
  error?: string;
}>;

const EMPTY_MACHINES: readonly RemoteMachine[] = Object.freeze([]);
const EMPTY_AGENT_HOSTS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_STATUSES: Readonly<Record<string, RemoteMachineStatus>> =
  Object.freeze({});

/** Derive a friendly machine name from a wss:// host URL (e.g. omarchy.tail.ts.net -> Omarchy). */
export function deriveMachineName(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!hostname) return "Remote machine";
    if (/^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) {
      return hostname;
    }
    const first = hostname.split(".")[0] ?? hostname;
    const words = first.split(/[-_]+/).filter(Boolean);
    if (!words.length) return hostname;
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "Remote machine";
  }
}

/** Human-readable OS label from Node `process.platform`. */
export function formatPlatformLabel(platform: string | undefined): string {
  if (!platform) return "";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return platform;
}

/** `user@host` or a `~/.ssh/config` alias; never a leading `-` (an ssh option). */
export function isValidSshTarget(target: string): boolean {
  return (
    target.length > 0 &&
    target.length <= 255 &&
    !target.startsWith("-") &&
    !target.endsWith("@") &&
    (target.match(/@/g)?.length ?? 0) <= 1 &&
    /^[A-Za-z0-9._@:%[\]-]+$/.test(target)
  );
}

/** The loopback URL of an SSH machine's local forward. */
export function sshLoopbackUrl(localPort: number): string {
  return `ws://127.0.0.1:${localPort}`;
}

export function sshRoute(
  machine: Pick<RemoteMachine, "routes">,
): SshMachineRoute | undefined {
  return machine.routes.find(
    (route): route is SshMachineRoute => route.type === "ssh",
  );
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  );
}

/** First configured `wss` route URL for a machine (or legacy `machine.url`). */
export function primaryWssUrl(
  machine: Pick<RemoteMachine, "url" | "routes">,
): string {
  for (const route of machine.routes) {
    if (route.type === "wss" && route.url) return route.url;
  }
  // An SSH machine's `url` is its local forward, not an address to show or edit.
  return sshRoute(machine) ? "" : machine.url;
}

/**
 * Resolve the best connection route in priority order.
 * Prefers `iroh` when the native bridge is available; otherwise chooses `wss`.
 */
export function preferredRoute(
  machine: Pick<RemoteMachine, "routes">,
  options?: { irohAvailable?: boolean },
): RemoteMachineRoute | undefined {
  if (options?.irohAvailable) {
    const iroh = machine.routes.find((route) => route.type === "iroh");
    if (iroh) return iroh;
  }
  const wss = machine.routes.find((route) => route.type === "wss");
  if (wss) return wss;
  return machine.routes[0];
}

/**
 * Parse a Server URL or 1-paste pairing link (`wss://host/_buzz-host#token=bha_...`).
 * Enforces `wss://` because Buzz's WebView CSP only permits secure WebSockets.
 */
export function parseMachineInput(raw: string): ParsedMachineInput {
  const text = String(raw ?? "").trim();
  if (!text) return { url: "", token: undefined, error: "Enter a server URL." };
  const hashIndex = text.indexOf("#");
  let base = text;
  let token: string | undefined;
  if (hashIndex >= 0) {
    base = text.slice(0, hashIndex).trim();
    const fragment = text.slice(hashIndex + 1);
    const params = new URLSearchParams(fragment);
    const parsedToken = params.get("token")?.trim();
    if (parsedToken) token = parsedToken;
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return {
      url: base,
      token,
      error: "Enter a valid wss:// URL (or paste a pairing link).",
    };
  }
  if (parsed.protocol !== "wss:") {
    return {
      url: base,
      token,
      error: "Server URL must start with wss://.",
    };
  }
  return { url: base, token };
}

function normalizeRoute(raw: unknown): RemoteMachineRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (item.type === "wss") {
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url) return null;
    return Object.freeze({ type: "wss", url });
  }
  if (item.type === "iroh") {
    const nodeId = typeof item.nodeId === "string" ? item.nodeId.trim() : "";
    if (!nodeId) return null;
    const endpointAddr =
      typeof item.endpointAddr === "string" && item.endpointAddr.trim()
        ? item.endpointAddr.trim()
        : undefined;
    return Object.freeze({
      type: "iroh",
      nodeId,
      ...(endpointAddr ? { endpointAddr } : {}),
    });
  }
  if (item.type === "ssh") {
    const target = typeof item.target === "string" ? item.target.trim() : "";
    if (
      !isValidSshTarget(target) ||
      !isPort(item.remotePort) ||
      !isPort(item.localPort)
    )
      return null;
    return Object.freeze({
      type: "ssh",
      target,
      remotePort: item.remotePort,
      localPort: item.localPort,
    });
  }
  return null;
}

function normalizeRoutes(
  rawRoutes: unknown,
  fallbackUrl: string,
): readonly RemoteMachineRoute[] {
  const routes: RemoteMachineRoute[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawRoutes)) {
    for (const entry of rawRoutes) {
      const normalized = normalizeRoute(entry);
      if (!normalized) continue;
      const key =
        normalized.type === "wss"
          ? `wss:${normalized.url}`
          : normalized.type === "iroh"
            ? `iroh:${normalized.nodeId}`
            : "ssh";
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(normalized);
    }
  }
  // An SSH machine's `url` is its local forward, not a route of its own.
  if (
    fallbackUrl &&
    !routes.some((route) => route.type === "wss" || route.type === "ssh")
  ) {
    routes.push(Object.freeze({ type: "wss", url: fallbackUrl }));
  }
  return Object.freeze(routes);
}

function normalizeCapabilities(
  raw: unknown,
): RemoteMachineCapabilities | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const desktop = typeof item.desktop === "boolean" ? item.desktop : undefined;
  const docker = typeof item.docker === "boolean" ? item.docker : undefined;
  const fs = typeof item.fs === "boolean" ? item.fs : undefined;
  const fsWrite = typeof item.fsWrite === "boolean" ? item.fsWrite : undefined;
  if (
    desktop === undefined &&
    docker === undefined &&
    fs === undefined &&
    fsWrite === undefined
  )
    return undefined;
  return Object.freeze({
    ...(desktop !== undefined ? { desktop } : {}),
    ...(docker !== undefined ? { docker } : {}),
    ...(fs !== undefined ? { fs } : {}),
    ...(fsWrite !== undefined ? { fsWrite } : {}),
  });
}

function normalizeRuntimes(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean = [
    ...new Set(
      raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  return clean.length ? Object.freeze(clean) : undefined;
}

function normalizeMachine(raw: unknown): RemoteMachine | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
  const routes = normalizeRoutes(item.routes, rawUrl);
  if (!id || routes.length === 0) return null;
  const wssRoute = routes.find((route) => route.type === "wss");
  const ssh = routes.find((route) => route.type === "ssh");
  const url = ssh
    ? sshLoopbackUrl(ssh.localPort)
    : rawUrl || wssRoute?.url || "";
  const name =
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : url
        ? deriveMachineName(url)
        : "Remote machine";
  const token = typeof item.token === "string" ? item.token.trim() : "";
  const source: RemoteMachineSource =
    item.source === "discovered" ? "discovered" : "manual";
  const machineId =
    typeof item.machineId === "string" && item.machineId.trim()
      ? item.machineId.trim()
      : undefined;
  const platform =
    typeof item.platform === "string" && item.platform.trim()
      ? item.platform.trim()
      : undefined;
  const host =
    typeof item.host === "string" && item.host.trim()
      ? item.host.trim()
      : undefined;
  const role =
    item.role === "admin" || item.role === "guest" ? item.role : undefined;
  const runtimes = normalizeRuntimes(item.runtimes);
  const capabilities = normalizeCapabilities(item.capabilities);
  const publicGuestUrl =
    typeof item.publicGuestUrl === "string"
      ? item.publicGuestUrl
      : item.publicGuestUrl === null
        ? null
        : undefined;
  const lastSeen =
    typeof item.lastSeen === "number" && Number.isFinite(item.lastSeen)
      ? item.lastSeen
      : undefined;
  return Object.freeze({
    id,
    ...(machineId ? { machineId } : {}),
    name,
    url,
    token,
    routes,
    source,
    ...(platform ? { platform } : {}),
    ...(host ? { host } : {}),
    ...(role ? { role } : {}),
    ...(runtimes ? { runtimes } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(publicGuestUrl !== undefined ? { publicGuestUrl } : {}),
    ...(lastSeen !== undefined ? { lastSeen } : {}),
  });
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

function dispatchLocalEvent(name: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(name));
  } catch {
    // Ignore environments without CustomEvent support.
  }
}

let cachedMachinesRaw: string | null | undefined;
let cachedLegacyUrlRaw: string | null | undefined;
let cachedLegacyTokenRaw: string | null | undefined;
let cachedMachines: readonly RemoteMachine[] = EMPTY_MACHINES;

function readMachinesFromStorage(): readonly RemoteMachine[] {
  const store = storage();
  if (!store) return EMPTY_MACHINES;
  let raw: string | null = null;
  let legacyUrl: string | null = null;
  let legacyToken: string | null = null;
  try {
    raw = store.getItem(REMOTE_MACHINES_KEY);
    legacyUrl = store.getItem(LEGACY_URL_KEY);
    legacyToken = store.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return EMPTY_MACHINES;
  }
  if (
    raw === cachedMachinesRaw &&
    legacyUrl === cachedLegacyUrlRaw &&
    legacyToken === cachedLegacyTokenRaw
  ) {
    return cachedMachines;
  }

  let machines: RemoteMachine[] = [];
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        for (const entry of parsed) {
          const normalized = normalizeMachine(entry);
          if (!normalized || seen.has(normalized.id)) continue;
          seen.add(normalized.id);
          machines.push(normalized);
        }
      }
    } catch {
      machines = [];
    }
  } else if (legacyUrl?.trim()) {
    const cleanUrl = legacyUrl.trim();
    const cleanToken = legacyToken?.trim() ?? "";
    const migrated = normalizeMachine({
      id: "default",
      name: deriveMachineName(cleanUrl),
      url: cleanUrl,
      token: cleanToken,
      routes: [{ type: "wss", url: cleanUrl }],
      source: "manual",
    });
    if (migrated) {
      machines = [migrated];
      try {
        store.setItem(REMOTE_MACHINES_KEY, JSON.stringify(machines));
        raw = store.getItem(REMOTE_MACHINES_KEY);
      } catch {
        // Keep in-memory migration even when storage is read-only.
      }
    }
  }

  cachedMachinesRaw = raw;
  cachedLegacyUrlRaw = legacyUrl;
  cachedLegacyTokenRaw = legacyToken;
  cachedMachines = machines.length ? Object.freeze(machines) : EMPTY_MACHINES;
  return cachedMachines;
}

function syncLegacyKeys(
  store: Storage,
  machines: readonly RemoteMachine[],
  preferredId?: string,
) {
  const activeId =
    preferredId ??
    (() => {
      try {
        return store.getItem(ACTIVE_MACHINE_KEY)?.trim() || undefined;
      } catch {
        return undefined;
      }
    })();
  const selected =
    (activeId ? machines.find((m) => m.id === activeId) : undefined) ??
    machines[0];
  const url = selected ? primaryWssUrl(selected) : "";
  if (url) {
    store.setItem(LEGACY_URL_KEY, url);
    if (selected?.token) store.setItem(LEGACY_TOKEN_KEY, selected.token);
    else store.removeItem(LEGACY_TOKEN_KEY);
  } else {
    store.removeItem(LEGACY_URL_KEY);
    store.removeItem(LEGACY_TOKEN_KEY);
  }
  cachedLegacyUrlRaw = url || null;
  cachedLegacyTokenRaw = url && selected?.token ? selected.token : null;
}

function writeMachinesToStorage(
  machines: readonly RemoteMachine[],
  preferredId?: string,
) {
  const store = storage();
  if (!store) return;
  const serialized = JSON.stringify(machines);
  store.setItem(REMOTE_MACHINES_KEY, serialized);
  syncLegacyKeys(store, machines, preferredId);
  cachedMachinesRaw = serialized;
  cachedMachines = machines.length
    ? Object.freeze([...machines])
    : EMPTY_MACHINES;
  dispatchLocalEvent(REMOTE_MACHINES_CHANGED);
}

let cachedAgentHostsRaw: string | null | undefined;
let cachedAgentHosts: Readonly<Record<string, string>> = EMPTY_AGENT_HOSTS;

function readAgentHostsFromStorage(): Readonly<Record<string, string>> {
  const store = storage();
  if (!store) return EMPTY_AGENT_HOSTS;
  let raw: string | null = null;
  try {
    raw = store.getItem(REMOTE_AGENT_HOSTS_KEY);
  } catch {
    return EMPTY_AGENT_HOSTS;
  }
  if (raw === cachedAgentHostsRaw) return cachedAgentHosts;
  const next: Record<string, string> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [pubkey, machineId] of Object.entries(parsed)) {
          if (typeof pubkey === "string" && typeof machineId === "string") {
            const cleanPubkey = pubkey.trim().toLowerCase();
            const cleanId = machineId.trim();
            if (cleanPubkey && cleanId) next[cleanPubkey] = cleanId;
          }
        }
      }
    } catch {
      // Ignore corrupt cache; discovery will repopulate it.
    }
  }
  cachedAgentHostsRaw = raw;
  cachedAgentHosts = Object.keys(next).length
    ? Object.freeze(next)
    : EMPTY_AGENT_HOSTS;
  return cachedAgentHosts;
}

function writeAgentHostsToStorage(map: Readonly<Record<string, string>>) {
  const store = storage();
  if (!store) return;
  const serialized = JSON.stringify(map);
  try {
    store.setItem(REMOTE_AGENT_HOSTS_KEY, serialized);
  } catch {
    return;
  }
  cachedAgentHostsRaw = serialized;
  cachedAgentHosts = Object.keys(map).length
    ? Object.freeze({ ...map })
    : EMPTY_AGENT_HOSTS;
  dispatchLocalEvent(REMOTE_AGENT_HOSTS_CHANGED);
}

export function remoteMachinesSnapshot(): readonly RemoteMachine[] {
  return readMachinesFromStorage();
}

export function agentHostMapSnapshot(): Readonly<Record<string, string>> {
  return readAgentHostsFromStorage();
}

export function activeMachineIdSnapshot(): string | undefined {
  const store = storage();
  const machines = readMachinesFromStorage();
  if (!machines.length) return undefined;
  try {
    const stored = store?.getItem(ACTIVE_MACHINE_KEY)?.trim();
    if (stored && machines.some((m) => m.id === stored)) return stored;
  } catch {
    // Fall back to first configured machine.
  }
  return machines[0]?.id;
}

/**
 * Mark a machine as the active target for new-agent creation and mirror its
 * wss:// route + token into the legacy keys for single-host plugin compatibility.
 */
export function selectActiveMachine(id: string): RemoteMachine | undefined {
  const machines = readMachinesFromStorage();
  const target = machines.find((m) => m.id === id);
  if (!target) return undefined;
  const store = storage();
  if (store) {
    try {
      store.setItem(ACTIVE_MACHINE_KEY, target.id);
      syncLegacyKeys(store, machines, target.id);
    } catch {
      // Ignore storage write failures.
    }
  }
  dispatchLocalEvent(REMOTE_MACHINES_CHANGED);
  return target;
}

export function subscribeRemoteMachines(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === REMOTE_MACHINES_KEY ||
      event.key === ACTIVE_MACHINE_KEY ||
      event.key === LEGACY_URL_KEY ||
      event.key === LEGACY_TOKEN_KEY
    ) {
      cachedMachinesRaw = undefined;
      listener();
    }
  };
  const onLocal = () => {
    cachedMachinesRaw = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(REMOTE_MACHINES_CHANGED, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REMOTE_MACHINES_CHANGED, onLocal);
  };
}

export function subscribeAgentHostMap(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === REMOTE_AGENT_HOSTS_KEY) {
      cachedAgentHostsRaw = undefined;
      listener();
    }
  };
  const onLocal = () => {
    cachedAgentHostsRaw = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(REMOTE_AGENT_HOSTS_CHANGED, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REMOTE_AGENT_HOSTS_CHANGED, onLocal);
  };
}

function generateMachineId(existing: readonly RemoteMachine[]): string {
  const used = new Set(existing.map((m) => m.id));
  for (let i = 0; i < 8; i++) {
    const candidate =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `m_${crypto.randomUUID().slice(0, 8)}`
        : `m_${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `m_${Date.now().toString(36)}`;
}

export function addRemoteMachine(input: {
  id?: string;
  machineId?: string;
  name?: string;
  url?: string;
  token?: string;
  routes?: readonly RemoteMachineRoute[];
  source?: RemoteMachineSource;
  platform?: string;
  host?: string;
  role?: "admin" | "guest";
  runtimes?: readonly string[];
  capabilities?: RemoteMachineCapabilities;
  publicGuestUrl?: string | null;
  lastSeen?: number;
}): RemoteMachine {
  const existing = [...readMachinesFromStorage()];
  const cleanUrl = input.url?.trim() ?? "";
  const routes = input.routes?.length
    ? input.routes
    : cleanUrl
      ? [{ type: "wss" as const, url: cleanUrl }]
      : [];
  const machine = normalizeMachine({
    id: input.id?.trim() || generateMachineId(existing),
    machineId: input.machineId,
    name: input.name?.trim() || (cleanUrl ? deriveMachineName(cleanUrl) : ""),
    url: cleanUrl,
    token: input.token?.trim() ?? "",
    routes,
    source: input.source ?? "manual",
    platform: input.platform,
    host: input.host,
    role: input.role,
    runtimes: input.runtimes,
    capabilities: input.capabilities,
    publicGuestUrl: input.publicGuestUrl,
    lastSeen: input.lastSeen,
  });
  if (!machine) throw new Error("Invalid remote machine configuration.");
  existing.push(machine);
  writeMachinesToStorage(existing);
  return machine;
}

export function updateRemoteMachine(
  id: string,
  patch: Partial<Omit<RemoteMachine, "id">>,
): RemoteMachine | undefined {
  const existing = [...readMachinesFromStorage()];
  const index = existing.findIndex((m) => m.id === id);
  if (index < 0) return undefined;
  const current = existing[index];
  if (!current) return undefined;
  let nextRoutes = patch.routes ?? current.routes;
  if (patch.url !== undefined && patch.routes === undefined) {
    const cleanUrl = patch.url.trim();
    const nonWss = current.routes.filter((route) => route.type !== "wss");
    nextRoutes = cleanUrl
      ? [...nonWss, Object.freeze({ type: "wss" as const, url: cleanUrl })]
      : nonWss;
  }
  const updated = normalizeMachine({
    ...current,
    ...patch,
    routes: nextRoutes,
    id,
  });
  if (!updated) throw new Error("Invalid remote machine configuration.");
  existing[index] = updated;
  writeMachinesToStorage(existing);
  return updated;
}

export type DiscoveredMachineInput = Readonly<{
  machineId: string;
  name: string;
  routes: readonly RemoteMachineRoute[];
  platform?: string;
  host?: string;
  runtimes?: readonly string[];
  capabilities?: RemoteMachineCapabilities;
  publicGuestUrl?: string | null;
  agents?: readonly Readonly<{ pubkey: string; name?: string }>[];
  lastSeen?: number;
}>;

function canonicalWssUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    const path =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function knownMachineId(machine: RemoteMachine): string | undefined {
  return (
    machine.machineId ??
    (machine.source === "discovered" ? machine.id : undefined)
  );
}

function machineHasCanonicalUrl(
  machine: RemoteMachine,
  canonicalUrl: string,
): boolean {
  if (!canonicalUrl) return false;
  if (canonicalWssUrl(primaryWssUrl(machine)) === canonicalUrl) return true;
  if (
    machine.publicGuestUrl &&
    canonicalWssUrl(machine.publicGuestUrl) === canonicalUrl
  ) {
    return true;
  }
  return false;
}

function mergeManualRoutes(
  existingWss: string,
  incomingRoutes: readonly RemoteMachineRoute[],
): { url: string; routes: readonly RemoteMachineRoute[] } {
  const incomingWss =
    incomingRoutes.find((route) => route.type === "wss")?.url ?? "";
  if (!existingWss) {
    return { url: incomingWss, routes: incomingRoutes };
  }
  const incomingNonWss = incomingRoutes.filter((route) => route.type !== "wss");
  return {
    url: existingWss,
    routes: normalizeRoutes(
      [...incomingNonWss, { type: "wss" as const, url: existingWss }],
      existingWss,
    ),
  };
}

/**
 * buzz-host access tokens are guest tokens. Only move one onto a tokenless card
 * when both cards use the same WSS listener (or the card has no WSS route);
 * otherwise a tokenless admin card (e.g. tailnet Serve on `:8447`) would start
 * authenticating as a guest over Iroh.
 */
export function canAdoptToken(
  card: Pick<RemoteMachine, "url" | "routes" | "token">,
  donor: Pick<RemoteMachine, "url" | "routes" | "token">,
): boolean {
  if (card.token || !donor.token) return false;
  const cardWss = canonicalWssUrl(primaryWssUrl(card));
  return !cardWss || cardWss === canonicalWssUrl(primaryWssUrl(donor));
}

/**
 * Fold any `source: "discovered"` duplicate entries that share `machineId` into
 * the kept card (`keepId`), preserving the kept card's manual identity/URL while
 * absorbing routes, token (when missing), metadata, active selection, and agent
 * host mappings. A duplicate holding a token the kept card can't adopt (see
 * `canAdoptToken`) is promoted to a separate manual card instead of being
 * dropped, so the token is neither lost nor moved onto another listener.
 */
function consolidateDiscoveredDuplicates(
  keepId: string,
  machineId: string,
): RemoteMachine | undefined {
  const cleanMachineId = machineId.trim();
  const machines = readMachinesFromStorage();
  const keepIndex = machines.findIndex((m) => m.id === keepId);
  if (keepIndex < 0) return undefined;
  let kept = machines[keepIndex];
  if (!kept || !cleanMachineId) return kept;

  const duplicates = machines.filter(
    (m) =>
      m.id !== keepId &&
      m.source === "discovered" &&
      knownMachineId(m) === cleanMachineId,
  );
  if (duplicates.length === 0) return kept;

  const duplicateIds = new Set<string>();
  const promoted = new Map<string, RemoteMachine>();
  for (const dup of duplicates) {
    if (dup.token && dup.token !== kept.token && !canAdoptToken(kept, dup)) {
      const asManual = normalizeMachine({
        ...dup,
        machineId: cleanMachineId,
        source: "manual",
      });
      if (asManual) promoted.set(dup.id, asManual);
      continue;
    }
    duplicateIds.add(dup.id);
    const mergedRoutes =
      kept.source === "manual"
        ? mergeManualRoutes(primaryWssUrl(kept), [
            ...dup.routes.filter((r) => r.type !== "wss"),
            ...kept.routes,
          ])
        : {
            url: primaryWssUrl(kept) || primaryWssUrl(dup),
            routes: normalizeRoutes(
              [...kept.routes, ...dup.routes],
              primaryWssUrl(kept) || primaryWssUrl(dup),
            ),
          };
    const nextLastSeen =
      kept.lastSeen !== undefined && dup.lastSeen !== undefined
        ? Math.max(kept.lastSeen, dup.lastSeen)
        : (kept.lastSeen ?? dup.lastSeen);
    const merged = normalizeMachine({
      ...kept,
      machineId: cleanMachineId,
      url: mergedRoutes.url,
      routes: mergedRoutes.routes,
      token: kept.token || dup.token,
      platform: kept.platform ?? dup.platform,
      host: kept.host ?? dup.host,
      runtimes: kept.runtimes ?? dup.runtimes,
      capabilities: kept.capabilities ?? dup.capabilities,
      publicGuestUrl:
        kept.publicGuestUrl !== undefined
          ? kept.publicGuestUrl
          : dup.publicGuestUrl,
      ...(nextLastSeen !== undefined ? { lastSeen: nextLastSeen } : {}),
    });
    if (merged) kept = merged;
  }

  const nextMachines = machines
    .filter((m) => !duplicateIds.has(m.id))
    .map((m) => (m.id === keepId ? kept : (promoted.get(m.id) ?? m)));

  const store = storage();
  let preferredId: string | undefined;
  if (store) {
    try {
      const currentActive = store.getItem(ACTIVE_MACHINE_KEY)?.trim();
      if (currentActive && duplicateIds.has(currentActive)) {
        store.setItem(ACTIVE_MACHINE_KEY, keepId);
        preferredId = keepId;
      }
    } catch {
      // Ignore storage errors.
    }
  }
  writeMachinesToStorage(nextMachines, preferredId);

  const hosts = readAgentHostsFromStorage();
  let hostsChanged = false;
  const nextHosts: Record<string, string> = {};
  for (const [pubkey, hostMachineId] of Object.entries(hosts)) {
    if (duplicateIds.has(hostMachineId)) {
      nextHosts[pubkey] = keepId;
      hostsChanged = true;
    } else {
      nextHosts[pubkey] = hostMachineId;
    }
  }
  if (hostsChanged) writeAgentHostsToStorage(nextHosts);

  let statusChanged = false;
  const nextStatuses = { ...statusMap };
  for (const dupId of duplicateIds) {
    statusOriginMap.delete(dupId);
    probeCheckedAtMap.delete(dupId);
    if (dupId in nextStatuses) {
      delete nextStatuses[dupId];
      statusChanged = true;
    }
    void irohTunnelDisconnect(dupId);
  }
  if (statusChanged) {
    statusMap = Object.freeze(nextStatuses);
    emitStatuses();
  }

  return kept;
}

/**
 * Find an existing `source: "discovered"` card that corresponds to a manually
 * added machine (by `machineId`, primary WSS URL, or `publicGuestUrl`) so the
 * editor can promote it in place instead of creating a duplicate card.
 */
export function findDiscoveredMachineMatch(input: {
  machineId?: string;
  url?: string;
  publicGuestUrl?: string | null;
}): RemoteMachine | undefined {
  const machines = readMachinesFromStorage().filter(
    (m) => m.source === "discovered",
  );
  const cleanId = input.machineId?.trim() ?? "";
  if (cleanId) {
    const byId = machines.find(
      (m) => m.id === cleanId || knownMachineId(m) === cleanId,
    );
    if (byId) return byId;
  }
  const urlCanonical = canonicalWssUrl(input.url ?? "");
  if (urlCanonical) {
    const byUrl = machines.find((m) => machineHasCanonicalUrl(m, urlCanonical));
    if (byUrl) return byUrl;
  }
  const guestCanonical = canonicalWssUrl(input.publicGuestUrl ?? "");
  if (guestCanonical) {
    const byGuest = machines.find((m) =>
      machineHasCanonicalUrl(m, guestCanonical),
    );
    if (byGuest) return byGuest;
  }
  return undefined;
}

/**
 * Merge a discovered machine record (from Nostr kind:30003 presence) into the
 * registry. Matches by `machineId`, primary `wss` URL, or `publicGuestUrl`
 * (preferring manual cards over discovered duplicates), never clobbers a
 * user-configured `token`, manual `name`, or manual `wss` URL, keeps
 * `source: "manual"` on manually configured machines, creates brand-new
 * machines with `source: "discovered"` and `id: machineId`, and merges
 * advertised `agents`.
 */
export function mergeDiscoveredMachine(
  input: DiscoveredMachineInput,
): RemoteMachine | undefined {
  const machineId = input.machineId.trim();
  if (!machineId) return undefined;
  const incomingRoutes = normalizeRoutes(input.routes, "");
  const incomingWss =
    incomingRoutes.find((route) => route.type === "wss")?.url ?? "";
  const incomingCanonical = canonicalWssUrl(incomingWss);
  const incomingGuestCanonical = canonicalWssUrl(input.publicGuestUrl ?? "");
  const machines = readMachinesFromStorage();
  const matchesBySource = (source: RemoteMachineSource) => {
    const subset = machines.filter((m) => m.source === source);
    const tiers = [
      (m: RemoteMachine) =>
        m.id === machineId || knownMachineId(m) === machineId,
      (m: RemoteMachine) => machineHasCanonicalUrl(m, incomingCanonical),
      (m: RemoteMachine) => machineHasCanonicalUrl(m, incomingGuestCanonical),
    ];
    return tiers.flatMap((matches) => subset.filter(matches));
  };
  // Several manual cards can point at one host (e.g. a tokenless admin card and
  // a guest card). Heartbeats carry Iroh routes, which only work with an access
  // token, so prefer a manual card that has one.
  const manualMatches = matchesBySource("manual");
  const existing =
    manualMatches.find((m) => m.token) ??
    manualMatches[0] ??
    matchesBySource("discovered")[0];
  const lastSeen = input.lastSeen ?? Date.now();

  if (!existing) {
    if (incomingRoutes.length === 0) return undefined;
    const created = addRemoteMachine({
      id: machineId,
      machineId,
      name: input.name,
      url: incomingWss,
      routes: incomingRoutes,
      source: "discovered",
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.runtimes !== undefined ? { runtimes: input.runtimes } : {}),
      ...(input.capabilities !== undefined
        ? { capabilities: input.capabilities }
        : {}),
      ...(input.publicGuestUrl !== undefined
        ? { publicGuestUrl: input.publicGuestUrl }
        : {}),
      lastSeen,
    });
    if (input.agents !== undefined) {
      mergeAgentMachines(
        created.id,
        input.agents.map((a) => a.pubkey),
      );
    }
    return created;
  }

  let nextRoutes = existing.routes;
  let nextUrl = existing.url;
  if (incomingRoutes.length > 0) {
    if (existing.source === "manual") {
      const mergedManual = mergeManualRoutes(
        primaryWssUrl(existing),
        incomingRoutes,
      );
      nextUrl = mergedManual.url;
      nextRoutes = mergedManual.routes;
    } else {
      nextUrl = incomingWss;
      nextRoutes = incomingRoutes;
    }
  }

  let updated = updateRemoteMachine(existing.id, {
    machineId,
    ...(existing.source === "discovered" && input.name.trim()
      ? { name: input.name.trim() }
      : {}),
    url: nextUrl,
    routes: nextRoutes,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.runtimes !== undefined ? { runtimes: input.runtimes } : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : {}),
    ...(input.publicGuestUrl !== undefined
      ? { publicGuestUrl: input.publicGuestUrl }
      : {}),
    lastSeen,
  });
  if (updated) {
    updated = consolidateDiscoveredDuplicates(updated.id, machineId) ?? updated;
  }
  if (updated && input.agents !== undefined) {
    mergeAgentMachines(
      updated.id,
      input.agents.map((a) => a.pubkey),
    );
  }
  return updated;
}

/**
 * Merge a discovered machine record (e.g. from Nostr kind:30003 presence) into
 * the registry without overwriting a user's manually assigned name or token.
 */
export function upsertDiscoveredMachine(input: {
  id: string;
  name: string;
  routes: readonly RemoteMachineRoute[];
  platform?: string;
  host?: string;
  runtimes?: readonly string[];
  capabilities?: RemoteMachineCapabilities;
  publicGuestUrl?: string | null;
  agents?: readonly Readonly<{ pubkey: string; name?: string }>[];
  lastSeen?: number;
}): RemoteMachine {
  const merged = mergeDiscoveredMachine({
    machineId: input.id,
    name: input.name,
    routes: input.routes,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.runtimes !== undefined ? { runtimes: input.runtimes } : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : {}),
    ...(input.publicGuestUrl !== undefined
      ? { publicGuestUrl: input.publicGuestUrl }
      : {}),
    ...(input.agents !== undefined ? { agents: input.agents } : {}),
    ...(input.lastSeen !== undefined ? { lastSeen: input.lastSeen } : {}),
  });
  if (!merged) throw new Error("Could not update discovered machine.");
  return merged;
}

export function removeRemoteMachine(id: string): void {
  const existing = readMachinesFromStorage();
  const next = existing.filter((m) => m.id !== id);
  if (next.length === existing.length) return;
  const store = storage();
  if (store) {
    try {
      if (store.getItem(ACTIVE_MACHINE_KEY)?.trim() === id) {
        if (next[0]) store.setItem(ACTIVE_MACHINE_KEY, next[0].id);
        else store.removeItem(ACTIVE_MACHINE_KEY);
      }
    } catch {
      // Ignore storage errors.
    }
  }
  writeMachinesToStorage(next);
  const hosts = readAgentHostsFromStorage();
  const filtered: Record<string, string> = {};
  let changed = false;
  for (const [pubkey, machineId] of Object.entries(hosts)) {
    if (machineId === id) {
      changed = true;
      continue;
    }
    filtered[pubkey] = machineId;
  }
  if (changed) writeAgentHostsToStorage(filtered);
  statusOriginMap.delete(id);
  probeCheckedAtMap.delete(id);
  if (statusMap[id]) {
    const nextStatuses = { ...statusMap };
    delete nextStatuses[id];
    statusMap = Object.freeze(nextStatuses);
    emitStatuses();
  }
  void irohTunnelDisconnect(id);
}

export function setAgentMachine(pubkey: string, machineId: string): void {
  const cleanPubkey = pubkey.trim().toLowerCase();
  const cleanId = machineId.trim();
  if (!cleanPubkey || !cleanId) return;
  const current = readAgentHostsFromStorage();
  if (current[cleanPubkey] === cleanId) return;
  writeAgentHostsToStorage({ ...current, [cleanPubkey]: cleanId });
}

export function mergeAgentMachines(
  machineId: string,
  pubkeys: readonly string[],
): void {
  const cleanId = machineId.trim();
  if (!cleanId) return;
  const current = readAgentHostsFromStorage();
  const next: Record<string, string> = {};
  const owned = new Set(
    pubkeys.map((p) => p.trim().toLowerCase()).filter(Boolean),
  );
  for (const [pubkey, existingId] of Object.entries(current)) {
    if (existingId === cleanId && !owned.has(pubkey)) continue;
    next[pubkey] = existingId;
  }
  for (const pubkey of owned) next[pubkey] = cleanId;
  const prevKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (
    prevKeys.length === nextKeys.length &&
    nextKeys.every((key) => current[key] === next[key])
  ) {
    return;
  }
  writeAgentHostsToStorage(next);
}

export function machineForAgent(
  pubkey: string | undefined,
): RemoteMachine | undefined {
  if (!pubkey) return undefined;
  const clean = pubkey.trim().toLowerCase();
  const hosts = readAgentHostsFromStorage();
  const machineId = hosts[clean];
  if (!machineId) return undefined;
  return readMachinesFromStorage().find((m) => m.id === machineId);
}

export function remoteMachineNameForAgent(
  pubkey: string | undefined,
): string | undefined {
  return machineForAgent(pubkey)?.name;
}

export function useRemoteMachines(): readonly RemoteMachine[] {
  return useSyncExternalStore(
    subscribeRemoteMachines,
    remoteMachinesSnapshot,
    () => EMPTY_MACHINES,
  );
}

export function useRemoteMachineForAgent(
  pubkey: string | undefined,
): RemoteMachine | undefined {
  return useSyncExternalStore(
    (listener) => {
      const stopMachines = subscribeRemoteMachines(listener);
      const stopHosts = subscribeAgentHostMap(listener);
      return () => {
        stopMachines();
        stopHosts();
      };
    },
    () => machineForAgent(pubkey),
    () => undefined,
  );
}

export function useRemoteAgentHosts(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    subscribeAgentHostMap,
    agentHostMapSnapshot,
    () => EMPTY_AGENT_HOSTS,
  );
}

// ----- Live probe & per-machine status store -----

type StatusOrigin = "probe" | "discovery";

let statusMap: Readonly<Record<string, RemoteMachineStatus>> = EMPTY_STATUSES;
const statusOriginMap = new Map<string, StatusOrigin>();
const probeCheckedAtMap = new Map<string, number>();
const statusListeners = new Set<() => void>();

function emitStatuses() {
  for (const listener of [...statusListeners]) listener();
}

function setMachineStatus(id: string, status: RemoteMachineStatus) {
  statusMap = Object.freeze({ ...statusMap, [id]: Object.freeze(status) });
  emitStatuses();
}

/**
 * Update a machine's live status from a verified Nostr discovery heartbeat.
 * Respects the 120s freshness window and explicit `status: "stopped"`, and
 * never clobbers an in-flight or newer manual probe.
 */
export function updateDiscoveredMachineStatus(
  id: string,
  input: Readonly<{
    status: "online" | "stopped";
    observedAt: number;
    agentCount?: number;
    now?: number;
  }>,
): void {
  const machine = readMachinesFromStorage().find((m) => m.id === id);
  if (!machine) return;
  const current = statusMap[id];
  if (current?.state === "checking") return;
  const now = input.now ?? Date.now();
  const lastProbeAt = probeCheckedAtMap.get(id);
  if (lastProbeAt !== undefined && lastProbeAt > input.observedAt) return;

  const next: RemoteMachineStatus =
    input.status === "stopped"
      ? {
          state: "offline",
          error: "Host stopped.",
          ...(input.agentCount !== undefined
            ? { agentCount: input.agentCount }
            : {}),
          checkedAt: input.observedAt,
        }
      : now - input.observedAt <= DISCOVERY_FRESHNESS_MS
        ? {
            state: "online",
            ...(input.agentCount !== undefined
              ? { agentCount: input.agentCount }
              : {}),
            checkedAt: input.observedAt,
            ...(current?.state === "online" && current.activeRoute
              ? { activeRoute: current.activeRoute }
              : {}),
          }
        : {
            state: "offline",
            error: "Host heartbeat timed out.",
            ...(input.agentCount !== undefined
              ? { agentCount: input.agentCount }
              : {}),
            checkedAt: input.observedAt,
          };

  statusOriginMap.set(id, "discovery");
  if (
    current &&
    current.state === next.state &&
    current.error === next.error &&
    current.agentCount === next.agentCount &&
    current.checkedAt === next.checkedAt &&
    current.activeRoute === next.activeRoute
  ) {
    return;
  }
  setMachineStatus(id, next);
}

/**
 * Mark stale discovered machines offline once `lastSeen` exceeds the 120s
 * freshness window, without clobbering active or manual probes when no
 * discovery event exists.
 */
export function sweepStaleDiscoveredMachines(now = Date.now()): boolean {
  const machines = readMachinesFromStorage();
  let changed = false;
  let nextStatuses: Record<string, RemoteMachineStatus> | undefined;
  for (const machine of machines) {
    const origin = statusOriginMap.get(machine.id);
    if (machine.source !== "discovered" && origin !== "discovery") continue;
    const current = statusMap[machine.id];
    if (current?.state === "checking") continue;
    const lastProbeAt = probeCheckedAtMap.get(machine.id);
    if (
      origin === "probe" &&
      lastProbeAt !== undefined &&
      now - lastProbeAt <= DISCOVERY_FRESHNESS_MS
    ) {
      continue;
    }
    const lastSeen = machine.lastSeen ?? current?.checkedAt;
    if (lastSeen !== undefined && now - lastSeen <= DISCOVERY_FRESHNESS_MS) {
      continue;
    }
    if (current?.state === "offline") continue;
    if (!nextStatuses) nextStatuses = { ...statusMap };
    nextStatuses[machine.id] = Object.freeze({
      state: "offline",
      error: "Host heartbeat timed out.",
      ...(current?.agentCount !== undefined
        ? { agentCount: current.agentCount }
        : {}),
      checkedAt: lastSeen ?? now,
    });
    statusOriginMap.set(machine.id, "discovery");
    changed = true;
  }
  if (changed && nextStatuses) {
    statusMap = Object.freeze(nextStatuses);
    emitStatuses();
  }
  return changed;
}

export function remoteMachineStatusesSnapshot(): Readonly<
  Record<string, RemoteMachineStatus>
> {
  return statusMap;
}

export function subscribeRemoteMachineStatuses(
  listener: () => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function useRemoteMachineStatuses(): Readonly<
  Record<string, RemoteMachineStatus>
> {
  return useSyncExternalStore(
    subscribeRemoteMachineStatuses,
    remoteMachineStatusesSnapshot,
    () => EMPTY_STATUSES,
  );
}

type WebSocketConstructor = new (url: string) => WebSocket;

/** The native tunnel's `ws://127.0.0.1:<port>/t/…` URLs (never user input). */
/** The app's own loopback forwards: the Iroh tunnel (`/t/…`) and an SSH
 * machine's forward (the listener's root). */
const LOOPBACK_TUNNEL_URL = /^ws:\/\/127\.0\.0\.1:\d{1,5}(?:\/t\/|\/?$)/;

/**
 * Connect to a buzz-host endpoint, authenticate if a token is supplied, call
 * `hello` and `list`, and close the probe socket cleanly.
 */
export async function probeRemoteMachine({
  url,
  token = "",
  signal,
  timeoutMs = 15000,
  WebSocketImpl = WebSocket,
  allowLoopbackTunnel = false,
}: {
  url: string;
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  WebSocketImpl?: WebSocketConstructor;
  /** Also accept the app's loopback forwards (Iroh tunnel, SSH). */
  allowLoopbackTunnel?: boolean;
}): Promise<RemoteMachineProbeResult> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const tunnelled = allowLoopbackTunnel && LOOPBACK_TUNNEL_URL.test(url);
  const parsed = tunnelled ? { url, token: undefined } : parseMachineInput(url);
  if ("error" in parsed && parsed.error) throw new Error(parsed.error);
  const cleanUrl = parsed.url;
  const cleanToken = (parsed.token ?? token).trim();

  return new Promise<RemoteMachineProbeResult>((resolve, reject) => {
    let ws: WebSocket;
    let settled = false;
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(reason: Error): void }
    >();

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws?.close();
      } catch {
        // Ignore close errors during teardown.
      }
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      cleanup();
      reject(err);
    };

    const succeed = (result: RemoteMachineProbeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => fail(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      fail(new Error(`Timed out connecting to ${cleanUrl}.`));
    }, timeoutMs);

    try {
      ws = new WebSocketImpl(cleanUrl);
    } catch (error) {
      fail(error);
      return;
    }

    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const id = nextId++;
        pending.set(id, {
          resolve: (value) =>
            res(
              value && typeof value === "object"
                ? (value as Record<string, unknown>)
                : {},
            ),
          reject: rej,
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          rej(error instanceof Error ? error : new Error(String(error)));
        }
      });

    ws.onmessage = (event) => {
      let msg: { id?: number; result?: unknown; error?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    };

    ws.onopen = () => {
      void (async () => {
        try {
          if (cleanToken) {
            await rpc("auth", { token: cleanToken });
          }
          const [hello, list] = await Promise.all([rpc("hello"), rpc("list")]);
          const rawAgents = Array.isArray(list.agents) ? list.agents : [];
          const agents = rawAgents
            .filter((a): a is { pubkey: string; name?: string } =>
              Boolean(
                a &&
                  typeof a === "object" &&
                  typeof (a as { pubkey?: unknown }).pubkey === "string",
              ),
            )
            .map((a) =>
              Object.freeze({
                pubkey: a.pubkey.toLowerCase(),
                ...(typeof a.name === "string" ? { name: a.name } : {}),
              }),
            );
          const machineId =
            typeof hello.machineId === "string" && hello.machineId.trim()
              ? hello.machineId.trim()
              : undefined;
          const platform =
            typeof hello.platform === "string" ? hello.platform : undefined;
          const capabilities =
            normalizeCapabilities(hello.capabilities) ??
            (platform
              ? Object.freeze({ desktop: platform === "linux" })
              : undefined);
          const runtimes = normalizeRuntimes(hello.runtimes);
          const role =
            hello.role === "admin" || hello.role === "guest"
              ? hello.role
              : undefined;
          succeed(
            Object.freeze({
              ...(machineId ? { machineId } : {}),
              ...(platform ? { platform } : {}),
              ...(typeof hello.host === "string" ? { host: hello.host } : {}),
              ...(role ? { role } : {}),
              ...(runtimes ? { runtimes } : {}),
              ...(capabilities ? { capabilities } : {}),
              ...(typeof hello.publicGuestUrl === "string" ||
              hello.publicGuestUrl === null
                ? { publicGuestUrl: hello.publicGuestUrl }
                : {}),
              agents: Object.freeze(agents),
            }),
          );
        } catch (error) {
          fail(error);
        }
      })();
    };

    ws.onclose = () => {
      if (!settled) {
        fail(
          new Error(
            cleanToken
              ? `Could not reach ${cleanUrl}. Check that buzz-host is running and the pairing link is valid.`
              : `Could not reach ${cleanUrl}. Check that buzz-host is running and reachable.`,
          ),
        );
      }
    };
  });
}

export async function refreshRemoteMachine(
  id: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    WebSocketImpl?: WebSocketConstructor;
  },
): Promise<RemoteMachineProbeResult | undefined> {
  const machine = readMachinesFromStorage().find((m) => m.id === id);
  if (!machine) return undefined;
  statusOriginMap.set(id, "probe");
  setMachineStatus(id, {
    ...statusMap[id],
    state: "checking",
  });
  // buzz-host-iroh forwards to the token-gated listener, so skip Iroh when a
  // tokenless machine (e.g. tailnet-only Serve) already has a WSS route.
  const hasWss = Boolean(primaryWssUrl(machine));
  const candidates = await resolveMachineWebSocketCandidates(
    machine,
    !machine.token && hasWss ? { irohAvailable: false } : undefined,
  );
  if (options?.signal?.aborted) return undefined;
  if (!candidates.length) {
    const now = Date.now();
    statusOriginMap.set(id, "probe");
    probeCheckedAtMap.set(id, now);
    setMachineStatus(id, {
      state: "offline",
      error: "No reachable WebSocket route configured for this machine yet.",
      checkedAt: now,
    });
    return undefined;
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const result = await probeRemoteMachine({
        url: candidate.url,
        token: machine.token,
        allowLoopbackTunnel: candidate.routeType !== "wss",
        ...options,
      });
      recordProbe(id, result, candidate.routeType);
      return result;
    } catch (error) {
      if (options?.signal?.aborted) return undefined;
      lastError = error;
    }
  }
  if (!readMachinesFromStorage().some((m) => m.id === id)) return undefined;
  const now = Date.now();
  statusOriginMap.set(id, "probe");
  probeCheckedAtMap.set(id, now);
  setMachineStatus(id, {
    state: "offline",
    error: lastError instanceof Error ? lastError.message : String(lastError),
    checkedAt: now,
  });
  return undefined;
}

function recordProbe(
  id: string,
  result: RemoteMachineProbeResult,
  activeRoute: MachineRouteType,
) {
  const now = Date.now();
  const updated = updateRemoteMachine(id, {
    ...(result.machineId ? { machineId: result.machineId } : {}),
    ...(result.platform ? { platform: result.platform } : {}),
    ...(result.host ? { host: result.host } : {}),
    ...(result.role ? { role: result.role } : {}),
    ...(result.runtimes ? { runtimes: result.runtimes } : {}),
    ...(result.capabilities ? { capabilities: result.capabilities } : {}),
    ...(result.publicGuestUrl !== undefined
      ? { publicGuestUrl: result.publicGuestUrl }
      : {}),
    lastSeen: now,
  });
  if (!updated) return;
  if (result.machineId) {
    consolidateDiscoveredDuplicates(id, result.machineId);
  }
  mergeAgentMachines(
    id,
    result.agents.map((a) => a.pubkey),
  );
  statusOriginMap.set(id, "probe");
  probeCheckedAtMap.set(id, now);
  setMachineStatus(id, {
    state: "online",
    agentCount: result.agents.length,
    checkedAt: now,
    activeRoute,
  });
}

export async function refreshAllRemoteMachines(options?: {
  signal?: AbortSignal;
  timeoutMs?: number;
  WebSocketImpl?: WebSocketConstructor;
}): Promise<void> {
  const machines = readMachinesFromStorage();
  await Promise.all(
    machines.map((machine) => refreshRemoteMachine(machine.id, options)),
  );
}

/** Reset in-memory caches (for tests). */
export function resetRemoteMachinesCache(): void {
  cachedMachinesRaw = undefined;
  cachedLegacyUrlRaw = undefined;
  cachedLegacyTokenRaw = undefined;
  cachedMachines = EMPTY_MACHINES;
  cachedAgentHostsRaw = undefined;
  cachedAgentHosts = EMPTY_AGENT_HOSTS;
  statusOriginMap.clear();
  probeCheckedAtMap.clear();
  statusMap = EMPTY_STATUSES;
  emitStatuses();
}
