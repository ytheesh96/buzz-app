import type { PluginModule } from "../../src/plugins/api";

export const inject: NonNullable<PluginModule["inject"]>;
export const apply: PluginModule["apply"];
