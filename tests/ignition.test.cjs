'use strict';

// Real heard-note descriptors drive the production gas simulation. These checks
// cover spatial ignition and transport state, not browser pixels or GPU speed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(script => script.includes('A tiny, local module container'));
const boot = source?.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Load the production modules without starting the browser application');
const context = vm.createContext({ atob, btoa, console, GUZICZAK_I18N: { t: key => key } });
vm.runInContext(source.slice(0, boot), context, { filename: 'index.html:ignition-modules' });
const modules = context.GuziczakModules;
const geometry = modules.get('geometry/instrument');
const audio = modules.get('audio/instrument');
const simulation = modules.get('scene/instrument');
const volume = modules.get('render/steam');
const { M } = modules.get('math');
const plain = value => JSON.parse(JSON.stringify(value));
const close = (a, b, tolerance = 1e-6) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const meshes = { instrumentBody: 'body', instrumentLight: 'mouth', instrumentSpark: 'spark' };

function voice(id, midi, onsetAt = 1, duration = .18) {
  return { id, midi, at: onsetAt, generation: 1, revision: 1, velocity: 110,
    strength: .55, startTime: onsetAt, stopTime: onsetAt + duration,
    attack: .004, floor: .0001, normalizer: 1, cancelled: false,
    partials: [{ peak: 1, ring: duration > 1 ? 6 : .12, stopTime: onsetAt + duration }] };
}
function fixture(voices) {
  let ledger;
  const sampler = audio.create({ instrumentState: () => ledger });
  const motion = simulation.create();
  function render(source, { sceneTime = 10.5, reduced = false } = {}) {
    const commands = [];
    const result = motion.sample({ t: sceneTime, state: { time: sceneTime, stage: 1,
      phase: 'cast', phaseProgress: .5, instrument: source }, meshes, reduced,
      push: (mesh, pose, mode, from, to, transparent, light, begin, end, energy) =>
        commands.push({ mesh, pose: Array.from(pose), transparent, light, energy }) });
    return { source, result, commands };
  }
  return { render, sample(clock, changes = {}, options = {}) {
    ledger = { position: clock, contextTime: clock, running: true, available: true,
      paused: false, muted: false, volume: 1, gain: 1, generation: 1, revision: 1,
      voices: voices.filter(v => v.stopTime > clock), ...changes };
    return render(sampler.sample(), options);
  }, destroy: () => sampler.destroy() };
}

test('each chromatic mouth owns its ignition plane, including raised black pipes', () => {
  assert.equal(geometry.slots, 66);
  const planes = new Set(), heights = new Set();
  for (let slot = 0; slot < geometry.slots; slot++) {
    const mouth = geometry.mouth(slot), gap = geometry.ignition(slot);
    close(gap[0], mouth[0]); close(gap[2], mouth[2]);
    close(gap[1] - mouth[1], geometry.ignitionConfig.height);
    assert(gap[1] < 0, 'Negative world-space height is a valid ignition plane');
    assert.equal(volume.ignitionAt(mouth[1], gap[1]), 0);
    assert.equal(volume.ignitionAt(gap[1], gap[1]), 0);
    close(volume.ignitionAt(gap[1] + geometry.ignitionConfig.transition, gap[1]), 1);
    planes.add(JSON.stringify(gap)); heights.add(gap[1]);
  }
  assert.equal(planes.size, 66, 'No two pipes share a physical spark gap');
  assert.equal(heights.size, 2, 'Naturals and accidentals ignite at their own height');
});

test('heard gas begins as steam, straddles its gap, then burns above it', () => {
  const f = fixture([voice(1, 66), voice(2, 67)]);
  try {
    assert.equal(f.sample(.99).result.steamLobes.length, 0, 'Audio lookahead cannot emit gas');
    const before = f.sample(1.035);
    assert(before.result.steamLobes.length > 0);
    assert(before.result.steamLobes.every(l => l.center[1] + l.radii[1] < l.ignitionY),
      'The first visible gas stays entirely below the gap for multiple ordinary frames');
    assert.equal(before.result.instrument.sparks.length, 0);
    const crossing = f.sample(1.11);
    for (const midi of [66, 67]) {
      const head = crossing.result.steamLobes.find(l => l.midi === midi && l.kind === 'head');
      const low = head.center[1] - head.radii[1], high = head.center[1] + head.radii[1];
      assert(low < head.ignitionY && high > head.ignitionY, 'One volume contains both phases');
      assert.equal(volume.ignitionAt(low, head.ignitionY, head.fuel), 0);
      assert(volume.ignitionAt(high, head.ignitionY, head.fuel) > .9);
      assert(crossing.result.instrument.sparks.some(s => s.midi === midi), 'Only this gap arcs');
    }
    f.sample(1.2);
    const detached = f.sample(1.45);
    assert(detached.result.steamLobes.some(l => l.kind === 'head' && l.center[1] - l.radii[1] > l.ignitionY),
      'Detached gas remains combustible after crossing instead of reverting at note-off');
    assert(detached.result.instrument.sparks.every(s => [66, 67].includes(s.midi)));
    assert.equal(f.sample(2.6).result.steamLobes.length, 0, 'No permanent fire remains after the packet expires');
  } finally { f.destroy(); }
});

