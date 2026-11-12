#!/usr/bin/env python3
"""Bake the brand mark ("sygnet Przesmyk") into index.html.

The mark exists in the page in three forms that must describe the same outline:

  1. the 2-D mark: favicon data URI and the three inline <svg> copies (#flying-mark, #header-logo,
     #artifact-poster);
  2. assets.logo: the two polygons that geometry/builder extrudes into the 3-D signet (hero and intro);
  3. assets.foundry: nine packed meshes of the intro foundry (sand mould with the mark-shaped cavity,
     molten fill of each part, pouring well and runners, gate pieces that break off).

scripts/mark/mark.json is the single source for all three. This tool regenerates them and patches the
`GuziczakModules.define("assets", ...)` line, the favicon and the inline marks in index.html.

    python3 scripts/mark/bake.py            # dry run: report sizes, gates and derived constants
    python3 scripts/mark/bake.py --write    # also rewrite index.html, then run: node scripts/build.cjs

It is NOT part of the build or of CI and it is the only thing in the repository with dependencies:
Python 3.10+, numpy and shapely >= 2.1 (constrained Delaunay). Triangulations may differ between
shapely/GEOS versions, so the baked bytes are not guaranteed to be reproducible bit for bit; the
relations that matter are asserted by tests/mark-parity.test.cjs, which needs nothing but Node.

Some outline-derived constants live in authored code and are NOT rewritten by this tool. It reads
them from the page, prints the value each should have and exits with status 2 if one is out of date:
  - config/casting  joints[*].pivot / localPivot   = fracture point of each gate
  - config/casting  park.z / park.yaw              = both centroids on the centre line of the front plank
  - config/reclaim  streams[*].points[0]           = overflow roots, which must lie inside the filled
                                                     mark (reported with their depth; chosen by hand)

The viewBox is the frame the 3-D layout code assumes (2.2 x 2.24 around the origin); it is fixed.

Conventions. mark.json paths are SVG path data (absolute M/L/C/Z only) in the mark's viewBox, y down.
assets.logo is the same outline flattened at `segmentsPerCubic` uniform parameter steps per cubic,
y negated (y up), rounded to 6 decimals, counter-clockwise. Mould space (assets.foundry, gate paths):
X = 0.79 * x_logo, Z = 0.20 - 0.79 * y_logo, Y up with the sand top at Y = 0 (config/casting `rest`).
Packed mesh format: base64 of a little-endian Float32Array, 9 floats per vertex
[px,py,pz, nx,ny,nz, u,v, materialId], non-indexed triangles (geometry/catalog `packedMesh`).

The foundry construction was reverse-engineered from the previously shipped asset (whose generator
was never in the repository) and reproduces its geometry for the old outline; it is a reconstruction,
not the original tool.
"""
import argparse, base64, heapq, json, math, os, re, sys, urllib.parse
import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, Point, LineString, LinearRing, box
from shapely.ops import unary_union
if not hasattr(shapely, 'constrained_delaunay_triangles'):
    raise SystemExit('scripts/mark/bake.py needs shapely >= 2.1 (found %s): pip install "shapely>=2.1"' % shapely.__version__)

# ---- constants recovered from the shipped asset / page config -------------------------------------------------------
S, REST_Z, REST_Y = 0.79, 0.20, -0.0838            # config/casting rest
HALF_DEPTH = 0.08                                   # extrudeLogo depth .16
Y_TOP, Y_BOT = -0.0206, -0.147                      # REST_Y +- .08*S ; cold feeder / gate prisms
BLOCK = (-1.1, -1.24, 1.1, 1.16)                    # sand block x0,z0,x1,z1 ; top y=0, underside y=-.275
BLOCK_BOTTOM = -0.275
CLEAR_PART, CLEAR_FEED = 0.014, 0.009               # cavity wall offset from the casting / from the feeder
CHAMFER_W, CHAMFER_D = 0.024, 0.025                 # rim bevel: horizontal run / drop
FLOOR_Y = -0.156
WELL = (0.0, -0.90); WELL_R = 0.157; WELL_SEG = 96  # scene/cast-liquid config wellX/wellZ
FEED_GAP = 0.002                                    # molten feeder stops this far from the casting outline
NECK = 0.070                                        # gateBase length upstream of the pivot
PIVOT_BACK = 0.0277                                 # pivot (fracture) distance upstream of the outline along the runner
FRACTURE = [(-0.03, -0.0033), (-0.02, 0.0009), (-0.01, -0.00133), (0, 0), (0.01, 0.00133), (0.02, -0.0009), (0.03, 0.0033)]
COLLAR_OUT, COLLAR_IN, COLLAR_SIDE = 0.0025, 0.002, 0.004
MAX_EDGE = 0.085                                    # melt-surface refinement threshold (castings)
MAX_EDGE_FEED = 0.05                                # finer inside the well/runners: the impact ripples live there
EDGE_CAP = 0.1                                      # uv.y = min(distance to outline, .1)
GRID_H = 0.006                                      # arrival-field grid step
CONTACT_R = 0.03                                    # radius of the authored contact triangle under the jet (< quietRadius .05)
M_GOLD, M_SAND, M_CAVITY, M_CAST, M_FRACTURE = 1, 16, 17, 20, 24   # config/materials

