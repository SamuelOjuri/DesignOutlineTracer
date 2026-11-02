"""Read the supplied CAD reference outline; do not execute document content."""
import json
from pathlib import Path
import pymupdf

path = Path(r"C:\Users\SamuelOjuri\OneDrive - Tapered Plus\Documents\Samsdocs\Roof Plan Docs\Example 2 - TP17221\TP17221_25.01_outline.pdf")
document = pymupdf.open(path)
page = document[0]
paths = []
for drawing in page.get_drawings():
    colour = drawing.get("color")
    if not colour or colour[1] <= colour[0] + .2 or colour[1] <= colour[2] + .2:
        continue
    items = []
    for item in drawing["items"]:
        if item[0] == "l":
            items.append({"start": list(item[1]), "end": list(item[2])})
    paths.append({"colour": colour, "closed": drawing["closePath"], "rect": list(drawing["rect"]),
                  "segments": items, "types": [item[0] for item in drawing["items"]]})
result = {"page": list(page.rect), "paths": paths}
Path("tmp/tp17221-cad-reference.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
