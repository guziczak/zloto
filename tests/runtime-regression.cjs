'use strict';

// Read-only execution checks for the real application modules. DOM and GPU uploads
// are substituted here; this does not claim browser layout or shader compilation.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const adjacentHtml = path.resolve(__dirname, '..', 'index.html');
const htmlPath = process.argv.find(arg => arg.startsWith('--html='))?.slice(7)
  || (fs.existsSync(adjacentHtml) ? adjacentHtml : path.resolve(__dirname, '..', 'zloto', 'index.html'));
const baseline = process.argv.includes('--baseline');
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7) || '';
const dumpShaders = process.argv.find(arg => arg.startsWith('--dump-shaders='))?.slice(15);
const dumpProjections = process.argv.find(arg => arg.startsWith('--dump-projections='))?.slice('--dump-projections='.length);
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
  match => ({ attrs: match[1], textContent: match[2] }));
const findings = [];
const failures = [];
function check(name, fn) {
  const requiresCatalog = /geometry|keyboard|audio-ledger|airflow|full-scene|renderer|mobile|projection/.test(only);
  if (only && !name.includes(only) && !(requiresCatalog && name === 'cpu-geometry-catalog')) return;
  try { const detail = fn(); findings.push({ name, status: 'pass', ...detail }); }
  catch (error) { failures.push({ name, message: error.message, stack: error.stack?.split('\n').slice(0, 6) }); }
}

class FakeElement extends EventTarget {
  constructor(tag, doc, text = '') {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.parentNode = null; this.attributes = new Map();
    this.dataset = {}; this.hidden = false; this._text = text; this.className = '';
    this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
    const has = name => this.className.split(/\s+/).includes(name);
    this.classList = {
      contains: has,
      add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const value = force === undefined ? !has(name) : !!force; value ? this.classList.add(name) : this.classList.remove(name); return value; }
    };
    this.rect = { x: 24, y: 110, width: 340, height: 96 };
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); for (const child of this.children) child.parentNode = null; this.children = []; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return this === this.ownerDocument?.documentElement || !!this.parentNode?.isConnected; }
  get offsetTop() { return this.parentNode ? this.parentNode.children.indexOf(this) * 72 : 0; }
  get offsetLeft() { return this.rect.x; }
  get offsetWidth() { return this.rect.width; }
  get offsetHeight() { return this.rect.height; }
  get clientWidth() { return this.rect.width; }
  get clientHeight() { return this.rect.height; }
  get scrollHeight() { return this.children.length * 72; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(typeof child === 'string' ? this.ownerDocument.createTextNode(child) : child); }
  prepend(child) { this.insertBefore(child, this.firstChild); }
  insertBefore(child, before) { if (child.parentNode) child.parentNode.removeChild(child); const index = before ? this.children.indexOf(before) : -1; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); child.parentNode = this; return child; }
  removeChild(child) { const index = this.children.indexOf(child); assert(index >= 0, 'DOM removeChild target must exist'); this.children.splice(index, 1); child.parentNode = null; return child; }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  remove() { this.parentNode?.removeChild(this); }
  contains(child) { return child === this || this.children.some(node => node.contains(child)); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
  setAttributeNS(_namespace, key, value) { this.setAttribute(key, value); }
  getAttribute(key) { if (key === 'class') return this.className; if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null; return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.getAttribute(key) !== null; }
  removeAttribute(key) { this.attributes.delete(key); if (key.startsWith('data-')) delete this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; }
  toggleAttribute(key, force) { const on = force === undefined ? !this.hasAttribute(key) : !!force; on ? this.setAttribute(key, '') : this.removeAttribute(key); return on; }
  getBoundingClientRect() { const { x, y, width, height } = this.rect; return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return { x, y, width, height }; } }; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView() {}
  getContext(kind) {
    assert.equal(kind, '2d', 'Harness substitutes only 2D atlas operations');
    return this._context2d ||= new Proxy({ canvas: this, measureText: text => ({ width: String(text).length * 8 }) },
      { get(target, key) { if (key in target) return target[key]; return target[key] = () => {}; } });
  }
  matches(selector) { return selector.split(',').some(part => this.matchesSimple(part.trim())); }
  matchesSimple(selector) {
    if (this.tagName === '#TEXT') return false;
    const parts = selector.split(/\s+/); const last = parts.pop();
    if (parts.length) { if (!this.matchesSimple(last)) return false; let parent = this.parentNode; while (parent) { if (parent.matchesSimple(parts.join(' '))) return true; parent = parent.parentNode; } return false; }
    if (selector === '*') return true;
    if (selector.includes(':')) selector = selector.replace(/:scope/g, '').trim();
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:=['"]?([^\]'" ]+)['"]?)?\]/g)) { const value = this.getAttribute(match[1]); if (value === null || match[2] !== undefined && value !== match[2]) return false; }
    return true;
  }
  querySelectorAll(selector) { const output = []; for (const child of this.children) { if (child.matches(selector)) output.push(child); output.push(...child.querySelectorAll(selector)); } return output; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
}
class DetailEvent extends Event { constructor(type, options = {}) { super(type, options); this.detail = options.detail; } }
function makeDom() {
  const doc = new EventTarget();
  doc.documentElement = new FakeElement('html', doc); doc.documentElement.lang = 'pl';
  doc.head = doc.documentElement.appendChild(new FakeElement('head', doc));
  doc.body = doc.documentElement.appendChild(new FakeElement('body', doc));
  doc.activeElement = doc.body; doc.scripts = scripts; doc.hidden = false;
  doc.createElement = tag => new FakeElement(tag, doc);
  doc.createElementNS = (_namespace, tag) => new FakeElement(tag, doc);
  doc.createTextNode = text => new FakeElement('#text', doc, String(text));
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.querySelector = selector => doc.querySelectorAll(selector)[0] || null;
  doc.getElementById = id => doc.querySelector('#' + id);
  for (const id of ['artifact-stage', 'artifact-slot', 'scene']) { const node = doc.createElement('div'); node.id = id; node.rect = { x: 640, y: 200, width: 460, height: 480 }; doc.body.appendChild(node); }
  const win = new EventTarget(); let now = 1000;
  win.CustomEvent = DetailEvent;
  win.document = doc; win.innerWidth = 1440; win.innerHeight = 900; win.devicePixelRatio = 1;
  win.performance = { now: () => now }; win.advanceTime = value => { now = value; };
  win.matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  win.location = { href: 'http://local.test/', search: '', pathname: '/', hash: '' };
  win.getComputedStyle = el => ({ ...el.style, display: el.hidden ? 'none' : 'block' });
  const frames = []; win.requestAnimationFrame = fn => { frames.push(fn); return frames.length; }; win.cancelAnimationFrame = () => {};
  win.flushAnimationFrame = () => { const pending = frames.splice(0); for (const fn of pending) fn(now); };
  doc.defaultView = win;
  return { win, doc };
}

check('inline-script-parse', () => {
  let count = 0;
  for (const script of scripts) if (!/application\/(?:ld\+)?json/.test(script.attrs)) new vm.Script(script.textContent, { filename: 'inline-script-' + ++count + '.js' });
  return { executableScripts: count };
});

const { win, doc } = makeDom();
const main = scripts.find(script => script.textContent.includes('A tiny, local module container'))?.textContent;
assert(main, 'Expected inline application module container');
const boot = main.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Expected final application bootstrap marker');
const context = vm.createContext({ console, atob, btoa, URL, URLSearchParams, TextDecoder, TextEncoder,
  performance: win.performance, Event, EventTarget, CustomEvent: DetailEvent, Element: FakeElement,
  window: win, document: doc, innerWidth: win.innerWidth, innerHeight: win.innerHeight,
  devicePixelRatio: 1, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
  GUZICZAK_I18N: { t: key => key } });
vm.runInContext(main.slice(0, boot), context, { filename: path.basename(htmlPath) + ':modules' });
const registry = context.GuziczakModules;

check('all-module-factories', () => { const graph = registry.graph(); for (const { name } of graph) registry.get(name); return { modules: graph.length }; });