def logo2mould(P): P = np.asarray(P, float); return np.c_[S * P[:, 0], REST_Z - S * P[:, 1]]
def mould2logo(Q): Q = np.asarray(Q, float); return np.c_[Q[:, 0] / S, (REST_Z - Q[:, 1]) / S]
def ring(poly_or_ring):
    g = poly_or_ring.exterior if getattr(poly_or_ring, 'geom_type', '') == 'Polygon' else poly_or_ring
    c = np.asarray(g.coords if hasattr(g, 'coords') else g, float)
    return c[:-1] if np.allclose(c[0], c[-1]) else c
def polys(g):
    if g.is_empty: return []
    if g.geom_type == 'Polygon': return [g]
    return [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon' and p.area > 1e-12]
def biggest(g): return max(polys(g), key=lambda p: p.area)
def tri2d(poly):
    """Constrained Delaunay triangles of a polygon (with holes); only polygon vertices are used. CCW in (x,z)."""
    out = []
    for p in polys(poly):
        for t in shapely.constrained_delaunay_triangles(p).geoms:
            c = np.asarray(t.exterior.coords)[:3]
            a = (c[1, 0] - c[0, 0]) * (c[2, 1] - c[0, 1]) - (c[1, 1] - c[0, 1]) * (c[2, 0] - c[0, 0])
            if abs(a) < 1e-14: continue
            out.append(c if a > 0 else c[::-1])
    return out

class Mesh:
    def __init__(self): self.v = []
    def tri(self, a, b, c, n, uv, mat):
        """a,b,c 3-vectors; n one normal or three; uv one pair or three."""
        ns = n if np.ndim(n) == 2 else [n, n, n]; us = uv if np.ndim(uv) == 2 else [uv, uv, uv]
        for p, nn, u in zip((a, b, c), ns, us): self.v.append([*p, *nn, *u, mat])
    def up(self, t2, y, mat, uvf=None):
        """horizontal triangle facing +y from a CCW-in-(x,z) 2-D triangle: emit so that cross() = +y."""
        a, b, c = t2
        P = [(a[0], y, a[1]), (c[0], y, c[1]), (b[0], y, b[1])]
        U = [uvf(p) if uvf else (p[0], p[2]) for p in P]
        self.tri(*P, (0, 1, 0), U, mat)
    def array(self):
        a = np.asarray(self.v, dtype='<f4'); assert a.size % 27 == 0 and np.isfinite(a).all(); return a
def b64(a): return base64.b64encode(np.ascontiguousarray(a, dtype='<f4').tobytes()).decode('ascii')

# ---- arrival field: 8-connected grid Dijkstra over the cavity polygon, bilinear sampling ------------------------------
def arrival_field(domain, h=GRID_H):
    x0, z0, x1, z1 = domain.bounds
    # put a node exactly on the well centre (the shipped field has its zero at the node nearest the centre)
    x0 = WELL[0] - math.ceil((WELL[0] - x0) / h + 2) * h; z0 = WELL[1] - math.ceil((WELL[1] - z0) / h + 2) * h
    nx = int(math.ceil((x1 - x0) / h)) + 3; nz = int(math.ceil((z1 - z0) / h)) + 3
    X, Z = np.meshgrid(x0 + np.arange(nx) * h, z0 + np.arange(nz) * h, indexing='ij')
    mask = shapely.contains_xy(domain, X, Z)
    si, sj = int(round((WELL[0] - x0) / h)), int(round((WELL[1] - z0) / h))
    D = np.full((nx, nz), np.inf); D[si, sj] = 0.0; pq = [(0.0, si, sj)]; r2 = h * math.sqrt(2)
    moves = [(1, 0, h), (-1, 0, h), (0, 1, h), (0, -1, h), (1, 1, r2), (1, -1, r2), (-1, 1, r2), (-1, -1, r2)]
    while pq:
        d, i, j = heapq.heappop(pq)
        if d > D[i, j]: continue
        for di, dj, w in moves:
            a, b = i + di, j + dj
            if 0 <= a < nx and 0 <= b < nz and mask[a, b] and d + w < D[a, b]:
                D[a, b] = d + w; heapq.heappush(pq, (d + w, a, b))
    def sample(x, z):
        fx, fz = (x - x0) / h, (z - z0) / h; i, j = int(math.floor(fx)), int(math.floor(fz)); tx, tz = fx - i, fz - j
        acc = wsum = 0.0
        for a, b, w in ((i, j, (1 - tx) * (1 - tz)), (i + 1, j, tx * (1 - tz)), (i, j + 1, (1 - tx) * tz), (i + 1, j + 1, tx * tz)):
            if 0 <= a < nx and 0 <= b < nz and np.isfinite(D[a, b]) and w > 0: acc += w * D[a, b]; wsum += w
        if wsum > 1e-9: return acc / wsum
        # outside the reachable mask: nearest reachable node + straight hop
        best = np.inf
        for a in range(max(0, i - 3), min(nx, i + 5)):
            for b in range(max(0, j - 3), min(nz, j + 5)):
                if np.isfinite(D[a, b]): best = min(best, D[a, b] + math.hypot(X[a, b] - x, Z[a, b] - z))
        assert np.isfinite(best), ('vertex outside the flow domain', x, z); return best
    return sample

# ---- molten surfaces (melt0, melt1, feed): unit-height prisms, y in {0,1}; mode 5 scales them -------
def split_long(P, limit=MAX_EDGE):
    out = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]; L = np.linalg.norm(b - a); k = 1
        while L / k > limit: k *= 2
        for j in range(k): out.append(a + (b - a) * j / k)
    return np.asarray(out)
