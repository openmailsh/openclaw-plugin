// The PluginRuntime handed to us at registration. Needed outside the gateway
// context for durable state (ingress queue, keyed stores). The SDK store keys
// the slot by plugin id so duplicate module instances share one runtime.
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime, getRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "openmail",
  errorMessage: "OpenMail plugin runtime is not initialised; the gateway must load the plugin first.",
});

export const setOpenMailRuntime = setRuntime;
export const getOpenMailRuntime = getRuntime;
