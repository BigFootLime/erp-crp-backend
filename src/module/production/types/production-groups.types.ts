export type ProductionGroup = {
  id: string;
  code: string;
  client_id: string | null;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_label: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
};

export type ProductionGroupListItem = Pick<
  ProductionGroup,
  "id" | "code" | "client_id" | "piece_technique_id" | "piece_code" | "piece_label" | "description" | "updated_at"
> & {
  linked_affaires_count: number;
  linked_ofs_count: number;
};

export type AffaireLite = {
  id: number;
  reference: string;
  client_id: string;
  commande_id: number | null;
  devis_id: number | null;
  statut: string;
  type_affaire: string;
  updated_at: string;
};

export type OfLite = {
  id: number;
  numero: string;
  affaire_id: number | null;
  commande_id: number | null;
  client_id: string | null;
  piece_technique_id: string;
  piece_code: string;
  piece_designation: string;
  statut: string;
  priority: string;
  updated_at: string;
};

export type ProductionGroupDetail = {
  group: ProductionGroup;
  affaires: AffaireLite[];
  ofs: OfLite[];
};
