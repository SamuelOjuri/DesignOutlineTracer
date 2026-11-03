"""Verify every perimeter edge and fit disconnected sides with their neighbours.

Source lines establish geometry, not construction approval. Corrections preserve
the number/order of sides and always require review. No page axes are assumed.
"""
from itertools import product

from shapely.geometry import Polygon

from . import outline_geometry as g


def _line_key(option):
    return option['normal'], option['offset']


def _same_line(first, second, points):
    return all(abs(sum(n[k] * p[k] for k in (0, 1)) - c) < .5
               for n, c in (first, second) for p in points)


def _vector_connected(a, b, segments, snap):
    """Require aggregate support and uninterrupted source at both endpoints."""
    options = g._vector_candidates(a, b, segments, .5)
    if not any(option['support'] >= .9 for option in options):
        return False
    direction, _, _ = g._line(a, b)
    length = min(g._distance(a, b), 4 * snap)
    end_a = tuple(a[k] + length * direction[k] for k in (0, 1))
    end_b = tuple(b[k] - length * direction[k] for k in (0, 1))
    return (g._continuous_vector_span(a, end_a, segments)
            and g._continuous_vector_span(end_b, b, segments))


def _verified(a, b, segments, raster, snap):
    if g._continuous_vector_span(a, b, segments):
        return True
    # A raster fallback is checked in windows, including both ends. A long line
    # cannot hide an unsupported corner or substantial gap in its average score.
    direction, normal, offset = g._line(a, b)
    length = g._distance(a, b)
    count = max(1, int(length / max(4., 2 * snap)) + 1)
    for index in range(count):
        p, q = [tuple(a[k] + direction[k] * length * t for k in (0, 1))
                for t in (index / count, (index + 1) / count)]
        if g._raster_support(p, q, normal, offset, raster) < .8:
            return False
    return True


def _contrary_face(a, b, segments, raster, winding, policy, snap):
    if policy == 'roof_deck':
        return False
    n, c = g._line(a, b)[1:]
    current = {'normal': n, 'offset': c}
    for other in g._vector_candidates(a, b, segments, snap):
        if other['support'] < .9 or not 2 < abs(other['offset']-c) <= snap:
            continue
        if g._choose_side_face([current, other], [(a, b)], raster, winding, policy, snap) is other:
            return True
    return False


def _safe(candidate, original, bounds, radius):
    left, top, right, bottom = bounds
    if (not g._valid_ring(candidate) or g._area(candidate) * g._area(original) <= 0
            or not .96 <= g._area(candidate) / g._area(original) <= 1.04
            or any(not left - g.EPS <= x <= right + g.EPS or not top - g.EPS <= y <= bottom + g.EPS
                   for x, y in candidate)
            or any(g._point_to_ring_distance(p, ring) > radius + g.EPS
                   for points, ring in ((candidate, original), (original, candidate)) for p in points)):
        return False
    # Net area alone would let simultaneous additions/subtractions cancel out.
    return Polygon(candidate).symmetric_difference(Polygon(original)).area <= .04 * abs(g._area(original))


def _reconstruct(points, assignments):
    lines = [g._line(a, b)[1:] for a, b in zip(points, points[1:] + points[:1])]
    for index, line in assignments.items():
        lines[index] = line
    result = list(points)
    for index in range(len(points)):
        if index in assignments or (index - 1) % len(points) in assignments:
            meet = g._line_meeting(lines[index - 1], lines[index])
            if meet is None:
                return None  # Do not extrapolate a shallow or sampled curve corner.
            result[index] = meet
    return result


