'use strict';

// Exercise the production score renderer and its existing DOM fixture. Canvas
// calls and viewport rectangles are substituted; this does not test CSS pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => ({ textContent: match[1] }));
const main = scripts.find(script => script.textContent.includes('A tiny, local module container'))?.textContent;
const boot = main?.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Load the actual modules without the browser bootstrap');
const runtime = fs.readFileSync(path.join(__dirname, 'runtime-regression.cjs'), 'utf8');
const fixtureStart = runtime.indexOf('class FakeElement extends EventTarget');
const fixtureEnd = runtime.indexOf("\ncheck('inline-script-parse'");
assert(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'Reuse the maintained runtime DOM fixture');
const { makeDom } = vm.runInNewContext(runtime.slice(fixtureStart, fixtureEnd) + '\n({ makeDom });',
  { assert, Event, EventTarget, scripts }, { filename: 'runtime-regression.cjs:dom-fixture' });

const sourceNotes = [
  [1000, 250, 60, 100], [1000, 250, 48, 90],
  [1100, 125, 64, 100], [1100, 125, 52, 90], [1200, 250, 67, 100],
  [2000, 250, 69, 100], [2000, 250, 45, 90],
  [2100, 250, 72, 100], [2100, 250, 48, 90],
  [2200, 250, 74, 100], [2200, 250, 50, 90],
  [2500, 250, 76, 100], [2500, 250, 52, 90]
];

function fixture({ reduced = false, notes = sourceNotes } = {}) {
  const { win, doc } = makeDom();
  win.innerWidth = 390; win.innerHeight = 844;
  const add = (tag, id, parent = doc.body) => {
    const element = doc.createElement(tag); element.id = id; parent.appendChild(element); return element;
  };
  const header = add('header', 'header'); header.rect = { x: 0, y: 0, width: 390, height: 80 };
  const slot = add('div', 'page-score-slot'); slot.rect = { x: 0, y: 500, width: 390, height: 122 };
  const root = add('div', 'score-bridge'), canvas = add('canvas', 'score-canvas', root);
  canvas.rect = { x: 0, y: 0, width: 390, height: 122 };
  let draws = 0;
  const graphics = canvas.getContext('2d');
  graphics.createLinearGradient = () => ({ addColorStop() {} });
  graphics.clearRect = () => { draws++; };
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  win.matchMedia = () => preference;
  const callbacks = new Map(); let serial = 0;
  win.requestAnimationFrame = callback => { callbacks.set(++serial, callback); return serial; };
  win.cancelAnimationFrame = id => callbacks.delete(id);
  let transport = { running: true, muted: false, position: .9 };
  const sound = {
    score: () => ({ revision: 1, notes, sections: [{ at: 0, bpm: 120 }] }),
    visualState: () => ({ ...transport })
  };
  const context = vm.createContext({ atob, btoa, console, window: win, document: doc, GUZICZAK_I18N: { t: key => key },
    innerWidth: win.innerWidth, innerHeight: win.innerHeight,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
    Path2D: class Path2D { constructor(source) { this.source = source; } } });
  vm.runInContext(main.slice(0, boot), context, { filename: 'index.html:score-modules' });
  const modules = context.GuziczakModules;
  const layer = modules.get('audio/score').create(win, doc, sound);
  function frame(ms, position, changes = {}) {
    transport = { ...transport, ...changes, position };
    win.advanceTime(ms);
    const pending = [...callbacks.values()]; callbacks.clear();
    for (const callback of pending) callback(ms);
    return layer.diagnostics();
  }
  return { win, doc, root, canvas, slot, header, layer, frame,
    introTime: modules.get('config/sequence').cues.scoreIn[1],
    draws: () => draws, pending: () => callbacks.size,
    scroll: () => win.dispatchEvent(new Event('scroll')),
    reduced(value) {
      preference.matches = value;
      const event = new Event('change'); event.matches = value; preference.dispatchEvent(event);
    },
    hidden(value) { doc.hidden = value; doc.dispatchEvent(new Event('visibilitychange')); },
    destroy: () => layer.destroy()
  };
}

