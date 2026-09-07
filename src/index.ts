import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { openmailPlugin } from "./channel.js";

export default defineChannelPluginEntry({
  id: "openmail",
  name: "OpenMail",
  description: "OpenMail channel plugin: give your agent its own email address.",
  plugin: openmailPlugin,
});
