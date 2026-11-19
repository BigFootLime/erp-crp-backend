# Portail Clayens VS et classeur partagé

## Compte, droits et provenance

Le portail emploie les comptes clients existants. Pour consulter les lignes fermes, l’administrateur lie les adresses de livraison à un compte du client. Pour transmettre des demandes au pilote CARCO, il autorise aussi le code de l’établissement de saisie, avec le pilote transactionnel actif.

`GET /api/v1/portal/pieces` recherche sur les lignes des commandes fermes publiées et les sites liés au compte. Les paramètres `q`, `page` et `pageSize` recherchent par sous-chaîne littérale et paginent jusqu’à 50 résultats par page. Le payload inclut les quantités commandées et expédiées, le reliquat, la date de besoin ERP, le jalon de production et les engagements par quantité. Les expéditions groupées utilisent les allocations prouvées du BL, avec repli sur le rattachement de ligne pour les anciens BL. Les engagements requièrent la preuve du site. La fin atelier est affichée si des OF racines planifiés ou en cours avec une date future ou du jour couvrent le reliquat.

Tester le compte et les vues avec le rôle PostgreSQL de l’API sur la cible de recette. Le scénario local a utilisé le rôle propriétaire de la base jetable. En production, le rôle doit disposer des lectures déjà utilisées par les modules commande, BL, OF et promesses.

## Coédition et traitement CERP

1. Mettre le classeur **Suivi des échéances** sur le OneDrive professionnel convenu. Restreindre l’édition aux personnes nommées côté client et CRP. Activer la coédition Excel et la disponibilité locale sur le poste qui exécutera le pont.
2. Dédier un compte **portail client** au pont. Autoriser uniquement l’établissement de saisie du classeur. Charger les identifiants depuis le coffre de l’hôte via `CERP_CLAYENS_SYNC_EMAIL` et `CERP_CLAYENS_SYNC_PASSWORD`.
3. Lancer le pont depuis le dépôt backend compilé avec l’URL de l’API autorisée et le chemin absolu du fichier local synchronisé.

```powershell
node scripts/integrations/clayens-onedrive.mjs --api https://<hote-cerp>/api/v1 --site <etablissement> --workbook '<classeur.xlsx>' --watch
```

Le pont relit le classeur stable toutes les 30 secondes. Il transmet les lignes prêtes selon `TRANSMETTRE=OUI` et rejoue le même dépôt en sécurité en cas de nouvel essai. Pour modifier une ligne, passer sa colonne **TRANSMETTRE** à **NON**, préparer les changements, puis repasser à **OUI**. Sans `--watch`, la commande vérifie le fichier et la réponse CERP une fois. Un échec d’authentification arrête le pont. Un verrou ou un transfert temporairement incomplet est repris au cycle suivant.

Dans **Commandes clients → Imports et demandes client**, l’ADV contrôle les écarts, qualifie les rattachements ambigus et transmet les lignes prêtes dans la boîte de décision. Une nouvelle date ferme est une demande jusqu’à la décision et son application ERP. Le retour `<nom-du-classeur>.Retour-CERP.csv` est publié à côté du classeur quand le relevé correspondant a été traité. Il porte `VERSION_EXPORT`, `DEMANDE_CRP`, `DATE_CONF` et la ventilation des engagements. Vérifier la version du CSV après la transmission d’une nouvelle demande. Le pont écrit le retour par remplacement atomique et ouvre le XLSX en lecture seule afin de préserver la coédition.

Pour un dépôt manuel, utiliser le même onglet **Demandes** du portail. Chaque export concerne un seul établissement. Le contrat est requis pour les prévisions. L’envoi d’une demande d’AR et le classeur partagé sont des relevés partiels, même si la case « carnet exhaustif » a été cochée par inadvertance.

La coédition de l’entreprise et ses autorisations de partage relèvent du tenant Microsoft 365. Le pont a été éprouvé avec un fichier local et une API de recette.

[Documentation Microsoft sur la coédition Excel](https://support.microsoft.com/en-us/excel/get-started/collaborate-on-excel-workbooks-at-the-same-time-with-co-authoring)
