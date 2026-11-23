// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents/react";
import type { Agents, Models } from "../agents/service";
import { createMessages } from "../relay/messages";
import type { ProfileQueries } from "../relay/profile-directory";
import { ComposerModels, type DraftPicks } from "./ComposerModels";
import { parseSoloModelPicks } from "./solo-model-picks";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

const pubkey = "a".repeat(64);
const profiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};

const runtimes = [
  { id: "claude", label: "Claude Code" },
  { id: "antigravity", label: "Antigravity" },
  { id: "hermes", label: "Hermes · default", group: "Hermes" },
  { id: "hermes:career-lead", label: "Hermes · career-lead", group: "Hermes" },
  { id: "hermes:selfhost", label: "Hermes · selfhost", group: "Hermes" },
] as const;

const claudeCatalog: Models = {
  current: "opus",
  currentRuntime: "claude",
  modelsRuntime: "claude",
  runtimes,
  models: [
    {
      id: "opus",
      label: "Opus 5.5",
      effort: "high",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "sonnet",
      label: "Sonnet",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ],
};

const careerLeadCatalog: Models = {
  current: "go:flash",
  currentRuntime: "claude",
  modelsRuntime: "hermes:career-lead",
  runtimes,
  models: [
    {
      id: "go:flash",
      label: "OpenCode Go · flash",
      group: "OpenCode Go",
      effort: "medium",
      efforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "claude-subscription-directsdk-experimental:claude-haiku-4-5-20251001",
      label: "Anthropic · claude-haiku-4-5-20251001",
      group: "Anthropic",
      efforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
      ],
    },
  ],
};

function Harness({
  initial = {},
  resettable = false,
  modelsImpl,
  onResolved,
}: {
  initial?: DraftPicks;
  resettable?: boolean;
  modelsImpl: (
    agent: unknown,
    place?: { channelId: string; root?: string },
    runtime?: string,
  ) => Promise<Models>;
  onResolved: (value: unknown) => void;
}) {
  const [value, setValue] = useState<DraftPicks>(initial);
  const agents = useMemo(() => {
    const snapshot = {
      status: "ready" as const,
      agents: [
        {
          pubkey,
          key: pubkey,
          name: "Haiku",
          type: "local.buzz-host/omarchy",
          config: {},
        },
      ],
    };
    const types = [
      {
        key: "local.buzz-host/omarchy",
        id: "omarchy",
        models: modelsImpl,
      },
    ];
    return {
      find: (key: string) =>
        snapshot.agents.find((agent) => agent.pubkey === key),
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
    } as unknown as Agents;
  }, [modelsImpl]);
  const place = useMemo(() => ({ channelId: "c1" }), []);
  const pubkeys = useMemo(() => [pubkey], []);
  return (
    <AgentsContext.Provider value={agents}>
      <ComposerModels
        pubkeys={pubkeys}
        profiles={profiles}
        media={() => undefined}
        value={value}
        disabled={false}
        resettable={resettable}
        explicitOnly={resettable}
        startsThread={false}
        place={place}
        onChange={setValue}
        focusAfterPickerRemoval={() => {}}
        onResolved={onResolved}
      />
    </AgentsContext.Provider>
  );
}

