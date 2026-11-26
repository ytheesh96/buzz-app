import {
  resolveMachineWebSocketCandidates,
  type MachineWebSocketCandidate,
} from "./iroh-tunnel";
import {
  primaryWssUrl,
  type RemoteMachine,
  type RemoteMachineStatus,
} from "./remote-machines";

/**
 * buzz-host's `fs.list`/`fs.read` RPCs, over the same routes as `hello`:
 * the native Iroh tunnel when available, then the machine's `wss` route.
 */

export type RemoteFsEntryKind = "dir" | "file" | "symlink" | "other";
export type RemoteFsTargetKind = "dir" | "file" | "other";

export type RemoteFsEntry = Readonly<{
  name: string;
  path: string;
  displayPath: string;
  kind: RemoteFsEntryKind;
  targetKind: RemoteFsTargetKind | null;
  size: number;
  mtimeMs: number;
  hidden: boolean;
  isGitRepo: boolean;
}>;

export type RemoteFsListResult = Readonly<{
  path: string;
  displayPath: string;
  home: string;
  parent: string | null;
  parentDisplay: string | null;
  truncated: boolean;
  entries: readonly RemoteFsEntry[];
}>;

export type RemoteFsReadResult = Readonly<{
  path: string;
  displayPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
  encoding: "utf8" | "base64" | "binary";
  isBinary: boolean;
  isImage: boolean;
  truncated: boolean;
  content: string | null;
}>;

export type RemoteFsListParams = Readonly<{
  path?: string | undefined;
  dirsOnly?: boolean | undefined;
  showHidden?: boolean | undefined;
  limit?: number | undefined;
}>;

export type RemoteFsReadParams = Readonly<{
  path: string;
  maxBytes?: number | undefined;
}>;

export type RemoteFsRequestOptions = Readonly<{
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  WebSocketImpl?: WebSocketConstructor | undefined;
}>;

export type RemoteFsWriteParams = Readonly<{
  path: string;
  content: string;
  /** When set, the host rejects the write when the file's mtime moved. */
  expectedMtimeMs?: number | undefined;
  /** When true, the write fails if the file already exists. */
  createOnly?: boolean | undefined;
}>;

export type RemoteFsWriteResult = Readonly<{
  path: string;
  displayPath: string;
  name: string;
  size: number;
  mtimeMs: number;
}>;

export type RemoteFsMkdirParams = Readonly<{
  path: string;
  recursive?: boolean | undefined;
}>;

export type RemoteFsMkdirResult = Readonly<{
  path: string;
  displayPath: string;
  name: string;
  kind: "dir";
  mtimeMs: number;
}>;

export type RemoteFsRenameParams = Readonly<{
  from: string;
  to: string;
}>;

export type RemoteFsRenameResult = Readonly<{
  from: string;
  to: string;
  path: string;
  displayPath: string;
  name: string;
}>;

export type RemoteFsDeleteParams = Readonly<{
  path: string;
  recursive?: boolean | undefined;
}>;

export type RemoteFsDeleteResult = Readonly<{
  path: string;
  displayPath: string;
  deleted: boolean;
}>;

type WebSocketConstructor = new (url: string) => WebSocket;
type RemoteFsMethod =
  | "fs.list"
  | "fs.read"
  | "fs.write"
  | "fs.mkdir"
  | "fs.rename"
  | "fs.delete";

/** The fields the RPC needs from a configured machine. */
export type RemoteFsMachine = Pick<
  RemoteMachine,
  "id" | "url" | "routes" | "token"
>;

export type RemotePathCrumb = Readonly<{ label: string; path: string }>;

/** Breadcrumb segments for a host display path (`~/dev/app` or `/home/dev`). */
export function remotePathCrumbs(
  displayPath: string,
): readonly RemotePathCrumb[] {
  const parts = displayPath.split("/").filter(Boolean);
  if (displayPath.startsWith("~/")) {
    const result: RemotePathCrumb[] = [{ label: "~", path: "~" }];
    let next = "~";
    for (const part of parts.slice(1)) {
      next += `/${part}`;
      result.push({ label: part, path: next });
    }
    return result;
  }
  const result: RemotePathCrumb[] = [{ label: "/", path: "/" }];
  let next = "";
  for (const part of parts) {
    next += `/${part}`;
    result.push({ label: part, path: next });
  }
  return result;
}