function strippedGLSL(source) { return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); }
function interfaceValues(source, qualifier) {
  const result = new Map();
  for (const match of strippedGLSL(source).matchAll(new RegExp('\\b' + qualifier + '\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+([^;(){}]+);', 'g'))) {
    for (const declaration of match[2].split(',')) { const name = declaration.trim().match(/^([\w]+)/)?.[1]; if (name) result.set(name, match[1]); }
  }
  return result;
}
check('shader-source-structure-and-interfaces', () => {
  let programs = 0, shaders = 0;
  for (const moduleName of ['render/shaders', 'render/atelier-shaders']) {
    const sources = registry.get(moduleName);
    for (const [name, source] of Object.entries(sources)) {
      if (typeof source !== 'string' || !/[VF]S$/.test(name)) continue;
      shaders++; assert(/^\s*#version 300 es\b/.test(source), moduleName + '/' + name + ': GLSL ES 300 declaration');
      assert(!source.includes('${'), moduleName + '/' + name + ': unresolved string template');
      assert(/\bvoid\s+main\s*\(/.test(source), moduleName + '/' + name + ': main function');
      const stack = [], close = { ')': '(', ']': '[', '}': '{' };
      for (const token of strippedGLSL(source)) { if ('([{'.includes(token)) stack.push(token); else if (')]}'.includes(token)) assert.equal(stack.pop(), close[token], moduleName + '/' + name + ': matching delimiter'); }
      assert.equal(stack.length, 0, moduleName + '/' + name + ': balanced delimiters');
    }
    for (const prefix of ['mesh', 'shadow', 'word', 'dust']) {
      const vs = sources[prefix + 'VS'], fsSource = sources[prefix + 'FS']; if (!vs || !fsSource) continue;
      const produced = interfaceValues(vs, 'out');
      for (const [name, type] of interfaceValues(fsSource, 'in')) assert.equal(produced.get(name), type, moduleName + '/' + prefix + ': compatible varying ' + name);
      programs++;
    }
  }
  return { shaders, interfacePairs: programs, limitation: 'Structure and declared varyings only; no real GLSL compilation.' };
});

function makeGLUploads() {
  let serial = 0, uploads = 0, updates = 0, bytes = 0, bound = null;
  const lengths = new Map(), summaries = new Map();
  function finite(data) { if (ArrayBuffer.isView(data) && !(data instanceof DataView)) for (const value of data) assert(Number.isFinite(value), 'Nonfinite geometry upload'); }
  const gl = {
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, FLOAT: 5126,
    createVertexArray: () => ({ id: ++serial }), createBuffer: () => ({ id: ++serial }),
    bindVertexArray() {}, bindBuffer(_target, buffer) { bound = buffer; },
    bufferData(_target, data) {
      finite(data); uploads++; const size = typeof data === 'number' ? data : data.byteLength; bytes += size;
      if (bound) {
        lengths.set(bound, size);
        if (data?.constructor?.name === 'Float32Array' && data.length % 9 === 0) {
          let minNormalY = Infinity, maxNormalY = -Infinity; const materials = new Set();
          const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
          for (let i = 0; i < data.length; i += 9) {
            minNormalY = Math.min(minNormalY, data[i + 4]); maxNormalY = Math.max(maxNormalY, data[i + 4]); materials.add(data[i + 8]);
            for (let k = 0; k < 3; k++) { bounds.min[k] = Math.min(bounds.min[k], data[i + k]); bounds.max[k] = Math.max(bounds.max[k], data[i + k]); }
          }
          summaries.set(bound, { minNormalY, maxNormalY, materials: [...materials], bounds });
        }
      }
    },
    bufferSubData(_target, offset, data) { finite(data); updates++; if (bound) assert(offset + data.byteLength <= lengths.get(bound), 'Geometry update fits allocated buffer'); },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, deleteBuffer() {}, deleteVertexArray() {}
  };
  return { gl, summary: buffer => summaries.get(buffer), stats: () => ({ uploads, updates, bytes }) };
}

const gpu = makeGLUploads();
let catalog;
check('cpu-geometry-catalog', () => {
  catalog = registry.get('geometry/catalog').createGeometry(gpu.gl);
  const instrumentMeshes = Object.entries(catalog.meshes).filter(([name]) => /instrument/i.test(name));
  assert(instrumentMeshes.length >= 2, 'Instrument meshes must be registered in real scene catalog');
  for (const [name, mesh] of instrumentMeshes) {
    assert(mesh.count > 0 && mesh.count % 3 === 0, name + ': nonempty triangle mesh');
    assert([...mesh.bounds.min, ...mesh.bounds.max].every(Number.isFinite), name + ': finite bounds');
    assert(catalog.names.has(mesh), name + ': draw registry membership');
  }
  if (!baseline) for (const name of ['meltA', 'meltB', 'sand']) assert(catalog.meshes[name].bounds, 'Packed ' + name + ' mesh exposes actual bounds for picking and tether');
  return { meshes: Object.keys(catalog.meshes).length, totalTriangles: catalog.triangleCount,
    instrumentMeshes: instrumentMeshes.map(([name, mesh]) => ({ name, vertices: mesh.count, bounds: mesh.bounds, summary: gpu.summary(mesh.buffer) })), ...gpu.stats() };
});

function legacyAudioSnapshot() {
  if (!baseline) {
    const voice = (midi, startTime, strength, id) => ({ id, generation: 1, revision: 1, midi, velocity: Math.round(127 * strength),
      strength, at: startTime, scoreAt: startTime, startTime, stopTime: 8, attack: .004,
      floor: .0001, normalizer: 1, cancelled: false, cancelAt: null, cancelTau: .008,
      partials: [{ peak: 1, ring: 6, stopTime: 8 }] });
    const ledger = { position: 1, contextTime: 1, running: true, available: true, muted: false, paused: false,
      volume: 1, revision: 1, generation: 1, gain: 1, voices: [voice(60, .9, .95, 1), voice(67, .85, .8, 2)] };
    const instrument = registry.get('audio/instrument').create({ instrumentState: () => ledger });
    const result = instrument.sample(); instrument.destroy(); return result;
  }
  return { position: 1, running: true, available: true, revision: 1, low: 28, high: 93,
    levels: Array.from({ length: 66 }, (_, i) => i === 32 ? .82 : i === 39 ? .5 : 0),
    notes: [{ midi: 60, name: 'C4', velocity: 110, level: .82, at: .9, age: .1, attack: .6 }, { midi: 67, name: 'G4', velocity: 90, level: .5, at: .85, age: .15, attack: .3 }], energy: .8, serial: 2 };
}

if (!baseline) check('keyboard-layout-and-picking', () => {
  const geometry = registry.get('geometry/instrument'), audio = registry.get('audio/instrument');
  const docking = registry.get('config/docking'), engine = registry.get('app/engine');
  const chromatic = Array.from({ length: 66 }, (_, i) => i + 28), blackClasses = new Set([1, 3, 6, 8, 10]);
  assert.deepEqual(Array.from(geometry.pitches), chromatic, 'The physical keyboard covers every chromatic pitch from E1 to A6');
  assert.equal(geometry.keys.length, 66, 'Every physical key exposes its actual mouth geometry');
  const positions = chromatic.map(midi => Array.from(geometry.position(geometry.slotFor(midi))));
  const angles = positions.map(point => Math.atan2((point[2] - docking.hull[2]) / docking.hull[1], point[0] / docking.hull[0]));
  for (let i = 1; i < angles.length; i++) while (angles[i] < angles[i - 1]) angles[i] += Math.PI * 2;
  const natural = [], accidental = [];
  for (const [slot, midi] of chromatic.entries()) {
    const key = geometry.keys[slot], black = blackClasses.has(midi % 12);
    assert.equal(geometry.slotFor(midi), slot, 'Chromatic MIDI maps to its own stable slot');
    assert.equal(key.midi, midi); assert.equal(key.isBlack, black, 'Accidentals follow the piano pitch classes');
    assert.equal(key.row, black ? 'inner' : 'outer', 'Piano colors occupy distinct radial rows');
    const radius = Math.hypot(positions[slot][0] / docking.hull[0], (positions[slot][2] - docking.hull[2]) / docking.hull[1]);
    assert(Number.isFinite(radius) && key.mouthRadius > 0 && key.radius > key.mouthRadius, 'Each mouth has an open bore and a solid rim');
    (black ? accidental : natural).push({ midi, slot, angle: angles[slot], radius, mouthY: geometry.mouth(slot)[1] });
  }
  assert.equal(natural.length, 39); assert.equal(accidental.length, 27);
  const step = natural[1].angle - natural[0].angle;
  for (let i = 1; i < natural.length; i++) assert(Math.abs(natural[i].angle - natural[i - 1].angle - step) < 1e-9, 'Natural keys have uniform angular spacing');
  for (const key of accidental) {
    const lower = geometry.slotFor(key.midi - 1), upper = geometry.slotFor(key.midi + 1);
    assert(!geometry.keys[lower].isBlack && !geometry.keys[upper].isBlack, 'Every black key lies between neighboring white keys');
    assert(Math.abs(key.angle - (angles[lower] + angles[upper]) * .5) < 1e-9, 'Black key is centered on the diatonic gap');
  }
  for (const start of [36, 48, 60, 72]) {
    const octave = chromatic.filter(midi => midi >= start && midi < start + 12);
    const blacks = octave.filter(midi => geometry.keys[geometry.slotFor(midi)].isBlack).map(midi => midi - start);
    assert.deepEqual(blacks, [1, 3, 6, 8, 10], 'Each complete octave has groups of two and three black keys, with E–F and B–C gaps');
  }
  assert(Math.min(...natural.map(key => key.radius)) - Math.max(...accidental.map(key => key.radius)) > .10, 'Both rows have clear radial separation');
  const raisedBlackMouths = Math.min(...accidental.map(key => key.mouthY)) - Math.max(...natural.map(key => key.mouthY));
  assert(raisedBlackMouths > .08, 'The inner black mouths rise above the outer row instead of reading as flat holes');
  let minimumSolidClearance = Infinity;
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    const gap = Math.hypot(positions[i][0] - positions[j][0], positions[i][2] - positions[j][2]) - geometry.keys[i].radius - geometry.keys[j].radius;
    minimumSolidClearance = Math.min(minimumSolidClearance, gap);
  }
  assert(minimumSolidClearance > 0, 'The circular pipe bodies do not overlap within or across rows');
  for (const midi of [27, 94, 60.5, NaN]) assert.equal(geometry.slotFor(midi), -1, 'Invalid pitches cannot alias a physical key');
  const frame = { time: 2, stage: 1, phase: 'assembly', phaseProgress: .5, instrument: { running: false } };
  const list = registry.get('scene/commands').createDrawList(catalog, frame); list.family('instrument');
  const quiet = registry.get('scene/instrument').sample({ t: 2, state: frame, meshes: catalog.meshes, push: list.push });
  for (const target of quiet.traceTargets) {
    const slot = geometry.slotFor(target.midi);
    assert(slot >= 0, 'Every selectable mouth carries its actual pitch');
    assert.deepEqual(Array.from(target.world), Array.from(geometry.mouth(slot)), 'The selection anchor is exactly the fixed pipe mouth');
  }
  const projected = engine.projectTraceTargets({ commands: [], traceTargets: quiet.traceTargets },
    point => [187 + point[0] * 30, 360 + point[2] * 30, 10 + point[1]], { width: 375, height: 720 }, frame, []);
  assert.equal(projected.targets.length, 66, 'The projection budget retains all idle chromatic mouths');
  assert.equal(projected.pickTargets.length, 66, 'Every unobscured idle mouth can be selected');
  const isolated = makeDom(), trace = registry.get('runtime/trace').create(isolated.win, isolated.doc);
  trace.beginFrame('intro', { time: 2 }, 1000); trace.setTargets(projected.targets);
  trace.emit('organ', { midi: 93 }, { objectId: 'instrument/note/93', priority: 80 });
  trace.endFrame({ audio: legacyAudioSnapshot() });
  assert.equal(trace.diagnostics().targets, 66, 'The trace target store cannot truncate the final two keys');
  for (const midi of Array.from(audio.layout.pitches)) {
    const target = projected.pickTargets.find(item => item.objectId === 'instrument/note/' + midi);
    assert(target, 'Every original score pitch retains its projected object ID');
    assert.equal(engine.pickTraceTarget(projected.pickTargets, target.x, target.y)?.objectId, target.objectId, 'Tapping the exact mouth selects its original pitch');
    assert.equal(trace.pin('organ', target.objectId)?.objectId, target.objectId, 'Original score pitch can still be pinned');
  }
  assert.equal(trace.diagnostics().tether, true, 'The highest original pitch retains its projected tether');
  trace.destroy();
  return { physicalPitches: 66, naturals: 39, accidentals: 27, completeOctaves: 4, minimumSolidClearance,
    naturalSpacing: true, accidentalMidpoints: true, raisedBlackMouths, idlePickTargets: 66, originalScorePitchesPreserved: 46 };
});

if (!baseline) check('audio-ledger-to-airflow-instrument', () => {
  const audio = registry.get('audio/instrument'), geometry = registry.get('geometry/instrument');
  assert.equal(audio.layout.pitches.length, 46, 'The original scores retain their 46 used pitches');
  assert.equal(geometry.slots, 66, 'The physical keyboard also includes chromatic notes unused by the scores');
  assert(catalog.meshes.instrumentAir, 'The real scene catalog contains the airflow mesh');
  assert(gpu.summary(catalog.meshes.instrumentAir.buffer).materials.every(id => id === 29), 'Airflow has its dedicated transparent material');
  assert(gpu.summary(catalog.meshes.instrumentBurst.buffer).materials.every(id => id === 32), 'The onset puff has its own material, separate from ivory and ebony');
  assert.equal(new Set(geometry.pitches).size, 66, 'Distinct chromatic pitches retain distinct sockets');
  for (const midi of Array.from(audio.layout.pitches)) assert.equal(geometry.pitches[geometry.slotFor(midi)], midi, 'Every score pitch reaches its matching physical socket');
  const noLedger = audio.create({ visualState: () => ({ running: true, available: true, position: 1, volume: 1 }), score: () => ({ notes: [[0, 1000, 60, 127]] }) });
  assert.equal(noLedger.sample().energy, 0, 'Score position without actual voice ledger cannot invent activity'); noLedger.destroy();
  let ledger = { position: .99, contextTime: .99, running: true, available: true, muted: false, paused: false, volume: 1,
    revision: 1, generation: 1, gain: 1, voices: [{ id: 1, generation: 1, revision: 1, midi: 60, velocity: 127,
      strength: 1, at: 1, scoreAt: 1, startTime: 1, stopTime: 8, attack: .004, floor: .0001, normalizer: 1,
      cancelled: false, cancelAt: null, partials: [{ peak: 1, ring: 6, stopTime: 8 }] }] };
  const instrument = audio.create({ instrumentState: () => ledger });
  assert.equal(instrument.sample().energy, 0, 'Future scheduled voice stays dark before audible start');
  ledger.position = ledger.contextTime = 1.1; const onset = instrument.sample(); assert(onset.energy > 0, 'Heard voice lights instrument');
  ledger.position = ledger.contextTime = 1.8; const afterGap = instrument.sample(); assert(afterGap.energy > 0, '700ms rendering gap preserves still-audible note');
  ledger.generation = 2; assert.equal(instrument.sample().energy, 0, 'Old generation is not displayed after transport replacement');
  ledger.generation = 1; ledger.muted = true; assert.equal(instrument.sample().energy, 0, 'Muted transport has no airflow energy');
  ledger.muted = false; ledger.paused = true; assert.equal(instrument.sample().energy, 0, 'Paused transport has no airflow energy');
  ledger.paused = false; ledger.available = false; assert.equal(instrument.sample().energy, 0, 'Unavailable audio has no airflow energy');
  instrument.destroy();
  function sceneSample(source, mobile = false, reduced = false, time = 2) {
    const frame = { time, stage: 1, phase: 'assembly', phaseProgress: .5, instrument: source };
    const list = registry.get('scene/commands').createDrawList(catalog, frame); list.family('instrument');
    const emissions = []; const result = registry.get('scene/instrument').sample({ t: time, state: frame, mobile, reduced,
      meshes: catalog.meshes, push: list.push, emit: (...args) => emissions.push(args) });
    return { result, commands: list.commands, emissions };
  }
  const flowCommands = sample => sample.commands.filter(command => command.mesh === catalog.meshes.instrumentAir);
  const burstCommands = sample => sample.commands.filter(command => command.mesh === catalog.meshes.instrumentBurst);
  const laterSnapshot = (source, elapsed) => ({ ...source, position: source.position + elapsed,
    notes: source.notes.map(note => ({ ...note, age: note.age + elapsed })) });
  const quiet = sceneSample({ ...onset, running: false, notes: [], levels: onset.levels.map(() => 0), energy: 0 });
  assert.equal(flowCommands(quiet).length, 0, 'Silent input has no airflow');
  const stopped = sceneSample({ ...onset, running: false });
  assert.equal(flowCommands(stopped).length, 0, 'Stopped transport cannot reuse stale positive note levels');
  assert.equal(burstCommands(stopped).length, 0, 'Stopped transport cannot leave an onset puff');
  assert.equal(stopped.emissions.filter(([key]) => key === 'organ').length, 0, 'Silent pipes cannot claim a live airflow operation');
  assert.equal(stopped.result.traceTargets.length, 66, 'Silent mouths remain available for stable object selection');
  const active = sceneSample(onset);
  assert(flowCommands(active).some(command => command.mode === 8 && command.glass && command.noteEnergy > 0), 'Audible voice creates a transparent airflow draw command');
  assert(active.result.traceTargets.some(target => target.objectId === 'instrument/note/60' && target.world.every(Number.isFinite)), 'Heard note has stable projected selection target');
  assert(active.emissions.some(([key, values, options]) => key === 'organ' && values.midi === 60 && options.objectId === 'instrument/note/60'), 'Airflow trace belongs to the actual sounding pitch');
  assert.equal(burstCommands(active).length, 1, 'A genuinely heard onset produces one puff at its own mouth');
  assert.equal(active.result.instrument.bursts[0].midi, 60);
  assert(Math.abs(active.result.instrument.bursts[0].age - onset.notes[0].age) < 1e-9, 'Puff age comes from the heard voice');
  const commandState = commands => commands.map(command => ({ matrix: Array.from(command.m), from: Array.from(command.from), to: Array.from(command.to) }));
  const flowState = sample => commandState(flowCommands(sample));
  const laterScene = sceneSample(onset, false, false, 4);
  assert.deepEqual(flowState(laterScene), flowState(active), 'Advancing scene time alone cannot advance audio airflow');
  assert.deepEqual(commandState(burstCommands(laterScene)), commandState(burstCommands(active)), 'The onset puff cannot move on an independent scene clock');
  const laterAudio = sceneSample(laterSnapshot(onset, .5));
  assert(flowCommands(laterAudio).every(command => command.from[1] === onset.position + .5), 'Airflow receives the heard audio position');
  assert.notDeepEqual(flowState(laterAudio), flowState(active), 'Advancing the audible clock advances airflow phase');
  assert.equal(burstCommands(laterAudio).length, 0, 'The short onset puff expires while the note continues sounding');
  const anchorState = sample => Array.from(sample.result.traceTargets, target => ({ objectId: target.objectId, world: Array.from(target.world) }));
  assert.deepEqual(anchorState(active), anchorState(stopped), 'Playing a note cannot move its selectable mouth into the plume');
  assert.deepEqual(anchorState(laterAudio), anchorState(active), 'Aging airflow keeps the object marker at the same mouth');
  const future = sceneSample({ ...onset, notes: onset.notes.map(note => ({ ...note, at: onset.position + .12, age: -.12 })) });
  assert.equal(flowCommands(future).length + burstCommands(future).length, 0, 'A future scheduled note cannot show flow or an early puff');
  const oneTone = (level, age) => ({ ...onset, position: 1 + age,
    levels: onset.levels.map((_value, i) => i === 60 - onset.low ? level : 0),
    notes: [{ ...onset.notes[0], level, age, at: 1, attack: age < .16 ? .5 : 0 }] });
  const soft = sceneSample(oneTone(.008, .7), true), strong = sceneSample(oneTone(.4, .7), true);
  assert(soft.result.instrument.flows[0].height > .50, 'A soft audible note retains a readable plume height on mobile');
  assert(strong.result.instrument.flows[0].height > soft.result.instrument.flows[0].height, 'Stronger audio still produces a larger visible response');
  assert.equal(soft.result.instrument.flows[0].level, .008, 'Perceptual display gain preserves the original measured level');
  assert(soft.emissions.some(([key, values]) => key === 'organ' && values.level === .008), 'Live source values do not mislabel display gain as audio amplitude');
  const firstPuff = sceneSample(oneTone(.1, .04)).result.instrument.bursts[0];
  const releasingPuff = sceneSample(oneTone(.1, .4)).result.instrument.bursts[0];
  assert(firstPuff && releasingPuff && firstPuff.pulse > releasingPuff.pulse, 'The heard onset envelope releases after its initial puff');
  assert(releasingPuff.radius > firstPuff.radius && releasingPuff.rise > firstPuff.rise, 'A puff expands and rises as its actual note ages');
  assert(firstPuff.height > 0 && releasingPuff.height > firstPuff.height, 'The onset mist stretches upward as it disperses');
  const pitches = Array.from(audio.layout.pitches), levels = Array.from({ length: 66 }, (_, i) => pitches.includes(i + 28) ? .9 : 0);
  const dense = { ...onset, levels, notes: pitches.map(midi => ({ midi, name: String(midi), level: .9, age: .1, attack: .5, at: onset.position - .1 })) };
  const denseScene = sceneSample(dense);
  assert.equal(denseScene.commands.filter(command => command.mesh === catalog.meshes.instrumentLight).length, 46, 'All sounding pitches illuminate their mouths');
  assert.equal(flowCommands(denseScene).length, 8, 'A dense chord uses at most eight airflow draws');
  assert.equal(burstCommands(denseScene).length, 8, 'A dense heard onset uses at most eight puff draws');
  assert(denseScene.commands.every(command => Array.from(command.m).concat(command.from, command.to, command.light, command.noteEnergy).every(Number.isFinite)), 'Dense airflow uniforms and transforms remain finite');
  const reverseDense = sceneSample({ ...dense, notes: dense.notes.slice().reverse() });
  assert.deepEqual(flowCommands(reverseDense).map(command => command.from[0]), flowCommands(denseScene).map(command => command.from[0]), 'Dense-note selection remains deterministic when ledger order changes');
  const mobileScene = sceneSample(onset, true), reducedScene = sceneSample(onset, false, true);
  assert(mobileScene.result.instrument.flows.every(flow => flow.height > 0 && flow.height <= 1.050001), 'Mobile airflow stays within its presentation budget');
  assert.equal(flowCommands(reducedScene).length, flowCommands(active).length, 'Reduced motion retains the sounding note cue');
  assert(flowCommands(reducedScene).every(command => command.from[1] === 0 && command.to[1] === 1), 'Reduced motion requests frozen airflow without a moving packet clock');
  assert.equal(burstCommands(reducedScene).length, 0, 'Reduced motion omits the expanding onset puff');
  assert.deepEqual(flowState(sceneSample(laterSnapshot(onset, .5), false, true)), flowState(reducedScene), 'Reduced-motion airflow remains fixed as audio time advances');
  return { pitches: 46, noScoreOnlyFallback: true, futureVoiceDark: true, longFrameGap: true, generationAndPause: true,
    stoppedSnapshotRejected: true, audibleClockControlsFlow: true, reducedMotion: true, onsetMistEnvelope: true, fixedMouthAnchors: true, softNoteMobileHeight: soft.result.instrument.flows[0].height,
    liveFlows: active.result.instrument.flows.length, denseFlows: 8, densePuffs: 8, denseLitMouths: 46, stableTraceTargets: denseScene.result.traceTargets.length };
});

if (!baseline) check('mobile-content-projection', () => {
  assert(catalog, 'Geometry catalog required');
  const math = registry.get('math'), { M } = math;
  const docking = registry.get('config/docking'), geometry = registry.get('geometry/instrument');
  const engine = registry.get('app/engine'), trace = registry.get('runtime/trace');
  const timeline = registry.get('core/timeline').createTimeline(), scene = registry.get('scene/composer').createScene(catalog);
  const plots = [], results = [];
  function projector(camera, frame, viewport) {
    const fade = 1 - math.ease(16.35, 16.70, frame.time);
    const top = viewport.traceTop * fade, bottom = viewport.traceInset * fade;
    const contentHeight = viewport.height - top - bottom;
    const aim = camera.target, yaw = camera.yaw, pitch = camera.pitch, distance = camera.distance;
    const eye = [aim[0] + Math.sin(yaw) * Math.cos(pitch) * distance, aim[1] + Math.sin(pitch) * distance,
      aim[2] + Math.cos(yaw) * Math.cos(pitch) * distance];
    const projection = M.P((camera.fov || 35) * Math.PI / 180, viewport.width / contentHeight, .1, 1500);
    const scaleY = contentHeight / viewport.height, offsetY = (bottom - top) / viewport.height;
    for (let column = 0; column < 4; column++) projection[column * 4 + 1] = projection[column * 4 + 1] * scaleY + projection[column * 4 + 3] * offsetY;
    const matrix = M.mul(projection, M.look(eye, aim));
    const project = point => {
      const q = M.point(matrix, point), w = matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15];
      return [(q[0] / w * .5 + .5) * viewport.width, (-q[1] / w * .5 + .5) * viewport.height, w];
    };
    return { project, top, bottom, contentHeight };
  }
  for (const [width, height] of [[320, 568], [375, 720], [390, 660]]) {
    const viewport = { width, height, dpr: 1, traceTop: Math.min(width <= 700 ? 56 : 62, height * .13), traceInset: Math.min(width <= 360 ? 136 : 128, height * .30) };
    for (const authored of [3.6, 6.3, 9.5, 10.2, 11.5, 12, 13.5, 15.7]) {
      const frame = registry.get('scene/state').sampleState(timeline.sample(timeline.toElapsed(authored)));
      frame.frozen = true; frame.seek = true; frame.instrument = legacyAudioSnapshot();
      frame.motion = { tilt: [0, 0], acceleration: [0, 0], speed: 0 };
      frame.water = registry.get('world/water-drive').create().snapshot();
      const packet = scene.sample(frame, viewport);
      Object.assign(frame, { fluid: packet.fluid, docking: packet.docking, reclaim: packet.reclaim, inflow: packet.inflow }, packet.atmosphere);
      const camera = registry.get('scene/camera').sampleCamera(frame, viewport, packet.assembly);
      const { project, top, bottom, contentHeight } = projector(camera, frame, viewport);
      assert(camera.fov >= 43.9, 'Full-table mobile focus uses its designed field of view');
      const ring = [], underside = [], airflowBound = [];
      for (let i = 0; i <= 96; i++) {
        const angle = i * Math.PI / 48;
        ring.push(project([docking.hull[0] * Math.cos(angle), docking.deckY, docking.hull[2] + docking.hull[1] * Math.sin(angle)]));
        underside.push(project([docking.hull[0] * Math.cos(angle), docking.deckY - .32, docking.hull[2] + docking.hull[1] * Math.sin(angle)]));
        airflowBound.push(project([docking.hull[0] * 1.045 * Math.cos(angle), docking.deckY + 1.65, docking.hull[2] + docking.hull[1] * 1.045 * Math.sin(angle)]));
      }
      const bound = ring.concat(underside, airflowBound); assert(bound.every(point => point.every(Number.isFinite) && point[2] > 0), 'Full rim is in front of camera');
      const minX = Math.min(...bound.map(point => point[0])), maxX = Math.max(...bound.map(point => point[0]));
      const minY = Math.min(...bound.map(point => point[1])), maxY = Math.max(...bound.map(point => point[1]));
      assert(minX >= -.5 && maxX <= width + .5, 'Full ring fits portrait width at ' + width + 'x' + height + ' t=' + authored);
      assert(minY >= top - .5 && maxY <= height - bottom + .5, 'Full ring and airflow bound fit with ambient source at ' + width + 'x' + height + ' t=' + authored);
      const cup = [], coil = [];
      for (let i = 0; i <= 64; i++) {
        const angle = i * Math.PI / 32;
        if (packet.assembly?.cupPose) cup.push(project(M.point(packet.assembly.cupPose, [1.19 * Math.cos(angle), 1.04, 1.19 * Math.sin(angle)])));
        if (packet.assembly?.coilPose) coil.push(project(M.point(packet.assembly.coilPose, [.54 * Math.cos(angle), -1.7, .54 * Math.sin(angle)])));
      }
      const mouths = Array.from({ length: geometry.slots }, (_, i) => project(geometry.mouth(i)));
      for (const point of cup.concat(coil)) assert(point[0] >= -.5 && point[0] <= width + .5 && point[1] >= top - .5 && point[1] <= height - bottom + .5, 'Actual cup and coil fit reserved content viewport');
      const projected = engine.projectTraceTargets(packet, project, viewport, frame, []);
      assert.equal(projected.targets.filter(target => target.key === 'organ').length, 66, 'The actual camera keeps every chromatic mouth in the trace store');
      assert(projected.sceneBounds && Object.values(projected.sceneBounds).every(Number.isFinite), 'The real table and assembly provide finite annotation bounds');
      const annotation = trace.resolveTraceLayout({ viewport, bounds: projected.sceneBounds,
        safe: { left: 18, right: 18, top: 70, bottom: 16 }, size: { width: width - 36, height: 101 } });
      assert(annotation.fits && annotation.left >= 18 && annotation.right <= width - 18 && annotation.bottom <= height - 16, 'Compact source fits the actual portrait scene viewport');
      assert.equal(annotation.placement, 'below', 'The reserved viewport leaves room immediately below the real scene');
      assert(annotation.top - projected.sceneBounds.bottom <= 18, 'The source follows the scene without an empty vertical gap');
      const mouldBounds = [];
      for (const command of packet.commands.filter(command => /mould|mold|sand|flask/i.test(command.id))) {
        const bounds = command.mesh.bounds || gpu.summary(command.mesh.buffer)?.bounds;
        assert(bounds, 'Mould mesh has observable vertex bounds');
        const corners = [];
        for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) corners.push(project(M.point(command.m, [x, y, z])));
        mouldBounds.push({ objectId: command.id, corners });
      }
      results.push({ width, height, authored, fov: camera.fov, distance: camera.distance,
        leftClearance: minX, rightClearance: width - maxX, topClearance: minY - top, bottomClearance: height - bottom - maxY,
        annotationGap: annotation.top - projected.sceneBounds.bottom, annotationBottom: annotation.bottom });
      if (authored === 9.5) plots.push({ width, height, authored, top, bottom, contentHeight, ring, underside, airflowBound, cup, coil, mouths, mouldBounds });
    }
  }
  if (dumpProjections) fs.writeFileSync(dumpProjections, JSON.stringify({ htmlPath, limitation: 'Exact CPU camera projection of bounds; not a rendered WebGL screenshot.', plots, results }, null, 2));
  return { portraits: 3, samples: results.length, annotationHeight: 101, minSideClearance: Math.min(...results.flatMap(result => [result.leftClearance, result.rightClearance])),
    minTopClearance: Math.min(...results.map(result => result.topClearance)), minBottomClearance: Math.min(...results.map(result => result.bottomClearance)), sampled: results };
});

