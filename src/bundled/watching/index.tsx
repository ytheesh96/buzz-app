import type { PluginModule } from "../../plugins/api";
import type { Agents } from "../../features/agents/service";
import { type AttentionSetting, createTab } from "./Tab";

/** Local patch: what a hosted type's provider supplies for Buzz's own
 * Attention tab, in the shape of Buzz's agent service: a snapshot whose
 * `running` holds the agent with its attention fields, its subscription,
 * and `save` for the tab's edits (attention, attentionExpected, watchEnabled). */
type AttentionSource = Pick<Agents, "snapshot" | "subscribe" | "save">;

export const inject = ["agents", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay, navigation } = ctx;
  // Attention runs only while this plugin is on to show and control it.
  agents.controlAttention();
  agents.registerTab({
    id: "watching",
    title: "Attention",
    // Hosted agents have no attention on this device.
    when: (agent) => agent.place === "here",
    component: createTab({ agents, relay, navigation }),
  });
  // Local patch: the same tab for a hosted agent type whose provider keeps its
  // attention (buzz-host): ctx.reflect.get("attentionTab")?.create(source).
  ctx.provide?.("attentionTab", {
    version: 1,
    create: (source: AttentionSource, setting?: AttentionSetting) =>
      createTab(
        {
          agents: {
            snapshot: source.snapshot,
            subscribe: source.subscribe,
            save: source.save,
            presentWatch: agents.presentWatch,
          } as unknown as Agents,
          relay,
          navigation,
        },
        setting,
      ),
  });
};
