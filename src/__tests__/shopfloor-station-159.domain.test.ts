// #159 — Poste opérateur tablette : règles de domaine.
//
// Ces tests appellent les politiques PURES directement, sans HTTP ni base. Ils
// couvrent ce qu'aucun test d'orchestration ne peut prouver : la règle
// elle-même, y compris ses cas accentués et ses refus.

import { describe, expect, it } from "vitest";

import {
  assertCredentialNotLocked,
  assertDeviceTransition,
  assertDeviceUsable,
  assertHandoverAcknowledgeable,
  assertHandoverParties,
  assertNonceFresh,
  assertOperatorSwitchDecided,
  assertOwnSessionOrSupervision,
  assertSessionTransition,
  assessOperationReadiness,
  canSubscribeStationRoom,
  compareWorklistEntries,
  evaluateMachineSelectability,
  evaluateSession,
  fingerprintCredential,
  FORBIDDEN_STATION_CAPABILITY_FRAGMENTS,
  FORBIDDEN_STATION_SIDE_EFFECTS,
  generateSessionToken,
  hashSessionToken,
  listStationCapabilities,
  LOCK_NEVER_STOPS_EXECUTION,
  NEVER_EXPOSED_FIELDS,
  parseStationRoom,
  resolvePlanForSnapshot,
  roleHasStationCapability,
  safeEqualHex,
  sanitizeAuditDetail,
  STATION_CAPABILITIES,
  stripCostFields,
  type MachineCandidate,
  type WorklistSignals,
} from "../module/production/domain/station";

const PEPPER = "poivre-de-test-suffisamment-long";

function signals(overrides: Partial<WorklistSignals> = {}): WorklistSignals {
  return {
    of_statut: "EN_COURS",
    operation_status: "TODO",
    has_pending_predecessor: false,
    has_active_execution_by_other: false,
    machine_matches: true,
    machine_available: true,
    has_technical_snapshot: true,
    has_plan_document: true,
    first_article_pending: false,
    qty_pending_control: 0,
    remaining_quantity: 10,
    ...overrides,
  };
}