check('full-scene-phase-integration', () => {
  assert(catalog, 'Geometry catalog required');
  const timeline = registry.get('core/timeline').createTimeline();
  const states = registry.get('scene/state');
  const scene = registry.get('scene/composer').createScene(catalog);
  const trace = registry.get('runtime/trace').create(win, doc);
  context.GUZICZAK_TRACE = trace;
  const drive = registry.get('world/water-drive').create();
  const quench = registry.get('interaction/quench').create(timeline);
  let frames = 0, instrumentFrames = 0, maximumCommands = 0;
  const activeKeys = new Set(), modes = [];
  for (const width of [1440, 390]) {
    const viewport = { width, height: width < 651 ? 844 : 900, dpr: 1 };
    for (const segment of timeline.segments) for (const progress of [0, .5, .99]) {
      const cursor = timeline.sample(segment.start + segment.duration * progress);
      const frame = states.sampleState(cursor); frame.frozen = false; frame.seek = true;
      frame.motion = { tilt: [0, 0], acceleration: [0, 0], impulse: null };
      trace.beginFrame('intro', frame, 1000 + frames * 150);
      frame.water = drive.advance(1 / 60, frame.motion, false); frame.instrument = legacyAudioSnapshot();
      frame.quench = quench.sample(frame);
      const packet = scene.sample(frame, viewport);
      assert(packet.commands.every(command => catalog.names.has(command.mesh)), 'Every drawn mesh is registered');
      assert(packet.commands.every(command => Array.from(command.m).every(Number.isFinite)), 'All command transforms finite');
      assert(packet.commands.every(command => Number.isFinite(command.noteEnergy)), 'Note energy propagated to every command');
      const instrumentCommands = packet.commands.filter(command => /^instrument\//.test(command.id));
      if (frame.time > .65 && frame.stage > .1) { assert(instrumentCommands.length > 1, 'Active notes reach the instrument draw family'); instrumentFrames++; }
      const camera = registry.get('scene/camera').sampleCamera(frame, viewport, packet.assembly);
      assert([camera.yaw, camera.pitch, camera.distance, ...camera.target].every(Number.isFinite), 'Finite camera sample');
      trace.endFrame({ audio: frame.instrument, paused: false });
      const diagnostics = trace.diagnostics(); if (diagnostics.activeKey) activeKeys.add(diagnostics.activeKey);
      maximumCommands = Math.max(maximumCommands, packet.commands.length); frames++;
    }
    modes.push(width < 651 ? 'mobile' : 'desktop');
  }
  trace.destroy(); delete context.GUZICZAK_TRACE; quench.destroy?.();
  return { frames, modes, phases: timeline.segments.map(segment => segment.id), instrumentFrames, maximumCommands, activeKeys: [...activeKeys], ...gpu.stats() };
});

check('renderer-javascript-projection-and-uniforms', () => {
  assert(catalog, 'Geometry catalog required');
  const uniformSamples = [], programSources = [], methods = new Set();
  let number = 100000, draws = 0;
  const additions = {
    getParameter: () => 8192,
    getExtension: name => name === 'EXT_color_buffer_float' ? {} : null,
    getInternalformatParameter: () => new Int32Array([4]),
    getShaderParameter: () => true,
    getProgramParameter: (program, key) => key === gl.ACTIVE_UNIFORMS ? program.uniforms?.length || 0 : true,
    shaderSource: (shader, source) => { shader.source = source; },
    attachShader: (program, shader) => { (program.shaders ||= []).push(shader); },
    linkProgram: program => {
      const source = program.shaders.map(shader => shader.source).join('\n');
      const uniforms = new Map();
      for (const match of strippedGLSL(source).matchAll(/\buniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([^;{}]+);/g)) {
        for (const declaration of match[2].split(',')) {
          const entry = declaration.trim().match(/^(\w+)(\s*\[[^\]]+\])?/); if (!entry) continue;
          const name = entry[1] + (entry[2] ? '[0]' : ''); uniforms.set(name, { name, type: match[1], size: 1 });
        }
      }
      program.uniforms = [...uniforms.values()]; programSources.push(program.shaders.map(shader => shader.source));
    },
    getActiveUniform: (program, index) => program.uniforms[index],
    getUniformLocation: (program, name) => ({ program, name }),
    getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    clientWaitSync: () => gl.CONDITION_SATISFIED,
    getError: () => 0,
    drawArrays() { draws++; }, drawElements() { draws++; }, drawArraysInstanced() { draws++; }, drawElementsInstanced() { draws++; }
  };
  const raw = { ...gpu.gl, ...additions };
  const gl = new Proxy(raw, { get(target, key) {
    if (key in target) return target[key];
    if (/^[A-Z][A-Z0-9_]*$/.test(String(key))) return target[key] = ++number;
    if (/^create|^fenceSync/.test(String(key))) return target[key] = () => ({ id: ++number });
    if (/^uniform/.test(String(key))) return target[key] = (location, ...values) => {
      for (const value of values) {
        if (typeof value === 'boolean') continue;
        if (Array.isArray(value) || ArrayBuffer.isView(value)) assert(Array.from(value).every(Number.isFinite), location.name + ': finite uniform array');
        else assert(Number.isFinite(value), location.name + ': finite uniform value');
      }
      uniformSamples.push({ name: location.name, values });
    };
    methods.add(String(key)); return target[key] = () => {};
  } });
  const canvas = doc.getElementById('scene');
  const device = { gl, claimSurface(width, height) { canvas.width = width; canvas.height = height; }, counts: () => ({}), dispose() {} };
  const renderer = registry.get('render/renderer').createRenderer(device, catalog, canvas, doc, registry.get('config/sequence').render);
  const timeline = registry.get('core/timeline').createTimeline();
  const scene = registry.get('scene/composer').createScene(catalog);
  const quench = registry.get('interaction/quench').create(timeline);
  const trace = registry.get('runtime/trace').create(win, doc); context.GUZICZAK_TRACE = trace;
  const drive = registry.get('world/water-drive').create();
  const sampled = [], handoffProjection = [];
  const engine = registry.get('app/engine');
  for (const authored of [2, 6.3, 9.5, 10.2, 11.5, 12.0, 13.5, 17.5]) {
    const frame = registry.get('scene/state').sampleState(timeline.sample(timeline.toElapsed(authored)));
    frame.frozen = false; frame.seek = true; frame.motion = { tilt: [0, 0], acceleration: [0, 0], speed: 0 };
    const viewport = { width: 1440, height: 900, dpr: 1 };
    trace.beginFrame('intro', frame, 20000 + authored * 1000);
    frame.water = drive.advance(1 / 60, frame.motion, false); frame.instrument = legacyAudioSnapshot(); frame.quench = quench.sample(frame);
    const packet = scene.sample(frame, viewport);
    Object.assign(frame, { fluid: packet.fluid, docking: packet.docking, reclaim: packet.reclaim, inflow: packet.inflow }, packet.atmosphere);
    const camera = registry.get('scene/camera').sampleCamera(frame, viewport, packet.assembly);
    renderer.render(frame, packet, camera, viewport);
    let projected = { targets: [], pickTargets: [] };
    if (!baseline) {
      assert.equal(typeof trace.executed, 'function', 'Trace exposes current-frame executed objects');
      assert.equal(typeof engine.projectTraceTargets, 'function', 'Engine projection helper is testable');
      projected = engine.projectTraceTargets(packet, renderer.project, viewport, frame, trace.executed());
      assert(projected.targets.every(target => Number.isFinite(target.x) && Number.isFinite(target.y)), 'Projected object anchors are finite CSS positions');
      assert(projected.pickTargets.every(target => target.visible && target.depth > 0), 'Only visible forward-facing anchors can be picked');
      if (authored < 16.7) assert.equal(projected.targets.filter(target => target.objectId.startsWith('instrument/note/')).length, 66, 'All chromatic mouths have projection anchors');
      else assert.equal(projected.targets.length, 0, 'Cinema targets are removed during exhibit handoff');
      trace.setTargets(projected.targets);
      const one = projected.pickTargets[0];
      if (one) assert.equal(engine.pickTraceTarget([one], one.x, one.y, { pointerType: 'touch' })?.objectId, one.objectId, 'Projected target can select its stable object ID');
    }
    trace.endFrame({ audio: frame.instrument, paused: false });
    if (!baseline && authored >= 9.5 && authored <= 12.0) {
      assert.equal(trace.diagnostics().activeKey, 'gold', 'Idle-quench casting/cooling focuses executed gold operation at ' + authored);
      const heading = doc.querySelector('.live-trace-name');
      if (authored < 11.62) assert.equal(heading?.textContent, 'Wypełnianie formy', 'Casting label follows fill operation');
      assert(projected.targets.some(target => target.objectId === trace.selection()?.objectId && target.visible), 'Selected gold operation anchors to a currently visible object');
    }
    assert.equal(renderer.ready(), true);
    assert(renderer.project([0, 0, 0]).every(Number.isFinite), 'Renderer projection is finite');
    sampled.push({ authored, activeKey: trace.diagnostics().activeKey, objects: packet.commands.length, projectedTargets: projected.targets.length, pickTargets: projected.pickTargets.length });
  }
  if (!baseline) {
    // At the first exhibit frame the cinema mark and its presentation rectangle
    // must share the original 35-degree, full-viewport projection. Derive the
    // expected pixels directly from the aligned mark plane, independently of M.P.
    const { hero } = registry.get('config/casting');
    for (const [width, height] of [[1440, 900], [375, 720], [390, 660]]) {
      const authored = 16.70, viewport = { width, height, dpr: 1,
        traceTop: Math.min(width <= 700 ? 56 : 62, height * .13),
        traceInset: Math.min(width <= 360 ? 136 : width <= 700 ? 128 : 124, height * .30) };
      const frame = registry.get('scene/state').sampleState(timeline.sample(timeline.toElapsed(authored)));
      assert(Math.abs(frame.time - authored) < 1e-9, 'Handoff test samples the exact first exhibit frame');
      frame.frozen = false; frame.seek = true; frame.motion = { tilt: [0, 0], acceleration: [0, 0], speed: 0 };
      frame.water = drive.advance(1 / 60, frame.motion, false); frame.instrument = legacyAudioSnapshot(); frame.quench = quench.sample(frame);
      const packet = scene.sample(frame, viewport);
      Object.assign(frame, { fluid: packet.fluid, docking: packet.docking, reclaim: packet.reclaim, inflow: packet.inflow }, packet.atmosphere);
      const camera = registry.get('scene/camera').sampleCamera(frame, viewport, packet.assembly);
      renderer.render(frame, packet, camera, viewport);
      const focal = height / (2 * Math.tan(35 * Math.PI / 360)), z = hero.z + .08 * hero.scale;
      const points = [[0, hero.y, z], [-1.1 * hero.scale, hero.y + 1.12 * hero.scale, z],
        [1.1 * hero.scale, hero.y - 1.12 * hero.scale, z]];
      let maxErrorPx = 0;
      const projected = points.map(point => {
        const actual = renderer.project(point), depth = 9.5 - point[2];
        const expected = [width * .5 + point[0] * focal / depth, height * .5 - point[1] * focal / depth];
        for (let axis = 0; axis < 2; axis++) maxErrorPx = Math.max(maxErrorPx, Math.abs(actual[axis] - expected[axis]));
        assert(Math.abs(actual[2] - depth) < .00001, 'Settled signature plane retains original camera depth');
        return actual;
      });
      assert(maxErrorPx < .002, 'At 16.70 the renderer restores full-viewport signature projection at ' + width + 'x' + height + '; error=' + maxErrorPx);
      const rect = registry.get('scene/brand-layout').sample(authored, viewport).rect;
      const rectErrorPx = Math.max(Math.abs(projected[1][0] - rect.x), Math.abs(projected[1][1] - rect.y),
        Math.abs(projected[2][0] - rect.x - rect.w), Math.abs(projected[2][1] - rect.y - rect.h));
      assert(rectErrorPx < .002, 'Cinema signature front plane aligns with the exhibit handoff rectangle');
      const content = registry.get('scene/camera').contentViewport(frame, viewport);
      assert.equal(content.top, 0, 'Camera header reservation ends at the first exhibit frame');
      assert.equal(content.bottom, 0, 'Camera ambient-source reservation ends at the first exhibit frame');
      handoffProjection.push({ width, height, authored, maxErrorPx, rectErrorPx });
    }
  }
  assert(uniformSamples.some(sample => sample.name === 'uNoteEnergy' && sample.values[0] > 0), 'Audible note intensity reaches mesh shader uniform');
  if (!baseline) {
    assert(uniformSamples.some(sample => sample.name === 'uMode' && sample.values[0] === 8), 'Airflow reaches its renderer mode without colliding with existing deformation');
  }
  for (const pair of programSources) {
    assert.equal(pair.length, 2, 'Every renderer program has vertex and fragment source');
    const produced = interfaceValues(pair[0], 'out');
    for (const [name, type] of interfaceValues(pair[1], 'in')) assert.equal(produced.get(name), type, 'Renderer program varying ' + name);
  }
  if (dumpShaders) {
    const exported = programSources.map((pair, index) => ({ name: 'cinema/program-' + index, vertex: pair[0], fragment: pair[1] }));
    const exhibit = registry.get('render/atelier-shaders');
    for (const prefix of ['mesh', 'shadow', 'dust']) exported.push({ name: 'exhibit/' + prefix, vertex: exhibit[prefix + 'VS'], fragment: exhibit[prefix + 'FS'] });
    for (const prefix of ['sky', 'water', 'post', 'blur', 'fog']) exported.push({ name: 'exhibit/' + prefix, vertex: exhibit.screenVS, fragment: exhibit[prefix + 'FS'] });
    fs.writeFileSync(dumpShaders, JSON.stringify({ htmlPath, programs: exported }));
  }
  renderer.suspend(); assert.equal(renderer.stats().suspended, true);
  trace.destroy(); delete context.GUZICZAK_TRACE; quench.destroy?.();
  return { renderFrames: sampled, handoffProjection, simulatedPrograms: programSources.length, uniformWrites: uniformSamples.length, simulatedDrawCalls: draws,
    limitation: 'Real renderer JavaScript, projection math and uniform values; graphics compilation, resource allocation and draw calls simulated.' };
});

