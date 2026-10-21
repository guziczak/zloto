'use strict';

// Geometry regressions run the production module factories and their real meshes.
// GPU uploads are captured on the CPU; this is not a rendered WebGL screenshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(script => script.includes('A tiny, local module container'));
assert(source, 'The production module container is present');
const boot = source.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Do not execute the application bootstrap');
const context = vm.createContext({ console, atob, btoa, GUZICZAK_I18N: { t: key => key } });
vm.runInContext(source.slice(0, boot), context, { filename: 'index.html:foundry-modules' });
const registry = context.GuziczakModules;
const { M } = registry.get('math');
const casting = registry.get('config/casting');
const motion = registry.get('scene/foundry-motion');
const instrument = registry.get('geometry/instrument');
const assembly = registry.get('scene/assembly');
const castMotion = registry.get('scene/cast-motion');
const liquid = registry.get('scene/cast-liquid');
const quench = registry.get('interaction/quench');

let bound = null, serial = 0;
const uploads = new Map();
const gl = {
  ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, FLOAT: 5126,
  createVertexArray: () => ({ id: ++serial }), createBuffer: () => ({ id: ++serial }),
  bindVertexArray() {}, bindBuffer(_target, buffer) { bound = buffer; },
  bufferData(_target, data) { if (ArrayBuffer.isView(data)) uploads.set(bound, data); },
  bufferSubData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
  deleteBuffer() {}, deleteVertexArray() {}
};
const catalog = registry.get('geometry/catalog').createGeometry(gl);
const pipes = instrument.keys.map((key, slot) => ({
  midi: key.midi, center: instrument.position(slot), radius: key.radius,
  minY: instrument.position(slot)[1] + .011,
  maxY: Math.max(instrument.mouth(slot)[1], instrument.ignitionBounds(slot).max[1])
}));

function bounds(points) {
  return {
    min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])))
  };
}
function transformedBounds(box, pose) {
  const corners = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]])
    for (const z of [box.min[2], box.max[2]]) corners.push(M.point(pose, [x, y, z]));
  return bounds(corners);
}
const intervalGap = (a0, a1, b0, b1) => Math.max(a0 - b1, b0 - a1);
const pointGap = (value, lo, hi) => Math.max(lo - value, 0, value - hi);
function pipeBoxGap(pipe, box) {
  const horizontal = Math.hypot(pointGap(pipe.center[0], box.min[0], box.max[0]),
    pointGap(pipe.center[2], box.min[2], box.max[2])) - pipe.radius;
  return Math.max(horizontal, intervalGap(pipe.minY, pipe.maxY, box.min[1], box.max[1]));
}
function boxGap(a, b) {
  return Math.max(...[0, 1, 2].map(axis => intervalGap(a.min[axis], a.max[axis], b.min[axis], b.max[axis])));
}
function sampleTimes(from, to, step) {
  return Array.from({ length: Math.ceil((to - from) / step) + 1 }, (_, index) => Math.min(to, from + index * step));
}
function assemblyAt(t) {
  return assembly.sample({ t, state: { stage: 1 }, meshes: catalog.meshes, push() {} });
}
function segmentDistance(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
  const u = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length2)) : 0;
  return Math.hypot(point[0] - a[0] - u * dx, point[1] - a[1] - u * dz);
}
function triangleDistance(point, triangle) {
  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const signs = triangle.map((a, index) => cross(a, triangle[(index + 1) % 3], point));
  const area = cross(triangle[0], triangle[1], triangle[2]);
  if (Math.abs(area) > 1e-12 && (signs.every(value => value >= 0) || signs.every(value => value <= 0))) return 0;
  return Math.min(...triangle.map((a, index) => segmentDistance(point, a, triangle[(index + 1) % 3])));
}
function trianglesFor(name) {
  const data = uploads.get(catalog.meshes[name].buffer), triangles = [];
  assert(data?.length, name + ' has observable production vertices');
  for (let offset = 0; offset < data.length; offset += 27) {
    triangles.push([0, 9, 18].map(vertex => Array.from(data.slice(offset + vertex, offset + vertex + 3))));
  }
  return triangles;
}
function centroid(polygon) {
  let x = 0, y = 0, area = 0;
  polygon.forEach((p, index) => {
    const q = polygon[(index + 1) % polygon.length], weight = p[0] * q[1] - q[0] * p[1];
    x += (p[0] + q[0]) * weight; y += (p[1] + q[1]) * weight; area += weight;
  });
  return [x / (3 * area), y / (3 * area), 0];
}
const logo = registry.get('assets').logo;

