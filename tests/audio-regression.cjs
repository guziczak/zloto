'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// With an explicit HTML argument, test the integrated application. Otherwise use
// the replacement modules next to this file and the repository's real library.
const htmlPath = process.argv[2] || [path.resolve(__dirname, '../index.html'), path.resolve(__dirname, '../zloto/index.html')].find(fs.existsSync);
if (!htmlPath) throw Error('Usage: node audio-regression.cjs /absolute/path/to/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const overridePath = path.join(__dirname, 'audio-modules.json');
const overrides = !process.argv[2] && fs.existsSync(overridePath) ? JSON.parse(fs.readFileSync(overridePath, 'utf8')) : {};
function moduleSource(name) {
    if (overrides[name]) return overrides[name];
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const start = html.search(new RegExp('GuziczakModules\\.define\\(["\x27]' + safe + '["\x27]'));
    if (start < 0) throw Error('Missing module: ' + name);
    const end = html.indexOf('GuziczakModules.define(', start + 24);
    return html.slice(start, end < 0 ? html.length : end);
}

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { for (const fn of Array.from(this.listeners.get(event.type) || [])) fn(event); return true; }
}
class Element extends Events {
    constructor() { super(); this.dataset = {}; this.style = {}; this.textContent = ''; }
    setAttribute() {}
    matches() { return false; }
    closest() { return null; }
}
class Param {
    constructor(value = 0) { this.value = value; this.events = []; }
    cancelScheduledValues(at) { this.events.push({ type: 'cancel', at }); }
    setValueAtTime(value, at) { this.events.push({ type: 'set', value, at }); this.value = value; }
    setTargetAtTime(value, at, tau) { this.events.push({ type: 'target', value, at, tau }); }
    exponentialRampToValueAtTime(value, at) { this.events.push({ type: 'exponential', value, at }); }
}
class Node {
    constructor() {
        for (const name of ['gain','pan','frequency','detune','Q','threshold','knee','ratio','attack','release']) this[name] = new Param();
        this.connections = [];
    }
    connect(other) { this.connections.push(other); return other; }
    disconnect() { this.connections = []; }
    getFloatTimeDomainData(array) { array.fill(0); }
}

