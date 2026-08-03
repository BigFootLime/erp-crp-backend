import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  authorizationRole,
  effectiveRoleHasAny,
  normalizeAssignedRoles,
} from "../module/auth/domain/roles";
import { authorizeRole } from "../module/auth/middlewares/auth.middleware";
import { adminCreateUserSchema } from "../module/admin/validators/admin.validators";
import { roleHasFinanceCapability } from "../module/facturation/domain/finance-policy";
import { roleHasPlanningAccess } from "../module/planning/domain/planning-rbac";
import { roleHasMachineCapability } from "../module/production/domain/machine-rbac";
import { ARTICLE_WRITE_ROLES } from "../module/stock/stock-article.permissions";
import { canApprovePieceTechniqueVersion } from "../module/pieces-techniques/domain/pieces-techniques-rbac";
import { canLaunchInternalOrder } from "../module/commande-client/domain/commande-client-rbac";
import {
  CLIENT_FINANCE_ROLES,
  CLIENT_WRITE_ROLES,
} from "../module/client/client.permissions";

const validUserBody = {
  username: "LAMBERT",
  password: "Atelier1**",
  name: "THOMASSONI",
  surname: "Lambert",
  email: "lambert@croix-rousse-precision.fr",
  tel_no: "0600000001",
  role: "Directeur",
  roles: ["Directeur", "Commerce", "Achats"],
  gender: "Male",
  address: "Adresse provisoire",
  lane: "Rue provisoire",
  house_no: "1",
  postcode: "69000",
  country: "France",
  date_of_birth: "1990-01-01",
  status: "Active",
  social_security_number: "100000000000001",
};

