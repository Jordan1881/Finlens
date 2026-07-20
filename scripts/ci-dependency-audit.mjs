#!/usr/bin/env node
/**
 * Fail CI on high/critical npm advisories, with a narrow allowlist for
 * known transitive noise that cannot be overridden (bundled deps).
 *
 * Allowlist entries must include residual-risk notes in docs/security/ci-gate.md.
 */
import { execSync } from "node:child_process";

/** @type {Record<string, { reason: string }>} */
const ALLOWLIST = {
  // aws-cdk-lib ships brace-expansion@5.0.6 inside its bundle (`inBundle: true`);
  // npm overrides cannot replace it. Harmless for Finlens (CDK synth/deploy only).
  "GHSA-3jxr-9vmj-r5cp": {
    reason: "Bundled inside aws-cdk-lib; upgrade when CDK republishes with >=5.0.7",
  },
};

let report;
try {
  execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  report = { vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } };
} catch (error) {
  const stdout = error.stdout?.toString?.() ?? "";
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error("npm audit did not return JSON");
    process.exit(1);
  }
}

const blockers = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") {
    continue;
  }
  const vias = Array.isArray(vuln.via) ? vuln.via : [];
  const ghsaIds = vias
    .filter((v) => typeof v === "object" && v && typeof v.url === "string")
    .map((v) => {
      const match = /GHSA-[\w-]+/.exec(v.url);
      return match?.[0];
    })
    .filter(Boolean);

  const allAllowed =
    ghsaIds.length > 0 && ghsaIds.every((id) => Object.hasOwn(ALLOWLIST, id));
  if (allAllowed) {
    console.log(
      `allowlisted ${name} (${ghsaIds.join(", ")}): ${ALLOWLIST[ghsaIds[0]].reason}`,
    );
    continue;
  }
  blockers.push({ name, severity: vuln.severity, ghsaIds, range: vuln.range });
}

if (blockers.length > 0) {
  console.error("High/critical advisories blocking CI:");
  for (const b of blockers) {
    console.error(`- ${b.name} [${b.severity}] ${b.ghsaIds.join(" ") || ""} range=${b.range}`);
  }
  process.exit(1);
}

console.log("Dependency audit gate passed (high/critical clear after allowlist).");
