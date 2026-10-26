import { createHmac } from "node:crypto";
import type { Express, Request, Response, RequestHandler } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { HttpError } from "../utils/httpError";
import {
  validateDirectorySession,
  createDirectorySessionFromIdentity,
} from "./session.repository";
import type { DirectorySession } from "./model";
import {
  listAccessibleBusinessCompanies,
  lockSwitch,
  readSwitchState,
  switchHash,
} from "./business-company-switch.repository";
import { createHash } from "node:crypto";
import { companyPolicyReplyMac } from "./company-policy-signature";
import { COMMERCIAL_COMPANY_MODULE_KEYS } from "../module/entreprises/domain/company-context";

type Wrap = (
  work: (req: Request, res: Response) => Promise<void>,
) => RequestHandler;
const session = z.string().regex(/^dir_[a-f0-9]{64}$/),
  key = z.string().uuid();
const body = z
  .object({ directory_session: session, input: z.unknown() })
  .strict();
export const businessCompanyContextSnapshotSchema = z
  .object({
    company: z
      .object({
        id: z.string().uuid(),
        code: z.string(),
        name: z.string(),
        status: z.literal("ACTIVE"),
        profile: z.enum(["COMMERCIAL", "INDUSTRIAL"]),
        enabled_module_keys: z.array(z.string()),
        enabled_commercial_projection_capabilities: z.array(z.string()),
      })
      .strict(),
    membership: z
      .object({
        central_account_id: z.number().int().positive(),
        directory_profile_id: z.string().uuid(),
        company_id: z.string().uuid(),
        status: z.literal("ACTIVE"),
        denied_module_keys: z.array(z.string()),
        enabled_commercial_projection_capabilities: z.array(z.string()),
      })
      .strict(),
    instance: z
      .object({
        company_id: z.string().uuid(),
        environment: z.enum(["cerp_prod", "cerp_test"]),
        site_id: z.string(),
        active: z.literal(true),
      })
      .strict(),
  })
  .strict();
export const businessCompanyListSchema = z
  .object({
    environment: z.enum(["cerp_prod", "cerp_test"]),
    companies: z.array(
      z
        .object({
          id: z.string().uuid(),
          code: z.string(),
          name: z.string(),
          profile: z.enum(["COMMERCIAL", "INDUSTRIAL"]),
        })
        .strict(),
    ),
  })
  .strict();
const callerEnvironment = (site: string): "cerp_prod" | "cerp_test" =>
  site === "cerp_prod" || site.endsWith("_prod") ? "cerp_prod" : "cerp_test";
const reject = (code: string, status = 403): never => {
  throw new HttpError(status, code, "Votre accès doit être vérifié à nouveau.");
};
const deterministicTicket = (
  secret: string,
  sourceHash: string,
  k: string,
  target: string,
  environment: string,
) =>
  createHmac("sha256", secret)
    .update(
      `directory-business-company-ticket-v1\n${sourceHash}\n${k}\n${target}\n${environment}`,
    )
    .digest("hex");
const deterministicToken = (
  secret: string,
  t: string,
  k: string,
  target: string,
) =>
  `dir_${createHmac("sha256", secret).update(`directory-business-company-switch-v1\n${t}\n${k}\n${target}`).digest("hex")}`;
const switchCreateDto = (
  ticket: string,
  companyId: string,
  environment: string,
  expiresAt: string,
) => ({
  ticket,
  target_company_id: companyId,
  environment,
  expires_at: new Date(expiresAt).toISOString(),
});