it("switches Hermes profiles in the Runtime row, lazy-loads that profile's models, and resolves runtime picks", async () => {
  const user = userEvent.setup();
  const resolved = vi.fn();
  const modelsImpl = vi.fn(
    async (_agent: unknown, _place?: unknown, runtime?: string) =>
      runtime === "hermes:career-lead" ? careerLeadCatalog : claudeCatalog,
  );
  render(<Harness modelsImpl={modelsImpl} onResolved={resolved} />);

  const trigger = await screen.findByRole("button", {
    name: "Model and effort for the next run",
  });
  await user.click(trigger);

  // Runtime row shows Claude Code; Model row shows Opus 5.5 without a runtime prefix.
  const runtimeBtn = await screen.findByRole("button", {
    name: "Runtime for Haiku's next run",
  });
  expect(runtimeBtn).toHaveTextContent("Claude Code");
  expect(
    screen.getByRole("button", { name: "Model for Haiku's next run" }),
  ).toHaveTextContent("Opus 5.5");

  // Open Runtime menu and pick Hermes -> career-lead.
  await user.click(runtimeBtn);
  const careerLead = await screen.findByRole("menuitemradio", {
    name: "career-lead",
  });
  await user.click(careerLead);

  await waitFor(() =>
    expect(runtimeBtn).toHaveTextContent("Hermes · career-lead"),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Model for Haiku's next run" }),
    ).toHaveTextContent("OpenCode Go · flash"),
  );
  // One-click profile switch resolves with just `runtime` (uses profile's default model).
  await waitFor(() =>
    expect(resolved).toHaveBeenLastCalledWith({
      [pubkey]: { runtime: "hermes:career-lead" },
    }),
  );
});

it("attaches currentRuntime when picking only a model on a multi-runtime agent", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const resolved = vi.fn();
  const activeHermes: Models = {
    ...careerLeadCatalog,
    currentRuntime: "hermes:career-lead",
    modelsRuntime: "hermes:career-lead",
  };
  const modelsImpl = vi.fn(async () => activeHermes);
  render(<Harness modelsImpl={modelsImpl} onResolved={resolved} />);

  await user.click(
    await screen.findByRole("button", {
      name: "Model and effort for the next run",
    }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Model for Haiku's next run" }),
  );
  // Hover the Anthropic provider submenu and pick the 68-char model id.
  const anthropic = await screen.findByRole("menuitem", { name: "Anthropic" });
  await user.hover(anthropic);
  const haikuModel = await screen.findByRole("menuitemradio", {
    name: "claude-haiku-4-5-20251001",
  });
  fireEvent.click(haikuModel);

  await waitFor(() =>
    expect(resolved).toHaveBeenLastCalledWith({
      [pubkey]: {
        runtime: "hermes:career-lead",
        model:
          "claude-subscription-directsdk-experimental:claude-haiku-4-5-20251001",
      },
    }),
  );
});

it("emits runtime tag and accepts long Hermes model ids in relay/messages and solo-model-picks", async () => {
  const published: Array<{ tags: string[][] }> = [];
  const messages = createMessages(
    {
      supports: () => true,
      send: async (template: {
        kind: number;
        content: string;
        tags: string[][];
      }) => {
        published.push(template);
        return {
          id: "1".repeat(64),
          pubkey: "2".repeat(64),
          created_at: 1,
          kind: template.kind,
          tags: template.tags,
          content: template.content,
          sig: "3".repeat(128),
        };
      },
    } as never,
    "2".repeat(64),
    () => undefined,
    () => [],
    () => {},
  );
  const longModel =
    "claude-subscription-directsdk-experimental:claude-haiku-4-5-20251001";
  await messages.send(
    "61ace2b8-1160-44c8-ad2b-6efd96b816af",
    "hello",
    [pubkey],
    [],
    undefined,
    [],
    {
      [pubkey]: {
        runtime: "hermes:career-lead",
        model: longModel,
        effort: "high",
      },
    },
  );
  expect(published[0]?.tags).toContainEqual([
    "runtime",
    pubkey,
    "hermes:career-lead",
  ]);
  expect(published[0]?.tags).toContainEqual(["model", pubkey, longModel]);
  expect(published[0]?.tags).toContainEqual(["effort", pubkey, "high"]);

  expect(
    parseSoloModelPicks(
      JSON.stringify({
        [pubkey]: { runtime: "hermes:selfhost", model: "go:flash" },
      }),
    ),
  ).toEqual({
    [pubkey]: { runtime: "hermes:selfhost", model: "go:flash" },
  });
});