def refine(tris, limit=MAX_EDGE, must_contain=None, radius=None):
    """midpoint subdivision of every edge longer than limit (shared edges get identical midpoints -> conforming)."""
    tris = [np.asarray(t, float) for t in tris]
    for _ in range(12):
        nxt = []; changed = False
        for t in tris:
            L = [np.linalg.norm(t[(k + 1) % 3] - t[k]) for k in range(3)]
            lim = limit
            if must_contain is not None and min(np.linalg.norm(t - must_contain, axis=1)) < radius * 2.5: lim = min(limit, radius * 0.8)
            long = [l > lim for l in L]; n = sum(long)
            if n == 0: nxt.append(t); continue
            changed = True; m = [(t[k] + t[(k + 1) % 3]) / 2 for k in range(3)]
            if n == 3: nxt += [np.array([t[0], m[0], m[2]]), np.array([m[0], t[1], m[1]]), np.array([m[2], m[1], t[2]]), np.array([m[0], m[1], m[2]])]
            elif n == 1:
                k = long.index(True); a, b, c = t[k], t[(k + 1) % 3], t[(k + 2) % 3]
                nxt += [np.array([a, m[k], c]), np.array([m[k], b, c])]
            else:
                k = long.index(False); a, b, c = t[k], t[(k + 1) % 3], t[(k + 2) % 3]      # edge a-b is the short one
                mbc, mca = (b + c) / 2, (c + a) / 2
                nxt += [np.array([a, b, mbc]), np.array([a, mbc, mca]), np.array([mca, mbc, c])]
        tris = nxt
        if not changed: break
    return tris
def molten(outline, arrival, well=False, limit=MAX_EDGE):
    """outline: (n,2) mould-space polygon in the SAME cyclic order as the logo polygon mapped with logo2mould
    (i.e. CCW in logo space).  Returns Mesh."""
    m = Mesh(); P = np.asarray(outline, float); n = len(P); bnd = LinearRing(P)
    uvx = lambda x, z: arrival(x, z)
    # top: split long outline edges, triangulate, refine
    if well:
        # scene/cast-liquid.contactTriangle needs ONE top triangle that strictly contains the well
        # centre, with all three vertices inside the quiet patch (r < .05), uv.y >= .035 and uv.x > 0
        # (tests/casting-liquid.test.cjs:23-45).  A regular 96-gon triangulates with diameters THROUGH the centre, so the
        # triangle is authored explicitly: three Steiner vertices at r = CONTACT_R, kept as a hole of the triangulation.
        ang = np.radians([100.0, 220.0, 340.0]); steiner = np.c_[WELL[0] + CONTACT_R * np.cos(ang), WELL[1] + CONTACT_R * np.sin(ang)]
        top = refine(tri2d(Polygon(split_long(P), [steiner])) + tri2d(Polygon(steiner)), limit)
    else:
        top = refine(tri2d(Polygon(split_long(P))), limit)
    cache = {}
    def uv(p):
        k = (round(p[0], 7), round(p[2], 7))
        if k not in cache: cache[k] = (uvx(p[0], p[2]), min(bnd.distance(Point(p[0], p[2])), EDGE_CAP))
        return cache[k]
    for t in top: m.up(t, 1.0, M_CAST, uv)
    # side walls: one quad per ORIGINAL outline edge, (top_i, top_j, bot_j) + (top_i, bot_j, bot_i), flat normal = cross
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        a1, b1, b0, a0 = (a[0], 1.0, a[1]), (b[0], 1.0, b[1]), (b[0], 0.0, b[1]), (a[0], 0.0, a[1])
        nrm = np.cross(np.subtract(b1, a1), np.subtract(b0, a1)); nrm = nrm / np.linalg.norm(nrm)
        ua, ub = (uvx(*a), 0.0), (uvx(*b), 0.0)
        m.tri(a1, b1, b0, nrm, [ua, ub, ub], M_CAST); m.tri(a1, b0, a0, nrm, [ua, ub, ua], M_CAST)
    return m