def _policy_choice(plans, points, raster, policy, snap):
    """Choose a paired face only with consistent geometry and side evidence.

    An adjoining side may disambiguate a top/bottom line obscured by hatching.
    Multiple unrelated closures or inconsistent face choices remain unresolved.
    """
    if len(plans) == 1:
        plan = plans[0]
        if policy != 'roof_deck':
            winding = 1 if g._area(points) > 0 else -1
            sign = 1 if policy == 'inner_parapet' else -1
            for index, (n, c) in plan['lines'].items():
                a, b = plan['points'][index], plan['points'][(index+1) % len(points)]
                contrast = g._side_contrast(a, b, n, c, raster, winding)
                if contrast is not None and sign * contrast < -.08:
                    return None  # Connectivity alone cannot override contrary face evidence.
        return plan
    if len(plans) != 2 or policy == 'roof_deck':
        return None
    winding = 1 if g._area(points) > 0 else -1
    sign = 1 if policy == 'inner_parapet' else -1
    wanted = min(plans, key=lambda p: sign * abs(g._area(p['points'])))
    other = plans[1] if wanted is plans[0] else plans[0]
    supported = False
    for index, line in wanted['lines'].items():
        alternate = other['lines'][index]
        a, b = points[index], points[(index + 1) % len(points)]
        if _same_line(line, alternate, (wanted['points'][index], wanted['points'][(index + 1) % len(points)])):
            continue
        n, c = line
        m, d = alternate
        if (sum(x*y for x, y in zip(n, m)) < .9999 or not 2 < abs(c-d) <= snap
                or sign * winding * (c-d) <= 0):
            return None
        choices = [{'normal': n, 'offset': c}, {'normal': m, 'offset': d}]
        selected = g._choose_side_face(choices, [(a, b)], raster, winding, policy, snap)
        if selected is choices[1]:
            return None
        # Explicitly test evidence against the chosen face as well as for it.
        contrast = [g._side_contrast(a, b, item['normal'], item['offset'], raster, winding) for item in choices]
        if any(value is None for value in contrast):
            return None
        if sign * contrast[1] >= .08 and sign * (contrast[0] - contrast[1]) <= -.12:
            return None
        supported |= selected is choices[0]
    return wanted if supported else None


def _plans(index, points, original, segments, bounds, locked, snap, verified):
    size = len(points)
    previous, following = (index - 1) % size, (index + 1) % size
    a, b = points[index], points[following]
    radius = min(5 * snap, g._distance(a, b) / 5)
    options = []
    for edge, search in ((previous, snap), (index, radius), (following, snap)):
        p, q = points[edge], points[(edge + 1) % size]
        candidates = [o for o in g._vector_candidates(p, q, segments, search) if o['support'] >= .9]
        if verified[edge]:
            candidates = [o for o in candidates if all(
                abs(sum(o['normal'][k] * x[k] for k in (0, 1)) - o['offset']) < .5 for x in (p, q))]
        if edge in locked:
            candidates = [o for o in candidates if all(
                abs(sum(o['normal'][k] * x[k] for k in (0, 1)) - o['offset']) < .05 for x in (p, q))]
        # Dense, ambiguous linework must not turn into an unbounded search or an
        # arbitrary truncation of the candidate set.
        if not candidates or len(candidates) > 8:
            return []
        options.append(candidates)
    if len(options[0]) * len(options[1]) * len(options[2]) > 64:
        return []
    plans = []
    for neighbours in product(*options):
        assignments = {i: _line_key(o) for i, o in zip((previous, index, following), neighbours)}
        candidate = _reconstruct(points, assignments)
        if candidate is None:
            continue
        if (max(g._distance(points[i], candidate[i]) for i in (index, following)) > radius
                or max(g._distance(points[i], candidate[i]) for i in (previous, (following + 1) % size)) > 1.6 * snap):
            continue
        if not g._continuous_vector_span(candidate[index], candidate[following], segments):
            continue
        if not all(_vector_connected(candidate[i], candidate[(i + 1) % size], segments, snap)
                   for i in (previous, following)):
            continue
        if not _safe(candidate, original, bounds, 5 * snap):
            continue
        # Do not break a verified far corner. A previously unverified adjoining
        # edge remains subject to review; it cannot veto an independently proven
        # correction at the two central corners, nor serve as its source evidence.
        if not all(_vector_connected(candidate[i], candidate[(i + 1) % size], segments, snap)
                   for i in ((previous - 1) % size, (following + 1) % size)
                   if verified[i] and (g._distance(points[(i + 1) % size], candidate[(i + 1) % size]) > .5
                                       or g._distance(points[i], candidate[i]) > .5)):
            continue
        if any(max(g._distance(p, q) for p, q in zip(candidate, plan['points'])) < .5 for plan in plans):
            continue
        plans.append({'points': candidate, 'lines': assignments, 'edge': index})
    return plans


