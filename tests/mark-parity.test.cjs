'use strict';

// The brand mark exists three times in the page: as 2-D paths (favicon, header, poster),
// as the two polygons the 3-D signet is extruded from, and as the baked meshes of the
// intro foundry. These checks tie them to scripts/mark/mark.json and to each other, so
// that one form cannot be changed alone. They read the page; nothing is rendered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mark = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'mark', 'mark.json'), 'utf8'));
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(script => script.includes('A tiny, local module container'));
assert(source, 'The production module container is present');
const boot = source.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Do not execute the application bootstrap');
const context = vm.createContext({ console, atob, btoa, GUZICZAK_I18N: { t: key => key } });
vm.runInContext(source.slice(0, boot), context, { filename: 'index.html:mark-modules' });
const registry = context.GuziczakModules;
const assets = registry.get('assets');
const casting = registry.get('config/casting');
const liquid = registry.get('scene/cast-liquid');

// Mould frame of the packed foundry meshes: x right, y up (sand top at 0), z toward the viewer.
const scale = casting.rest.scale, restZ = casting.rest.z - casting.frame.originZ;
const toMould = ([x, y]) => [x * scale, restZ - y * scale];
const STRIDE = 9, MOLTEN = 20, CAVITY = 17, FRACTURE = 24;

function decode(name) {
  const bytes = Buffer.from(assets.foundry[name], 'base64');
  assert.equal(bytes.length % (STRIDE * 4 * 3), 0, `${name} holds whole triangles`);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}
