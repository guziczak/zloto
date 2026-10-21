'use strict';

// Exercise the production exhibit passes and rotor. The GL recorder verifies
// resource ownership and resolve ordering; native EGL renders verify pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(script => script.includes('A tiny, local module container'));
const boot = source?.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Load the actual modules without booting the browser application');
const context = vm.createContext({ atob, btoa, console, innerWidth: 390, innerHeight: 844,
  devicePixelRatio: 2, GUZICZAK_I18N: { t: key => key } });
vm.runInContext(source.slice(0, boot), context, { filename: 'index.html:exhibit-quality' });
const modules = context.GuziczakModules;
const initialPose = modules.get('ui/exhibit').initialPose;
const shaders = modules.get('render/atelier-shaders');

function fixture({ hdr = true, colorSamples = [8, 4, 2], depthSamples = [4, 2], incomplete = false } = {}) {
  let next = 1, read = null, draw = null, renderbuffer = null, program = null;
  const events = [], queries = [], allocated = [], deleted = new Set(), multisample = new Set();
  const region = { x: 0, y: 0, width: 390, height: 844 };
  const raw = { drawingBufferWidth: 780, drawingBufferHeight: 1688,
    FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9,
    RENDERBUFFER: 0x8d41, FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
    COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
    RGBA16F: 0x881a, RGBA8: 0x8058, DEPTH_COMPONENT24: 0x81a6,
    getParameter: () => 8192,
    getExtension: name => name === 'EXT_color_buffer_float' && hdr ? {} : null,
    getInternalformatParameter(target, format) {
      queries.push(format);
      assert.equal(target, gl.RENDERBUFFER);
      return Int32Array.from(format === gl.DEPTH_COMPONENT24 ? depthSamples : colorSamples);
    },
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    getUniformLocation: (object, name) => ({ object, name }),
    shaderSource(shader, text) { shader.source = text; },
    attachShader(object, shader) { (object.shaders ||= []).push(shader); },
    useProgram(object) { program = object; },
    bindFramebuffer(target, object) {
      if (target === gl.FRAMEBUFFER || target === gl.READ_FRAMEBUFFER) read = object;
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) draw = object;
    },
    bindRenderbuffer(_target, object) { renderbuffer = object; },
    renderbufferStorage(_target, format, width, height) {
      Object.assign(renderbuffer, { format, width, height, samples: 0 });
    },
    renderbufferStorageMultisample(_target, samples, format, width, height) {
      Object.assign(renderbuffer, { format, width, height, samples });
      multisample.add(draw);
    },
    framebufferRenderbuffer(_target, attachment, _kind, object) {
      (draw.attachments ||= new Map()).set(attachment, object);
    },
    framebufferTexture2D(_target, attachment, _kind, object) {
      (draw.attachments ||= new Map()).set(attachment, object);
    },
    checkFramebufferStatus() {
      return incomplete && multisample.has(draw) ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : gl.FRAMEBUFFER_COMPLETE;
    },
    blitFramebuffer(...args) { events.push({ type: 'blit', source: read, target: draw, args }); },
    drawArrays(mode, start, count) { events.push({ type: 'draw', target: draw, program, mode, start, count }); }
  };
  const gl = new Proxy(raw, { get(target, key) {
    if (key in target) return target[key];
    if (/^[A-Z][A-Z0-9_]*$/.test(String(key))) return target[key] = 0x10000 + next++;
    if (/^create/.test(String(key))) return target[key] = () => {
      const object = { id: next++, kind: key.slice(6) }; allocated.push(object); return object;
    };
    if (/^delete/.test(String(key))) return target[key] = object => {
      if (!object) return;
      assert(!deleted.has(object), `Resource ${object.kind}/${object.id} is released once`);
      deleted.add(object);
    };
    if (/^uniform/.test(String(key))) return target[key] = (location, ...values) => {
      for (const value of values) {
        if (typeof value === 'boolean') continue;
        assert((Array.isArray(value) || ArrayBuffer.isView(value))
          ? Array.from(value).every(Number.isFinite) : Number.isFinite(value),
        `${location.name} receives finite values`);
      }
    };
    return target[key] = () => {};
  } });
  const canvas = { width: 780, height: 1688, parentElement: { getBoundingClientRect: () => region } };
  const claims = [];
  const device = { gl, claimSurface(width, height, owner) {
    claims.push({ width, height, owner });
    canvas.width = gl.drawingBufferWidth = width; canvas.height = gl.drawingBufferHeight = height;
  }, surface: () => ({ width: canvas.width, height: canvas.height, owner: 'exhibit' }) };
  const meshes = modules.get('geometry/brand').create(gl);
  const exhibit = modules.get('render/exhibit').create(device, meshes, canvas);
  const rect = { x: 66, y: 380, w: 258, h: 263 };
  const render = (overlay = false) => exhibit.render(rect, initialPose.yaw, initialPose.pitch, overlay, 1, 2);
  return { gl, exhibit, render, region, events, queries, allocated, deleted, multisample, claims };
}