if (!baseline) check('engine-target-rejection-and-picking', () => {
  const engine = registry.get('app/engine');
  const packet = { commands: [], traceTargets: [
    { key: 'organ', objectId: 'instrument/note/60', world: [100, 100, 2] },
    { key: 'organ', objectId: 'instrument/note/61', world: [100, 100, -2] },
    { key: 'organ', objectId: 'instrument/note/62', world: [10000, 100, 2] },
    { key: 'organ', objectId: 'instrument/note/63', world: [NaN, 100, 2] }
  ] };
  const result = engine.projectTraceTargets(packet, point => point, { width: 375, height: 720 }, { time: 9.5 }, []);
  assert.equal(result.pickTargets.length, 1, 'Offscreen, behind-camera and invalid coordinates are rejected');
  assert.equal(result.pickTargets[0].objectId, 'instrument/note/60');
  assert.equal(engine.pickTraceTarget(result.pickTargets, 100, 100)?.objectId, 'instrument/note/60');
  assert.equal(engine.pickTraceTarget(result.pickTargets, 300, 500), null, 'Empty stage tap has no invented target');
  assert.equal(engine.pickTraceTarget(result.pickTargets, NaN, 100), null, 'Invalid pointer is ignored');
  const overlap = [{ objectId: 'back', x: 100, y: 100, depth: 5, radius: 20, visible: true }, { objectId: 'front', x: 100, y: 100, depth: 2, radius: 20, visible: true }];
  assert.equal(engine.pickTraceTarget(overlap, 100, 100)?.objectId, 'front', 'Nearer object wins equal-distance pick');
  assert.equal(engine.projectTraceTargets(packet, point => point, { width: 375, height: 720 }, { time: 16.7 }, []).targets.length, 0, 'Handoff cannot reuse cinema targets');
  return { invalidCoordinates: true, offscreen: true, depth: true, emptyTap: true, stableObjectIds: true, handoffClears: true };
});

