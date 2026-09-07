#!/usr/bin/env node
// Single source of truth for everything OpenClaw reads about this plugin
// before loading it: `openclaw.plugin.json` and the `openclaw` block of
// package.json. Both are derived from the compiled TS (config schema, setup
// contract, channel meta) so the manifest can't drift from the code.
//
//   node scripts/build-manifest.mjs          write both files
//   node scripts/build-manifest.mjs --check  exit 1 if either is stale
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const MANIFEST_PATH = fileURLToPath(new URL("openclaw.plugin.json", root));
const PACKAGE_PATH = fileURLToPath(new URL("package.json", root));

const { openmailChannelConfigSchema } = await import(new URL("dist/config-schema.js", root));
const { OPENMAIL_META, openmailSetupContract } = await import(new URL("dist/setup.js", root));

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const hostVersion = pkg.devDependencies?.openclaw?.replace(/^[^\d]*/, "");
if (!hostVersion) throw new Error("devDependencies.openclaw must pin the OpenClaw version we build against");

const manifest = {
  id: "openmail",
  name: "OpenMail",
  description: pkg.description,
  version: pkg.version,
  activation: { onStartup: false },
  channels: ["openmail"],
  channelConfigs: {
    openmail: {
      label: OPENMAIL_META.label,
      description: "Email for agents. Inbound mail wakes the agent; replies go out in the same thread.",
      schema: openmailChannelConfigSchema.schema,
      uiHints: openmailChannelConfigSchema.uiHints,
    },
  },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  // apiKey may be a SecretRef; the host resolves it before the channel reads it.
  secretInputs: {
    paths: [
      { path: "channels.openmail.apiKey", expected: "string" },
      { path: "channels.openmail.accounts.*.apiKey", expected: "string" },
    ],
  },
  skills: ["skills"],
  cliCommands: [
    {
      name: "openmail",
      description: "OpenMail CLI with the channel's credentials",
      hasSubcommands: false,
    },
  ],
};

const openclawBlock = {
  extensions: ["./dist/index.js"],
  setupEntry: "./dist/setup-entry.js",
  channel: {
    ...OPENMAIL_META,
    // Show the "who may email you" step during quickstart; the default is nobody.
    quickstartAllowFrom: true,
    configuredState: { env: { allOf: ["OPENMAIL_API_KEY"] } },
    setup: { fields: openmailSetupContract.metadata.fields },
  },
  compat: { pluginApi: `>=${hostVersion}`, minGatewayVersion: hostVersion },
  build: { openclawVersion: hostVersion, pluginSdkVersion: hostVersion },
  install: {
    npmSpec: pkg.name,
    defaultChoice: "npm",
    minHostVersion: `>=${hostVersion}`,
    // A bad channels.openmail block must not brick `openclaw doctor`/setup.
    allowInvalidConfigRecovery: true,
  },
};

const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
const nextPackage = `${JSON.stringify({ ...pkg, openclaw: openclawBlock }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let stale = false;
  if (readFileSync(MANIFEST_PATH, "utf8") !== nextManifest) {
    console.error("openclaw.plugin.json is out of date.");
    stale = true;
  }
  if (readFileSync(PACKAGE_PATH, "utf8") !== nextPackage) {
    console.error("package.json#openclaw is out of date.");
    stale = true;
  }
  if (stale) {
    console.error("Run: pnpm manifest");
    process.exit(1);
  }
  console.log("manifest up to date");
} else {
  writeFileSync(MANIFEST_PATH, nextManifest);
  writeFileSync(PACKAGE_PATH, nextPackage);
  console.log("wrote openclaw.plugin.json and package.json#openclaw");
}
