'use strict';

// Exercise the actual inline modules and packed pouring-well geometry. No DOM or GPU mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const main = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .find(match => match[1].includes('A tiny, local module container'))?.[1];
const boot = main?.indexOf("(function () {\n    'use strict';\n    let player;");
assert(boot > 0, 'Application module boundary must be present');
const context = vm.createContext({ atob, btoa, console, window: {}, document: {},
  GUZICZAK_I18N: { t: key => key } });
vm.runInContext(main.slice(0, boot), context);
const modules = context.GuziczakModules;
const liquid = modules.get('scene/cast-liquid');
const hydraulics = modules.get('scene/hydraulics');
const { M } = modules.get('math');
const close = (a, b, tolerance = 1e-10) => assert(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('the jet follows the actual triangulated well surface as it fills', () => {
  const { contact, config } = liquid;
  close(contact.reduce((sum, v) => sum + v.weight, 0), 1);
  close(contact.reduce((sum, v) => sum + v.weight * v.x, 0), config.wellX);
  close(contact.reduce((sum, v) => sum + v.weight * v.z, 0), config.wellZ);
  for (const vertex of contact) {
    assert(vertex.uv > 0, 'The actual arrival UV is not the well-centre coordinate');
    assert(vertex.edge >= .035, 'The contact triangle must be outside the wall meniscus');
    assert(Math.hypot(vertex.x - config.wellX, vertex.z - config.wellZ) < config.quietRadius,
      'The contact triangle must lie inside the quiet, undisplaced impact patch');
  }
  let previous = config.floor;
  for (let t = 9.0; t <= 12.57; t += .007) {
    const level = liquid.contactLevel(t);
    assert(level >= previous - 1e-12, 'The surface must never recede during filling');
    assert(level >= config.floor - 1e-12 && level <= config.top + 1e-12);
    close(level, contact.reduce((sum, v) => sum + v.weight * liquid.levelAt(t, v.uv), 0));
    previous = level;
  }
  close(liquid.contactLevel(9.0), config.floor);
  close(liquid.contactLevel(11.62), config.top);
});

test('the stream uses the reservoir discharge and carries it down the falling column', () => {
  for (let t = 8.8; t < 12; t += .013) close(liquid.flowAt(t), hydraulics.sample(t).flow);
  const from = [0, -1.681, -.62], to = [0, -2.0756, -.62];
  assert.deepEqual(Array.from(liquid.streamPoint(from, to, 0)), from);
  assert.deepEqual(Array.from(liquid.streamPoint(from, to, 1)), to);
  let last = from[1], speed = 0;
  for (let s = .05; s <= 1.000001; s += .05) {
    const y = liquid.streamPoint(from, to, s)[1], fall = last - y;
    assert(fall >= speed - 1e-10, 'Gravity must increase vertical speed');
    assert(y >= to[1] - 1e-12 && y <= from[1]);
    last = y; speed = fall;
  }
  const top = liquid.streamRadius(10.35, 0), bottom = liquid.streamRadius(10.35, 1);
  assert(bottom / top > .60 && bottom / top < .85, 'Steady flow should narrow gently under gravity');
  for (let t = 9.2; t < 11.55; t += .013) {
    for (const s of [0, .25, .5, .75, 1]) {
      const radius = liquid.streamRadius(t, s);
      assert(Number.isFinite(radius) && radius > 0 && radius < .061);
    }
  }
});

test('foundry draw commands meet the rising surface and carry each final gold material', () => {
  const foundry = modules.get('scene/foundry');
  const meshes = Object.fromEntries(['flask', 'sand', 'goldStream', 'dropGold', 'meltFeed', 'meltA', 'meltB'].map(name => [name, name]));
  for (const t of [9.5, 10.0, 10.5, 11.4]) {
    const commands = [];
    const result = foundry.sample({ t, state: { stage: 1 }, meshes, cartridge: M.I(),
      push: (mesh, pose, mode, from, to, transparent, light, begin, end) => commands.push({ mesh, pose, mode, from, to, begin, end }) });
    const stream = commands.find(command => command.mesh === 'goldStream');
    assert(stream && stream.begin < stream.end);
    const expected = M.point(result.moldRoot, [liquid.config.wellX, liquid.contactLevel(t), liquid.config.wellZ]);
    stream.to.forEach((value, i) => close(value, expected[i], 1e-7));
    for (const [mesh, material] of [['meltFeed', 1], ['meltA', 12], ['meltB', 13]]) {
      const draw = commands.find(command => command.mesh === mesh);
      assert.equal(draw.mode, 5);
      assert.equal(draw.from[0], material);
    }
  }
});

test('the drain, ripples and heat settle before the cold geometry takes over', () => {
  const end = liquid.streamInterval(liquid.config.streamStop + liquid.config.flight + .001);
  assert.equal(end.begin, end.end, 'No residual stream can remain after the last flight');
  close(liquid.flowAt(11.56), 0);
  close(liquid.flowAt(11.86 - liquid.config.flight), 0);
  assert(liquid.hotAt(11.62) > .99);
  assert.equal(liquid.hotAt(12.52), 0);
  assert.equal(liquid.hotAt(12.569999), 0, 'Reclaim must hold a fully cold casting');
  assert.equal(liquid.hotAt(12.57), 0);
  close(liquid.contactLevel(12.569999), liquid.contactLevel(12.57));
});
