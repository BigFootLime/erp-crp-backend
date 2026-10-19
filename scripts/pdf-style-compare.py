"""Compare captured PDFs without accepting any business/layout change.

Requires pdfplumber. Usage: python scripts/pdf-style-compare.py /absolute/proofs
Colors and PDF creation metadata may change. The OF renderer footer moves 1.7 to
1.8. Every glyph metric/position, page and embedded image must stay fixed.
--rounded-corners permits only the requested contour changes: PDFKit panel outer
bounds stay exact; React-PDF border arcs may extend inward by at most six points.
"""
import hashlib
import json
from pathlib import Path
import sys
import pdfplumber


def same_panel_bounds(a, b, family):
    if a['lines'] != b['lines']:
        return False
    if family != 'frontend':
        # Rectangle -> rounded path, with the same outer box and drawing attributes.
        bounds = lambda shapes: sorted([o[:5] + o[6:] for kind in ('rects', 'curves') for o in shapes[kind]], key=str)
        return bounds(a) == bounds(b)
    if a['rects'] != b['rects'] or len(a['curves']) != len(b['curves']):
        return False
    for before, after in zip(a['curves'], b['curves']):
        if before[4] != after[4] or before[6:] != after[6:]:
            return False
        deltas = [abs(x - y) for x, y in zip(before[:4], after[:4])]
        if max(deltas) > 6.0001 or sum(d > 0.0001 for d in deltas) > 1:
            return False
    return True


def rounded(value):
    if isinstance(value, (float, int)):
        return round(value, 4)
    if isinstance(value, (tuple, list)):
        return [rounded(v) for v in value]
    return value


def inspect(file):
    with pdfplumber.open(file) as document:
        pages = []
        for page in document.pages:
            text = ''.join(c['text'] for c in page.chars)
            text = text.replace('gabarit of-ordre-fabrication/1.8', 'gabarit of-ordre-fabrication/1.7')
            characters = [[rounded(c.get(k)) for k in ('x0', 'y0', 'x1', 'y1', 'fontname', 'size', 'adv', 'upright')] for c in page.chars]
            shapes = {kind: [[rounded(o.get(k)) for k in ('x0', 'y0', 'x1', 'y1', 'linewidth', 'pts', 'fill', 'stroke')] for o in getattr(page, kind)] for kind in ('lines', 'rects', 'curves')}
            images = [{
                'geometry': [rounded(i.get(k)) for k in ('x0', 'y0', 'x1', 'y1', 'srcsize', 'bits', 'imagemask')],
                'pixels_sha256': hashlib.sha256(i['stream'].get_data()).hexdigest(),
            } for i in page.images]
            pages.append({'size': [page.width, page.height], 'text': text, 'characters': characters, 'shapes': shapes, 'images': images})
        return pages


root = Path(sys.argv[1]).resolve()
allow_rounding = '--rounded-corners' in sys.argv[2:]
results, additional = [], []
for family in ('backend', 'frontend', 'reports', 'archives'):
    before, after = root / f'{family}-before', root / f'{family}-after'
    names = {p.name for p in before.glob('*.pdf')}
    after_names = {p.name for p in after.glob('*.pdf')}
    if not names or names - after_names:
        raise RuntimeError(f'{family}: missing baseline or output: {names - after_names}')
    additional.extend(f'{family}/{name}' for name in sorted(after_names - names))
    for name in sorted(names):
        a, b = inspect(before / name), inspect(after / name)
        differences, rounded_pages = [], []
        if len(a) != len(b):
            differences.append('page count')
        for index, (pa, pb) in enumerate(zip(a, b)):
            for field in pa:
                if pa[field] != pb[field]:
                    if field == 'shapes' and allow_rounding and same_panel_bounds(pa[field], pb[field], family):
                        rounded_pages.append(index + 1)
                        continue
                    differences.append(f'page {index + 1}: {field}')
        # PDFKit measurement documents are captured too; do not count as a business PDF.
        empty_ruler = not any(p['text'] or p['images'] or any(p['shapes'].values()) for p in a)
        results.append({'family': family, 'file': name, 'pages': len(b), 'measurementOnly': empty_ruler,
                        'identicalBytes': (before / name).read_bytes() == (after / name).read_bytes(),
                        'approvedRoundedContoursOnPages': rounded_pages, 'differences': differences})

report = {'captures': len(results), 'documents': sum(not r['measurementOnly'] for r in results),
          'pages': sum(r['pages'] for r in results if not r['measurementOnly']),
          'failed': sum(bool(r['differences']) for r in results),
          'roundedContourPages': sum(len(r['approvedRoundedContoursOnPages']) for r in results),
          'additionalAfterOnly': additional, 'results': results}
(root / 'geometry-comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({k: v for k, v in report.items() if k not in ('results', 'additionalAfterOnly')}, ensure_ascii=False))
for r in results:
    if r['differences']:
        print(json.dumps(r, ensure_ascii=False))
raise SystemExit(1 if report['failed'] else 0)
