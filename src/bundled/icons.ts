const manifests = import.meta.glob<{ id: string }>(
  ["./*/manifest.json", "../../plugins/*/manifest.json"],
  {
    eager: true,
    import: "default",
  },
);
const icons = import.meta.glob<string>(
  ["./*/icon.{png,jpg}", "../../plugins/*/icon.{png,jpg}"],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

export const bundledIcons: ReadonlyMap<string, string> = new Map(
  Object.entries(manifests).flatMap(([path, manifest]) => {
    const directory = path.replace(/manifest\.json$/, "");
    const icon = icons[`${directory}icon.png`] ?? icons[`${directory}icon.jpg`];
    return icon ? [[manifest.id, icon] as const] : [];
  }),
);
