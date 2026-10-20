'use strict';

// Execute the production bootstrap, localization and router against the actual
// HTML controls. Only browser facilities and document media are substituted.
// This does not validate browser layout, embedded PDF rendering or native focus.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const routeSource = fs.readFileSync(path.join(root, 'src/routes.cjs'), 'utf8');
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function attributes(source) {
  return [...source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map(match => [match[1], decode(match[2] ?? match[3] ?? match[4] ?? '')]);
}

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, capture: options === true || !!options?.capture, once: !!options?.once });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener.callback !== callback));
  }
  dispatchEvent(event, capture) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      if (capture !== undefined && listener.capture !== capture) continue;
      listener.callback.call(this, event);
      if (listener.once) this.removeEventListener(event.type, listener.callback);
    }
    return !event.defaultPrevented;
  }
}
class EventFixture {
  constructor(type, values = {}) { Object.assign(this, { type, defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, values); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
  remove() { this.parentNode?.removeChild(this); }
}
class Element extends Target {
  constructor(tag, doc) {
    super(); this.tagName = tag.toUpperCase(); this.nodeType = 1; this.ownerDocument = doc;
    this.childNodes = []; this.parentNode = null; this.attrs = new Map(); this.dataset = {};
    this.hidden = false; this.inert = false; this.className = ''; this.value = '';
    this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; }, removeProperty(name) { delete this[name]; } };
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: name => classes().includes(name),
      add: (...names) => { this.className = [...new Set([...classes(), ...names])].join(' '); },
      remove: (...names) => { this.className = classes().filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const on = force === undefined ? !classes().includes(name) : !!force; on ? this.classList.add(name) : this.classList.remove(name); return on; }
    };
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new TextNode(String(value))); }
  get href() { const value = this.getAttribute('href'); return value === null ? '' : new URL(value, this.ownerDocument.defaultView.location.href).href; }
  set href(value) { this.setAttribute('href', value); }
  get target() { return this.getAttribute('target') || ''; }
  set target(value) { this.setAttribute('target', value); }
  get hreflang() { return this.getAttribute('hreflang') || ''; }
  get content() { return this.getAttribute('content') || ''; }
  set content(value) { this.setAttribute('content', value); }
  get lang() { return this.getAttribute('lang') || ''; }
  set lang(value) { this.setAttribute('lang', value); }
  get firstChild() { return this.childNodes[0] || null; }
  setAttribute(name, value) {
    value = String(value); this.attrs.set(name, value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    if (name === 'class') this.className = value;
    if (name === 'hidden' || name === 'inert') this[name] = true;
    if (name === 'value') this.value = value;
  }
  getAttribute(name) { return name === 'class' ? this.className : this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { this.attrs.delete(name); if (name === 'hidden' || name === 'inert') this[name] = false; }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') node = new TextNode(node);
      node.parentNode?.removeChild(node); node.parentNode = this; this.childNodes.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const excluded = [...part.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      if (excluded.some(value => this.matches(value))) return false;
      part = part.replace(/:not\([^)]+\)/g, '');
      const chain = part.split(/\s+/);
      if (chain.length > 1) {
        if (!this.matches(chain.pop())) return false;
        let parent = this.parentNode;
        while (parent?.nodeType === 1) { if (parent.matches(chain.join(' '))) return true; parent = parent.parentNode; }
        return false;
      }
      const attrs = [...part.matchAll(/\[([\w-]+)(?:=['"]?([^\]'" ]+)['"]?)?\]/g)];
      const plain = part.replace(/\[[^\]]*\]/g, '');
      const tag = plain.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = plain.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      if ([...plain.matchAll(/\.([\w-]+)/g)].some(match => !this.classList.contains(match[1]))) return false;
      return attrs.every(match => this.hasAttribute(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]));
    });
  }
  querySelectorAll(selector) {
    const nodes = [];
    for (const child of this.children) { if (child.matches(selector)) nodes.push(child); nodes.push(...child.querySelectorAll(selector)); }
    return nodes;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node?.nodeType === 1) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.ownerDocument.defaultView.lastScrollTarget = this.id; }
  getBoundingClientRect() { return { top: 200, bottom: 600, left: 0, width: 1000, height: 400 }; }
  click() { return this.ownerDocument.defaultView.clickElement(this); }
}

