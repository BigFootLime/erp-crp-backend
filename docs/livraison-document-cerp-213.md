# Documents PDF sortants côté serveur — bon de livraison & certificat de conformité

Issue `erp-crp-backend#213` ↔ `crp-systems-web#363` · Décision `ADR-0042`
Applicable à : `src/shared/pdf/`, `src/module/livraisons/services/`

## 1. Pourquoi ces deux documents restent au serveur

Cinq documents CERP sont rendus dans le navigateur (fiche client, fiche fournisseur, bon de
commande fournisseur, devis, récapitulatif de commande). Le bon de livraison et le certificat
de conformité ne le sont pas, et ne doivent pas l'être : le module Livraisons les **fige** — il
les génère, les hache en SHA-256, les archive dans la GED, les versionne et permet de les
révoquer.

Un PDF rendu dans le navigateur ne peut pas être l'original archivé : il n'a traversé aucun
contrôle serveur, il dépend du poste et du bundle, et il pourrait différer de ce qui a été
envoyé. Le raisonnement complet est dans l'ADR-0042 du dépôt frontend
(`docs/adr/ADR-0042-document-serveur-fige.md`).

## 2. Ce qui est partagé avec le frontend : la grammaire, pas le code

`@react-pdf/renderer` construit un arbre React ; `pdfkit` dessine impérativement. Il n'existe
pas de socle de code commun aux deux.

Ce qui est partagé est la **grammaire**, portée ici par `src/shared/pdf/cerp-document.ts`,
miroir déclaré de `crp-systems-web/src/design-system/pdf/document-kit.tsx` :

| Élément | Règle |
|---|---|
| Page | A4, marges 38, 34 en tête, 54 réservés au pied |
| Palette | `#B90101` (rouge officiel prélevé sur le logo) comme **unique** accent ; le reste en encre, anthracite, gris neutres |
| En-tête | 3 zones — logo officiel · identité (titre, code, statut, drapeau) · réserve de logo tiers, toujours dessinée |
| Bandeau | Identifiants sur fond gris, ce qu'un lecteur cherche en premier |
| Sections | Capitales espacées + filet, avec une réserve de cohésion pour ne pas orpheliner le titre |
| Table | En-tête de colonnes réémis sur chaque page traversée ; une ligne n'est jamais coupée |
| Pied | Émetteur · date de génération · « Page X / Y » |

**Un écart de rendu entre les deux familles est un défaut, pas une variante.**

### Le logo est embarqué, pas lu sur disque

`src/shared/pdf/cerp-logo.ts` contient le PNG officiel en base64. `tsc` ne copie pas les
binaires dans `dist/` : un chemin résolu au runtime fonctionnerait en développement et
casserait silencieusement après build.

### « Page X / Y » impose `bufferPages`

Connaître le total exige de repasser sur les pages une fois le contenu écrit.
`renderCerpDocument` ouvre le document avec `bufferPages: true`, laisse le module écrire ses
sections, puis parcourt `bufferedPageRange()` pour dessiner le rappel d'identité (pages ≥ 2) et
le pied de page.

### `characterSpacing` est une option de texte, pas une méthode

pdfkit n'expose pas `doc.characterSpacing(n)`. L'interlettrage se passe par
`doc.text(s, x, y, { characterSpacing: n })`, et **`widthOfString` doit recevoir la même
option** pour mesurer juste — sinon tout ce qui est aligné à droite ou centré dérive.

## 3. Un document, un rendu

Deux services produisaient le bon de livraison, chacun avec sa mise en page : la génération
simple (`POST /livraisons/:id/pdf`, `pdf.service.ts`) et le pack figé (`pack-pdf.service.ts`).
Le client pouvait recevoir deux bons d'aspect différent pour la même expédition.

Le rendu vit désormais dans `bon-livraison-document.ts`, appelé par les deux. À donnée égale,
les deux chemins produisent **le même binaire** — vérifié par un test, pas par relecture.

`pdf.service.ts` ne s'occupe plus que du versionnement, du stockage, de l'empreinte et du
journal.

### Disponibilité et génération sont deux opérations distinctes