test('every mouth has separate ceramic and metal ignition hardware inside its clearance envelope', t => {
  const mouths = pipes.map((_pipe, slot) => instrument.mouth(slot));
  const lowestMouth = Math.min(...mouths.map(point => point[1]));
  const boxes = pipes.map((_pipe, slot) => instrument.ignitionBounds(slot));
  const counts = pipes.map(() => ({ metal: 0, ceramic: 0 }));
  let highestHardware = 0;
  const within = (point, box) => point.every((value, axis) => value >= box.min[axis] - 1e-5 && value <= box.max[axis] + 1e-5);
  const body = uploads.get(catalog.meshes.instrumentBody.buffer);
  for (let offset = 0; offset < body.length; offset += 9) {
    const material = body[offset + 8];
    if (material !== 2 && material !== 30) continue;
    const point = Array.from(body.slice(offset, offset + 3));
    // Existing ivory pipe walls stop at the mouth. Only the added ceramic rises
    // above it; steel material is used by the added electrodes in this mesh.
    if (material === 30 && point[1] <= lowestMouth + .0001) continue;
    let slot = 0, distance2 = Infinity;
    mouths.forEach((mouth, index) => {
      const d = (point[0] - mouth[0]) ** 2 + (point[2] - mouth[2]) ** 2;
      if (d < distance2) { slot = index; distance2 = d; }
    });
    if (material === 30 && point[1] <= mouths[slot][1] + .0001) continue;
    assert(within(point, boxes[slot]), `Actual ignition vertex fits its exported bounds for MIDI ${pipes[slot].midi}`);
    assert(Math.sqrt(distance2) <= pipes[slot].radius + 1e-5,
      'Ignition hardware never widens the original pipe clearance cylinder');
    highestHardware = Math.max(highestHardware, point[1] - mouths[slot][1]);
    counts[slot][material === 2 ? 'metal' : 'ceramic']++;
  }
  const spark = uploads.get(catalog.meshes.instrumentSpark.buffer);
  assert(spark?.length > 0, 'The active gap has one shared arc mesh');
  for (let slot = 0; slot < pipes.length; slot++) {
    assert(counts[slot].metal > 0 && counts[slot].ceramic > 0,
      `MIDI ${pipes[slot].midi} has its own fixed electrodes and ceramic insulators`);
    const point = instrument.ignition(slot), mouth = mouths[slot];
    assert(Math.hypot(point[0] - mouth[0], point[2] - mouth[2]) < 1e-8,
      'Each ignition gap is centred above its own bore');
    assert(Math.abs(point[1] - mouth[1] - instrument.ignitionConfig.height) < 1e-8);
    const pose = M.mul(M.T(...point), M.Ry(instrument.outwardAngle(slot)));
    for (let offset = 0; offset < spark.length; offset += 9) {
      assert.equal(spark[offset + 8], 34, 'The arc has its own emissive material');
      const vertex = M.point(pose, Array.from(spark.slice(offset, offset + 3)));
      assert(within(vertex, boxes[slot]), 'The active arc fits the same bounded ignition assembly');
      assert(Math.hypot(vertex[0] - mouth[0], vertex[2] - mouth[2]) <= pipes[slot].radius + 1e-5);
    }
  }
  assert(highestHardware > instrument.ignitionConfig.height,
    'The ignition point lies between real metal tips, rather than above empty space');
  assert(highestHardware <= instrument.ignitionConfig.maxHeight + 1e-5);
  t.diagnostic(`66 fixed ignition assemblies; actual hardware top ${highestHardware.toFixed(6)} above each mouth`);
});

test('the whole flask, its fittings and sand clear every pipe and igniter throughout arrival and departure', t => {
  let minimum = Infinity, closest;
  // Full mesh boxes include handles, corner straps and the sand underside. This
  // intentionally overestimates their occupied space instead of checking timber alone.
  // Each pipe cylinder also encloses its ceramic mounts, electrodes and active arc.
  for (const time of sampleTimes(7.66, 17.55, .005)) {
    const placement = motion.sample(time);
    for (const name of ['flask', 'sand']) {
      const box = transformedBounds(catalog.meshes[name].bounds, placement.pose);
      for (const pipe of pipes) {
        const gap = pipeBoxGap(pipe, box);
        if (gap < minimum) { minimum = gap; closest = { time, name, midi: pipe.midi }; }
      }
    }
  }
  assert(minimum >= .04, `Mould/pipe clearance ${minimum}; ${JSON.stringify(closest)}`);
  t.diagnostic(`Minimum conservative mould/pipe clearance ${minimum.toFixed(6)} scene units`);
});

test('the raised cartridge and nozzle clear the moving flask, then align over the well', t => {
  let minimum = Infinity, closest;
  for (const time of sampleTimes(7.66, 17.55, .005)) {
    const placement = motion.sample(time), rig = assemblyAt(time);
    const flask = transformedBounds(catalog.meshes.flask.bounds, placement.pose);
    for (const name of ['neck', 'coil', 'chamber']) {
      const gap = boxGap(flask, transformedBounds(catalog.meshes[name].bounds, rig.cartridge));
      if (gap < minimum) { minimum = gap; closest = { time, name }; }
    }
  }
  assert(minimum >= .04, `Cartridge/flask clearance ${minimum}; ${JSON.stringify(closest)}`);
  for (const time of sampleTimes(8.97, 11.56, .01)) {
    const outlet = M.point(assemblyAt(time).cartridge, [0, -1.681, 0]);
    const well = M.point(motion.sample(time).pose, [0, liquid.contactLevel(time), -.90]);
    assert(Math.hypot(outlet[0] - well[0], outlet[2] - well[2]) < 1e-5,
      `The gold stream has a vertical axis at ${time}`);
    assert(outlet[1] - well[1] > .35, 'The outlet stays above the rising receiving surface');
  }
  t.diagnostic(`Minimum conservative cartridge/flask clearance ${minimum.toFixed(6)} scene units`);
});

