/* Shared, dependency-free URL model. No DOM, history, storage or network access. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GUZICZAK_ROUTES = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const VIEWS = ['home', 'cv', 'score'];
  const ROUTE_KEYS = new Set(['route', 'lang', 'cvLang', 'format', 'section']);
  const CONTROL = /[\u0000-\u001f\u007f]/;

  function normalizeConfig(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Site configuration is required');
    const origin = new URL(input.siteOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
      throw new TypeError('siteOrigin must be an HTTP(S) origin');
    const base = input.basePath;
    if (typeof base !== 'string' || !base.startsWith('/') || /[?#%\\]/.test(base) || CONTROL.test(base) || base.includes('//') || base.split('/').some(p => p === '.' || p === '..'))
      throw new TypeError('basePath must be an absolute directory path');
    const basePath = base.endsWith('/') ? base : base + '/';
    const languages = input.languages;
    if (!Array.isArray(languages) || !languages.length || languages.some(l => typeof l !== 'string' || !/^[a-z]{2}(?:-[A-Za-z0-9]+)*$/.test(l)) || new Set(languages).size !== languages.length || !languages.includes(input.defaultLanguage))
      throw new TypeError('languages must contain the defaultLanguage exactly once');
    const routes = {};
    for (const view of VIEWS) {
      const value = input.routes && input.routes[view];
      if (typeof value !== 'string' || /[?#%\\]/.test(value) || CONTROL.test(value) || value.startsWith('/') || value.includes('//') || value.split('/').some(p => p === '.' || p === '..') || (view === 'home' ? value !== '' : !value))
        throw new TypeError('Invalid configured route: ' + view);
      routes[view] = value && !value.endsWith('/') ? value + '/' : value;
    }
    if (new Set(Object.values(routes)).size !== VIEWS.length) throw new TypeError('Configured routes must be distinct');
    return Object.freeze({ ...input, siteOrigin: origin.origin, basePath, languages: Object.freeze(languages.slice()), routes: Object.freeze(routes) });
  }

  function notFound(config) {
    return { view: 'not-found', format: 'html', uiLang: config.defaultLanguage, lang: config.defaultLanguage, hash: '', documentLanguageExplicit: false };
  }

  function decode(value, query = false) {
    const result = decodeURIComponent(query ? value.replace(/\+/g, ' ') : value);
    if (CONTROL.test(result)) throw new URIError('Control character in URL');
    return result;
  }

  function parameters(raw) {
    const result = new Map();
    for (const pair of raw.replace(/^\?/, '').split('&')) {
      if (!pair) continue;
      const separator = pair.indexOf('=');
      try {
        const key = decode(separator < 0 ? pair : pair.slice(0, separator), true);
        const value = decode(separator < 0 ? '' : pair.slice(separator + 1), true);
        // As with URLSearchParams.get(), the first occurrence wins. A malformed
        // individual parameter is ignored instead of breaking an existing page.
        if (ROUTE_KEYS.has(key) && !result.has(key)) result.set(key, value);
      } catch (_) { /* Ignore this malformed optional parameter. */ }
    }
    return result;
  }

  function pathView(url, config) {
    if (url.protocol === 'file:') return 'home';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const parts = url.pathname.split('/').map(part => {
      const decoded = decode(part);
      if (/[\\/?#]/.test(decoded) || decoded === '.' || decoded === '..') throw new URIError('Invalid route path');
      return decoded;
    });
    const path = parts.join('/');
    if (path.includes('//')) return null;
    let relative;
    if (config.basePath !== '/' && path === config.basePath.slice(0, -1)) relative = '';
    else if (path.startsWith(config.basePath)) relative = path.slice(config.basePath.length);
    else return null;
    for (const view of VIEWS) {
      const directory = config.routes[view];
      if ([directory, directory + 'index.html', directory.replace(/\/$/, '')].includes(relative)) return view;
    }
    return null;
  }

  /**
   * Decode canonical paths and legacy hash/query routes. Missing lang is always
   * the configured default; history state and browser preferences are irrelevant.
   * Absolute HTTP(S) URLs may use a preview origin. The DOM adapter owns same-origin
   * link checks; siteOrigin is the canonical origin, not a localhost restriction.
   * Unknown paths/route aliases are not-found. Optional values are forgiving:
   * unsupported lang defaults to defaultLanguage, invalid cvLang is ignored,
   * and unknown format means html. First duplicate wins; malformed individual
   * query parameters and unknown parameters (for example UTM tags) are ignored.
   */
  function parseRoute(input, configuration) {
    const config = normalizeConfig(configuration);
    try {
      const url = new URL(String(input), config.siteOrigin + config.basePath);
      const fromPath = pathView(url, config);
      if (!fromPath) return notFound(config);
      const params = parameters(url.search);
      const rawHash = url.hash.slice(1);
      let decodedHash = '';
      let fromHash = null;
      if (rawHash.startsWith('/')) {
        const question = rawHash.indexOf('?');
        const name = decode(question < 0 ? rawHash : rawHash.slice(0, question)).replace(/\/$/, '');
        fromHash = name === '' || name === '/home' ? 'home' : name.slice(1);
        if (!VIEWS.includes(fromHash)) return notFound(config);
        const hashParams = parameters(question < 0 ? '' : rawHash.slice(question + 1));
        for (const [key, value] of hashParams) params.set(key, value);
      } else try { decodedHash = decode(rawHash); } catch (_) { /* Ignore a malformed section fragment. */ }
      const fromQuery = params.get('route');
      if (params.has('route') && !VIEWS.includes(fromQuery)) return notFound(config);
      if (fromHash && fromQuery && fromHash !== fromQuery) return notFound(config);
      const view = fromHash || fromQuery || fromPath;
      if (fromPath !== 'home' && view !== fromPath) return notFound(config);
      const uiLang = config.languages.includes(params.get('lang')) ? params.get('lang') : config.defaultLanguage;
      const explicit = view === 'cv' && config.languages.includes(params.get('cvLang'));
      const lang = explicit ? params.get('cvLang') : uiLang;
      const requestedFormat = params.get('format') === 'pdf' ? 'pdf' : 'html';
      return {
        view,
        format: view === 'home' ? 'html' : requestedFormat,
        uiLang,
        lang,
        hash: view === 'home' ? (fromHash ? params.get('section') || '' : decodedHash || params.get('section') || '') : '',
        documentLanguageExplicit: explicit
      };
    } catch (_) {
      return notFound(config);
    }
  }

  /**
   * Return a root-relative canonical URL. Passing an originating file: URL opts
   * into local hash routing and preserves that exact file path. Explicit cvLang
   * is retained even when equal to lang; a different document language is also
   * necessarily explicit in the resulting URL. not-found is not serializable.
   */
  function serializeRoute(route, configuration, fileBase) {
    const config = normalizeConfig(configuration);
    if (!route || !VIEWS.includes(route.view)) throw new TypeError('A known route view is required');
    const view = route.view;
    const uiLang = route.uiLang ?? config.defaultLanguage;
    const lang = view === 'cv' ? route.lang ?? uiLang : uiLang;
    const format = route.format ?? 'html';
    const hash = view === 'home' ? route.hash ?? '' : '';
    if (!config.languages.includes(uiLang) || !config.languages.includes(lang)) throw new TypeError('Unsupported route language');
    if (!['html', 'pdf'].includes(format)) throw new TypeError('Unsupported document format');
    if (typeof hash !== 'string' || CONTROL.test(hash)) throw new TypeError('Invalid section fragment');
    if (route.documentLanguageExplicit !== undefined && typeof route.documentLanguageExplicit !== 'boolean') throw new TypeError('documentLanguageExplicit must be boolean');
    const query = new URLSearchParams();
    if (uiLang !== config.defaultLanguage) query.set('lang', uiLang);
    if (view === 'cv' && (route.documentLanguageExplicit || lang !== uiLang)) query.set('cvLang', lang);
    if (view !== 'home' && format === 'pdf') query.set('format', 'pdf');
    if (fileBase !== undefined && fileBase !== null) {
      const base = new URL(String(fileBase));
      if (base.protocol !== 'file:') throw new TypeError('fileBase must identify an originating file: URL');
      for (const key of ROUTE_KEYS) base.searchParams.delete(key);
      if (hash) query.set('section', hash);
      base.hash = '/' + view + (query.size ? '?' + query.toString() : '');
      return base.href;
    }
    return config.basePath + config.routes[view] + (query.size ? '?' + query.toString() : '') + (hash ? '#' + encodeURIComponent(hash) : '');
  }

  return Object.freeze({ normalizeConfig, parseRoute, serializeRoute });
});
