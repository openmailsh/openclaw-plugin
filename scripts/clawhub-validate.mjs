#!/usr/bin/env node
// Run ClawHub's Plugin Inspector on the built package and fail on any
// finding. `clawhub package validate` exits 0 on warnings, and a warning is
// exactly what shows up on the public listing, so treat them as errors here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "clawhub-validate-"));
try {
  const run = spawnSync(
    "npx",
    ["-y", "clawhub@latest", "package", "validate", ".", "--no-input", "--json", "--out", out],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    process.exit(run.status ?? 1);
  }
  const report = JSON.parse(readFileSync(path.join(out, "plugin-inspector-report.json"), "utf8"));
  const issues = report.issues ?? [];
  if (report.status !== "pass" || issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.severity ?? "issue"} ${issue.code}: ${issue.title ?? issue.summary ?? ""}`);
    }
    console.error(`clawhub validate: status ${report.status}, ${issues.length} issue(s)`);
    process.exit(1);
  }
  console.log("clawhub validate: no findings");
} finally {
  rmSync(out, { recursive: true, force: true });
}
