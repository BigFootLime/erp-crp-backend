export type ClientContractArticle = {
  article_id:string; root_article_id:string; code:string; designation:string;
  piece_technique_id:string; piece_technique_version_id:string; indice:string;
  unit_id:string; unit:string;
};
export type ClientContractLine = {
  id:string; article_id:string; root_article_id:string; replenishment_qty:string;
  unit_id:string; unit:string; configured_code:string; configured_designation:string;
  configured_indice:string; configured_piece_technique_version_id:string;
  proposed_article:ClientContractArticle|null;
};
export type ClientContract = {
  id:string; client_id:string; reference:string; title:string;
  status:"DRAFT"|"ACTIVE"|"CLOSED"; valid_from:string|null; valid_until:string|null;
  version:number; updated_at:string; lines:ClientContractLine[];
};
export type ClientContractResult={event_id:string; contract:ClientContract};
