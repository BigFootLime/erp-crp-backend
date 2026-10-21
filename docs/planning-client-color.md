# Couleur client commune — planning et dossier OF

Demande et confirmation humaines du 21 octobre 2026 : la couleur du client est commune à tout l’atelier et apparaît en fond pastel dans la case « Client et documents ». Extension du lot PDF `UI-PLANNING-STYLE-20261019` ; proposition de suivi `PDF-CLIENT-COLOR-20261021`. Aucun nouvel état Project Office ou ticket distant n’est prétendu créé.

## Source et API

`clients.planning_color_hex` est l’affectation commune, isolée dans la base choisie. `NULL` rétablit une couleur stable calculée à partir de l’identifiant client. Les noms prédéfinis CRP et Vision Systems conservent une teinte dédiée. Le domaine `planning-client-color.ts` fournit la palette, la résolution et l’éclaircissement des couleurs foncées. Les pastels existants sont conservés ; le rouge d’alerte est refusé.

- `GET /api/v1/planning/client-colors` : dictionnaire `id:<client_id>` → couleur résolue, accès planning `read`.
- `PUT /api/v1/planning/client-colors/:clientId` : `{ "color": "#DCFCE7" }` ou `{ "color": null }`, capacité `manage_schedule`, validation Zod stricte, mise à jour d’un seul client et audit dans la même transaction. Retour `{ "client_id": "…", "color": "…" }`.
- Les événements classiques et tâches centrales exposent la même couleur résolue. Les préférences personnelles historiques restent conservées mais ne pilotent plus la couleur client dans la nouvelle interface.

## PDF et archives

Le gabarit OF 1.9 copie la couleur dans `clientPlanningColor`, dans la transaction de lecture de l’OF. Elle entre dans l’empreinte des données approuvées : un changement entre aperçu et émission impose un nouvel aperçu. Les réimpressions utilisent les éditions figées ; modifier un client ne recolore pas un document déjà émis. Une nouvelle édition reprend la nouvelle couleur. Le code client et l’affaire restent distincts, sans nom ni logo client.

Seul le fond du cartouche est ajouté. La typographie, le bandeau production, les quantités, la nomenclature, le pli et la pagination ne changent pas. Les gabarits 1.4–1.8 gardent leurs empreintes de référence.

## Livraison coordonnée

1. Sauvegarder la base cible avant modification, conformément à la demande de Keenan.
2. Appliquer le patch additif sur Test, puis qualifier l’API avec deux utilisateurs habilités. Il reprend une ancienne préférence seulement si toutes les préférences enregistrées pour ce client concordent ; sinon aucune préférence personnelle ne gagne arbitrairement et la couleur par défaut s’applique. Les anciennes préférences sont conservées.
3. Livrer backend et frontend ensemble. Un ancien frontend peut encore afficher sa préférence locale pendant une livraison partielle.
4. Qualifier puis appliquer le même patch à Prod avec sauvegarde préalable. Ne pas remplacer de données métier. Un retour logiciel peut conserver la colonne additive.

Vérifications locales : tests de résolution/validation, écriture ciblée et audit transactionnel, réinitialisation, erreurs et lecture seule du sélecteur, empreintes PDF historiques, comparaison de tous les caractères/positions/pages pour quatre pastels, aperçu navigateur clair/sombre et 375 px. Les preuves et résultats complets sont remis dans le dossier local `cerp-pdf-style-20261019/proofs/client-color-20261021`. Migration réelle, validation multi-comptes sur Test et déploiement restent à exécuter par la livraison coordonnée.