- `GET /livraisons/:id/pdf/availability` indique si une archive lisible existe, sans créer de
  fichier ni de version. Une absence ordinaire renvoie `NOT_GENERATED` ; une archive référencée
  mais absente ou invalide reste une erreur d'intégrité explicite.
- `GET /livraisons/:id/pdf?version=N` est strictement en lecture : il sert uniquement une version
  déjà archivée et ne régénère jamais silencieusement un document manquant.
- `POST /livraisons/:id/pdf` est la seule opération de génération. Elle exige la capacité
  `documents_manage` et une clé `Idempotency-Key`. Un verrou sur le BL sérialise les demandes
  concurrentes ; la même intention rejouée rend la même version, une nouvelle intention crée la
  version suivante. Ses archives `GENERATED_SIMPLE_BL_PDF` restent séparées des BL du pack
  figé (`GENERATED_BL_PDF`), dont le cycle de version est autonome.

Les réponses PDF et de disponibilité portent `Cache-Control: private, no-store` afin qu'un
navigateur ou un proxy ne réutilise pas un état d'autorisation ou une version obsolète.

## 4. Ce qui ne doit jamais figurer sur ces documents

| Fuite trouvée | Corrigé en |
|---|---|
| `ID: <uuid>` du client sous la raison sociale | Raison sociale seule |
| `OUT`, `POSTED` bruts sur le certificat | « Sortie », « Comptabilisé » |
| `commentaire_interne` | Reste absent (il l'était déjà) |

Un code de mouvement absent du dictionnaire est rendu **tel quel** : un libellé brut vaut mieux
qu'une traduction inventée. `commentaire_client`, lui, était saisi mais jamais imprimé — c'est
maintenant le cas.

## 5. Encodage : WinAnsi couvre le français

L'ancienne version écrivait « Numero », « Designation », « CERTIFICAT DE CONFORMITE ». Les
polices standard PDF sont encodées en **WinAnsi**, qui contient l'intégralité des accents
français. La précaution était inutile.

Ce qui doit rester surveillé, ce sont les caractères **hors** WinAnsi — `toPdfSafeText` les
substitue : signe moins typographique `−` (qui, silencieusement supprimé, transformerait une
remise en montant positif), signe de diamètre `⌀`, `≤ ≥ ≠ ≈`, flèches, espaces insécables
fines, caractères de largeur nulle.

Attention en relecture : WinAnsi **n'est pas** latin1 entre `0x80` et `0x9F`. C'est là que
logent le tiret cadratin (`0x97`), l'apostrophe typographique et les guillemets. Lire un flux
PDF en latin1 les fait disparaître et donne l'illusion d'une perte de donnée.

## 6. Vérification

`src/module/livraisons/services/pack-pdf.service.test.ts` — **premier harnais de test PDF du
dépôt**, 15 cas. `CERP_PDF_PREVIEW=1` écrit les rendus dans `outputs/pdf-preview` (ignoré par
git) pour inspection visuelle :

```bash
CERP_PDF_PREVIEW=1 npx vitest run src/module/livraisons/services/pack-pdf.service.test.ts
```

Le texte est relu **dans les flux de contenu du PDF**, décompressés et décodés en WinAnsi :
donc ce que le document affiche, pas ce que le code croit avoir écrit. C'est ce qui permet
d'affirmer qu'aucun UUID n'y figure.

`src/module/livraisons/services/pdf.service.test.ts` couvre en complément le brouillon vide,
un BL complet, la régénération, le rejeu idempotent, l'archive manquante et deux générations
concurrentes. Le contrôleur vérifie séparément que `GET` reste sans effet de bord et ne masque
pas les erreurs d'autorisation ou de stockage.

Suite complète : **2968 tests verts sur 2969**. L'échec restant
(`src/__tests__/surface-finish-210.migration-guards.test.ts`) est **antérieur** à ce chantier —
vérifié en remisant les modifications et en relançant sur `origin/dev` seul.

## 7. Limites

- Aucune recette navigateur.
- Aucun déploiement, aucune modification de production.
- **Aucune migration de base** : le contrat HTTP évolue, mais les tables existantes suffisent au
  versionnement, à l'empreinte et au journal d'idempotence.