function assertReleased(f, targets) {
  for (const target of targets) {
    assert(f.deleted.has(target), 'The multisample framebuffer is released');
    for (const buffer of target.attachments.values()) assert(f.deleted.has(buffer), 'Both multisample attachments are released');
  }
}

test('opaque exhibit uses supported 4x samples and resolves color plus depth before water', () => {
  const f = fixture();
  try {
    f.render();
    assert.deepEqual(f.queries, [f.gl.RGBA16F, f.gl.DEPTH_COMPONENT24]);
    const stats = f.exhibit.stats();
    assert.equal(stats.samples, 4);
    assert.deepEqual([stats.width, stats.height], [780, 1688], 'Antialiasing keeps the existing DPR and pixel budget');
    const copies = f.events.filter(event => event.type === 'blit');
    assert.equal(copies.length, 2, 'One opaque resolve precedes the existing water-base copy');
    const [resolve, waterCopy] = copies;
    assert(f.multisample.has(resolve.source));
    for (const attachment of resolve.source.attachments.values()) {
      assert.equal(attachment.samples, 4);
      assert.deepEqual([attachment.width, attachment.height], [780, 1688]);
    }
    assert.equal(waterCopy.source, resolve.target, 'Water copies the resolved opaque color and depth');
    assert.deepEqual(resolve.args, [0, 0, 780, 1688, 0, 0, 780, 1688,
      f.gl.COLOR_BUFFER_BIT | f.gl.DEPTH_BUFFER_BIT, f.gl.NEAREST]);
    const water = f.events.find(event => event.type === 'draw' && event.program.shaders.some(shader => shader.source === shaders.waterFS));
    assert(f.events.indexOf(water) > f.events.indexOf(waterCopy));
    assert.equal(water.target, resolve.target, 'Water stays single-sample and depth-tested against the resolved opaque target');
    f.events.length = 0;
    const claims = f.claims.length;
    f.render(true);
    assert.equal(f.claims.length, claims, 'The cinematic overlay never resizes the shared drawing surface');
    assert.equal(f.events.filter(event => event.type === 'blit').length, 1, 'The transparent handoff also resolves the silhouette');
  } finally { f.exhibit.destroy(); }
  assertReleased(f, f.multisample);
});

test('sample selection intersects depth support, handles LDR and preserves unsupported fallback', () => {
  for (const options of [
    { hdr: false, colorSamples: [8, 4, 2], depthSamples: [2], expected: 2 },
    { hdr: true, colorSamples: [4], depthSamples: [2], expected: 1 },
    { hdr: false, colorSamples: [], depthSamples: [4], expected: 1 }
  ]) {
    const f = fixture(options);
    try {
      f.render();
      assert.deepEqual(f.queries, [options.hdr ? f.gl.RGBA16F : f.gl.RGBA8, f.gl.DEPTH_COMPONENT24]);
      assert.equal(f.exhibit.stats().samples, options.expected);
      assert.equal(f.multisample.size, options.expected > 1 ? 1 : 0);
      assert.equal(f.events.filter(event => event.type === 'blit').length, options.expected > 1 ? 2 : 1);
    } finally { f.exhibit.destroy(); }
    assertReleased(f, f.multisample);
  }
});

