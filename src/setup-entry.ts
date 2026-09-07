// Loaded during onboarding/setup instead of index.ts so `ws` and the
// gateway loop never get imported just to collect an API key.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { openmailSetupPlugin } from "./setup.js";

export default defineSetupPluginEntry(openmailSetupPlugin);
