// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentCreationRequest,
  RegisteredAgentType,
} from "../../features/agents/service";
import { CreationReview } from "./CreationReview";

afterEach(cleanup);

function fixture(change: Partial<AgentCreationRequest> = {}) {
  let requests: readonly AgentCreationRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      type: "test/echo",
      name: "Child",
      ...change,
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const types = [
    {
      key: "test/echo",
      title: "Echo",
      defaults: () => ({ config: { reply: "default" } }),
      adopt: (carry: { instructions?: string }, saved: { reply: string }) => ({
        reply: carry.instructions ?? saved.reply,
      }),
    },
    {
      key: "test/cloud",
      title: "Cloud",
      remote: {},
      defaults: () => ({ config: { reply: "hosted" } }),
      adopt: (carry: { instructions?: string }, saved: { reply: string }) => ({
        reply: carry.instructions ?? saved.reply,
      }),
    },
    {
      key: "test/other-cloud",
      title: "Other cloud",
      remote: {},
      defaults: () => ({ config: {} }),
    },
  ] as unknown as readonly RegisteredAgentType[];
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    creationRequests: () => requests,
    approveCreation: vi.fn(async () => {
      clear();
      return {} as Agent;
    }),
    dismissCreation: vi.fn(clear),
    create: vi.fn(),
  };
  render(<CreationReview agents={agents as unknown as Agents} />);
  return agents;
}

it("prefills an editable review and creates only when the owner submits", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  const name = await screen.findByDisplayValue("Child");
  expect(
    screen.getByText(/Parent requested this agent\. Review/),
  ).toBeVisible();
  expect(agents.approveCreation).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewed");
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        name: "Reviewed",
        type: "test/echo",
        config: { reply: "default" },
      }),
    ),
  );
  expect(agents.create).not.toHaveBeenCalled();
});

it("starts from a requested picture and creates the agent with it", async () => {
  const user = userEvent.setup();
  const agents = fixture({ picture: "https://example.test/kid.png" });
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ picture: "https://example.test/kid.png" }),
    ),
  );
});

it("starts the review from the requested instructions", async () => {
  const user = userEvent.setup();
  const agents = fixture({ instructions: "Review PRs." });
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ config: { reply: "Review PRs." } }),
    ),
  );
});

it("dismisses an unsaved request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissCreation).toHaveBeenCalledWith("draft"),
  );
  expect(agents.approveCreation).not.toHaveBeenCalled();
  expect(agents.create).not.toHaveBeenCalled();
});

it("offers a hosted agent's draft its own hosted type, and no other (local patch)", async () => {
  const user = userEvent.setup();
  const agents = fixture({ type: "test/cloud", instructions: "Scout jobs." });
  await screen.findByDisplayValue("Child");
  expect(screen.queryByText("Other cloud")).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  // The same introduction a manually created remote agent gets.
  await user.click(await screen.findByRole("button", { name: /Let’s go/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        name: "Child",
        type: "test/cloud",
        config: { reply: "Scout jobs." },
      }),
    ),
  );
});
