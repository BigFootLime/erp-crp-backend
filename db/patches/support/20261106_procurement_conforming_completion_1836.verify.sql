SELECT md5(replace(p.prosrc,E'\r',''))='28cdd52fec5aae7cd2297cc4ed5373f6' AS conforming_guard_installed
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='guard_subcontract_completion_1273' AND p.pronargs=0;