test('a repeated note emits fresh white gas below an older burning cloud', () => {
  const f = fixture([voice(1, 67), voice(2, 67, 1.4)]);
  try {
    f.sample(1.1); f.sample(1.2);
    const overlap = f.sample(1.435).result;
    const oldHead = overlap.steamLobes.find(l => l.onsetId === '1:1' && l.kind === 'head');
    const newHead = overlap.steamLobes.find(l => l.onsetId === '1:2' && l.kind === 'head');
    assert(oldHead && newHead, 'Repeated pitches retain independent packets');
    assert(oldHead.center[1] - oldHead.radii[1] > oldHead.ignitionY);
    assert(newHead.center[1] + newHead.radii[1] < newHead.ignitionY);
    assert.equal(volume.ignitionAt(newHead.center[1], newHead.ignitionY, newHead.fuel), 0,
      'A previously lit pipe cannot turn a fresh below-gap packet into fire');
  } finally { f.destroy(); }
});

test('electrical arcs follow actual gap contact and the audible transport', () => {
  const f = fixture([voice(1, 67, 1, 7)]);
  try {
    const active = f.sample(1.11), sameAudio = f.render(active.source, { sceneTime: 14 });
    assert(active.commands.some(c => c.mesh === 'spark' && c.energy > 0 && c.transparent));
    assert.deepEqual(plain(active.result.instrument.sparks), plain(sameAudio.result.instrument.sparks),
      'Advancing the cinematic clock cannot change the electrical arc');
    const head = active.result.steamLobes.find(l => l.kind === 'head');
    assert(simulation.gapContact(head) > 0);
    const moved = { ...head, center: [head.center[0] + 2, head.center[1], head.center[2]] };
    assert.equal(simulation.gapContact(moved), 0, 'A cloud at the same height but away from this gap cannot fire it');
    for (const flags of [{ muted: true }, { paused: true }, { running: false }, { available: false }]) {
      const quiet = f.render({ ...active.source, ...flags });
      assert.equal(quiet.result.steamLobes.length, 0);
      assert.equal(quiet.result.instrument.sparks.length, 0);
      assert(!quiet.commands.some(c => c.mesh === 'spark'));
    }
    const reduced = f.render(active.source, { reduced: true });
    assert.equal(reduced.result.steamLobes.length, 0);
    assert.equal(reduced.result.instrument.sparks.length, 0);
    assert(reduced.commands.some(c => c.mesh === 'body') && reduced.commands.some(c => c.mesh === 'mouth'),
      'Reduced motion preserves hardware and the sounding-mouth cue');
  } finally { f.destroy(); }
});

test('renderer preserves per-pipe ignition through sorting and reflected draws', () => {
  const f = fixture([voice(1, 66), voice(2, 67)]);
  try {
    const lobes = f.sample(1.11).result.steamLobes;
    const view = M.look([0, 7, 12], [0, -2, 0]);
    for (const reflectionY of [null, -2.6]) {
      const prepared = volume.prepareLobes(lobes, view, reflectionY);
      assert(prepared.count > 0);
      assert.equal(prepared.data.length, prepared.count * 12, 'The existing instance stride stays bounded');
      prepared.order.forEach((item, i) => {
        const original = lobes[item.index];
        close(prepared.data[i * 12 + 10], geometry.ignition(geometry.slotFor(original.midi))[1]);
        assert.equal(prepared.data[i * 12 + 11], 1);
        if (i) assert(prepared.order[i - 1].depth >= item.depth, 'Back-to-front transparency order is retained');
      });
    }
    const valid = lobes[0];
    for (const invalid of [{ ...valid, ignitionY: undefined }, { ...valid, ignitionY: NaN },
      { ...valid, fuel: undefined }, { ...valid, fuel: Infinity }]) {
      const sanitized = volume.sanitizeLobes([invalid]);
      assert.equal(sanitized.length, 1); assert.equal(sanitized[0].fuel, 0,
        'Missing or invalid ignition metadata stays ordinary steam');
    }
  } finally { f.destroy(); }
});

test('a dense chord keeps gas, sparks and GPU uploads within their existing budgets', () => {
  const f = fixture(Array.from(geometry.pitches, (midi, i) => voice(i + 1, midi, 1, 7)));
  try {
    const sample = f.sample(1.11).result;
    assert.equal(sample.instrument.active, 66);
    assert.equal(sample.instrument.igniters, 66);
    assert(sample.steamLobes.length <= volume.MAX_LOBES);
    assert(sample.instrument.primary <= simulation.limits.primary);
    assert(sample.instrument.sparks.length <= geometry.slots);
    assert.equal(new Set(sample.instrument.sparks.map(s => s.midi)).size, sample.instrument.sparks.length);
    assert(sample.steamLobes.every(l => l.fuel === 1 && l.ignitionY === geometry.ignition(geometry.slotFor(l.midi))[1]));
    const prepared = volume.prepareLobes(sample.steamLobes, M.look([0, 8, 12], [0, 0, 0]));
    assert(prepared.data.length <= 128 * 12);
    assert(Array.from(prepared.data).every(Number.isFinite));
    assert.equal(volume.RAY_STEPS, 6, 'Combustion adds no ray-march samples');
  } finally { f.destroy(); }
});
