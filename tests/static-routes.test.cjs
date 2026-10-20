'use strict';

// Exercise the generated files through HTTP without a single-page-app rewrite.
// This is a strict local file host, not a claim about the deployed CDN's headers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { build } = require('../scripts/build.cjs');

const rootDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'site.config.json'), 'utf8'));
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3] ?? match[4] ?? '')]));
}
function tags(html, name) {
  return [...html.matchAll(new RegExp('<' + name + '\\b([^>]*)>', 'gi'))].map(match => attributes(match[1]));
}
function byId(html, tag, id) {
  const matches = tags(html, tag).filter(attrs => attrs.id === id);
  assert.equal(matches.length, 1, tag + '#' + id + ' exists exactly once');
  return matches[0];
}
function has(attrs, name) { return Object.hasOwn(attrs, name); }
function realLinks(html) {
  return tags(html, 'a').map(attrs => attrs.href).filter(Boolean);
}
function absoluteDocument(relative) { return new URL(relative, config.documentOrigin).href; }

function staticHost(directory) {
  const basePath = config.basePath;
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { response.writeHead(400).end('Bad path'); return; }
    if (!pathname.startsWith(basePath)) { response.writeHead(404).end('Not found'); return; }
    const relative = pathname.slice(basePath.length);
    let file = path.resolve(directory, relative);
    if (file !== directory && !file.startsWith(directory + path.sep)) { response.writeHead(404).end('Not found'); return; }
    let stat;
    try { stat = fs.statSync(file); }
    catch { response.writeHead(404).end('Not found'); return; }
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(301, { Location: url.pathname + '/' + url.search }).end();
        return;
      }
      file = path.join(file, 'index.html');
      try { stat = fs.statSync(file); }
      catch { response.writeHead(404).end('Not found'); return; }
    }
    if (!stat.isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
}

