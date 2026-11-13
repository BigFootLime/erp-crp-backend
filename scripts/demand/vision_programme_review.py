#!/usr/bin/env python3
"""Offline, review-only transcription helper for Vision/Clayens RAL programmes.

This program is deliberately *not* an import tool.  It never connects to CERP,
never writes next to the source document and never invents ERP identity keys.
The resulting CSV is a review queue whose schedule columns use the
``VISION_PROGRAMME`` adapter vocabulary.

For scans, give it an OCR sidecar produced locally by an approved OCR process.
The sidecar is intentionally simple so an operator can correct it before this
script parses it:

    {"pages": {"1": "Article : A-1\nContrat : C-1\nUnité : PCE\n..."}}

Expected dated lines are ``FIRM <dd/mm/yyyy> <quantity>`` and
``PRV <dd/mm/yyyy> <quantity>``.  The proof/evidence CSV keeps the source page
and original OCR line.  Every row remains blocking-review-required.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


REVIEW_HEADERS = [
    "SITE", "NUM_CDE", "ID_LIGNE", "ID_ECHEANCE", "ARTICLE", "CONTRAT",
    "UNITE", "RUBRIQUE", "DATE_ECHEANCE", "QUANTITE_ECHEANCE",
    "source_version", "source_as_of", "REVIEW_REQUIRED", "REVIEW_REASONS",
    "SOURCE_DOCUMENT_SHA256", "SOURCE_PAGE", "SOURCE_BLOCK", "SOURCE_EVIDENCE", "SOURCE_COORDINATES",
]
EVIDENCE_HEADERS = [
    "SOURCE_DOCUMENT_SHA256", "SOURCE_PAGE", "OCR_MODE", "NATIVE_TEXT_CHARS",
    "CANDIDATE_ROWS", "REVIEW_REQUIRED", "REVIEW_REASONS",
]

ARTICLE_RE = re.compile(r"\bArticle\s*:\s*([^\s]+)", re.IGNORECASE)
CONTRACT_RE = re.compile(r"\bContrat\s*:\s*([^\s]+)", re.IGNORECASE)
UNIT_RE = re.compile(r"\b(?:Unité|Unite|Unit)\s*:\s*([^\s]+)", re.IGNORECASE)
SCHEDULE_RE = re.compile(
    r"^\s*(FIRM|FERME|EN\s+COMMANDE\s+FERME|PRV|PREVISION|PRÉVISION)\s*"
    r"(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s+([0-9][0-9\s.,]*)\s*$",
    re.IGNORECASE,
)
PRV_TABLE_RE = re.compile(
    r"(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s*\|?\s*\d{1,2}\s+([0-9][0-9\s.,]*)\s+(?:P?RV|PRV_)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Candidate:
    page: int
    block: int
    article: str
    contract: str
    unit: str
    rubrique: str
    date: str
    quantity: str
    evidence: str
    coordinates: str = ""


def parse_date(raw: str) -> str:
    pieces = re.split(r"[/.\-]", raw)
    return f"{int(pieces[0]):02d}/{int(pieces[1]):02d}/{pieces[2]}"


def is_valid_printed_date(raw: str) -> bool:
    try:
        datetime.strptime(raw, "%d/%m/%Y")
        return True
    except ValueError:
        return False


def parse_quantity(raw: str) -> str:
    """Return an unambiguous decimal string, or fail rather than guessing."""
    compact = raw.replace(" ", "").replace("\u00a0", "")
    if compact.count(",") > 1 or compact.count(".") > 1:
        raise ValueError("ambiguous decimal separators")
    return compact.replace(",", ".")


def parse_page(page: int, text: str, line_coordinates: dict[str, list[str]] | None = None) -> list[Candidate]:
    candidates: list[Candidate] = []
    article = contract = unit = ""
    block = 0
    for raw_line in text.splitlines():
        line = " ".join(raw_line.split())
        article_match = ARTICLE_RE.search(line)
        if article_match:
            article = article_match.group(1)
            contract_match = CONTRACT_RE.search(line)
            unit_match = UNIT_RE.search(line)
            contract = contract_match.group(1) if contract_match else ""
            unit = unit_match.group(1).upper() if unit_match else ""
            block += 1
            continue
        if not article:
            continue
        contract_match = CONTRACT_RE.search(line)
        unit_match = UNIT_RE.search(line)
        if contract_match:
            contract = contract_match.group(1)
        if unit_match:
            unit = unit_match.group(1).upper()
        coordinates = (line_coordinates or {}).get(line, [""])[0]
        schedule_match = SCHEDULE_RE.match(line)
        matches: list[tuple[str, str, str]] = []
        if schedule_match:
            label, raw_date, raw_quantity = schedule_match.groups()
            matches.append(("En commande ferme" if label.upper() in {"FIRM", "FERME", "EN COMMANDE FERME"} else "PRV", raw_date, raw_quantity))
        else:
            matches.extend(("PRV", date, quantity) for date, quantity in PRV_TABLE_RE.findall(line))
        for rubrique, raw_date, raw_quantity in matches:
            try:
                quantity = parse_quantity(raw_quantity)
            except ValueError:
                continue
            candidates.append(Candidate(page, block, article, contract, unit, rubrique, parse_date(raw_date), quantity, line, coordinates))
    return candidates


def load_text_by_page(pdf_path: Path, ocr_sidecar: Path | None) -> tuple[dict[int, str], dict[int, int], str]:
    try:
        import fitz  # PyMuPDF; intentionally local-only.
    except ImportError as error:  # pragma: no cover - only exercised outside dev tooling
        raise RuntimeError("PyMuPDF est requis (pip install PyMuPDF) pour lire le PDF local.") from error
    document = fitz.open(pdf_path)
    native = {index + 1: page.get_text("text") for index, page in enumerate(document)}
    native_lengths = {page: len(text.strip()) for page, text in native.items()}
    if ocr_sidecar is None:
        return native, native_lengths, "native-text"
    payload = json.loads(ocr_sidecar.read_text(encoding="utf-8"))
    pages = payload.get("pages", payload)
    if not isinstance(pages, dict):
        raise ValueError("Le sidecar OCR doit contenir un objet pages indexé à partir de 1.")
    merged = dict(native)
    for key, value in pages.items():
        page = int(key)
        if page not in merged:
            raise ValueError(f"La page OCR {page} n'existe pas dans le PDF.")
        if not isinstance(value, str):
            raise ValueError(f"Le texte OCR de la page {page} doit être une chaîne.")
        merged[page] = value
    return merged, native_lengths, "local-ocr-sidecar"


def local_tesseract_text_by_page(pdf_path: Path, tessdata_dir: Path) -> tuple[dict[int, str], dict[int, int], dict[int, dict[str, list[str]]], list[Candidate]]:
    """Run local Tesseract and retain line bounding boxes as confidential evidence."""
    try:
        import fitz
        from PIL import Image
        import tesserocr
    except ImportError as error:  # pragma: no cover - host setup only
        raise RuntimeError("OCR locale indisponible : installez tesserocr, PyMuPDF et Pillow hors du dépôt.") from error
    document = fitz.open(pdf_path)
    texts: dict[int, str] = {}
    native_lengths: dict[int, int] = {}
    coordinates: dict[int, dict[str, list[str]]] = {}
    firm_candidates: list[Candidate] = []
    with tesserocr.PyTessBaseAPI(path=str(tessdata_dir), lang="fra+eng", psm=tesserocr.PSM.AUTO) as api:
        for index, page in enumerate(document):
            number = index + 1
            native_lengths[number] = len(page.get_text("text").strip())
            pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            api.SetPageSegMode(tesserocr.PSM.AUTO)
            api.SetVariable("tessedit_char_whitelist", "")
            api.SetImage(image)
            texts[number] = api.GetUTF8Text()
            grouped: dict[tuple[str, str, str], list[tuple[str, int, int, int, int]]] = {}
            for raw in api.GetTSVText(0).splitlines()[1:]:
                parts = raw.split("\t")
                if len(parts) != 12 or parts[0] != "5" or not parts[11].strip():
                    continue
                try:
                    grouped.setdefault((parts[2], parts[3], parts[4]), []).append((parts[11], int(parts[6]), int(parts[7]), int(parts[8]), int(parts[9])))
                except ValueError:
                    continue
            per_text: dict[str, list[str]] = {}
            article_headers: list[tuple[int, str, str, str]] = []
            for words in grouped.values():
                text = " ".join(word[0] for word in words)
                x1, y1 = min(word[1] for word in words), min(word[2] for word in words)
                x2, y2 = max(word[1] + word[3] for word in words), max(word[2] + word[4] for word in words)
                per_text.setdefault(" ".join(text.split()), []).append(f"{x1},{y1},{x2 - x1},{y2 - y1}")
                article_match = ARTICLE_RE.search(text)
                if article_match:
                    contract_match = CONTRACT_RE.search(text)
                    unit_match = UNIT_RE.search(text)
                    article_headers.append((y1, article_match.group(1), contract_match.group(1).strip("_| ") if contract_match else "", unit_match.group(1).upper() if unit_match else ""))
            coordinates[number] = per_text
            # The firm table is printed in coloured cells.  Read only the two
            # left cells, not the DLS column, after a binary cleanup.  A date
            # and a quantity must be recognised on the same table row.
            article_headers.sort()
            api.SetPageSegMode(tesserocr.PSM.SINGLE_LINE)
            seen: set[tuple[str, str, str]] = set()
            for header_index, (header_y, article, contract, unit) in enumerate(article_headers):
                next_y = article_headers[header_index + 1][0] if header_index + 1 < len(article_headers) else image.height
                # Limit to the firm-table band immediately below this article;
                # a later article header is never a firm schedule row.
                band_end = min(next_y - 38, header_y + 440)
                for y in range(header_y + 80, max(header_y + 80, band_end), 4):
                    def clean(cell: Image.Image) -> Image.Image:
                        # Cyan/yellow marker backgrounds are bright in at
                        # least one RGB channel, unlike black printed glyphs.
                        # A max-channel threshold removes the colour fill and
                        # leaves text/grid ink for the digits-only OCR pass.
                        rgb = cell.convert("RGB")
                        binary = bytes(0 if max(pixel) < 130 else 255 for pixel in rgb.getdata())
                        return Image.frombytes("L", rgb.size, binary).resize((cell.width * 2, cell.height * 2))
                    date_box = (int(image.width * 0.054), y, int(image.width * 0.126), y + 42)
                    quantity_box = (int(image.width * 0.160), y, int(image.width * 0.241), y + 42)
                    date_cell = image.crop(date_box)
                    # Blank table rows contain only borders.  Skip OCR unless
                    # the inner date cell carries enough dark glyph pixels.
                    inner = date_cell.crop((5, 3, max(6, date_cell.width - 5), max(4, date_cell.height - 3))).convert("RGB")
                    if sum(1 for pixel in inner.getdata() if max(pixel) < 90) < 70:
                        continue
                    api.SetVariable("tessedit_char_whitelist", "0123456789/")
                    api.SetImage(clean(date_cell))
                    raw_date = api.GetUTF8Text().strip()
                    if not re.fullmatch(r"\d{2}/\d{2}/\d{4}", raw_date) or not is_valid_printed_date(raw_date):
                        continue
                    api.SetVariable("tessedit_char_whitelist", "0123456789,.")
                    api.SetImage(clean(image.crop(quantity_box)))
                    raw_quantity = api.GetUTF8Text().strip()
                    try:
                        quantity = parse_quantity(raw_quantity)
                    except ValueError:
                        continue
                    if not re.fullmatch(r"\d+(?:\.\d+)?", quantity) or float(quantity) <= 0:
                        continue
                    key = (article, raw_date, quantity)
                    if key in seen:
                        continue
                    seen.add(key)
                    coords = f"{date_box[0]},{y},{date_box[2] - date_box[0]},42|{quantity_box[0]},{y},{quantity_box[2] - quantity_box[0]},42"
                    firm_candidates.append(Candidate(number, header_index + 1, article, contract, unit, "En commande ferme", raw_date, quantity,
                                                     f"FIRM left cells; date={raw_date}; quantity={raw_quantity}", coords))
    return texts, native_lengths, coordinates, firm_candidates


def assert_safe_output(input_pdf: Path, output_dir: Path) -> None:
    input_parent = input_pdf.resolve().parent
    resolved = output_dir.resolve()
    # The customer share is read-only input only.  Reject both same tree and Z: output.
    if str(resolved).lower().startswith("z:\\") or resolved == input_parent or input_parent in resolved.parents:
        raise ValueError("La sortie doit être hors du partage/document source (jamais dans Z:).")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_csv(path: Path, headers: Iterable[str], rows: Iterable[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(headers), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convertit un programme Vision scanné en file de revue VISION_PROGRAMME.")
    parser.add_argument("--input", required=True, type=Path, help="PDF local ou partage monté, lu uniquement.")
    parser.add_argument("--output-dir", required=True, type=Path, help="Dossier local hors partage client.")
    parser.add_argument("--source-version", required=True, help="Version lisible, par exemple S44-2026.")
    parser.add_argument("--source-as-of", default="", help="Horodatage ISO fourni par le métier après vérification.")
    parser.add_argument("--site", default="", help="Identifiant de site CERP, si déjà validé.")
    parser.add_argument("--ocr-sidecar", type=Path, help="JSON OCR local, jamais envoyé hors poste.")
    parser.add_argument("--local-tesseract", action="store_true", help="Exécute Tesseract localement (dépendances hors dépôt).")
    parser.add_argument("--tessdata-dir", type=Path, help="Répertoire local contenant fra.traineddata et eng.traineddata.")
    args = parser.parse_args(argv)
    input_pdf = args.input.resolve()
    if not input_pdf.is_file() or input_pdf.suffix.lower() != ".pdf":
        parser.error("--input doit désigner un PDF existant.")
    assert_safe_output(input_pdf, args.output_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.local_tesseract:
        if args.ocr_sidecar or not args.tessdata_dir:
            parser.error("--local-tesseract requiert --tessdata-dir et ne se combine pas avec --ocr-sidecar.")
        texts, native_lengths, line_coordinates, firm_candidates = local_tesseract_text_by_page(input_pdf, args.tessdata_dir)
        mode = "local-tesseract"
    else:
        texts, native_lengths, mode = load_text_by_page(input_pdf, args.ocr_sidecar)
        line_coordinates = {}
        firm_candidates = []
    document_hash = sha256(input_pdf)
    candidates = firm_candidates + [candidate for page, text in texts.items() for candidate in parse_page(page, text, line_coordinates.get(page))]
    rows = []
    for candidate in candidates:
        reasons = ["OCR_OR_TRANSCRIPTION_REVIEW_REQUIRED", "STABLE_IDS_MUST_BE_ASSOCIATED"]
        if candidate.rubrique == "En commande ferme":
            reasons.append("FIRM_CELL_OCR_REVIEW_REQUIRED")
        if not candidate.contract:
            reasons.append("CONTRACT_MISSING")
        if not candidate.unit:
            reasons.append("UNIT_MISSING")
        rows.append({
            "SITE": args.site, "NUM_CDE": "", "ID_LIGNE": "", "ID_ECHEANCE": "",
            "ARTICLE": candidate.article, "CONTRAT": candidate.contract, "UNITE": candidate.unit,
            "RUBRIQUE": candidate.rubrique, "DATE_ECHEANCE": candidate.date,
            "QUANTITE_ECHEANCE": candidate.quantity, "source_version": args.source_version,
            "source_as_of": args.source_as_of, "REVIEW_REQUIRED": "TRUE",
            "REVIEW_REASONS": ";".join(reasons), "SOURCE_DOCUMENT_SHA256": document_hash,
            "SOURCE_PAGE": candidate.page, "SOURCE_BLOCK": candidate.block, "SOURCE_EVIDENCE": candidate.evidence,
            "SOURCE_COORDINATES": candidate.coordinates,
        })
    evidence = []
    for page in sorted(texts):
        page_candidates = [row for row in rows if row["SOURCE_PAGE"] == page]
        reasons = ["OCR_OR_TRANSCRIPTION_REVIEW_REQUIRED", "NO_AUTO_APPLY"]
        if native_lengths[page] == 0 and args.ocr_sidecar is None and not args.local_tesseract:
            reasons.append("SCANNED_PAGE_NO_LOCAL_OCR_SIDECAR")
        evidence.append({"SOURCE_DOCUMENT_SHA256": document_hash, "SOURCE_PAGE": page, "OCR_MODE": mode,
                         "NATIVE_TEXT_CHARS": native_lengths[page], "CANDIDATE_ROWS": len(page_candidates),
                         "REVIEW_REQUIRED": "TRUE", "REVIEW_REASONS": ";".join(reasons)})
    review_path = args.output_dir / "vision-programme-review.csv"
    evidence_path = args.output_dir / "vision-programme-evidence.csv"
    write_csv(review_path, REVIEW_HEADERS, rows)
    write_csv(evidence_path, EVIDENCE_HEADERS, evidence)
    scanned_without_sidecar = sum(1 for size in native_lengths.values() if size == 0 and args.ocr_sidecar is None and not args.local_tesseract)
    print(json.dumps({"review_csv": str(review_path), "evidence_csv": str(evidence_path),
                      "pages": len(texts), "candidate_rows": len(rows), "blocking_review_rows": len(rows),
                      "blocking_review_pages": len(evidence), "scanned_pages_without_sidecar": scanned_without_sidecar,
                      "firm_candidate_rows": sum(1 for row in rows if row["RUBRIQUE"] == "En commande ferme"),
                      "prv_candidate_rows": sum(1 for row in rows if row["RUBRIQUE"] == "PRV")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Erreur: {error}", file=sys.stderr)
        raise SystemExit(2)
