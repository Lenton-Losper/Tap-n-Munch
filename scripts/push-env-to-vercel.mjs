/**
 * Push local env file to the linked Vercel project (CLI must be logged in).
 *
 * Usage:
 *   npm run vercel:env:push
 *   node scripts/push-env-to-vercel.mjs --production-only
 *   node scripts/push-env-to-vercel.mjs --with-development
 *
 * Reads `.env.local` if present, else `.env`.
 * By default sets **production** and **preview**. Secrets (non-NEXT_PUBLIC_) use --sensitive.
 * Existing keys are overwritten (--force).
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { parse } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const productionOnly = process.argv.includes("--production-only");
const withDevelopment = process.argv.includes("--with-development");

let targets = ["production", "preview"];
if (productionOnly) targets = ["production"];
if (withDevelopment) targets = ["production", "preview", "development"];

const envPath = existsSync(join(root, ".env.local"))
  ? join(root, ".env.local")
  : join(root, ".env");

if (!existsSync(envPath)) {
  console.error("No .env.local or .env found in project root.");
  process.exit(1);
}

const parsed = parse(readFileSync(envPath));

/**
 * Vercel often mangles JSON in env; base64 is one line and reliable.
 * - From JSON: compact + derive B64
 * - From B64 only: ensure JSON var is refreshed from decoded object (optional)
 */
if (parsed.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const obj = JSON.parse(parsed.FIREBASE_SERVICE_ACCOUNT_JSON);
    const compact = JSON.stringify(obj);
    parsed.FIREBASE_SERVICE_ACCOUNT_JSON = compact;
    parsed.FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from(compact, "utf8").toString(
      "base64",
    );
    console.log(
      "Normalized FIREBASE_SERVICE_ACCOUNT_JSON + FIREBASE_SERVICE_ACCOUNT_B64.",
    );
  } catch (e) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON in .env.local is not valid JSON — use FIREBASE_SERVICE_ACCOUNT_B64 only, or fix the file:",
      e?.message || e,
    );
  }
} else if (parsed.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    const json = Buffer.from(
      parsed.FIREBASE_SERVICE_ACCOUNT_B64.trim(),
      "base64",
    ).toString("utf8");
    const compact = JSON.stringify(JSON.parse(json));
    parsed.FIREBASE_SERVICE_ACCOUNT_JSON = compact;
    parsed.FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from(compact, "utf8").toString(
      "base64",
    );
    console.log(
      "Decoded FIREBASE_SERVICE_ACCOUNT_B64 → compact JSON + B64 for Vercel.",
    );
  } catch (e) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_B64 in .env.local is invalid:",
      e?.message || e,
    );
  }
}

const keys = Object.keys(parsed).filter((k) => k && !k.startsWith("#"));

if (keys.length === 0) {
  console.error("No variables parsed from", envPath);
  process.exit(1);
}

console.log(`Using ${envPath} (${keys.length} keys) → Vercel: ${targets.join(", ")}`);

let failures = 0;

/** Windows: spawnSync + stdin `input` breaks for npx (EINVAL). Use temp file + shell redirect. */
function vercelEnvAdd(key, value, environment, sensitive) {
  const tmp = join(
    tmpdir(),
    `vc-env-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  writeFileSync(tmp, value, "utf8");
  try {
    const sens = sensitive ? " --sensitive" : "";
    const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const cmd = `npx vercel env add ${q(key)} ${environment} --force -y${sens} < ${q(tmp)}`;
    execSync(cmd, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: true,
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

for (const key of keys) {
  const value = parsed[key];
  if (value === undefined || value === "") {
    console.warn(`Skip empty: ${key}`);
    continue;
  }

  const sensitive = !key.startsWith("NEXT_PUBLIC_");

  for (const environment of targets) {
    const ok = vercelEnvAdd(key, value, environment, sensitive);
    if (!ok) {
      console.error(`FAILED: ${key} (${environment})`);
      failures += 1;
    } else {
      console.log(`OK: ${key} (${environment})`);
    }
  }
}

if (failures > 0) {
  console.error(`\nCompleted with ${failures} error(s). Is \`vercel link\` set and are you logged in?`);
  process.exit(1);
}

console.log("\nDone. Redeploy on Vercel (or trigger a new deployment) so builds pick up new values.");
