import { afterEach, expect, it, vi } from "vitest";
import { bundledPlugins } from ".";
import { orgPlugins } from "./org";

afterEach(() => {
  vi.doUnmock("./org.json");
  vi.resetModules();
});

it("bundles Remote Agents and Viewport after the rest", () => {
  expect(orgPlugins.map(({ manifest }) => manifest.id)).toEqual([
    "local.buzz-host",
    "local.buzz-host.viewport",
  ]);
  expect(orgPlugins.every(({ enabledByDefault }) => enabledByDefault)).toBe(
    true,
  );
  expect(
    bundledPlugins.slice(bundledPlugins.length - orgPlugins.length),
  ).toEqual(orgPlugins);
});

it("leaves out a plugin org.json lists without code in org.ts", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  vi.doMock("./org.json", () => ({
    default: [
      {
        manifest: { id: "org.example", name: "Example", apiVersion: 1 },
        enabledByDefault: true,
      },
    ],
  }));
  expect((await import("./org")).orgPlugins).toEqual([]);
  expect(error).toHaveBeenCalledWith(
    "Organization plugin org.example has no code in org.ts",
  );
  error.mockRestore();
});