check('trace-source-lifecycle-and-selection', () => {
  const isolated = makeDom();
  const trace = registry.get('runtime/trace').create(isolated.win, isolated.doc);
  const root = isolated.doc.getElementById('live-trace'); assert(root, 'Trace root mounted');
  assert(trace.diagnostics().sourceKeys.length >= 12, 'All real source blocks captured');
  trace.beginFrame('intro', { time: 2, elapsed: 2, phase: 'assembly' }, 1000);
  trace.emit('assembly', { transform: [1, 2, 3], energy: .3 }, { objectId: 'assembly/cup', priority: 40 });
  trace.emit('not-a-source', { evil: '<script>bad</script>' }, { objectId: 'bad', priority: 1000 });
  trace.endFrame({ audio: legacyAudioSnapshot(), paused: false });
  assert.equal(trace.diagnostics().activeKey, 'assembly', 'Only source-backed operations can be selected');
  assert.equal(trace.diagnostics().visible, true);
  if (!baseline) {
    assert.equal(trace.diagnostics().expanded, false, 'Compact code view is default');
    assert.equal(typeof trace.pin, 'function', 'Pin API'); assert.equal(typeof trace.unpin, 'function', 'Unpin API');
    assert.equal(typeof trace.selection, 'function', 'Renderer selection API');
    assert.equal(typeof trace.projectObject, 'function', 'Projected object API');
    trace.pin('water', 'water/surface');
    trace.beginFrame('intro', { time: 2.016, phase: 'assembly' }, 1016);
    trace.emit('assembly', { energy: .5 }, { objectId: 'assembly/cup', priority: 80 });
    trace.emit('water', { velocity: .3, waves: 1 }, { objectId: 'water/surface', priority: 12 });
    trace.projectObject('water/surface', { x: 710, y: 460, visible: true });
    trace.endFrame({ audio: legacyAudioSnapshot(), paused: true });
    assert.equal(trace.diagnostics().activeKey, 'water', 'Pinned lower-priority executed operation wins');
    assert.equal(trace.diagnostics().paused, true);
    const status = root.querySelector('.live-trace-status');
    assert(status && /PAUZA|PAUSED/.test(status.textContent), 'Pause badge updates within a 16ms frame');
    assert(root.querySelector('.live-trace-values')?.textContent.includes('0.3'), 'Final paused frame values bypass the 125ms paint throttle');
    const selection = trace.selection(); assert.equal(selection?.objectId, 'water/surface'); assert.equal(selection?.pinned, true);
    assert.equal(trace.diagnostics().tether, true, 'Current projected object gets a tether');
    const point = isolated.doc.querySelector('.live-trace-target'); assert.equal(point.getAttribute('cx'), '710'); assert.equal(point.getAttribute('cy'), '460');
    trace.beginFrame('intro', { time: 2.032, phase: 'assembly' }, 1032);
    trace.emit('assembly', { energy: .6 }, { objectId: 'assembly/cup', priority: 80 });
    trace.endFrame({ audio: legacyAudioSnapshot(), paused: false });
    assert.equal(trace.selection().waiting, true, 'Inactive pinned object is explicitly historical');
    assert.equal(status.textContent, 'CZEKA', 'Inactive operation never claims LIVE');
    assert.equal(trace.diagnostics().tether, false, 'Inactive operation hides tether');
    trace.beginFrame('intro', { time: 2.048, phase: 'assembly' }, 1048);
    trace.emit('water', { velocity: .4 }, { objectId: 'water/surface', priority: 12 });
    trace.endFrame({ audio: legacyAudioSnapshot(), paused: false });
    assert.equal(trace.diagnostics().tether, false, 'Targets from previous frames never leak');
    assert.equal(trace.pin('missing-source', 'untrusted'), false, 'Cannot pin fabricated source');
    trace.unpin();
  }
  const toggle = root.querySelector('.live-trace-toggle');
  if (toggle && !trace.diagnostics().expanded) toggle.dispatchEvent(new Event('click'));
  for (const [i, key] of ['water', 'lift', 'pour', 'mould', 'cast'].entries()) {
    trace.beginFrame('intro', { time: i + 4 }, 1500 + i * 400); trace.emit(key, { time: i, position: [1, 2, 3] }, { priority: 80 }); trace.endFrame({ audio: legacyAudioSnapshot() });
  }
  assert(trace.diagnostics().history <= 3, 'History retains at most 3 source blocks');
  trace.beginFrame('page', { time: 23 }, 6000); trace.emit('exhibit', { yaw: .4 }, { objectId: 'exhibit/mark', priority: 60 }); trace.endFrame({ audio: legacyAudioSnapshot() });
  assert.equal(trace.diagnostics().mode, 'page');
  isolated.win.dispatchEvent(new DetailEvent('guziczak:routechange', { detail: { view: 'cv' } }));
  assert.equal(trace.diagnostics().visible, false, 'CV route hides trace');
  isolated.win.dispatchEvent(new DetailEvent('guziczak:routechange', { detail: { view: 'home' } }));
  trace.setSuspended(true); assert.equal(trace.diagnostics().visible, false);
  trace.setSuspended(false);
  isolated.doc.documentElement.lang = 'de'; isolated.win.dispatchEvent(new DetailEvent('guziczak:languagechange'));
  assert.equal(root.getAttribute('aria-label'), 'Code live', 'Localization changes trace UI');
  trace.destroy(); assert.equal(trace.diagnostics().destroyed, true); assert.equal(trace.diagnostics().scopeSize, 0, 'Event listeners disposed');
  assert.equal(isolated.doc.getElementById('live-trace'), null, 'Trace node removed');
  return { sources: 12, boundedHistory: true, selection: !baseline, routeLifecycle: true, localization: true, cleanup: true };
});

