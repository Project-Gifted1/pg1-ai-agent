#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const isDryRun = process.argv.includes("--dry-run");

const requirements = {
  VERCEL: ["VERCEL_TOKEN"],
  CLOUDFLARE: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  SUPABASE: ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF"],
};

function findMissing(keys) {
  return keys.filter((key) => !process.env[key]);
}

function run(label, command) {
  console.log(`\n[deploy:auto] ${label}`);
  console.log(`[deploy:auto] ${command}`);
  if (isDryRun) return;

  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

try {
  const missing = Object.entries(requirements)
    .map(([scope, keys]) => ({ scope, missing: findMissing(keys) }))
    .filter((item) => item.missing.length > 0);

  if (missing.length > 0) {
    const lines = missing
      .map((item) => `- ${item.scope}: ${item.missing.join(", ")}`)
      .join("\n");
    throw new Error(`Missing required deployment environment variables:\n${lines}`);
  }

  run("Vercel production deploy", "npx vercel deploy --prod --yes --token \"$VERCEL_TOKEN\"");
  run(
    "Cloudflare Worker deploy",
    "npx wrangler deploy --config wrangler.toml --env production"
  );
  run(
    "Supabase schema push",
    "npx supabase db push --project-ref \"$SUPABASE_PROJECT_REF\""
  );

  console.log("\n[deploy:auto] ✅ completed");
} catch (error) {
  console.error(`\n[deploy:auto] ❌ ${error.message}`);
  process.exit(1);
}
