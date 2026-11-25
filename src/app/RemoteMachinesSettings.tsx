import {
  type ClipboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { resolveMachineWebSocketCandidates } from "../features/agents/iroh-tunnel";
import {
  ProviderDialogActions,
  ProviderDialogFooter,
} from "../features/agents/ProviderDialogActions";
import {
  addRemoteMachine,
  deriveMachineName,
  findDiscoveredMachineMatch,
  formatPlatformLabel,
  parseMachineInput,
  primaryWssUrl,
  probeRemoteMachine,
  type RemoteMachine,
  type RemoteMachineStatus,
  refreshRemoteMachine,
  removeRemoteMachine,
  updateRemoteMachine,
  useRemoteMachineStatuses,
  useRemoteMachines,
} from "../features/agents/remote-machines";
import {
  ArrowsClockwiseIcon,
  CloudIcon,
  CloudOffIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "../shared/design-system/icons";
import { Badge } from "../shared/design-system/ui/Badge";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { Field } from "../shared/design-system/ui/Field";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Input } from "../shared/design-system/ui/Input";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";

function hasIrohRoute(machine: RemoteMachine | undefined): boolean {
  return Boolean(machine?.routes.some((route) => route.type === "iroh"));
}

function hostLabel(machine: RemoteMachine): string {
  if (machine.host) return machine.host;
  const wssUrl = primaryWssUrl(machine);
  if (wssUrl) {
    try {
      return new URL(wssUrl).host;
    } catch {
      return wssUrl;
    }
  }
  const iroh = machine.routes.find((route) => route.type === "iroh");
  if (!iroh) return "";
  return iroh.nodeId.length > 12 ? `${iroh.nodeId.slice(0, 12)}…` : iroh.nodeId;
}

function routeBadgesFor(
  machine: RemoteMachine,
  status: RemoteMachineStatus | undefined,
): readonly ("Iroh" | "WSS")[] {
  if (status?.state === "online" && status.activeRoute) {
    return [status.activeRoute === "iroh" ? "Iroh" : "WSS"];
  }
  const badges: ("Iroh" | "WSS")[] = [];
  if (hasIrohRoute(machine)) badges.push("Iroh");
  if (primaryWssUrl(machine)) badges.push("WSS");
  return badges;
}

/** The add/edit machine fields and actions. Actions render into the
 * surrounding dialog's footer through ProviderDialogActions. */
export function MachineEditorForm({
  machine,
  urlInputRef,
  onCancel,
  onSaved,
  onPendingChange,
}: {
  machine?: RemoteMachine | undefined;
  urlInputRef: RefObject<HTMLInputElement | null>;
  onCancel(): void;
  onSaved(machine: RemoteMachine): void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const editing = Boolean(machine);
  const irohOnlyCapable = hasIrohRoute(machine);
  const [rawUrl, setRawUrl] = useState(machine ? primaryWssUrl(machine) : "");
  const [name, setName] = useState(machine?.name ?? "");
  const [token, setToken] = useState(machine?.token ?? "");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState("");
  const [probeFailed, setProbeFailed] = useState(false);
  const [pending, setPendingState] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const formId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);

  const setPending = (next: boolean) => {
    setPendingState(next);
    onPendingChange?.(next);
  };

  const clearErrors = () => {
    setUrlError(undefined);
    setSubmitError("");
    setProbeFailed(false);
  };

  /** Moves a pairing link's #token= into the masked token field. */
  const splitPairingLink = (value: string) => {
    const parsed = parseMachineInput(value);
    if (parsed.error || !parsed.token) return false;
    setRawUrl(parsed.url);
    setToken(parsed.token);
    clearErrors();
    return true;
  };

  const handleUrlPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (splitPairingLink(event.clipboardData.getData("text")))
      event.preventDefault();
  };

  const parsedPreview = parseMachineInput(rawUrl);
  const derivedName =
    !parsedPreview.error && parsedPreview.url
      ? deriveMachineName(parsedPreview.url)
      : (machine?.name ?? "");

  const persist = (
    cleanUrl: string,
    cleanToken: string,
    probe?: Awaited<ReturnType<typeof probeRemoteMachine>>,
  ) => {
    const cleanName =
      name.trim() ||
      (cleanUrl ? deriveMachineName(cleanUrl) : machine?.name) ||
      "Remote machine";
    const fields = {
      name: cleanName,
      url: cleanUrl,
      token: cleanToken,
      ...(probe?.machineId ? { machineId: probe.machineId } : {}),
      ...(probe?.platform ? { platform: probe.platform } : {}),
      ...(probe?.host ? { host: probe.host } : {}),
      ...(probe?.role ? { role: probe.role } : {}),
      ...(probe?.runtimes ? { runtimes: probe.runtimes } : {}),
      ...(probe?.capabilities ? { capabilities: probe.capabilities } : {}),
      ...(probe?.publicGuestUrl !== undefined
        ? { publicGuestUrl: probe.publicGuestUrl }
        : {}),
      ...(probe ? { lastSeen: Date.now() } : {}),
    };
    const existingDiscovered = !machine
      ? findDiscoveredMachineMatch({
          ...(probe?.machineId ? { machineId: probe.machineId } : {}),
          url: cleanUrl,
          ...(probe?.publicGuestUrl !== undefined
            ? { publicGuestUrl: probe.publicGuestUrl }
            : {}),
        })
      : undefined;
    const saved = machine
      ? updateRemoteMachine(machine.id, fields)
      : existingDiscovered
        ? updateRemoteMachine(existingDiscovered.id, {
            ...fields,
            token: cleanToken || existingDiscovered.token,
            source: "manual",
          })
        : addRemoteMachine(fields);
    setPending(false);
    if (!saved) {
      onCancel();
      return;
    }
    void refreshRemoteMachine(saved.id);
    onSaved(saved);
  };

  const save = async ({ skipCheck = false }: { skipCheck?: boolean } = {}) => {
    if (pending) return;
    const trimmedUrl = rawUrl.trim();
    let cleanUrl = "";
    let cleanToken = token.trim();
    if (trimmedUrl || !irohOnlyCapable) {
      const parsed = parseMachineInput(rawUrl);
      if (parsed.error) {
        setUrlError(parsed.error);
        urlInputRef.current?.focus();
        return;
      }
      cleanUrl = parsed.url;
      cleanToken = (parsed.token ?? token).trim();
    }
    if (skipCheck) {
      persist(cleanUrl, cleanToken);
      return;
    }
    setPending(true);
    setSubmitError("");
    setProbeFailed(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let probe: Awaited<ReturnType<typeof probeRemoteMachine>>;
      if (cleanUrl) {
        probe = await probeRemoteMachine({
          url: cleanUrl,
          token: cleanToken,
          signal: controller.signal,
        });
      } else if (machine) {
        const candidates = await resolveMachineWebSocketCandidates({
          id: machine.id,
          url: "",
          routes: machine.routes,
        });
        if (controller.signal.aborted) return;
        const candidate = candidates[0];
        if (!candidate) {
          throw new Error(
            "Iroh tunnel is unavailable in this environment. Add a wss:// fallback URL or click Save anyway.",
          );
        }
        probe = await probeRemoteMachine({
          url: candidate.url,
          token: cleanToken,
          allowLoopbackTunnel: candidate.routeType === "iroh",
          signal: controller.signal,
        });
      } else {
        throw new Error("Enter a server URL.");
      }
      if (controller.signal.aborted) return;
      persist(cleanUrl, cleanToken, probe);
    } catch (error) {
      if (controller.signal.aborted) return;
      setPending(false);
      setProbeFailed(true);
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label="Server URL or pairing link"
          optional={irohOnlyCapable}
          description={
            irohOnlyCapable
              ? "Optional fallback over Tailscale Funnel, zrok, or any wss:// proxy. This machine already has an Iroh route."
              : "Works over Tailscale Funnel, zrok, or any wss:// proxy."
          }
          error={urlError}
        >
          <Input
            ref={urlInputRef}
            placeholder="wss://host.example.org/_buzz-host#token=bha_…"
            value={rawUrl}
            disabled={pending}
            onPaste={handleUrlPaste}
            onBlur={(event) => splitPairingLink(event.currentTarget.value)}
            onChange={(event) => {
              setRawUrl(event.target.value);
              clearErrors();
            }}
          />
        </Field>
        <Field
          label="Machine name"
          optional
          description="Shown in the Run on picker when creating agents."
        >
          <Input
            placeholder={derivedName || "Omarchy or Mac Mini"}
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Access token"
          optional
          description="Filled automatically when you paste a #token= pairing link. Leave blank for tailnet-only servers."
        >
          <Input
            type="password"
            placeholder="bha_…"
            value={token}
            disabled={pending}
            onChange={(event) => {
              setToken(event.target.value);
              setSubmitError("");
              setProbeFailed(false);
            }}
          />
        </Field>
        {submitError && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {submitError}
          </p>
        )}
      </form>
      <ProviderDialogActions>
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        {probeFailed && (
          <Button
            disabled={pending}
            onClick={() => void save({ skipCheck: true })}
          >
            Save anyway
          </Button>
        )}
        <Button type="submit" form={formId} variant="primary" loading={pending}>
          {editing ? "Save" : "Connect and save"}
        </Button>
      </ProviderDialogActions>
    </>
  );
}