export const REMOTE_FS_UNSUPPORTED_MESSAGE =
  "Update buzz-host on this machine to browse files.";

/** A machine that answers `hello` without the `fs` capability. */
export class RemoteFsUnsupportedError extends Error {
  constructor(message = REMOTE_FS_UNSUPPORTED_MESSAGE) {
    super(message);
    this.name = "RemoteFsUnsupportedError";
  }
}

export function isRemoteFsUnsupported(error: unknown): boolean {
  return (
    error instanceof RemoteFsUnsupportedError ||
    (error instanceof Error && error.name === "RemoteFsUnsupportedError")
  );
}

export const REMOTE_FS_CONFLICT_PREFIX = "CONFLICT:";
export const REMOTE_FS_ALREADY_EXISTS_PREFIX = "ALREADY_EXISTS:";

/** The host reported `CONFLICT:` (the file changed since the expected mtime). */
export function isRemoteFsConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(REMOTE_FS_CONFLICT_PREFIX)
  );
}

/** The host reported `ALREADY_EXISTS:` (an entry already occupies the path). */
export function isRemoteFsAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(REMOTE_FS_ALREADY_EXISTS_PREFIX)
  );
}

/** Strips the internal `CONFLICT:`/`ALREADY_EXISTS:` prefix for display. */
export function cleanRemoteFsErrorMessage(message: string): string {
  if (message.startsWith(REMOTE_FS_CONFLICT_PREFIX))
    return message.slice(REMOTE_FS_CONFLICT_PREFIX.length).trim();
  if (message.startsWith(REMOTE_FS_ALREADY_EXISTS_PREFIX))
    return message.slice(REMOTE_FS_ALREADY_EXISTS_PREFIX.length).trim();
  return message;
}

/**
 * Joins a child name onto a directory path, handling trailing slashes and the
 * `~` home alias. Pure: used by both the inline browser and the Files panel.
 */
export function joinRemotePath(dirDisplayOrAbs: string, name: string): string {
  const dir = dirDisplayOrAbs.trim().replace(/[\\/]+$/, "");
  const part = name.trim().replace(/^[\\/]+/, "");
  if (!part) return dir || "/";
  if (!dir || dir === "/") return `/${part}`;
  return `${dir}/${part}`;
}

class RemoteFsRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteFsRpcError";
  }
}

const IDLE_CLOSE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

type PendingRequest = Readonly<{
  resolve(value: unknown): void;
  reject(error: Error): void;
}>;

type Session = {
  machineId: string;
  token: string;
  route: MachineWebSocketCandidate;
  socket: WebSocket;
  pending: Map<number, PendingRequest>;
  nextId: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
};

const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function entryKind(value: unknown): RemoteFsEntryKind {
  return value === "dir" || value === "file" || value === "symlink"
    ? value
    : "other";
}

function targetKind(value: unknown): RemoteFsTargetKind | null {
  return value === "dir" || value === "file" || value === "other"
    ? value
    : null;
}

function invalid(what: string): Error {
  return new Error(`buzz-host returned an invalid ${what}.`);
}

function parseEntry(raw: unknown): RemoteFsEntry | undefined {
  const entry = record(raw);
  if (!entry) return undefined;
  const name = text(entry.name);
  const path = text(entry.path);
  if (!name || !path) return undefined;
  return Object.freeze({
    name,
    path,
    displayPath: text(entry.displayPath) ?? path,
    kind: entryKind(entry.kind),
    targetKind: targetKind(entry.targetKind),
    size: finiteNumber(entry.size) ?? 0,
    mtimeMs: finiteNumber(entry.mtimeMs) ?? 0,
    hidden: entry.hidden === true,
    isGitRepo: entry.isGitRepo === true,
  });
}

function parseListResult(raw: unknown): RemoteFsListResult {
  const result = record(raw);
  const path = text(result?.path);
  if (!result || !path) throw invalid("file listing");
  const rawEntries = result.entries;
  if (!Array.isArray(rawEntries)) throw invalid("file listing");
  const parent = text(result.parent);
  const parentDisplay = text(result.parentDisplay);
  return Object.freeze({
    path,
    displayPath: text(result.displayPath) ?? path,
    home: text(result.home) ?? "~",
    parent: parent ?? null,
    parentDisplay: parentDisplay ?? null,
    truncated: result.truncated === true,
    entries: Object.freeze(
      rawEntries
        .map(parseEntry)
        .filter((entry): entry is RemoteFsEntry => entry !== undefined),
    ),
  });
}