describe("RBAC multi-rôles #315", () => {
  it("normalise les rôles sans doublon et conserve le rôle principal en premier", () => {
    expect(normalizeAssignedRoles("Directeur", ["Commerce", "Directeur", "Achats"])).toEqual([
      "Directeur",
      "Commerce",
      "Achats",
    ]);
    expect(authorizationRole("Directeur", ["Commerce", "Achats"])).toBe(
      "Directeur | Commercial | Achat"
    );
  });

  it("traduit explicitement les responsabilités sans escalade par intitulé", () => {
    const effective = authorizationRole("Employee", [
      "Directeur Technique",
      "Planning",
      "Maintenance",
    ]);

    expect(effective).toBe("Employee | Production | Atelier | Method | Planification | Maintenance");
    expect(effectiveRoleHasAny(effective, ["Directeur"])).toBe(false);
    expect(roleHasPlanningAccess(effective)).toBe(true);
    expect(roleHasFinanceCapability(effective, "read")).toBe(false);
  });

  it("autorise une route lorsqu'un rôle complémentaire correspond", () => {
    const middleware = authorizeRole("Responsable RH");
    const req = {
      user: {
        id: 12,
        username: "NIZIER",
        email: "nizier@croix-rousse-precision.fr",
        role: "Directeur | Responsable RH | Planning",
        primary_role: "Directeur",
        roles: ["Directeur", "Responsable RH", "Planning"],
      },
      headers: {},
      method: "GET",
      originalUrl: "/api/v1/temps-deplacements",
    } as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("applique les alias explicites aux gardes de rôle exactes", () => {
    const middleware = authorizeRole("Secretaire");
    const req = {
      user: {
        id: 14,
        username: "ASSISTANCE",
        email: "assistance@example.invalid",
        role: "Employee | Secretaire",
        primary_role: "Employee",
        roles: ["Employee", "Assistante polyvalente"],
      },
      headers: {},
      method: "POST",
      originalUrl: "/api/v1/clients",
    } as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("n'escalade jamais Directeur Technique vers le rôle global Directeur", () => {
    const middleware = authorizeRole("Directeur");
    const req = {
      user: {
        id: 15,
        username: "DIRECTION_TECHNIQUE",
        email: "direction-technique@example.invalid",
        role: "Employee | Production | Atelier | Method",
        primary_role: "Employee",
        roles: ["Employee", "Directeur Technique"],
      },
      headers: {},
      method: "GET",
      originalUrl: "/api/v1/admin/users",
    } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as unknown as Response;
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("refuse par défaut si aucun rôle attribué ne correspond", () => {
    const middleware = authorizeRole("Responsable RH");
    const req = {
      user: {
        id: 13,
        username: "OPERATEUR",
        email: "operateur@croix-rousse-precision.fr",
        role: "Employee | Opérateur atelier",
        primary_role: "Employee",
        roles: ["Employee", "Opérateur atelier"],
      },
      headers: {},
      method: "GET",
      originalUrl: "/api/v1/temps-deplacements",
    } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as unknown as Response;
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("valide le rôle principal dans l'ensemble des rôles attribués", () => {
    expect(adminCreateUserSchema.safeParse({ body: validUserBody }).success).toBe(true);
    const invalid = adminCreateUserSchema.safeParse({
      body: { ...validUserBody, roles: ["Commerce", "Achats"] },
    });
    expect(invalid.success).toBe(false);
  });

  it("refuse les rôles inconnus au lieu de fabriquer une autorisation", () => {
    expect(
      adminCreateUserSchema.safeParse({
        body: { ...validUserBody, role: "Directeur Technique Inconnu" },
      }).success
    ).toBe(false);
    expect(
      adminCreateUserSchema.safeParse({
        body: { ...validUserBody, roles: ["Directeur", "Role-Inconnu"] },
      }).success
    ).toBe(false);
    expect(authorizationRole("Role-Inconnu", ["Role-Inconnu"])).toBe("");
  });

  it("autorise un compte ERP incomplet sans inventer de données RH", () => {
    const accountOnly = {
      ...validUserBody,
      tel_no: null,
      gender: null,
      address: null,
      lane: null,
      house_no: null,
      postcode: null,
      date_of_birth: null,
      social_security_number: null,
    };
    expect(adminCreateUserSchema.safeParse({ body: accountOnly }).success).toBe(true);
  });

  it("cumule les capacités des rôles fonctionnels historiques", () => {
    expect(roleHasMachineCapability("Employee | Maintenance", "maintenance")).toBe(true);
    expect(roleHasMachineCapability("Employee | Opérateur atelier", "archive")).toBe(false);
    expect(roleHasFinanceCapability("Employee | Comptabilite", "validate")).toBe(true);
  });

  it("débloque les actions critiques pour les responsabilités organisationnelles prévues", () => {
    const materialManagerRole = authorizationRole("Employee", ["Gestion matière"]);
    const methodsRole = authorizationRole("Employee", ["Études-Méthodes"]);
    const technicalDirectorRole = authorizationRole("Employee", ["Directeur Technique"]);
    const commercialRole = authorizationRole("Employee", ["Commerce"]);
    const financeRole = authorizationRole("Employee", ["RH-Financier"]);

    expect(effectiveRoleHasAny(materialManagerRole, ARTICLE_WRITE_ROLES)).toBe(true);
    expect(canApprovePieceTechniqueVersion(methodsRole)).toBe(true);
    expect(canLaunchInternalOrder(technicalDirectorRole)).toBe(true);
    expect(effectiveRoleHasAny(commercialRole, CLIENT_WRITE_ROLES)).toBe(true);
    expect(effectiveRoleHasAny(commercialRole, CLIENT_FINANCE_ROLES)).toBe(false);
    expect(effectiveRoleHasAny(financeRole, CLIENT_FINANCE_ROLES)).toBe(true);
  });

  it("maintient le refus sur les actions sensibles pour un opérateur sans responsabilité", () => {
    const operatorRole = authorizationRole("Employee", ["Opérateur atelier"]);

    expect(effectiveRoleHasAny(operatorRole, ARTICLE_WRITE_ROLES)).toBe(false);
    expect(canApprovePieceTechniqueVersion(operatorRole)).toBe(false);
    expect(canLaunchInternalOrder(operatorRole)).toBe(false);
  });
});
