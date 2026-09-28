#!/usr/bin/env node
/* eslint-disable no-console */

// Creates only the explicit public-demo account. It refuses every database
// except cerp_demo and never embeds a password in source control.
const bcrypt = require("bcryptjs");
const { Client } = require("pg");

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function assertDemoDatabase(url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cerp_demo") throw new Error("Refusing to seed a database other than cerp_demo");
}

async function main() {
  if (process.env.CERP_DEMO_MODE !== "true") throw new Error("CERP_DEMO_MODE=true is required");
  const databaseUrl = required("DATABASE_URL");
  assertDemoDatabase(databaseUrl);
  const password = required("DEMO_SEED_PASSWORD");
  const username = (process.env.DEMO_SEED_USERNAME || "DEMO").trim().toUpperCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO public.users (username, password, name, surname, email, role, status, is_superadmin)
       VALUES ($1, $2, 'Visiteur', 'Démo', $3, 'Directeur', 'Active', false)
       ON CONFLICT (username) DO UPDATE
       SET password = EXCLUDED.password, name = EXCLUDED.name, surname = EXCLUDED.surname,
           email = EXCLUDED.email, role = EXCLUDED.role, status = EXCLUDED.status,
           is_superadmin = false`,
      [username, passwordHash, `${username.toLowerCase()}@example.test`]
    );
    console.log("Demo account seeded.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Demo seed failed");
  process.exitCode = 1;
});
