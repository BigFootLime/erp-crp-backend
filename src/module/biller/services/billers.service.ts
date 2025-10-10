// src/module/billers/services/billers.service.ts
import { repoListBillers } from "../repository/billers.repository";
export const svcListBillers = (q = "") =>
  repoListBillers(q).then(rows => rows.map(r => ({ id: r.biller_id, value: r.biller_id, label: r.biller_name })));
