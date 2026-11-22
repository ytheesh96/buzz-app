import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

const { externalPluginIcon } = await import("./content-icon");

it("reads an external plugin's packaged icon once per revision", async () => {
  invoke.mockResolvedValue({ iconPng: "iVBO", iconJpg: null });
  await expect(externalPluginIcon("example.one", "r1")).resolves.toBe(
    "data:image/png;base64,iVBO",
  );
  await externalPluginIcon("example.one", "r1");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("plugin_content", {
    id: "example.one",
    revision: "r1",
  });
});

it("falls back to the JPEG icon and retries after a failed read", async () => {
  invoke.mockRejectedValueOnce(new Error("Plugin was updated"));
  await expect(externalPluginIcon("example.two", "r1")).resolves.toBe(
    undefined,
  );
  invoke.mockResolvedValueOnce({ iconPng: null, iconJpg: "/9j/" });
  await expect(externalPluginIcon("example.two", "r1")).resolves.toBe(
    "data:image/jpeg;base64,/9j/",
  );
});