/** Add or edit a machine in its own dialog, for flows outside Settings such
 * as the Create agent Run on picker. */
export function MachineEditorDialog({
  machine,
  onClose,
  onSaved,
}: {
  machine?: RemoteMachine | undefined;
  onClose(): void;
  onSaved?: ((machine: RemoteMachine) => void) | undefined;
}) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={machine ? `Edit ${machine.name}` : "Add machine"}
      description={
        machine && hasIrohRoute(machine) && !primaryWssUrl(machine)
          ? "This machine connects over Iroh. Optionally add a wss:// fallback URL or update its access token."
          : "Paste a buzz-host pairing link (wss://…#token=bha_…) or a server URL."
      }
      size="compact"
      initialFocus={urlInputRef}
      preventClose={pending}
      actions={<div ref={setFooter} className="contents" />}
    >
      <ProviderDialogFooter value={footer}>
        <MachineEditorForm
          machine={machine}
          urlInputRef={urlInputRef}
          onPendingChange={setPending}
          onCancel={() => setOpen(false)}
          onSaved={(saved) => {
            onSaved?.(saved);
            setOpen(false);
          }}
        />
      </ProviderDialogFooter>
    </Dialog>
  );
}

type ManagerView =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "add" }>
  | Readonly<{ kind: "edit"; machine: RemoteMachine }>
  | Readonly<{ kind: "remove"; machine: RemoteMachine }>;

