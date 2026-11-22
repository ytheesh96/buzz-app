import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";

type Content = { iconPng?: string | null; iconJpg?: string | null };

// One read per installed revision; a new revision (update or rollback) is a new key.
const icons = new Map<string, Promise<string | undefined>>();

/** Data URL for an external plugin's packaged icon.png/icon.jpg, if it ships one. */
export function externalPluginIcon(
  id: string,
  revision: string,
): Promise<string | undefined> | undefined {
  if (!desktop) return undefined;
  const key = `${id}@${revision}`;
  let icon = icons.get(key);
  if (!icon) {
    icon = invoke<Content>("plugin_content", { id, revision }).then(
      ({ iconPng, iconJpg }) =>
        iconPng
          ? `data:image/png;base64,${iconPng}`
          : iconJpg
            ? `data:image/jpeg;base64,${iconJpg}`
            : undefined,
      () => {
        icons.delete(key);
        return undefined;
      },
    );
    icons.set(key, icon);
  }
  return icon;
}