function parseDocument(source) {
  const doc = new Target();
  const holder = new Element('document', doc), stack = [holder];
  const voids = new Set(['meta', 'link', 'br', 'input', 'hr', 'img', 'source', 'area', 'base', 'embed', 'param', 'wbr']);
  const tokens = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<!--[\s\S]*?-->|<![^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)\b([^>]*?)\/?>|([^<]+)/gi;
  for (const token of source.matchAll(tokens)) {
    if (token[1]) {
      const node = new Element(token[1], doc);
      for (const [name, value] of attributes(token[2])) node.setAttribute(name, value);
      node.textContent = token[3]; stack.at(-1).append(node);
    } else if (token[4]) {
      const index = stack.findLastIndex(node => node.tagName === token[4].toUpperCase());
      if (index > 0) stack.length = index;
    } else if (token[5]) {
      const node = new Element(token[5], doc);
      for (const [name, value] of attributes(token[6])) node.setAttribute(name, value);
      stack.at(-1).append(node);
      if (!voids.has(token[5].toLowerCase()) && !token[0].endsWith('/>')) stack.push(node);
    } else if (token[7]) stack.at(-1).append(new TextNode(decode(token[7])));
  }
  doc.documentElement = holder.querySelector('html');
  doc.head = holder.querySelector('head'); doc.body = holder.querySelector('body'); doc.activeElement = doc.body;
  doc.querySelectorAll = selector => holder.querySelectorAll(selector);
  doc.querySelector = selector => holder.querySelector(selector);
  doc.getElementById = id => holder.querySelector('#' + id);
  doc.createElement = tag => new Element(tag, doc);
  doc.createTextNode = value => new TextNode(value);
  doc.title = doc.querySelector('title').textContent;
  return doc;
}

function environment(relative, storedLanguage = 'de') {
  const doc = parseDocument(html), win = new Target();
  const frames = new Map(), timers = new Map(); let sequence = 0;
  const initial = new URL(relative, config.siteOrigin + config.basePath);
  let address = initial, cursor = 0;
  const entries = [{ url: address.href, state: null }], assignments = [], engineCalls = [], scoreCalls = [];
  const storage = new Map([['guziczak.language.v1', storedLanguage]]);
  const location = {};
  for (const key of ['href', 'origin', 'pathname', 'search', 'hash', 'protocol']) Object.defineProperty(location, key, { get: () => address[key] });
  location.assign = value => assignments.push(new URL(value, address).href);
  location.replace = value => assignments.push(new URL(value, address).href);
  const history = {
    get state() { return entries[cursor].state; },
    get length() { return entries.length; },
    pushState(state, _unused, url) { address = new URL(url, address); entries.splice(cursor + 1); entries.push({ state: structuredClone(state), url: address.href }); cursor++; },
    replaceState(state, _unused, url) { address = new URL(url, address); entries[cursor] = { state: structuredClone(state), url: address.href }; },
    go(delta) { const next = cursor + delta; if (next < 0 || next >= entries.length) return; cursor = next; address = new URL(entries[cursor].url); win.dispatchEvent(new EventFixture('popstate', { state: entries[cursor].state })); },
    back() { this.go(-1); }, forward() { this.go(1); }
  };
  Object.assign(win, {
    console, URL, URLSearchParams, TextDecoder, TextEncoder, Blob, AbortController, DOMException,
    document: doc, location, history, Node: { TEXT_NODE: 3 }, Element, Event: EventFixture, CustomEvent: EventFixture,
    navigator: { onLine: false, pdfViewerEnabled: true },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    innerWidth: 1440, innerHeight: 900, scrollX: 0, scrollY: 0,
    setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    scrollTo: position => { win.scrollX = position.left || 0; win.scrollY = position.top || 0; },
    matchMedia: () => Object.assign(new Target(), { matches: false }),
    fetch: () => { throw Error('Router integration fixture must not make network requests'); },
    GUZICZAK_SITE_CONFIG: structuredClone(config),
    GUZICZAK_SCORE: { hide: () => scoreCalls.push('hide'), show: format => scoreCalls.push(format), diagnostics: () => ({ simulated: true }) },
    GUZICZAK_PDF_FIT: { resize() {}, fragment: '#view=Fit' },
    GUZICZAK_CV_LANGUAGE: { close() {}, sync() {} },
    __GUZICZAK: { skip: () => engineCalls.push('skip'), setRouteSuspended: value => engineCalls.push(value) }
  });
  win.window = win; doc.defaultView = win;
  win.clickElement = (element, values = {}) => {
    const event = new EventFixture('click', { target: element, ...values });
    doc.dispatchEvent(event, true);
    if (!event.stopped) element.dispatchEvent(event);
    if (!event.stopped) doc.dispatchEvent(event, false);
    return event;
  };
  const context = vm.createContext(win);
  vm.runInContext(routeSource, context, { filename: 'src/routes.cjs' });
  for (const id of ['cv-spa-boot', 'site-i18n']) {
    const script = doc.getElementById(id); assert(script, 'production script #' + id);
    vm.runInContext(script.textContent, context, { filename: 'index.html#' + id });
  }
  win.GUZICZAK_I18N.mount();
  vm.runInContext(doc.getElementById('cv-spa-router').textContent, context, { filename: 'index.html#cv-spa-router' });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); };
  flush();
  return { win, doc, history, entries, assignments, engineCalls, scoreCalls, flush,
    click: (id, values) => win.clickElement(doc.getElementById(id), values),
    hashChange: hash => {
      const oldURL = address.href;
      address = new URL(address); address.hash = hash;
      entries.splice(cursor + 1); entries.push({ url: address.href, state: null }); cursor++;
      win.dispatchEvent(new EventFixture('hashchange', { oldURL, newURL: address.href }));
      flush();
    },
    state: () => win.GUZICZAK_ROUTER.diagnostics(),
    url: () => new URL(location.href) };
}

