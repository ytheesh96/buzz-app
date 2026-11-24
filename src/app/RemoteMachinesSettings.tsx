import { type ClipboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  addRemoteMachine,
  deriveMachineName,
  formatPlatformLabel,
  parseMachineInput,
  primaryWssUrl,
  probeRemoteMachine,
  refreshAllRemoteMachines,
  refreshRemoteMachine,
  removeRemoteMachine,
  updateRemoteMachine,
  useRemoteMachines,
  useRemoteMachineStatuses,
  type RemoteMachine,
} from "../features/agents/remote-machines";
import {
  ArrowsClockwiseIcon,
  CloudIcon,
  CloudOffIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "../shared/design-system/icons";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
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
  return iroh ? `Iroh ${iroh.nodeId.slice(0, 12)}…` : "";
}

export function MachineEditorDialog({
  machine,
  onClose,
  onSaved,
}: {
  machine?: RemoteMachine | undefined;
  onClose(): void;
  onSaved?: ((machine: RemoteMachine) => void) | undefined;
}) {
  const editing = Boolean(machine);
  const [open, setOpen] = useState(true);
  const [rawUrl, setRawUrl] = useState(machine ? primaryWssUrl(machine) : "");
  const [name, setName] = useState(machine?.name ?? "");
  const [token, setToken] = useState(machine?.token ?? "");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState("");
  const [probeFailed, setProbeFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const formId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleUrlChange = (value: string) => {
    setRawUrl(value);
    setUrlError(undefined);
    setSubmitError("");
    setProbeFailed(false);
  };

  const handleUrlPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    const parsed = parseMachineInput(pasted);
    if (!parsed.error && parsed.token) {
      event.preventDefault();
      setRawUrl(parsed.url);
      setToken(parsed.token);
      setUrlError(undefined);
      setSubmitError("");
      setProbeFailed(false);
    }
  };

  const parsedPreview = parseMachineInput(rawUrl);
  const derivedName =
    !parsedPreview.error && parsedPreview.url
      ? deriveMachineName(parsedPreview.url)
      : "";

  const persist = (
    cleanUrl: string,
    cleanToken: string,
    probe?: Awaited<ReturnType<typeof probeRemoteMachine>>,
  ) => {
    const cleanName = name.trim() || deriveMachineName(cleanUrl);
    const saved = machine
      ? updateRemoteMachine(machine.id, {
          name: cleanName,
          url: cleanUrl,
          token: cleanToken,
          ...(probe?.platform ? { platform: probe.platform } : {}),
          ...(probe?.host ? { host: probe.host } : {}),
          ...(probe?.role ? { role: probe.role } : {}),
          ...(probe?.runtimes ? { runtimes: probe.runtimes } : {}),
          ...(probe?.capabilities ? { capabilities: probe.capabilities } : {}),
          ...(probe?.publicGuestUrl !== undefined
            ? { publicGuestUrl: probe.publicGuestUrl }
            : {}),
          ...(probe ? { lastSeen: Date.now() } : {}),
        })
      : addRemoteMachine({
          name: cleanName,
          url: cleanUrl,
          token: cleanToken,
          ...(probe?.platform ? { platform: probe.platform } : {}),
          ...(probe?.host ? { host: probe.host } : {}),
          ...(probe?.role ? { role: probe.role } : {}),
          ...(probe?.runtimes ? { runtimes: probe.runtimes } : {}),
          ...(probe?.capabilities ? { capabilities: probe.capabilities } : {}),
          ...(probe?.publicGuestUrl !== undefined
            ? { publicGuestUrl: probe.publicGuestUrl }
            : {}),
          ...(probe ? { lastSeen: Date.now() } : {}),
        });
    if (saved) {
      onSaved?.(saved);
      void refreshRemoteMachine(saved.id);
    }
    setOpen(false);
  };

  const save = async ({ skipCheck = false }: { skipCheck?: boolean } = {}) => {
    if (pending) return;
    const parsed = parseMachineInput(rawUrl);
    if (parsed.error) {
      setUrlError(parsed.error);
      urlInputRef.current?.focus();
      return;
    }
    const cleanUrl = parsed.url;
    const cleanToken = (parsed.token ?? token).trim();
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
      const probe = await probeRemoteMachine({
        url: cleanUrl,
        token: cleanToken,
        signal: controller.signal,
      });
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={editing ? `Edit ${machine?.name}` : "Add machine"}
      description="Paste a buzz-host pairing link (wss://…#token=bha_…) or a server URL."
      size="compact"
      initialFocus={urlInputRef}
      preventClose={pending}
      actions={
        <>
          <Button disabled={pending} onClick={() => setOpen(false)}>
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
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={pending}
          >
            {editing ? "Save" : "Connect and save"}
          </Button>
        </>
      }
    >
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
          description="Works over Tailscale Funnel, zrok, or any wss:// proxy."
          error={urlError}
        >
          <Input
            ref={urlInputRef}
            placeholder="wss://host.example.org/_buzz-host#token=bha_…"
            value={rawUrl}
            disabled={pending}
            onPaste={handleUrlPaste}
            onChange={(event) => handleUrlChange(event.target.value)}
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
    </Dialog>
  );
}

export function RemoteMachinesSettings({
  active = true,
}: {
  active?: boolean;
}) {
  const machines = useRemoteMachines();
  const statuses = useRemoteMachineStatuses();
  const [editor, setEditor] = useState<
    { mode: "add" } | { mode: "edit"; machine: RemoteMachine } | null
  >(null);
  const [removing, setRemoving] = useState<RemoteMachine | null>(null);

  useEffect(() => {
    if (!active || machines.length === 0) return;
    const controller = new AbortController();
    void refreshAllRemoteMachines({ signal: controller.signal });
    return () => controller.abort();
  }, [active, machines.length]);

  const subtitleFor = (machine: RemoteMachine) => {
    const status = statuses[machine.id];
    const parts: string[] = [];
    const host = hostLabel(machine);
    if (host) parts.push(host);
    if (machine.routes.some((route) => route.type === "iroh")) {
      parts.push("Iroh");
    }
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
    <div className="mt-section-gap">
      <InlineHeader
        title="Machines"
        subtitle="Connect Linux or Mac computers running buzz-host so you can choose where each agent runs."
        actions={
          machines.length > 0 ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setEditor({ mode: "add" })}
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
              onClick={() => setEditor({ mode: "add" })}
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
                      onClick={() => setEditor({ mode: "edit", machine })}
                    />
                    <IconButton
                      type="button"
                      size="sm"
                      aria-label={`Remove ${machine.name}`}
                      icon={<TrashIcon size={16} aria-hidden="true" />}
                      onClick={() => setRemoving(machine)}
                    />
                  </div>
                }
              />
            );
          })}
        </SettingsGroup>
      )}
      {editor && (
        <MachineEditorDialog
          machine={editor.mode === "edit" ? editor.machine : undefined}
          onClose={() => setEditor(null)}
        />
      )}
      {removing && (
        <AlertDialog
          title={`Remove ${removing.name}?`}
          description="Buzz will disconnect from this machine. Any agents already running on it keep running until removed there."
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  removeRemoteMachine(removing.id);
                  setRemoving(null);
                }}
              >
                Remove
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
