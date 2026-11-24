import { expect, it } from "vitest";
import {
  agentExecution,
  remoteExecutionDetail,
  remoteWorkDetail,
} from "./execution-location";

it("keeps unknown execution distinct from local, including an unavailable harness", () => {
  expect(agentExecution({ place: "hosted" })).toBe("remote");
  expect(agentExecution({ place: "here" })).toBe("local");
  expect(agentExecution({ place: "elsewhere" })).toBeUndefined();
  expect(agentExecution({ place: "elsewhere" }, {})).toBe("local");
});

it("keeps a native agent with a remote execution binding distinct from local custody", () => {
  expect(
    agentExecution({
      place: "here",
      executionBinding: { provider: "internal/remote" },
    }),
  ).toBe("remote");
});

it("names the owning remote machine while keeping Builderlab and generic fallbacks intact", () => {
  expect(
    remoteExecutionDetail("remote", "local.buzz-host/omarchy", "Mac Mini"),
  ).toBe("Runs on Mac Mini");
  expect(
    remoteWorkDetail("remote", "local.buzz-host/omarchy", "Mac Mini"),
  ).toBe("Running on Mac Mini…");
  expect(
    remoteExecutionDetail("remote", "block.builderlab/builderlab", "Mac Mini"),
  ).toBe("Runs remotely on Builderlab");
  expect(
    remoteWorkDetail("remote", "block.builderlab/builderlab", "Mac Mini"),
  ).toBe("Running remotely on Builderlab…");
  expect(remoteExecutionDetail("remote", "local.buzz-host/omarchy")).toBe(
    "Runs on a remote machine",
  );
  expect(remoteWorkDetail("remote", "local.buzz-host/omarchy")).toBe(
    "Running on a remote machine…",
  );
});