test('both released castings clear the pipes and igniters during transfer, parking and pickup', t => {
  const triangles = { A: trianglesFor('signatureA'), B: trianglesFor('signatureB') };
  let minimum = Infinity, closest;
  for (const time of sampleTimes(casting.phase.coolEnd, casting.phase.travelEnd, .005)) {
    for (const part of castMotion.sample(time).pieces) {
      const broad = transformedBounds(catalog.meshes['signature' + part.name].bounds, part.pose);
      const candidates = pipes.filter(pipe => pipeBoxGap(pipe, broad) < .06);
      if (!candidates.length) continue;
      // Per-triangle projections preserve the actual logo outline. Its rectangular
      // bounds alone would falsely report the empty corner near the C-sharp pipe.
      for (const triangle of triangles[part.name]) {
        const world = triangle.map(point => M.point(part.pose, point));
        const lo = Math.min(...world.map(point => point[1])), hi = Math.max(...world.map(point => point[1]));
        const projected = world.map(point => [point[0], point[2]]);
        for (const pipe of candidates) {
          const vertical = intervalGap(pipe.minY, pipe.maxY, lo, hi);
          const horizontal = triangleDistance([pipe.center[0], pipe.center[2]], projected) - pipe.radius;
          const gap = Math.max(vertical, horizontal);
          if (gap < minimum) { minimum = gap; closest = { time, piece: part.name, midi: pipe.midi }; }
        }
      }
    }
  }
  assert(minimum >= .06, `Casting/pipe clearance ${minimum}; ${JSON.stringify(closest)}`);
  t.diagnostic(`Minimum detailed casting/pipe clearance ${minimum.toFixed(6)} scene units`);
});

test('castings begin at their real gate joints and rest with their mass over the front plank', () => {
  const mould = motion.sample(casting.phase.coolEnd);
  for (const part of castMotion.sample(casting.phase.coolEnd).pieces) {
    const near = M.point(part.pose, part.localPivot), far = M.point(mould.pose, part.pivot);
    assert(Math.hypot(...near.map((value, axis) => value - far[axis])) < 1e-5,
      part.name + ' stays attached to its gate before breakoff');
  }
  for (const time of [casting.joints[0].transfer[1], casting.joints[1].transfer[1], ...casting.hold]) {
    const placement = motion.sample(time);
    for (const [index, part] of castMotion.sample(time).pieces.entries()) {
      if (!part.contact) continue;
      const box = transformedBounds(catalog.meshes['signature' + part.name].bounds, part.pose);
      const gap = box.min[1] - (placement.y + casting.frame.top);
      assert(gap >= -1e-6 && gap <= .003, part.name + ' rests on, rather than floats above, the timber');
      const center = M.point(part.pose, centroid(logo[index]));
      assert(Math.abs(center[0] - placement.x) < 1.28, 'The mass remains inside the plank width');
      assert(center[2] > placement.z + casting.frame.railMinZ + .04 &&
        center[2] < placement.z + casting.frame.railMaxZ - .04,
      part.name + ' has its centre of mass safely above the plank');
    }
  }
});

test('the water terrain and metal footprint follow the same moving mould as rendering', () => {
  for (const time of sampleTimes(7.67, 17.54, .01)) {
    const placement = motion.sample(time);
    for (const local of [[0, 0, 1.27], [0, 0, -1.35], [1.212, 0, 0]]) {
      const point = M.point(placement.pose, local);
      // The water domain deliberately ends at the hull and excludes the drain.
      if (Math.hypot(point[0] / 3.8, (point[2] + .4) / 3.55) > 1.03 ||
          Math.hypot(point[0], point[2] + 2.4) < .58) continue;
      const ground = quench.terrain(point[0], point[2], time);
      assert.equal(ground.kind, 2, `A visible timber probe is a terrain wall at ${time}`);
      assert(Math.abs(ground.bed - (placement.y + casting.frame.top)) < 1e-6,
        'The collision surface has the rendered timber height');
    }
  }
  const initial = castMotion.sample(casting.phase.coolEnd);
  for (const [index, polygon] of logo.entries()) for (const [vertex, point] of polygon.entries()) {
    const world = M.point(initial.pieces[index].pose, [...point, 0]);
    assert(Math.hypot(world[0] - quench.polygons[index][vertex][0],
      world[2] - quench.polygons[index][vertex][1]) < 1e-6,
    'Quench uses the actual cast footprint, without a stale world offset');
  }
});
