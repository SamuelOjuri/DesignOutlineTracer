"""Read-only PDF geometry inspection and detail rendering."""
from pathlib import Path
import json
import pymupdf

root = Path(r'C:\Users\SamuelOjuri\OneDrive - Tapered Plus\Documents\Samsdocs\Roof Plan Docs\Example 2 - TP17221')
for kind in ('input', 'outline'):
    with pymupdf.open(root / f'TP17221_25.01_{kind}.pdf') as doc:
        page = doc[0]
        drawings = page.get_drawings()
        print(kind, list(page.rect))
        if kind == 'input':
            selected = [d for d in drawings if d.get('color') and d['color'][2] > .8 and d['color'][0] < .2 and d['color'][1] > .4 and len(d['items']) <= 3 and max(d['rect'].width, d['rect'].height) > 2]
        else:
            selected = [d for d in drawings if d.get('color') == (0, 0, 0) and 3 < d['rect'].width < 11 and 3 < d['rect'].height < 11 and 350 < d['rect'].x0 < 1700 and 750 < d['rect'].y0 < 1150]
        print(json.dumps([{'rect': list(d['rect']), 'color': d['color'], 'types': [i[0] for i in d['items']]} for d in selected]))
        clip = pymupdf.Rect(350, 990, 1100, 1340) if kind == 'input' else pymupdf.Rect(350, 780, 1050, 1110)
        page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=clip).save(f'tmp/pdfs/tp17221-outlet-{kind}-detail.png')