test('a direct URL controls UI and document languages independently of saved preferences', () => {
  const explicit = environment('cv/?lang=pl&cvLang=en&format=pdf', 'de');
  assert.equal(explicit.state().uiLanguage, 'pl');
  assert.equal(explicit.state().language, 'en');
  assert.equal(explicit.state().documentLanguageExplicit, true);
  assert.equal(explicit.state().format, 'pdf');
  assert.equal(explicit.doc.documentElement.lang, 'pl');
  assert.equal(explicit.doc.activeElement.id, 'cv-title');
  assert.equal(explicit.win.GUZICZAK_SPA_BOOT.cv, true, 'document entry disables cinematic startup');
  const canonical = new URL(explicit.doc.querySelector('link[rel=canonical]').href);
  assert.equal(canonical.pathname, config.basePath + 'cv/');
  assert.equal(canonical.searchParams.get('cvLang'), 'en');
  assert.equal(canonical.searchParams.has('format'), false);
  assert.equal(explicit.doc.querySelector('meta[property="og:url"]').content, canonical.href);
  assert.equal(explicit.doc.title, config.pages.cv.pl.title + ' · PDF');
  assert.equal(explicit.doc.querySelector('meta[name="description"]').content, config.pages.cv.pl.description);
  const fresh = environment('cv/', 'en');
  assert.equal(fresh.state().uiLanguage, config.defaultLanguage);
  assert.equal(fresh.state().language, config.defaultLanguage);
  assert.equal(fresh.state().documentLanguageExplicit, false);
  const german = environment('cv/?lang=de', 'en');
  assert.equal(german.state().uiLanguage, 'de');
  assert.equal(german.state().language, 'de');
});

test('changing UI language preserves an explicitly selected CV language, including equal-to-UI choices', () => {
  for (const documentLanguage of ['en', 'pl']) {
    const env = environment('cv/?lang=pl&cvLang=' + documentLanguage);
    env.win.GUZICZAK_ROUTER.changeLanguage('de');
    assert.equal(env.state().uiLanguage, 'de');
    assert.equal(env.state().language, documentLanguage);
    assert.equal(env.state().documentLanguageExplicit, true);
    assert.equal(env.url().searchParams.get('cvLang'), documentLanguage);
    assert.equal(env.url().searchParams.get('lang'), 'de');
    assert.equal(env.doc.title, config.pages.cv.de.title);
    assert.equal(env.doc.querySelector('meta[property="og:description"]').content, config.pages.cv.de.description);
    for (const alternate of env.doc.querySelectorAll('link[rel="alternate"][hreflang]')) {
      const address = new URL(alternate.href);
      const expectedLanguage = alternate.hreflang === 'x-default' ? config.defaultLanguage : alternate.hreflang;
      assert.equal(address.pathname, config.basePath + 'cv/');
      assert.equal(address.searchParams.get('lang') || config.defaultLanguage, expectedLanguage);
      assert.equal(address.searchParams.get('cvLang'), documentLanguage, 'alternate UI languages keep the explicit document selection');
      assert.equal(address.searchParams.has('format'), false);
    }
  }
  const inherited = environment('cv/?lang=pl');
  inherited.win.GUZICZAK_ROUTER.changeLanguage('en');
  assert.equal(inherited.state().language, 'en', 'an implicit language follows the interface');
  assert.equal(inherited.url().searchParams.has('cvLang'), false);
  const selected = environment('cv/?lang=pl');
  const dropdown = selected.doc.getElementById('cv-language');
  dropdown.value = 'pl';
  dropdown.dispatchEvent(new EventFixture('change', { target: dropdown }));
  selected.win.GUZICZAK_ROUTER.changeLanguage('en');
  assert.equal(selected.state().language, 'pl', 'a real selection of the current language becomes an explicit choice');
});

