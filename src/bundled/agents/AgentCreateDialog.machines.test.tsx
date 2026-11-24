// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  activeMachineIdSnapshot,
  addRemoteMachine,
  machineForAgent,
  resetRemoteMachinesCache,
  SELF_HOSTED_TYPE_KEY,
} from "../../features/agents/remote-machines";
import { AgentCreateDialog } from "./AgentCreateDialog";

vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

const localHarness: RegisteredAgentType = {
  key: "local/claude",
  pluginId: "local",
  revision: "1",
  id: "claude",
  title: "Claude Code",
  description: "Local Claude Code harness",
  defaults: () => ({ config: { instructions: "" } }),
  adopt: (carry, saved) => ({
    ...(saved as object),
    instructions: carry.instructions ?? "",
  }),
  carry: (config) => ({
    instructions: (config as { instructions?: string })?.instructions ?? "",
  }),
  Create: () => null,
};

function makeSelfHostedType(mountedIds: string[]): RegisteredAgentType {
  return {
    key: SELF_HOSTED_TYPE_KEY,
    pluginId: "local.buzz-host",
    revision: "1",
    id: "omarchy",
    title: "Self-hosted",
    description: "Self-hosted buzz-host remote agent",
    defaults: () => ({ config: { runtime: "claude", instructions: "" } }),
    adopt: (carry, saved) => ({
      ...(saved as object),
      instructions: carry.instructions ?? "",
    }),
    carry: (config) => ({
      instructions: (config as { instructions?: string })?.instructions ?? "",
    }),
    remote: {
      provision: vi.fn(),
      activate: vi.fn(),
      profile: vi.fn(),
      instructions: { get: vi.fn(), set: vi.fn() },
      remove: vi.fn(),
    },
    CreateConfiguration: ({ config, onReadyChange }) => {
      const machineId =
        (config as { machineId?: string } | undefined)?.machineId ?? "";
      mountedIds.push(machineId);
      useEffect(() => {
        onReadyChange?.(true);
      }, [onReadyChange]);
      return <div data-testid="self-hosted-config">machine:{machineId}</div>;
    },
    Create: () => null,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMachinesCache();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetRemoteMachinesCache();
});

it("lets the user pick between This computer and configured remote machines and records the owning machine", async () => {
  const linux = addRemoteMachine({
    name: "Omarchy",
    url: "wss://omarchy.example.org:8447",
    platform: "linux",
    capabilities: { desktop: true },
  });
  const mac = addRemoteMachine({
    name: "Mac Mini",
    url: "wss://mac-mini.example.org/_buzz-host",
    token: "bha_mac",
    platform: "darwin",
    capabilities: { desktop: false },
  });

  const mountedIds: string[] = [];
  const selfHosted = makeSelfHostedType(mountedIds);
  const createdAgent: Agent = {
    key: "agent-key-1",
    pubkey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    type: SELF_HOSTED_TYPE_KEY,
    name: "Mac Builder",
    config: {},
    place: "hosted",
    relay: "wss://relay.example.org",
  } as Agent;
  const onCreate = vi.fn(async () => createdAgent);
  const onCreated = vi.fn();
  const agents = {
    previewRetype: () => undefined,
    create: onCreate,
  } as unknown as Agents;

  const user = userEvent.setup();
  render(
    <AgentCreateDialog
      agents={agents}
      types={[localHarness, selfHosted]}
      onClose={() => {}}
      onCreated={onCreated}
      onCreate={onCreate}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  const runOn = within(dialog).getByRole("combobox", { name: "Run on" });
  expect(runOn).toHaveTextContent("This computer");

  await user.click(runOn);
  await user.click(await screen.findByRole("option", { name: /Mac Mini/ }));

  expect(runOn).toHaveTextContent("Mac Mini");
  expect(activeMachineIdSnapshot()).toBe(mac.id);
  expect(within(dialog).getByTestId("self-hosted-config")).toHaveTextContent(
    `machine:${mac.id}`,
  );
  expect(within(dialog).getByText(/macOS · No remote desktop/)).toBeVisible();

  // Switching to Linux machine updates config and active target cleanly.
  await user.click(runOn);
  await user.click(await screen.findByRole("option", { name: /Omarchy/ }));
  expect(activeMachineIdSnapshot()).toBe(linux.id);
  expect(within(dialog).getByTestId("self-hosted-config")).toHaveTextContent(
    `machine:${linux.id}`,
  );

  await user.type(within(dialog).getByLabelText("Name"), "Mac Builder");
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );
  // Remote introduction step names the chosen machine.
  expect(await screen.findByText(/I work on Omarchy/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Let’s go" }));

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdAgent));
  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      type: SELF_HOSTED_TYPE_KEY,
      name: "Mac Builder",
      config: expect.objectContaining({ machineId: linux.id }),
    }),
  );
  expect(machineForAgent(createdAgent.pubkey)?.id).toBe(linux.id);
});

it("hides Run on and leaves the active machine alone without the Remote Agents plugin", () => {
  addRemoteMachine({
    name: "Mac Mini",
    url: "wss://mac-mini.example.org/_buzz-host",
    platform: "darwin",
  });
  const before = activeMachineIdSnapshot();
  const agents = { previewRetype: () => undefined } as unknown as Agents;

  render(
    <AgentCreateDialog
      agents={agents}
      types={[localHarness]}
      onClose={() => {}}
      onCreated={() => {}}
      onCreate={vi.fn()}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(
    within(dialog).queryByRole("combobox", { name: "Run on" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText("Mac Mini")).not.toBeInTheDocument();
  expect(activeMachineIdSnapshot()).toBe(before);
});
