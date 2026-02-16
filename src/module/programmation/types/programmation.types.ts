export type ProgrammationTaskListItem = {
  id: string;
  piece_technique_id: string;
  piece_code: string;
  piece_designation: string;
  client_id: string | null;
  client_company_name: string | null;
  plan_reference: string | null;
  date_commencement: string;
  date_fin: string;
  programmer_user_id: number | null;
  programmer_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type Paginated<T> = {
  items: T[];
  total: number;
};
