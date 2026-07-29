# Facture & avoir — pièces fiscales sur la grammaire CERP

Issue `erp-crp-backend#216` ↔ `crp-systems-web#366` · Décision `ADR-0042`
Applicable à : `src/module/facturation/services/finance-document-render.ts`,
`finance-document.service.ts`, `avoir-document.service.ts`, `pdf.service.ts`

## 1. Pourquoi ces documents restent au serveur

La facture et l'avoir **font foi**. Elles sont conservées, leur contenu est encadré par la loi,
et l'exemplaire émis est **immuable** — le service refuse de le régénérer. Un PDF rendu dans le
navigateur ne peut pas être cet exemplaire : il n'a traversé aucun contrôle serveur, il dépend
du poste et du bundle, et il pourrait différer de ce qui a été envoyé.

C'est la même règle que pour le bon de livraison (ADR-0042, dépôt frontend).

## 2. Un document, un rendu — pour trois chemins

Trois services dessinaient ces pièces, chacun avec sa mise en page :

| Chemin | Produisait |
|---|---|
| `pdf.service.ts` | Brouillons de facture **et** d'avoir |
| `finance-document.service.ts` | Exemplaire légal immuable de la facture |
| `avoir-document.service.ts` | Exemplaire légal immuable de l'avoir |

Un client pouvait donc recevoir un brouillon puis une facture **d'aspect complètement
différent** pour le même montant — couleurs, colonnes et structure changeaient.

Le rendu vit désormais dans `finance-document-render.ts`, appelé par les trois. Les services ne
s'occupent plus que de ce qui les regarde : écriture du fichier, empreinte SHA-256, journal.

## 3. Les mentions obligatoires

### Ce qui a été ajouté

**Ventilation de la TVA par taux** — pour chaque taux appliqué, la base hors taxes et le
montant de taxe. Elle est **entièrement dérivée des lignes** :

- aucun montant n'est recalculé — si le référentiel fournit une taxe à `0.00` pour un taux à
  20 %, le document affiche `0,00 €` ; il ne réapplique jamais un taux de son propre chef ;
- les sommes se font en **centimes entiers** : `0.1 + 0.2` en virgule flottante donne
  `0.30000000000000004`, ce qui se voit au centime sur une facture.

**Identité fiscale des deux parties** — dénomination, adresse, SIRET, SIREN, RCS, n° de TVA
intracommunautaire, capital. Lecture **défensive** de l'instantané, dont la forme appartient au
référentiel : une mention absente **reste absente**, jamais remplacée par un substitut.

L'instantané de l'émetteur ne retenait que `biller_id` et `biller_name` : la facture légale
sortait donc sans adresse ni SIRET, alors que le rendu savait déjà les afficher. Il retient
maintenant une **liste blanche** de champs d'identité fiscale, construite sur `to_jsonb(f)` —
la table `factureur` est historique et sa forme exacte n'appartient pas à ce module. Le SQL
remonte la ligne entière, le code filtre.

**Un brouillon se dénonce comme tel** : statut « Brouillon », drapeau « Ne pas transmettre ».
Imprimée, une facture non émise n'a aucune valeur fiscale.

### Ce qui manque encore, faute de donnée

Ces mentions ne sont **pas** imprimées parce que le référentiel ne les porte pas. Les inventer
serait pire que les omettre :

- **pénalités de retard** et **indemnité forfaitaire de recouvrement de 40 €**
  (art. L441-10 / D441-5 du code de commerce) ;
- **escompte** et conditions de règlement rédigées ;
- **RCS**, **capital social**, **forme juridique** de l'émetteur — le rendu les affiche si les
  colonnes existent et sont renseignées ; rien ne le garantit aujourd'hui.

Elles relèvent d'un **paramétrage d'entité émettrice**, pas du rendu. À arbitrer.

## 4. Format des montants

Le référentiel fournit des chaînes à point décimal (`10465.20`) et le document les sortait
telles quelles avec le code ISO — sur une facture française, et alors que les devis et
commandes rendus dans le navigateur affichent déjà `10 465,20 €` pour la même entreprise.

`money()` et `percent()` ne changent que les **séparateurs** : aucun chiffre n'est modifié, le
signe négatif est conservé (un montant négatif devenu positif ferait mentir la pièce), et une
chaîne qui n'est pas un nombre est rendue telle quelle plutôt que perdue.

## 5. Deux corrections du socle

**`notesSection`** — `section()` réserve 52 pt sous son titre pour ne pas l'orpheliner. Devant
une note courte, cette réserve dépasse la hauteur réelle du bloc : une facture de deux lignes
basculait sur une seconde page **pour 1,1 pt**. `notesSection` mesure le paragraphe avant de
réserver.

**`footerNote`** — la mention de traçabilité (`Instantané immuable <uuid>`) était écrite à la
suite du contenu. Une note de 7 pt suffisait à ouvrir une page entière presque vide. Elle vit
désormais dans la bande du pied de page, portée par **toutes** les pages — ce qui est aussi
plus utile : une page détachée peut être rattachée à son exemplaire d'origine.

## 6. Ce qui ne doit jamais figurer

`ID: <uuid>` du client était imprimé sous la raison sociale, sur une pièce adressée au client.
C'est la **quatrième** occurrence de ce défaut dans la série de documents CERP. Seule la raison
sociale et l'identité fiscale sont imprimées.

Le commentaire interne (`internal_comment`) reste dans l'ERP : seul le texte destiné au client
est repris.

## 7. Vérification

```bash
CERP_PDF_PREVIEW=1 npx vitest run src/module/facturation/services/finance-document-render.test.ts
```

**22 cas.** Le texte est relu **dans les flux de contenu décompressés**, décodés en WinAnsi —
donc ce que le document affiche. Attention en relecture : WinAnsi **n'est pas** latin1 entre
`0x80` et `0x9F`, où logent le tiret cadratin et l'apostrophe typographique.

Couvre : facture émise à deux taux, brouillon, remise globale, 40 lignes paginées, émetteur à
identité réduite, avoir avec motif et facture corrigée, absence d'échéances sur un avoir,
absence de l'identifiant technique du client, accents et tiret cadratin, arithmétique de la
ventilation TVA (regroupement, centimes, non-recalcul).

Suite complète : **2989 tests verts sur 2990**. Le seul échec,
`src/__tests__/surface-finish-210.migration-guards.test.ts`, est **antérieur** à ce chantier —
vérifié en remisant les modifications et en relançant sur `origin/dev` seul.

## 8. Limites

- Aucune recette navigateur.
- **Aucune migration de base**, aucun changement de contrat d'API.
- Les mentions listées au § 3 restent absentes tant que le référentiel ne les porte pas.
