import csv
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("vision_programme_review.py")
SPEC = importlib.util.spec_from_file_location("vision_programme_review", SCRIPT)
assert SPEC and SPEC.loader
converter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = converter
SPEC.loader.exec_module(converter)


class VisionProgrammeReviewTests(unittest.TestCase):
    def test_parses_only_explicit_firm_and_prv_schedule_lines(self):
        text = """Article : 040-12139-028 Contrat : CO080030-2 Unité : PCE
Qté/Uc : 999999 RETARD : 12 Cum : 999
FIRM 15/10/2026 5,000
PRV 22/03/2027 22
PRV 06/04/2027 24.000
"""
        rows = converter.parse_page(1, text)
        self.assertEqual([(row.rubrique, row.date, row.quantity) for row in rows], [
            ("En commande ferme", "15/10/2026", "5.000"),
            ("PRV", "22/03/2027", "22"), ("PRV", "06/04/2027", "24.000"),
        ])
        self.assertTrue(all(row.quantity not in {"999999", "12", "999"} for row in rows))

    def test_parses_the_two_printed_prv_groups_but_not_pack_or_retard_metadata(self):
        text = """Article : A-2 Contrat : C-2 Unité : PCE
Qté/Uc : 999999 RETARD = 12 Cum. Att : 123
22/03/2027 | 12 22,000 PRV | 05/04/2027 | 14 24,000 PRV
"""
        rows = converter.parse_page(2, text)
        self.assertEqual([(row.rubrique, row.date, row.quantity) for row in rows], [
            ("PRV", "22/03/2027", "22.000"), ("PRV", "05/04/2027", "24.000"),
        ])

    def test_rejects_impossible_dates_from_the_cell_ocr_pass(self):
        self.assertTrue(converter.is_valid_printed_date("02/11/2026"))
        self.assertFalse(converter.is_valid_printed_date("59/10/2026"))

    def test_writes_blocking_review_csv_and_never_fabricates_stable_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            import fitz
            pdf = root / "programme.pdf"
            document = fitz.open(); document.new_page(); document.save(pdf); document.close()
            sidecar = root / "ocr.json"
            sidecar.write_text(json.dumps({"pages": {"1": "Article : A-1 Contrat : C-1 Unité : PCE\nPRV 01/11/2026 4"}}), encoding="utf-8")
            with tempfile.TemporaryDirectory() as output_temporary:
                output = Path(output_temporary) / "out"
                self.assertEqual(converter.main(["--input", str(pdf), "--output-dir", str(output), "--source-version", "S44-2026", "--ocr-sidecar", str(sidecar)]), 0)
                with (output / "vision-programme-review.csv").open(encoding="utf-8-sig", newline="") as stream:
                    row = next(csv.DictReader(stream))
                self.assertEqual(row["ARTICLE"], "A-1")
                self.assertEqual(row["ID_LIGNE"], "")
                self.assertEqual(row["ID_ECHEANCE"], "")
                self.assertEqual(row["REVIEW_REQUIRED"], "TRUE")
                self.assertEqual(row["QUANTITE_ECHEANCE"], "4")


if __name__ == "__main__":
    unittest.main()