function vertices(data, keep) {
  const out = [];
  for (let i = 0; i < data.length; i += STRIDE) {
    const vertex = { p: [data[i], data[i + 1], data[i + 2]], n: [data[i + 3], data[i + 4], data[i + 5]], uv: [data[i + 6], data[i + 7]], material: data[i + 8] };
    if (keep(vertex)) out.push(vertex);
  }
  return out;
}
function parsePath(d) {
  const tokens = d.match(/[MLCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g), commands = [];
  for (let i = 0; i < tokens.length;) {
    const op = tokens[i++], count = { M: 2, L: 2, C: 6, Z: 0 }[op];
    assert(count !== undefined, `Only absolute M, L, C and Z are supported, not ${op}`);
    const values = tokens.slice(i, i + count).map(Number); i += count;
    assert(values.length === count && values.every(Number.isFinite), 'Complete path data');
    const points = [];
    for (let k = 0; k < count; k += 2) points.push([values[k], values[k + 1]]);
    commands.push({ op, points });
  }
  return commands;
}
// The flattening rule of scripts/mark/bake.py: path order, uniform parameter steps, y up.
function flatten(d, steps) {
  const out = []; let current = null;
  for (const { op, points } of parsePath(d)) {
    if (op === 'M' || op === 'L') { current = points[0]; out.push(current); }
    else if (op === 'C') {
      const p0 = current, [p1, p2, p3] = points;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, s = 1 - t;
        out.push([0, 1].map(axis => s * s * s * p0[axis] + 3 * s * s * t * p1[axis] + 3 * s * t * t * p2[axis] + t * t * t * p3[axis]));
      }
      current = p3;
    }
  }
  return out.map(([x, y]) => [x, -y]);
}
const signedArea = polygon => polygon.reduce((sum, p, i) => {
  const q = polygon[(i + 1) % polygon.length]; return sum + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const u = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
}
const outlineDistance = (p, polygon) => Math.min(...polygon.map((a, i) => segmentDistance(p, a, polygon[(i + 1) % polygon.length])));
function inside(p, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
const centroid = points => points[0].map((_, axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
const pathData = markup => [...markup.matchAll(/<path\b[^>]*?\bd="([^"]+)"[^>]*>/g)].map(match => match[1]);

test('the favicon and the three inline marks draw the paths of scripts/mark/mark.json', () => {
  assert.equal(mark.paths.length, 2, 'The mark has two parts: A (crescent) and B (bar and bowl)');
  const inline = html.match(/<svg aria-hidden="true" viewbox="-1\.1 -1\.12 2\.2 2\.24"[^>]*>.*?<\/svg>/g) || [];
  assert.equal(inline.length, 3, 'flying mark, header logo and the no-WebGL poster');
  for (const svg of inline) {
    assert.deepEqual(pathData(svg), mark.paths);
    assert(!/transform=/.test(svg), 'Paths are stored in final coordinates');
  }
  const favicon = html.match(/<link href="data:image\/svg\+xml,([^"]+)" rel="icon"/);
  assert(favicon, 'The favicon is an inline SVG');
  const decoded = decodeURIComponent(favicon[1]);
  assert.deepEqual(pathData(decoded), mark.paths);
  assert(decoded.includes(`viewBox="${mark.viewBox}"`));
});

test('the 3D outline is exactly those paths, flattened', () => {
  assert.equal(assets.logo.length, 2);
  mark.paths.forEach((d, part) => {
    const expected = flatten(d, mark.segmentsPerCubic), actual = assets.logo[part];
    assert.equal(actual.length, expected.length, `part ${part} vertex count`);
    actual.forEach((point, i) => point.forEach((value, axis) =>
      assert(Math.abs(value - expected[i][axis]) < 1.5e-6, `part ${part} vertex ${i} follows its path`)));
    assert(signedArea(actual) > 0, 'Outlines run counter-clockwise');
  });
  const gap = Math.min(
    ...assets.logo[0].map(p => outlineDistance(p, assets.logo[1])),
    ...assets.logo[1].map(p => outlineDistance(p, assets.logo[0])));
  // Each cavity wall stands .014 mould units off its casting; closer parts would share one cavity.
  assert(gap * scale > .06, `The two castings keep a sand wall between them (${(gap * scale).toFixed(4)})`);
});

test('the molten fill and the sand cavity are baked from the same outline', () => {
  const sand = decode('sand');
  const walls = vertices(sand, v => v.material === CAVITY && Math.abs(v.n[1]) < 1e-6).map(v => [v.p[0], v.p[2]]);
  assert(walls.length > 300, 'The cavity has vertical walls');
  const floor = vertices(sand, v => v.material === CAVITY && v.n[1] > .999);
  const floorTriangles = [];
  for (let i = 0; i < floor.length; i += 3) floorTriangles.push(floor.slice(i, i + 3).map(v => [v.p[0], v.p[2]]));
  const onFloor = p => floorTriangles.some(triangle => {
    const sign = (a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    const d = [sign(triangle[0], triangle[1]), sign(triangle[1], triangle[2]), sign(triangle[2], triangle[0])];
    return !(d.some(value => value < -1e-9) && d.some(value => value > 1e-9));
  });
  ['melt0', 'melt1'].forEach((name, part) => {
    const top = vertices(decode(name), v => v.material === MOLTEN && v.p[1] > .5).map(v => [v.p[0], v.p[2]]);
    assert(top.length > 0, `${name} has a surface`);
    let near = 0;
    for (const point of assets.logo[part].map(toMould)) {
      const surface = Math.min(...top.map(q => Math.hypot(q[0] - point[0], q[1] - point[1])));
      assert(surface < 2e-5, `${name} reaches every vertex of part ${part} (${surface})`);
      assert(onFloor(point), `The cavity floor lies under part ${part}`);
      const wall = Math.min(...walls.map(q => Math.hypot(q[0] - point[0], q[1] - point[1])));
      assert(wall > .012, `The cavity wall clears part ${part} (${wall})`);
      if (wall < .03) near++;
    }
    // Only the mouth of the gate has no wall next to the casting.
    assert(near >= assets.logo[part].length * .9, `The cavity wall follows part ${part} (${near} vertices)`);
    for (const q of top) assert(inside(q, assets.logo[part].map(toMould)) || outlineDistance(q, assets.logo[part].map(toMould)) < 2e-5,
      `${name} stays within part ${part}`);
  });
});

test('each gate breaks where config/casting hinges its casting', () => {
  assert.equal(casting.joints.map(joint => joint.name).join(), 'A,B');
  casting.joints.forEach((joint, part) => {
    const pivot = [joint.pivot[0], joint.pivot[2]], outline = assets.logo[part].map(toMould);
    const neck = outlineDistance(pivot, outline);
    assert(!inside(pivot, outline) && neck > .015 && neck < .045, `Gate ${joint.name} breaks a short neck away from its casting (${neck})`);
    assert(!inside(pivot, assets.logo[1 - part].map(toMould)), 'A gate cannot end in the other casting');
    const base = vertices(decode('gateBase' + joint.name), v => v.material === FRACTURE).map(v => [v.p[0], v.p[2]]);
    assert(base.length >= 6, `gateBase${joint.name} has a fracture face`);
    const baseCentre = centroid(base);
    assert(Math.hypot(baseCentre[0] - pivot[0], baseCentre[1] - pivot[1]) < .004, `gateBase${joint.name} fractures at the pivot`);
    // The stub that stays on the casting is stored in the casting's own frame.
    const tip = decode('gateTip' + joint.name);
    const tipCentre = centroid(vertices(tip, v => v.material === FRACTURE).map(v => [v.p[0], v.p[1]]));
    assert(Math.hypot(tipCentre[0] - joint.localPivot[0], tipCentre[1] - joint.localPivot[1]) < .004 / scale,
      `gateTip${joint.name} fractures at the local pivot`);
    const reach = Math.min(...vertices(tip, () => true).map(v => outlineDistance([v.p[0], v.p[1]], assets.logo[part])));
    assert(reach < .004, `gateTip${joint.name} is attached to its casting (${reach})`);
  });
});

test('the baked arrival field finishes filling before the metal cools', () => {
  const well = [liquid.config.wellX, liquid.config.wellZ];
  let last = 0;
  for (const name of ['feed', 'melt0', 'melt1']) {
    const top = vertices(decode(name), v => v.material === MOLTEN && v.p[1] > .5);
    for (const v of top) {
      assert(v.uv[0] >= 0 && Number.isFinite(v.uv[0]));
      // Metal cannot arrive sooner than the straight line from the well allows.
      if (name !== 'feed') assert(v.uv[0] > .5 * Math.hypot(v.p[0] - well[0], v.p[2] - well[1]), `${name} fills from its gate`);
      last = Math.max(last, v.uv[0]);
    }
  }
  const full = liquid.arrivalAt(last) + liquid.config.fill;
  assert(full <= 11.38 + 1e-3, `The mould is full at ${full.toFixed(3)} s, when the scene reports it filled`);
  assert(full < liquid.config.coolStart);
});
