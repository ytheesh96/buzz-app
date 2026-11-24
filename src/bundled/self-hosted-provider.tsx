// The Self-hosted harness's Harness defaults row. The Remote Agents plugin
// registers the type; this build gives it a provider whose dialog manages the
// buzz-host machines the app connects to, so they sit beside the other
// harnesses rather than in a separate Settings section.
import type { Context } from "@deepseek-ai/cordis";
import { RemoteMachinesManager } from "../app/RemoteMachinesSettings";
import type {
  AgentProvider,
  AgentProviderSnapshot,
} from "../features/agents/service";
import {
  refreshAllRemoteMachines,
  remoteMachinesSnapshot,
  remoteMachineStatusesSnapshot,
  subscribeRemoteMachines,
  subscribeRemoteMachineStatuses,
} from "../features/agents/remote-machines";
import { startRemoteMachineDiscovery } from "../features/agents/remote-machine-discovery";
import type { PluginModule } from "../plugins/api";
import { CloudIcon } from "../shared/design-system/icons";

/** The type id the Remote Agents plugin registers for Self-hosted agents. */
const SELF_HOSTED_TYPE_ID = "omarchy";

let cached:
  | Readonly<{
      machines: ReturnType<typeof remoteMachinesSnapshot>;
      statuses: ReturnType<typeof remoteMachineStatusesSnapshot>;
      snapshot: AgentProviderSnapshot;
    }>
  | undefined;

function snapshot(): AgentProviderSnapshot {
  const machines = remoteMachinesSnapshot();
  const statuses = remoteMachineStatusesSnapshot();
  if (cached?.machines === machines && cached.statuses === statuses)
    return cached.snapshot;
  const offline = machines.filter(
    (machine) => statuses[machine.id]?.state === "offline",
  );
  // Never status-only: the dialog is where machines are added and fixed.
  const next: AgentProviderSnapshot = Object.freeze(
    machines.length === 0
      ? {
          readiness: "attention",
          attentionLabel: "Connect a machine",
          attentionDescription:
            "Connect a Linux or macOS machine running buzz-host.",
        }
      : offline.length === machines.length
        ? {
            readiness: "attention",
            attentionLabel: "Manage machines",
            attentionDescription:
              machines.length === 1
                ? `${machines[0]?.name} is offline.`
                : "None of your machines are reachable.",
          }
        : { readiness: "ready" },
  );
  cached = { machines, statuses, snapshot: next };
  return next;
}

export const selfHostedProvider: AgentProvider = {
  snapshot,
  subscribe(listener) {
    const stopMachines = subscribeRemoteMachines(listener);
    const stopStatuses = subscribeRemoteMachineStatuses(listener);
    return () => {
      stopMachines();
      stopStatuses();
    };
  },
  check: () =>
    remoteMachinesSnapshot().length > 0
      ? refreshAllRemoteMachines()
      : undefined,
  DialogBody: RemoteMachinesManager,
};

/** The plugin's context, except that its Self-hosted type registers with
 * this provider and icon. Everything else reaches the real context. */
function withProvider(ctx: Context): Context {
  const forward = <T extends object>(target: T, key: PropertyKey) => {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(ctx, {
    get(target, key) {
      if (key !== "agents") return forward(target, key);
      const agents = target.agents;
      return new Proxy(agents, {
        get(target, key) {
          if (key !== "register") return forward(target, key);
          return (type: Parameters<typeof agents.register>[0]) =>
            target.register(
              type?.id === SELF_HOSTED_TYPE_ID
                ? { ...type, icon: CloudIcon, provider: selfHostedProvider }
                : type,
            );
        },
      });
    },
  });
}

/** The Remote Agents plugin, with the Self-hosted provider attached. */
export function withSelfHostedProvider(module: PluginModule): PluginModule {
  return {
    ...module,
    apply(ctx) {
      ctx.effect(() =>
        startRemoteMachineDiscovery({
          relay: ctx.reflect.get("relay"),
          communityReader: ctx.reflect.get("communityReader"),
        }),
      );
      return module.apply(withProvider(ctx));
    },
  };
}
