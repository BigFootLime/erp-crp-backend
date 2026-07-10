-- Module « Project Office » — contenu binaire (base64) des captures & exports du rapport.
-- Issue #130. ADDITIF + IDEMPOTENT. Pourquoi en DB : le backend tourne sur deux déploiements
-- (VPS Coolify + atelier) avec des disques distincts ; seule la base est partagée. Pattern
-- identique aux exports paie Temps & Déplacements (base64 + checksum vérifié au download).
-- Les captures sont servies par endpoint authentifié + gate (jamais en statique public).

ALTER TABLE public.project_report_assets  ADD COLUMN IF NOT EXISTS content_base64 text NULL;
ALTER TABLE public.project_report_assets  ADD COLUMN IF NOT EXISTS checksum text NULL;
ALTER TABLE public.project_report_exports ADD COLUMN IF NOT EXISTS file_base64 text NULL;
