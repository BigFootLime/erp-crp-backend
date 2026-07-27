\set ON_ERROR_STOP on

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback #169 is restricted to cerp_test';
  END IF;
END
$guard$;

ALTER TABLE public.commande_ligne
  DROP CONSTRAINT commande_ligne_article_fabrique_fk,
  ADD CONSTRAINT commande_ligne_article_fabrique_fk
    FOREIGN KEY (article_id)
    REFERENCES public.articles_fabrique(article_id)
    NOT VALID;

ALTER TABLE public.commande_cadre_release_ligne
  DROP CONSTRAINT commande_cadre_release_ligne_article_fabrique_fk,
  ADD CONSTRAINT commande_cadre_release_ligne_article_fabrique_fk
    FOREIGN KEY (article_id)
    REFERENCES public.articles_fabrique(article_id)
    NOT VALID;

ALTER TABLE public.ordres_fabrication
  DROP CONSTRAINT ordres_fabrication_article_fabrique_fk,
  ADD CONSTRAINT ordres_fabrication_article_fabrique_fk
    FOREIGN KEY (article_id)
    REFERENCES public.articles_fabrique(article_id)
    NOT VALID;

COMMIT;