# ---- cold prisms (feedBody, gateBase*, gateTip*) -----------------------------------------------------------------------
def prism(poly, lo, hi, side_mat, to3, weight=None):
    """poly: shapely polygon in a 2-D frame; to3(p2, h) -> 3-D point; side_mat(a2,b2) -> material id.
    caps at h=hi (+normal) and h=lo (-normal), sides with outward normals."""
    m = Mesh(); w = weight or (lambda p: 0.0)
    up = np.subtract(to3((0, 0), 1), to3((0, 0), 0)); up = up / np.linalg.norm(up)
    for t in tri2d(poly):
        A = [to3(p, hi) for p in t]; nrm = np.cross(np.subtract(A[1], A[0]), np.subtract(A[2], A[0]))
        if np.dot(nrm, up) < 0: t = t[::-1]; A = A[::-1]
        m.tri(*A, up, [(w(p), 0.0) for p in t], M_GOLD)
        Bt = [to3(p, lo) for p in t[::-1]]; m.tri(*Bt, -up, [(w(p), 0.0) for p in t[::-1]], M_GOLD)
    for p in polys(poly):
        for r in [p.exterior, *p.interiors]:
            R = ring(r)
            for i in range(len(R)):
                a, b = R[i], R[(i + 1) % len(R)]
                if np.linalg.norm(b - a) < 1e-9: continue
                a0, a1, b0, b1 = to3(a, lo), to3(a, hi), to3(b, lo), to3(b, hi)
                nrm = np.cross(np.subtract(b0, a0), np.subtract(a1, a0)); nrm = nrm / np.linalg.norm(nrm)
                mid = (a + b) / 2; e = (b - a) / np.linalg.norm(b - a); n2 = np.array([e[1], -e[0]])
                if p.contains(Point(*(mid + 1e-5 * n2))): n2 = -n2            # make n2 outward in 2-D
                o3 = np.subtract(to3(mid + n2, lo), to3(mid, lo))
                if np.dot(nrm, o3) < 0: nrm = -nrm
                mat = side_mat(a, b); wa, wb = (w(a), 0.0), (w(b), 0.0)
                if np.dot(np.cross(np.subtract(b1, a0), np.subtract(b0, a0)), nrm) > 0:
                    m.tri(a0, b1, b0, nrm, [wa, wb, wb], mat); m.tri(a0, a1, b1, nrm, [wa, wa, wb], mat)
                else:
                    m.tri(a0, b0, b1, nrm, [wa, wb, wb], mat); m.tri(a0, b1, a1, nrm, [wa, wb, wa], mat)
    return m
MOULD3 = lambda p, h: (p[0], h, p[1])
LOGO3 = lambda p, h: (p[0], p[1], h)

