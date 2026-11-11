#!/usr/bin/env python3
"""Extract native TRICS roof input geometries to structured JSON and CAD DXF.

Verified for the given project file; private TRICS schema is undocumented.
Does not modify the source project.
"""
import gzip
import json
from pathlib import Path
from lxml import etree
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
import ezdxf

SOURCE = Path('/mnt/data/AX19010_26.01 - A.trics')
JSON_OUT = Path('/mnt/data/AX19010_input_geometry.json')
DXF_OUT = Path('/mnt/data/AX19010_input_geometry.dxf')

DATA_TYPES = {'7001': ('roof_boundaries','Roof Definitions'), '7004': ('protrusions','Protrusion Definitions'), '7002': ('sump_boundaries','Sump Definitions'), '7012': ('outlets','Outlets')}

b = SOURCE.read_bytes()
gzip_start = b.find(b'\x1f\x8b\x08')
assert gzip_start == 10, 'Unexpected TRICS wrapper; inspect before decompressing'
root = etree.fromstring(gzip.decompress(b[gzip_start:]))
assert root.tag == 'TRICS'

entities = root.find('Entities')
project = root.find('ProjectData')
output = {
  'source': SOURCE.name,
  'project_reference': project.attrib.get('DrawingReference'),
  'revision': project.attrib.get('Revision'),
  'coordinate_system': {'type': 'CAD Cartesian XY', 'units': 'millimetres', 'georeferenced': False, 'y_axis': 'up'},
  'extraction_method': 'Native TRICS geometry entities from compressed XML; no image tracing',
  'geometry': {k: [] for k,_ in DATA_TYPES.values()},
  'notes': [
    'Coordinates and radii come directly from the TRICS project (floating-point values, not scaled to the PDF).',
    'Protrusion Definitions are CAD obstructions; their real-world identity as penetrations/rooflights must be verified.',
    'Sump polygons are separate from drainage outlet point entities.',
    'Some outlet points may not lie inside the roof or sump polygons. They are preserved unaltered.',
    'This schema is TRICS-specific and has been validated on this project file, not other versions.'
  ]
}

doc=ezdxf.new('R2010')
doc.header['$INSUNITS']=4
doc.header['$MEASUREMENT']=1
msp=doc.modelspace()
layer_props = {'roof_boundaries': ('ROOF_BOUNDARIES',3), 'protrusions': ('PROTRUSIONS',1), 'sump_boundaries':('SUMP_BOUNDARIES',6), 'outlets':('OUTLETS',4)}
for lname,color in layer_props.values(): doc.layers.new(lname,dxfattribs={'color':color})

polygons=[]; outlets=[]
for ent in entities:
    typ=ent.get('EntityType')
    if typ not in DATA_TYPES: continue
    category,layername=DATA_TYPES[typ]
    idx=len(output['geometry'][category])+1
    base={'id':f'{category}_{idx:02d}', 'source_handle':ent.get('Handle'), 'source_layer':layername}
    if typ=='7012':
       pos=ent.find('{*}Position')
       x=float(pos.findtext('{*}X'));y=float(pos.findtext('{*}Y'));rad=float(ent.findtext('{*}Radius'))
       record={**base,'geometry_type':'Point','position_mm':[x,y], 'radius_mm':rad}
       msp.add_circle((x,y),radius=rad,dxfattribs={'layer':'OUTLETS'})
       outlets.append(record)
    else:
       segments=[];points=[]
       for seg in ent.findall('./Segments/Segment'):
           a=[float(seg.get('Point1_x')),float(seg.get('Point1_y'))]
           z=[float(seg.get('Point2_x')),float(seg.get('Point2_y'))]
           meta={k:v for k,v in seg.attrib.items() if k not in ('Point1_x','Point1_y','Point1_z','Point2_x','Point2_y','Point2_z','EntityType')}
           segments.append({'start_mm':a,'end_mm':z,**meta})
           points.append(a)
       assert len(points)>=3
       assert all(all(abs(x-y)<1e-6 for x,y in zip(segments[i]['end_mm'],segments[(i+1)%len(segments)]['start_mm'])) for i in range(len(segments))), 'Unclosed source entity'
       geom=Polygon(points)
       assert geom.is_valid and geom.area>0, 'Invalid polygon'
       record={**base,'geometry_type':'Polygon','closed':True,'vertices_mm':points,'area_m2':geom.area/1e6,'segment_details':segments}
       if typ=='7001':record['group_name']=ent.get('GroupName')
       if typ=='7004':record['edge_as_perimeter']=ent.get('EdgeAsPerimeter')
       msp.add_lwpolyline(points,close=True,dxfattribs={'layer':layer_props[category][0]})
       polygons.append((category,record,geom))
    output['geometry'][category].append(record)

roofs=[(rec,p) for cat,rec,p in polygons if cat=='roof_boundaries']
sumps=[(rec,p) for cat,rec,p in polygons if cat=='sump_boundaries']
for cat,rec,p in polygons:
    if cat=='roof_boundaries':continue
    overlaps=[(r['id'],round(p.intersection(poly).area/p.area,6)) for r,poly in roofs if p.intersects(poly)]
    rec['roof_overlap_fractions']=[{'roof_id':rid,'fraction':v} for rid,v in overlaps if v>0]
for rec in outlets:
    p=Point(rec['position_mm'])
    rec['within_roofs']=[r['id'] for r,poly in roofs if poly.covers(p)]
    rec['within_sumps']=[r['id'] for r,poly in sumps if poly.covers(p)]
    rec['nearest_roof_id']=min(roofs,key=lambda rp: rp[1].distance(p))[0]['id']
    rec['distance_to_nearest_roof_mm']=round(min(poly.distance(p) for _,poly in roofs),3)
    rec['nearest_sump_id']=min(sumps,key=lambda rp: rp[1].distance(p))[0]['id']
    rec['distance_to_nearest_sump_mm']=round(min(poly.distance(p) for _,poly in sumps),3)

all_roofs=unary_union([p for _,p in roofs])
protrusions=unary_union([p for c,_,p in polygons if c=='protrusions'])
output['summary'] = {
   'roof_polygon_count':len(roofs),
   'protrusion_polygon_count':len(output['geometry']['protrusions']),
   'sump_polygon_count':len(sumps),
   'outlet_point_count':len(outlets),
   'gross_roof_area_m2':round(all_roofs.area/1e6,3),
   'roof_area_less_protrusions_m2':round(all_roofs.difference(protrusions).area/1e6,3),
   'outlet_points_outside_all_roof_polygons':sum(not o['within_roofs'] for o in outlets),
   'outlet_points_outside_all_sump_polygons':sum(not o['within_sumps'] for o in outlets),
}
JSON_OUT.write_text(json.dumps(output,indent=2,ensure_ascii=False),encoding='utf-8')
doc.saveas(DXF_OUT)
assert len(msp.query('LWPOLYLINE')) == 21
assert len(msp.query('CIRCLE')) == 8
print(json.dumps(output['summary'],indent=2))
print('DXF saved:',DXF_OUT,DXF_OUT.stat().st_size)
print('JSON saved:',JSON_OUT,JSON_OUT.stat().st_size)
for rec in outlets:
 print(rec['id'], 'pos',*(round(v,1) for v in rec['position_mm']), 'roof',rec['within_roofs'], 'sump',rec['within_sumps'], 'nearest_roof_mm',rec['distance_to_nearest_roof_mm'],'nearest_sump_mm',rec['distance_to_nearest_sump_mm'])
