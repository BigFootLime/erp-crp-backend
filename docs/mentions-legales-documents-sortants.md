# Mentions légales des documents sortants

Toute pièce commerciale émise par CERP porte désormais l'identité légale de son émetteur et
ses mentions obligatoires : facture, avoir, bon de livraison, certificat de conformité et
accusé de réception de commande.

Fait suite au rendu unique des pièces financières (#216) et du bon de livraison (#213).

## Le défaut

Le rendu était prêt à afficher SIRET, SIREN, RCS, numéro de TVA et capital social — il ne
les inventait simplement pas. Trois constats, relevés le 2026-07-29 :

1. **`public.factureur` ne porte aucune colonne légale.** Le serveur lisait
   `to_jsonb(factureur)` puis filtrait sur une liste blanche contenant `siret`, `siren`,
   `rcs`, `vat_number` et `capital_social`. Aucune de ces colonnes n'existe : le filtre ne
   retenait jamais rien.
2. **`public.factureur` est vide** sur `cerp_test` comme sur `cerp_prod`. Le bloc
   « Émetteur » sortait « Non renseigné », et l'émission aurait levé
   `503 FINANCE_ISSUER_NOT_CONFIGURED` dès la première facture.
3. **L'instantané ne figeait que `biller_id` et `biller_name`.** Même alimenté, il n'aurait
   rien porté d'opposable.

Le bon de livraison et le pack COFC lisaient `biller_name` seul ; l'accusé de réception ne
lisait rien du tout. Chaque module avait sa propre idée de l'émetteur.

## Ce que la loi exige

| Mention | Fondement | Champ |
|---|---|---|
| Forme juridique, capital social | art. R123-237 C. com. | `legal_form`, `share_capital` |
| RCS **et ville d'immatriculation** | art. R123-237 C. com. | `rcs_city`, `rcs_number` |
| SIREN / SIRET | art. R123-237 C. com. | `siren`, `siret` |
| N° de TVA intracommunautaire | art. 242 nonies A ann. II CGI | `vat_number` |
| Pénalités de retard | art. L441-10 C. com. | `late_penalty_rate`, `late_penalty_basis` |
| Indemnité forfaitaire de recouvrement (40 €) | art. D441-5 C. com. | `recovery_indemnity` |
| Escompte, **même en son absence** | art. L441-9 C. com. | `early_discount_rate` |
| « TVA non applicable, art. 293 B du CGI » | art. 293 B CGI | `vat_exempt_293b` |
| « TVA acquittée sur les encaissements » | art. 269-2 CGI | `vat_on_receipts` |
| Réserve de propriété | loi du 12 mai 1980 | `retention_of_title` |

## Où vit la donnée

`public.finance_legal_mentions`, **versionnée par période de validité**, et non des colonnes
sur `factureur`.

Un taux de pénalité, un capital ou une ville de RCS changent. Une facture émise doit porter
les mentions en vigueur **à sa date d'émission**, et elle est immuable. Des colonnes sur
`factureur` seraient réécrites en place et falsifieraient rétroactivement l'historique. Ici,
une modification ouvre une nouvelle version : les instantanés déjà figés continuent de
résoudre la leur.

`fn_finance_issuer_snapshot(biller_id, date)` résout identité opérationnelle et mentions
applicables en un seul objet JSON, destiné à être figé tel quel. C'est le **seul** point de
vérité, partagé par tous les documents.

Le patch additif
`20260729_finance_legal_mentions_hardening_221.sql` interdit en outre tout chevauchement
de périodes pour un même émetteur, y compris en cas d'écritures concurrentes, et rend le
choix de la version applicable explicitement déterministe. Le premier patch avait déjà été
appliqué sur `cerp_test` au moment de cette revue : il n'a donc pas été réécrit.

Les montants et taux sortent en **texte** : le rendu met en forme, il ne calcule pas.
`jsonb_strip_nulls` garantit qu'une mention absente est absente de l'instantané, et non
présente à `NULL` — le rendu n'affiche jamais de substitut à une mention manquante.

## Quand les mentions sont figées

À l'**émission**, pas à la création du brouillon. Un brouillon peut vivre des semaines ; si
un taux change entre-temps, la facture doit porter ce qui est en vigueur le jour où elle est
émise. `svcIssueFacture` et `svcIssueAvoir` re-résolvent donc l'instantané à `issueDate`,
l'écrivent dans le document **et** le réenregistrent sur la ligne : sans cela,
`facture.issuer_snapshot` et le PDF émis diraient deux choses différentes de la même pièce.

Un avoir résout ses propres mentions à sa date d'émission plutôt que d'hériter de celles de
la facture corrigée : c'est lui-même une pièce fiscale.

Facture et avoir refusent désormais l'émission avant toute consommation d'un numéro légal
si la version applicable ou l'une des mentions obligatoires manque. La ligne métier conserve
ensuite le même `issuer_snapshot` que l'instantané immuable et le PDF.

## Où les mentions apparaissent

Dans la **bande de pied**, sur toutes les pages — jamais dans le flux du contenu.

C'est la disposition de la facture papier de l'entreprise : le bloc « Émetteur » en tête
porte l'adresse et le téléphone, le pied porte capital, RCS, SIRET et TVA. Trois raisons :

- placées à la suite du contenu, elles poussaient un bon de livraison de deux lignes sur une
  seconde page qui ne portait qu'elles — le cadre de réception occupe déjà le bas de page ;
- une mention obligatoire ne doit jamais coûter une page ;
- répétée à chaque page, elle reste opposable sur une page détachée.

La hauteur de la bande est **mesurée** sur le texte réel, jamais forfaitaire : une clause de
réserve de propriété longue chevaucherait sinon la dernière ligne du contenu, et une mention
illisible est une mention absente.

Deux pièges de pdfkit sont traités dans `shared/pdf/cerp-document.ts` :

- pdfkit **ouvre une page** dès qu'un texte susceptible de revenir à la ligne dépasse
  `maxY()`. Un pied vit par définition sous la marge basse : la marge est donc suspendue le
  temps de le dessiner. Sans cela, chaque document gagnait une page vide.
- pdfkit **justifie en positionnant les mots** au lieu d'écrire les espaces. Le texte extrait
  revenait collé (« Pénalitésderetard:12,5% »). Les mentions sont donc rendues fer à gauche :
  une mention légale doit rester lisible par une machine — copier-coller, indexation,
  contrôle automatisé.

## Conséquence sur la pagination

La bande coûte de la hauteur de contenu à chaque page. Un document déjà au bord gagne une
page. Le gabarit `FACTURE` des tests était à moins de 10 pt de la limite **avant** ce
changement : sa seule ligne d'identité légale suffit à le faire paginer. C'est le contenu qui
remplit la page, pas les mentions — mais l'effet est visible et assumé.

## Périmètre

| Document | Identité légale | Mentions | Rendu |
|---|---|---|---|
| Facture | ✅ | ✅ + RIB | grammaire CERP |
| Avoir | ✅ | ✅ sans RIB — un avoir ne se règle pas | grammaire CERP |
| Bon de livraison | ✅ | ✅ | grammaire CERP |
| Certificat de conformité | ✅ | ✅ | grammaire CERP |
| Accusé de réception de commande | ✅ | ✅ | grammaire CERP |

L'accusé de réception a rejoint `renderCerpDocument` pendant la revue #221 : le référentiel
est résolu à la date de génération de l'artefact, la table est paginée par le socle et le
pied répète les mentions sur chaque page comme les autres documents.

Devis, commande et bon de commande sont rendus dans le navigateur (ADR-0039/0040) : ils
relèvent du dépôt `crp-systems-web` et ne sont pas couverts ici.

## Tolérance à l'absence de patch

Tant que `20260729_finance_legal_mentions.sql` n'est pas appliqué, la fonction n'existe pas
(`42883`) et `readIssuerParty` retombe sur l'identité opérationnelle seule pour les
documents non fiscaux et les aperçus. L'émission d'une facture ou d'un avoir, elle, échoue
explicitement : un exemplaire fiscal immuable sans mentions ne doit jamais être créé.

## Vérification

`src/module/facturation/services/finance-document-render.test.ts` — 42 cas, dont 20 ajoutés
pour les mentions. `src/module/livraisons/services/pack-pdf.service.test.ts` — 18 cas.

Le texte est relu dans les **flux de contenu décompressés** du PDF, décodés en WinAnsi : on
vérifie ce que le document affiche, pas ce que le code croit avoir écrit. Sont couverts la
présence de chaque mention obligatoire, l'absence de mention inventée quand le référentiel
est muet, l'énoncé explicite de l'absence d'escompte, la franchise 293 B, la répétition sur
chaque page, l'extractibilité du texte, et le fait que l'instantané figé prime sur le
paramétrage courant.

`CERP_PDF_PREVIEW=1` écrit les PDF dans `outputs/pdf-preview` pour inspection visuelle.