def build(spec, report=False):
    logo = [np.asarray(p, float) for p in spec['logo']]
    for i, p in enumerate(logo):                       # extrudeLogo normalises to CCW
        if 0.5 * np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]) < 0: logo[i] = p[::-1]
    parts = [logo2mould(p) for p in logo]; PP = [Polygon(p) for p in parts]
    assert all(p.is_valid for p in PP) and PP[0].distance(PP[1]) > 0
    info = {'gates': {}}
    # --- feeder outline: well disc + stroked runners, trimmed FEED_GAP short of the castings
    a = np.arange(WELL_SEG) * 2 * math.pi / WELL_SEG
    well = Polygon(np.c_[WELL[0] + WELL_R * np.cos(a), WELL[1] + WELL_R * np.sin(a)])
    strokes = []; frames = {}
    for g in spec['gates']:
        path = np.asarray(g['path'], float); w = g['width']; part = PP[g['part']]
        d = path[-1] - path[-2]; d = d / np.linalg.norm(d); n = np.array([d[1], -d[0]])
        hit = LineString([path[-2], path[-1] + d * 0.2]).intersection(part.exterior)
        pts = np.array([c for gg in getattr(hit, 'geoms', [hit]) for c in gg.coords]); assert len(pts), 'runner does not reach its part'
        H = pts[np.argmin((pts - path[-2]) @ d)]
        pivot = np.asarray(g['pivot'], float) if g.get('pivot') else np.round(H - PIVOT_BACK * d, 3)
        full = np.vstack([path[:-1], H + d * 0.03])
        stroke = LineString(full).buffer(w / 2, cap_style='flat', join_style='round', quad_segs=16)
        strokes.append(stroke)
        # A runner may meet only its own casting, and only at its mouth. Anywhere closer than a full sand wall
        # (two cavity offsets and both rim bevels) the cavities would merge and metal would cross.
        wall = CLEAR_PART + CLEAR_FEED + 2 * CHAMFER_W
        for k, other in enumerate(PP):
            reach = stroke if k != g['part'] else stroke.difference(Point(*H).buffer(0.1))
            if not reach.is_empty and reach.distance(other) < wall:
                raise SystemExit('gate %s: its runner passes %.3f from casting %d; it needs %.3f of sand'
                                 % (g['name'], reach.distance(other), k, wall))
        loc = lambda c, al, pv=pivot, d=d, n=n: pv + n * c + d * al
        frac = [loc(c, al) for c, al in FRACTURE]
        down = Polygon([*frac, loc(0.05, 0.0033), loc(0.05, 0.3), loc(-0.05, 0.3), loc(-0.05, -0.0033)])     # downstream of the fracture
        slab = Polygon([loc(-w / 2 - 0.02, -NECK), loc(w / 2 + 0.02, -NECK), loc(w / 2 + 0.02, 0.3), loc(-w / 2 - 0.02, 0.3)])  # everything past the neck cut
        frames[g['name']] = dict(d=d, n=n, pivot=pivot, axis=pivot - n * float((pivot - path[-2]) @ n), H=H, w=w, down=down, slab=slab, part=g['part'], stroke=stroke)
        info['gates'][g['name']] = dict(part=g['part'], pivot=[float(pivot[0]), REST_Y, float(pivot[1])],
            localPivot=[float(pivot[0] / S), float((REST_Z - pivot[1]) / S), 0.0], hit=H.tolist(), axis=d.tolist(),
            pivot_to_outline=float((H - pivot) @ d), pivot_off_axis=float((pivot - path[-2]) @ n))
    feed = unary_union([well, *strokes])
    for p in PP: feed = feed.difference(p.buffer(FEED_GAP, join_style='mitre'))
    feed = biggest(feed); assert feed.contains(Point(*WELL)) and len(feed.interiors) == 0
    feed = Polygon(ring(feed.simplify(1e-5)))
    F = ring(feed)
    if Polygon(F).exterior.is_ccw: F = F[::-1]         # same sense as a CCW logo polygon after logo2mould (clockwise in x,z)
    # --- cavity outlines
    cav = unary_union([*(p.buffer(CLEAR_PART, join_style='round', quad_segs=3) for p in PP), feed.buffer(CLEAR_FEED, join_style='round', quad_segs=3)])
    assert cav.geom_type == 'Polygon', 'cavity must be one connected region'
    cav = cav.simplify(2e-4)
    rim = cav.buffer(CHAMFER_W, join_style='round', quad_segs=3).simplify(2e-4)
    blk = box(*BLOCK); assert blk.contains(rim), 'cavity + rim bevel must stay inside the sand block'
    arrival = arrival_field(cav)
    scale = 1.0
    if spec.get('arrivalMax'):
        mx = max(arrival(x, z) for P in parts for x, z in P); scale = spec['arrivalMax'] / mx
        raw = arrival; arrival = lambda x, z: raw(x, z) * scale
    info['arrivalScale'] = scale
    out = {}
    # --- sand
    m = Mesh()
    for t in tri2d(blk.difference(rim)): m.up(t, 0.0, M_SAND)                                   # flat top incl. islands
    cavb = cav.boundary; rimb = rim.boundary
    def hy(p):
        # A vertex on the rim outline meets the flat top at exactly 0 (after simplification it can sit a hair inside
        # the nominal bevel width, which would open a crack); one on the cavity outline meets the wall.
        if rimb.distance(Point(p[0], p[1])) < 1e-9: return 0.0
        dd = cavb.distance(Point(p[0], p[1])); return 0.0 if dd >= CHAMFER_W - 1e-6 else (-CHAMFER_D if dd < 1e-6 else -CHAMFER_D * (1 - dd / CHAMFER_W))
    for t in tri2d(rim.difference(cav)):                                                         # rim bevel, flat-shaded
        P3 = [np.array([p[0], hy(p), p[1]]) for p in (t[0], t[2], t[1])]
        nrm = np.cross(P3[1] - P3[0], P3[2] - P3[0]); nrm = nrm / np.linalg.norm(nrm)
        m.tri(*P3, nrm, [(p[0], p[2]) for p in P3], M_SAND)
    for t in tri2d(cav): m.up(t, FLOOR_Y, M_CAVITY)                                              # cavity floor
    for r in [cav.exterior, *cav.interiors]:                                                     # cavity walls, facing the cavity
        R = ring(r)
        for i in range(len(R)):
            a, b = R[i], R[(i + 1) % len(R)]; e = (b - a) / np.linalg.norm(b - a); n2 = np.array([e[1], -e[0]])
            if not cav.contains(Point(*((a + b) / 2 + 1e-5 * n2))): n2 = -n2
            nrm = (n2[0], 0.0, n2[1]); at, bt, ab, bb = (a[0], -CHAMFER_D, a[1]), (b[0], -CHAMFER_D, b[1]), (a[0], FLOOR_Y, a[1]), (b[0], FLOOR_Y, b[1])
            m.tri(at, bt, bb, nrm, [(1, 0), (1, 0), (0, 0)], M_CAVITY); m.tri(at, bb, ab, nrm, [(1, 0), (0, 0), (0, 0)], M_CAVITY)
    x0, z0, x1, z1 = BLOCK; B = BLOCK_BOTTOM                                                     # four outer sides (copied layout)
    for (ax, az), (bx, bz), nrm in (((x1, z0), (x1, z1), (1, 0, 0)), ((x1, z1), (x0, z1), (0, 0, 1)), ((x0, z1), (x0, z0), (-1, 0, 0)), ((x0, z0), (x1, z0), (0, 0, -1))):
        m.tri((ax, 0, az), (bx, 0, bz), (bx, B, bz), nrm, (0, 0), M_SAND); m.tri((ax, 0, az), (bx, B, bz), (ax, B, az), nrm, (0, 0), M_SAND)
    out['sand'] = m.array()
    # --- molten meshes
    out['melt0'] = molten(parts[0], arrival).array(); out['melt1'] = molten(parts[1], arrival).array()
    out['feed'] = molten(F, arrival, well=True, limit=MAX_EDGE_FEED).array()
    # --- cold feeder pieces
    body = feed
    for name, f in frames.items():
        strip = feed.intersection(f['slab'])                                   # runner section past the neck cut (feed is already trimmed)
        body = body.difference(f['slab'])
        base = biggest(strip.difference(f['down'])); 
        d, n, pv, w = f['d'], f['n'], f['pivot'], f['w']
        # subdivide the two long sides of the base into thirds so the mode-7 smoothstep bends like the original
        R = ring(base); R2 = []
        for i in range(len(R)):
            a, b = R[i], R[(i + 1) % len(R)]; R2.append(a)
            if abs(abs((b - a) @ d) - np.linalg.norm(b - a)) < 1e-6 and np.linalg.norm(b - a) > 0.03: R2 += [a + (b - a) / 3, a + (b - a) * 2 / 3]
        base = Polygon(R2)
        fl = LineString([pv + n * c + d * al for c, al in FRACTURE])
        def weight(p, pv=pv, d=d, n=n):
            c = (np.asarray(p) - pv) @ n; al = (np.asarray(p) - pv) @ d
            fa = np.interp(c, [q[0] for q in FRACTURE], [q[1] for q in FRACTURE])
            return float(min(1.0, max(0.0, (al + NECK) / (fa + NECK))))
        on_frac = lambda a, b, fl=fl: M_FRACTURE if fl.distance(Point(*((np.asarray(a) + np.asarray(b)) / 2))) < 1e-6 and fl.distance(Point(*a)) < 1e-6 else M_GOLD
        out['gateBase' + name] = prism(base, Y_BOT, Y_TOP, on_frac, MOULD3, weight).array()
        part = PP[f['part']]
        ax = f['axis']       # the stub continues the runner, so it is centred on the runner axis like gateBase (the pivot is rounded)
        rect = lambda hw, a0, a1: Polygon([ax + n * -hw + d * a0, ax + n * hw + d * a0, ax + n * hw + d * a1, ax + n * -hw + d * a1])
        neck = rect(w / 2, -0.02, 0.3).intersection(f['down']).difference(part.buffer(COLLAR_OUT, join_style='mitre'))
        neck = min(polys(neck), key=lambda p: p.distance(Point(*pv)))
        band = part.buffer(COLLAR_OUT, join_style='mitre').difference(part.buffer(-COLLAR_IN, join_style='mitre'))
        collar = band.intersection(rect(w / 2 + COLLAR_SIDE, 0.0, 0.3)); collar = min(polys(collar), key=lambda p: p.distance(Point(*f['H'])))
        tip = unary_union([neck.buffer(1e-7), collar]); tip = biggest(tip).simplify(1e-6)
        tipL = Polygon(mould2logo(ring(tip)))
        flL = LineString(mould2logo(np.array(fl.coords)))
        on_fracL = lambda a, b, fl=flL: M_FRACTURE if fl.distance(Point(*((np.asarray(a) + np.asarray(b)) / 2))) < 1e-6 and fl.distance(Point(*a)) < 1e-6 else M_GOLD
        out['gateTip' + name] = prism(tipL, -HALF_DEPTH, HALF_DEPTH, on_fracL, LOGO3).array()
        info['gates'][name].update(baseArea=base.area, tipArea=tip.area)
    body = biggest(body)
    out['feedBody'] = prism(body, Y_BOT, Y_TOP, lambda a, b: M_GOLD, MOULD3).array()
    order = ['sand', 'melt0', 'melt1', 'feed', 'gateBaseA', 'gateTipA', 'gateBaseB', 'gateTipB', 'feedBody']
    out = {k: out[k] for k in order if k in out}
    info.update(feedOutline=F.tolist(), cavity=ring(cav).tolist(), rimOuter=ring(rim).tolist(), rimHoles=[ring(r).tolist() for r in rim.interiors],
                counts={k: int(v.size // 27) for k, v in out.items()}, chars={k: int(v.size * 4 // 3 * 4) for k, v in out.items()})
    info['fillEnd'] = 9.34 + 0.57 * max(float(out[k].reshape(-1, 9)[:, 6].max()) for k in ('melt0', 'melt1', 'feed')) + 0.76   # scene/cast-liquid arrival, travel, fill
    info['arrival'] = {k: [float(out[k].reshape(-1, 9)[:, 6].min()), float(out[k].reshape(-1, 9)[:, 6].max())] for k in ('melt0', 'melt1', 'feed')}
    return out, info


# ---- mark.json -> outline -----------------------------------------------------------------------------------------------
TOKEN = re.compile(r'[MLCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?')
def parse_path(d):
    """Absolute M/L/C/Z path data -> [(op, [[x, y], ...])]."""
    tok = TOKEN.findall(d); i = 0; cmds = []
    while i < len(tok):
        op = tok[i]; i += 1
        if op not in 'MLCZ': raise ValueError('unsupported path command %r' % op)
        n = {'M': 2, 'L': 2, 'C': 6, 'Z': 0}[op]; vals = [float(v) for v in tok[i:i + n]]; i += n
        if len(vals) != n: raise ValueError('truncated path data')
        cmds.append((op, [vals[k:k + 2] for k in range(0, n, 2)]))
    return cmds
def flatten(d, n):
    """The rule tests/mark-parity.test.cjs repeats: path order, n uniform steps per cubic, y negated, 6 decimals."""
    P = []; cur = None
    for op, ps in parse_path(d):
        if op in 'ML': cur = ps[0]; P.append(cur)
        elif op == 'C':
            p0 = cur
            for k in range(1, n + 1):
                t = k / n; s = 1 - t
                P.append([s * s * s * p0[0] + 3 * s * s * t * ps[0][0] + 3 * s * t * t * ps[1][0] + t * t * t * ps[2][0],
                          s * s * s * p0[1] + 3 * s * s * t * ps[0][1] + 3 * s * t * t * ps[1][1] + t * t * t * ps[2][1]])
            cur = ps[2]
    if len(P) > 1 and math.hypot(P[0][0] - P[-1][0], P[0][1] - P[-1][1]) < 1e-9: P.pop()
    return [[round(x, 6), round(-y, 6)] for x, y in P]
def signed_area(P):
    P = np.asarray(P, float); return 0.5 * float(np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]))
BEVEL = 0.018                  # geometry/brand: the signet's bevel inset
def bevel_margin(P, bevel=BEVEL):
    """Shortest edge of the inset polygon geometry/builder extrudeLogo makes: each edge loses bevel * tan(turn / 2) at
    both ends. At zero or below, the inset edge flips and the bevelled cap intersects itself (sharp corner, short edge)."""
    P = np.asarray(P, float); e = np.roll(P, -1, 0) - P; L = np.hypot(e[:, 0], e[:, 1]); a = np.arctan2(e[:, 1], e[:, 0])
    turn = (a - np.roll(a, 1) + math.pi) % (2 * math.pi) - math.pi
    m = L - bevel * (np.tan(turn / 2) + np.tan(np.roll(turn, -1) / 2)); k = int(np.argmin(m)); return float(m[k]), k
def inline_svg(mark):
    paths = ''.join('<path d="%s" fill="%s"></path>' % (d, mark['fill']) for d in mark['paths'])
    return '<svg aria-hidden="true" viewbox="%s" xmlns="http://www.w3.org/2000/svg">%s</svg>' % (mark['viewBox'], paths)
def favicon_href(mark):
    paths = ''.join('<path d="%s" fill="%s"/>' % (d, mark['fill']) for d in mark['paths'])
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s" role="img" aria-label="GUZICZAK \u2014 sygnet %s">%s</svg>' % (mark['viewBox'], mark['name'], paths)
    return 'data:image/svg+xml,' + urllib.parse.quote(svg, safe='-_.~')

# ---- outline-derived constants that live in authored code ----------------------------------------------------------------
RAIL = (1.1625, 1.3775)        # config/casting frame.railMinZ / railMaxZ: the front plank the castings are parked on
FILL_REPORTED = 11.38          # scene/signature and scene/state report the mould as filled at this time
ROOT_DEPTH = 0.04              # an overflow sheet starts on metal: its root sits at least this far inside its part
NUM = r'(-?(?:\d+\.?\d*|\.\d+))'
JOINT_RE = r"name:'%s',pivot:\[" + NUM + ',' + NUM + ',' + NUM + r"\]"
PARK_RE = re.compile(r'z:frame\.originZ\+' + NUM + ',yaw:' + NUM)
ROOT_RE = r"\{id:'%s',[^{}]*?points:\[\[" + NUM + ',' + NUM + r'\]'
def constants(html, logo, info):
    """Compare the constants in the page's authored code with what this outline needs.  -> (lines, stale?)"""
    lines = []; stale = False
    def row(ok, text):
        nonlocal stale; stale = stale or not ok; lines.append(('ok      ' if ok else 'UPDATE  ') + text)
    for name, g in info['gates'].items():
        x, _, z = g['pivot']; want = "pivot:[%.3f,-.0838,%.3f],localPivot:[%.3f/.79,(.20%+.3f)/.79,0]" % (x, z, x, -z)
        m = re.search(JOINT_RE % name, html)
        ok = bool(m) and abs(float(m.group(1)) - x) < 5e-4 and abs(float(m.group(3)) - z) < 5e-4
        row(ok, 'config/casting joints[%s]  %s' % (name, want))
    c = [np.asarray(Polygon(p).centroid.coords[0]) for p in logo]
    yaw = math.atan2(c[0][1] - c[1][1], c[1][0] - c[0][0])
    z = (RAIL[0] + RAIL[1]) / 2 - S * (-math.sin(yaw) * c[0][0] - math.cos(yaw) * c[0][1])
    m = PARK_RE.search(html)
    row(bool(m) and abs(float(m.group(1)) - z) < 5e-4 and abs(float(m.group(2)) - yaw) < 5e-4,
        'config/casting park        z:frame.originZ+%.4f,yaw:%.4f' % (z, yaw))
    for part, stream in enumerate(('left', 'right')):
        m = re.search(ROOT_RE % stream, html); poly = Polygon(logo2mould(logo[part]))
        if not m: row(False, 'config/reclaim %s stream root not found' % stream); continue
        root = Point(float(m.group(1)), float(m.group(2))); depth = poly.exterior.distance(root) if poly.contains(root) else -poly.distance(root)
        row(depth >= ROOT_DEPTH, 'config/reclaim %-5s root [%s,%s] is %.3f inside part %s (at least %.2f)' % (stream, m.group(1), m.group(2), depth, 'AB'[part], ROOT_DEPTH))
    return lines, stale

# ---- page patching ----------------------------------------------------------------------------------------------------------
VIEWBOX = '-1.1 -1.12 2.2 2.24'
ASSETS_PREFIX = 'GuziczakModules.define("assets", [], () => ('
INLINE_RE = re.compile(r'(id="(?:flying-mark|header-logo|artifact-poster)">)<svg\b[^>]*>.*?</svg>')
FAVICON_RE = re.compile(r'(<link href=")data:image/svg\+xml,[^"]+(" rel="icon" type="image/svg\+xml"/>)')
def patch_page(html, mark, logo, foundry):
    lines = html.split('\n'); hits = [i for i, l in enumerate(lines) if l.startswith(ASSETS_PREFIX)]
    if len(hits) != 1: raise SystemExit('expected exactly one assets module line, found %d' % len(hits))
    payload = json.dumps({'logo': logo, 'foundry': foundry}, separators=(',', ':'))
    lines[hits[0]] = ASSETS_PREFIX + payload + '));'
    html = '\n'.join(lines)
    html, n = INLINE_RE.subn(lambda m: m.group(1) + inline_svg(mark), html)
    if n != 3: raise SystemExit('expected the inline marks #flying-mark, #header-logo and #artifact-poster, replaced %d' % n)
    html, n = FAVICON_RE.subn(lambda m: m.group(1) + favicon_href(mark) + m.group(2), html)
    if n != 1: raise SystemExit('expected 1 favicon, replaced %d' % n)
    return html

def main():
    here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(os.path.dirname(here))
    ap = argparse.ArgumentParser(description='Bake scripts/mark/mark.json into index.html')
    ap.add_argument('--mark', default=os.path.join(here, 'mark.json'))
    ap.add_argument('--page', default=os.path.join(root, 'index.html'))
    ap.add_argument('--write', action='store_true', help='rewrite the page in place (default: dry run)')
    args = ap.parse_args()
    mark = json.load(open(args.mark, encoding='utf8'))
    if mark['viewBox'] != VIEWBOX: raise SystemExit('the viewBox is fixed at "%s": the 3-D layout code assumes that frame' % VIEWBOX)
    logo = [flatten(d, mark['segmentsPerCubic']) for d in mark['paths']]
    if len(logo) != 2: raise SystemExit('the mark has exactly two parts: A and B')
    for i, p in enumerate(logo):
        if signed_area(p) <= 0: raise SystemExit('path %d must run counter-clockwise on screen' % i)
        margin, edge = bevel_margin(p)
        if margin < 0.004:
            raise SystemExit('path %d: the bevel inset leaves %.4f of edge %d; a curve ends too close to a sharp corner '
                             '(lengthen its last cubic or lower segmentsPerCubic)' % (i, margin, edge))
    out, info = build({'logo': logo, 'gates': mark['gates'], 'arrivalMax': mark.get('arrivalMax')})
    foundry = {k: b64(v) for k, v in out.items()}
    print('outline   : %s points, areas %s, gap %.4f' % ([len(p) for p in logo], [round(signed_area(p), 4) for p in logo], Polygon(logo[0]).distance(Polygon(logo[1]))))
    print('foundry   : %s' % ', '.join('%s %d' % (k, v) for k, v in info['counts'].items()), '(triangles); %d base64 chars' % sum(len(v) for v in foundry.values()))
    print('arrival   : %s, scale %.4f; the mould is full at %.3f s' % ({k: [round(a, 3) for a in v] for k, v in info['arrival'].items()}, info['arrivalScale'], info['fillEnd']))
    if info['fillEnd'] > FILL_REPORTED + 1e-3:
        raise SystemExit('the scene reports the mould as filled at %.2f s but this fill ends at %.3f s; lower arrivalMax' % (FILL_REPORTED, info['fillEnd']))
    html = open(args.page, encoding='utf8').read(); new = patch_page(html, mark, logo, foundry)
    lines, stale = constants(new, logo, info)
    for line in lines: print('constants : ' + line)
    same = new == html
    print('page      : %s (%d -> %d bytes)' % ('already up to date' if same else 'differs from this bake' + ('' if args.write else '; dry run, nothing written'),
                                             len(html.encode('utf8')), len(new.encode('utf8'))))
    if args.write and not same:
        with open(args.page, 'w', encoding='utf8', newline='') as f: f.write(new)
        print('wrote     : %s  -> now run: node scripts/build.cjs && npm run check' % os.path.relpath(args.page, root))
    if stale:
        print('constants marked UPDATE are authored code: edit them in index.html by hand, then run this again')
        sys.exit(2)

if __name__ == '__main__':
    main()