async function fixture({ main = [[0, 2000, 60, 127]], variation = [[0, 2000, 72, 127]], enabled = true } = {}) {
    const win = new Events(), doc = new Events(), intervals = new Map(), timeouts = new Map();
    let nextTimer = 0, wallTime = 200000, context = null;
    const elements = new Map();
    doc.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    doc.body = new Element(); doc.hidden = false;
    const storage = new Map();
    win.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
    win.performance = { now: () => wallTime };
    win.fetch = async url => ({ ok: true, status: 200, text: async () => JSON.stringify({ bpm: 103, gap_ms: 4500,
        notes: url.endsWith('variation.json') ? variation : main }) });
    class AudioContext extends Events {
        constructor() { super(); context = this; this.currentTime = 100; this.state = 'running'; this.sampleRate = 2000; this.outputLatency = .025; this.baseLatency = .025; this.destination = new Node(); this.oscillators = []; }
        createGain() { return new Node(); }
        createDynamicsCompressor() { return new Node(); }
        createBiquadFilter() { return new Node(); }
        createConvolver() { return new Node(); }
        createAnalyser() { return new Node(); }
        createStereoPanner() { return new Node(); }
        createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: channel => data[channel] }; }
        createOscillator() {
            const node = new Node(); node.starts = []; node.stops = [];
            node.start = at => { node.starts.push(at); };
            node.stop = at => { node.stops.push(at); };
            this.oscillators.push(node); return node;
        }
        createBufferSource() { const node = new Node(); node.start = () => {}; node.stop = () => {}; return node; }
        getOutputTimestamp() { return { contextTime: this.currentTime - this.outputLatency, performanceTime: wallTime }; }
        suspend() { this.state = 'suspended'; this.dispatchEvent({ type: 'statechange' }); return Promise.resolve(); }
        resume() { this.state = 'running'; this.dispatchEvent({ type: 'statechange' }); return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
        finishNodes() {
            for (const node of this.oscillators) if (!node.ended && node.stops.length && node.stops.at(-1) <= this.currentTime) {
                node.ended = true; node.onended?.();
            }
        }
    }
    win.AudioContext = AudioContext;
    const registry = new Map(), instances = new Map();
    const config = { main: { title: 'Main', file: 'main.json' }, variation: { title: 'Variation', file: 'variation.json' },
        bases: ['https://fixture.invalid/'], cacheKey: 'fixture', defaultTempo: 103, defaultGapMs: 4500, timeoutMs: 6500, maxBytes: 2000000 };
    instances.set('config/music', config);
    instances.set('math', { clamp: (value, low, high) => Math.max(low, Math.min(high, value)) });
    instances.set('core/scope', { createScope() { const cleanups = []; return {
        on(target, type, fn, options) { target.addEventListener(type, fn, options); cleanups.push(() => target.removeEventListener(type, fn, options)); },
        dispose() { cleanups.splice(0).forEach(fn => fn()); }
    }; } });
    const GuziczakModules = {
        define(name, deps, factory) { registry.set(name, { deps, factory }); },
        get(name) { if (!instances.has(name)) { const item = registry.get(name); if (!item) throw Error('Missing dependency ' + name); instances.set(name, item.factory(...item.deps.map(dep => this.get(dep)))); } return instances.get(name); }
    };
    const sandbox = { GuziczakModules, window: win, document: doc, localStorage: win.localStorage, Element, AbortController,
        CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
        GUZICZAK_I18N: { t: key => key }, console,
        setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
        setTimeout: fn => { const id = ++nextTimer; timeouts.set(id, fn); return id; }, clearTimeout: id => timeouts.delete(id) };
    vm.createContext(sandbox);
    for (const name of ['audio/library', 'audio/music', 'audio/instrument']) vm.runInContext(moduleSource(name), sandbox, { filename: name });
    const sound = GuziczakModules.get('audio/music').createMusic(win, doc, { master: 1, music: .98, effects: .32 });
    const instruments = GuziczakModules.get('audio/instrument'), instrument = instruments.create(sound);
    await new Promise(resolve => setImmediate(resolve));
    sound.ready();
    if (enabled) sound.toggle();
    const result = {
        sound, instrument, instruments, win, doc,
        get context() { return context; },
        advance(seconds, schedule = true) {
            wallTime += seconds * 1000;
            if (context?.state === 'running') context.currentTime += seconds;
            if (schedule) for (const callback of Array.from(intervals.values())) callback();
            context?.finishNodes();
            return instrument.sample();
        },
        dispose() { instrument.destroy(); sound.destroy(); }
    };
    return result;
}

