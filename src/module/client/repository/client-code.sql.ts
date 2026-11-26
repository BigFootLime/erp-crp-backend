export const CLIENT_CODE_SQL = `COALESCE(
  NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
  NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
)`;

export const CLIENT_CODE_ORDER_SQL = `
  CASE WHEN ${CLIENT_CODE_SQL} ~* '^(CLI[- ]?)?[0-9]+$'
       THEN substring(${CLIENT_CODE_SQL} FROM '[0-9]+$')::numeric END ASC NULLS LAST,
  lower(${CLIENT_CODE_SQL}) ASC NULLS LAST,
  lower(c.company_name) ASC,
  c.client_id ASC
`;
