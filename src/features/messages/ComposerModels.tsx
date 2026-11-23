import { useProfileGeneration } from "../relay/react";
import { Popover } from "@base-ui/react/popover";
import { EffortSlider } from "./composer-models/EffortSlider";
import { avatarMedia } from "../../shared/avatar-source";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { selectProfiles } from "../relay/profile-selection";
import type { ProfileQueries } from "../relay/profile-directory";
import {
  Fragment,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import {
  AgentsContext,
  useSessionState,
  useMentionModels,
  useAgentsSnapshot,
} from "../agents/react";
import type { MentionModelChoice } from "../agents/react";
import { onAutomatic } from "../agents/recommended";
import type { SessionPlace, SessionControlAction } from "../agents/service";
import type { MentionPicks, RunPick } from "../relay/messages";
import {
  CaretDownIcon,
  FoldIcon,
  CheckIcon,
  ArrowCounterClockwiseIcon,
  StopIcon,
  CircleNotchIcon,
  CircleDottedIcon,
  GaugeIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
} from "../../shared/design-system/ui/Menu";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import styles from "./ComposerModels.module.css";

/** The draft's picks, each with the agent type it was made under. */
export type DraftPicks = Readonly<
  Record<string, RunPick & Readonly<{ type?: string }>>
>;

type ComposerModelsProps = Parameters<typeof ComposerModelsFor>[0];

/** The picker below. An agent on Automatic (Recommended) runs on the
 * recommendation, so it offers only its session controls, and a pick saved
 * for it before it switched is left out of what is sent. */
export function ComposerModels(props: ComposerModelsProps) {
  const agents = useContext(AgentsContext);
  // Read again as agents change, such as one switching to or from Automatic.
  const snapshot = useAgentsSnapshot(agents);
  const automatic = Object.keys(props.value)
    .filter((pubkey) => {
      const agent = snapshot?.agents.find((item) => item.pubkey === pubkey);
      const type =
        agent && agents?.types().find((item) => item.key === agent.type);
      return !!type && onAutomatic(agent.config, type.id);
    })
    .join(":");
  const value = useMemo(
    () =>
      automatic
        ? Object.fromEntries(
            Object.entries(props.value).filter(
              ([pubkey]) => !automatic.split(":").includes(pubkey),
            ),
          )
        : props.value,
    [props.value, automatic],
  );
  return <ComposerModelsFor {...props} value={value} />;
}

/** Model and effort for the next run of each mentioned agent of the viewer's
 * that offers a choice. Session controls act immediately on this conversation. */
function ComposerModelsFor({
  pubkeys,
  profiles,
  media,
  value,
  disabled,
  resettable = false,
  explicitOnly = false,
  onChange,
  focusAfterPickerRemoval,
  onResolved,
  onRetryInventory,
  startsThread,
  place,
}: {
  pubkeys: readonly string[];
  profiles: ProfileQueries;
  media: Parameters<typeof avatarMedia>[1];
  value: DraftPicks;
  disabled: boolean;
  /** Solo chat picks are defaults for the chat until explicitly reset. */
  resettable?: boolean;
  /** A new Solo chat keeps provider defaults unchanged unless picked. */
  explicitOnly?: boolean;
  onChange(value: DraftPicks, resetPubkeys?: readonly string[]): void;
  focusAfterPickerRemoval(): void;
  /** null waits for choices; undefined invalidates the picker's snapshot. */
  onResolved(value: MentionPicks | null | undefined, error?: string): void;
  onRetryInventory?(): void;
  /** The message starts a thread of its own, as a channel's top-level one
   * does, so a thread-scoped agent has no session to act on. */
  startsThread: boolean;
  place: SessionPlace;
}) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const unavailableDescriptionId = useId();
  const requestedRuntimes = useMemo(
    () =>
      Object.fromEntries(
        pubkeys.flatMap((pubkey) =>
          value[pubkey]?.runtime ? [[pubkey, value[pubkey].runtime]] : [],
        ),
      ),
    [pubkeys, value],
  );
  const mentioned = useMentionModels(pubkeys, retry, place, requestedRuntimes);
  const choices = useMemo<readonly MentionModelChoice[]>(
    () =>
      mentioned.flatMap((choice) => {
        const { session, ...catalog } = choice;
        const visible: MentionModelChoice =
          startsThread && session === "thread" ? catalog : choice;
        const unavailablePick = unavailableSavedPick(
          visible,
          value[visible.pubkey] ?? {},
          resettable,
          explicitOnly,
        );
        return visible.loading ||
          visible.failed ||
          (visible.runtimes?.length ?? 0) > 1 ||
          visible.models.length > 1 ||
          visible.models.some((model) => model.efforts.length) ||
          visible.session ||
          unavailablePick
          ? [visible]
          : [];
      }),
    [mentioned, startsThread, resettable, explicitOnly, value],
  );
  const profileKey = pubkeys.join(":");
  const selection = useMemo(
    () => selectProfiles(profiles, profileKey.split(":")),
    [profiles, profileKey],
  );
  // A mentioned agent need not be a member yet, so its profile may not be loaded.
  const profileGeneration = useProfileGeneration(profiles);
  useEffect(() => {
    void profileGeneration;
    if (profileKey)
      void profiles.ensure(profileKey.split(":"), "background").catch(() => {});
  }, [profiles, profileKey, profileGeneration]);
  const portraits = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const agents = useContext(AgentsContext);
  const agentSnapshot = useAgentsSnapshot(agents);
  const unavailableType =
    resettable &&
    pubkeys.some((pubkey) => {
      const agent = agentSnapshot?.agents.find(
        (item) => item.pubkey === pubkey,
      );
      return (
        hasPick(value[pubkey]) &&
        agent &&
        !agents?.types().some((type) => type.key === agent.type)
      );
    });
  const unresolvedInventory =
    unavailableType ||
    (resettable &&
      (agentSnapshot?.status === "loading" ||
        agentSnapshot?.status === "error") &&
      pubkeys.some(
        (pubkey) =>
          hasPick(value[pubkey]) &&
          !agentSnapshot.agents.some((agent) => agent.pubkey === pubkey),
      ));
  const inventoryFailed =
    unavailableType ||
    (unresolvedInventory && agentSnapshot?.status === "error");
  // A pick keeps the type it was made under: a retype drops it, even while
  // the new type's choices load or once they fail to, as none showed it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mentioned` follows the agents' snapshot, so a retype reruns this.
  useLayoutEffect(() => {
    const kept = Object.fromEntries(
      Object.entries(value).filter(([pubkey, { type }]) => {
        const now = agents?.find(pubkey)?.type;
        return !type || !now || now === type;
      }),
    );
    if (Object.keys(kept).length !== Object.keys(value).length) onChange(kept);
  }, [agents, mentioned, value, onChange]);
  const thumb = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreComposerFocusAfterReset = useRef(false);
  // Publish the displayed defaults separately from the user's draft picks.
  // A settings refresh or model-only pick must still follow the new default.
  useLayoutEffect(() => {
    const waitingForSavedChoices =
      resettable &&
      (unresolvedInventory ||
        mentioned.some((choice) => {
          const saved = value[choice.pubkey];
          if (!hasPick(saved)) return false;
          if (choice.loading || choice.failed) return true;
          return Boolean(
            saved?.runtime &&
              choice.runtimes?.some((item) => item.id === saved.runtime) &&
              choice.modelsRuntime &&
              choice.modelsRuntime !== saved.runtime,
          );
        }));
    if (waitingForSavedChoices) {
      onResolved(
        null,
        inventoryFailed || mentioned.some((choice) => choice.failed)
          ? "Saved model and effort choices could not be loaded. Open model and effort controls to retry or reset them."
          : undefined,
      );
      return () => onResolved(undefined);
    }
    const resolved: Record<string, RunPick> = resettable
      ? {}
      : Object.fromEntries(
          Object.entries(value).map(([pubkey, { runtime, model, effort }]) => [
            pubkey,
            {
              ...(runtime ? { runtime } : {}),
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            },
          ]),
        );
    for (const choice of resettable ? mentioned : choices) {
      if (choice.loading || choice.failed) continue;
      const saved = value[choice.pubkey] ?? {};
      const selectedRuntime = saved.runtime
        ? choice.runtimes?.find((item) => item.id === saved.runtime)
        : undefined;
      const modelsReady =
        !saved.runtime ||
        !choice.modelsRuntime ||
        choice.modelsRuntime === saved.runtime;
      const selected = modelsReady
        ? choice.models.find((item) => item.id === saved.model)
        : undefined;
      const runs = runModel(choice, modelsReady ? saved.model : undefined);
      const explicitEffort =
        modelsReady && runs.id
          ? runs.efforts.find(
              (item) =>
                item.id === saved.effort &&
                (!resettable || !saved.model || selected !== undefined),
            )?.id
          : undefined;
      const effort =
        explicitEffort ??
        (runs.efforts.some((item) => item.id === runs.effort)
          ? runs.effort
          : undefined);
      if (choice.sendDefaults && !explicitOnly && runs.id) {
        const runtimeOut =
          selectedRuntime?.id ??
          (choice.runtimes?.length && choice.currentRuntime
            ? choice.currentRuntime
            : undefined);
        resolved[choice.pubkey] = {
          ...(runtimeOut ? { runtime: runtimeOut } : {}),
          model: runs.id,
          ...(effort ? { effort } : {}),
        };
      } else if (
        resettable &&
        (selectedRuntime || selected || explicitEffort)
      ) {
        const runtimeOut =
          selectedRuntime?.id ??
          (selected && choice.runtimes?.length && choice.currentRuntime
            ? choice.currentRuntime
            : undefined);
        resolved[choice.pubkey] = {
          ...(runtimeOut ? { runtime: runtimeOut } : {}),
          ...(selected ? { model: selected.id } : {}),
          ...(explicitEffort ? { effort: explicitEffort } : {}),
        };
      } else if (
        !resettable &&
        choice.runtimes?.length &&
        choice.currentRuntime &&
        resolved[choice.pubkey]?.model &&
        !resolved[choice.pubkey]?.runtime
      ) {
        resolved[choice.pubkey] = {
          runtime: choice.currentRuntime,
          ...resolved[choice.pubkey],
        };
      }
    }
    onResolved(resolved);
    return () => onResolved(undefined);
  }, [
    choices,
    mentioned,
    value,
    onResolved,
    resettable,
    explicitOnly,
    unresolvedInventory,
    inventoryFailed,
  ]);
  const canReset =
    resettable && pubkeys.some((pubkey) => hasPick(value[pubkey]));
  const anyRuntimes = choices.some(
    (choice) => (choice.runtimes?.length ?? 0) > 1,
  );
  useLayoutEffect(() => {
    if (!restoreComposerFocusAfterReset.current || open) return;
    restoreComposerFocusAfterReset.current = false;
    if (!trigger.current?.isConnected) focusAfterPickerRemoval();
  }, [open, focusAfterPickerRemoval]);
  if (!choices.length && !inventoryFailed && !canReset) return null;
  const picked = choices.flatMap((choice) => {
    if (choice.loading) return [];
    const { runtime, model, effort } = value[choice.pubkey] ?? {};
    const runtimeItem = choice.runtimes?.find((item) => item.id === runtime);
    const showRuntime = Boolean(
      runtimeItem && (resettable || runtime !== choice.currentRuntime),
    );
    const modelsMatch =
      !runtime || !choice.modelsRuntime || choice.modelsRuntime === runtime;
    const runs = runModel(choice, modelsMatch ? model : undefined);
    const selected =
      modelsMatch && choice.models.some((item) => item.id === model);
    const unavailable = unavailableSavedPick(
      choice,
      value[choice.pubkey] ?? {},
      resettable,
      explicitOnly,
    );
    const savedEffortApplies =
      modelsMatch && (!resettable || !model || selected);
    const supportedEffort = savedEffortApplies
      ? runs.efforts.find((item) => item.id === effort)
      : undefined;
    const text =
      unavailable ??
      [
        showRuntime && runtimeItem?.label,
        selected && runs.label,
        effort !== undefined && supportedEffort?.label,
      ]
        .filter(Boolean)
        .join(" · ");
    return text ? [choices.length > 1 ? `${choice.name}: ${text}` : text] : [];
  });
  const unavailableDescription = choices.flatMap((choice) => {
    const unavailable = unavailableSavedPick(
      choice,
      value[choice.pubkey] ?? {},
      resettable,
      explicitOnly,
    );
    return unavailable
      ? [choices.length > 1 ? `${choice.name}: ${unavailable}` : unavailable]
      : [];
  });
  const pick = (pubkey: string, next: RunPick) => {
    const { [pubkey]: _, ...rest } = value;
    const type = agents?.find(pubkey)?.type;
    onChange(
      next.runtime || next.model || next.effort
        ? { ...rest, [pubkey]: { ...next, ...(type ? { type } : {}) } }
        : rest,
    );
  };
  const label =
    choices.length > 0 && choices.every((choice) => choice.automatic)
      ? `Session controls${resettable ? " for this chat" : ""}`
      : choices.some((choice) => choice.session)
        ? `Model, effort, and session controls${resettable ? " for this chat" : ""}`
        : resettable
          ? "Model and effort for this chat"
          : "Model and effort for the next run";
  const target = resettable ? "this chat" : "next run";
  const unavailableDescriptionText = unavailableDescription.join(" ");
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      {unavailableDescriptionText && (
        <span id={unavailableDescriptionId} className="sr-only">
          {unavailableDescriptionText}
        </span>
      )}
      <Popover.Trigger
        disabled={disabled}
        render={
          <IconButton
            ref={trigger}
            size="toolbar"
            type="button"
            disabled={disabled}
            data-selected={picked.length ? "" : undefined}
            aria-label={label}
            aria-describedby={
              unavailableDescriptionText ? unavailableDescriptionId : undefined
            }
            title={
              picked.length
                ? `${label}. ${target}: ${picked.join(", ")}`
                : label
            }
            icon={<GaugeIcon size={18} aria-hidden="true" />}
          />
        }
      />
      <Popover.Portal>
        {/* The controls are the whole popup: it has no surface of its own. */}
        <Popover.Positioner
          className="buzz-popover-positioner"
          side="top"
          align="end"
          sideOffset={8}
          anchor={() => trigger.current?.closest("form") ?? trigger.current}
          collisionPadding={8}
        >
          <Popover.Popup
            className={styles.popup}
            aria-label={label}
            initialFocus={thumb}
          >
            <div
              className="sr-only"
              role="status"
              aria-label="Saved model and effort availability"
              aria-atomic="true"
            >
              <span className={styles.statusCopy}>
                {unavailableDescriptionText}
              </span>
            </div>
            {inventoryFailed && (
              <div className={`${styles.agent} floating-surface`}>
                <PanelHeader
                  variant="card"
                  title={<PanelHeaderLabel title="Model and effort" />}
                />
                <div className={styles.controls}>
                  <div className={styles.status}>
                    <span className={styles.statusCopy} role="alert">
                      Agents could not be loaded.
                    </span>
                    {onRetryInventory && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onRetryInventory();
                          setOpen(false);
                        }}
                      >
                        Retry agents
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {canReset && (
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  restoreComposerFocusAfterReset.current = true;
                  const addressed = new Set(pubkeys);
                  onChange(
                    Object.fromEntries(
                      Object.entries(value).filter(
                        ([pubkey]) => !addressed.has(pubkey),
                      ),
                    ),
                    [...addressed],
                  );
                  setOpen(false);
                }}
              >
                {anyRuntimes
                  ? "Reset runtime, model, and effort"
                  : "Reset model and effort"}
              </Button>
            )}
            {choices.map((choice, index) => (
              <AgentChoice
                key={choice.pubkey}
                choice={choice}
                availability={unavailableSavedPick(
                  choice,
                  value[choice.pubkey] ?? {},
                  resettable,
                  explicitOnly,
                )}
                avatarSrc={avatarMedia(
                  portraits.get(choice.pubkey)?.picture,
                  media,
                )}
                place={place}
                value={value[choice.pubkey] ?? {}}
                disabled={disabled}
                chatScoped={resettable}
                retry={() => setRetry((attempt) => attempt + 1)}
                pick={(next) => pick(choice.pubkey, next)}
                {...(index === 0 ? { thumb } : {})}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const hasPick = (saved: RunPick | undefined) =>
  Boolean(saved?.runtime || saved?.model || saved?.effort);

/** The model a run uses: the picked one, or else the agent's own. */
const runModel = (choice: MentionModelChoice, picked: string | undefined) =>
  choice.models.find((item) => item.id === picked) ??
  choice.models.find((item) => item.id === choice.current) ??
  choice.models[0] ?? { id: "", label: "", efforts: [] };

function unavailableSavedPick(
  choice: MentionModelChoice,
  value: RunPick,
  resettable: boolean,
  explicitOnly: boolean,
) {
  if (!resettable || choice.loading || choice.failed) return undefined;
  if (
    value.runtime &&
    choice.runtimes?.length &&
    !choice.runtimes.some((item) => item.id === value.runtime)
  ) {
    return "Saved runtime is unavailable. Using the active runtime. Your saved choice is retained until you reset it.";
  }
  if (
    value.runtime &&
    choice.modelsRuntime &&
    choice.modelsRuntime !== value.runtime
  ) {
    return undefined;
  }
  const selectedModel = choice.models.some((item) => item.id === value.model);
  const runs = runModel(choice, value.model);
  const unavailableModel = Boolean(value.model && !selectedModel);
  const unavailableEffort = Boolean(
    value.effort &&
      (!value.model || selectedModel) &&
      !runs.efforts.some((item) => item.id === value.effort),
  );
  if (!unavailableModel && !unavailableEffort) return undefined;
  const defaultEffort = runs.efforts.find((item) => item.id === runs.effort);
  const modelIsKnown =
    selectedModel ||
    (choice.sendDefaults && !explicitOnly) ||
    choice.current === runs.id;
  const fallback = runs.id
    ? !modelIsKnown
      ? "Send omits model and effort overrides; the agent or provider decides which model runs"
      : `Using ${runs.label}${
          defaultEffort
            ? ` with its default effort (${defaultEffort.label})`
            : runs.efforts.length
              ? " with the provider's default effort"
              : ""
        }`
    : "No supported model is listed in the loaded catalog. Send omits model and effort overrides and uses the agent's defaults";
  const reason = unavailableModel
    ? "Saved model is unavailable."
    : modelIsKnown && runs.id
      ? `Saved effort is unavailable for ${runs.label}.`
      : "Saved effort is unavailable.";
  return `${reason} ${fallback}. Your saved choice is retained until you reset it.`;
}

function AgentChoice({
  choice,
  availability,
  avatarSrc,
  place,
  value,
  disabled,
  chatScoped,
  retry,
  pick,
  thumb,
}: {
  choice: MentionModelChoice;
  availability: string | undefined;
  avatarSrc: string | undefined;
  place: SessionPlace;
  value: RunPick;
  disabled: boolean;
  chatScoped: boolean;
  retry(): void;
  pick(next: RunPick): void;
  thumb?: Ref<HTMLInputElement>;
}) {
  const [feedback, setFeedback] = useState("");
  if (choice.loading)
    return (
      <div
        className={`${styles.loading} floating-surface`}
        role="status"
        aria-busy="true"
      >
        <PanelHeader
          variant="card"
          title={<PanelHeaderLabel title={choice.name} />}
        />
        <div className={styles.controls}>
          <div className={styles.status}>
            <span className={styles.statusIcon}>
              <CircleNotchIcon
                size={20}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            </span>
            <div className={styles.statusCopy}>
              <ShimmerText>Loading model and effort…</ShimmerText>
            </div>
          </div>
        </div>
      </div>
    );
  const runtimes = choice.runtimes ?? [];
  const hasRuntimes = runtimes.length > 1;
  const selectedRuntime = runtimes.some((item) => item.id === value.runtime)
    ? value.runtime
    : undefined;
  const activeRuntimeId =
    selectedRuntime ?? choice.currentRuntime ?? runtimes[0]?.id ?? "";
  const activeRuntime =
    runtimes.find((item) => item.id === activeRuntimeId) ?? runtimes[0];
  const runtimeGroups = [
    ...new Set(runtimes.flatMap((item) => item.group ?? [])),
  ];
  const runtimeModelsLoading = Boolean(
    activeRuntimeId &&
      choice.modelsRuntime &&
      choice.modelsRuntime !== activeRuntimeId,
  );
  const runs = runModel(choice, runtimeModelsLoading ? undefined : value.model);
  const selectedModel =
    !runtimeModelsLoading &&
    choice.models.some((item) => item.id === value.model)
      ? value.model
      : undefined;
  const selectedEffort =
    !runtimeModelsLoading &&
    (!chatScoped || !value.model || selectedModel !== undefined)
      ? runs.efforts.find((item) => item.id === value.effort)?.id
      : undefined;
  const several = choice.models.length > 1;
  // Switching runtime/profile resets model and effort so the new runtime's own
  // default applies unless a model on it is chosen next.
  const chooseRuntime = (id: string) => {
    if (id === activeRuntimeId && (!chatScoped || value.runtime === id)) return;
    pick(chatScoped || id !== choice.currentRuntime ? { runtime: id } : {});
  };
  // Chat choices stay explicit even when they match the provider default.
  // An effort the new model lacks falls back to its default.
  const chooseModel = (id: string) => {
    const next = choice.models.find((item) => item.id === id);
    const effort = next?.efforts.some((item) => item.id === value.effort)
      ? value.effort
      : undefined;
    pick({
      ...(selectedRuntime ? { runtime: selectedRuntime } : {}),
      ...(chatScoped || id !== choice.current ? { model: id } : {}),
      ...(effort ? { effort } : {}),
    });
  };
  // A hosted runtime with many providers groups its models by provider.
  const groups = [
    ...new Set(choice.models.flatMap((item) => item.group ?? [])),
  ];
  const radios = (items: typeof choice.models, group?: string) => (
    <MenuRadioGroup value={runs.id} onValueChange={chooseModel}>
      {items.map((item) => (
        <MenuRadioItem key={item.id} value={item.id} closeOnClick>
          {group && item.label.startsWith(`${group} · `)
            ? item.label.slice(group.length + 3)
            : item.label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
  const model = (level?: string) =>
    several ? (
      <div className={styles.model}>
        <MenuRoot>
          <MenuTrigger
            disabled={disabled}
            aria-label={
              chatScoped
                ? `Model for ${choice.name} in this chat`
                : `Model for ${choice.name}'s next run`
            }
            render={
              <Button variant="subtle" size="sm">
                <span className={styles.about}>{runs.label}</span>
                {level && <span className={styles.level}>{level}</span>}
                <CaretDownIcon size={12} aria-hidden="true" />
              </Button>
            }
          />
          <MenuPopup size="compact" side="top" align="end">
            {groups.length ? (
              <>
                {choice.models.some((item) => !item.group) &&
                  radios(choice.models.filter((item) => !item.group))}
                {groups.map((group) => (
                  <MenuSubmenu key={group}>
                    <MenuSubmenuTrigger
                      data-selected={
                        choice.models.find((item) => item.id === runs.id)
                          ?.group === group
                          ? ""
                          : undefined
                      }
                    >
                      {group}
                    </MenuSubmenuTrigger>
                    <MenuSubmenuPopup
                      size="compact"
                      aria-label={`${group} models`}
                    >
                      {radios(
                        choice.models.filter((item) => item.group === group),
                        group,
                      )}
                    </MenuSubmenuPopup>
                  </MenuSubmenu>
                ))}
              </>
            ) : (
              radios(choice.models)
            )}
          </MenuPopup>
        </MenuRoot>
      </div>
    ) : (
      <span className={styles.fixedModel}>
        {runs.label}
        {level && <span className={styles.level}>{level}</span>}
      </span>
    );
  return (
    <div
      className={`${styles.agent} floating-surface`}
      data-agent-model-card=""
    >
      <PanelHeader
        variant="card"
        title={
          <PanelHeaderLabel title={choice.name}>
            {!choice.automatic && hasRuntimes && (
              <div className={styles.runtime}>
                <MenuRoot>
                  <MenuTrigger
                    disabled={disabled}
                    aria-label={
                      chatScoped
                        ? `Runtime for ${choice.name} in this chat`
                        : `Runtime for ${choice.name}'s next run`
                    }
                    render={
                      <Button variant="subtle" size="sm">
                        <span className={styles.about}>
                          {activeRuntime?.label ?? activeRuntimeId}
                        </span>
                        <CaretDownIcon size={12} aria-hidden="true" />
                      </Button>
                    }
                  />
                  <MenuPopup size="compact" side="top" align="start">
                    <MenuRadioGroup
                      value={activeRuntimeId}
                      onValueChange={chooseRuntime}
                    >
                      {runtimes
                        .filter((item) => !item.group)
                        .map((item) => (
                          <MenuRadioItem
                            key={item.id}
                            value={item.id}
                            closeOnClick
                          >
                            {item.label}
                          </MenuRadioItem>
                        ))}
                      {runtimeGroups.map((group) => (
                        <Fragment key={group}>
                          {runtimes.some((item) => !item.group) && (
                            <MenuSeparator />
                          )}
                          <MenuGroup>
                            <MenuGroupLabel>{group}</MenuGroupLabel>
                            {runtimes
                              .filter((item) => item.group === group)
                              .map((item) => (
                                <MenuRadioItem
                                  key={item.id}
                                  value={item.id}
                                  closeOnClick
                                >
                                  {item.label.startsWith(`${group} · `)
                                    ? item.label.slice(group.length + 3)
                                    : item.label}
                                </MenuRadioItem>
                              ))}
                          </MenuGroup>
                        </Fragment>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </MenuRoot>
              </div>
            )}
          </PanelHeaderLabel>
        }
        actions={
          choice.session && (
            <SessionActions
              key={`${choice.pubkey}:${place.channelId}:${place.root ?? ""}`}
              pubkey={choice.pubkey}
              name={choice.name}
              place={place}
              onFeedback={setFeedback}
            />
          )
        }
      />
      {/* On Automatic it runs on the recommendation: only the session row. */}
      {!choice.automatic && availability && (
        <div className={styles.status} aria-hidden="true">
          <span className={styles.statusCopy}>{availability}</span>
        </div>
      )}
      {!choice.automatic && (
        <div className={styles.controls}>
          {choice.failed ? (
            <div className={styles.status}>
              <span className={styles.statusCopy} role="alert">
                Model and effort could not be loaded.
              </span>
              <Button size="sm" disabled={disabled} onClick={retry}>
                Retry
              </Button>
            </div>
          ) : runtimeModelsLoading ? (
            <div className={styles.status} role="status" aria-busy="true">
              <span className={styles.statusIcon}>
                <CircleNotchIcon
                  size={20}
                  className="motion-safe:animate-spin"
                  aria-hidden="true"
                />
              </span>
              <div className={styles.statusCopy}>
                <ShimmerText>Loading models…</ShimmerText>
              </div>
            </div>
          ) : runs.efforts.length > 0 ? (
            <EffortSlider
              name={choice.name}
              chatScoped={chatScoped}
              avatarSrc={avatarSrc}
              model={model}
              efforts={runs.efforts}
              resting={runs.effort}
              value={selectedEffort}
              disabled={disabled}
              pick={(effort) =>
                pick({
                  ...(selectedRuntime ? { runtime: selectedRuntime } : {}),
                  ...(selectedModel ? { model: selectedModel } : {}),
                  ...(effort ? { effort } : {}),
                })
              }
              {...(thumb ? { thumb } : {})}
            />
          ) : (
            <div className={styles.status}>
              <span className={styles.statusIcon}>
                <CircleDottedIcon size={20} aria-hidden="true" />
              </span>
              <div className={styles.statusCopy}>
                {runs.id && several ? (
                  model()
                ) : (
                  <span>
                    {runs.id
                      ? `${runs.label} · No thinking options`
                      : "Model unavailable"}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {feedback && (
        <span className={`${styles.about} ${styles.controls}`} role="status">
          {feedback}
        </span>
      )}
    </div>
  );
}

function SessionActions({
  pubkey,
  name,
  place,
  onFeedback,
}: {
  pubkey: string;
  name: string;
  place: SessionPlace;
  onFeedback(message: string): void;
}) {
  const agents = useContext(AgentsContext);
  const state = useSessionState(agents, [pubkey], place);
  const [started, setStarted] = useState<object>();
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(undefined), 3000);
    return () => clearTimeout(timer);
  }, [started]);
  const act = async (action: SessionControlAction) => {
    // Clearing first empties the live region, so a repeated success is
    // announced again.
    onFeedback("");
    setStarted(undefined);
    try {
      // Its membership in the selected community; a pubkey alone is refused.
      await agents?.session(agents.find(pubkey)?.key ?? pubkey, place, action);
      if (action === "new") {
        setHintDismissed(false);
        setStarted({});
      } else {
        onFeedback(
          action === "compact" ? "Session compacted" : "Interrupt requested",
        );
      }
    } catch (error) {
      onFeedback(
        error instanceof Error ? error.message : "Session action failed",
      );
    }
  };
  return (
    <fieldset className={styles.actions} aria-label={`${name}'s session`}>
      <span className="sr-only" role="status">
        {started ? "New session started" : ""}
      </span>
      {(
        [
          ["compact", "Compact session", FoldIcon],
          ["new", "Start a new session", ArrowCounterClockwiseIcon],
          ["interrupt", "Interrupt", StopIcon],
        ] as const
      ).map(([action, label, Icon]) => {
        const enabled =
          action === "interrupt"
            ? state === "active" || state === "compacting"
            : state === "idle";
        const title =
          state === "unavailable"
            ? `${label}: session controls unavailable. Check the agent's connection and the app running it.`
            : state === "compacting"
              ? action === "interrupt"
                ? "Interrupt compaction"
                : "Compacting session. Wait for it to finish, or interrupt it."
              : enabled
                ? label
                : action === "interrupt"
                  ? "Nothing to interrupt. The session is idle."
                  : `Wait for the active turn to finish before ${action === "compact" ? "compacting" : "starting a new session"}.`;
        const succeeded = action === "new" && !!started;
        return (
          <Tooltip
            key={action}
            content={succeeded ? "New session started" : title}
            {...(succeeded && !hintDismissed ? { open: true } : {})}
            onOpenChange={(open) => {
              if (!open && succeeded) setHintDismissed(true);
            }}
          >
            <IconButton
              size="sm"
              type="button"
              icon={
                succeeded ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <Icon aria-hidden="true" />
                )
              }
              aria-label={label}
              disabled={!enabled}
              loading={action === "compact" && state === "compacting"}
              focusableWhenDisabled
              onClick={() => void act(action)}
            />
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
