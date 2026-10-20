'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseRoute, serializeRoute, normalizeConfig } = require('../src/routes.cjs');
const config = require('../site.config.json');

const route = (overrides = {}) => ({
  view: 'home', format: 'html', uiLang: 'pl', lang: 'pl', hash: '',
  documentLanguageExplicit: false, ...overrides
});
const parse = url => parseRoute(url, config);
const canonical = value => serializeRoute(value, config);

test('home, document directories and legacy no-slash/index.html addresses agree', () => {
  const aliases = {
    home: ['/zloto', '/zloto/', '/zloto/index.html'],
    cv: ['/zloto/cv', '/zloto/cv/', '/zloto/cv/index.html'],
    score: ['/zloto/score', '/zloto/score/', '/zloto/score/index.html']
  };
  for (const [view, urls] of Object.entries(aliases)) for (const url of urls) {
    assert.deepEqual(parse(url), route({ view }), url);
    assert.equal(canonical(parse(url)), '/zloto/' + config.routes[view]);
  }
});

test('legacy query and hash routes produce the same CV document state', () => {
  const expected = route({ view: 'cv', format: 'pdf', uiLang: 'en', lang: 'de', documentLanguageExplicit: true });
  for (const url of [
    '/zloto/?route=cv&lang=en&cvLang=de&format=pdf',
    '/zloto/#/cv?lang=en&cvLang=de&format=pdf',
    '/zloto/index.html?lang=en#/cv?cvLang=de&format=pdf',
    '/zloto/cv/?lang=en&cvLang=de&format=pdf'
  ]) assert.deepEqual(parse(url), expected, url);
  assert.equal(canonical(expected), '/zloto/cv/?lang=en&cvLang=de&format=pdf');
});

test('language comes entirely from the URL, with a configured default', () => {
  assert.deepEqual(parse('/zloto/cv/'), route({ view: 'cv' }));
  assert.deepEqual(parse('/zloto/cv/?lang=en'), route({ view: 'cv', uiLang: 'en', lang: 'en' }));
  assert.deepEqual(parseRoute('/zloto/cv/', { ...config, defaultLanguage: 'de' }), route({ view: 'cv', uiLang: 'de', lang: 'de' }));
});

test('an explicit document language remains explicit even when it equals the UI language', () => {
  const expected = route({ view: 'cv', uiLang: 'en', lang: 'en', documentLanguageExplicit: true });
  assert.deepEqual(parse('/zloto/cv/?lang=en&cvLang=en'), expected);
  assert.equal(canonical(expected), '/zloto/cv/?lang=en&cvLang=en');
  assert.equal(canonical(route({ view: 'cv', documentLanguageExplicit: true })), '/zloto/cv/?cvLang=pl');
});

test('independent document language survives serialization without an explicit flag from a caller', () => {
  const url = canonical(route({ view: 'cv', lang: 'de' }));
  assert.equal(url, '/zloto/cv/?cvLang=de');
  assert.equal(parse(url).documentLanguageExplicit, true);
  assert.equal(parse(url).lang, 'de');
});

test('a known page remains usable with unsupported optional parameter values', () => {
  assert.deepEqual(parse('/zloto/cv/?lang=unsupported&cvLang=unknown&format=docx'), route({ view: 'cv' }));
  assert.deepEqual(parse('/zloto/cv/?lang=en&cvLang=unknown&format=pdf'), route({ view: 'cv', uiLang: 'en', lang: 'en', format: 'pdf' }));
  assert.deepEqual(parse('/zloto/cv/?lang=&cvLang=&format='), route({ view: 'cv' }));
  assert.deepEqual(parse('/zloto/score/?lang=de&cvLang=en'), route({ view: 'score', uiLang: 'de', lang: 'de' }));
});

test('duplicate optional parameters use the first occurrence, including invalid values', () => {
  assert.deepEqual(parse('/zloto/cv/?lang=en&lang=de&format=pdf&format=html'), route({ view: 'cv', uiLang: 'en', lang: 'en', format: 'pdf' }));
  assert.deepEqual(parse('/zloto/cv/?lang=unknown&lang=de&cvLang=en&cvLang=de'), route({ view: 'cv', lang: 'en', documentLanguageExplicit: true }));
});

test('malformed optional query pairs do not prevent a document from loading', () => {
  for (const url of [
    '/zloto/cv/?lang=%ZZ&format=pdf',
    '/zloto/cv/?bad=%E0%A4%A&format=pdf',
    '/zloto/cv/?lang=%00&format=pdf',
    '/zloto/#/cv?lang=%ZZ&format=pdf'
  ]) assert.deepEqual(parse(url), route({ view: 'cv', format: 'pdf' }), url);
  assert.deepEqual(parse('/zloto/#%ZZ'), route());
});

test('home sections retain Unicode, spaces, plus signs and encoded slashes', () => {
  for (const hash of ['o-mnie', 'sekcja źródeł', 'a+b', '/cv', 'a?b#c']) {
    const model = route({ hash, uiLang: 'en', lang: 'en' });
    assert.deepEqual(parse(canonical(model)), model, hash);
  }
  assert.deepEqual(parse('/zloto/#/home?section=sekcja+o+mnie'), route({ hash: 'sekcja o mnie' }));
});

test('tracking parameters are ignored and a relative URL resolves within the deployment base', () => {
  assert.deepEqual(parse('cv/?utm_source=mail&lang=de'), route({ view: 'cv', uiLang: 'de', lang: 'de' }));
  assert.equal(canonical(parse('/zloto/cv/?utm_source=mail')), '/zloto/cv/');
});

