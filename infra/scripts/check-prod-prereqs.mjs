#!/usr/bin/env node
/**
 * Gate for FinlensProdStack deploy (#29).
 *
 * Fails if prerequisite security-phase docs are missing, or if the prod stack
 * path no longer omits DEV_API_KEY / locks CORS to CloudFront.
 *
 * Usage:
 *   node scripts/check-prod-prereqs.mjs
 *   node scripts/check-prod-prereqs.mjs --verify-synth
 *
 * Exit 0 = ready to deploy (caller still decides whether to run cdk deploy).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const infraRoot = join(__dirname, "..");
const repoRoot = join(infraRoot, "..");
const securityDir = join(repoRoot, "docs", "security");

const REQUIRED_DOCS = [
  // #18 CI security gate
  "phase-ci-gate.md",
  "ci-gate.md",
  // #19 Statement data floor
  "phase-statement-data-floor.md",
  // #20 Workspace identity
  "phase-workspace-identity.md",
  // #21 Per-workspace API keys
  "phase-api-keys.md",
  // #23 Per-workspace quotas
  "phase-quotas.md",
  // #29 this phase
  "phase-prod-deploy.md",
];

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function checkDocs() {
  for (const name of REQUIRED_DOCS) {
    const path = join(securityDir, name);
    if (!existsSync(path)) {
      fail(`Missing security prerequisite doc: docs/security/${name}`);
    }
  }
}

function checkBinStage() {
  const binPath = join(infraRoot, "bin", "finlens.ts");
  if (!existsSync(binPath)) {
    fail("Missing infra/bin/finlens.ts");
    return;
  }
  const source = readFileSync(binPath, "utf8");
  if (!/new FinlensStack\(\s*app,\s*"FinlensProdStack"/.test(source)) {
    fail('infra/bin/finlens.ts must declare FinlensProdStack');
  }
  if (!/stage:\s*"prod"/.test(source)) {
    fail('FinlensProdStack must pass stage: "prod"');
  }
}

function checkStackSource() {
  const stackPath = join(infraRoot, "lib", "finlens-stack.ts");
  if (!existsSync(stackPath)) {
    fail("Missing infra/lib/finlens-stack.ts");
    return;
  }
  const source = readFileSync(stackPath, "utf8");

  // DEV_API_KEY may only be injected when stage === "dev"
  if (!/stage\s*===\s*"dev"\s*&&\s*devApiKey\s*\?\s*\{\s*DEV_API_KEY/.test(source)) {
    fail(
      'infra/lib/finlens-stack.ts must gate DEV_API_KEY with stage === "dev" (no shared prod shortcut)',
    );
  }
  if (!/stage\s*===\s*"prod"\s*&&\s*"DEV_API_KEY"\s+in\s+lambdaEnv/.test(source)) {
    fail("infra/lib/finlens-stack.ts must assert DEV_API_KEY is absent when stage is prod");
  }

  // Prod CORS must be CloudFront-only (not "*")
  const normalized = source.replace(/\s+/g, " ");
  const hasProdCloudFrontCors =
    /allowOrigins:\s*stage\s*===\s*"prod"\s*\?\s*\[`https:\/\/\$\{webDistribution\.distributionDomainName\}`\]/.test(
      normalized,
    );
  if (!hasProdCloudFrontCors) {
    fail(
      "Prod CORS allowOrigins must be https://${webDistribution.distributionDomainName} when stage===prod",
    );
  }
}

function checkSynthTemplate() {
  const outDir = join(infraRoot, "cdk.out");
  if (!existsSync(outDir)) {
    fail("cdk.out missing — run `npx cdk synth FinlensProdStack` before --verify-synth");
    return;
  }

  const templates = readdirSync(outDir).filter(
    (name) => name.startsWith("FinlensProdStack") && name.endsWith(".template.json"),
  );
  if (templates.length === 0) {
    fail("No FinlensProdStack*.template.json in cdk.out — synth FinlensProdStack first");
    return;
  }

  for (const name of templates) {
    const template = readFileSync(join(outDir, name), "utf8");
    if (/"DEV_API_KEY"\s*:/.test(template)) {
      fail(`${name} contains DEV_API_KEY — prod must not ship the shared shortcut`);
    }
    // CORS AllowOrigins should not be wildcard for the HTTP API
    if (/"AllowOrigins"\s*:\s*\[\s*"\*"\s*\]/.test(template)) {
      fail(`${name} CORS AllowOrigins is ["*"] — prod must lock to CloudFront`);
    }
  }
}

checkDocs();
checkBinStage();
checkStackSource();

const verifySynth = process.argv.includes("--verify-synth");
if (verifySynth) {
  checkSynthTemplate();
}

for (const message of warnings) {
  console.warn(`WARN: ${message}`);
}

if (errors.length > 0) {
  console.error("Prod deploy prerequisites failed:\n");
  for (const message of errors) {
    console.error(`  ✗ ${message}`);
  }
  console.error(
    "\nSee docs/security/phase-prod-deploy.md. Fix the gaps above before npm run deploy:prod.",
  );
  process.exit(1);
}

console.log("Prod deploy prerequisites OK:");
console.log(`  ✓ Security docs (${REQUIRED_DOCS.length}) present`);
console.log('  ✓ FinlensProdStack stage:"prod"');
console.log("  ✓ DEV_API_KEY gated to stage===dev + prod assertion");
console.log("  ✓ Prod CORS locked to CloudFront origin (source)");
if (verifySynth) {
  console.log("  ✓ Synth template checked (no DEV_API_KEY, no CORS *)");
}
console.log("\nReady to deploy FinlensProdStack (operator must confirm AWS profile / approval).");
process.exit(0);
