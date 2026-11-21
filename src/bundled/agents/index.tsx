import type { PluginModule } from "../../plugins/api";
import { registerAttention } from "../../features/agents/attention-command";
import { registerDiscovery } from "../../features/agents/attention-discovery";
import { registerDecideTool } from "../../features/decisions/agent-tool";
import { AgentsPage } from "./AgentsPage";
import { AgentCardAttachment, isAgentCard } from "./AgentCardAttachment";
import {
  AgentCardLink,
  agentCardLinkId,
  createAgentCardReads,
} from "./AgentCardLink";
import { availableAgentProviderRoute } from "./routes";
import { developerMode } from "../../features/developer/mode";
import { withImportScenario } from "../../features/developer/agent-import-scenario";
import { isTauri } from "@tauri-apps/api/core";
import type {} from "../../features/agents/external-connection";
import { ExternalConnectionSettings } from "./ExternalConnectionSettings";
import { externalMcpEnabled } from "../../features/agents/external-connection";
import { forgetMemoryListingsOnSelection } from "../../features/agents/memory";
import inlineStyles from "../../shared/InlineReference.module.css";
import { createActivityTab } from "../builderlab/adapter-type/Activity";
import { gatewayRoutes } from "../../features/agents/gateway/route";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ModelPicker } from "../../features/agents/ModelPicker";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export const inject = [
  "pages",
  "agents",
  "relay",
  "navigation",
  "communityReader",
  "host",
  "conversation",
  "decisions",
  "settingsCards",
  "externalApps",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerAttention(ctx);
  registerDiscovery(ctx.agents);
  registerDecideTool(ctx.agents, ctx.decisions);
  ctx.effect(() => forgetMemoryListingsOnSelection(ctx.communityReader));
  const { relay, navigation: navigator } = ctx;
  // Local patch: Buzz's published-activity panel, the Activity tab Builderlab's
  // hosted agents get, for any hosted type's own Activity tab. Plugins read it
  // with ctx.reflect.get("publishedActivity")?.component and give it their
  // tab's props.
  // Local patch: Buzz's own controls for an outside agent type's settings tab
  // and creation fields, as Buzz's built-in harnesses compose them (Harness,
  // Model and Thinking rows in a SettingsGroup, AgentInstructions, the shared
  // save bar), read with ctx.reflect.get("agentUi"). Props as in buzz-app.
  ctx.provide(
    "agentUi",
    Object.freeze({
      version: 1,
      SettingsGroup,
      PreferenceRow,
      Select,
      Field,
      Input,
      Textarea,
      Button,
      ModelPicker,
      AgentInstructions,
      AgentSaveButton,
    }),
  );
  ctx.provide("publishedActivity", {
    component: createActivityTab(
      relay,
      (section) =>
        void navigator.open({ version: 1, kind: "settings", section }),
    ),
  });
  const agents = developerMode ? withImportScenario(ctx.agents) : ctx.agents;
  if (isTauri()) {
    // Gateway readiness probes go out under this plugin's native grant for
    // the build's gateway origin, which exists only when routing is on.
    if (gatewayRoutes.configured)
      ctx.effect(() =>
        gatewayRoutes.bindRequest((request) => ctx.host.request(request)),
      );
    const connection = ctx.externalApps;
    ctx.effect(() =>
      connection.bind({
        connect: ctx.agents.connectExternal.bind(ctx.agents),
        pairing: (operation, request) => {
          if (!ctx.host.externalMcpPairing)
            throw new Error("Saved approval is unavailable");
          return ctx.host.externalMcpPairing(operation, request);
        },
        deny: (request) => {
          if (!ctx.host.denyMcpAuthorization)
            throw new Error("External authorization is unavailable");
          return ctx.host.denyMcpAuthorization(request);
        },
      }),
    );
    ctx.settingsCards.register({
      id: "external-apps",
      title: "External apps",
      visibility: {
        snapshot: () =>
          externalMcpEnabled(ctx.communityReader.snapshot().selected),
        subscribe: (listener) => ctx.communityReader.subscribe(listener),
        ensure: () => () => {},
      },
      component: () => <ExternalConnectionSettings connection={connection} />,
    });
  }
  ctx.conversation.registerAttachment({
    id: "agent-card",
    title: "Agent card",
    matches: isAgentCard,
    component: (props) => (
      <AgentCardAttachment
        {...props}
        agents={agents}
        relay={relay}
        navigator={navigator}
      />
    ),
  });
  const cardReads = createAgentCardReads();
  ctx.conversation.registerLink({
    id: "agent-card",
    title: "Agent card links",
    matches: (url) => agentCardLinkId(url) !== null,
    className: inlineStyles.link,
    component: ({ url }) => <AgentCardLink url={url} reads={cardReads} />,
  });
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        linkRenderers={ctx.conversation.links}
        agents={agents}
        relay={relay}
        communities={ctx.communityReader}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