/** The Self-hosted provider dialog's body: the machine list, with add, edit
 * and remove shown in place of it rather than in a second modal. */
export function RemoteMachinesManager() {
  const machines = useRemoteMachines();
  const statuses = useRemoteMachineStatuses();
  const [view, setView] = useState<ManagerView>({ kind: "list" });
  const urlInputRef = useRef<HTMLInputElement>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // The trigger, not document.activeElement: WebKit does not focus clicked buttons.
  const open = (
    next: Exclude<ManagerView, { kind: "list" }>,
    trigger: HTMLElement,
  ) => {
    returnFocus.current = trigger;
    setView(next);
  };
  const back = () => setView({ kind: "list" });

  useLayoutEffect(() => {
    if (view.kind === "add" || view.kind === "edit")
      urlInputRef.current?.focus();
    else if (view.kind === "remove") removeCancelRef.current?.focus();
    else {
      const trigger = returnFocus.current;
      if (!trigger) return;
      returnFocus.current = null;
      // A removed machine takes its buttons with it.
      (trigger.isConnected
        ? trigger
        : listRef.current?.querySelector<HTMLElement>("button:not([disabled])")
      )?.focus();
    }
  }, [view]);

  const subtitleFor = (machine: RemoteMachine) => {
    const status = statuses[machine.id];
    const parts: string[] = [];
    const host = hostLabel(machine);
    if (host) parts.push(host);
    if (status?.state === "checking") {
      parts.push("Checking…");
    } else if (status?.state === "online") {
      const count = status.agentCount ?? 0;
      parts.push(`${count} ${count === 1 ? "agent" : "agents"}`);
      if (machine.capabilities?.desktop === false) {
        parts.push("No remote desktop");
      }
    } else if (status?.state === "offline") {
      parts.push(status.error ? `Offline · ${status.error}` : "Offline");
    }
    return parts.join(" · ");
  };

  return (
    <div className="grid gap-3">
      <div ref={listRef} hidden={view.kind !== "list"} className="grid gap-3">
        <InlineHeader
          title="Machines"
          subtitle="Linux or macOS computers running buzz-host. Choose one in Run on when you create an agent."
          actions={
            machines.length > 0 ? (
              <Button
                type="button"
                size="sm"
                onClick={(event) => open({ kind: "add" }, event.currentTarget)}
              >
                <PlusIcon size={16} aria-hidden="true" />
                Add machine
              </Button>
            ) : undefined
          }
        />
        {machines.length === 0 ? (
          <EmptyState
            icon={<CloudIcon size={24} aria-hidden="true" />}
            title="No remote machines connected"
            description="Add a Linux or macOS machine running buzz-host to run agents remotely and keep them online while this computer is off."
            action={
              <Button
                type="button"
                variant="prominent"
                size="sm"
                onClick={(event) => open({ kind: "add" }, event.currentTarget)}
              >
                Add machine
              </Button>
            }
          />
        ) : (
          <SettingsGroup>
            {machines.map((machine) => {
              const status = statuses[machine.id];
              const platformLabel = formatPlatformLabel(machine.platform);
              const routeBadges = routeBadgesFor(machine, status);
              const checking = status?.state === "checking";
              const offline = status?.state === "offline";
              return (
                <PreferenceRow
                  key={machine.id}
                  icon={
                    offline ? (
                      <CloudOffIcon size={20} aria-hidden="true" />
                    ) : (
                      <CloudIcon size={20} aria-hidden="true" />
                    )
                  }
                  title={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span>{machine.name}</span>
                      {platformLabel && <Badge>{platformLabel}</Badge>}
                      {status?.state === "online" && (
                        <Badge tone="success">Online</Badge>
                      )}
                      {offline && <Badge>Offline</Badge>}
                      {routeBadges.map((label) => (
                        <Badge key={label}>{label}</Badge>
                      ))}
                      {machine.source === "discovered" && (
                        <Badge>Discovered</Badge>
                      )}
                      {machine.role === "guest" && <Badge>Guest</Badge>}
                    </span>
                  }
                  subtitle={subtitleFor(machine)}
                  trailing={
                    <div className="flex items-center gap-1">
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={`Check ${machine.name}`}
                        disabled={checking}
                        icon={
                          <ArrowsClockwiseIcon
                            size={16}
                            aria-hidden="true"
                            className={
                              checking ? "motion-safe:animate-spin" : undefined
                            }
                          />
                        }
                        onClick={() => void refreshRemoteMachine(machine.id)}
                      />
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={`Edit ${machine.name}`}
                        icon={<PencilSimpleIcon size={16} aria-hidden="true" />}
                        onClick={(event) =>
                          open({ kind: "edit", machine }, event.currentTarget)
                        }
                      />
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={`Remove ${machine.name}`}
                        icon={<TrashIcon size={16} aria-hidden="true" />}
                        onClick={(event) =>
                          open({ kind: "remove", machine }, event.currentTarget)
                        }
                      />
                    </div>
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
      </div>
      {(view.kind === "add" || view.kind === "edit") && (
        <>
          <InlineHeader
            title={
              view.kind === "edit" ? `Edit ${view.machine.name}` : "Add machine"
            }
            subtitle={
              view.kind === "edit" &&
              hasIrohRoute(view.machine) &&
              !primaryWssUrl(view.machine)
                ? "This machine connects over Iroh. Optionally add a wss:// fallback URL or update its access token."
                : "Paste a buzz-host pairing link (wss://…#token=bha_…) or a server URL."
            }
          />
          <MachineEditorForm
            key={view.kind === "edit" ? view.machine.id : "add"}
            machine={view.kind === "edit" ? view.machine : undefined}
            urlInputRef={urlInputRef}
            onCancel={back}
            onSaved={back}
          />
        </>
      )}
      {view.kind === "remove" && (
        <>
          <InlineHeader
            title={`Remove ${view.machine.name}?`}
            subtitle="Buzz will disconnect from this machine. Any agents already running on it keep running until removed there."
          />
          <ProviderDialogActions>
            <Button ref={removeCancelRef} onClick={back}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                removeRemoteMachine(view.machine.id);
                back();
              }}
            >
              Remove
            </Button>
          </ProviderDialogActions>
        </>
      )}
    </div>
  );
}
