-- Candidats 20260729_methodes_gamme_referentials — LECTURE SEULE, AUCUNE ÉCRITURE.
--
-- Le patch ne devine AUCUNE famille machine. `machines.type` est un enum
-- technique (MILLING, TURNING, EDM, GRINDING, OTHER) qui ne distingue pas une
-- machine à commande numérique d'une machine conventionnelle : `TURNING` peut
-- être un tour CN (`T`) comme un tour conventionnel (`TTRAD`). Un backfill
-- automatique fabriquerait donc une donnée fausse, et ADR-0020 l'interdit
-- explicitement (« ne pas déduire depuis le code machine »).
--
-- Ce rapport propose une PISTE à trancher par les Méthodes, machine par machine.
-- Rien n'est appliqué : la colonne `machine_family_code` reste NULL tant qu'un
-- humain n'a pas décidé, et l'interface affiche « famille non renseignée ».

SELECT
  m.code,
  m.name,
  m.type::text                                     AS type_technique,
  m.status::text                                   AS statut,
  m.is_available                                   AS disponible,
  m.machine_family_code                            AS famille_actuelle,
  CASE m.type::text
    WHEN 'TURNING'  THEN 'T ou TTRAD — à trancher : CN ou conventionnel ?'
    WHEN 'MILLING'  THEN 'F ou FTRAD — à trancher : CN ou conventionnel ?'
    WHEN 'EDM'      THEN 'famille dédiée à créer (le référentiel est extensible)'
    WHEN 'GRINDING' THEN 'famille dédiée à créer (le référentiel est extensible)'
    ELSE                 'aucune piste — décision Méthodes'
  END                                              AS piste_a_valider,
  m.legacy_alias                                   AS alias_clipper,
  m.hourly_rate                                    AS taux_machine_actuel,
  m.hourly_rate_source                             AS provenance_taux,
  m.hourly_rate_effective_at                       AS date_effet_taux
FROM public.machines m
WHERE m.archived_at IS NULL
ORDER BY m.type::text, m.code;

-- Machines dont le taux horaire pourrait alimenter un premier tarif de centre
-- de frais. Rappel ADR-0020 §6 : une valeur non nulle exige une provenance ET
-- une date d'effet ; `0` n'est jamais créé pour remplacer une inconnue.
SELECT
  m.code,
  m.name,
  m.hourly_rate,
  m.currency,
  m.hourly_rate_source,
  m.hourly_rate_effective_at,
  m.hourly_rate_is_override,
  CASE
    WHEN m.hourly_rate IS NULL                       THEN 'inconnu — ne rien créer'
    WHEN m.hourly_rate = 0                           THEN 'zéro suspect — ne rien créer sans décision'
    WHEN m.hourly_rate_source IS NULL                THEN 'provenance manquante — à qualifier avant reprise'
    WHEN m.hourly_rate_effective_at IS NULL          THEN 'date d''effet manquante — à qualifier avant reprise'
    ELSE 'reprise possible vers production_cost_center_rates après affectation d''un centre de frais'
  END                                                AS verdict
FROM public.machines m
WHERE m.archived_at IS NULL
ORDER BY m.code;

-- Opérations de gamme existantes : ce que la reprise devra arbitrer.
SELECT
  o.id::text            AS operation_id,
  o.gamme_id::text      AS gamme_id,
  o.phase,
  o.designation,
  o.type_operation,
  o.machine_id::text    AS machine_id,
  o.cf_id::text         AS cf_id,
  o.taux_horaire,
  o.tp                  AS temps_preparation_heures,
  o.tf_unit             AS temps_unitaire_heures,
  o.qte,
  o.coef,
  o.temps_total         AS temps_final_heures,
  -- Écart entre l'ancienne formule `(tp + tf×qte) × coef` et la formule cible
  -- `tp + tf×qte×coef`. Non nul uniquement lorsque coef <> 1 ET tp <> 0.
  round((o.tp + o.tf_unit * o.qte) * o.coef, 4)      AS temps_final_ancienne_formule,
  round(o.tp + o.tf_unit * o.qte * o.coef, 4)        AS temps_final_formule_cible,
  round(((o.tp + o.tf_unit * o.qte) * o.coef) - (o.tp + o.tf_unit * o.qte * o.coef), 4)
                                                     AS ecart_heures
FROM public.pieces_techniques_operations o
ORDER BY o.gamme_id NULLS LAST, o.phase;
