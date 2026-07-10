# T10 — Validation E2E sur cerp_test

## Ce qui est prouvé automatiquement (niveau service/DB)

Chaîne complète exercée sur cerp_test en une transaction `BEGIN…ROLLBACK` (0 résidu) —
`scratchpad/t10_e2e_chain.sql` :

```
A POINTAGE→MINUTES: worked=420 brk=60 (attendu 420 / 60)
B CORRECTION: approuvée_par_tiers=t
C VALIDATION: jour+semaine=t
D KILOMETRES: validés=t
E EXPORT: lot créé (matches=1)
F BORNE_AUTH: matches=1
G BADGE_RESOLVE: matches=1
residus_emp = 0 ; residus_user = 0
```

+ smokes par tranche (T2 idempotence/append-only, T4 self-approve, T5 résolution règles, T6 km, T7 export,
T8 borne/badge). Le modèle événement→minutes, les transitions d'état, les contraintes (append-only,
one-active, no-self-approve) et la résolution borne/badge sont donc validés côté données.

## Blocage — validation NAVIGATEUR

La validation navigateur complète nécessite le **backend T2+ exécuté contre cerp_test**. Il n'est
aujourd'hui déployé nulle part (l'atelier sert le backend de prod). Deux options, toutes deux **hors
périmètre « code sur dev »** ⇒ **validation humaine / infra** :

1. Déploiement temporaire d'une instance backend (`origin/dev`) avec un `.env` pointant cerp_test
   (nécessite le mot de passe `cerp_app` — non manipulé par l'agent).
2. Exécution locale via tunnel SSH vers la base atelier (même prérequis d'identifiants).

Tant que ce prérequis n'est pas levé, l'E2E navigateur reste **gated**. Le front (déployé) n'expose pas
`/time-clock` côté prod : normal.

## Procédure (une fois le backend déployé sur cerp_test)

1. `psql -f db/seeds/temps-deplacements-e2e-seed.sql` (crée employé `TEST_TD_EMP`, manager, règle 35h,
   contrat, badge `TEST_TD_BADGE`, borne token `TEST_TD_TOKEN`). Définir les mots de passe applicatifs
   des comptes de test hors seed.
2. Dérouler les 20 scénarios ci-dessous.
3. `psql -f db/seeds/temps-deplacements-e2e-cleanup.sql` (purge, superuser — événements append-only).

## 20 scénarios navigateur

Salarié (`test_td_emp`) :
1. Login → menu « Temps & Déplacements » visible.
2. Mon pointage : pointer Entrée → toast succès, point vert.
3. Pointer Pause puis Retour → temps de pause affiché.
4. Pointer Sortie → journée calculée (temps travaillé cohérent).
5. Double-clic Entrée < 90 s → « double badge » (orange), pas de doublon.
6. Mon relevé : jour + semaine (cible 35h, HS/absence corrects).
7. Mes anomalies : liste vide/pertinente selon le pointage.
8. Mes kilomètres : déclarer un trajet (brouillon) → apparaît en DRAFT.
9. Soumettre le trajet → statut SUBMITTED.
10. Tentative d'accès « Administration RH » → « espace réservé » (gate rôle).

Responsable (`test_td_mgr`, Directeur) :
11. Équipe du jour : voir `TEST_TD_EMP` + KPIs.
12. Corrections à valider : approuver une demande → disparaît de la liste.
13. Refuser une autre demande → statut REJECTED.
14. Kilomètres équipe : valider le trajet soumis (10→SUBMITTED) → VALIDATED.
15. Administration RH · Règles : créer une règle 39h.
16. Administration RH · Contrats : créer un 2ᵉ contrat actif → erreur « contrat actif existe déjà ».
17. Administration RH · Horaires : ajouter/supprimer un horaire.
18. Administration RH · Bornes : créer une borne → **jeton affiché une seule fois** ; désactiver.
19. Administration RH · Exports : générer un CSV, télécharger → fichier `;`+BOM, checksum affiché.
20. Borne de pointage : saisir `TEST_TD_TOKEN`, sélectionner Entrée, « taper » `TEST_TD_BADGE`+Entrée →
    feedback **vert** ; badge inconnu → **rouge**.

## Critère de succès

20/20 verts, aucune fuite de secret (jeton/UID) à l'écran ou en console, `cleanup` → 0 reste.
