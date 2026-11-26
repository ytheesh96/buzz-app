import { invoke, isTauri } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { ProviderDialogActions } from "../features/agents/ProviderDialogActions";
import {
  addRemoteMachine,
  isValidSshTarget,
  type RemoteMachine,
  refreshRemoteMachine,
  sshRoute,
  updateRemoteMachine,
} from "../features/agents/remote-machines";
import {
  openSshTunnel,
  type SshSetupResult,
  type SshSetupStep,
  setupSshMachine,
  sshConfigHosts,
} from "../features/agents/ssh-machines";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleNotchIcon,
} from "../shared/design-system/icons";
import { Button } from "../shared/design-system/ui/Button";
import { Combobox } from "../shared/design-system/ui/Combobox";
import { Field } from "../shared/design-system/ui/Field";
import { FieldButton } from "../shared/design-system/ui/FieldButton";
import { Input } from "../shared/design-system/ui/Input";

const STEP_LABELS: Readonly<Record<SshSetupStep, string>> = {
  connect: "Connect over SSH",
  upload: "Upload the release",
  install: "Install and start buzz-host",
  start: "Start buzz-host",
};

function stepsFor(releaseDir: string): readonly SshSetupStep[] {
  return releaseDir ? ["connect", "upload", "install"] : ["connect", "start"];
}

function newMachineId(): string {
  return `m_${crypto.randomUUID().slice(0, 8)}`;
}

/** The host part of `user@host`, as a default machine name. */
function defaultName(target: string): string {
  return target.slice(target.lastIndexOf("@") + 1) || target;
}

/** Saves a set-up machine: an SSH-forwarded one, or (when buzz-host reports a
 * public address) an ordinary wss one. */
async function saveMachine(
  machine: RemoteMachine | undefined,
  target: string,
  name: string,
  result: SshSetupResult,
): Promise<RemoteMachine | undefined> {
  const fields = { name, token: result.token, platform: result.platform };
  if (result.tunnelPort === null) {
    if (!result.url.startsWith("wss://"))
      throw new Error(
        `buzz-host on ${target} reports ${result.url}, which Buzz cannot reach. Remove its public URL, or use wss://.`,
      );
    return machine
      ? updateRemoteMachine(machine.id, {
          ...fields,
          routes: [{ type: "wss", url: result.url }],
        })
      : addRemoteMachine({ ...fields, url: result.url });
  }
  const id = machine?.id ?? newMachineId();
  const current = machine ? sshRoute(machine) : undefined;
  const tunnel = await openSshTunnel(id, {
    target,
    remotePort: result.tunnelPort,
    ...(current ? { localPort: current.localPort } : {}),
  });
  const route = {
    type: "ssh" as const,
    target,
    remotePort: result.tunnelPort,
    localPort: tunnel.localPort,
  };
  if (!machine) return addRemoteMachine({ ...fields, id, routes: [route] });
  return updateRemoteMachine(machine.id, {
    ...fields,
    // Keep a discovered Iroh route; the SSH route replaces any other.
    routes: [route, ...machine.routes.filter((item) => item.type === "iroh")],
  });
}

/** Sets up (or upgrades) buzz-host on a computer over SSH and saves it as a
 * machine. Actions render into the surrounding dialog's footer. */