test('an incomplete multisample framebuffer falls back and releases every attempted attachment', () => {
  const f = fixture({ incomplete: true });
  try {
    f.render();
    assert.equal(f.exhibit.stats().samples, 1);
    assert.equal(f.multisample.size, 1, 'The supported allocation is attempted once');
    assertReleased(f, f.multisample);
    assert(f.events.filter(event => event.type === 'draw').every(event => !f.multisample.has(event.target)));
    assert.equal(f.events.filter(event => event.type === 'blit').length, 1, 'Fallback still provides the opaque water-base copy');
  } finally { f.exhibit.destroy(); }
});

test('resize, suspend and reactivation release and recreate the extra attachments', () => {
  const f = fixture();
  try {
    f.render(); const first = [...f.multisample];
    f.region.height = 740; f.render();
    assertReleased(f, first);
    assert.equal(f.exhibit.stats().height, 1480);
    assert.equal(f.multisample.size, 2);
    f.exhibit.suspend();
    assertReleased(f, f.multisample);
    assert.equal(f.exhibit.stats().samples, 1);
    assert.equal(f.exhibit.stats().width, 0);
    f.render();
    assert.equal(f.exhibit.stats().samples, 4);
    assert.equal(f.exhibit.stats().suspended, false);
    assert.equal(f.multisample.size, 3);
  } finally { f.exhibit.destroy(); }
  assertReleased(f, f.multisample);
});

test('the readable initial pose retains unlimited vertical-axis drag and paused manual control', () => {
  assert(Math.abs(initialPose.yaw) < Math.PI / 6, 'The first view shows the front with a small depth-revealing angle');
  assert.equal(initialPose.pitch, 0);
  const rotor = modules.get('interaction/rotor').create(initialPose, { paused: true });
  const advance = seconds => { for (let i = 0; i < seconds * 60; i++) rotor.step(1 / 60); };
  advance(5); assert.equal(rotor.snapshot().yaw, initialPose.yaw, 'Pause stops automatic rotation');
  rotor.grab();
  for (let i = 0; i < 300; i++) { rotor.move(.055); rotor.step(1 / 60); }
  const dragged = rotor.snapshot();
  assert(dragged.yaw - initialPose.yaw > Math.PI * 2, 'Manual rotation crosses a complete turn without an angle clamp');
  assert.equal(dragged.pitch, 0);
  rotor.release(); advance(3);
  rotor.nudge(.18, 10); advance(3);
  assert.equal(rotor.snapshot().pitch, 0, 'The compatibility pitch argument cannot tilt the emblem');
  assert.equal(rotor.snapshot().pitchVelocity, 0);
});

test('reduced motion stays still, supports deliberate input and full automatic turns remain available', () => {
  const rotors = modules.get('interaction/rotor');
  const reduced = rotors.create(initialPose, { paused: true, reducedMotion: true });
  for (let i = 0; i < 600; i++) reduced.step(1 / 60);
  assert.equal(reduced.snapshot().yaw, initialPose.yaw);
  reduced.grab(); reduced.move(.2); reduced.release();
  const moved = reduced.snapshot().yaw;
  assert(moved > initialPose.yaw);
  for (let i = 0; i < 600; i++) reduced.step(1 / 60);
  assert.equal(reduced.snapshot().yaw, moved, 'Reduced motion adds no inertia after manual input');
  const automatic = rotors.create(initialPose);
  for (let i = 0; i < 45 * 60; i++) automatic.step(1 / 60);
  assert(automatic.snapshot().yaw - initialPose.yaw > Math.PI * 2, 'Automatic presentation still includes the entire back and profile');
  assert.equal(automatic.snapshot().pitch, 0);
});
