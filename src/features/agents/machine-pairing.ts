// `buzz://pair?url=<url>[&name=<name>]#token=<token>`: a buzz-host pairing
// link (`buzz-host pair` prints one). Opening it only prefills Add machine in
// Settings → Agent setup → Self-hosted; the user still confirms with Connect
// and save. The token stays in the fragment and never enters a navigation
// target, browser history or a log: it waits here, in memory, for the form.
import { parseMachineInput, SELF_HOSTED_TYPE_KEY } from "./remote-machines";

export type MachinePairing = Readonly<{
  /** Distinguishes two openings of the same link. */
  id: number;
  url: string;
  token: string;
  name?: string;
}>;

/** buzz-host access tokens: `bha_` (admin) or `bhg_` (guest). */
const TOKEN = /^bh[ag]_[A-Za-z0-9_-]{8,256}$/;
const MAX_NAME = 100;

let nextId = 0;

/** The pairing a link names, or null for anything else (other links included).
 * The URL follows the same rules as the Add machine form. */
export function parseMachinePairingLink(raw: string): MachinePairing | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  if (!/^buzz:\/\/pair\/?\?/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.hostname !== "pair" ||
    !["", "/"].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.port ||
    ["url", "name"].some((key) => url.searchParams.getAll(key).length > 1)
  )
    return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const tokens = fragment.getAll("token");
  const token = tokens[0] ?? "";
  if (tokens.length !== 1 || !TOKEN.test(token)) return null;
  const target = url.searchParams.get("url") ?? "";
  // A pairing URL carries its token in our fragment, never in its own.
  if (!target || target.includes("#")) return null;
  const parsed = parseMachineInput(target);
  if (parsed.error) return null;
  const name = (url.searchParams.get("name") ?? "").trim();
  if (
    name.length > MAX_NAME ||
    [...name].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return null;
  return Object.freeze({
    id: ++nextId,
    url: parsed.url,
    token,
    ...(name ? { name } : {}),
  });
}

/** Settings → Agent setup with the Self-hosted provider's dialog open. */
export const SELF_HOSTED_SETTINGS_TARGET = Object.freeze({
  version: 1,
  kind: "settings",
  section: "agents",
  provider: SELF_HOSTED_TYPE_KEY,
} as const);

let pending: MachinePairing | undefined;
const listeners = new Set<() => void>();

/** Hold `pairing` for the Self-hosted dialog; a newer one replaces it. */
export function offerMachinePairing(pairing: MachinePairing): void {
  pending = pairing;
  for (const listener of [...listeners]) listener();
}

/** The held pairing, without consuming it (safe in render). */
export function peekMachinePairing(): MachinePairing | undefined {
  return pending;
}

/** Consume the held pairing once the form shows it. */
export function takeMachinePairing(id: number): void {
  if (pending?.id === id) pending = undefined;
}

export function subscribeMachinePairing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