function hasPitch(sample, midi) { return sample.notes.some(note => note.midi === midi && note.level > .001); }
function peak(sample) { return Math.max(...sample.levels); }
function close(actual, expected, epsilon = 1e-9) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`); }
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('scheduled lookahead stays dark until the actual output clock reaches oscillator.start()', async () => {
    const f = await fixture();
    try {
        const event = f.sound.instrumentState().voices.find(voice => voice.midi === 60);
        assert.ok(event);
        assert.equal(f.context.oscillators.filter(node => node.starts[0] === event.startTime).length, 6);
        assert.equal(peak(f.instrument.sample()), 0);
        assert.equal(peak(f.advance(.060)), 0, 'The 25 ms output latency must be respected');
        const audible = f.advance(.020);
        assert.ok(hasPitch(audible, 60));
        close(audible.notes[0].age, f.sound.instrumentState().contextTime - event.startTime);
        assert.equal(audible.serial, 1);
    } finally { f.dispose(); }
});

test('a late scheduled note follows its corrected start, not its old score timestamp', async () => {
    const f = await fixture({ main: [[300, 2000, 64, 127]] });
    try {
        assert.equal(f.sound.instrumentState().voices.length, 0);
        f.advance(.500);
        const event = f.sound.instrumentState().voices.find(voice => voice.midi === 64);
        assert.ok(event); close(event.startTime, f.context.currentTime + .002);
        assert.ok(event.at > event.scoreAt + .1);
        assert.equal(peak(f.instrument.sample()), 0);
        assert.equal(peak(f.advance(.020)), 0);
        assert.ok(hasPitch(f.advance(.025), 64));
    } finally { f.dispose(); }
});

test('a note skipped by the audio scheduler never appears merely because it is in the score', async () => {
    const f = await fixture({ main: [[300, 2000, 64, 127]] });
    try {
        const sample = f.advance(1);
        assert.equal(f.sound.instrumentState().voices.length, 0);
        assert.equal(peak(sample), 0);
        assert.equal(sample.serial, 0);
    } finally { f.dispose(); }
});

test('a rendering gap over 250 ms reconstructs the same still-audible release', async () => {
    const f = await fixture();
    try {
        const before = f.advance(.2), id = before.notes[0].id;
        const after = f.advance(1);
        assert.ok(hasPitch(after, 60));
        assert.equal(after.notes[0].id, id);
        assert.ok(after.notes[0].level < before.notes[0].level);
        const continuous = await fixture();
        try {
            for (let i = 0; i < 12; i++) continuous.advance(.1);
            close(peak(after), peak(continuous.instrument.sample()), 1e-10);
        } finally { continuous.dispose(); }
    } finally { f.dispose(); }
});

test('AudioContext suspend/resume preserves voices and release while wall time advances', async () => {
    const f = await fixture();
    try {
        const before = f.advance(.2), generation = before.generation;
        await f.context.suspend();
        const suspended = f.advance(5);
        assert.equal(suspended.running, false); assert.equal(peak(suspended), 0);
        await f.context.resume();
        const resumed = f.instrument.sample();
        assert.equal(resumed.generation, generation);
        assert.equal(resumed.notes[0].id, before.notes[0].id);
        close(peak(resumed), peak(before));
    } finally { f.dispose(); }
});

test('mute cancels pending and sounding voices with stop times, and unmute cannot resurrect them', async () => {
    const f = await fixture({ main: [[0, 2000, 60, 127], [200, 2000, 64, 127]] });
    try {
        f.advance(.120);
        const scheduled = f.sound.instrumentState().voices;
        assert.equal(scheduled.length, 2, 'Fixture must include a future lookahead voice');
        const oldIds = new Set(scheduled.map(voice => voice.id)), oldGeneration = scheduled[0].generation;
        const cancelledAt = f.context.currentTime;
        f.sound.setMuted(true);
        assert.equal(peak(f.instrument.sample()), 0);
        for (const voice of f.sound.instrumentState().voices.filter(voice => oldIds.has(voice.id))) {
            assert.equal(voice.cancelled, true); close(voice.cancelAt, cancelledAt);
            assert.ok(voice.stopTime <= cancelledAt + .05 + 1e-9);
        }
        f.sound.setMuted(false);
        assert.ok(f.sound.instrumentState().generation > oldGeneration);
        const resumed = f.advance(.3);
        assert.ok(resumed.voices.every(voice => !oldIds.has(voice.id)));
        assert.ok(!hasPitch(resumed, 60), 'The old release must not return');
    } finally { f.dispose(); }
});

test('scene seek/pause invalidates voices; restarting creates new actual starts', async () => {
    const f = await fixture();
    try {
        const before = f.advance(.2), oldId = before.notes[0].id;
        f.sound.timelinePause(true); f.instrument.reset();
        assert.equal(peak(f.instrument.sample()), 0);
        f.sound.timelinePause(false);
        assert.equal(peak(f.advance(.1)), 0, 'Resuming a paused score must not revive its old release');
        f.sound.begin(true); f.instrument.reset();
        assert.equal(peak(f.instrument.sample()), 0, 'Restart is still in the output lookahead');
        const replay = f.advance(.1);
        assert.ok(hasPitch(replay, 60)); assert.notEqual(replay.notes[0].id, oldId);
    } finally { f.dispose(); }
});

test('repeated cancellation cannot extend an oscillator or overwrite its original cancellation time', async () => {
    const f = await fixture();
    try {
        f.advance(.2);
        f.sound.setMuted(true);
        const first = f.sound.instrumentState().voices[0];
        const stops = f.context.oscillators.map(node => node.stops.at(-1));
        f.advance(.02);
        f.sound.timelinePause(true);
        const repeated = f.sound.instrumentState().voices.find(voice => voice.id === first.id);
        assert.equal(repeated.cancelAt, first.cancelAt);
        assert.equal(repeated.stopTime, first.stopTime);
        f.context.oscillators.forEach((node, i) => assert.ok(node.stops.at(-1) <= stops[i]));
    } finally { f.dispose(); }
});

test('track changes stop the prior voice while the 46-mouth mapping stays fixed', async () => {
    const f = await fixture({ main: [[0, 2000, 28, 127]], variation: [[0, 2000, 93, 127]] });
    try {
        const main = f.advance(.2); assert.ok(hasPitch(main, 28));
        f.sound.selectTrack('variation');
        assert.equal(peak(f.instrument.sample()), 0);
        const variation = f.advance(.1);
        assert.ok(hasPitch(variation, 93)); assert.ok(!hasPitch(variation, 28));
        assert.equal(variation.low, 28); assert.equal(variation.high, 93);
        assert.equal(variation.pitches.length, 46);
        assert.deepEqual(Array.from(main.pitches), Array.from(variation.pitches));
        assert.equal(variation.levels.length, 66);
    } finally { f.dispose(); }
});

test('volume follows the same gain automation as audio, instead of acting only as an on/off gate', async () => {
    const full = await fixture(), quiet = await fixture();
    try {
        full.advance(.5); quiet.advance(.5);
        quiet.sound.setVolume(.25);
        const a = full.advance(.6), b = quiet.advance(.6), ratio = peak(b) / peak(a);
        assert.ok(ratio > .249 && ratio < .265, `Quarter volume should give a quarter-strength visual, got ${ratio}`);
        assert.ok(quiet.sound.instrumentState().gain < full.sound.instrumentState().gain * .27);
        const id = b.notes[0].id, generation = b.generation;
        quiet.sound.setVolume(0); assert.equal(peak(quiet.instrument.sample()), 0);
        quiet.sound.setVolume(1);
        const restored = quiet.advance(.15);
        assert.equal(restored.generation, generation, 'Volume does not cancel the real voice');
        assert.equal(restored.notes[0].id, id);
        assert.ok(peak(restored) > 0);
    } finally { full.dispose(); quiet.dispose(); }
});

test('finished oscillator releases vanish and reset alone does not erase live voices', async () => {
    const f = await fixture();
    try {
        const before = f.advance(.2); f.instrument.reset();
        close(peak(f.instrument.sample()), peak(before));
        const after = f.advance(8, false);
        assert.equal(peak(after), 0); assert.equal(after.notes.length, 0);
    } finally { f.dispose(); }
});

test('no clock or score-only fallback fabricates notes; layout exists even with no audio', async () => {
    const f = await fixture({ enabled: false });
    try {
        const noLedger = f.instruments.create({ visualState: () => ({ running: true, available: true, position: .1, volume: 1 }), score: () => ({ notes: [[0, 2000, 60, 127]] }) });
        const sample = noLedger.sample();
        assert.equal(peak(sample), 0); assert.equal(sample.running, false);
        assert.equal(sample.low, 28); assert.equal(sample.high, 93); assert.equal(sample.pitches.length, 46);
        assert.equal(peak(f.instrument.sample()), 0);
        noLedger.destroy();
    } finally { f.dispose(); }
});

(async () => {
    let failed = 0;
    for (const [name, run] of tests) {
        try { await run(); console.log('PASS ' + name); }
        catch (error) { failed++; console.error('FAIL ' + name); console.error(error.stack); }
    }
    console.log(`${tests.length - failed}/${tests.length} audio regressions passed`);
    if (failed) process.exitCode = 1;
})();