export function SshMachineForm({
  machine,
  targetInputRef,
  onCancel,
  onSaved,
  onPendingChange,
}: {
  machine?: RemoteMachine | undefined;
  targetInputRef?: RefObject<HTMLInputElement | null> | undefined;
  onCancel(): void;
  onSaved(machine: RemoteMachine): void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const existing = machine ? sshRoute(machine) : undefined;
  const [hosts, setHosts] = useState<readonly string[]>([]);
  const [target, setTarget] = useState(existing?.target ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [releaseDir, setReleaseDir] = useState("");
  const [targetError, setTargetError] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [pending, setPendingState] = useState(false);
  const [step, setStep] = useState<SshSetupStep | undefined>();
  const [log, setLog] = useState("");
  const [done, setDone] = useState<
    Readonly<{ machine: RemoteMachine; result: SshSetupResult }> | undefined
  >();
  const alive = useRef(true);
  const formId = useId();
  const statusId = useId();

  useEffect(() => {
    alive.current = true;
    void sshConfigHosts().then((list) => {
      if (alive.current) setHosts(list);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const setPending = (next: boolean) => {
    setPendingState(next);
    onPendingChange?.(next);
  };

  const chooseRelease = async () => {
    try {
      const path = await invoke<string | null>("workspace_pick_folder", {
        title: "Choose a buzz-host release folder",
        start: releaseDir || undefined,
      });
      if (alive.current && path) setReleaseDir(path);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const run = async () => {
    if (pending) return;
    const cleanTarget = target.trim();
    if (!isValidSshTarget(cleanTarget)) {
      setTargetError("Enter a host from your ~/.ssh/config, or user@host.");
      targetInputRef?.current?.focus();
      return;
    }
    setPending(true);
    setError("");
    setStep(undefined);
    setLog("");
    try {
      const result = await setupSshMachine(cleanTarget, releaseDir, (event) => {
        if (!alive.current) return;
        if (event.kind === "step") setStep(event.step);
        else setLog(event.line);
      });
      const saved = await saveMachine(
        machine,
        cleanTarget,
        name.trim() || machine?.name || defaultName(cleanTarget),
        result,
      );
      if (!saved) throw new Error("This machine was removed.");
      void refreshRemoteMachine(saved.id);
      if (alive.current) setDone({ machine: saved, result });
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setPending(false);
    }
  };

  if (done) {
    const { result } = done;
    const action = !result.installed
      ? "is running"
      : result.previousVersion && result.previousVersion !== result.version
        ? `was upgraded from ${result.previousVersion}`
        : "was installed";
    return (
      <>
        <div className="flex flex-col gap-3" role="status">
          <p className="m-0 text-body">
            buzz-host {result.version} {action} on {done.machine.name}.
          </p>
          <p className="m-0 text-body-sm text-secondary">
            Agents there use that computer's own Claude Code or Codex sign-in.
            If you haven't signed in on it yet, run{" "}
            <code>ssh {target.trim()}</code>, then <code>claude</code> (and{" "}
            <code>/login</code>) or <code>codex login</code>.
          </p>
        </div>
        <ProviderDialogActions>
          <Button variant="primary" onClick={() => onSaved(done.machine)}>
            Done
          </Button>
        </ProviderDialogActions>
      </>
    );
  }

  const steps = stepsFor(releaseDir);
  const current = step ? steps.indexOf(step) : -1;

  return (
    <>
      <form
        id={formId}
        className="flex flex-col gap-4"
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Combobox.Root<string>
          items={hosts}
          inputValue={target}
          onInputValueChange={(next, details) => {
            // Free text: keep what was typed when the list closes unpicked
            // (Base UI clears an unmatched input then).
            if (details.reason !== "input-change") return;
            setTarget(next);
            setTargetError(undefined);
            setError("");
          }}
          onValueChange={(next) => {
            if (next) {
              setTarget(next);
              setTargetError(undefined);
              setError("");
            }
          }}
          value={null}
          disabled={pending}
          modal={false}
        >
          <Combobox.Control
            ref={targetInputRef}
            label="SSH host"
            triggerLabel="Show hosts from ~/.ssh/config"
            placeholder="m1 or user@host.example.org"
            description="It must already connect from a terminal without a password prompt (a key or ssh-agent)."
            error={targetError}
          />
          <Combobox.Popup empty="No matching hosts in ~/.ssh/config.">
            <Combobox.List>
              {(host: string) => (
                <Combobox.Item key={host} value={host}>
                  {host}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Root>
        <Field
          label="Machine name"
          optional
          description="Shown in the Run on picker when creating agents."
        >
          <Input
            placeholder={defaultName(target.trim()) || "Mac Mini"}
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {isTauri() && (
          <Field
            label="Release folder"
            optional
            nativeLabel={false}
            description="To install or upgrade buzz-host, choose a folder with install.sh, the buzz-host bundle for the machine, and SHA256SUMS. Leave empty to start the buzz-host already installed there."
          >
            <div className="flex items-center gap-2">
              <FieldButton
                dropdown={false}
                title={releaseDir || undefined}
                aria-label={
                  releaseDir
                    ? `Release folder: ${releaseDir}`
                    : "Choose a release folder"
                }
                disabled={pending}
                onClick={() => void chooseRelease()}
              >
                {releaseDir || "Choose a folder…"}
              </FieldButton>
              {releaseDir && (
                <Button disabled={pending} onClick={() => setReleaseDir("")}>
                  Clear
                </Button>
              )}
            </div>
          </Field>
        )}
        {(pending || step) && (
          <div id={statusId} aria-live="polite" className="flex flex-col gap-2">
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {steps.map((item, index) => {
                const state =
                  index < current
                    ? "done"
                    : index !== current
                      ? "waiting"
                      : pending
                        ? "active"
                        : "failed";
                return (
                  <li
                    key={item}
                    className={`flex items-center gap-2 text-body-sm ${state === "waiting" ? "text-secondary" : state === "failed" ? "text-danger" : ""}`}
                  >
                    {state === "done" ? (
                      <CheckIcon size={16} aria-hidden="true" />
                    ) : state === "active" ? (
                      <CircleNotchIcon
                        size={16}
                        aria-hidden="true"
                        className="motion-safe:animate-spin"
                      />
                    ) : (
                      <CircleDashedIcon size={16} aria-hidden="true" />
                    )}
                    <span>{STEP_LABELS[item]}</span>
                  </li>
                );
              })}
            </ol>
            {pending && log && (
              <p
                className="m-0 truncate text-body-sm text-secondary"
                title={log}
              >
                {log}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
      <ProviderDialogActions>
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form={formId} variant="primary" loading={pending}>
          {machine ? "Set up again" : "Set up and save"}
        </Button>
      </ProviderDialogActions>
    </>
  );
}
