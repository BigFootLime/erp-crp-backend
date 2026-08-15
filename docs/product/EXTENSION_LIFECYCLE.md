# Cycle de vie des extensions et dépréciations

## Transformer une demande spécifique

1. **Observer** : décrire le travail, la fréquence, l'acteur et la preuve sans
   promettre d'implémentation.
2. **Classer** : appliquer `FEATURE_ACCEPTANCE_GRID.md` et choisir noyau, extension,
   expérience, report ou refus.
3. **Définir la frontière** : conserver une API et un modèle communs ; isoler les
   écarts par configuration validée ou adaptateur versionné. Aucun fork client.
4. **Contractualiser** : fixer prix, données, SLO, support, propriétaire et sortie.
5. **Construire petit** : livrer le flux minimal, flag faux par défaut si
   expérimental, audit et tests négatifs compris.
6. **Promouvoir** : test puis production seulement après release gate, migration
   réversible et runbook.
7. **Mesurer** : usage et coût à 30/90 jours puis dans la revue trimestrielle.

Les flags servent à contrôler un rollout temporaire, pas à maintenir indéfiniment
plusieurs produits. Chaque flag a un propriétaire, une valeur production explicite,
une date de retrait et des tests dans les deux états.

## Revue trimestrielle du coût de support

Pour chaque module, le propriétaire consigne sur le trimestre :

- clients et utilisateurs actifs, opérations métier et dernière utilisation ;
- tickets, incidents, gravité, temps de diagnostic et de résolution ;
- temps d'assistance, formation et corrections manuelles ;
- coût d'infrastructure et dépendances externes ;
- dette de sécurité, migrations en attente et couverture de tests ;
- revenu, contrat ou risque évité associé.

Chaque mesure porte unité, période, source, fraîcheur et fiabilité. Les données
incomplètes sont marquées `PARTIELLE` ou `INDISPONIBLE`. La revue produit un
propriétaire et une décision datée.

## Déprécier puis retirer

1. ouvrir une décision avec usage mesuré, motif, propriétaire et alternative ;
2. vérifier obligations contractuelles, conservation, export et dépendances ;
3. annoncer une échéance proportionnée aux contrats et identifier les utilisateurs
   concernés ;
4. bloquer les nouvelles activations avant de retirer l'existant ;
5. fournir export, migration, rollback et support de transition ;
6. instrumenter l'usage résiduel sans PII et tester l'absence de consommateurs ;
7. retirer code, routes, permissions, jobs, données de référence et documentation
   morte dans une PR dédiée ;
8. conserver les données requises ou les supprimer selon la politique approuvée ;
9. valider release, sauvegarde/restauration, comportement métier et communication ;
10. clore seulement après une période d'observation sans appel résiduel.

## Actions interdites

- supprimer une donnée ou une API sans inventaire des consommateurs et sauvegarde ;
- laisser un endpoint déprécié non surveillé sans date de fin ;
- facturer une extension que l'exploitation ne sait ni diagnostiquer ni restaurer ;
- contourner RBAC, audit ou validation pour isoler une variante client ;
- présenter un usage manquant comme nul.

Le rollback d'un retrait restaure une version applicative compatible et, si le
schéma a changé, la sauvegarde ou migration inverse testée. Un flag ne remplace pas
la compatibilité des données.
