import type {
  CreateCertificatBodyDTO,
  CreateEquipementBodyDTO,
  ListEquipementsQueryDTO,
  PatchEquipementBodyDTO,
  UpsertPlanBodyDTO,
} from "../validators/metrologie.validators";
import type {
  MetrologieAlerts,
  MetrologieCertificat,
  MetrologieEquipementDetail,
  MetrologieEquipementListItem,
  MetrologieKpis,
  Paginated,
} from "../types/metrologie.types";
import type { AuditContext } from "../repository/metrologie.repository";
import {
  repoAttachCertificats,
  repoDeleteEquipement,
  repoGetAlerts,
  repoGetCertificatForDownload,
  repoGetEquipementDetail,
  repoGetKpis,
  repoListCertificats,
  repoListEquipements,
  repoMetrologieDocsBaseDir,
  repoPatchEquipement,
  repoRemoveCertificat,
  repoUpsertPlan,
  repoCreateEquipement,
} from "../repository/metrologie.repository";

export function svcMetrologieDocsBaseDir(): string {
  return repoMetrologieDocsBaseDir();
}

export async function svcListEquipements(filters: ListEquipementsQueryDTO): Promise<Paginated<MetrologieEquipementListItem>> {
  return repoListEquipements(filters);
}

export async function svcGetKpis(): Promise<MetrologieKpis> {
  return repoGetKpis();
}

export async function svcGetAlerts(): Promise<MetrologieAlerts> {
  return repoGetAlerts();
}

export async function svcGetEquipementDetail(id: string): Promise<MetrologieEquipementDetail | null> {
  return repoGetEquipementDetail(id);
}

export async function svcCreateEquipement(body: CreateEquipementBodyDTO, audit: AuditContext): Promise<MetrologieEquipementDetail> {
  return repoCreateEquipement(body, audit);
}

export async function svcPatchEquipement(id: string, body: PatchEquipementBodyDTO, audit: AuditContext): Promise<MetrologieEquipementDetail | null> {
  return repoPatchEquipement(id, body, audit);
}

export async function svcDeleteEquipement(id: string, audit: AuditContext): Promise<boolean> {
  return repoDeleteEquipement(id, audit);
}

export async function svcUpsertPlan(equipementId: string, body: UpsertPlanBodyDTO, audit: AuditContext) {
  return repoUpsertPlan(equipementId, body, audit);
}

export async function svcListCertificats(equipementId: string): Promise<MetrologieCertificat[] | null> {
  return repoListCertificats(equipementId);
}

export async function svcAttachCertificats(params: {
  equipement_id: string;
  body: CreateCertificatBodyDTO;
  documents: Express.Multer.File[];
  audit: AuditContext;
}): Promise<MetrologieCertificat[] | null> {
  return repoAttachCertificats(params);
}

export async function svcRemoveCertificat(params: { equipement_id: string; certificat_id: string; audit: AuditContext }) {
  return repoRemoveCertificat(params);
}

export async function svcGetCertificatForDownload(params: { equipement_id: string; certificat_id: string; audit: AuditContext }) {
  return repoGetCertificatForDownload(params);
}
