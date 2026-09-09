import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  newDeviceToken,
  newPairingCode,
  tokenHash,
  type TerminalKind,
} from "../domain/terminal-policy";
export type Db = Pick<PoolClient, "query">;
export type Terminal = {
  id: string;
  device_id: string;
  kind: TerminalKind;
  site_code: string;
  machine_id: string | null;
  warehouse_id: string | null;
  label: string;
  public_code: string;
  machine_code: string;
  machine_name: string;
  auto_lock_seconds: number;
  session_max_seconds: number;
  scanner_prefix: string;
  scanner_suffix: string;
};
const SELECT_TERMINAL = `SELECT t.id,t.device_id,t.kind,t.site_code,t.warehouse_id,t.scanner_prefix,t.scanner_suffix,t.paired_at,t.revoked_at,
 d.machine_id,d.label,d.public_code,d.auto_lock_seconds,d.session_max_seconds,m.code AS machine_code,m.name AS machine_name
 FROM public.cerp_terminals t JOIN public.production_devices d ON d.id=t.device_id
 LEFT JOIN public.machines m ON m.id=d.machine_id`;
export async function transaction<T>(
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function audit(
  tx: Db,
  terminal: string | null,
  actor: number | null,
  event: string,
  detail: Record<string, unknown> = {},
) {
  await tx.query(
    "INSERT INTO public.cerp_terminal_audit(terminal_id,actor_id,event,detail) VALUES($1,$2,$3,$4::jsonb)",
    [terminal, actor, event, JSON.stringify(detail)],
  );
}
export async function findTerminal(token: string) {
  const r = await pool.query<Terminal>(
    `${SELECT_TERMINAL} WHERE t.device_token_hash=$1 AND t.revoked_at IS NULL AND d.status='ACTIVE' AND (m.id IS NULL OR m.archived_at IS NULL)`,
    [tokenHash(token)],
  );
  if (!r.rows[0])
    throw new HttpError(
      401,
      "TERMINAL_DEVICE_REJECTED",
      "Terminal non reconnu ou révoqué.",
    );
  return r.rows[0];
}
export async function listTerminals() {
  return (await pool.query(`${SELECT_TERMINAL} ORDER BY d.public_code`)).rows;
}
export async function terminalAdminOptions() {
  const [machines, users, warehouses] = await Promise.all([
    pool.query(
      "SELECT id::text,code,name FROM public.machines WHERE archived_at IS NULL ORDER BY code",
    ),
    pool.query(
      "SELECT id,username,name,surname FROM public.users WHERE status='Active' ORDER BY surname,name,username",
    ),
    pool.query('SELECT id::text,COALESCE(code,code_magasin) AS code,COALESCE(name,code,code_magasin) AS name FROM public.magasins ORDER BY 2'),
  ]);
  return { machines: machines.rows, users: users.rows, warehouses:warehouses.rows };
}
export async function updateTerminalSettings(
  id: string,
  body: { machine_id: string|null; warehouse_id?:string|null; scanner_prefix: string; scanner_suffix: string },
  actor: number,
) {
  return transaction(async (tx) => {
    const t = (
      await tx.query(
        "SELECT device_id,kind,warehouse_id FROM public.cerp_terminals WHERE id=$1 AND revoked_at IS NULL FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!t)
      throw new HttpError(404, "TERMINAL_NOT_FOUND", "Terminal introuvable.");
    if(t.kind==='OPERATOR'&&!body.machine_id)throw new HttpError(422,'TERMINAL_MACHINE_REQUIRED','Choisissez une machine pour le poste opérateur.');
    if(['RECEPTION','OF_PROCUREMENT'].includes(t.kind)&&body.machine_id)throw new HttpError(422,'TERMINAL_SITE_ASSIGNMENT','Ce terminal est rattaché au site et au magasin.');
    if(body.warehouse_id&&!(await tx.query('SELECT id FROM public.magasins WHERE id=$1::uuid',[body.warehouse_id])).rows.length)
      throw new HttpError(422,'TERMINAL_WAREHOUSE_UNKNOWN','Choisissez un magasin existant.');
    if (
      body.machine_id&&! (
        await tx.query(
          "SELECT id FROM public.machines WHERE id=$1 AND archived_at IS NULL FOR SHARE",
          [body.machine_id],
        )
      ).rowCount
    )
      throw new HttpError(404, "MACHINE_NOT_FOUND", "Machine introuvable.");
    await tx.query(
      "UPDATE public.production_devices SET machine_id=$2 WHERE id=$1",
      [t.device_id, body.machine_id],
    );
    await tx.query(
      "UPDATE public.cerp_terminals SET scanner_prefix=$2,scanner_suffix=$3,warehouse_id=$4::uuid WHERE id=$1",
      [id, body.scanner_prefix, body.scanner_suffix,body.warehouse_id===undefined?t.warehouse_id:body.warehouse_id],
    );
    await tx.query(
      "UPDATE public.operator_device_sessions SET state='CLOSED',closed_at=now(),close_reason='TERMINAL_SETTINGS_CHANGED' WHERE device_id=$1 AND state IN('ACTIVE','LOCKED')",
      [t.device_id],
    );
    await audit(tx, id, actor, "SETTINGS_CHANGED", body);
  });
}
export async function touchTerminalSession(sessionId: string) {
  await pool.query(
    "UPDATE public.cerp_terminal_sessions SET last_input_at=now() WHERE session_id=$1",
    [sessionId],
  );
}
export async function closeTerminalSession(
  sessionId: string,
  terminalId: string,
  actor: number,
) {
  return transaction(async (tx) => {
    await tx.query(
      "UPDATE public.operator_device_sessions SET state='CLOSED',closed_at=now(),close_reason='USER' WHERE id=$1",
      [sessionId],
    );
    await audit(tx, terminalId, actor, "SESSION_CLOSED");
  });
}
export async function isSiteOperator(site: string, userId: number) {
  return !!(
    await pool.query(
      `SELECT p.user_id FROM public.cerp_terminal_pins p JOIN public.users u ON u.id=p.user_id
    WHERE p.site_code=$1 AND p.user_id=$2 AND p.revoked_at IS NULL AND u.status='Active'`,
      [site, userId],
    )
  ).rowCount;
}
export async function hasProductionReceipt(db: Db, key: string) {
  return !!(
    await db.query(
      "SELECT 1 FROM public.production_execution_idempotency WHERE idempotency_key=$1",
      [key],
    )
  ).rowCount;
}
export async function createPairing(tx: Db, id: string, actor: number) {
  const code = newPairingCode();
  await tx.query(
    "UPDATE public.cerp_terminal_pairings SET consumed_at=now() WHERE terminal_id=$1 AND consumed_at IS NULL",
    [id],
  );
  await tx.query(
    `INSERT INTO public.cerp_terminal_pairings(token_hash,terminal_id,expires_at,created_by) VALUES($1,$2,now()+interval '15 minutes',$3)`,
    [tokenHash(code), id, actor],
  );
  await audit(tx, id, actor, "PAIRING_CREATED");
  return { code, expires_in_seconds: 900 };
}
export async function enrollTerminal(
  body: { kind: TerminalKind; site_code: string; warehouse_id?:string|null },
  deviceId: string,
  actor: number,
) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `INSERT INTO public.cerp_terminals(device_id,kind,site_code,created_by,warehouse_id) VALUES($1,$2,$3,$4,$5::uuid) RETURNING id`,
        [deviceId, body.kind, body.site_code, actor,body.warehouse_id??null],
      )
    ).rows[0];
    return {
      terminal_id: row.id as string,
      ...(await createPairing(tx, row.id, actor)),
    };
  });
}
export async function pairTerminal(code: string, kind: TerminalKind) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `SELECT p.terminal_id FROM public.cerp_terminal_pairings p
      JOIN public.cerp_terminals t ON t.id=p.terminal_id JOIN public.production_devices d ON d.id=t.device_id
      WHERE p.token_hash=$1 AND p.consumed_at IS NULL AND p.expires_at>now() AND t.revoked_at IS NULL
      AND d.status='ACTIVE' AND t.kind=$2 FOR UPDATE OF p,t,d`,
        [tokenHash(code.toUpperCase()), kind],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        401,
        "TERMINAL_PAIRING_REJECTED",
        "Code d’appairage invalide, expiré ou déjà utilisé.",
      );
    const token = newDeviceToken();
    await tx.query(
      "UPDATE public.cerp_terminal_pairings SET consumed_at=now() WHERE token_hash=$1",
      [tokenHash(code.toUpperCase())],
    );
    await tx.query(
      "UPDATE public.cerp_terminals SET device_token_hash=$2,paired_at=now() WHERE id=$1",
      [row.terminal_id, tokenHash(token)],
    );
    await tx.query(
      `UPDATE public.operator_device_sessions SET state='CLOSED',closed_at=now(),close_reason='TERMINAL_REPAIRED' WHERE id IN(SELECT session_id FROM public.cerp_terminal_sessions WHERE terminal_id=$1) AND state IN('ACTIVE','LOCKED')`,
      [row.terminal_id],
    );
    await audit(tx, row.terminal_id, null, "PAIRED");
    return { terminal_id: row.terminal_id, device_token: token };
  });
}
// Counters and lookup share a transaction. Failures are returned, not thrown,
// so a rollback cannot accidentally erase the rate limit.
export async function resolvePin(terminal: Terminal, hash: string) {
  return transaction(async (tx) => {
    const buckets = [
      { key: `site:${terminal.site_code}`, limit: 50 },
      { key: `terminal:${terminal.id}`, limit: 5 },
    ];
    for (const b of buckets) {
      await tx.query(
        `INSERT INTO public.cerp_terminal_rate_limits(bucket) VALUES($1) ON CONFLICT DO NOTHING`,
        [b.key],
      );
      const r = (
        await tx.query(
          `SELECT locked_until>now() AS locked FROM public.cerp_terminal_rate_limits WHERE bucket=$1 FOR UPDATE`,
          [b.key],
        )
      ).rows[0];
      if (r.locked) return { ok: false as const, locked: true };
      await tx.query(
        `UPDATE public.cerp_terminal_rate_limits SET attempts=0,window_start=now(),locked_until=NULL WHERE bucket=$1 AND window_start<now()-interval '5 minutes'`,
        [b.key],
      );
    }
    const pin = (
      await tx.query<{
        id: string;
        user_id: number;
        role: string;
        username: string;
        name: string | null;
        surname: string | null;
      }>(
        `SELECT p.id,p.user_id,u.role,u.username,u.name,u.surname
      FROM public.cerp_terminal_pins p JOIN public.users u ON u.id=p.user_id
      WHERE p.site_code=$1 AND p.pin_hash=$2 AND p.revoked_at IS NULL AND u.status='Active' FOR SHARE OF p,u`,
        [terminal.site_code, hash],
      )
    ).rows[0];
    if (!pin) {
      for (const b of buckets)
        await tx.query(
          `UPDATE public.cerp_terminal_rate_limits SET attempts=attempts+1,
        locked_until=CASE WHEN attempts+1 >= $2 THEN now()+interval '5 minutes' ELSE locked_until END WHERE bucket=$1`,
          [b.key, b.limit],
        );
      await audit(tx, terminal.id, null, "PIN_REJECTED");
      return { ok: false as const, locked: false };
    }
    await tx.query(
      "UPDATE public.cerp_terminal_rate_limits SET attempts=0,locked_until=NULL WHERE bucket=$1",
      [`terminal:${terminal.id}`],
    );
    return { ok: true as const, pin };
  });
}
export async function setPin(
  site: string,
  userId: number,
  hash: string,
  actor: number,
) {
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `terminal-pins:${site}`,
    ]);
    const user = (
      await tx.query(
        `SELECT id FROM public.users WHERE id=$1 AND status='Active' FOR SHARE`,
        [userId],
      )
    ).rows[0];
    if (!user)
      throw new HttpError(
        404,
        "TERMINAL_USER_UNAVAILABLE",
        "Utilisateur actif introuvable.",
      );
    const taken = (
      await tx.query(
        `SELECT id FROM public.cerp_terminal_pins WHERE site_code=$1 AND pin_hash=$2 AND user_id<>$3 AND revoked_at IS NULL`,
        [site, hash, userId],
      )
    ).rows[0];
    if (taken)
      throw new HttpError(
        409,
        "TERMINAL_PIN_TAKEN",
        "Ce code est déjà attribué sur ce site.",
      );
    if((await tx.query('SELECT id FROM public.cerp_terminal_pins WHERE site_code=$1 AND user_id=$2 AND pin_hash=$3 AND revoked_at IS NULL',[site,userId,hash])).rows.length)return;
    await tx.query(
      "UPDATE public.cerp_terminal_pins SET revoked_at=now() WHERE site_code=$1 AND user_id=$2 AND revoked_at IS NULL",
      [site, userId],
    );
    await tx.query(
      "INSERT INTO public.cerp_terminal_pins(site_code,user_id,pin_hash,created_by) VALUES($1,$2,$3,$4)",
      [site, userId, hash, actor],
    );
    await audit(tx, null, actor, "PIN_REPLACED", {
      site_code: site,
      subject_user_id: userId,
    });
  });
}
export async function revokePin(site: string, userId: number, actor: number) {
  return transaction(async (tx) => {
    await tx.query(
      "UPDATE public.cerp_terminal_pins SET revoked_at=now() WHERE site_code=$1 AND user_id=$2 AND revoked_at IS NULL",
      [site, userId],
    );
    await audit(tx, null, actor, "PIN_REVOKED", {
      site_code: site,
      subject_user_id: userId,
    });
  });
}
export async function revokeTerminal(
  id: string,
  actor: number,
  reason: string,
) {
  return transaction(async (tx) => {
    const r = await tx.query(
      "UPDATE public.cerp_terminals SET revoked_at=now(),device_token_hash=NULL WHERE id=$1 AND revoked_at IS NULL RETURNING device_id",
      [id],
    );
    if (!r.rows[0])
      throw new HttpError(
        404,
        "TERMINAL_NOT_FOUND",
        "Terminal introuvable ou déjà révoqué.",
      );
    await tx.query(
      `UPDATE public.operator_device_sessions SET state='REVOKED',closed_at=now(),close_reason='TERMINAL_REVOKED' WHERE device_id=$1 AND state IN('ACTIVE','LOCKED')`,
      [r.rows[0].device_id],
    );
    await audit(tx, id, actor, "REVOKED", { reason });
  });
}