function assertSourceNotes(snapshot, notes = sourceNotes) {
  assert.equal(snapshot.pps, 66);
  assert.equal(snapshot.notes, notes.length);
  assert(snapshot.painted.length > 0, 'The actual renderer painted source notes');
  for (const note of snapshot.painted) {
    assert(notes.some(source => source[0] / 1000 === note.t && source[2] === note.midi),
      'Reparenting cannot introduce generated notes');
    assert(Math.abs(note.x - note.headX - (note.t - snapshot.position) * 66) < 1e-6,
      'Both placements keep the same audio playhead and 66 px/s spacing');
  }
}

test('one actual score canvas moves between intro, page slot and replay', () => {
  const f = fixture();
  try {
    f.layer.setScene(f.introTime);
    assertSourceNotes(f.frame(1000, .9));
    assert.equal(f.root.parentNode, f.doc.body);
    assert(f.root.classList.contains('score-fixed')); assert(!f.root.classList.contains('score-page'));
    f.layer.finish();
    const page = f.frame(1016, .916); assertSourceNotes(page);
    assert.equal(f.root.parentNode, f.slot); assert.equal(f.canvas.parentNode, f.root);
    assert(f.root.classList.contains('score-page')); assert(!f.root.classList.contains('score-fixed'));
    assert.equal(page.placement, 'page'); assert.equal(page.staffCount, 2);
    assert.equal(f.doc.querySelectorAll('#score-canvas').length, 1, 'No duplicate canvas or transport is created');
    f.layer.reset(); f.frame(1032, .932);
    assert.equal(f.root.parentNode, f.doc.body); assert.equal(f.layer.diagnostics().opacity, 0);
    assert(f.root.classList.contains('score-fixed')); assert(!f.root.classList.contains('score-page'));
    f.layer.finish(); f.frame(1048, .948);
    f.layer.setScene(f.introTime); assertSourceNotes(f.frame(1064, .964));
    assert.equal(f.root.parentNode, f.doc.body, 'Seeking into the film also restores its fixed canvas');
    assert.equal(f.doc.getElementById('score-canvas'), f.canvas);
  } finally { f.destroy(); }
});

test('offscreen page slot stops drawing and resumes on scroll without old bursts', () => {
  const f = fixture();
  try {
    f.layer.finish(); f.frame(1000, .9);
    const sounding = f.frame(1120, 1.02); assert.equal(sounding.bursts, 2); assert(sounding.particles > 0);
    const draws = f.draws(), frames = sounding.frames;
    f.slot.rect.y = 900; f.scroll();
    const hidden = f.frame(1200, 1.1);
    assert.equal(hidden.opacity, 0); assert.equal(hidden.frames, frames); assert.equal(f.draws(), draws);
    assert.equal(hidden.particles, 0); assert.equal(hidden.bursts, 2); assert.equal(f.pending(), 0);
    f.frame(9000, 2.04);
    assert.equal(f.draws(), draws, 'Offscreen audio progress schedules no canvas work');
    f.slot.rect.y = 500; f.scroll();
    const resumed = f.frame(9016, 2.05);
    assert.equal(resumed.frames, frames + 1); assert.equal(resumed.position, 2.05);
    assert.equal(resumed.bursts, 2, 'The first visible frame skips notes crossed offscreen');
    assert.equal(resumed.particles, 0); assert(f.pending() > 0);
    assert.equal(f.frame(9086, 2.12).bursts, 4, 'Fresh visible notes still produce their ordinary bursts');
    const beforeHeader = f.draws();
    f.slot.rect.y = -50; f.scroll();
    assert.equal(f.frame(9102, 2.136).opacity, 0);
    assert.equal(f.draws(), beforeHeader, 'A slot entirely covered by the header is not visible');
    assert.equal(f.pending(), 0);
    f.slot.rect.y = 500; f.scroll();
    assert.equal(f.frame(9206, 2.24).bursts, 4,
      'Even an offscreen gap shorter than the seek guard discards hidden crossings');
  } finally { f.destroy(); }
});

