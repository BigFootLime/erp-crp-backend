import type {ClientContractArticle} from './client-contract.types';
export type ClientContractForecast={id:string;contract_id:string;contract_line_id:string;root_article_id:string;unit_id:string;
  article_snapshot:ClientContractArticle;month:string;quantity:string;converted_quantity:string;remaining_quantity:string;delivery_due:string;estimate_date:string;
  status:'ACTIVE'|'CANCELLED';version:number;created_at:string;updated_at:string;updated_by:number;actor_label:string};
export type ClientForecastResult={event_id:string;forecast:ClientContractForecast};