if (!baseline) check('trace-layout-and-stable-connectors', () => {
  const runtime = registry.get('runtime/trace');
  const fixtures = [[320, 568], [390, 660], [812, 375], [1440, 900]];
  for (const [width, height] of fixtures) {
    const viewport = { left: 7, top: 11, width, height };
    const safe = { left: 18, right: 18, top: 70, bottom: 16 };
    const bounds = { left: viewport.left + width * .12, right: viewport.left + width * .88,
      top: viewport.top + height * .20, bottom: viewport.top + height * .60 };
    const size = { width: 530, height: height < 400 ? 72 : 84 };
    const layout = runtime.resolveTraceLayout({ viewport, bounds, safe, size });
    assert(layout.fits, 'A compact source annotation fits portrait, landscape and desktop viewports');
    assert(layout.left >= viewport.left + safe.left && layout.right <= viewport.left + width - safe.right, 'Source stays inside both horizontal safe margins');
    assert(layout.top >= viewport.top + safe.top && layout.bottom <= viewport.top + height - safe.bottom, 'Source stays clear of top controls and the viewport bottom');
    assert(layout.top >= bounds.bottom && layout.top - bounds.bottom <= 18, 'Available space places source directly below its scene');
    const crowded = runtime.resolveTraceLayout({ viewport, bounds: { ...bounds, bottom: viewport.top + height - 3 }, safe, size });
    assert.equal(crowded.placement, 'clamped', 'A low scene cannot push the annotation offscreen');
    assert(crowded.bottom <= viewport.top + height - safe.bottom && crowded.top >= viewport.top + safe.top);
  }
  const viewport = { left: 0, top: 0, width: 390, height: 660 };
  const rect = { left: 18, top: 500, right: 372, bottom: 584 };
  const closeTargets = [{ x: 90, y: 470 }, { x: 200, y: 620 }, { x: 5, y: 540 }, { x: 385, y: 540 }];
  for (const target of closeTargets) {
    const connector = runtime.resolveTraceConnector({ rect, target, viewport, maxLength: 112 });
    assert.equal(connector.kind, 'linked', 'A nearby object is connected to the annotation');
    assert.equal(connector.end.x, target.x); assert.equal(connector.end.y, target.y);
    assert(connector.start.x === rect.left || connector.start.x === rect.right || connector.start.y === rect.top || connector.start.y === rect.bottom, 'A direct leader starts on the source boundary');
    assert(connector.length <= 112, 'The direct leader stays within its readable length budget');
  }
  for (const target of [{ x: 1, y: 1 }, { x: 389, y: 1 }, { x: 200, y: 120 }]) {
    const connector = runtime.resolveTraceConnector({ rect, target, viewport, maxLength: 112, labelWidth: 40 });
    assert.equal(connector.kind, 'local', 'A distant object gets a short local leader instead of a long diagonal');
    assert.equal(connector.end.x, target.x); assert.equal(connector.end.y, target.y);
    assert(connector.length <= 30 && connector.label, 'A short local pointer includes a note label');
    for (const point of [connector.start, connector.label]) assert(point.x >= 0 && point.x <= 390 && point.y >= 0 && point.y <= 660, 'Edge targets retain an onscreen pointer and label anchor');
  }
  for (const target of [{ x: 200, y: 540 }, { x: -1, y: 100 }, { x: 100, y: 100, visible: false }])
    assert.equal(runtime.resolveTraceConnector({ rect, target, viewport }), null, 'Covered or unavailable targets do not get misleading leaders');
  const isolated = makeDom(), trace = runtime.create(isolated.win, isolated.doc);
  isolated.win.innerWidth = 390; isolated.win.innerHeight = 660;
  trace.setSceneLayout({ viewport, bounds: { left: 24, right: 366, top: 150, bottom: 420 }, safe: { left: 18, right: 18, top: 70, bottom: 16 } });
  function frame(ms, entries) {
    trace.beginFrame('intro', { time: 2 + (ms - 1000) / 1000 }, ms);
    for (const entry of entries) {
      trace.projectObject('instrument/note/' + entry.midi, { x: entry.x, y: entry.y });
      trace.emit('organ', { note: entry.note, midi: entry.midi, flowHeight: .7 }, { objectId: 'instrument/note/' + entry.midi, priority: entry.priority });
    }
    trace.endFrame({ audio: legacyAudioSnapshot() });
  }
  const c4 = { midi: 60, note: 'C4', priority: 80, x: 90, y: 400 }, c5 = { midi: 72, note: 'C5', priority: 84, x: 340, y: 150 };
  frame(1000, [c4]);
  assert.equal(trace.diagnostics().layout.placement, 'below', 'The live trace consumes the scene layout API');
  frame(1100, [c4, c5]);
  assert.equal(trace.selection().objectId, 'instrument/note/60', 'A still sounding selected pipe does not flicker to a new chord leader every frame');
  frame(1116, [c5]);
  assert.equal(trace.selection().objectId, 'instrument/note/72', 'Selection immediately leaves a voice that no longer executes');
  const connector = trace.diagnostics().connector;
  assert.equal(connector.kind, 'local'); assert.equal(connector.caption, 'C5', 'The local pointer names the actual selected note');
  const marker = isolated.doc.querySelector('.live-trace-target');
  assert.equal(Number(marker.getAttribute('cx')), c5.x); assert.equal(Number(marker.getAttribute('cy')), c5.y);
  assert.equal(isolated.doc.querySelector('.live-trace-target-label').textContent, 'C5');
  trace.pin('organ', 'instrument/note/60');
  assert.equal(trace.selection().waiting, true); assert.equal(trace.diagnostics().connector, null, 'Pinning an inactive mouth cannot preserve an active leader');
  trace.setSceneLayout(null); assert.equal(trace.diagnostics().layout, null, 'Clearing the scene layout removes the intro placement');
  trace.unpin();
  trace.setSceneLayout({ viewport, bounds: { left: 24, right: 366, top: 150, bottom: 420 } });
  frame(1700, [c5]); assert(trace.diagnostics().layout, 'A later intro frame can restore the scene placement');
  trace.beginFrame('page', { time: 23 }, 2100); trace.emit('exhibit', { yaw: .3 }, { objectId: 'exhibit/signature', priority: 70 }); trace.endFrame({});
  const traceRoot = isolated.doc.getElementById('live-trace');
  assert.equal(trace.diagnostics().layout, null, 'Entering the exhibit clears floating intro placement');
  assert.equal(traceRoot.parentNode.id, 'artifact-stage', 'Page source is attached to its own artifact stage');
  assert(!traceRoot.style.left && !traceRoot.style.top, 'Intro screen coordinates cannot leak into page layout');
  trace.destroy();
  return { responsiveFixtures: fixtures.length, boundedLeaders: true, exactMouthMarker: true, noteLabels: true, stableSelection: true, absentVoiceNeverLive: true, pagePlacementCleanup: true };
});

