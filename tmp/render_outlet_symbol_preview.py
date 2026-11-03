import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
data = json.loads((root / 'outlet-symbol-preview.json').read_text())
aa, magnify = 4, 6
width, height = 960, 310
canvas = Image.new('RGB', (width * aa, height * aa), '#f0f2f5')
draw = ImageDraw.Draw(canvas)

def font(size):
    return ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', size * aa)

def rounded_line(points, colour, weight):
    line_width = max(1, round(weight))
    draw.line(points, fill=colour, width=line_width, joint='curve')
    radius = weight / 2
    for x, y in [points[0], points[-1]]:
        draw.ellipse((round(x-radius), round(y-radius), round(x+radius), round(y+radius)), fill=colour)

for index, variant in enumerate(data['variants']):
    cx, cy = 160 + index * 320, 130
    def point(x, y):
        return ((cx + x * magnify) * aa, (cy + y * magnify) * aa)
    # A neutral line makes the existing white halo visible without filling the symbol.
    draw.line(((cx-110)*aa, cy*aa, (cx+110)*aa, cy*aa), fill='#b9c0ca', width=aa)
    draw.line((cx*aa, (cy-90)*aa, cx*aa, (cy+90)*aa), fill='#b9c0ca', width=aa)
    for stroke in variant['strokes']:
        current = None
        weight = stroke['width'] * magnify * aa
        for command in stroke['path']:
            if command['type'] == 'move':
                current = point(command['x'], command['y'])
            elif command['type'] == 'line':
                endpoint = point(command['x'], command['y'])
                rounded_line([current, endpoint], stroke['colour'], weight)
                current = endpoint
            elif command['type'] == 'arc':
                radius = command['radius']
                start, end = command['start'], command['end']
                length = (end-start) * radius
                runs = []
                if stroke['dash']:
                    position, dash_index = 0, 0
                    while position < length:
                        next_position = min(length, position + stroke['dash'][dash_index % len(stroke['dash'])])
                        if dash_index % 2 == 0:
                            runs.append((start+position/radius, start+next_position/radius))
                        position, dash_index = next_position, dash_index+1
                else:
                    runs.append((start, end))
                for begin, finish in runs:
                    center_x, center_y = point(command['x'], command['y'])
                    outer = radius*magnify*aa + weight/2
                    box = tuple(round(value) for value in (center_x-outer, center_y-outer, center_x+outer, center_y+outer))
                    if not stroke['dash']:
                        draw.ellipse(box, outline=stroke['colour'], width=round(weight))
                    else:
                        draw.arc(box, start=math.degrees(begin), end=math.degrees(finish),
                                 fill=stroke['colour'], width=round(weight))
                        for angle in (begin, finish):
                            x, y = point(command['x']+radius*math.cos(angle), command['y']+radius*math.sin(angle))
                            cap = weight/2
                            draw.ellipse(tuple(round(value) for value in (x-cap, y-cap, x+cap, y+cap)), fill=stroke['colour'])
    draw.text((cx*aa, 234*aa), variant['label'], font=font(18), fill='#222b38', anchor='mm')

draw.text((width/2*aa, 281*aa), '6x enlarged  |  Magenta #C000A0  |  White halo  |  Transparent centre',
          font=font(15), fill='#515d6e', anchor='mm')
canvas.resize((width, height), Image.Resampling.LANCZOS).save(root / 'outlet-symbol-preview.png')
print(root / 'outlet-symbol-preview.png')
