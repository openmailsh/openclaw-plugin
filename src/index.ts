import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { openmailPlugin } from "./channel.js";
import { registerOpenMailCli } from "./cli.js";
import { setOpenMailRuntime } from "./runtime.js";

export default defineChannelPluginEntry({
  id: "openmail",
  name: "OpenMail",
  description: "OpenMail channel plugin: give your agent its own email address.",
  plugin: openmailPlugin,
  // Durable ingress queue and cursor store live on the runtime.
  setRuntime: setOpenMailRuntime,
  // `openclaw openmail -- ...` is what the bundled skill tells the agent to run.
  registerCliMetadata: (api) => registerOpenMailCli(api),
});