def verify_perimeter(fitted, original, segments, raster, bounds, policy, locked):
    """Audit every edge, select connected alternatives, then validate one batch."""
    points, evidence, warnings = fitted
    snap, size = g._max_shift(bounds), len(points)
    verified = [_verified(a, b, segments, raster, snap) for a, b in zip(points, points[1:] + points[:1])]
    proposals = []
    if segments and 'fitting_rejected' not in warnings and 'component_conflict' not in warnings:
        for index in range(size):
            if verified[index] or index in locked:
                continue
            # An already resolved adjoining side may anchor a candidate, but
            # continuity ambiguity is never overridden by this broader search.
            if any(locked.get(i, False) for i in ((index-1) % size, (index+1) % size)):
                continue
            plans = _plans(index, points, original, segments, bounds, locked, snap, verified)
            chosen = _policy_choice(plans, points, raster, policy, snap)
            if chosen is not None:
                proposals.append(chosen)
    # Reject BOTH incompatible plans. Selection must not depend on ring start.
    conflicts = set()
    for i, first in enumerate(proposals):
        for j, second in enumerate(proposals[i+1:], i+1):
            for edge in first['lines'].keys() & second['lines'].keys():
                endpoints = (first['points'][edge], first['points'][(edge+1) % size])
                if not _same_line(first['lines'][edge], second['lines'][edge], endpoints):
                    conflicts.update((i, j))
    proposals = [p for i, p in enumerate(proposals) if i not in conflicts]
    assignments = {i: line for p in proposals for i, line in p['lines'].items()}
    candidate = _reconstruct(points, assignments) if assignments else None
    notes = set(warnings)
    corrected = (candidate is not None and _safe(candidate, original, bounds, 5*snap)
                 and all(_vector_connected(candidate[i], candidate[(i+1) % size], segments, snap) for i in assignments)
                 and all(g._continuous_vector_span(candidate[p['edge']], candidate[(p['edge']+1) % size], segments)
                         for p in proposals))
    if corrected and max(g._distance(p, q) for p, q in zip(candidate, points)) > .05:
        points = candidate
        notes.add('boundary_alignment_corrected')
        evidence = []
        for index, (a, b) in enumerate(zip(points, points[1:] + points[:1])):
            support = max((o['support'] for o in g._vector_candidates(a, b, segments, .5)), default=0.)
            source = 'vector'
            if support < .55:
                n, c = g._line(a, b)[1:]
                support = g._raster_support(a, b, n, c, raster)
                source = 'raster' if support >= .55 else 'unsupported'
            evidence.append({'index': index, 'support': round(support, 4), 'source': source,
                             'ambiguous': fitted[1][index]['ambiguous'] if index not in assignments else False})
        verified = [_verified(a, b, segments, raster, snap) for a, b in zip(points, points[1:] + points[:1])]
        if not g._contacts_roi(points, bounds):
            notes.discard('roi_boundary_contact')
        if all(e['source'] != 'unsupported' and e['support'] >= .55 for e in evidence):
            notes.discard('unsupported_boundary_segments')
        if all(not e['ambiguous'] for e in evidence):
            notes.discard('ambiguous_parallel_edges')
    updated = [dict(edge) for edge in evidence]
    for index, good in enumerate(verified):
        if not good:
            updated[index]['ambiguous'] = True
    if not all(verified):
        notes.add('boundary_connections_unverified')
    winding = 1 if g._area(points) > 0 else -1
    for index, (a, b) in enumerate(zip(points, points[1:] + points[:1])):
        if verified[index] and _contrary_face(a, b, segments, raster, winding, policy, snap):
            updated[index]['ambiguous'] = True
            notes.add('boundary_policy_unverified')
    return points, updated, sorted(notes)