test('unknown and outside-prefix paths cannot masquerade as the home page', () => {
  for (const url of [
    '/cv/', '/zloto-other/cv/', '/zloto/unknown/', '/zloto/cv/extra/',
    '/zloto/cv.html', '/zloto//cv/', '/zloto/%2Fcv/', '/zloto/cv/%ZZ',
    '/zloto/%E0%A4%A/', '/zloto/../cv/', '/other/#/cv',
    '/zloto/?route=unknown', '/zloto/#/unknown', '/zloto/#/%ZZ',
    '/zloto/cv/?route=score', '/zloto/cv/#/score',
    'javascript:alert(1)', 'data:text/html,hello'
  ]) assert.equal(parse(url).view, 'not-found', url);
});

test('the same model supports root deployments and alternate preview prefixes', () => {
  for (const basePath of ['/', '/preview/', '/nested/preview/']) {
    const cfg = { ...config, basePath };
    const expected = route({ view: 'cv', format: 'pdf', uiLang: 'de', lang: 'de' });
    const url = serializeRoute(expected, cfg);
    assert.equal(url, basePath + 'cv/?lang=de&format=pdf');
    assert.deepEqual(parseRoute(url, cfg), expected);
    assert.deepEqual(parseRoute('http://127.0.0.1:8123' + url, cfg), expected);
    assert.deepEqual(parseRoute(basePath + 'index.html', cfg), route());
  }
});

test('route directories come from configuration rather than hard-coded physical names', () => {
  const cfg = { ...config, routes: { home: '', cv: 'documents/resume/', score: 'music/' } };
  assert.equal(serializeRoute(route({ view: 'cv' }), cfg), '/zloto/documents/resume/');
  assert.deepEqual(parseRoute('/zloto/documents/resume/index.html', cfg), route({ view: 'cv' }));
  assert.equal(parseRoute('/zloto/cv/', cfg).view, 'not-found');
  assert.deepEqual(parseRoute('/zloto/#/cv', cfg), route({ view: 'cv' }));
});

test('local hash routing preserves the originating file and unrelated query data', () => {
  const fileBase = 'file:///tmp/My%20Portfolio/index.html?debug=1&lang=de&route=score#/home';
  const model = route({ view: 'cv', format: 'pdf', uiLang: 'en', lang: 'en', documentLanguageExplicit: true });
  const url = serializeRoute(model, config, fileBase);
  assert.equal(url, 'file:///tmp/My%20Portfolio/index.html?debug=1#/cv?lang=en&cvLang=en&format=pdf');
  assert.deepEqual(parseRoute(url, config), model);
  const home = route({ hash: 'o-mnie' });
  assert.equal(serializeRoute(home, config, fileBase), 'file:///tmp/My%20Portfolio/index.html?debug=1#/home?section=o-mnie');
  assert.deepEqual(parseRoute(serializeRoute(home, config, fileBase), config), home);
});

test('HTTP and file serialization round-trip every supported view/language/format combination', () => {
  for (const uiLang of config.languages) for (const view of ['home', 'cv', 'score']) {
    const languages = view === 'cv' ? config.languages : [uiLang];
    for (const lang of languages) for (const format of view === 'home' ? ['html'] : ['html', 'pdf']) {
      const explicitOptions = view === 'cv' && lang === uiLang ? [false, true] : [view === 'cv'];
      for (const documentLanguageExplicit of explicitOptions) {
        const model = route({ view, uiLang, lang, format, documentLanguageExplicit, hash: view === 'home' ? 'kontakt' : '' });
        for (const fileBase of [undefined, 'file:///tmp/portfolio.html']) {
          const url = serializeRoute(model, config, fileBase);
          assert.deepEqual(parseRoute(url, config), model, url);
        }
      }
    }
  }
});

test('serialization rejects invalid models instead of generating invalid public links', () => {
  for (const model of [route({ view: 'not-found' }), route({ view: 'missing' }), route({ uiLang: 'xx' }), route({ view: 'cv', lang: 'xx' }), route({ format: 'docx' }), route({ hash: '\u0000' }), route({ documentLanguageExplicit: 'yes' })])
    assert.throws(() => canonical(model), TypeError);
  assert.throws(() => serializeRoute(route(), config, 'https://example.com/index.html'), TypeError);
});

test('configuration is validated once per call and no input object is mutated', () => {
  const original = JSON.stringify(config);
  const model = route({ view: 'cv', uiLang: 'en', lang: 'de', documentLanguageExplicit: true });
  const modelBefore = JSON.stringify(model);
  const normalized = normalizeConfig({ ...config, basePath: '/preview', siteOrigin: config.siteOrigin + '/' });
  assert.equal(normalized.basePath, '/preview/');
  assert.equal(normalized.siteOrigin, config.siteOrigin);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.routes));
  parse(canonical(model));
  assert.equal(JSON.stringify(config), original);
  assert.equal(JSON.stringify(model), modelBefore);
  for (const cfg of [
    { ...config, basePath: 'relative/' }, { ...config, basePath: '/../' },
    { ...config, siteOrigin: 'https://example.com/path/' },
    { ...config, defaultLanguage: 'xx' }, { ...config, languages: ['pl', 'pl'] },
    { ...config, routes: { ...config.routes, cv: 'score/' } },
    { ...config, routes: { ...config.routes, cv: '../cv/' } }
  ]) assert.throws(() => normalizeConfig(cfg), TypeError);
});

test('the exact UMD source runs in a browser-like global without DOM or history', () => {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/routes.cjs'), 'utf8'), context);
  const api = context.GUZICZAK_ROUTES;
  assert.equal(typeof api.parseRoute, 'function');
  assert.equal(typeof api.serializeRoute, 'function');
  assert.equal(api.serializeRoute(api.parseRoute('/zloto/cv/?lang=en&cvLang=en', config), config), '/zloto/cv/?lang=en&cvLang=en');
});
