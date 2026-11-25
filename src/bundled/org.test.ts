import { afterEach, expect, it, vi } from "vitest";
import { bundledPlugins } from ".";
import { bundledIcons } from "./icons";
import { orgPlugins } from "./org";
import { bundledReadmes } from "./readmes";

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

it("categorizes Viewport under Agent tools and ships icons and READMEs for org plugins", () => {
  const byId = new Map(
    orgPlugins.map((plugin) => [plugin.manifest.id, plugin]),
  );
  expect(byId.get("local.buzz-host")?.manifest.discovery?.category).toBe(
    "agents",
  );
  expect(
    byId.get("local.buzz-host.viewport")?.manifest.discovery?.category,
  ).toBe("agent-tools");

  for (const { manifest } of orgPlugins) {
    expect(bundledIcons.get(manifest.id), `${manifest.id} icon`).toBeTruthy();
    const [guide = ""] = (bundledReadmes.get(manifest.id) ?? "").split(
      "\n---\n",
    );
    expect(guide.split("\n")[0], `${manifest.id} readme title`).toBe(
      `# ${manifest.name}`,
    );
    expect(guide.match(/^## .*/gm), `${manifest.id} readme headings`).toEqual([
      "## Getting started",
    ]);
  }
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
