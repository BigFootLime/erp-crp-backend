# Programme Vision / Clayens : transcription locale sous revue

Le tableau Excel CARCO suit un circuit distinct de la transcription PDF. Dans **Commandes clients → Boîte ADV → Relevés de commandes CLAYENS**, sélectionner le client, le site, la version et la date d’extraction indiquée par le client. Cocher « carnet complet » seulement lorsque le périmètre de l’envoi est confirmé. Déposer le CSV ou XLSX d’origine, puis relire les écarts et les motifs de revue. Le comparatif conserve les groupes ambigus, même si deux lignes ont les mêmes valeurs.

`NUM_LIGNE_CDE` identifie la ligne. Une échéance conserve son propre identifiant. Sur une ligne ferme comportant une seule échéance, l’ADV peut enregistrer un identifiant stable après vérification. La correspondance article et unité est gérée dans **Planning → PIC / PDP / CBN → Correspondances article client**. Les lignes sans article restent visibles. La fiche technique d’une pièce fabriquée est contrôlée dans la préparation de l’OF.

« Transmettre » enregistre des demandes pour décision ADV. Les lignes prêtes peuvent être traitées d’abord, puis la même version peut être complétée une fois les autres lignes qualifiées. Le solde alimente le besoin. Les pièces déjà livrées sont affichées pour contrôle. Le fichier de retour CSV est destiné à la relecture interne avant accord sur le format d’échange. Les quatre cycles ADV et l’ouverture de chaque compte fournisseur relèvent du pilote opérationnel.

`scripts/demand/vision_programme_review.py` converts a **local PDF only** into
a review queue for the `VISION_PROGRAMME` demand adapter.  It is for the
scanned “Programme de livraison / Reste à livrer” sheets; it is not a CERP
importer and cannot apply an order, a promise, an OF or an AR.

```powershell
python scripts/demand/vision_programme_review.py `
  --input 'Z:\…\CO Croix Rousse Précision -S44 2026.pdf' `
  --output-dir "$env:TEMP\vision-s44-review" `
  --source-version S44-2026
```

The output directory is compulsory and is rejected when it is in `Z:` or in
the source document tree.  Thus no customer PDF, OCR or CSV is copied to Git
or written to the source share.

Scanned sheets have no reliable native text.  A locally generated, corrected
OCR sidecar can be supplied with `--ocr-sidecar ocr.json`; it is never uploaded
or stored by CERP.  The sidecar format is `{"pages":{"1":"..."}}` and its
dated schedule lines must be transcribed as `FIRM dd/mm/yyyy quantity` or
`PRV dd/mm/yyyy quantity`.

For an isolated local OCR execution, install `tesserocr`, `PyMuPDF`, `Pillow`
and the `fra`/`eng` tessdata files in a temporary Python target (not this
repository), then run that interpreter with:

```powershell
python scripts/demand/vision_programme_review.py --local-tesseract `
  --tessdata-dir "$env:TEMP\cerp-tessdata-fast" `
  --input 'Z:\…\CO Croix Rousse Précision -S44 2026.pdf' `
  --output-dir "$env:TEMP\vision-s44-review" --source-version S44-2026
```

The local OCR records the pixel bounding box of each recognised source line in
`SOURCE_COORDINATES`; this is proof for the reviewer, not an authority to
apply the result.

For the coloured **En commande ferme** cells, the local pass reads the left
date and quantity cells independently, with digits-only OCR after removing the
cyan/yellow background.  It deliberately excludes the DLS column.  These rows
receive the additional `FIRM_CELL_OCR_REVIEW_REQUIRED` reason: overlapping
crops can disagree (for example around a handwritten/highlighted quantity), so
the reviewer must retain one value or reject all candidates for that printed
row before import.

The review CSV uses the exact `VISION_PROGRAMME` columns:

`SITE, NUM_CDE, ID_LIGNE, ID_ECHEANCE, ARTICLE, CONTRAT, UNITE, RUBRIQUE, DATE_ECHEANCE, QUANTITE_ECHEANCE, source_version, source_as_of`

It also records hash, page, block, evidence and `REVIEW_REQUIRED=TRUE`.  The
operator must associate `NUM_CDE`, `ID_LIGNE` and `ID_ECHEANCE` with stable
customer/ERP identities and confirm the article, contract, unit, dates and
quantities before giving a cleaned CSV to the adapter.  The script never
derives an identity from dates or article data.

Only a dated quantity explicitly transcribed below `FIRM`/`En commande ferme`
or `PRV` is considered a candidate.  `Qté/Uc`, `RETARD`, cumulative figures,
RAL labels and the open-contract label are metadata, never schedule quantities.
All values represent remaining quantities (`quantity_basis=REMAINING` in the
adapter), not cumulative commercial totals.

`vision-programme-evidence.csv` contains one blocking evidence record per PDF
page, including pages where no schedule could be extracted.  It makes the
absence of local OCR visible rather than silently treating a scan as an empty
programme.

Run the synthetic regression check with:

```powershell
python scripts/demand/test_vision_programme_review.py
```
