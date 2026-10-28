// Host discovery seam: OpenClaw loads `dist/secret-contract-api.js` from an
// external plugin's root to learn which config paths may hold SecretRefs
// *without* starting the plugin. Command-scoped resolution (`openclaw openmail
// -- ...`, `openclaw secrets audit`) only knows about `channels.openmail.*.apiKey`
// through this file; the gateway learns the same from `registerChannel`.
export { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
