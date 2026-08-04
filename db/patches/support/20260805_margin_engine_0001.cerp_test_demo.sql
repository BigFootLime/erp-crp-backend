-- DEMO SEULEMENT. Ne jamais executer sur cerp_prod.
-- Prerequis navigateur: creer un devis TEST_TD_MARGIN_*, une commande puis un OF,
-- et saisir un pointage + une declaration de rebut depuis l'UI.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Demo margin engine refusee: base attendue cerp_test, base courante %', current_database();
  END IF;
END $$;

-- Les donnees metier TEST_TD_* se creent exclusivement via l'UI.
-- Les hypotheses suivantes se creent via POST /api/v1/margins/rate-versions
-- et POST /api/v1/margins/inputs afin de conserver auteur et journal d'audit.
SELECT
  d.id,
  d.numero,
  d.total_ht,
  count(dl.id) AS line_count
FROM public.devis d
LEFT JOIN public.devis_ligne dl ON dl.devis_id = d.id
WHERE d.numero LIKE 'TEST_TD_MARGIN_%'
GROUP BY d.id, d.numero, d.total_ht
ORDER BY d.id DESC;

SELECT
  o.id,
  o.numero,
  sum(op.temps_total_planned) AS planned_hours,
  sum(op.temps_total_real) AS actual_hours,
  sum(op.hourly_rate_applied * op.temps_total_real) AS traceable_actual_operator_cost
FROM public.ordres_fabrication o
LEFT JOIN public.of_operations op ON op.of_id = o.id
WHERE o.numero LIKE 'TEST_TD_MARGIN_%'
GROUP BY o.id, o.numero
ORDER BY o.id DESC;