async function withSite(run) {
  const scratch = fs.mkdtempSync(path.join(rootDir, '.static-routes-test-'));
  const outputDir = path.join(scratch, 'published');
  let server;
  try {
    await build({ rootDir, outputDir });
    server = staticHost(outputDir);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    await run({ outputDir, scratch, origin, get: relative => fetch(origin + config.basePath + relative, { redirect: 'manual' }) });
  } finally {
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('published home, CV and score have real HTTP entrypoints, including query variants', async () => {
  await withSite(async ({ get }) => {
    for (const relative of ['', 'cv/', 'score/', 'cv/?lang=de&cvLang=en&format=pdf', 'score/?lang=en&format=pdf']) {
      const response = await get(relative);
      assert.equal(response.status, 200, relative + ' exists without a client router');
      assert.match(response.headers.get('content-type'), /^text\/html\b/);
      assert.match(await response.text(), /<!doctype html>/i);
    }
    for (const view of ['cv', 'score']) {
      const response = await get(view + '?lang=en&format=pdf');
      assert.equal(response.status, 301);
      assert.equal(response.headers.get('location'), config.basePath + view + '/?lang=en&format=pdf', 'directory normalization retains parameters');
      const destination = await get(view + '/?lang=en&format=pdf');
      assert.equal(destination.status, 200);
    }
    for (const relative of ['missing-route/', 'cv/missing-child/', 'missing-asset.js']) {
      const response = await get(relative);
      assert.equal(response.status, 404, relative + ' must not silently serve the portfolio');
    }
  });
});

test('entrypoint HTML selects its visible main and carries correct initial metadata', async () => {
  await withSite(async ({ get }) => {
    const views = [
      { path: '', active: 'site', title: /GUZICZAK/, view: 'home' },
      { path: 'cv/', active: 'cv-view', title: /Curriculum vitae|CV/i, view: 'cv' },
      { path: 'score/', active: 'score-view', title: /Lux in tenebris|Partytura/i, view: 'score' }
    ];
    for (const item of views) {
      const html = await (await get(item.path)).text();
      const canonical = tags(html, 'link').filter(attrs => attrs.rel === 'canonical');
      assert.equal(canonical.length, 1, item.path + ' has one canonical');
      const expected = new URL(config.basePath + item.path, config.siteOrigin).href;
      assert.equal(canonical[0].href, expected, 'canonical identifies the current public route');
      assert.equal(tags(html, 'meta').find(attrs => attrs.property === 'og:url')?.content, expected);
      assert.match(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', item.title);
      if (item.view !== 'home') assert.equal(tags(html, 'body')[0]?.['data-view'], item.view);
      for (const id of ['site', 'cv-view', 'score-view']) {
        const attrs = byId(html, 'main', id);
        assert.equal(has(attrs, 'hidden'), id !== item.active, id + ' initial visibility');
        assert.equal(has(attrs, 'inert'), id !== item.active, id + ' initial interactivity');
      }
      const skip = tags(html, 'a').find(attrs => (attrs.class || '').split(/\s+/).includes('skip-content'));
      assert.equal(skip?.href, item.view === 'home' ? '#hero-heading' : '#' + item.view + '-title', 'skip link targets the currently visible document heading');
      const languageAlternates = tags(html, 'link').filter(attrs => attrs.rel === 'alternate' && attrs.hreflang);
      assert(languageAlternates.length >= config.languages.length, 'language metadata remains present');
      for (const alternate of languageAlternates) {
        const address = new URL(alternate.href);
        assert.equal(address.origin, config.siteOrigin);
        assert.equal(address.pathname, config.basePath + item.path, 'alternate language stays on the same view');
      }
    }
  });
});

test('ordinary links work without JavaScript and hosted originals remain available as fallbacks', async () => {
  await withSite(async ({ get }) => {
    for (const relative of ['', 'cv/', 'score/']) {
      const html = await (await get(relative)).text();
      assert.equal(byId(html, 'a', 'nav-cv').href, config.basePath + 'cv/');
      const links = realLinks(html);
      if (relative) {
        const backId = relative === 'cv/' ? 'cv-back' : 'score-back';
        const backHref = byId(html, 'a', backId).href;
        assert(backHref.startsWith(config.basePath), 'Back to website is a real homepage link, not a hash on the document route');
        assert.equal(new URL(backHref, config.siteOrigin).pathname, config.basePath);
        assert.match(html, /<noscript>[\s\S]*class="document-static-fallback"/, 'document includes a no-JavaScript fallback');
      }
      if (relative === 'cv/') {
        for (const language of config.languages) {
          assert(links.includes(absoluteDocument(config.documents.cv[language].html)), 'ordinary ' + language + ' HTML CV fallback link');
          assert(links.includes(absoluteDocument(config.documents.cv[language].pdf)), 'ordinary ' + language + ' PDF fallback link');
        }
      }
      if (relative === 'score/') {
        assert(links.includes(absoluteDocument(config.documents.score.html)), 'ordinary score image link');
        assert(links.includes(absoluteDocument(config.documents.score.pdf)), 'ordinary score PDF link');
      }
      // An emitted root-relative link must be a real site route, never a clean
      // client-only URL that leads back to the original direct-load regression.
      for (const href of links.filter(value => value.startsWith(config.basePath))) {
        const address = new URL(href, 'http://local.test');
        assert(['', 'cv/', 'score/'].includes(address.pathname.slice(config.basePath.length)), 'known published href: ' + href);
      }
    }
  });
});

test('build output is deterministic and rebuilding generated HTML does not accumulate injections', async () => {
  await withSite(async ({ outputDir, scratch }) => {
    const names = ['index.html', 'cv/index.html', 'score/index.html', '.nojekyll'];
    const first = new Map(names.map(name => [name, fs.readFileSync(path.join(outputDir, name))]));
    const repeated = path.join(scratch, 'repeated');
    await build({ rootDir, outputDir: repeated });
    for (const name of names) assert.deepEqual(fs.readFileSync(path.join(repeated, name)), first.get(name), name + ' is deterministic');
    fs.mkdirSync(path.join(outputDir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(rootDir, 'src/routes.cjs'), path.join(outputDir, 'src/routes.cjs'));
    fs.copyFileSync(path.join(rootDir, 'site.config.json'), path.join(outputDir, 'site.config.json'));
    const rebuilt = path.join(scratch, 'rebuilt');
    await build({ rootDir: outputDir, outputDir: rebuilt });
    for (const name of names) assert.deepEqual(fs.readFileSync(path.join(rebuilt, name)), first.get(name), name + ' is idempotent from generated input');
  });
});
