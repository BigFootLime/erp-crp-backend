import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationUrl = process.env.GED_AUTHORITATIVE_EVENTS_634_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const root = process.cwd();
const base = "20260823_ged_authoritative_pdf_access_events_634";
const oldEvents = [
  "UPLOAD", "READ", "DOWNLOAD", "SUBMIT", "APPROVE", "REJECT", "PUBLISH", "OBSOLETE", "ARCHIVE", "CHECKOUT", "CHECKIN",
  "HOLD_PLACED", "HOLD_RELEASED", "INTEGRITY_FAILURE", "SCAN_PENDING", "SCAN_CLEAN", "SCAN_INFECTED", "SCAN_FAILED",
  "QUARANTINED", "QUARANTINE_RELEASED", "QUARANTINE_DELETED",
];
const newEvents = [
  "AUTHORITATIVE_PDF_ARCHIVED", "AUTHORITATIVE_PDF_PREVIEWED", "AUTHORITATIVE_PDF_DOWNLOADED",
  "AUTHORITATIVE_PDF_PRINT_INTENT", "AUTHORITATIVE_PDF_SENT", "CREATION_SNAPSHOT_ARCHIVED",
];

suite("#634 GED authoritative-PDF audit events: PostgreSQL migration", () => {
  let client: import("pg").Client;
  let patch: string;
  let preflight: string;
  let verify: string;
  let rollback: string;

  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.Client({ connectionString: integrationUrl });
    await client.connect();
    const database = await client.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("GED_AUTHORITATIVE_EVENTS_634_TEST_DATABASE_URL must target a test/local/sandbox database");
    }
    [patch, preflight, verify, rollback] = await Promise.all([
      fs.readFile(path.join(root, "db", "patches", `${base}.sql`), "utf8"),
      fs.readFile(path.join(root, "db", "patches", "support", `${base}.preflight.sql`), "utf8"),
      fs.readFile(path.join(root, "db", "patches", "support", `${base}.verify.sql`), "utf8"),
      fs.readFile(path.join(root, "db", "patches", "support", `${base}.rollback.sql`), "utf8"),
    ]);
  });

  afterAll(async () => { await client?.end(); });

  it("applies and replays without losing legacy evidence, accepts all six source events, rejects unknown values, and restores the SOL-11 constraint on safe rollback", async () => {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(`
      CREATE TABLE public.ged_access_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_type text NOT NULL);
      ALTER TABLE public.ged_access_events ADD CONSTRAINT ged_access_events_event_type_check CHECK (event_type IN (${oldEvents.map((event) => `'${event}'`).join(", ")}));
      INSERT INTO public.ged_access_events(event_type) VALUES ('SCAN_CLEAN'), ('QUARANTINED');
    `);

    await expect(client.query(preflight)).resolves.toBeDefined();
    await client.query(patch);
    await client.query(patch); // SQL itself is safe if a rehearsal invokes it again.
    await expect(client.query(verify)).resolves.toBeDefined();
    expect((await client.query("SELECT event_type FROM public.ged_access_events ORDER BY id")).rows.map((row) => row.event_type)).toEqual(["SCAN_CLEAN", "QUARANTINED"]);

    for (const event of newEvents) await expect(client.query("INSERT INTO public.ged_access_events(event_type) VALUES ($1)", [event])).resolves.toBeDefined();
    await expect(client.query("INSERT INTO public.ged_access_events(event_type) VALUES ('UNRECOGNIZED_AUDIT_EVENT')")).rejects.toMatchObject({ code: "23514" });

    await client.query("SET cerp.migration_rehearsal = '1'");
    await expect(client.query(rollback)).rejects.toMatchObject({ message: expect.stringContaining("GED_AUTHORITATIVE_EVENTS_634_ROLLBACK_REFUSED_AUTHORITATIVE_EVIDENCE_EXISTS") });
    await client.query("DELETE FROM public.ged_access_events WHERE event_type = ANY($1::text[])", [newEvents]);
    await client.query(rollback);
    for (const event of oldEvents) await expect(client.query("INSERT INTO public.ged_access_events(event_type) VALUES ($1)", [event])).resolves.toBeDefined();
    await expect(client.query("INSERT INTO public.ged_access_events(event_type) VALUES ('AUTHORITATIVE_PDF_ARCHIVED')")).rejects.toMatchObject({ code: "23514" });
  });
});