if (!baseline) check('trace-ambient-execution-provenance', () => {
  // Compare displayed text against the real script text independently of the
  // runtime trace's source cache. Line numbers alone cannot prove provenance.
  const actualSources = new Map();
  for (const script of scripts) {
    let key = null, lines = new Map();
    for (const [index, line] of script.textContent.split('\n').entries()) {
      const marker = line.match(/^\s*\/\/\s*@live:([a-z][a-z0-9-]*)\s*$/);
      if (marker) {
        if (marker[1] === 'end') {
          if (key && !actualSources.has(key)) {
            const nonempty = Array.from(lines.values()).filter(line => line.trim());
            const indent = nonempty.length ? Math.min(...nonempty.map(line => line.match(/^\s*/)[0].length)) : 0;
            actualSources.set(key, { lines, indent });
          }
          key = null;
        }
        else { key = marker[1]; lines = new Map(); }
      } else if (key) lines.set(index + 1, line);
    }
  }
  function sourceSpan(key, range) {
    const source = actualSources.get(key); assert(source, 'The instruction belongs to an actual marked source');
    assert(Number.isInteger(range.line) && Number.isInteger(range.endLine) && range.endLine >= range.line, 'The instruction has a complete source line range');
    assert(Number.isInteger(range.column) && Number.isInteger(range.endColumn) && range.column >= 0 && range.endColumn > 0, 'Statement columns preserve provenance when multiple statements share a line');
    const parts = [];
    for (let number = range.line; number <= range.endLine; number++) {
      const raw = source.lines.get(number); assert.equal(typeof raw, 'string', 'Every instruction line exists inside the marked source');
      const start = source.indent + (number === range.line ? range.column : 0);
      const end = number === range.endLine ? source.indent + range.endColumn : raw.length;
      assert(start <= end && end <= raw.length, 'The displayed instruction span stays inside real source text');
      parts.push(raw.slice(start, end));
    }
    const text = parts.join('\n').trim();
    assert(text.endsWith(';'), 'Compact source contains a complete instruction rather than a clipped expression');
    return text;
  }
  const isolated = makeDom(), trace = registry.get('runtime/trace').create(isolated.win, isolated.doc);
  const root = isolated.doc.getElementById('live-trace'), executed = new Map();
  let frameId = 0;
  const frame = (key, options = {}) => {
    const id = ++frameId;
    trace.beginFrame(options.mode || 'intro', { frameId: id, time: id * .1 + 2, phase: 'assembly' }, 1000 + id * 400);
    trace.emit(key, { energy: id / 10, position: [1, 2, 3] }, { objectId: key + '/actual', priority: 80,
      focus: options.focus || [] });
    trace.emit('fabricated-operation', { source: 'invented.transform()' }, { priority: 1000 });
    executed.set(id, key);
    trace.endFrame({ audio: legacyAudioSnapshot(), paused: !!options.paused });
    return id;
  };
  const visibleNode = node => { let current = node; while (current) { if (current.hidden || current.hasAttribute('hidden')) return false; current = current.parentNode; } return true; };
  function inspect() {
    const diagnostics = trace.diagnostics();
    const rows = root.querySelectorAll('.live-trace-excerpt-line');
    assert(rows.length > 0 && rows.length <= (diagnostics.mode === 'page' ? 1 : 2), 'Ambient code has a small, legible source excerpt');
    assert.equal(rows.filter(row => row.classList.contains('is-active')).length, 1, 'One real instruction is visually emphasized');
    assert.equal(diagnostics.compactInstructions.length, rows.length, 'Displayed instructions retain their source spans');
    for (const [index, row] of rows.entries()) {
      const range = diagnostics.compactInstructions[index], actual = sourceSpan(diagnostics.activeKey, range);
      assert.equal(range.text.trim(), actual, 'Instruction diagnostics are copied from the actual source range');
      assert.equal(row.querySelector('code')?.textContent, actual, 'Displayed source is copied exactly, never replacement code');
      for (const key of ['line', 'endLine', 'column', 'endColumn']) assert.equal(Number(row.dataset[key]), range[key], 'DOM instruction range matches its captured source');
      if (!['shader', 'gold'].includes(diagnostics.activeKey)) new vm.Script('(function(){\n' + actual + '\n})', { filename: 'compact-' + diagnostics.activeKey + '.js' });
    }
    assert(Array.isArray(diagnostics.ambientEchoes), 'Ambient echo diagnostics expose execution provenance');
    assert(diagnostics.ambientEchoes.length <= 1, 'At most one previous operation remains as an ambient echo');
    const echo = root.querySelector('.live-trace-echo');
    assert.equal(echo?.getAttribute('aria-hidden'), 'true', 'The visual echo does not duplicate code for assistive readers');
    const echoes = root.querySelectorAll('.live-trace-echo-line').filter(visibleNode);
    assert.equal(echoes.length, diagnostics.ambientEchoes.length, 'Visible echoes match recorded actual executions');
    for (const [index, prior] of diagnostics.ambientEchoes.entries()) {
      assert.equal(executed.get(prior.frameId), prior.key, 'Every echo points to an operation actually emitted in its recorded frame');
      assert.notEqual(prior.key, diagnostics.activeKey, 'An echo refers to an earlier operation, not a duplicate of the active block');
      const actual = sourceSpan(prior.key, prior);
      assert.equal(echoes[index].querySelector('code')?.textContent, actual, 'Echo text retains exact executed-source provenance');
      for (const key of ['line', 'endLine', 'column', 'endColumn']) assert.equal(Number(echoes[index].dataset[key]), prior[key]);
      assert.equal(echoes[index].dataset.key, prior.key);
    }
    return JSON.parse(JSON.stringify(diagnostics.ambientEchoes));
  }
  const assemblyFrame = frame('assembly', { focus: ['const seated', 'const cartridge'] });
  assert.equal(inspect().length, 0, 'A first execution has no invented historical echo');
  frame('water', { focus: ['v[k]+=', 's[k]+='] });
  const firstEcho = inspect();
  assert.equal(firstEcho.length, 1, 'A real operation change leaves one source echo');
  assert.equal(firstEcho[0].frameId, assemblyFrame, 'Echo retains its original execution frame');
  frame('water', { paused: true });
  assert.deepEqual(inspect(), firstEcho, 'Pausing the same operation does not advance ambient history');
  const pausedFrame = trace.selection().frameId;
  isolated.win.advanceTime(20000); trace.endFrame({ paused: true });
  assert.deepEqual(inspect(), firstEcho, 'Wall-clock time alone cannot scroll or generate an echo');
  assert.equal(trace.selection().frameId, pausedFrame, 'Paused display never claims another executed frame');
  trace.pin('pour', 'pour/not-yet-executed');
  assert.equal(trace.selection().waiting, true, 'Pinning an unexecuted source is explicitly pending');
  assert.equal(trace.diagnostics().ambientEchoes.length, 0, 'Pending selection has no misleading executed echo');
  assert.equal(root.querySelectorAll('.live-trace-echo-line').filter(visibleNode).length, 0, 'Pending selection hides the historical visual echo');
  trace.unpin();
  const toggle = root.querySelector('.live-trace-toggle'); toggle.dispatchEvent(new Event('click'));
  const history = root.querySelector('.live-trace-history');
  let scrollWrites = 0, scrollPosition = 83;
  Object.defineProperty(history, 'scrollTop', { configurable: true, get: () => scrollPosition, set: value => { scrollWrites++; scrollPosition = value; } });
  frame('lift'); inspect(); frame('pour'); inspect(); frame('mould'); inspect();
  assert.equal(scrollWrites, 0, 'New source captures never force the user-controlled expanded history to scroll');
  assert.equal(history.querySelector('.live-trace-code')?.dataset.key, 'mould', 'Expanded source starts with the latest actual operation');
  frame('organ', { focus: ['const flowHeight =', 'const flowPose ='] }); inspect();
  const organ = trace.diagnostics().compactInstructions;
  assert.equal(organ.length, 2, 'The airflow view retains both short real transform instructions');
  assert(organ.every(unit => unit.text.length <= 48 && unit.line === unit.endLine), 'The sounding-pipe explanation fits as complete short calls');
  frame('cast', { focus: ['M.T(0,y,z)', 'M.Ry(yaw)'] }); inspect();
  const cast = trace.diagnostics().compactInstructions;
  assert.equal(cast.length, 2); assert(cast.every(unit => unit.line === unit.endLine && unit.text.length <= 48), 'Casting exposes complete short transform instructions');
  assert(cast.some(unit => unit.text.includes('M.T(0,y,z)')) && cast.some(unit => unit.text.includes('M.Ry(yaw)')), 'The live casting source keeps both actual translation and rotation');
  const multiline = ['const pose=C(', ' M.T(0,y,z),', ' M.Ry(yaw),M.Rx(rotation),', ' localTilt,M.S(scale)', ');'];
  const parsed = registry.get('runtime/trace').sourceInstructions(multiline.map((text, i) => ({ text, number: 101 + i })));
  assert.equal(parsed.length, 1, 'A multi-line matrix composition remains one complete instruction');
  assert.equal(parsed[0].text, multiline.join('\n'), 'Multi-line extraction retains the complete transform and closing punctuation');
  assert.equal(parsed[0].number, 101); assert.equal(parsed[0].endNumber, 105);
  frame('exhibit', { mode: 'page' }); inspect();
  trace.reset();
  assert.equal(trace.diagnostics().ambientEchoes.length, 0, 'Replay reset clears ambient execution history');
  assert.equal(root.querySelectorAll('.live-trace-echo-line').filter(visibleNode).length, 0, 'Replay reset clears visible ambient echoes');
  trace.destroy();
  return { exactSourceText: true, completeInstructionSpans: true, shortCastCalls: true, multilineExtraction: true, introInstructions: 2, pageInstructions: 1, maximumEchoes: 1,
    echoExecutionFrames: true, pausedClockStable: true, pendingHasNoEcho: true, manualHistoryScroll: true, resetClears: true };
});

console.log(JSON.stringify({ htmlPath, baseline, only: only || undefined, findings, failures,
  limitations: ['No browser layout or interactive visual inspection.', 'No real GLSL compilation or WebGL driver execution.', 'No audio hardware or perceived synchronization check.'] }, null, 2));
process.exitCode = failures.length ? 1 : 0;
