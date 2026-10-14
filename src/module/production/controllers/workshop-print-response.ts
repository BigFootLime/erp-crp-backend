import { createHash } from "node:crypto";
import type { Response } from "express";
import pool from "../../../config/database";

/** The connected pool identifies Test/Prod; never echo a renderer's header.
 * This digest covers the entire delivered packet, not only its OF annex. */
export async function printResponseContext() {
  const result = await pool.query<{ database: string }>("SELECT current_database() AS database");
  return result.rows[0]?.database ?? "unknown";
}
export function setWorkshopPrintHeaders(res: Response, database: string, actorId: number, intentId: string, copy: string | null, pdf: Buffer) {
  res.setHeader("X-Print-Intent-Id", intentId);
  res.setHeader("X-Print-Copy", copy ?? "ORIGINAL");
  res.setHeader("X-Print-Database", database);
  res.setHeader("X-Print-Actor-Id", String(actorId));
  res.setHeader("X-Print-SHA256", createHash("sha256").update(pdf).digest("hex"));
}
