/* AERO-wiki – klient. Načíta data/catalog.js (scripts/build_catalog.py, každú hodinu), zobrazí vrstvy
   v troch úrovniach: letecké vrstvy (vždy navrchu) > prekrytia (popisy, reliéf, tematické) > jeden podklad
   (+ pozadie mimo pokrytia regionálneho podkladu). Klik do mapy zobrazí najprv letecké informácie v bode,
   potom podklady. Reliéf a sklon počíta z výškových dlaždíc priamo v prehliadači; katalóg obnovuje každú hodinu. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ konštanty
  const O = 20037508.342789244;
  const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const KINDS = ['ortho', 'satellite', 'live', 'relief', 'thematic', 'base'];
  const KIND_SHORT = { ortho: 'Ortofoto', satellite: 'Satelit', live: 'Aktuálne', relief: 'Reliéf', thematic: 'Tematické', base: 'Podklad', aero: 'Letectvo' };
  const GLOBAL_ORDER = ['live', 'satellite', 'relief', 'thematic', 'base', 'ortho'];
  const AERO = window.OrtoAero || null;
  const LIBRARY = window.OrtoLibrary || null;
  const DEFAULT_BASE = 'eox-s2cloudless-2025';
  const DEFAULT_BACKDROP = 'eox-s2cloudless-2025';
  const DEFAULT_LAYERS = ['aero-sigmet', 'aero-notam', 'aero-metar', 'aero-ad', 'eox-overlay-bright'];
  const AERO_GROUPS = [['notam', 'NOTAM, rezervácie, výstrahy'], ['met', 'Počasie'], ['aip', 'AIP: letiská, priestory, prekážky'], ['chart', 'Letecké mapy'], ['uas', 'Drony (UAS)']];
  const TIME_POLL_MS = 10 * 60 * 1000;
  const FILTERS = {
    none: { label: 'pôvodné', css: 'none' },
    gray: { label: 'odtiene sivej', css: 'grayscale(1)' },
    vivid: { label: 'sýte, kontrastné', css: 'saturate(1.35) contrast(1.15)' },
    soft: { label: 'tlmené', css: 'saturate(.55) brightness(1.08)' },
    dark: { label: 'tmavé', css: 'brightness(.7) contrast(1.1)' },
    invert: { label: 'invertované', css: 'invert(1) hue-rotate(180deg)' },
  };
  const BLENDS = { normal: 'normálne', multiply: 'násobenie (reliéf)', screen: 'zosvetlenie', overlay: 'prekrytie', 'soft-light': 'jemné svetlo', luminosity: 'jas' };
  const HYPSO = [
    [-11000, [8, 29, 58]], [-6000, [17, 57, 104]], [-3000, [36, 94, 150]], [-1000, [72, 135, 190]], [-100, [126, 177, 214]], [0, [170, 205, 228]],
    [0.01, [86, 140, 84]], [150, [124, 165, 96]], [400, [176, 190, 118]], [800, [214, 196, 134]], [1300, [196, 154, 98]],
    [1900, [166, 118, 82]], [2600, [150, 128, 118]], [3500, [200, 196, 192]], [5000, [250, 250, 250]],
  ];
  const SLOPE = [[3, null], [8, [255, 255, 178]], [15, [254, 204, 92]], [25, [253, 141, 60]], [35, [240, 59, 32]], [91, [189, 0, 38]]];

  // ------------------------------------------------------------------ pomocné
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aerowiki:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aerowiki:' + k, JSON.stringify(v)); } catch { /* bez úložiska */ } },
  };
  const regionName = (() => {
    let dn = null;
    try { dn = new Intl.DisplayNames(['sk'], { type: 'region' }); } catch { /* starý prehliadač */ }
    return (cc) => { if (!cc) return 'Celý svet'; try { return (dn && dn.of(cc)) || cc; } catch { return cc; } };
  })();
  const fmtUTC = (iso) => { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? iso : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
  const fmtLocalTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '–' : d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }); };
  const svg = {
    zoom: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  const hashId = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'p' + (h >>> 0).toString(36); };
  let toastTimer = 0;
  function toast(msg, ms = 4200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ------------------------------------------------------------------ katalóg a stav
  let CAT = window.AEROWIKI_CATALOG;
  if (!CAT || !Array.isArray(CAT.layers)) {
    $('#list').innerHTML = '<p class="empty">Katalóg data/catalog.js sa nenačítal. Spustite scripts/build_catalog.py.</p>';
    return;
  }
  let byId = new Map(CAT.layers.map((l) => [l.id, l]));
  const timeInfo = new Map(); // id -> čas zistený priamo v prehliadači (novší než katalóg)

  const oldTab = store.get('tab', 'aero');
  const state = {
    tab: ['aero', 'library', 'base', 'active'].includes(oldTab) ? oldTab : oldTab === 'countries' || oldTab === 'global' ? 'base' : 'aero',
    sub: store.get('baseSub', oldTab === 'global' ? 'global' : 'countries'),
    q: '',
    kinds: new Set(store.get('kinds', KINDS)),
    hideDown: store.get('hideDown', true),
    openOnly: store.get('openOnly', false),
    open: new Set(store.get('openCountries', ['SK'])),
    active: [],          // id vrstiev zhora nadol (letecké > prekrytia > podklad > pozadie)
    base: null,          // jediný podklad
    backdrop: null,      // globálny podklad pod regionálnym (mimo jeho pokrytia)
    showCoverage: store.get('showCoverage', false),
    legendCollapsed: store.get('legendCollapsed', true),
    aeroInView: store.get('aeroInView', true),
    aeroClosed: new Set(store.get('aeroClosed', [])),
  };
  const live = new Map(); // id -> záznam aktívnej vrstvy

  // úroveň vrstvy: 0 letecké vektorové, 1 letecké rastrové prekrytie, 2 prekrytie, 3 podklad, 4 pozadie
  const isVecType = (l) => l.type === 'vector' || l.type === 'rainviewer';
  function isBase(l) {
    if (!l || l.overlay || isVecType(l)) return false;
    if (l.kind === 'aero') return true;          // nepriehľadné letecké mapy (ICAO, Sectional, podklad VFR)
    if (l.kind === 'relief') return l.type === 'terrarium' && l.mode === 'hypso';
    return ['ortho', 'satellite', 'base', 'live', 'thematic'].includes(l.kind);
  }
  function tier(id) {
    const l = byId.get(id) || live.get(id)?.def; if (!l) return 2;
    if (id === state.backdrop) return 4;
    if (isBase(l)) return 3;
    if (l.kind === 'aero') return isVecType(l) ? 0 : 1;
    return 2;
  }

  // ------------------------------------------------------------------ mapa
  const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 20, zoomSnap: 1, zoomControl: false }).setView([48.7, 19.5], 7);
  L.control.zoom({ position: 'topright', zoomInTitle: 'Priblížiť', zoomOutTitle: 'Oddialiť' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const coverageGroup = L.layerGroup().addTo(map);
  const hoverGroup = L.layerGroup().addTo(map);

  function boundsOf(l) {
    const b = l && l.bbox;
    if (!b) return null;
    return L.latLngBounds([[Math.max(-85, b[1]), b[0]], [Math.min(85, b[3]), b[2]]]);
  }

  // dlaždicová vrstva so zástupnými symbolmi ELI/WMS/WMTS: {z} {x} {y} {-y} {s} {bbox} {proj} {wkid} {width} {height} {time}
  const TemplateLayer = L.TileLayer.extend({
    initialize(def, opts) {
      this._def = def; this._timeValue = opts.timeValue || null;
      L.TileLayer.prototype.initialize.call(this, def.url, opts);
    },
    setTimeValue(t) { if (t === this._timeValue) return; this._timeValue = t; this.redraw(); },
    getTileUrl(c) {
      const z = this._getZoomForUrl(); const n = 2 ** z;
      const x = ((c.x % n) + n) % n; const y = c.y;
      let u = this._def.url;
      if (this._def.subdomains) { const subs = this._def.subdomains.split(','); u = u.replace('{s}', subs[(x + y) % subs.length]); }
      const s = (2 * O) / n;
      const bbox = [-O + x * s, O - (y + 1) * s, -O + (x + 1) * s, O - y * s].map((v) => v.toFixed(3)).join(',');
      const t = this._timeValue;
      if (!t) u = u.replace(/[&?]TIME=\{time\}/i, '');
      return u.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{-y\}/g, n - 1 - y).replace(/\{y\}/g, y)
        .replace(/\{proj\}/g, this._def.proj || 'EPSG:3857').replace(/\{wkid\}/g, '3857').replace(/\{bbox\}/g, bbox)
        .replace(/\{width\}/g, '256').replace(/\{height\}/g, '256').replace(/\{time\}/g, t || 'default');
    },
  });

  // výpočet reliéfu z výškových dlaždíc Terrarium (výška = R*256 + G + B/256 − 32768)
  function rampColor(stops, v) {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i]; const t = (v - a) / ((b - a) || 1);
        return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
      }
    }
    return stops[stops.length - 1][1];
  }
  function processTerrain(img, z, ty, mode) {
    const N = 256; const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const src = g.getImageData(0, 0, N, N); const d = src.data;
    const el = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) el[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 0.5)) / 2 ** z)));
    const cs = (40075016.686 * Math.cos(latRad)) / (N * 2 ** z);
    const zf = z < 12 ? 1 + (12 - z) * 0.3 : 1;
    const zen = (45 * Math.PI) / 180, az = (135 * Math.PI) / 180; // svetlo zo SZ (315°), výška 45°
    const out = g.createImageData(N, N); const o = out.data;
    const at = (x, y) => el[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const a = at(x - 1, y - 1), b = at(x, y - 1), cc = at(x + 1, y - 1), dd = at(x - 1, y), f = at(x + 1, y), gg = at(x - 1, y + 1), h = at(x, y + 1), ii = at(x + 1, y + 1);
        const dzdx = ((cc + 2 * f + ii) - (a + 2 * dd + gg)) / (8 * cs);
        const dzdy = ((gg + 2 * h + ii) - (a + 2 * b + cc)) / (8 * cs);
        const k = (y * N + x) * 4; const e = el[y * N + x];
        if (mode === 'slope') {
          const deg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
          let col = null; for (const [lim, cl] of SLOPE) { if (deg < lim) { col = cl; break; } }
          if (!col || e <= 0) { o[k + 3] = 0; continue; }
          o[k] = col[0]; o[k + 1] = col[1]; o[k + 2] = col[2]; o[k + 3] = 200;
          continue;
        }
        const slope = Math.atan(zf * Math.hypot(dzdx, dzdy));
        let aspect = Math.atan2(dzdy, -dzdx); if (aspect < 0) aspect += 2 * Math.PI;
        const hs = Math.max(0, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect));
        const col = rampColor(HYPSO, e);
        const m = e < 0 ? 0.82 + 0.18 * hs : 0.28 + 0.78 * hs;
        o[k] = Math.min(255, col[0] * m); o[k + 1] = Math.min(255, col[1] * m); o[k + 2] = Math.min(255, col[2] * m); o[k + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
    return c;
  }
  const TerrariumLayer = L.GridLayer.extend({
    initialize(def, opts) { this._def = def; L.GridLayer.prototype.initialize.call(this, opts); },
    createTile(coords, done) {
      const holder = document.createElement('div');
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = processTerrain(img, coords.z, coords.y, this._def.mode);
          c.style.width = c.style.height = '100%'; holder.appendChild(c); done(null, holder);
        } catch (e) { done(e, holder); }
      };
      img.onerror = () => done(new Error('dlaždica'), holder);
      const n = 2 ** coords.z; const x = ((coords.x % n) + n) % n;
      img.src = this._def.url.replace('{z}', coords.z).replace('{x}', x).replace('{y}', coords.y);
      return holder;
    },
  });

  // ------------------------------------------------------------------ čas
  function periodMs(p) {
    const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(p || '');
    if (!m) return null;
    const [, Y, Mo, D, H, Mi, S] = m.map((v) => +v || 0);
    if (Y || Mo) return null;
    return ((D * 24 + H) * 60 + Mi) * 60000 + S * 1000 || null;
  }
  function timeOf(def) {
    const t = Object.assign({}, def.time || {}, timeInfo.get(def.id) || {});
    return def.time ? t : null;
  }
  function timeSteps(def, max = 48) {
    const t = timeOf(def);
    if (!t || t.static || !t.latest || t.latest === 'default') return null;
    const daily = /^\d{4}-\d{2}-\d{2}$/.test(t.latest);
    const step = periodMs(t.period) || (daily ? 864e5 : null);
    if (!step) return [t.latest];
    const end = Date.parse(daily ? t.latest + 'T00:00:00Z' : t.latest);
    const start = t.start ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t.start) ? t.start + 'T00:00:00Z' : t.start) : -Infinity;
    const out = [];
    for (let i = 0; i < max; i++) {
      const v = end - i * step; if (v < start) break;
      const iso = new Date(v).toISOString();
      out.push(daily ? iso.slice(0, 10) : iso.slice(0, 19) + 'Z');
    }
    return out;
  }
  const fmtTime = (v) => (!v || v === 'default' ? 'najnovšie podľa servera' : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fmtUTC(v));
  function currentTime(rec) {
    const t = timeOf(rec.def);
    if (!t) return null;
    if (t.static) return 'default';
    if (rec.timeMode === 'pinned' && rec.time) return rec.time;
    if (t.latest && t.latest !== 'default') return t.latest;
    return t.source === 'gibs' ? 'default' : null;
  }

  const capsCache = new Map(); // url -> {at, promise}
  function fetchCaps(url) {
    const c = capsCache.get(url);
    if (c && Date.now() - c.at < TIME_POLL_MS - 5000) return c.promise;
    const promise = fetch(url, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then((txt) => new DOMParser().parseFromString(txt, 'text/xml'));
    capsCache.set(url, { at: Date.now(), promise });
    promise.catch(() => capsCache.delete(url));
    return promise;
  }
  function parseValues(text) {
    let latest = null, period = null, start = null;
    for (const part of String(text || '').split(',')) {
      const p = part.trim(); if (!p) continue;
      if (p.includes('/')) { const [a, b, pp] = p.split('/'); start = a; latest = b; period = pp || null; } else latest = p;
    }
    const norm = (v) => (v ? v.replace(/\.\d+Z$/, 'Z') : v);
    return { latest: norm(latest), period, start: norm(start) };
  }
  // zistí najnovší čas časových vrstiev priamo z GetCapabilities (NASA GIBS a EUMETSAT povoľujú CORS)
  async function refreshTimes(onlyActive = true) {
    const groups = new Map();
    for (const l of CAT.layers) {
      const t = l.time; if (!t || t.static || !t.caps) continue;
      if (onlyActive && !live.has(l.id)) continue;
      if (!groups.has(t.caps)) groups.set(t.caps, []);
      groups.get(t.caps).push(l);
    }
    let changed = false;
    await Promise.all([...groups].map(async ([url, ls]) => {
      let doc; try { doc = await fetchCaps(url); } catch { return; }
      const want = new Map(ls.map((l) => [l.time.layer, l]));
      for (const lay of doc.getElementsByTagName('Layer')) {
        let name = null, dim = null;
        for (const ch of lay.children) {
          if ((ch.localName === 'Identifier' || ch.localName === 'Name') && !name) name = ch.textContent;
          if (ch.localName === 'Dimension') dim = ch;
        }
        const l = name && want.get(name); if (!l || !dim) continue;
        let info;
        if (l.time.source === 'gibs') {
          const vals = [...dim.children].filter((e) => e.localName === 'Value').map((e) => e.textContent).join(',');
          info = parseValues(vals);
        } else info = parseValues(dim.textContent);
        const prev = timeOf(l);
        if (info.latest && info.latest !== prev.latest) changed = true;
        timeInfo.set(l.id, { ...info, checkedClient: new Date().toISOString() });
      }
    }));
    if (changed) {
      for (const [, rec] of live) if (rec.layer.setTimeValue) rec.layer.setTimeValue(currentTime(rec));
      renderList(); renderLegend();
    }
    return changed;
  }

  // ------------------------------------------------------------------ zapínanie a vypínanie vrstiev
  function addRaw(id, opts = {}) {
    if (live.has(id)) return true;
    const def = byId.get(id); if (!def) return false;
    const paneName = hashId(id);
    if (!map.getPane(paneName)) map.createPane(paneName);
    const saved = store.get('sym:' + id, null) || {};
    const defBlend = def.blend || (def.kind === 'relief' && !isBase(def) && def.mode !== 'slope' ? 'multiply' : 'normal');
    const rec = {
      id, def, pane: paneName, ok: 0, err: 0, warned: false,
      opacity: saved.opacity ?? (def.kind === 'relief' && defBlend === 'multiply' ? 0.85 : def.type === 'rainviewer' ? 0.75 : 1),
      blend: saved.blend || defBlend, filter: saved.filter || 'none',
      timeMode: 'latest', time: null,
    };
    const common = {
      pane: paneName, opacity: rec.opacity, minZoom: def.minz || 0, maxZoom: 21,
      maxNativeZoom: Math.min(def.maxz ?? 19, 21),
      attribution: def.attribution?.url ? `<a href="${esc(def.attribution.url)}" target="_blank" rel="noopener">${esc(def.attribution.text)}</a>` : esc(def.attribution?.text || def.name),
      bounds: boundsOf(def) || undefined, crossOrigin: false, errorTileUrl: EMPTY_TILE, keepBuffer: 1,
    };
    if (isVecType(def)) {
      if (!AERO) { toast('Letecký modul (aero.js) sa nenačítal.'); return false; }
      rec.layer = AERO.createLayer(def, paneName, { attribution: common.attribution, opacity: rec.opacity });
      if (def.type === 'vector') rec.layer.getAttribution = () => common.attribution;
    } else if (def.type === 'terrarium') rec.layer = new TerrariumLayer(def, { ...common, tileSize: 256 });
    else rec.layer = new TemplateLayer(def, { ...common, timeValue: null });
    rec.layer.on('tileload', () => { rec.ok++; tileStat(rec); });
    rec.layer.on('tileerror', () => { rec.err++; tileStat(rec); });
    live.set(id, rec);
    if (rec.layer.setTimeValue) rec.layer._timeValue = currentTime(rec);
    rec.layer.addTo(map);
    // vloženie podľa úrovne (letecké navrchu, podklad naspodku)
    const r = tier(id); let at = state.active.findIndex((a) => tier(a) > r);
    if (at < 0) at = state.active.length;
    state.active.splice(at, 0, id);
    applySymbology(rec);
    if (def.time && !def.time.static && (!timeOf(def).latest || timeOf(def).latest === 'default')) refreshTimes(true);
    if (!opts.quiet) {
      if (def.status?.state === 'down') toast(`Pozor: „${def.name}“ bola pri poslednej kontrole nedostupná (${def.status.err || 'chyba'}).`);
      const b = boundsOf(def);
      if (b && !b.intersects(map.getBounds())) toast(`„${def.name}“ je mimo aktuálneho výrezu – použite tlačidlo priblížiť.`);
      else if ((def.minz || 0) > map.getZoom()) toast(`„${def.name}“ sa zobrazí od priblíženia z${def.minz}.`);
    }
    return true;
  }
  function removeRaw(id) {
    const rec = live.get(id); if (!rec) return;
    map.removeLayer(rec.layer);
    live.delete(id);
    state.active = state.active.filter((a) => a !== id);
  }
  // jediný podklad; regionálny podklad dostane pod seba globálne pozadie
  function setBase(id, opts = {}) {
    const def = byId.get(id); if (!def) return;
    if (state.base === id) return;
    const regional = !!def.cc;
    const prev = state.base;
    if (prev) {
      const pdef = byId.get(prev);
      if (regional && pdef && !pdef.cc) {
        if (state.backdrop && state.backdrop !== prev) removeRaw(state.backdrop);
        state.backdrop = prev;
      } else removeRaw(prev);
    }
    if (!regional && state.backdrop) { removeRaw(state.backdrop); state.backdrop = null; }
    if (regional && !state.backdrop && byId.has(DEFAULT_BACKDROP) && DEFAULT_BACKDROP !== id) { state.backdrop = DEFAULT_BACKDROP; addRaw(DEFAULT_BACKDROP, { quiet: true }); }
    state.base = id;
    addRaw(id, opts);
    // pozadie zaradiť úplne naspodok
    if (state.backdrop) { state.active = state.active.filter((a) => a !== state.backdrop); state.active.push(state.backdrop); }
  }
  function setBackdrop(id) {
    if (state.backdrop) removeRaw(state.backdrop);
    state.backdrop = null;
    if (id && byId.has(id) && id !== state.base) { state.backdrop = id; addRaw(id, { quiet: true }); state.active = state.active.filter((a) => a !== id); state.active.push(id); }
    afterChange();
  }
  function activate(id, opts = {}) {
    const def = byId.get(id); if (!def || live.has(id)) return;
    if (isBase(def)) setBase(id, opts); else addRaw(id, opts);
    if (!opts.batch) afterChange();
  }
  function deactivate(id, opts = {}) {
    if (!live.has(id)) return;
    removeRaw(id);
    if (id === state.base) { state.base = state.backdrop; state.backdrop = null; }
    if (id === state.backdrop) state.backdrop = null;
    if (!opts.batch) afterChange();
  }
  function toggle(id) {
    const def = byId.get(id); if (!def) return;
    if (live.has(id)) { if (id === state.base) return; deactivate(id); } else activate(id);
  }
  function wantedOf(ids) {
    const firstBase = ids.find((id) => isBase(byId.get(id)));
    return ids.filter((id) => !isBase(byId.get(id)) || id === firstBase);
  }
  function layersOn(ids) {
    const ok = ids.filter((id) => byId.has(id));
    const want = wantedOf(ok);
    return want.length > 0 && want.every((id) => live.has(id));
  }
  function toggleLayers(ids, fit) {
    const ok = ids.filter((id) => byId.has(id));
    if (!ok.length) return;
    // z viacerých podkladov (napr. mapy FAA) sa zapne len prvý; ostatné sa dajú prepnúť v záložke Letectvo
    const want = wantedOf(ok);
    const allOn = layersOn(ok);
    if (allOn) want.forEach((id) => { if (id !== state.base) deactivate(id, { batch: true }); });
    else want.forEach((id) => activate(id, { batch: true, quiet: true }));
    afterChange();
    if (!allOn) {
      const b = fit ? L.latLngBounds(fit) : want.map((id) => boundsOf(byId.get(id))).filter(Boolean).reduce((acc, x) => (acc ? acc.extend(x) : L.latLngBounds(x.getSouthWest(), x.getNorthEast())), null);
      if (b && !b.intersects(map.getBounds())) map.fitBounds(b);
      const minz = Math.max(...want.map((id) => byId.get(id).minz || 0));
      setTimeout(() => { if (map.getZoom() < minz) toast(`Zapnuté: ${want.length} vrstiev. Niektoré sa zobrazia až od priblíženia z${minz}.`); else toast(`Zapnuté: ${want.length} vrstiev.`); }, 400);
    }
  }
  function applySymbology(rec) {
    const pane = map.getPane(rec.pane);
    pane.style.mixBlendMode = rec.blend === 'normal' ? '' : rec.blend;
    pane.style.filter = FILTERS[rec.filter]?.css === 'none' ? '' : FILTERS[rec.filter]?.css || '';
    rec.layer.setOpacity(rec.opacity);
    store.set('sym:' + rec.id, { opacity: rec.opacity, blend: rec.blend, filter: rec.filter });
  }
  // z-index: letecké vektorové 4xx (nad overlayPane), letecké rastre 3xx, prekrytia 2xx, podklad 210, pozadie 205
  function applyOrder() {
    state.active.sort((a, b) => tier(a) - tier(b));
    const base = [460, 380, 300, 210, 205];
    const used = [0, 0, 0, 0, 0];
    state.active.forEach((id) => {
      const rec = live.get(id); if (!rec) return;
      const t = tier(id);
      map.getPane(rec.pane).style.zIndex = String(base[t] - (t < 3 ? used[t]++ : 0));
    });
  }
  function move(id, dir) {
    const i = state.active.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= state.active.length || tier(state.active[j]) !== tier(id)) return;
    [state.active[i], state.active[j]] = [state.active[j], state.active[i]];
    afterChange();
  }
  let statTimer = 0;
  function tileStat(rec) {
    if (!rec.warned && rec.err >= 6 && rec.ok === 0) {
      rec.warned = true;
      toast(`„${rec.def.name}“ sa v tomto prehliadači nenačítava (${rec.err} chybných dlaždíc).`);
    }
    clearTimeout(statTimer);
    statTimer = setTimeout(() => {
      document.querySelectorAll(`.tile-stat[data-id="${CSS.escape(rec.id)}"]`).forEach((el) => {
        el.textContent = `dlaždice ${rec.ok}/${rec.ok + rec.err}`; el.classList.toggle('bad', rec.err > rec.ok);
      });
    }, 250);
  }
  function afterChange() {
    applyOrder();
    $('#cnt-active').textContent = state.active.length;
    renderList(); renderLegend(); renderCoverage(); saveHash();
  }

  // ------------------------------------------------------------------ filtre a zoznam
  function textOf(l) {
    return [l.name, l.id, l.cc, regionName(l.cc), l.start, l.end, KIND_SHORT[l.kind], l.attribution?.text].join(' ').toLowerCase();
  }
  function passes(l, q) {
    if (live.has(l.id)) return true;
    if (!state.kinds.has(l.kind)) return false;
    if (state.hideDown && l.status?.state === 'down') return false;
    if (state.openOnly && l.license?.open !== true) return false;
    if (q && !textOf(l).includes(q)) return false;
    return true;
  }
  function years(l) {
    const a = (l.start || '').slice(0, 4), b = (l.end || '').slice(0, 4);
    if (!a && !b) return '';
    return a === b || !b ? a : !a ? '–' + b : `${a}–${b}`;
  }
  function statusTitle(l) {
    const s = l.status || {};
    const lab = { ok: 'dostupná', warn: 'varovanie', down: 'nedostupná', unknown: 'neoverená' }[s.state || 'unknown'];
    const parts = [lab];
    if (s.err) parts.push(s.err);
    if (s.ms) parts.push(s.ms + ' ms');
    if (s.count != null) parts.push(s.count + ' objektov');
    if (s.uptime24 != null) parts.push(`dostupnosť 24 h: ${Math.round(s.uptime24 * 100)} %`);
    if (s.checked) parts.push('kontrola ' + fmtUTC(s.checked));
    return parts.join(' · ');
  }
  function sortLayers(a, b) {
    return (b.best - a.best) || ((b.end || b.start || '9999') > (a.end || a.start || '9999') ? 1 : (b.end || b.start || '9999') < (a.end || a.start || '9999') ? -1 : 0) || a.name.localeCompare(b.name, 'sk');
  }
  function typeLabel(l) {
    if (l.type === 'vector') return l.source === 'arcgis' ? 'živá služba' : 'údaje';
    if (l.type === 'rainviewer') return 'radar';
    return l.type === 'terrarium' ? 'výpočet' : l.type === 'wms' ? 'WMS' : 'dlaždice';
  }
  function rowHTML(l, inActive = false) {
    const st = l.status?.state || 'unknown';
    const rec = live.get(l.id);
    const lic = l.license || {};
    const licTxt = lic.open === true ? '<span class="lic-open">otvorená licencia</span>' : lic.open === false ? '<span class="lic-closed">podmienky</span>' : 'podmienky';
    const t = timeOf(l);
    const base = isBase(l);
    const meta = [
      base ? '<span class="role">podklad</span>' : l.kind === 'aero' ? '' : '<span class="role">prekrytie</span>',
      years(l) && `<span>${esc(years(l))}</span>`,
      t && !t.static ? `<span>${esc(t.period ? 'krok ' + t.period.replace(/^PT?/, '').toLowerCase() : 'časová')}</span>` : '',
      isVecType(l) ? (l.minz ? `<span>od z${l.minz}</span>` : '') : `<span>z${l.minz ?? 0}–${l.maxz ?? 19}</span>`, `<span>${typeLabel(l)}</span>`, licTxt,
      rec ? `<span class="tile-stat" data-id="${esc(l.id)}">${isVecType(l) ? vecStat(rec) : `dlaždice ${rec.ok}/${rec.ok + rec.err}`}</span>` : '',
    ].filter(Boolean).join('');
    const act = (inActive && tier(l.id) < 3 ? `<button class="icon" data-act="up" aria-label="Posunúť vyššie">${svg.up}</button><button class="icon" data-act="down" aria-label="Posunúť nižšie">${svg.down}</button>` : '') +
      `<i class="dot ${st}" title="${esc(statusTitle(l))}"></i>` +
      (l.bbox ? `<button class="icon" data-act="zoom" aria-label="Priblížiť na pokrytie">${svg.zoom}</button>` : '') +
      `<button class="icon" data-act="info" aria-label="Podrobnosti">${svg.info}</button>`;
    const label = (l.cc && (inActive || l.kind === 'aero') ? `<span class="ccb">${esc(l.cc)}</span>` : '') + esc(l.name);
    const input = base
      ? `<input type="radio" name="base-pick-${esc(state.tab)}" data-act="toggle" ${rec ? 'checked' : ''} aria-label="Podklad ${esc(l.name)}">`
      : `<input type="checkbox" data-act="toggle" ${rec ? 'checked' : ''} aria-label="Zobraziť ${esc(l.name)}">`;
    return `<div class="lr${st === 'down' ? ' is-down' : ''}" data-id="${esc(l.id)}">
      ${input}
      <span class="sw k-${l.kind}" title="${KIND_SHORT[l.kind]}"></span>
      <span class="lr-name" data-act="toggle">${label}${l.best ? '<span class="best">TOP</span>' : ''}</span>
      <span class="lr-act">${act}</span>
      <div class="lr-meta mono">${meta}</div>
      ${rec ? ctlHTML(l, rec) : ''}
    </div>`;
  }
  function vecStat(rec) {
    const lay = rec.layer;
    if (rec.def.type === 'rainviewer') return lay.error ? 'chyba: ' + esc(lay.error) : lay.frame ? `snímka ${fmtUTC(lay.frame.time * 1000).slice(11)}` : 'načítava sa';
    if (!lay || lay.count == null) return 'načítava sa';
    if (lay.error) return 'chyba: ' + esc(lay.error);
    if (!lay.count && lay.note) return esc(lay.note);
    return `objekty ${lay.count}${lay.total ? ' z ' + lay.total : ''}${lay.note ? ' · ' + esc(lay.note) : ''}`;
  }
  function ctlHTML(l, rec) {
    if (isVecType(l)) {
      return `<div class="ctl"><div class="ctl-row"><span>priehľadnosť</span><input type="range" data-ctl="opacity" min="0" max="100" value="${Math.round(rec.opacity * 100)}" aria-label="Priehľadnosť"><output>${Math.round(rec.opacity * 100)} %</output></div></div>`;
    }
    const opts = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');
    let timeRow = '';
    const steps = timeSteps(l);
    if (steps && steps.length > 1) {
      const cur = currentTime(rec); let idx = steps.indexOf(cur); if (idx < 0) idx = 0;
      timeRow = `<div class="ctl-row"><span>čas snímky</span>
        <input type="range" data-ctl="time" min="0" max="${steps.length - 1}" step="1" value="${steps.length - 1 - idx}" aria-label="Čas snímky">
        <output>${idx === 0 ? 'najnovšia' : '−' + idx}</output></div>
        <div class="ctl-row"><span></span><span class="mono">${esc(fmtTime(steps[idx]))}</span><span></span></div>`;
    } else if (l.time && !l.time.static) {
      timeRow = `<div class="ctl-row"><span>čas snímky</span><span class="mono">${esc(fmtTime(currentTime(rec)))}</span><span></span></div>`;
    }
    return `<div class="ctl">
      <div class="ctl-row"><span>priehľadnosť</span><input type="range" data-ctl="opacity" min="0" max="100" value="${Math.round(rec.opacity * 100)}" aria-label="Priehľadnosť"><output>${Math.round(rec.opacity * 100)} %</output></div>
      <div class="ctl-row"><span>prelínanie</span><select data-ctl="blend" aria-label="Režim prelínania">${opts(BLENDS, rec.blend)}</select><span></span></div>
      <div class="ctl-row"><span>farby</span><select data-ctl="filter" aria-label="Farebná úprava">${opts(FILTERS, rec.filter)}</select><span></span></div>
      ${timeRow}
    </div>`;
  }

  function renderCountries(q) {
    const groups = new Map();
    for (const l of CAT.layers) { if (!l.cc || l.kind === 'aero') continue; if (!groups.has(l.cc)) groups.set(l.cc, []); groups.get(l.cc).push(l); }
    const rows = [];
    let shown = 0;
    const entries = [...groups].map(([cc, ls]) => [cc, regionName(cc), ls]).sort((a, b) => a[1].localeCompare(b[1], 'sk'));
    for (const [cc, name, ls] of entries) {
      const nameHit = q && (name.toLowerCase().includes(q) || cc.toLowerCase() === q);
      const vis = ls.filter((l) => passes(l, nameHit ? '' : q));
      if (!vis.length) continue;
      shown++;
      const counts = {}; vis.forEach((l) => { counts[l.kind] = (counts[l.kind] || 0) + 1; });
      const mx = Math.max(...Object.values(counts));
      const bars = KINDS.filter((k) => counts[k]).map((k) => `<i style="--c:var(--k-${k});height:${Math.max(3, Math.round((counts[k] / mx) * 16))}px" title="${KIND_SHORT[k]}: ${counts[k]}"></i>`).join('');
      const ok = vis.filter((l) => l.status?.state === 'ok').length;
      const open = state.open.has(cc) || (q && vis.length <= 30) ? ' open' : '';
      rows.push(`<details class="country" data-cc="${cc}"${open}>
        <summary><span class="cc">${cc}</span><span class="cname">${esc(name)}<small>${vis.length} vrstiev · ${ok} dostupných</small></span>
        <span class="kbar" aria-hidden="true">${bars}</span>
        <button class="icon" data-act="zoom-cc" aria-label="Priblížiť na krajinu">${svg.zoom}</button></summary>
        <div class="layers">${open ? vis.sort(sortLayers).map((l) => rowHTML(l)).join('') : ''}</div>
      </details>`);
    }
    return { html: rows.join('') || '<p class="empty">Žiadna krajina nezodpovedá filtru.</p>', n: shown };
  }
  function renderGlobal(q) {
    const vis = CAT.layers.filter((l) => !l.cc && l.kind !== 'aero' && passes(l, q));
    if (!vis.length) return { html: '<p class="empty">Žiadna globálna vrstva nezodpovedá filtru.</p>', n: 0 };
    return { n: vis.length, html: GLOBAL_ORDER.map((k) => {
      const ls = vis.filter((l) => l.kind === k).sort(sortLayers); if (!ls.length) return '';
      return `<h2 class="grp-title"><span class="sw k-${k}"></span>${esc(CAT.kinds?.[k] || KIND_SHORT[k])} · ${ls.length}</h2>${ls.map((l) => rowHTML(l)).join('')}`;
    }).join('') };
  }
  function renderBase(q) {
    const c = renderCountries(q); const g = renderGlobal(q);
    document.querySelectorAll('[data-sub]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === state.sub)));
    $('#seg-n-countries').textContent = c.n; $('#seg-n-global').textContent = g.n;
    const curBase = state.base ? byId.get(state.base) : null;
    const hint = `<p class="hint small">Podklad je vždy len jeden (prepínač ◉); ortofoto, satelit aj nepriehľadné letecké mapy sa navzájom nahrádzajú. Prekrytia (☐ popisy, reliéf) sa pridávajú. Aktuálny podklad: <b>${esc(curBase ? curBase.name : 'žiadny')}</b>.</p>`;
    return hint + (state.sub === 'global' ? g.html : c.html);
  }
  function renderActive() {
    if (!state.active.length) return '<p class="empty">Na mape nie je žiadna vrstva. Zapnite ju v záložke Letectvo alebo Podklady, alebo kliknite do mapy.</p>';
    const ids = state.active;
    const sec = (t) => ids.filter((id) => tier(id) === t).map((id) => byId.get(id) || live.get(id)?.def).filter(Boolean);
    const aero = [...sec(0), ...sec(1)]; const ov = sec(2); const base = sec(3);
    const globals = CAT.layers.filter((l) => !l.cc && isBase(l) && l.status?.state !== 'down').sort(sortLayers).slice(0, 40);
    const bdSel = `<select id="f-backdrop" aria-label="Pozadie mimo pokrytia"><option value="">bez pozadia</option>${globals.map((l) => `<option value="${esc(l.id)}" ${l.id === state.backdrop ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
    return `<div class="active-tools"><span>Poradie zhora nadol = poradie v mape. Letecké vrstvy sú vždy navrchu.</span>
      <label><input type="checkbox" id="f-coverage" ${state.showCoverage ? 'checked' : ''}> obrysy pokrytia</label>
      <button class="btn" data-act="clear" type="button">Vypnúť všetko okrem podkladu</button></div>
      <h2 class="grp-title"><span class="sw k-aero"></span>Letecké vrstvy · ${aero.length}${aero.length ? ' <button class="link" data-act="aero-off" type="button">vypnúť</button>' : ''}</h2>
      <div class="active-list">${aero.map((l) => rowHTML(l, true)).join('') || '<p class="empty small">Žiadne. Zapnite ich v záložke Letectvo.</p>'}</div>
      <h2 class="grp-title"><span class="sw k-base"></span>Prekrytia · ${ov.length}</h2>
      <div class="active-list">${ov.map((l) => rowHTML(l, true)).join('') || '<p class="empty small">Žiadne.</p>'}</div>
      <h2 class="grp-title"><span class="sw k-satellite"></span>Podklad</h2>
      <div class="active-list">${base.map((l) => rowHTML(l, true)).join('') || '<p class="empty small">Bez podkladu.</p>'}</div>
      ${state.base && byId.get(state.base)?.cc ? `<div class="ctl-row backdrop-row"><span>pozadie mimo pokrytia</span>${bdSel}<span></span></div>` : ''}`;
  }
  let aeroSig = '';
  function aeroVisible() {
    const v = map.getBounds();
    return CAT.layers.filter((l) => l.kind === 'aero')
      .filter((l) => live.has(l.id) || !state.aeroInView || !l.bbox || boundsOf(l).intersects(v))
      .filter((l) => live.has(l.id) || isVecType(l) || !(state.hideDown && l.status?.state === 'down'));
  }
  function renderAero() {
    if (!AERO) return '<p class="empty">Letecký modul (aero.js) sa nenačítal.</p>';
    const vis = aeroVisible();
    aeroSig = vis.map((l) => l.id).join(',');
    const hidden = CAT.layers.filter((l) => l.kind === 'aero').length - vis.length;
    const groups = AERO_GROUPS.map(([g, title]) => {
      const ls = vis.filter((l) => (l.group || 'chart') === g).sort((a, b) => (a.cc ? 1 : 0) - (b.cc ? 1 : 0) || (b.best - a.best) || (a.cc || '').localeCompare(b.cc || '') || a.name.localeCompare(b.name, 'sk'));
      if (!ls.length) return '';
      const n = ls.filter((l) => live.has(l.id)).length;
      return `<details class="agrp" data-agrp="${g}"${state.aeroClosed.has(g) ? '' : ' open'}><summary>${esc(title)} <span class="cnt">${n ? n + ' zapnuté · ' : ''}${ls.length}</span></summary>${ls.map((l) => rowHTML(l)).join('')}</details>`;
    }).join('');
    return AERO.headHTML() + `<h2 class="grp-title"><span class="sw k-aero"></span>Letecké vrstvy</h2>
      <div class="toggles aero-tog"><label><input type="checkbox" id="f-aero-view" ${state.aeroInView ? 'checked' : ''}> len vrstvy pre aktuálny výrez${hidden && state.aeroInView ? ` <span class="muted">(skrytých ${hidden})</span>` : ''}</label>
      <button class="link" data-act="aero-off" type="button">vypnúť letecké vrstvy</button></div>` + groups;
  }
  let renderQueued = false;
  function renderList() {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const q = state.q.trim().toLowerCase();
      const list = $('#list'); const top = list.scrollTop;
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
      $('#filters').hidden = state.tab !== 'base';
      list.innerHTML = state.tab === 'base' ? renderBase(q) : state.tab === 'aero' ? renderAero() : state.tab === 'library' ? (LIBRARY ? LIBRARY.render() : '<p class="empty">Modul knižnice sa nenačítal.</p>') : renderActive();
      $('#cnt-aero').textContent = CAT.layers.filter((l) => l.kind === 'aero' && live.has(l.id)).length || '';
      $('#cnt-lib').textContent = LIBRARY ? LIBRARY.count() || '' : '';
      list.scrollTop = top;
      if (state.tab === 'aero' && AERO) AERO.updateMessages();
    });
  }
  function renderChips() {
    $('#kind-chips').innerHTML = KINDS.map((k) => `<button type="button" class="chip" data-kind="${k}" aria-pressed="${state.kinds.has(k)}"><span class="sw k-${k}"></span>${KIND_SHORT[k]}</button>`).join('');
  }
  function renderHealth() {
    const s = CAT.stats || {};
    $('#n-ok').textContent = s.ok ?? '–'; $('#n-warn').textContent = s.warn ?? '–'; $('#n-down').textContent = s.down ?? '–';
    $('#cat-time').textContent = fmtUTC(CAT.generated);
    $('#cat-time').title = `Overených ${s.layers} vrstiev v ${s.countries} krajinách`;
  }

  // ------------------------------------------------------------------ legenda, pokrytie, info
  function renderLegend() {
    const el = $('#legend');
    if (!state.active.length) { el.hidden = true; return; }
    const items = state.active.map((id) => {
      const rec = live.get(id); if (!rec) return '';
      const l = rec.def; const st = l.status?.state || 'unknown';
      let extra = '';
      if (l.time && !l.time.static) extra += `<span class="when">snímka: ${esc(fmtTime(currentTime(rec)))}</span>`;
      if (l.type === 'terrarium' && l.mode === 'hypso') {
        const stops = HYPSO.filter(([v]) => v >= 0.01);
        extra += `<div class="ramp">${stops.map(([, c]) => `<span style="background:rgb(${c.map(Math.round).join(',')})"></span>`).join('')}</div>
          <div class="ramp-l">${stops.map(([v]) => `<span>${v < 1 ? 0 : v}</span>`).join('')}</div><span class="when">nadmorská výška [m]</span>`;
      }
      if (AERO && isVecType(l)) extra += AERO.legendHTML(rec);
      if (l.type === 'terrarium' && l.mode === 'slope') {
        let prev = 3;
        extra += `<div class="classes">${SLOPE.filter(([, c]) => c).map(([lim, c]) => { const r = `<div><i style="background:rgb(${c.join(',')})"></i>${prev}–${lim > 90 ? 90 : lim}°</div>`; prev = lim; return r; }).join('')}</div>`;
      }
      const role = id === state.backdrop ? ' <span class="muted">(pozadie)</span>' : id === state.base ? ' <span class="muted">(podklad)</span>' : '';
      return `<div class="lg-item"><span class="sw k-${l.kind}"></span><span>${esc(l.name)}${role}</span><i class="dot ${st}" title="${esc(statusTitle(l))}"></i>${extra}</div>`;
    }).join('');
    el.innerHTML = `<h2><button type="button" class="lg-toggle" aria-expanded="${!state.legendCollapsed}">Legenda · ${state.active.length}</button></h2>${items}`;
    el.classList.toggle('collapsed', !!state.legendCollapsed);
    el.hidden = false;
  }
  function geomLayer(l, style) {
    if (l.geom) return L.geoJSON(l.geom, { style, interactive: false });
    const b = boundsOf(l); return b ? L.rectangle(b, { ...style, interactive: false }) : null;
  }
  const kindColor = (k) => getComputedStyle(document.documentElement).getPropertyValue('--k-' + k).trim() || '#555';
  function renderCoverage() {
    coverageGroup.clearLayers();
    if (!state.showCoverage) return;
    for (const id of state.active) {
      const l = byId.get(id); if (!l || !l.cc) continue;
      const g = geomLayer(l, { color: kindColor(l.kind), weight: 1.5, dashArray: '4 4', fill: false }); if (g) coverageGroup.addLayer(g);
    }
  }
  function showHover(id) {
    hoverGroup.clearLayers();
    const l = byId.get(id); if (!l || !l.cc) return;
    const g = geomLayer(l, { color: kindColor(l.kind), weight: 2, fillOpacity: 0.08 }); if (g) hoverGroup.addLayer(g);
  }
  function showInfo(id) {
    const l = byId.get(id); if (!l) return;
    const s = l.status || {}; const lic = l.license || {}; const t = timeOf(l);
    const spark = (s.h || '').split('').map((c) => `<i class="${c}" title="${{ o: 'dostupná', w: 'varovanie', d: 'nedostupná' }[c] || ''}"></i>`).join('');
    const svc = l.type === 'terrarium' ? 'výškové dlaždice Terrarium, reliéf počítaný v prehliadači' : l.type === 'wms' ? 'WMS (EPSG:3857)'
      : l.type === 'rainviewer' ? 'RainViewer API – radarové snímky po 10 min' : l.source === 'arcgis' ? 'ArcGIS REST – dotaz podľa výrezu (GeoJSON)' : l.type === 'vector' ? 'hodinové údaje data/aero/' : 'dlaždicová služba XYZ/WMTS';
    const addr = l.source === 'arcgis' ? (l.urls || []).map((u) => `<code>${esc(u)}</code>`).join('<br>') : `<code>${esc(l.url || (l.type === 'vector' ? 'data/aero/' : ''))}</code>`;
    $('#info-body').innerHTML = `
      <h3 id="info-title">${esc(l.name)}</h3>
      <div class="small" style="color:var(--muted)"><span class="sw k-${l.kind}"></span> ${esc(CAT.kinds?.[l.kind] || KIND_SHORT[l.kind])} · ${esc(regionName(l.cc))} · ${isBase(l) ? 'podklad' : l.kind === 'aero' ? 'letecká vrstva' : 'prekrytie'}</div>
      <dl>
        <dt>Stav</dt><dd><i class="dot ${s.state || 'unknown'}"></i> ${esc(statusTitle(l))}${s.by ? ` <span class="small">(${esc(s.by)})</span>` : ''}</dd>
        ${spark ? `<dt>Posledné kontroly</dt><dd><div class="spark" aria-label="história dostupnosti">${spark}</div></dd>` : ''}
        <dt>Zdroj</dt><dd>${l.attribution?.url ? `<a href="${esc(l.attribution.url)}" target="_blank" rel="noopener">${esc(l.attribution.text)}</a>` : esc(l.attribution?.text || '–')}</dd>
        <dt>Licencia</dt><dd>${lic.url ? `<a href="${esc(lic.url)}" target="_blank" rel="noopener">${esc(lic.name)}</a>` : esc(lic.name || 'neuvedená')}</dd>
        ${years(l) ? `<dt>Obdobie</dt><dd>${esc(years(l))}</dd>` : ''}
        ${t && !t.static ? `<dt>Čas</dt><dd>najnovší: ${esc(fmtTime(t.latest))}${t.period ? ` · krok ${esc(t.period)}` : ''}</dd>` : ''}
        <dt>Priblíženie</dt><dd>${isVecType(l) ? `od z${l.minz || 0}` : `z${l.minz ?? 0} – z${l.maxz ?? 19}`}</dd>
        <dt>Služba</dt><dd>${svc}${s.cors === false ? ' · bez CORS' : ''}</dd>
        <dt>Adresa</dt><dd>${addr}</dd>
        ${l.description ? `<dt>Popis</dt><dd>${esc(l.description)}</dd>` : ''}
        <dt>Katalóg</dt><dd>${l.src === 'eli' ? 'OSM Editor Layer Index' : 'kurátorský zoznam AERO-wiki'} · <code>${esc(l.id)}</code></dd>
      </dl>
      <p style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" type="button" data-info-act="toggle">${live.has(l.id) ? (l.id === state.base ? 'Je podkladom' : 'Odobrať z mapy') : isBase(l) ? 'Nastaviť ako podklad' : 'Pridať na mapu'}</button>
        ${l.bbox ? '<button class="btn" type="button" data-info-act="zoom">Priblížiť na pokrytie</button>' : ''}
      </p>`;
    $('#info').hidden = false; $('#info').dataset.id = id;
  }

  // ------------------------------------------------------------------ klik do mapy: najprv letecké informácie, potom podklady
  function inRing(x, y, r) {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) ins = !ins;
    }
    return ins;
  }
  function covers(l, lon, lat) {
    const b = l.bbox; if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
    if (!l.geom) return true;
    const polys = l.geom.type === 'Polygon' ? [l.geom.coordinates] : l.geom.coordinates;
    return polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)));
  }
  map.on('click', (e) => {
    const { lat } = e.latlng; const lon = e.latlng.wrap().lng;
    const here = CAT.layers.filter((l) => l.cc && covers(l, lon, lat) && (l.status?.state !== 'down' || live.has(l.id)));
    here.sort((a, b) => (a.kind === 'aero' ? -1 : 0) - (b.kind === 'aero' ? -1 : 0) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || sortLayers(a, b));
    const nGlobal = CAT.layers.filter((l) => !l.cc && l.kind !== 'aero' && l.status?.state !== 'down').length;
    const items = here.slice(0, 60).map((l) => `<li><input type="${isBase(l) ? 'radio' : 'checkbox'}" name="here-base" data-here="${esc(l.id)}" ${live.has(l.id) ? 'checked' : ''} aria-label="Zobraziť ${esc(l.name)}"><span class="sw k-${l.kind}"></span><span>${esc(l.name)} <span class="muted mono">${esc(years(l))}</span></span></li>`).join('');
    const ai = AERO ? AERO.clickInfo(e.latlng) : { html: '', count: 0, more: Promise.resolve('') };
    const topo = `<details class="here-topo"><summary>Vrstvy s pokrytím v tomto bode · ${here.length} <span class="muted">(+ ${nGlobal} globálnych)</span></summary>
      ${here.length ? `<ul>${items}</ul>` : '<p class="muted">Žiadna národná ani regionálna vrstva.</p>'}</details>`;
    const make = (ctxHTML) => `<div class="here"><h4>Na tomto mieste</h4>
      <p class="muted mono small">${lat.toFixed(5)}, ${lon.toFixed(5)}${AERO ? ' · platné k ' + esc(AERO.timeLabel()) : ''}</p>
      <section class="here-aero">${ai.html}${ctxHTML}</section>${topo}</div>`;
    const pp = L.popup({ maxWidth: 420, minWidth: 280, maxHeight: Math.max(240, Math.min(560, map.getSize().y - 90)), className: 'here-pop', autoPanPaddingTopLeft: [20, 50] })
      .setLatLng(e.latlng).setContent(make('<p class="muted small here-wait">Načítavajú sa NOTAM, SIGMET a najbližšie letiská…</p>')).openOn(map);
    ai.more.then((html) => {
      if (!pp.isOpen()) return;
      const empty = !html && !ai.count ? '<p class="muted small">Žiadne letecké informácie v tomto bode. Zapnite vrstvy v záložke Letectvo alebo pozrite Knižnicu zdrojov.</p>' : '';
      pp.setContent(make(html || empty));
    });
  });
  document.addEventListener('change', (e) => {
    const id = e.target?.dataset?.here; if (id) { if (e.target.type === 'radio') activate(id); else toggle(id); }
  });

  // ------------------------------------------------------------------ udalosti panelu
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'clear') { [...state.active].filter((id) => id !== state.base && id !== state.backdrop).forEach((id) => deactivate(id, { batch: true })); afterChange(); return; }
    if (act === 'aero-off') { [...state.active].filter((id) => byId.get(id)?.kind === 'aero' && id !== state.base).forEach((id) => deactivate(id, { batch: true })); afterChange(); return; }
    if (act === 'zoom-cc') {
      e.preventDefault();
      const cc = btn.closest('details').dataset.cc; const b = CAT.countries?.[cc]?.bbox;
      if (b) map.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
      return;
    }
    const row = btn.closest('.lr'); if (!row) return;
    const id = row.dataset.id;
    if (act === 'toggle') { if (btn.tagName !== 'INPUT') e.preventDefault(); toggle(id); }
    else if (act === 'zoom') { const b = boundsOf(byId.get(id)); if (b) map.fitBounds(b, { maxZoom: 14 }); }
    else if (act === 'info') showInfo(id);
    else if (act === 'up') move(id, -1);
    else if (act === 'down') move(id, +1);
  });
  list.addEventListener('input', (e) => {
    const el = e.target; const ctl = el.dataset.ctl; if (!ctl) return;
    const rec = live.get(el.closest('.lr')?.dataset.id); if (!rec) return;
    if (ctl === 'opacity') { rec.opacity = el.value / 100; el.nextElementSibling.textContent = el.value + ' %'; applySymbology(rec); }
    if (ctl === 'time') {
      const steps = timeSteps(rec.def); const idx = steps.length - 1 - +el.value;
      rec.timeMode = idx === 0 ? 'latest' : 'pinned'; rec.time = steps[idx];
      el.nextElementSibling.textContent = idx === 0 ? 'najnovšia' : '−' + idx;
      const lbl = el.closest('.ctl-row').nextElementSibling?.querySelector('.mono'); if (lbl) lbl.textContent = fmtTime(steps[idx]);
      clearTimeout(rec._tt); rec._tt = setTimeout(() => { rec.layer.setTimeValue(currentTime(rec)); renderLegend(); saveHash(); }, 250);
    }
  });
  list.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'f-coverage') { state.showCoverage = el.checked; store.set('showCoverage', el.checked); renderCoverage(); return; }
    if (el.id === 'f-aero-view') { state.aeroInView = el.checked; store.set('aeroInView', el.checked); renderList(); return; }
    if (el.id === 'f-backdrop') { setBackdrop(el.value || null); return; }
    const ctl = el.dataset.ctl; if (!ctl || ctl === 'opacity' || ctl === 'time') return;
    const rec = live.get(el.closest('.lr')?.dataset.id); if (!rec) return;
    rec[ctl] = el.value; applySymbology(rec);
  });
  list.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.matches?.('details.agrp')) { d.open ? state.aeroClosed.delete(d.dataset.agrp) : state.aeroClosed.add(d.dataset.agrp); store.set('aeroClosed', [...state.aeroClosed]); return; }
    if (!d.matches?.('details.country')) return;
    const cc = d.dataset.cc;
    if (d.open) { state.open.add(cc); const q = state.q.trim().toLowerCase(); const name = regionName(cc).toLowerCase();
      const ls = CAT.layers.filter((l) => l.cc === cc && l.kind !== 'aero' && passes(l, q && name.includes(q) ? '' : q)).sort(sortLayers);
      d.querySelector('.layers').innerHTML = ls.map((l) => rowHTML(l)).join(''); }
    else state.open.delete(cc);
    store.set('openCountries', [...state.open]);
  }, true);
  list.addEventListener('mouseover', (e) => { const r = e.target.closest('.lr'); if (r && r.dataset.id !== list._hover) { list._hover = r.dataset.id; showHover(r.dataset.id); } });
  list.addEventListener('mouseleave', () => { list._hover = null; hoverGroup.clearLayers(); });

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; store.set('tab', state.tab); list.scrollTop = 0; renderList(); }));
  document.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => { state.sub = b.dataset.sub; store.set('baseSub', state.sub); list.scrollTop = 0; renderList(); }));
  let qTimer = 0;
  $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; renderList(); }, 160); });
  $('#kind-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.kind; state.kinds.has(k) ? state.kinds.delete(k) : state.kinds.add(k);
    if (!state.kinds.size) KINDS.forEach((x) => state.kinds.add(x));
    store.set('kinds', [...state.kinds]); renderChips(); renderList();
  });
  $('#f-hide-down').checked = state.hideDown; $('#f-open').checked = state.openOnly;
  $('#f-hide-down').addEventListener('change', (e) => { state.hideDown = e.target.checked; store.set('hideDown', state.hideDown); renderList(); });
  $('#f-open').addEventListener('change', (e) => { state.openOnly = e.target.checked; store.set('openOnly', state.openOnly); renderList(); });
  $('#info-close').innerHTML = svg.close;
  $('#info-close').addEventListener('click', () => { $('#info').hidden = true; });
  $('#info').addEventListener('click', (e) => {
    const a = e.target.closest('[data-info-act]'); if (!a) return; const id = $('#info').dataset.id;
    if (a.dataset.infoAct === 'toggle') { toggle(id); showInfo(id); }
    if (a.dataset.infoAct === 'zoom') { const b = boundsOf(byId.get(id)); if (b) map.fitBounds(b, { maxZoom: 14 }); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#info').hidden = true; });
  $('#legend').addEventListener('click', (e) => { if (e.target.closest('.lg-toggle')) { state.legendCollapsed = !state.legendCollapsed; store.set('legendCollapsed', state.legendCollapsed); renderLegend(); } });
  $('#sheet-handle').addEventListener('click', () => {
    const p = $('#panel'); p.classList.toggle('collapsed'); $('#app').classList.toggle('sheet-collapsed', p.classList.contains('collapsed'));
    $('#sheet-handle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
    setTimeout(() => map.invalidateSize(), 250);
  });
  map.on('mousemove', (e) => { $('#readout').textContent = `${e.latlng.lat.toFixed(5)}°  ${e.latlng.wrap().lng.toFixed(5)}°  z${map.getZoom()}`; });
  // pri posune mapy: stav v URL; zoznam leteckých vrstiev a knižnicu prekresliť len ak sa zmenil obsah výrezu
  let mvTimer = 0;
  map.on('moveend', () => {
    saveHash();
    clearTimeout(mvTimer);
    mvTimer = setTimeout(() => {
      if (state.tab === 'aero' && state.aeroInView && aeroVisible().map((l) => l.id).join(',') !== aeroSig) renderList();
      if (state.tab === 'library') renderList();
    }, 350);
  });

  // ------------------------------------------------------------------ stav v URL
  function saveHash() {
    const c = map.getCenter();
    const ids = state.active.filter((id) => id !== state.base && id !== state.backdrop).join(',');
    const h = `#map=${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}` + (state.base ? `&b=${encodeURIComponent(state.base)}` : '') +
      (state.backdrop ? `&bg=${encodeURIComponent(state.backdrop)}` : '') + (ids ? `&l=${encodeURIComponent(ids)}` : '');
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function loadHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const m = (p.get('map') || '').split('/').map(Number);
    if (m.length === 3 && m.every(Number.isFinite)) map.setView([m[1], m[2]], m[0]);
    const ids = p.get('l');
    if (ids === null && !p.get('b')) return null;
    return { base: p.get('b'), backdrop: p.get('bg'), ids: (ids || '').split(',').filter((id) => byId.has(id)) };
  }

  // ------------------------------------------------------------------ hodinová obnova katalógu
  function mergeCatalog(c) {
    CAT = c; byId = new Map(CAT.layers.map((l) => [l.id, l]));
    for (const [id, rec] of live) {
      const def = byId.get(id); if (!def) continue;
      const urlChanged = def.url !== rec.def.url;
      rec.def = def;
      if (rec.layer instanceof TemplateLayer) {
        rec.layer._def = def;
        if (urlChanged) rec.layer.redraw();
        rec.layer.setTimeValue(currentTime(rec));
      }
    }
    // čas zistený v prehliadači ponecháme, len ak je novší než katalóg
    for (const [id, t] of timeInfo) { const k = byId.get(id)?.time?.latest; if (k && k !== 'default' && k >= (t.latest || '')) timeInfo.delete(id); }
    renderHealth(); renderList(); renderLegend();
  }
  let reloadTimer = 0;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    const next = Date.parse(CAT.next || '');
    let wait = Number.isFinite(next) ? next - Date.now() + 3 * 60 * 1000 : 60 * 60 * 1000;
    if (wait < 5 * 60 * 1000 || wait > 75 * 60 * 1000) wait = 60 * 60 * 1000;
    state.nextReload = Date.now() + wait;
    reloadTimer = setTimeout(() => reloadCatalog(false), wait);
    tickCountdown();
  }
  function reloadCatalog(manual) {
    const s = document.createElement('script');
    s.src = 'data/catalog.js?t=' + Date.now();
    s.onload = () => {
      const c = window.AEROWIKI_CATALOG; s.remove();
      if (c && Array.isArray(c.layers)) {
        const newer = c.generated !== CAT.generated;
        mergeCatalog(c);
        if (manual) toast(newer ? `Katalóg aktualizovaný: ${fmtUTC(c.generated)}.` : 'Katalóg je aktuálny.');
      }
      scheduleReload();
    };
    s.onerror = () => { s.remove(); if (manual) toast('Katalóg sa nepodarilo načítať. Ďalší pokus o hodinu.'); scheduleReload(); };
    document.head.appendChild(s);
    refreshTimes(true);
    if (AERO) AERO.reload().then((changed) => { if (changed) { renderList(); renderLegend(); } });
    if (LIBRARY) LIBRARY.reload().then((ok) => { if (ok && state.tab === 'library') renderList(); });
  }
  function tickCountdown() {
    const ms = (state.nextReload || 0) - Date.now();
    $('#cat-next').textContent = ms > 0 ? `o ${Math.max(1, Math.round(ms / 60000))} min (${fmtLocalTime(state.nextReload)})` : 'prebieha';
  }
  $('#btn-refresh').addEventListener('click', () => { reloadCatalog(true); refreshTimes(false); });
  setInterval(tickCountdown, 30 * 1000);
  setInterval(() => { if ([...live.values()].some((r) => r.def.time && !r.def.time.static)) refreshTimes(true); }, TIME_POLL_MS);

  // ------------------------------------------------------------------ štart
  renderChips(); renderHealth();
  if (AERO) {
    AERO.init({
      map, esc, store, list: $('#list'),
      rerender: () => { renderList(); renderLegend(); },
      onLayerData: (layer) => {
        if (layer && layer.def) document.querySelectorAll(`.tile-stat[data-id="${CSS.escape(layer.def.id)}"]`).forEach((el) => { el.textContent = vecStat({ layer, def: layer.def }); });
        renderLegend();
      },
    }).then(() => { if (state.tab === 'aero') renderList(); });
  }
  if (LIBRARY) {
    LIBRARY.init({
      map, esc, store, regionName, list: $('#list'),
      rerender: () => renderList(),
      hasLayer: (id) => byId.has(id), isActive: (id) => live.has(id), layersOn, toggleLayers,
    }).then(() => { if (state.tab === 'library') renderList(); });
  }
  const fromHash = loadHash();
  if (fromHash) {
    if (fromHash.backdrop && byId.has(fromHash.backdrop)) setBase(fromHash.backdrop, { quiet: true });
    if (fromHash.base && byId.has(fromHash.base)) setBase(fromHash.base, { quiet: true });
    [...fromHash.ids].reverse().forEach((id) => activate(id, { quiet: true, batch: true }));
    // poradie v rámci úrovne podľa URL
    const pos = new Map(fromHash.ids.map((id, i) => [id, i]));
    state.active.sort((a, b) => tier(a) - tier(b) || (pos.get(a) ?? 99) - (pos.get(b) ?? 99));
  } else {
    if (byId.has(DEFAULT_BASE)) setBase(DEFAULT_BASE, { quiet: true });
    [...DEFAULT_LAYERS].reverse().forEach((id) => byId.has(id) && activate(id, { quiet: true, batch: true }));
  }
  afterChange();
  scheduleReload();
})();