function parseReadResult(raw: unknown): RemoteFsReadResult {
  const result = record(raw);
  const path = text(result?.path);
  if (!result || !path) throw invalid("file read");
  const encoding =
    result.encoding === "base64" || result.encoding === "binary"
      ? result.encoding
      : "utf8";
  return Object.freeze({
    path,
    displayPath: text(result.displayPath) ?? path,
    name: text(result.name) ?? path.split("/").at(-1) ?? path,
    size: finiteNumber(result.size) ?? 0,
    mtimeMs: finiteNumber(result.mtimeMs) ?? 0,
    mimeType: text(result.mimeType) ?? "application/octet-stream",
    encoding,
    isBinary: result.isBinary === true,
    isImage: result.isImage === true,
    truncated: result.truncated === true,
    content: typeof result.content === "string" ? result.content : null,
  });
}

function parseWriteResult(raw: unknown): RemoteFsWriteResult {
  const result = record(raw);
  const path = text(result?.path);
  if (!result || !path) throw invalid("file write");
  return Object.freeze({
    path,
    displayPath: text(result.displayPath) ?? path,
    name: text(result.name) ?? path.split("/").at(-1) ?? path,
    size: finiteNumber(result.size) ?? 0,
    mtimeMs: finiteNumber(result.mtimeMs) ?? 0,
  });
}

function parseMkdirResult(raw: unknown): RemoteFsMkdirResult {
  const result = record(raw);
  const path = text(result?.path);
  if (!result || !path) throw invalid("directory creation");
  return Object.freeze({
    path,
    displayPath: text(result.displayPath) ?? path,
    name: text(result.name) ?? path.split("/").at(-1) ?? path,
    kind: "dir" as const,
    mtimeMs: finiteNumber(result.mtimeMs) ?? 0,
  });
}

function parseRenameResult(raw: unknown): RemoteFsRenameResult {
  const result = record(raw);
  const from = text(result?.from);
  const to = text(result?.to);
  const path = text(result?.path);
  if (!result || !from || !to || !path) throw invalid("rename");
  return Object.freeze({
    from,
    to,
    path,
    displayPath: text(result.displayPath) ?? path,
    name: text(result.name) ?? path.split("/").at(-1) ?? path,
  });
}

function parseDeleteResult(raw: unknown): RemoteFsDeleteResult {
  const result = record(raw);
  const path = text(result?.path);
  if (!result || !path) throw invalid("deletion");
  return Object.freeze({
    path,
    displayPath: text(result.displayPath) ?? path,
    deleted: result.deleted === true,
  });
}

function closeSession(session: Session, reason?: string): void {
  if (session.closed) return;
  session.closed = true;
  if (session.idle) clearTimeout(session.idle);
  session.idle = undefined;
  if (sessions.get(session.machineId) === session)
    sessions.delete(session.machineId);
  const error = new Error(
    reason ?? `The connection to ${session.route.url} closed.`,
  );
  for (const entry of session.pending.values()) entry.reject(error);
  session.pending.clear();
  try {
    session.socket.close();
  } catch {
    // The socket is already unusable; nothing else to release.
  }
}

function touch(session: Session): void {
  if (session.closed) return;
  if (session.idle) clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    if (session.pending.size) {
      touch(session);
      return;
    }
    closeSession(session);
  }, IDLE_CLOSE_MS);
}