test('client navigation, Back and Forward keep history, visible main, focus and home scroll consistent', () => {
  const env = environment('');
  env.win.scrollY = 940;
  env.doc.getElementById('cv-open-html').focus();
  assert.equal(env.click('cv-open-html').defaultPrevented, true);
  assert.equal(env.state().view, 'cv');
  assert.equal(env.url().pathname, config.basePath + 'cv/');
  assert.equal(env.history.length, 2);
  assert.equal(env.doc.getElementById('site').hidden, true);
  assert.equal(env.doc.getElementById('site').inert, true);
  assert.equal(env.doc.activeElement.id, 'cv-title');
  env.click('cv-tab-pdf');
  assert.equal(env.state().format, 'pdf');
  assert.equal(env.history.length, 2, 'format selection replaces the document entry');
  env.history.back(); env.flush();
  assert.equal(env.state().view, 'home');
  assert.equal(env.history.length, 2, 'popstate does not append a route');
  assert.equal(env.win.scrollY, 940);
  assert.equal(env.doc.activeElement.id, 'cv-open-html');
  assert.equal(env.doc.getElementById('cv-view').inert, true);
  env.history.forward(); env.flush();
  assert.equal(env.state().view, 'cv');
  assert.equal(env.state().format, 'pdf');
  assert.equal(env.history.length, 2);
  assert.equal(env.doc.getElementById('cv-back').getAttribute('href'), config.basePath, 'direct-entry visitors have a real home link');
});

test('normal score navigation is enhanced while native link gestures are not intercepted', () => {
  const env = environment('');
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(env.click('nav-cv', modifiers).defaultPrevented, false);
    assert.equal(env.state().view, 'home');
    assert.equal(env.history.length, 1);
  }
  const link = env.doc.getElementById('nav-cv');
  link.setAttribute('target', '_blank');
  assert.equal(env.click('nav-cv').defaultPrevented, false);
  link.removeAttribute('target'); link.setAttribute('download', 'cv.html');
  assert.equal(env.click('nav-cv').defaultPrevented, false);
  link.removeAttribute('download'); link.href = 'https://example.org/cv/';
  assert.equal(env.click('nav-cv').defaultPrevented, false, 'external destinations preserve native navigation');
  assert.equal(env.click('score-open').defaultPrevented, true);
  assert.equal(env.state().view, 'score');
  assert.equal(env.url().pathname, config.basePath + 'score/');
  assert.equal(env.doc.activeElement.id, 'score-title');
  assert.equal(env.doc.getElementById('score-view').hidden, false);
  assert.equal(env.doc.getElementById('site').hidden, true);
  assert.equal(env.doc.getElementById('score-back').getAttribute('href'), config.basePath);
});

test('History API failure falls back to a real document URL', () => {
  const env = environment('');
  env.history.pushState = () => { throw new DOMException('History unavailable', 'SecurityError'); };
  env.click('nav-cv');
  assert.equal(env.assignments.at(-1), config.siteOrigin + config.basePath + 'cv/');
});

test('file previews retain section anchors and distinguish explicit document language on hash changes', () => {
  const file = 'file:///preview/zloto/index.html';
  const direct = environment(file + '#/home?section=kontakt');
  assert.equal(direct.state().view, 'home');
  assert.equal(direct.win.lastScrollTarget, 'kontakt', 'initial local section URL scrolls to the requested section');

  const home = environment(file + '#/home');
  const contact = home.doc.getElementById('site-navigation').querySelectorAll('a')
    .find(link => link.getAttribute('data-l10n') === 'n42');
  assert(contact, 'real contact navigation link');
  const target = new URL(contact.href);
  assert.equal(target.protocol, 'file:');
  assert.equal(target.pathname, '/preview/zloto/index.html');
  assert.equal(new URLSearchParams(target.hash.split('?')[1]).get('section'), 'kontakt');
  home.hashChange(target.hash);
  assert.equal(home.state().view, 'home');
  assert.equal(home.win.lastScrollTarget, 'kontakt', 'native hash navigation updates the visible section');

  const cv = environment(file + '#/cv?lang=en');
  assert.equal(cv.state().documentLanguageExplicit, false);
  cv.hashChange('/cv?lang=en&cvLang=en');
  assert.equal(cv.state().uiLanguage, 'en');
  assert.equal(cv.state().language, 'en');
  assert.equal(cv.state().documentLanguageExplicit, true, 'equal language values do not hide an explicit-selection change');
  cv.win.GUZICZAK_ROUTER.changeLanguage('de');
  assert.equal(cv.state().language, 'en', 'explicit language chosen through a hash URL survives the next UI change');
});