function machine(overrides: Partial<MachineCandidate> = {}): MachineCandidate {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    code: "TOUR-01",
    name: "Tour CN",
    status: "ACTIVE",
    is_available: true,
    workshop_zone: "USINAGE",
    archived_at: null,
    active_operator_user_id: null,
    active_of_numero: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
describe("#159 — capacités RBAC", () => {
  it("accorde à un opérateur les gestes de base et rien de plus", () => {
    const caps = listStationCapabilities("Operateur CN");
    expect(caps).toContain("read_own_station");
    expect(caps).toContain("open_session");
    expect(caps).toContain("handover_shift");
    expect(caps).not.toContain("administer_devices");
    expect(caps).not.toContain("administer_credentials");
    expect(caps).not.toContain("view_costs");
    expect(caps).not.toContain("supervise_stations");
  });

  it("reconnaît les rôles accentués", () => {
    expect(roleHasStationCapability("Régleur tour", "start_self" as never)).toBe(false);
    expect(roleHasStationCapability("Régleur tour", "open_session")).toBe(true);
    expect(roleHasStationCapability("Opérateur fraisage", "read_own_station")).toBe(true);
  });

  it("refuse tout à un rôle inconnu — refus par défaut", () => {
    expect(listStationCapabilities("Visiteur externe")).toEqual([]);
    expect(listStationCapabilities(null)).toEqual([]);
    expect(listStationCapabilities("")).toEqual([]);
  });

  it("ouvre les coûts à la comptabilité et pas à l'atelier", () => {
    expect(roleHasStationCapability("Comptabilite", "view_costs")).toBe(true);
    expect(roleHasStationCapability("Operateur CN", "view_costs")).toBe(false);
  });

  it("ouvre la supervision au chef d'atelier, pas à l'opérateur", () => {
    expect(roleHasStationCapability("Chef d'atelier", "supervise_stations")).toBe(true);
    expect(roleHasStationCapability("Operateur CN", "supervise_stations")).toBe(false);
  });

  it("n'introduit AUCUNE capacité de nature RH", () => {
    for (const capability of STATION_CAPABILITIES) {
      for (const fragment of FORBIDDEN_STATION_CAPABILITY_FRAGMENTS) {
        expect(capability.toLowerCase()).not.toContain(fragment);
      }
    }
  });

  it("déclare explicitement les effets de bord interdits", () => {
    expect(FORBIDDEN_STATION_SIDE_EFFECTS).toContain("hr_time_events");
    expect(FORBIDDEN_STATION_SIDE_EFFECTS).toContain("stock_movements");
    expect(FORBIDDEN_STATION_SIDE_EFFECTS).toContain("bons_livraison");
    expect(FORBIDDEN_STATION_SIDE_EFFECTS).toContain("factures");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — cycle de vie d'un appareil", () => {
  const base = {
    id: "d",
    public_code: "TAB-0001",
    assignment_mode: "MOBILE" as const,
    machine_id: null,
    auto_lock_seconds: 180,
    session_max_seconds: 28800,
  };

  it("refuse une tablette inconnue avec un code distinct", () => {
    expect(() => assertDeviceUsable(null)).toThrowError(/pas enregistrée/i);
  });

  it("refuse une tablette révoquée et une tablette désactivée avec deux messages différents", () => {
    expect(() => assertDeviceUsable({ ...base, status: "REVOKED" })).toThrowError(/révoquée/i);
    expect(() => assertDeviceUsable({ ...base, status: "DISABLED" })).toThrowError(/désactivée/i);
  });

  it("accepte une tablette active", () => {
    expect(() => assertDeviceUsable({ ...base, status: "ACTIVE" })).not.toThrow();
  });

  it("interdit de réactiver une tablette révoquée", () => {
    expect(() => assertDeviceTransition("REVOKED", "ACTIVE")).toThrowError(/interdite/i);
    expect(() => assertDeviceTransition("DISABLED", "ACTIVE")).not.toThrow();
    expect(() => assertDeviceTransition("ACTIVE", "REVOKED")).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — session de poste", () => {
  const now = new Date("2026-07-26T10:00:00.000Z");

  it("accepte une session active et récente", () => {
    const result = evaluateSession({
      session: {
        state: "ACTIVE",
        expires_at: new Date("2026-07-26T18:00:00.000Z"),
        last_activity_at: new Date("2026-07-26T09:59:00.000Z"),
      },
      autoLockSeconds: 180,
      now,
    });
    expect(result).toEqual({ usable: true, reason: null });
  });

  it("verrouille sur inactivité, en s'appuyant sur l'horloge SERVEUR", () => {
    const result = evaluateSession({
      session: {
        state: "ACTIVE",
        expires_at: new Date("2026-07-26T18:00:00.000Z"),
        last_activity_at: new Date("2026-07-26T09:50:00.000Z"),
      },
      autoLockSeconds: 180,
      now,
    });
    expect(result).toEqual({ usable: false, reason: "IDLE_LOCK" });
  });

  it("expire une session au-delà de sa durée maximale, même active à la seconde près", () => {
    const result = evaluateSession({
      session: {
        state: "ACTIVE",
        expires_at: new Date("2026-07-26T09:59:59.000Z"),
        last_activity_at: now,
      },
      autoLockSeconds: 180,
      now,
    });
    expect(result).toEqual({ usable: false, reason: "EXPIRED" });
  });

  it("traite fermée, expirée et révoquée comme définitivement inutilisables", () => {
    for (const state of ["CLOSED", "EXPIRED", "REVOKED"] as const) {
      const result = evaluateSession({
        session: {
          state,
          expires_at: new Date("2026-07-26T18:00:00.000Z"),
          last_activity_at: now,
        },
        autoLockSeconds: 180,
        now,
      });
      expect(result).toEqual({ usable: false, reason: "CLOSED" });
    }
  });

  it("interdit de rouvrir une session fermée", () => {
    expect(() => assertSessionTransition("CLOSED", "ACTIVE")).toThrowError(/interdite/i);
    expect(() => assertSessionTransition("LOCKED", "ACTIVE")).not.toThrow();
  });

  it("garantit qu'un verrouillage n'arrête jamais une exécution", () => {
    expect(LOCK_NEVER_STOPS_EXECUTION).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — changement d'opérateur", () => {
  it("laisse passer quand aucun pointage ne tourne", () => {
    expect(() =>
      assertOperatorSwitchDecided({ hasActiveExecution: false, decision: null, actorRole: "Operateur" })
    ).not.toThrow();
  });

  it("exige une décision explicite quand un pointage tourne", () => {
    expect(() =>
      assertOperatorSwitchDecided({ hasActiveExecution: true, decision: null, actorRole: "Operateur CN" })
    ).toThrowError(/transmettre le poste/i);
  });

  it("accepte transmission et pause pour un opérateur", () => {
    for (const decision of ["HANDOVER", "PAUSE"] as const) {
      expect(() =>
        assertOperatorSwitchDecided({ hasActiveExecution: true, decision, actorRole: "Operateur CN" })
      ).not.toThrow();
    }
  });

  it("réserve la reprise autoritaire au superviseur", () => {
    expect(() =>
      assertOperatorSwitchDecided({
        hasActiveExecution: true,
        decision: "SUPERVISOR_OVERRIDE",
        actorRole: "Operateur CN",
      })
    ).toThrowError(/superviseur/i);
    expect(() =>
      assertOperatorSwitchDecided({
        hasActiveExecution: true,
        decision: "SUPERVISOR_OVERRIDE",
        actorRole: "Chef d'atelier",
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — identification", () => {
  it("produit une empreinte HMAC stable et non réversible", () => {
    const a = fingerprintCredential("04A1B2C3D4", PEPPER);
    const b = fingerprintCredential("04A1B2C3D4", PEPPER);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("04A1B2C3D4");
  });

  it("change d'empreinte avec le poivre : voler la base ne suffit pas", () => {
    const a = fingerprintCredential("04A1B2C3D4", PEPPER);
    const b = fingerprintCredential("04A1B2C3D4", `${PEPPER}-autre`);
    expect(a).not.toBe(b);
  });

  it("refuse de hacher sans poivre plutôt que de dégrader silencieusement", () => {
    expect(() => fingerprintCredential("04A1B2C3D4", "")).toThrowError(/pas configurée/i);
    expect(() => fingerprintCredential("04A1B2C3D4", "trop-court")).toThrowError(/pas configurée/i);
  });

  it("refuse un support vide", () => {
    expect(() => fingerprintCredential("   ", PEPPER)).toThrowError(/vide/i);
  });

  it("génère un jeton de session opaque et ne stocke que son empreinte", () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
  });

  it("compare les empreintes à temps constant", () => {
    const a = hashSessionToken("x");
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, hashSessionToken("y"))).toBe(false);
    expect(safeEqualHex(a, "court")).toBe(false);
  });

  it("verrouille un support après trop de tentatives", () => {
    const now = new Date("2026-07-26T10:00:00.000Z");
    expect(() =>
      assertCredentialNotLocked({ locked_until: new Date("2026-07-26T10:02:00.000Z"), now })
    ).toThrowError(/Réessayez dans/i);
    expect(() =>
      assertCredentialNotLocked({ locked_until: new Date("2026-07-26T09:58:00.000Z"), now })
    ).not.toThrow();
    expect(() => assertCredentialNotLocked({ locked_until: null, now })).not.toThrow();
  });

  it("refuse un code rejoué et un code périmé", () => {
    const now = new Date("2026-07-26T10:00:00.000Z");
    expect(() =>
      assertNonceFresh({ issuedAt: new Date("2026-07-26T09:59:50.000Z"), now, seenBefore: true })
    ).toThrowError(/déjà été utilisé/i);
    expect(() =>
      assertNonceFresh({ issuedAt: new Date("2026-07-26T09:58:00.000Z"), now, seenBefore: false })
    ).toThrowError(/plus valide/i);
    expect(() =>
      assertNonceFresh({ issuedAt: new Date("2026-07-26T09:59:50.000Z"), now, seenBefore: false })
    ).not.toThrow();
  });

  it("refuse un code daté du futur (horloge tablette reculée ou avancée)", () => {
    const now = new Date("2026-07-26T10:00:00.000Z");
    expect(() =>
      assertNonceFresh({ issuedAt: new Date("2026-07-26T10:01:00.000Z"), now, seenBefore: false })
    ).toThrowError(/plus valide/i);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — sélection de machine", () => {
  const actorUserId = 7;

  it("accepte une machine active, disponible et libre", () => {
    const v = evaluateMachineSelectability({
      machine: machine(),
      actorUserId,
      deviceZone: "USINAGE",
      enforceZone: true,
    });
    expect(v.selectable).toBe(true);
    expect(v.reason_code).toBe("OK");
  });

  it("refuse une machine archivée, inactive ou indisponible avec des codes distincts", () => {
    expect(
      evaluateMachineSelectability({
        machine: machine({ archived_at: new Date() }),
        actorUserId,
        deviceZone: null,
        enforceZone: false,
      }).reason_code
    ).toBe("MACHINE_ARCHIVED");

    expect(
      evaluateMachineSelectability({
        machine: machine({ status: "MAINTENANCE" }),
        actorUserId,
        deviceZone: null,
        enforceZone: false,
      }).reason_code
    ).toBe("MACHINE_INACTIVE");

    expect(
      evaluateMachineSelectability({
        machine: machine({ is_available: false }),
        actorUserId,
        deviceZone: null,
        enforceZone: false,
      }).reason_code
    ).toBe("MACHINE_UNAVAILABLE");
  });

  it("refuse une machine hors zone quand la zone est imposée", () => {
    const v = evaluateMachineSelectability({
      machine: machine({ workshop_zone: "RECTIF" }),
      actorUserId,
      deviceZone: "USINAGE",
      enforceZone: true,
    });
    expect(v.selectable).toBe(false);
    expect(v.reason_code).toBe("MACHINE_OUT_OF_ZONE");
  });

  it("signale une machine occupée par un tiers SANS proposer de forçage", () => {
    const v = evaluateMachineSelectability({
      machine: machine({ active_operator_user_id: 99, active_of_numero: "OF-2026-0042" }),
      actorUserId,
      deviceZone: null,
      enforceZone: false,
    });
    expect(v.selectable).toBe(false);
    expect(v.busy_by_other).toBe(true);
    expect(v.reason).toContain("OF-2026-0042");
  });

  it("laisse l'opérateur reprendre SA propre machine", () => {
    const v = evaluateMachineSelectability({
      machine: machine({ active_operator_user_id: actorUserId }),
      actorUserId,
      deviceZone: null,
      enforceZone: false,
    });
    expect(v.selectable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — préparation d'une opération", () => {
  it("déclare PRÊT quand tout est en place, avec une phrase lisible", () => {
    const a = assessOperationReadiness(signals());
    expect(a.level).toBe("READY");
    expect(a.headline).toMatch(/Prêt à démarrer/i);
    expect(a.reasons).toEqual([]);
  });

  it("BLOQUE sans snapshot technique : l'indice lancé serait incertain", () => {
    const a = assessOperationReadiness(signals({ has_technical_snapshot: false }));
    expect(a.level).toBe("BLOCKED");
    expect(a.reasons.map((r) => r.code)).toContain("NO_TECHNICAL_SNAPSHOT");
  });

  it("BLOQUE sur un OF non lancé ou annulé", () => {
    for (const statut of ["BROUILLON", "ANNULE", "SUSPENDU", "TERMINE"]) {
      expect(assessOperationReadiness(signals({ of_statut: statut })).level).toBe("BLOCKED");
    }
  });

  it("BLOQUE quand un autre opérateur pointe déjà l'opération", () => {
    const a = assessOperationReadiness(signals({ has_active_execution_by_other: true }));
    expect(a.level).toBe("BLOCKED");
    expect(a.reasons.map((r) => r.code)).toContain("ALREADY_RUNNING");
  });

  it("classe EN ATTENTE DE CONTRÔLE un premier article non prononcé, sans autre blocage", () => {
    const a = assessOperationReadiness(signals({ first_article_pending: true }));
    expect(a.level).toBe("AWAITING_CONTROL");
    expect(a.headline).toMatch(/Premier article/i);
  });

  it("classe INCOMPLET un manque de plan ou une phase antérieure ouverte", () => {
    expect(assessOperationReadiness(signals({ has_plan_document: false })).level).toBe("INCOMPLETE");
    expect(assessOperationReadiness(signals({ has_pending_predecessor: true })).level).toBe("INCOMPLETE");
    expect(assessOperationReadiness(signals({ machine_matches: false })).level).toBe("INCOMPLETE");
  });

  it("informe des quantités en attente de décision Qualité sans bloquer", () => {
    const a = assessOperationReadiness(signals({ qty_pending_control: 4 }));
    expect(a.level).toBe("READY");
    expect(a.reasons.find((r) => r.code === "QTY_AWAITING_CONTROL")?.label).toContain("4");
  });

  it("ordonne la file par préparation, puis date, puis phase — jamais par un score", () => {
    const entries = [
      { readiness: "BLOCKED" as const, due_date: "2026-01-01", phase: 10 },
      { readiness: "READY" as const, due_date: "2026-08-01", phase: 20 },
      { readiness: "READY" as const, due_date: "2026-07-01", phase: 30 },
      { readiness: "INCOMPLETE" as const, due_date: null, phase: 10 },
    ];
    const sorted = [...entries].sort(compareWorklistEntries);
    expect(sorted[0]).toEqual({ readiness: "READY", due_date: "2026-07-01", phase: 30 });
    expect(sorted[1]).toEqual({ readiness: "READY", due_date: "2026-08-01", phase: 20 });
    expect(sorted[3].readiness).toBe("BLOCKED");
  });

  it("place une opération sans date cible APRÈS celles qui en ont une", () => {
    const sorted = [
      { readiness: "READY" as const, due_date: null, phase: 10 },
      { readiness: "READY" as const, due_date: "2027-01-01", phase: 20 },
    ].sort(compareWorklistEntries);
    expect(sorted[0].due_date).toBe("2027-01-01");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — le plan suit le snapshot figé, jamais le dernier indice", () => {
  const doc = {
    id: "doc-1",
    label: "Plan",
    original_name: "plan-b.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    sha256: "a".repeat(64),
    piece_technique_id: "pt-1",
  };

  it("renvoie le document de la version figée", () => {
    const r = resolvePlanForSnapshot({
      snapshot: { piece_technique_version_id: "v-b", snapshot_sha256: "x", snapshot_at: new Date() },
      documentsForSnapshotVersion: [doc],
      latestVersionIndice: "B",
      snapshotIndice: "B",
    });
    expect(r.document?.id).toBe("doc-1");
    expect(r.matches_snapshot).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("AVERTIT quand un indice plus récent existe, sans jamais le substituer", () => {
    const r = resolvePlanForSnapshot({
      snapshot: { piece_technique_version_id: "v-b", snapshot_sha256: "x", snapshot_at: new Date() },
      documentsForSnapshotVersion: [doc],
      latestVersionIndice: "C",
      snapshotIndice: "B",
    });
    expect(r.document?.original_name).toBe("plan-b.pdf");
    expect(r.matches_snapshot).toBe(true);
    expect(r.warning).toContain("indice B");
    expect(r.warning).toContain("C");
  });

  it("refuse de substituer un autre document quand la version figée n'en a aucun", () => {
    const r = resolvePlanForSnapshot({
      snapshot: { piece_technique_version_id: "v-b", snapshot_sha256: "x", snapshot_at: new Date() },
      documentsForSnapshotVersion: [],
      latestVersionIndice: "C",
      snapshotIndice: "B",
    });
    expect(r.document).toBeNull();
    expect(r.matches_snapshot).toBe(false);
    expect(r.warning).toContain("B");
  });

  it("signale l'absence totale de snapshot comme une garantie manquante", () => {
    const r = resolvePlanForSnapshot({
      snapshot: { piece_technique_version_id: null, snapshot_sha256: null, snapshot_at: null },
      documentsForSnapshotVersion: [doc],
      latestVersionIndice: "C",
      snapshotIndice: null,
    });
    expect(r.document).toBeNull();
    expect(r.matches_snapshot).toBe(false);
    expect(r.warning).toMatch(/ne peut pas être garanti/i);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — transmission de poste", () => {
  it("refuse une transmission à soi-même", () => {
    expect(() => assertHandoverParties({ outgoingUserId: 5, incomingUserId: 5 })).toThrowError(
      /deux opérateurs différents/i
    );
  });

  it("autorise l'accusé de lecture au destinataire", () => {
    expect(() =>
      assertHandoverAcknowledgeable({
        incomingUserId: 5,
        actorUserId: 5,
        actorRole: "Operateur CN",
        alreadyAcknowledgedAt: null,
      })
    ).not.toThrow();
  });

  it("refuse l'accusé de lecture à un tiers non superviseur", () => {
    expect(() =>
      assertHandoverAcknowledgeable({
        incomingUserId: 5,
        actorUserId: 6,
        actorRole: "Operateur CN",
        alreadyAcknowledgedAt: null,
      })
    ).toThrowError(/autre opérateur/i);
  });

  it("autorise un superviseur et refuse un double accusé", () => {
    expect(() =>
      assertHandoverAcknowledgeable({
        incomingUserId: 5,
        actorUserId: 6,
        actorRole: "Chef d'atelier",
        alreadyAcknowledgedAt: null,
      })
    ).not.toThrow();
    expect(() =>
      assertHandoverAcknowledgeable({
        incomingUserId: 5,
        actorUserId: 5,
        actorRole: "Operateur CN",
        alreadyAcknowledgedAt: new Date(),
      })
    ).toThrowError(/déjà été accusée/i);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — anti-IDOR sur les sessions", () => {
  it("laisse un opérateur piloter sa session", () => {
    expect(() =>
      assertOwnSessionOrSupervision({
        actorUserId: 5,
        actorRole: "Operateur CN",
        sessionUserId: 5,
        action: "lock",
      })
    ).not.toThrow();
  });

  it("refuse la session d'un tiers à un opérateur", () => {
    expect(() =>
      assertOwnSessionOrSupervision({
        actorUserId: 5,
        actorRole: "Operateur CN",
        sessionUserId: 9,
        action: "close",
      })
    ).toThrowError(/autre opérateur/i);
  });

  it("autorise le superviseur", () => {
    expect(() =>
      assertOwnSessionOrSupervision({
        actorUserId: 5,
        actorRole: "Chef d'atelier",
        sessionUserId: 9,
        action: "close",
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — salons temps réel", () => {
  const MACHINE = "33333333-3333-3333-3333-333333333333";
  const DEVICE = "44444444-4444-4444-4444-444444444444";

  it("reconnaît les quatre formes de salon et rejette le reste", () => {
    expect(parseStationRoom("USER:7")).toEqual({ kind: "USER", userId: 7 });
    expect(parseStationRoom(`MACHINE:${MACHINE}`)).toEqual({ kind: "MACHINE", machineId: MACHINE });
    expect(parseStationRoom("OF:42")).toEqual({ kind: "OF", ofId: 42 });
    expect(parseStationRoom(`STATION:${DEVICE}`)).toEqual({ kind: "STATION", deviceId: DEVICE });
    expect(parseStationRoom("MACHINE:*")).toBeNull();
    expect(parseStationRoom("ADMIN:1")).toBeNull();
    expect(parseStationRoom("OF:abc")).toBeNull();
  });

  const scope = { ownMachineIds: [MACHINE], ownOfIds: [42], ownDeviceIds: [DEVICE] };

  it("réserve USER: à son propre identifiant", () => {
    expect(
      canSubscribeStationRoom({
        room: { kind: "USER", userId: 7 },
        actorUserId: 7,
        actorRole: "Operateur CN",
        ...scope,
      })
    ).toBe(true);
    expect(
      canSubscribeStationRoom({
        room: { kind: "USER", userId: 8 },
        actorUserId: 7,
        actorRole: "Chef d'atelier",
        ...scope,
      })
    ).toBe(false);
  });

  it("accorde MACHINE: et OF: dans le périmètre de l'opérateur uniquement", () => {
    expect(
      canSubscribeStationRoom({
        room: { kind: "MACHINE", machineId: MACHINE },
        actorUserId: 7,
        actorRole: "Operateur CN",
        ...scope,
      })
    ).toBe(true);
    expect(
      canSubscribeStationRoom({
        room: { kind: "MACHINE", machineId: "55555555-5555-5555-5555-555555555555" },
        actorUserId: 7,
        actorRole: "Operateur CN",
        ...scope,
      })
    ).toBe(false);
    expect(
      canSubscribeStationRoom({
        room: { kind: "OF", ofId: 99 },
        actorUserId: 7,
        actorRole: "Operateur CN",
        ...scope,
      })
    ).toBe(false);
  });

  it("élargit le périmètre au superviseur, et à lui seul", () => {
    expect(
      canSubscribeStationRoom({
        room: { kind: "OF", ofId: 99 },
        actorUserId: 7,
        actorRole: "Chef d'atelier",
        ...scope,
      })
    ).toBe(true);
    expect(
      canSubscribeStationRoom({
        room: { kind: "STATION", deviceId: "66666666-6666-6666-6666-666666666666" },
        actorUserId: 7,
        actorRole: "Operateur CN",
        ...scope,
      })
    ).toBe(false);
  });

  it("refuse tout salon à un rôle sans droit de lecture de poste", () => {
    expect(
      canSubscribeStationRoom({
        room: { kind: "MACHINE", machineId: MACHINE },
        actorUserId: 7,
        actorRole: "Visiteur externe",
        ...scope,
      })
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — fuite de données", () => {
  it("liste les champs qui ne doivent jamais sortir", () => {
    expect(NEVER_EXPOSED_FIELDS).toContain("storage_path");
    expect(NEVER_EXPOSED_FIELDS).toContain("session_token_hash");
    expect(NEVER_EXPOSED_FIELDS).toContain("credential_hash");
  });

  it("retire les coûts sans la capacité et les conserve avec", () => {
    const row = { designation: "Tournage", hourly_rate: 42, cout_mo: 12, prix: 5 };
    expect(stripCostFields({ ...row }, false)).toEqual({ designation: "Tournage" });
    expect(stripCostFields({ ...row }, true)).toEqual(row);
  });

  it("nettoie l'audit de tout secret et borne les chaînes longues", () => {
    const cleaned = sanitizeAuditDetail({
      badge_uid: "04A1B2",
      session_token: "abc",
      storage_path: "/srv/files/x.pdf",
      STATION_BADGE_PEPPER: "secret",
      of_numero: "OF-2026-0001",
      long: "x".repeat(600),
    });
    expect(cleaned).not.toHaveProperty("badge_uid");
    expect(cleaned).not.toHaveProperty("session_token");
    expect(cleaned).not.toHaveProperty("storage_path");
    expect(cleaned).not.toHaveProperty("STATION_BADGE_PEPPER");
    expect(cleaned.of_numero).toBe("OF-2026-0001");
    expect(String(cleaned.long)).toHaveLength(513);
  });
});
