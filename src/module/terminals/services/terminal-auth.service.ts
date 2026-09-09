import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { findAuthenticatedAccountState } from "../../auth/repository/auth.repository";
import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import {
  repoFindDeviceById,
  repoFindSessionByToken,
  repoOpenSession,
} from "../../production/repository/station.repository";
import type { StationContext } from "../../production/middlewares/station-authorization.middleware";
import {
  pinFingerprint,
  assertSameTerminal,
  terminalModule,
} from "../domain/terminal-policy";
import {
  resolvePin,
  audit,
  type Terminal,
} from "../repository/terminal-auth.repository";

export async function requireModule(userId: number, module: string) {
  const profile = await resolveAccessProfile(userId);
  if (
    !profile ||
    (!profile.is_superadmin &&
      !profile.modules.some((m) => m.module_key === module && m.allowed))
  ) {
    throw new HttpError(
      403,
      "TERMINAL_MODULE_FORBIDDEN",
      "Ce compte n’est pas autorisé pour cette fonction.",
    );
  }
}
export async function identifyTerminal(
  terminal: Terminal,
  pin: string,
  appVersion?: string,
) {
  const result = await resolvePin(
    terminal,
    pinFingerprint(terminal.site_code, pin),
  );
  if (!result.ok)
    throw new HttpError(
      result.locked ? 429 : 401,
      "TERMINAL_PIN_REJECTED",
      result.locked
        ? "Trop de tentatives. Patientez cinq minutes."
        : "Code non reconnu. Réessayez.",
    );
  await requireModule(result.pin.user_id, terminalModule[terminal.kind]);
  const account = await findAuthenticatedAccountState(result.pin.user_id);
  if (!account || account.status !== "Active")
    throw new HttpError(
      403,
      "TERMINAL_ACCOUNT_REJECTED",
      "Compte indisponible.",
    );
  const device = await repoFindDeviceById(terminal.device_id);
  if (
    !device ||
    device.status !== "ACTIVE" ||
    device.machine_id !== terminal.machine_id
  )
    throw new HttpError(
      401,
      "TERMINAL_DEVICE_REJECTED",
      "Terminal indisponible.",
    );
  // The station token is minted only after independent device + PIN proof.
  // PASSWORD is the legacy station category for a server-authenticated account;
  // the terminal audit records the actual factor, PIN, without changing web enums.
  const opened = await repoOpenSession({
    device,
    user_id: result.pin.user_id,
    machine_id: terminal.machine_id,
    identification_method: "PASSWORD",
    app_version: appVersion,
    beforeCommit: async (tx, session) => {
      const live = (
        await tx.query(
          `SELECT t.id FROM public.cerp_terminals t JOIN public.cerp_terminal_pins p ON p.id=$2
        WHERE t.id=$1 AND t.revoked_at IS NULL AND p.revoked_at IS NULL AND p.site_code=t.site_code FOR SHARE OF t,p`,
          [terminal.id, result.pin.id],
        )
      ).rows[0];
      if (!live)
        throw new HttpError(
          401,
          "TERMINAL_SESSION_REVOKED",
          "La tablette ou le code a été révoqué.",
        );
      await tx.query(
        `INSERT INTO public.cerp_terminal_sessions(session_id,terminal_id,pin_id,account_epoch) VALUES($1,$2,$3,$4)`,
        [session.id, terminal.id, result.pin.id, account.session_epoch],
      );
      await audit(tx, terminal.id, result.pin.user_id, "PIN_SESSION_OPENED", {
        session_id: session.id,
      });
    },
  });
  return {
    session_token: opened.token,
    session_id: opened.session.id,
    expires_at: opened.session.expires_at.toISOString(),
    auto_lock_seconds: device.auto_lock_seconds,
    user: {
      id: result.pin.user_id,
      display_name:
        [result.pin.name, result.pin.surname].filter(Boolean).join(" ") ||
        result.pin.username,
    },
  };
}
export async function authenticateTerminalSession(
  terminal: Terminal,
  token: string,
): Promise<StationContext> {
  const found = await repoFindSessionByToken(token);
  if (!found)
    throw new HttpError(
      401,
      "TERMINAL_SESSION_REQUIRED",
      "Saisissez votre code personnel.",
    );
  assertSameTerminal(terminal.device_id, found.session.device_id);
  const binding = (
    await pool.query<{
      terminal_id: string;
      account_epoch: string;
      valid: boolean;
    }>(
      `SELECT s.terminal_id,s.account_epoch::text,
    (p.revoked_at IS NULL AND s.last_input_at>now()-make_interval(secs=>$2) AND p.site_code=$3) AS valid
    FROM public.cerp_terminal_sessions s JOIN public.cerp_terminal_pins p ON p.id=s.pin_id WHERE s.session_id=$1`,
      [found.session.id, terminal.auto_lock_seconds, terminal.site_code],
    )
  ).rows[0];
  assertSameTerminal(terminal.id, binding?.terminal_id);
  if (
    !binding?.valid ||
    found.session.state !== "ACTIVE" ||
    found.session.expires_at.getTime() <= Date.now() ||
    found.device.status !== "ACTIVE" ||
    found.session.machine_id !== terminal.machine_id
  ) {
    throw new HttpError(
      401,
      "TERMINAL_SESSION_LOCKED",
      "Session verrouillée. Saisissez votre code.",
    );
  }
  const account = await findAuthenticatedAccountState(found.user.id);
  if (
    !account ||
    account.status !== "Active" ||
    account.session_epoch !== Number(binding.account_epoch)
  )
    throw new HttpError(
      401,
      "TERMINAL_ACCOUNT_REJECTED",
      "Une nouvelle identification est nécessaire.",
    );
  try {
    await requireModule(found.user.id, terminalModule[terminal.kind]);
  } catch {
    throw new HttpError(
      401,
      "TERMINAL_SESSION_ACCESS_REVOKED",
      "L’accès au poste a été révoqué.",
    );
  }
  return {
    session_id: found.session.id,
    device_id: terminal.device_id,
    device_code: terminal.public_code,
    device_zone: found.device.workshop_zone,
    device_assignment_mode: found.device.assignment_mode,
    machine_id: terminal.machine_id,
    user: found.user,
    auto_lock_seconds: terminal.auto_lock_seconds,
  };
}
export async function assertTerminalAdmin(userId: number, credentials = false) {
  const user = (
    await pool.query(
      `SELECT role,is_superadmin FROM public.users WHERE id=$1 AND status='Active'`,
      [userId],
    )
  ).rows[0];
  const allowed =
    user?.is_superadmin === true ||
    (credentials ? /admin|direct/i : /admin|direct|method|méthod/i).test(
      user?.role ?? "",
    );
  if (!allowed)
    throw new HttpError(
      403,
      "TERMINAL_ADMIN_REQUIRED",
      "Cette action est réservée à l’administration des terminaux.",
    );
}