function send(
  session: Session,
  method: string,
  params: Record<string, unknown>,
  options: Readonly<{
    signal?: AbortSignal | undefined;
    timeoutMs: number;
  }>,
): Promise<unknown> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (session.closed)
    return Promise.reject(
      new Error("The connection closed before the request was sent."),
    );
  if (session.idle) {
    clearTimeout(session.idle);
    session.idle = undefined;
  }
  const id = session.nextId++;
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      session.pending.delete(id);
      touch(session);
    };
    const fail = (error: Error) => {
      if (settled) return;
      finish();
      reject(error);
    };
    const succeed = (value: unknown) => {
      if (settled) return;
      finish();
      resolve(value);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for ${method}.`));
      closeSession(session);
    }, timeoutMs);
    const onAbort = () => fail(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    session.pending.set(id, { resolve: succeed, reject: fail });
    try {
      session.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      fail(asError(error));
      closeSession(session);
    }
  });
}

function openSession(
  machine: RemoteFsMachine,
  route: MachineWebSocketCandidate,
  WebSocketImpl: WebSocketConstructor,
  signal: AbortSignal | undefined,
): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(route.url);
    } catch (error) {
      reject(asError(error));
      return;
    }
    const session: Session = {
      machineId: machine.id,
      token: machine.token,
      route,
      socket,
      pending: new Map(),
      nextId: 1,
      idle: undefined,
      closed: false,
    };
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSession(session, error.message);
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(session);
    };
    const onAbort = () => fail(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      fail(new Error(`Timed out connecting to ${route.url}.`));
    }, REQUEST_TIMEOUT_MS);

    socket.onmessage = (event) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const entry = session.pending.get(message.id);
      if (!entry) return;
      if (typeof message.error === "string" && message.error)
        entry.reject(new RemoteFsRpcError(message.error));
      else entry.resolve(message.result);
    };
    socket.onclose = () => {
      const error = new Error(
        machine.token
          ? `Could not reach ${route.url}. Check that buzz-host is running and the pairing link is valid.`
          : `Could not reach ${route.url}. Check that buzz-host is running and reachable.`,
      );
      if (!settled) fail(error);
      else closeSession(session, error.message);
    };
    socket.onopen = () => {
      void (async () => {
        try {
          if (machine.token)
            await send(
              session,
              "auth",
              { token: machine.token },
              {
                signal,
                timeoutMs: REQUEST_TIMEOUT_MS,
              },
            );
          succeed();
        } catch (error) {
          fail(asError(error));
        }
      })();
    };
  });
}

async function sessionFor(
  machine: RemoteFsMachine,
  route: MachineWebSocketCandidate,
  WebSocketImpl: WebSocketConstructor,
  signal: AbortSignal | undefined,
): Promise<Session> {
  const live = sessions.get(machine.id);
  if (
    live &&
    !live.closed &&
    live.route.url === route.url &&
    live.token === machine.token
  )
    return live;
  if (live) closeSession(live);
  const pending = opening.get(machine.id);
  if (pending) return pending;
  const promise = openSession(machine, route, WebSocketImpl, signal)
    .then((session) => {
      if (session.closed) throw new Error("The connection closed.");
      sessions.set(machine.id, session);
      touch(session);
      return session;
    })
    .finally(() => {
      if (opening.get(machine.id) === promise) opening.delete(machine.id);
    });
  opening.set(machine.id, promise);
  return promise;
}

function normalizeRpcError(error: RemoteFsRpcError): Error {
  if (
    /unknown method|method not found|not permitted for guest accounts/i.test(
      error.message,
    )
  )
    return new RemoteFsUnsupportedError();
  return new Error(error.message);
}

async function callRemote<T>(
  machine: RemoteFsMachine,
  method: RemoteFsMethod,
  params: Record<string, unknown>,
  parse: (raw: unknown) => T,
  options: RemoteFsRequestOptions,
): Promise<T> {
  const {
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    WebSocketImpl = WebSocket,
  } = options;
  if (signal?.aborted) throw abortError();
  // buzz-host-iroh forwards to the token-gated listener, so skip Iroh when a
  // tokenless machine already has a WSS route (same rule as the probe).
  const hasWss = Boolean(primaryWssUrl(machine));
  const candidates = await resolveMachineWebSocketCandidates(
    machine,
    !machine.token && hasWss ? { irohAvailable: false } : undefined,
  );
  if (signal?.aborted) throw abortError();
  if (!candidates.length)
    throw new Error(
      "No reachable WebSocket route is configured for this machine yet.",
    );
  const live = sessions.get(machine.id);
  const ordered =
    live && !live.closed
      ? [live.route, ...candidates.filter(({ url }) => url !== live.route.url)]
      : candidates;
  const tried = new Set<string>();
  let lastError: Error | undefined;
  for (const route of ordered) {
    if (signal?.aborted) throw abortError();
    if (tried.has(route.url)) continue;
    tried.add(route.url);
    try {
      const session = await sessionFor(machine, route, WebSocketImpl, signal);
      if (signal?.aborted) throw abortError();
      const result = await send(session, method, params, {
        signal,
        timeoutMs,
      });
      return parse(result);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof RemoteFsRpcError) throw normalizeRpcError(error);
      lastError = asError(error);
      const session = sessions.get(machine.id);
      if (session?.route.url === route.url) closeSession(session);
    }
  }
  throw lastError ?? new Error("Could not reach the remote machine.");
}

/** Lists one directory on a machine, following the probe's route order. */
export function listRemoteDirectory(
  machine: RemoteFsMachine,
  params: RemoteFsListParams = {},
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsListResult> {
  const payload: Record<string, unknown> = {};
  if (params.path !== undefined) payload.path = params.path;
  if (params.dirsOnly !== undefined) payload.dirsOnly = params.dirsOnly;
  if (params.showHidden !== undefined) payload.showHidden = params.showHidden;
  if (params.limit !== undefined) payload.limit = params.limit;
  return callRemote(machine, "fs.list", payload, parseListResult, options);
}

/** Reads one file on a machine, read-only and bounded by the host's budget. */
export function readRemoteFile(
  machine: RemoteFsMachine,
  params: RemoteFsReadParams,
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsReadResult> {
  const payload: Record<string, unknown> = { path: params.path };
  if (params.maxBytes !== undefined) payload.maxBytes = params.maxBytes;
  return callRemote(machine, "fs.read", payload, parseReadResult, options);
}

/** Writes one file's contents. Rejects with `CONFLICT:` when the expected
 * mtime no longer matches, and with `ALREADY_EXISTS:` when `createOnly` is
 * set and the file already exists. */
export function writeRemoteFile(
  machine: RemoteFsMachine,
  params: RemoteFsWriteParams,
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsWriteResult> {
  const payload: Record<string, unknown> = {
    path: params.path,
    content: params.content,
  };
  if (params.expectedMtimeMs !== undefined)
    payload.expectedMtimeMs = params.expectedMtimeMs;
  if (params.createOnly !== undefined) payload.createOnly = params.createOnly;
  return callRemote(machine, "fs.write", payload, parseWriteResult, options);
}

/** Creates a directory. Rejects with `ALREADY_EXISTS:` when the path exists. */
export function mkdirRemoteDirectory(
  machine: RemoteFsMachine,
  params: RemoteFsMkdirParams,
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsMkdirResult> {
  const payload: Record<string, unknown> = { path: params.path };
  if (params.recursive !== undefined) payload.recursive = params.recursive;
  return callRemote(machine, "fs.mkdir", payload, parseMkdirResult, options);
}

/** Renames a file or directory to a new path. */
export function renameRemoteEntry(
  machine: RemoteFsMachine,
  params: RemoteFsRenameParams,
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsRenameResult> {
  return callRemote(
    machine,
    "fs.rename",
    { from: params.from, to: params.to },
    parseRenameResult,
    options,
  );
}

/** Deletes a file, or a directory when `recursive` is set. */
export function deleteRemoteEntry(
  machine: RemoteFsMachine,
  params: RemoteFsDeleteParams,
  options: RemoteFsRequestOptions = {},
): Promise<RemoteFsDeleteResult> {
  const payload: Record<string, unknown> = { path: params.path };
  if (params.recursive !== undefined) payload.recursive = params.recursive;
  return callRemote(machine, "fs.delete", payload, parseDeleteResult, options);
}

/**
 * Configured machines whose files this device may browse: admin machines,
 * guest machines (their sandboxed home), and manual machines not yet known.
 * Online machines come first so a picker opens on the machine that will
 * answer.
 */
export function browsableRemoteMachines(
  machines: readonly RemoteMachine[],
  statuses: Readonly<Record<string, RemoteMachineStatus>> = {},
): readonly RemoteMachine[] {
  const rank = (machine: RemoteMachine) => {
    const state = statuses[machine.id]?.state;
    return state === "online" ? 0 : state === "offline" ? 2 : 1;
  };
  return Object.freeze(
    machines
      .map((machine, index) => ({
        machine,
        index,
        rank: rank(machine),
      }))
      .filter(
        (
          entry,
        ): entry is { machine: RemoteMachine; index: number; rank: number } =>
          entry.rank !== undefined,
      )
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ machine }) => machine),
  );
}

/** Forget pooled sockets and their idle timers (for tests and disconnects). */
export function resetRemoteFsSessions(): void {
  for (const session of [...sessions.values()]) closeSession(session);
  sessions.clear();
  opening.clear();
}
