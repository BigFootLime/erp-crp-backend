# Changelog

## Supplier receipt fee completeness — #1010

- Cap declared subcontract receipt flat fees by cumulative rounded allocation; exact six-decimal residual across partial/overreceipts.
- Unallocated transport and invalid/unsupported price facts remain explained UNKNOWN amounts; approved invoice evidence stays distinct.
- No physical, historical snapshot, Stock journal or CUMP change. Combined acceptance fixtures/scenarios prepared NOT RUN.

## Valeur actuelle du stock documentée — #1007

- Correction financière entreprise EUR, justificatif article et empreinte du solde, quantité physique inchangée. Historique immuable, idempotence et contrôle financier existant.
- Écriture DECLARED et solde atomiques sous verrou global CUMP ; valeur historique inconnue conservée. Aucune ventilation de facture tardive ni activation.
- Migration/requêtes/retour arrière compilés dans ROLLBACK sur Test/Prod, gardes #983 conservées ; recette commune préparée NON EXÉCUTÉE.