export function mountDirectoryBusinessCompanies(
  app: Express,
  db: Pool,
  wrap: Wrap,
  options: {
    enabled: boolean;
    sourceJwtSecret: string;
    directoryId?: string;
    keys?: () => Promise<ReadonlyMap<string, string>>;
  },
) {
  if (!options.enabled) return;
  app.post(
    "/internal/directory/business-company-policy",
    wrap(async (req, res) => {
      const parsed = body.parse(req.body);
      z.object({}).strict().parse(parsed.input);
      const actor = await validateDirectorySession(
        db,
        req.directoryCaller!,
        parsed.directory_session,
        { autoProvisionTestMembership: false },
      );
      const environment = callerEnvironment(req.directoryCaller!);
      const row = (
        await db.query<any>(
          `SELECT c.company_id::text,c.profile,c.version AS company_version,m.version AS membership_version,i.version AS instance_version,
          c.enabled_module_keys,m.allowed_module_keys,m.denied_module_keys,i.site_id,i.environment
         FROM public.cerp_business_companies c JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id
         JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id AND i.environment=$2
         WHERE m.profile_id=$1::uuid AND i.site_id=$3 AND c.status='ACTIVE' AND m.status='ACTIVE' AND i.active`,
          [actor.profile_id, environment, req.directoryCaller!],
        )
      ).rows[0];
      if (!row) reject("BUSINESS_COMPANY_ACCESS_DENIED");
      const commercial = new Set<string>(COMMERCIAL_COMPANY_MODULE_KEYS);
      const modules = (row.enabled_module_keys as string[]).filter(
        (key) =>
          (row.allowed_module_keys as string[]).includes(key) &&
          !(row.denied_module_keys as string[]).includes(key) &&
          (row.profile !== "COMMERCIAL" || commercial.has(key)),
      );
      const data = {
        authority_id: options.directoryId,
        profile_id: actor.profile_id,
        company_id: row.company_id,
        environment: row.environment,
        target_site: row.site_id,
        company_version: Number(row.company_version),
        membership_version: Number(row.membership_version),
        instance_version: Number(row.instance_version),
        modules,
      };
      if (
        !data.authority_id ||
        ![
          data.company_version,
          data.membership_version,
          data.instance_version,
        ].every(Number.isSafeInteger)
      )
        reject("BUSINESS_COMPANY_ACCESS_DENIED");
      const policy_hash = createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex");
      const nonce =
        req.directoryRequestNonce ??
        (() => {
          throw new HttpError(
            403,
            "BUSINESS_COMPANY_ACCESS_DENIED",
            "Votre accès doit être vérifié à nouveau.",
          );
        })();
      const reply = {
        ...data,
        policy_hash,
        request_nonce: nonce,
        issued_at: Math.floor(Date.now() / 1000),
      };
      const keys = await options.keys?.();
      const callKey = keys?.get(req.directoryCaller!);
      if (!callKey)
        throw new HttpError(
          403,
          "BUSINESS_COMPANY_ACCESS_DENIED",
          "Votre accès doit être vérifié à nouveau.",
        );
      const bytes = Buffer.from(JSON.stringify(reply));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "X-CERP-Business-Company-Policy-Signature",
        companyPolicyReplyMac(callKey, nonce, bytes).toString("hex"),
      );
      res.type("application/json").send(bytes);
    }),
  );
  app.post(
    "/internal/directory/business-company-instance",
    wrap(async (req, res) => {
      z.object({ input: z.object({}).strict() })
        .strict()
        .parse(req.body);
      const row = (
        await db.query<{
          company_id: string;
          environment: "cerp_prod" | "cerp_test";
          site_id: string;
          active: boolean;
        }>(
          `SELECT i.company_id::text,i.environment,i.site_id,i.active FROM public.cerp_business_company_instances i JOIN public.cerp_business_companies c ON c.company_id=i.company_id WHERE i.site_id=$1 AND i.active AND c.status='ACTIVE'`,
          [req.directoryCaller!],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          403,
          "BUSINESS_COMPANY_INSTANCE_DENIED",
          "Cette instance société doit être configurée.",
        );
      res.json(row);
    }),
  );
  app.post(
    "/internal/directory/business-company-sign-in-context",
    wrap(async (req, res) => {
      z.object({ input: z.object({}).strict() })
        .strict()
        .parse(req.body);
      const environment = callerEnvironment(req.directoryCaller!);
      const row = (
        await db.query<{
          company_id: string;
          code: string;
          name: string;
          profile: "COMMERCIAL" | "INDUSTRIAL";
          environment: "cerp_prod" | "cerp_test";
        }>(
          `SELECT c.company_id::text,c.code,c.name,c.profile,i.environment
         FROM public.cerp_business_company_instances i
         JOIN public.cerp_business_companies c ON c.company_id=i.company_id
         WHERE i.site_id=$1 AND i.environment=$2 AND i.active AND c.status='ACTIVE'`,
          [req.directoryCaller!, environment],
        )
      ).rows[0];
      if (!row) reject("BUSINESS_COMPANY_INSTANCE_DENIED");
      res.setHeader("Cache-Control", "no-store");
      res.json({
        company: {
          id: row.company_id,
          code: row.code,
          name: row.name,
          profile: row.profile,
        },
        environment: row.environment,
      });
    }),
  );
  app.post(
    "/internal/directory/business-company-context",
    wrap(async (req, res) => {
      const parsed = body.parse(req.body);
      z.object({}).strict().parse(parsed.input);
      const actor = await validateDirectorySession(
        db,
        req.directoryCaller!,
        parsed.directory_session,
        { autoProvisionTestMembership: false },
      );
      const environment = callerEnvironment(req.directoryCaller!);
      const instance = (
        await db.query<{ company_id: string }>(
          `SELECT company_id::text FROM public.cerp_business_company_instances WHERE site_id=$1 AND active`,
          [req.directoryCaller!],
        )
      ).rows[0];
      if (!instance) reject("BUSINESS_COMPANY_ACCESS_DENIED");
      const state = await readSwitchState(db, {
        profileId: actor.profile_id,
        companyId: instance.company_id,
        environment,
      });
      if (!state || state.site_id !== req.directoryCaller!)
        throw new HttpError(
          403,
          "BUSINESS_COMPANY_ACCESS_DENIED",
          "Votre accès doit être vérifié à nouveau.",
        );
      res.json({
        company: {
          id: state.company_id,
          code: state.code,
          name: state.name,
          status: "ACTIVE",
          profile: state.profile,
          enabled_module_keys: state.enabled_module_keys,
          enabled_commercial_projection_capabilities:
            state.company_projection_capabilities,
        },
        membership: {
          central_account_id: state.source_user_id,
          directory_profile_id: state.profile_id,
          company_id: state.company_id,
          status: "ACTIVE",
          allowed_module_keys: state.allowed_module_keys,
          denied_module_keys: state.denied_module_keys,
          enabled_commercial_projection_capabilities:
            state.membership_projection_capabilities,
        },
        instance: {
          company_id: state.company_id,
          environment: state.environment,
          site_id: state.site_id,
          active: true,
        },
      });
    }),
  );
  app.post(
    "/internal/directory/business-company-list",
    wrap(async (req, res) => {
      const parsed = body.parse(req.body);
      z.object({}).strict().parse(parsed.input);
      const actor = await validateDirectorySession(
        db,
        req.directoryCaller!,
        parsed.directory_session,
        { autoProvisionTestMembership: false },
      );
      res.json({
        environment: callerEnvironment(req.directoryCaller!),
        companies: await listAccessibleBusinessCompanies(
          db,
          actor.profile_id,
          callerEnvironment(req.directoryCaller!),
        ),
      });
    }),
  );
  app.post(
    "/internal/directory/business-company-switch-create",
    wrap(async (req, res) => {
      const parsed = body.parse(req.body),
        input = z
          .object({ company_id: z.string().uuid(), key })
          .strict()
          .parse(parsed.input),
        sourceSite = req.directoryCaller!;
      const actor = await validateDirectorySession(
          db,
          sourceSite,
          parsed.directory_session,
          { autoProvisionTestMembership: false },
        ),
        environment = callerEnvironment(sourceSite),
        sourceHash = switchHash(parsed.directory_session);
      const tx = await db.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
          `business-company-switch:${sourceHash}:${input.key}`,
        ]);
        const state = await readSwitchState(tx, {
          profileId: actor.profile_id,
          companyId: input.company_id,
          environment,
          sourceSite,
          sourceSessionHash: sourceHash,
        });
        if (!state || state.environment !== environment)
          throw new HttpError(
            403,
            "BUSINESS_COMPANY_SWITCH_DENIED",
            "Votre accès doit être vérifié à nouveau.",
          );
        const existing = (
          await tx.query<{
            company_id: string;
            target_site: string;
            environment: string;
            expires_at: string;
          }>(
            `SELECT company_id::text,target_site,environment,expires_at::text FROM public.cerp_business_company_switches WHERE source_session_hash=$1 AND request_key=$2::uuid FOR UPDATE`,
            [sourceHash, input.key],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.company_id !== input.company_id ||
            existing.target_site !== state.site_id ||
            existing.environment !== environment
          )
            throw new HttpError(
              409,
              "BUSINESS_COMPANY_SWITCH_IDEMPOTENCY_CONFLICT",
              "La clé de requête est déjà utilisée.",
            );
          if (new Date(existing.expires_at) <= new Date())
            reject("BUSINESS_COMPANY_SWITCH_REJECTED");
          const raw = deterministicTicket(
            options.sourceJwtSecret,
            sourceHash,
            input.key,
            state.site_id,
            environment,
          );
          await tx.query("COMMIT");
          res.json(
            switchCreateDto(
              raw,
              input.company_id,
              environment,
              existing.expires_at,
            ),
          );
          return;
        }
        const raw = deterministicTicket(
            options.sourceJwtSecret,
            sourceHash,
            input.key,
            state.site_id,
            environment,
          ),
          hash = switchHash(raw);
        const created = (
          await tx.query<{ expires_at: string }>(
            `INSERT INTO public.cerp_business_company_switches(ticket_hash,request_key,source_session_hash,profile_id,source_site,target_site,company_id,environment,global_session_epoch,source_membership_version,source_company_membership_version,company_membership_version,target_directory_membership_version,expires_at) VALUES($1,$2::uuid,$3,$4::uuid,$5,$6,$7::uuid,$8,$9,$10,$11,$12,$13,now()+interval '60 seconds') RETURNING expires_at::text`,
            [
              hash,
              input.key,
              sourceHash,
              actor.profile_id,
              sourceSite,
              state.site_id,
              input.company_id,
              environment,
              actor.global_session_epoch,
              actor.membership_version,
              state.source_company_membership_version,
              state.company_membership_version,
              state.target_directory_membership_version,
            ],
          )
        ).rows[0];
        await tx.query("COMMIT");
        res.json(
          switchCreateDto(
            raw,
            input.company_id,
            environment,
            created.expires_at,
          ),
        );
      } catch (e) {
        await tx.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        tx.release();
      }
    }),
  );
  app.post(
    "/internal/directory/business-company-switch-redeem",
    wrap(async (req, res) => {
      const parsed = z
          .object({
            input: z
              .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/), key })
              .strict(),
          })
          .strict()
          .parse(req.body),
        targetSite = req.directoryCaller!;
      const tx = await db.connect();
      try {
        await tx.query("BEGIN");
        const locked = await lockSwitch(tx, switchHash(parsed.input.ticket));
        if (
          !locked ||
          locked.request_key !== parsed.input.key ||
          locked.target_site !== targetSite ||
          new Date(locked.expires_at) <= new Date()
        )
          reject("BUSINESS_COMPANY_SWITCH_REJECTED");
        const state = await readSwitchState(tx, {
          profileId: locked.profile_id,
          companyId: locked.company_id,
          environment: locked.environment,
          sourceSite: locked.source_site,
          sourceSessionHash: locked.source_session_hash,
        });
        if (
          !state ||
          state.site_id !== targetSite ||
          state.company_membership_version !==
            locked.company_membership_version ||
          state.source_company_membership_version !==
            Number(locked.source_company_membership_version) ||
          state.target_directory_membership_version !==
            locked.target_directory_membership_version ||
          state.source_membership_version !==
            locked.source_membership_version ||
          String(state.global_session_epoch) !==
            String(locked.global_session_epoch)
        )
          throw new HttpError(
            403,
            "BUSINESS_COMPANY_SWITCH_REJECTED",
            "Votre accès doit être vérifié à nouveau.",
          );
        const token = deterministicToken(
          options.sourceJwtSecret,
          parsed.input.ticket,
          parsed.input.key,
          targetSite,
        );
        const sourceExpiry =
          state.source_session_expires_at === null
            ? NaN
            : Date.parse(state.source_session_expires_at);
        if (!Number.isFinite(sourceExpiry) || sourceExpiry <= Date.now())
          reject("BUSINESS_COMPANY_SWITCH_REJECTED");
        const source = {
          profile_id: state.profile_id,
          source_user_id: state.source_user_id,
          global_session_epoch: state.global_session_epoch,
          mfa_factor_id: state.mfa_factor_id,
          mfa_factor_version: state.mfa_factor_version,
          mfa_verified_at: state.mfa_verified_at,
          mfa_method: state.mfa_method,
          tablet_device_id: state.tablet_device_id,
          tablet_pin_version:
            state.tablet_device_id === null
              ? undefined
              : state.tablet_pin_version,
        } as DirectorySession;
        const result = await createDirectorySessionFromIdentity(
          tx,
          targetSite,
          source,
          {
            token,
            expiresAt: new Date(
              Math.min(Date.now() + 24 * 60 * 60 * 1000, sourceExpiry),
            ),
          },
        );
        await tx.query(
          "UPDATE public.cerp_business_company_switches SET redeemed_at=coalesce(redeemed_at,now()),redeemed_session_hash=$2 WHERE ticket_hash=$1",
          [locked.ticket_hash, switchHash(token)],
        );
        await tx.query("COMMIT");
        res.json(result);
      } catch (e) {
        await tx.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        tx.release();
      }
    }),
  );
}