test('route suspension and hidden tabs cancel work and retain the page mount', () => {
  const f = fixture();
  try {
    f.layer.finish(); f.frame(1000, .9); f.frame(1120, 1.02);
    const before = f.draws(), bursts = f.layer.diagnostics().bursts;
    f.layer.setSuspended(true);
    assert.equal(f.pending(), 0); assert.equal(f.layer.diagnostics().particles, 0);
    assert.equal(f.layer.diagnostics().opacity, 0); assert.equal(f.root.parentNode, f.slot);
    f.frame(5000, 2.04); assert.equal(f.draws(), before);
    f.layer.setSuspended(false);
    assert.equal(f.frame(5016, 2.05).bursts, bursts, 'A route resume does not replay suspended crossings');
    f.frame(5086, 2.12); assert.equal(f.layer.diagnostics().bursts, bursts + 2);
    f.hidden(true); const hiddenDraws = f.draws();
    assert.equal(f.pending(), 0); assert.equal(f.layer.diagnostics().particles, 0);
    f.frame(10000, 2.4); assert.equal(f.draws(), hiddenDraws);
    f.hidden(false);
    assert.equal(f.frame(10016, 2.45).bursts, bursts + 2, 'Returning to the tab starts at current audio');
    f.destroy(); assert.equal(f.pending(), 0);
    f.scroll(); f.frame(10032, 2.466);
    assert.equal(f.pending(), 0, 'Destroy disposes the scroll wake listener');
  } finally { f.destroy(); }
});

test('pause freezes the playhead and reduced motion omits waves and particles', () => {
  const f = fixture();
  try {
    f.layer.finish(); f.frame(1000, .9); const active = f.frame(1120, 1.02);
    f.layer.setPaused(true);
    const paused = f.frame(5000, 2.05);
    assert.equal(paused.position, active.position); assert.equal(paused.waveTime, active.waveTime);
    assert.equal(paused.particles, 0); assert.equal(paused.bursts, active.bursts); assert.equal(f.pending(), 0);
    f.layer.setPaused(false);
    const resumed = f.frame(5016, 2.05); assert.equal(resumed.position, 2.05);
    assert.equal(resumed.bursts, active.bursts);
    const fresh = f.frame(5086, 2.12); assert.equal(fresh.bursts, active.bursts + 2);
    f.reduced(true);
    const reduced = f.frame(5102, 2.136);
    assert.equal(reduced.reduced, true); assert.equal(reduced.particles, 0);
    const later = f.frame(5202, 2.236);
    assert.equal(later.position, 2.236, 'Reduced motion can still follow the real audio playhead');
    assert.equal(later.waveTime, reduced.waveTime); assert.equal(later.bursts, fresh.bursts);
    f.frame(5218, 2.252, { running: false }); assert.equal(f.pending(), 0);
  } finally { f.destroy(); }
  const initial = fixture({ reduced: true });
  try {
    initial.layer.finish(); const snapshot = initial.frame(1000, .9);
    assert(snapshot.paused && snapshot.reduced); assert.equal(snapshot.particles, 0);
    assert.equal(initial.pending(), 0, 'The initial reduced-motion preference keeps a static page score');
  } finally { initial.destroy(); }
});

test('dense visible chords retain the existing particle budget in the page slot', () => {
  const notes = Array.from({ length: 40 }, (_, i) => [1000, 250, 33 + i, 100]);
  const f = fixture({ notes });
  try {
    f.layer.finish(); f.frame(1000, .9);
    const sounding = f.frame(1120, 1.02);
    assert.equal(sounding.bursts, notes.length); assert.equal(sounding.particles, 180);
    assert(sounding.burstStaff.T > 0 && sounding.burstStaff.B > 0);
    assert.equal(f.root.parentNode, f.slot); assert.equal(sounding.pps, 66);
    f.slot.rect.y = 900; f.scroll(); f.frame(1136, 1.036);
    assert.equal(f.layer.diagnostics().particles, 0); assert.equal(f.pending(), 0);
  } finally { f.destroy(); }
});
