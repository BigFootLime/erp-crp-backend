export type ClientLite = {
  client_id: string;
  company_name: string;
  email?: string | null;
  phone?: string | null;
  delivery_address_id?: string | null;
  bill_address_id?: string | null;
};

export type DocumentClient = {
  id: string;
  document_name: string;
  type?: string | null;
  creation_date?: string | null;
  created_by?: string | null;
};
