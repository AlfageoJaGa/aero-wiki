/* AERO-wiki – letecké vrstvy a letecké informácie.
   - METAR, TAF, SIGMET/AIRMET, NOTAM, letiská a navigačné zariadenia, openAIP: data/aero/ (scripts/build_aero.py, každú hodinu),
   - živé vektorové služby ArcGIS (LPS SR, FAA, ENAIRE, CAA SI …) dotazované podľa výrezu priamo z prehliadača,
   - zrážkový radar RainViewer.
   Všetko sa filtruje podľa zvoleného času platnosti (teraz alebo posun dopredu); pri „teraz“ sa prepočítava každú minútu.
   Plošné objekty (priestory, zóny, NOTAM, SIGMET) nepreberajú klik – klik do mapy zobrazí všetky letecké informácie
   v danom bode naraz (clickInfo), až potom podklady. Bodové objekty (letiská, stanice, prekážky) majú vlastný popup. */
(() => {
  'use strict';
  const DATA = 'data/aero/';
  const NM = 1852;
  const EMPTY = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const CAT_COLORS = { VFR: '#2e9e4f', MVFR: '#1f6fd1', IFR: '#d7263d', LIFR: '#b11fb5' };
  const CAT_RANK = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };
  const NOTAM_CATS = {
    airspace: ['Vzdušný priestor', '#c2185b'], obstacle: ['Prekážky', '#e65100'], warning: ['Varovania (lety, UAS, cvičenia)', '#b8860b'],
    nav: ['Navigácia a spojenie', '#1565c0'], aerodrome: ['Letiská', '#2e7d32'], procedure: ['Postupy a ATS', '#6a1b9a'], other: ['Ostatné', '#546e7a'],
  };
  const Q_CAT = { A: 'airspace', R: 'airspace', O: 'obstacle', W: 'warning', N: 'nav', I: 'nav', G: 'nav', C: 'nav', M: 'aerodrome', F: 'aerodrome', L: 'aerodrome', P: 'procedure', S: 'procedure' };
  const HAZ = {
    TS: ['búrky', '#d7263d'], CONVECTIVE: ['konvekcia', '#d7263d'], TURB: ['turbulencia', '#e07b00'], 'TURB-HI': ['turbulencia vysoko', '#e07b00'],
    'TURB-LO': ['turbulencia nízko', '#e07b00'], LLWS: ['strih vetra', '#e07b00'], ICE: ['námraza', '#2a7fd4'], FZLVL: ['nulová izoterma', '#2a7fd4'],
    VA: ['sopečný popol', '#7a5230'], TC: ['tropická cyklóna', '#8e3bd1'], MTW: ['horské vlny', '#3c9c8f'], DS: ['prachová búrka', '#c9a227'],
    SS: ['piesočná búrka', '#c9a227'], RDOACT: ['rádioaktívny oblak', '#000000'], IFR: ['IFR podmienky', '#6b7b8c'], MT_OBSC: ['zakryté hory', '#6b7b8c'],
    SFC_WIND: ['prízemný vietor', '#3c9c8f'],
  };
  const AD_STYLE = { L: [7, '#123c69'], M: [5.5, '#1f5f99'], S: [4, '#3d7fb8'], H: [3.5, '#7b3fa0'], W: [4, '#16857a'] };
  const AD_NAME = { L: 'veľké letisko', M: 'stredné letisko', S: 'malé letisko', H: 'heliport', W: 'vodné letisko' };
  const OAIP_CLASS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'SUA', 'SUA'];
  const OAIP_TYPE = { 0: 'iný', 1: 'obmedzený (R)', 2: 'nebezpečný (D)', 3: 'zakázaný (P)', 4: 'CTR', 5: 'TMZ', 6: 'RMZ', 7: 'TMA', 8: 'TRA',
    9: 'TSA', 10: 'FIR', 11: 'UIR', 12: 'ADIZ', 13: 'ATZ', 14: 'MATZ', 15: 'letová cesta', 16: 'MTR', 17: 'výstražný', 18: 'varovný', 19: 'chránený',
    20: 'HTZ', 21: 'plachtársky sektor', 22: 'TRP', 23: 'TIZ', 24: 'TIA', 25: 'MTA', 26: 'CTA', 27: 'sektor ACC', 28: 'športový', 29: 'nízky prelet', 30: 'MRT', 31: 'TFR' };
  // poradie skupín v informácii o mieste a v správach
  const GROUP_ORDER = { notam: 0, uas: 1, aip: 2, met: 3, chart: 4 };
  const GROUP_LABEL = { notam: 'NOTAM, rezervácie a výstrahy', uas: 'Zóny pre drony', aip: 'Vzdušné priestory a prekážky', met: 'Počasie', chart: 'Mapy' };
  const MSG_TYPES = { sigmet: 'SIGMET', notam: 'NOTAM', res: 'Rezervácie', metar: 'METAR', taf: 'TAF' };
  const MSG_BADGE = { sigmet: 'SIGMET', notam: 'NOTAM', res: 'REZERV', metar: 'METAR', taf: 'TAF' };

  let ctx = null;
  let meta = null;
  const files = new Map();      // súbor -> Promise s dátami
  const layers = new Set();     // aktívne letecké vrstvy (AeroLayer, RainLayer)
  const st = { offsetH: 0, notamCats: null, msgTypes: null, msgOpen: true, srcOpen: false };

  const now = () => new Date(Date.now() + st.offsetH * 3600e3);
  const tms = (v) => (v == null || v === '' ? NaN : typeof v === 'number' ? v : /^\d{10,13}$/.test(String(v)) ? +v : Date.parse(v));
  const minsAgo = (iso) => Math.round((Date.now() - tms(iso)) / 60000);
  const fmtZ = (v) => { const t = tms(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–'; };
  const fmtShort = (v) => { const t = tms(v); if (!Number.isFinite(t)) return '–'; const x = new Date(t).toISOString(); return `${x.slice(8, 10)}.${x.slice(5, 7)}. ${x.slice(11, 16)}`; };
  const fl = (v) => (v === 0 ? 'GND' : v >= 999 ? 'UNL' : 'FL' + String(v).padStart(3, '0'));
  const ft = (v) => (v == null || v === '' ? '–' : /^\d+$/.test(String(v)) ? (+v >= 18000 ? 'FL' + Math.round(+v / 100) : (+v).toLocaleString('sk-SK') + ' ft') : String(v));
  const validAt = (b, c, t) => { const B = tms(b), C = tms(c); return (!Number.isFinite(B) || B <= t) && (!Number.isFinite(C) || t < C); };

  function fetchJSON(file) {
    const v = meta?.generated || String(Math.floor(Date.now() / 3600e3));
    const key = file + '|' + v;
    if (!files.has(key)) {
      files.set(key, fetch(DATA + file + '?v=' + encodeURIComponent(v), { cache: 'no-cache' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
      files.get(key).catch(() => files.delete(key));
    }
    return files.get(key);
  }
  async function loadMeta() {
    try {
      const r = await fetch(DATA + 'meta.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = await r.json();
      const changed = !meta || m.generated !== meta.generated;
      meta = m;
      if (changed) files.clear();
      return changed;
    } catch (e) {
      meta = meta || { error: String(e) };
      return false;
    }
  }
  const has = (src) => { const s = meta?.sources?.[src]; return !!s && s.state !== 'off' && (s.count == null || s.count > 0 || src === 'airports'); };

  // NOTAM celého sveta sú v dlaždiciach (data/aero/notam/x_y.json, veľkosť v index.json); načítajú sa len dlaždice výrezu.
  // Pri veľkom výreze alebo hustých oblastiach sa namiesto správ zobrazia súčty (bubliny) podľa index.json.
  const NOTAM_MAX_TILES = 64;
  const NOTAM_MAX_FEATURES = 6000;
  function tileKeys(bounds, deg) {
    const s = Math.max(-90, bounds.getSouth()), n = Math.min(89.999, bounds.getNorth());
    let w = bounds.getWest(), e = bounds.getEast();
    if (e - w >= 360) { w = -180; e = 179.999; }
    const nx = 360 / deg, out = new Set();
    for (let x = Math.floor((w + 180) / deg); x <= Math.floor((e + 180) / deg); x++) {
      for (let y = Math.floor((s + 90) / deg); y <= Math.floor((n + 90) / deg); y++) out.add((((x % nx) + nx) % nx) + '_' + y);
    }
    return [...out];
  }
  async function notamsIn(bounds, o = {}) {
    const maxTiles = o.maxTiles ?? NOTAM_MAX_TILES, maxFeatures = o.maxFeatures ?? NOTAM_MAX_FEATURES;
    const idx = await fetchJSON('notam/index.json');
    // dlaždice všetkých úrovní (10°, 5°, 2,5° …); husté oblasti sú rozdelené na menšie, dlaždice sa neprekrývajú
    const levels = idx.levels || [String(idx.tile_deg || 10)];
    const keys = levels.flatMap((lv) => tileKeys(bounds, parseFloat(lv)).map((k) => lv + '_' + k)).filter((k) => idx.tiles && idx.tiles[k]);
    const inTiles = keys.reduce((a, k) => a + idx.tiles[k], 0);
    if (keys.length > maxTiles || inTiles > maxFeatures) return { features: [], capped: true, inTiles, tiles: keys.length, keys, idx };
    const parts = await Promise.all(keys.map((k) => fetchJSON('notam/' + k + '.json').catch(() => null)));
    const seen = new Set(); const features = [];
    for (const part of parts) {
      for (const f of part?.features || []) {
        const id = f.properties.id + '|' + f.properties.loc;
        if (seen.has(id)) continue;
        seen.add(id); features.push(f);
      }
    }
    return { features, capped: false, inTiles, tiles: keys.length, keys, idx };
  }
  const NOTAM_POINT = { maxTiles: 4, maxFeatures: Infinity };
  // platnosť NOTAM v čase t; pri odhadovanom konci (EST) zostáva NOTAM v platnosti, kým ho vydavateľ nezruší alebo nenahradí
  // (ICAO PANS-AIM; FAA NOTAM Search ho naďalej vedie ako aktívny) – zobrazí sa s upozornením
  const notamValid = (p, t) => { const b = tms(p.b), c = p.c ? tms(p.c) : Infinity; return (!Number.isFinite(b) || b <= t) && (t < c || !!p.est); };
  const notamOverdue = (p, t = now().getTime()) => !!(p.est && p.c && tms(p.c) <= t);
  const notamSub = (p) => [p.subj, p.cond].filter(Boolean).join(' – ');
  // súčty NOTAM v bunkách (pri oddialení alebo v hustých oblastiach): začína sa najjemnejšou dlaždicou vo výreze
  // a bunka sa zväčšuje, kým ich je najviac ~160; klik na bunku priblíži jej oblasť
  function notamCells(r, bounds) {
    const keyDeg = (k) => parseFloat(k.split('_')[0]);
    const center = (k) => { const [d, x, y] = k.split('_').map(Number); return r.idx.centers?.[k] || [-90 + (y + 0.5) * d, -180 + (x + 0.5) * d]; };
    let G = Math.min(...r.keys.map(keyDeg)), cells;
    for (;;) {
      cells = new Map();
      for (const k of r.keys) {
        const n = r.idx.tiles[k], c0 = center(k);
        const cx = Math.floor((c0[1] + 180) / G), cy = Math.floor((c0[0] + 90) / G), ck = cx + '_' + cy;
        const c = cells.get(ck) || { n: 0, lat: 0, lon: 0, cx, cy };
        c.n += n; c.lat += c0[0] * n; c.lon += c0[1] * n;
        cells.set(ck, c);
      }
      if (cells.size <= 160 || G >= 90) break;
      G *= 2;
    }
    const vc = bounds.getCenter().lng;
    return [...cells.values()].map((c) => {
      const lon = c.lon / c.n, sh = Math.round((vc - lon) / 360) * 360; // kópia sveta najbližšie k stredu výrezu
      const s0 = -90 + c.cy * G, w0 = -180 + c.cx * G + sh;
      return { n: c.n, lat: c.lat / c.n, lon: lon + sh, bounds: L.latLngBounds([s0, w0], [Math.min(90, s0 + G), w0 + G]) };
    });
  }

  // ------------------------------------------------------------------ AIRAC (ICAO 28-dňový cyklus)
  function airac(d = new Date()) {
    const epoch = Date.UTC(2024, 0, 25);
    const day = 864e5;
    const idx = Math.floor((d.getTime() - epoch) / (28 * day));
    const eff = new Date(epoch + idx * 28 * day);
    const jan1 = Date.UTC(eff.getUTCFullYear(), 0, 1);
    const k = Math.ceil((jan1 - epoch) / (28 * day));
    const first = epoch + k * 28 * day;
    const seq = Math.round((eff.getTime() - first) / (28 * day)) + 1;
    return { cycle: String(eff.getUTCFullYear() % 100).padStart(2, '0') + String(seq).padStart(2, '0'),
      effective: eff.toISOString().slice(0, 10), next: new Date(eff.getTime() + 28 * day).toISOString().slice(0, 10) };
  }

  // ------------------------------------------------------------------ vrstva s vektorovými údajmi
  const MOVE_SOURCES = new Set(['airports', 'arcgis', 'notam']);
  const TIMED_SOURCES = new Set(['taf', 'sigmet', 'notam', 'arcgis']);
  const AeroLayer = L.LayerGroup.extend({
    initialize(def, pane) {
      L.LayerGroup.prototype.initialize.call(this);
      this.def = def; this.paneName = pane; this.op = 1; this.count = 0; this.total = 0; this.note = null;
      this.renderer = L.canvas({ pane, padding: 0.4 });
      this.msgs = [];
    },
    onAdd(map) {
      L.LayerGroup.prototype.onAdd.call(this, map);
      this._mv = () => { if (MOVE_SOURCES.has(this.def.source)) { clearTimeout(this._mvT); this._mvT = setTimeout(() => this.refresh(), 250); } };
      map.on('moveend', this._mv);
      layers.add(this);
      this.refresh();
    },
    onRemove(map) {
      map.off('moveend', this._mv);
      layers.delete(this);
      this.msgs = [];
      L.LayerGroup.prototype.onRemove.call(this, map);
      scheduleMessages();
    },
    setOpacity(o) {
      this.op = o;
      this.eachLayer((l) => { if (l.setStyle) l.setStyle({ opacity: o, fillOpacity: o * (l.options.baseFill ?? 0.2) }); });
      return this;
    },
    async refresh() {
      // kým je otvorený popup niektorého objektu, vrstvu neprekresľujeme (popup by sa zavrel)
      if (this._popupOpen) { this._pending = true; return; }
      const seq = (this._seq = (this._seq || 0) + 1);
      let items;
      this.note = null;
      try { items = await build[this.def.source](this); } catch (e) {
        if (seq === this._seq) { this.clearLayers(); this.msgs = []; this.error = String(e.message || e); ctx.onLayerData(this); }
        return;
      }
      if (seq !== this._seq || !this._map) return;
      this.clearLayers(); this.error = null;
      items.forEach((l) => {
        l.on('popupopen', () => { this._popupOpen = true; });
        l.on('popupclose', () => { this._popupOpen = false; if (this._pending) { this._pending = false; this.refresh(); } });
        this.addLayer(l);
      });
      this.count = items.filter((l) => l.options.counted !== false).length;
      ctx.onLayerData(this);
      scheduleMessages();
    },
  });

  // zrážkový radar RainViewer – snímka najbližšia zvolenému času (posledné ~2 h po 10 min)
  let rvPromise = null, rvAt = 0;
  function rainFrames() {
    if (!rvPromise || Date.now() - rvAt > 4 * 60e3) {
      rvAt = Date.now();
      rvPromise = fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      rvPromise.catch(() => { rvPromise = null; });
    }
    return rvPromise;
  }
  const RainLayer = L.TileLayer.extend({
    initialize(def, pane, extra) {
      L.TileLayer.prototype.initialize.call(this, EMPTY, { pane, maxNativeZoom: def.maxz || 7, maxZoom: 21, opacity: 0.8, errorTileUrl: EMPTY, keepBuffer: 1, ...extra });
      this.def = def; this.count = null; this.frame = null;
    },
    onAdd(map) {
      L.TileLayer.prototype.onAdd.call(this, map);
      layers.add(this); this.refresh();
      this._iv = setInterval(() => this.refresh(), 5 * 60e3);
    },
    onRemove(map) { clearInterval(this._iv); layers.delete(this); L.TileLayer.prototype.onRemove.call(this, map); },
    async refresh() {
      try {
        const j = await rainFrames();
        const frames = [...(j.radar?.past || []), ...(j.radar?.nowcast || [])];
        if (!frames.length) throw new Error('bez snímok');
        const t = now().getTime() / 1000;
        let f = frames[0];
        for (const x of frames) if (x.time <= t + 300) f = x;
        this.future = t > frames[frames.length - 1].time + 900;
        this.frame = f; this.count = frames.length; this.error = null;
        const url = `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
        if (url !== this._url) this.setUrl(url);
      } catch (e) { this.error = String(e.message || e); }
      ctx.onLayerData(this);
    },
  });

  function opts(layer, extra) {
    return { pane: layer.paneName, renderer: layer.renderer, ...extra };
  }
  // area = plošný objekt (neberie klik; zobrazí sa v informácii o mieste), inak bodový objekt s vlastným popupom
  function style(layer, color, o = {}) {
    const fill = o.fill ?? 0.18;
    return opts(layer, { color, weight: o.weight ?? 1.5, opacity: layer.op, fillColor: color, fillOpacity: fill * layer.op, baseFill: fill,
      dashArray: o.dash, counted: o.counted, bubblingMouseEvents: false, interactive: !o.area });
  }
  // popis objektu pre klik do mapy a zoznam správ
  function tag(l, layer, info) { l._ai = { group: layer.def.group || 'aip', layer: layer.def.name, ...info }; return l; }
  const esc = (s) => ctx.esc(s);
  const row = (k, v) => (v == null || v === '' ? '' : `<tr><th>${esc(k)}</th><td>${v}</td></tr>`);
  const pop = (title, sub, rows, raw) => `<div class="aero-pop"><h4>${title}</h4>${sub ? `<p class="muted">${sub}</p>` : ''}
    <table>${rows.join('')}</table>${raw ? `<pre>${esc(raw)}</pre>` : ''}</div>`;
  const body = (sub, rows, raw) => `${sub ? `<p class="muted">${sub}</p>` : ''}<table>${rows.join('')}</table>${raw ? `<pre>${esc(raw)}</pre>` : ''}`;

  // ------------------------------------------------------------------ ArcGIS FeatureServer / MapServer podľa výrezu
  const agsCache = new Map();
  function lim(val, uom, code) {
    const u = String(uom || '').toUpperCase(); const c = String(code || '').toUpperCase();
    if (val == null || val === '') return c || u || '–';
    if (c === 'UNL' || u === 'UNL') return 'UNL';
    if (u === 'FL') return 'FL' + String(Math.round(+val)).padStart(3, '0');
    if (+val === 0 && (c === 'HEI' || c === 'SFC' || u === 'GND' || c === '')) return 'GND';
    const ref = c === 'HEI' ? ' AGL' : c === 'ALT' ? ' AMSL' : c === 'STD' ? ' STD' : u === 'SFC' || u === 'AGL' ? ' AGL' : u === 'MSL' || u === 'AMSL' ? ' AMSL' : '';
    return `${(+val).toLocaleString('sk-SK')} ${u === 'M' ? 'm' : 'ft'}${ref}`;
  }
  const stripTags = (s) => String(s || '').replace(/<\s*(br|p)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
  const SKIP_FIELD = /^(objectid|fid|globalid|shape|shape__.*|shape\..*|st_area.*|st_length.*|created_.*|last_edited_.*|gfid|geom_calc_date)$/i;
  function genericRows(p, max = 12) {
    return Object.entries(p).filter(([k, v]) => !SKIP_FIELD.test(k) && v != null && v !== '' && String(v).length < 600).slice(0, max)
      .map(([k, v]) => row(k, esc(typeof v === 'number' && v > 9e11 && v < 5e12 ? fmtZ(v) : v)));
  }
  const firstOf = (p, keys) => { for (const k of keys) if (p[k] != null && p[k] !== '') return p[k]; return null; };
  function aspColor(type, local) {
    const t = String(type || '').toUpperCase(); const lt = String(local || '').toUpperCase();
    if (/^(P|R)$|PROHIB|RESTRICT/.test(t)) return ['#c2185b', 0.14, null];
    if (t === 'D' || /DANGER/.test(t)) return ['#e65100', 0.12, null];
    if (/TRA|TSA|MOA|W$/.test(t)) return ['#b8860b', 0.08, '6 4'];
    if (t === 'CTR') return ['#1f5f99', 0.13, null];
    if (/TMA|CTA|CTL/.test(t)) return ['#1f5f99', 0.04, '8 5'];
    if (/RMZ|TMZ/.test(lt) || t === 'RAS') return ['#6a1b9a', 0.05, '4 4'];
    if (/ATZ|HTZ|AFIZ/.test(t + lt)) return ['#2e7d32', 0.1, null];
    if (/FIR|UIR/.test(t)) return ['#455a64', 0, '10 6'];
    return ['#546e7a', 0.06, null];
  }
  function notamCatOf(q) { const s = String(q || '').replace(/^Q/, ''); return Q_CAT[s[0]] || 'other'; }
  const UAS_ZG = { PROHIBITED: ['zákaz', '#b71c1c'], REQ_AUTHORIZATION: ['potrebné povolenie', '#e65100'], CONDITIONAL: ['podmienky', '#f9a825'],
    NO_RESTRICTION: ['bez obmedzenia', '#2e7d32'] };
  const SI_COLORS = ['#b71c1c', '#7b3fa0', '#7b3fa0', '#1f5f99', '#b71c1c', '#1f5f99', '#e65100', '#e65100', '#e65100', '#b8860b', '#e65100', '#c2185b', '#2e7d32', '#1f5f99'];
  function uasfmColor(c) { c = +c; return c <= 0 ? '#b71c1c' : c <= 50 ? '#e65100' : c <= 100 ? '#f9a825' : c <= 200 ? '#9e9d24' : c <= 300 ? '#558b2f' : '#2e7d32'; }

  // formát podľa zdroja: farba, titulok, obsah, čas platnosti, typ správy
  const FMT = {
    'lps-asp': {
      style: (p) => { const [c, f, d] = aspColor(p.TYPE_CODE, p.LOCALTYPE_TXT); return { color: c, fill: f, dash: d }; },
      time: (p) => [p.ValidFrom_Date, p.ValidTo_Date],
      title: (p) => `${p.IDENT_TXT || ''} ${p.NAME_TXT || ''}`.trim(),
      sub: (p) => [p.LOCALTYPE_TXT || p.TYPE_CODE, p.CLASS_CODE ? 'trieda ' + p.CLASS_CODE : ''].filter(Boolean).join(' · '),
      rows: (p) => [row('Horná hranica', esc(lim(p.DISTVERTUPPER_VAL, p.DISTVERTUPPER_UOM, p.DISTVERTUPPER_CODE))),
        row('Spodná hranica', esc(lim(p.DISTVERTLOWER_VAL, p.DISTVERTLOWER_UOM, p.DISTVERTLOWER_CODE))),
        row('Prevádzka', esc([p.WORKHR_CODE, p.WORKHRRMK_TXT].filter(Boolean).join(' – '))), row('Činnosť', esc(p.ACTIVITY_CODE || '')), row('Vojenský', esc(p.MIL_CODE || ''))],
      limits: (p) => `${lim(p.DISTVERTLOWER_VAL, p.DISTVERTLOWER_UOM, p.DISTVERTLOWER_CODE)} – ${lim(p.DISTVERTUPPER_VAL, p.DISTVERTUPPER_UOM, p.DISTVERTUPPER_CODE)}`,
    },
    'lps-lara': {
      msg: 'res',
      style: (p) => (String(p.status).toUpperCase() === 'ACTIVE' ? { color: '#d7263d', fill: 0.2 } : { color: '#e07b00', fill: 0.12, dash: '6 4' }),
      time: (p) => [p.startdate, p.enddate],
      title: (p) => `${p.airspace || 'rezervácia'}`,
      sub: (p) => [p.type_code, p.localtype_txt, p.airspace_type, p.status].filter(Boolean).join(' · '),
      rows: (p) => [row('Čas', `${fmtShort(p.startdate)} – ${fmtShort(p.enddate)} UTC`), row('Výšky', esc(`${p.base || '–'} – ${p.top_ || '–'}`)),
        row('Stav', esc(p.status || '')), row('Činnosť', esc(p.activity_code || '')), row('Vojenský', esc(p.mil_code || ''))],
      limits: (p) => `${p.base || '–'} – ${p.top_ || '–'}`,
    },
    'lps-warn': {
      msg: 'notam',
      style: () => ({ color: '#e65100', fill: 0.9, radius: 7 }),
      time: (p) => [p.Date_WEF, p.Date_TILL],
      title: (p) => p.Title || 'Výstraha',
      sub: (p) => [p.Airport, `${fmtShort(p.Date_WEF)} – ${fmtShort(p.Date_TILL)}`].filter(Boolean).join(' · '),
      rows: () => [], raw: (p) => p.Description,
    },
    'faa-class': {
      style: (p) => { const c = String(p.CLASS || '').toUpperCase(); return c === 'B' ? { color: '#1f5f99', fill: 0.08 } : c === 'C' ? { color: '#c2185b', fill: 0.06 } : c === 'D' ? { color: '#1f5f99', fill: 0.03, dash: '6 4' } : { color: '#c2185b', fill: 0.02, dash: '4 4', weight: 1 }; },
      title: (p) => p.NAME || p.IDENT || 'priestor',
      sub: (p) => ['trieda ' + (p.CLASS || '?'), p.LOCAL_TYPE].filter(Boolean).join(' · '),
      rows: (p) => [row('Horná hranica', esc(lim(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE))), row('Spodná hranica', esc(lim(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE))), row('ICAO', esc(p.ICAO_ID || ''))],
      limits: (p) => `${lim(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE)} – ${lim(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE)}`,
    },
    'faa-sua': {
      style: (p) => { const t = String(p.TYPE_CODE || '').toUpperCase(); const c = { P: '#880e4f', R: '#c2185b', MOA: '#6a1b9a', W: '#e65100', A: '#2e7d32' }[t] || '#455a64'; return { color: c, fill: t === 'P' || t === 'R' ? 0.12 : 0.06, dash: t === 'MOA' || t === 'A' ? '6 4' : null }; },
      title: (p) => p.NAME || 'SUA',
      sub: (p) => [p.TYPE_CODE, p.CITY, p.STATE].filter(Boolean).join(' · '),
      rows: (p) => [row('Horná hranica', esc(lim(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE))), row('Spodná hranica', esc(lim(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE))), row('Čas použitia', esc(p.TIMESOFUSE || ''))],
      limits: (p) => `${lim(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE)} – ${lim(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE)}`,
    },
    'faa-dof': {
      style: () => ({ color: '#e65100', fill: 0.85, radius: 3.5 }),
      title: (p) => `${p.Type_Code || 'prekážka'} ${p.AGL != null ? p.AGL + ' ft AGL' : ''}`.trim(),
      sub: (p) => [p.OAS_Number, p.City, p.State].filter(Boolean).join(' · '),
      rows: (p) => [row('Výška', `${esc(p.AGL ?? '–')} ft AGL / ${esc(p.AMSL ?? '–')} ft AMSL`), row('Osvetlenie', esc(p.Lighting || '')), row('Presnosť', esc([p.Hor_Acc, p.Vert_Acc].filter(Boolean).join(' / ')))],
    },
    'faa-uasfm': {
      style: (p) => ({ color: uasfmColor(p.CEILING), fill: 0.28, weight: 0.6 }),
      title: (p) => `Max. ${p.CEILING ?? '?'} ${p.UNIT || 'ft'} AGL`,
      sub: (p) => [p.APT1_ICAO || p.APT1_FAAID, p.APT1_NAME].filter(Boolean).join(' · '),
      rows: (p) => [row('Platnosť', esc(p.LAST_EDIT || ''))],
    },
    'enaire-notam': {
      msg: 'notam',
      style: (p) => { const c = (NOTAM_CATS[notamCatOf(p.qcode)] || NOTAM_CATS.other)[1]; return { color: c, fill: 0.12, radius: 5 }; },
      time: (p) => [p.itemB, p.itemC],
      cat: (p) => notamCatOf(p.qcode),
      title: (p) => `${p.notamId || 'NOTAM'} · ${p.itemA || ''}`,
      sub: (p) => [p.qcode, p.FLYING_LEVELS_DESC, `${fmtShort(p.itemB)} – ${fmtShort(p.itemC)}`].filter(Boolean).join(' · '),
      rows: (p) => [row('Platnosť', `${fmtZ(p.itemB)} – ${fmtZ(p.itemC)}`), row('Rozvrh (D)', esc(p.itemD || '')), row('Výšky', esc(p.FLYING_LEVELS_DESC || ''))],
      raw: (p) => p.itemE || p.DESCRIPTION || p.icaoFormatText,
      limits: (p) => p.FLYING_LEVELS_DESC || '',
    },
    'enaire-zg': {
      style: (p) => ({ color: (UAS_ZG[p.type] || ['', '#6a1b9a'])[1], fill: 0.12 }),
      title: (p) => p.name || p.identifier || 'zóna UAS',
      sub: (p) => [p.identifier, (UAS_ZG[p.type] || [p.type])[0], p.reasons].filter(Boolean).join(' · '),
      rows: (p) => [row('Spodná hranica', esc(p.lower != null ? `${p.lower} ${p.uomDimensions || ''} ${p.lowerReference || ''}` : '')), row('Horná hranica', esc(p.upper != null ? `${p.upper} ${p.uomDimensions || ''} ${p.upperReference || ''}` : ''))],
      raw: (p) => stripTags(p.message).slice(0, 1500),
    },
    'si-uas': {
      style: (p, i) => ({ color: SI_COLORS[i % SI_COLORS.length], fill: 0.14 }),
      title: (p, i, def) => (def.labels && def.labels[i]) || firstOf(p, ['NAME', 'Name', 'name', 'IME', 'naziv']) || 'zóna UAS',
      sub: (p) => firstOf(p, ['NAME', 'Name', 'name', 'IME', 'naziv', 'OPIS', 'Opis']) || '',
      rows: (p) => genericRows(p, 8),
    },
    generic: {
      style: () => ({ color: '#6a1b9a', fill: 0.12, radius: 5 }),
      title: (p, i, def) => firstOf(p, ['NAME', 'Name', 'name', 'NAME_TXT', 'IDENT', 'Title', 'title']) || (def.labels && def.labels[i]) || def.name,
      sub: () => '',
      rows: (p) => genericRows(p),
    },
  };

  async function agsQuery(url, bbox, z, def) {
    const deg = 360 / (256 * 2 ** z);
    const q = new URLSearchParams({
      where: def.where || '1=1', geometry: bbox.map((v) => v.toFixed(4)).join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson',
      resultRecordCount: String(def.max || 1000), geometryPrecision: '5', maxAllowableOffset: (deg * 0.6).toPrecision(2),
    });
    const key = url + '/query?' + q;
    const c = agsCache.get(key);
    if (c && Date.now() - c.at < 90e3) return c.p;
    const p = fetch(key).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => {
      if (j.error) throw new Error('ArcGIS ' + (j.error.code || '') + ' ' + (j.error.message || ''));
      return j;
    });
    agsCache.set(key, { at: Date.now(), p });
    p.catch(() => agsCache.delete(key));
    if (agsCache.size > 200) agsCache.delete(agsCache.keys().next().value);
    return p;
  }

  // ------------------------------------------------------------------ zostavenie jednotlivých zdrojov
  const build = {
    async metar(layer) {
      const d = await fetchJSON('metar.json');
      const z = ctx.map.getZoom();
      const r = z < 5 ? 3 : z < 8 ? 4.5 : 6;
      layer.total = d.rows.length;
      return d.rows.map((m) => {
        const [id, lat, lon, obs, cat, , , , , , , , , , raw] = m;
        const age = minsAgo(obs);
        const col = CAT_COLORS[cat] || '#8a9592';
        const stale = age > 150;
        const mk = L.circleMarker([lat, lon], { ...style(layer, stale ? '#8a9592' : '#ffffff', { weight: 1, fill: stale ? 0.15 : 0.95 }), radius: r, fillColor: stale ? '#8a9592' : col });
        mk.bindPopup(() => metarHTML(m) + `<div class="aero-taf" data-taf="${esc(id)}"></div>`, { maxWidth: 360 });
        mk.on('popupopen', (e) => attachTaf(e.popup, id));
        return tag(mk, layer, { point: true, title: `${id} · METAR ${cat || ''}`, sub: fmtShort(obs), color: col, raw });
      });
    },
    async taf(layer) {
      const d = await fetchJSON('taf.json');
      const t = now().getTime();
      const z = ctx.map.getZoom();
      const valid = d.rows.filter((r) => tms(r[4]) <= t && t < tms(r[5]));
      layer.total = d.rows.length;
      return valid.map(([id, lat, lon, issue, from, to, raw]) => {
        const mk = L.circleMarker([lat, lon], { ...style(layer, '#5e35b1', { weight: 1.5, fill: 0.15, dash: '2 2' }), radius: z < 6 ? 5 : 8 });
        mk.bindPopup(() => pop(`${esc(id)} · TAF`, `vydané ${fmtZ(issue)} · platné ${fmtShort(from)} – ${fmtShort(to)} UTC`, [], raw), { maxWidth: 380 });
        return tag(mk, layer, { point: true, title: `${id} · TAF`, sub: `${fmtShort(from)} – ${fmtShort(to)}`, color: '#5e35b1', raw });
      });
    },
    async sigmet(layer) {
      const d = await fetchJSON('sigmet.json');
      const t = now().getTime();
      layer.total = d.features.length;
      const out = [];
      for (const f of d.features) {
        const p = f.properties;
        if (!(tms(p.from) <= t && t < tms(p.to))) continue;
        const hz = HAZ[(p.hazard || '').toUpperCase()] || [p.hazard || 'jav', '#555555'];
        const html = () => sigmetHTML(p);
        const g = L.geoJSON(f, {
          pane: layer.paneName, renderer: layer.renderer, interactive: false,
          style: () => style(layer, hz[1], { weight: 1.6, fill: 0.16, dash: p.src === 'G-AIRMET' ? '5 4' : null, area: true }),
          pointToLayer: (_, ll) => L.circleMarker(ll, { ...style(layer, hz[1]), radius: 6 }),
        });
        g.eachLayer((l) => {
          if (l instanceof L.CircleMarker) l.bindPopup(html, { maxWidth: 380 });
          out.push(tag(l, layer, { title: `${p.src} · ${hz[0]} ${p.qual || ''}`.trim(), sub: `${p.firName || p.fir || ''} · ${fmtShort(p.from)} – ${fmtShort(p.to)}`, color: hz[1], html: () => sigmetHTML(p, true) }));
        });
      }
      return out;
    },
    async notam(layer) {
      const vb = ctx.map.getBounds().pad(0.1);
      const r = await notamsIn(vb);
      const t = now().getTime();
      if (r.capped) {
        // súčty v bunkách – klik priblíži
        layer.total = r.inTiles;
        layer.note = `vo výreze ${r.inTiles.toLocaleString('sk-SK')} NOTAM – zobrazené súčty, priblížte`;
        return notamCells(r, vb).map((c) => {
          const lab = c.n >= 10000 ? Math.round(c.n / 1000) + 'k' : c.n >= 1000 ? (c.n / 1000).toFixed(1).replace('.0', '') + 'k' : String(c.n);
          const sz = Math.round(22 + 7 * Math.log10(c.n));
          // bubliny v paneli značiek (nad plátnami ostatných vrstiev, aby klik nezachytilo plátno inej vrstvy)
          const mk = L.marker([c.lat, c.lon], { pane: 'markerPane', keyboard: false, counted: false, title: `${c.n} NOTAM – kliknutím priblížiť`,
            icon: L.divIcon({ className: 'notam-agg', html: `<span>${lab}</span>`, iconSize: [sz, sz] }) });
          mk.on('click', () => ctx.map.fitBounds(c.bounds, { maxZoom: 10 }));
          return mk;
        });
      }
      layer.total = r.features.length;
      layer.note = `databáza ${Number(r.idx.count || 0).toLocaleString('sk-SK')} NOTAM`;
      const cats = st.notamCats;
      const out = [];
      for (const f of r.features) {
        const p = f.properties;
        if (!notamValid(p, t)) continue;
        if (cats && !cats.has(p.cat)) continue;
        const [lon, lat] = f.geometry.coordinates;
        const col = (NOTAM_CATS[p.cat] || NOTAM_CATS.other)[1];
        // pri letiskových NOTAM (rozsah A) je polomer len okolie letiska – kreslíme iba značku
        const circle = notamIsArea(p);
        const approx = p.pos === 'fir';
        const info = { title: `${p.id} · ${p.loc}`, sub: notamSub(p), color: col, html: () => notamHTML(p, true) };
        if (circle) {
          const c1 = L.circle([lat, lon], { ...style(layer, col, { weight: 1.3, fill: p.cat === 'obstacle' ? 0.35 : 0.12, area: true }), radius: Math.max(p.r * NM, 300) });
          out.push(tag(c1, layer, info));
        }
        const mk = L.circleMarker([lat, lon], { ...style(layer, approx ? col : '#ffffff', { weight: approx ? 1.5 : 1, fill: approx ? 0.35 : 0.95, dash: approx ? '2 2' : null, counted: circle ? false : undefined }),
          radius: p.cat === 'obstacle' ? 4 : circle ? 3.5 : approx ? 6 : 5, fillColor: col });
        mk.bindPopup(() => notamHTML(p), { maxWidth: 420 });
        out.push(tag(mk, layer, { ...info, point: true }));
      }
      return out;
    },
    async airports(layer) {
      const map = ctx.map;
      const z = map.getZoom();
      const vb = map.getBounds().pad(0.15);
      const inView = (lat, lon) => vb.contains([lat, lon]);
      const sub = layer.def.sub;
      const out = [];
      if (z < 7) {
        if (sub === 'nav') { layer.total = 0; layer.note = 'zobrazí sa od z7'; return out; }
        const d = await fetchJSON('ad_major.json');
        layer.total = d.rows.length;
        for (const a of d.rows) {
          if (!inView(a[3], a[4])) continue;
          if (z < 5 && a[1] !== 'L') continue;
          out.push(adMarker(layer, { ident: a[0], type: a[1], name: a[2], lat: a[3], lon: a[4], icao: a[5], iata: a[6] }, z));
        }
        return out;
      }
      const parts = await adParts(vb);
      layer.total = 0;
      for (const part of parts) {
        if (!part) continue;
        if (sub === 'ad') {
          layer.total += part.ad.length;
          for (const a of part.ad) {
            const [ident, type, name, lat, lon, elev, icao, iata, city, rwy, frq] = a;
            if (!inView(lat, lon)) continue;
            if (type === 'H' && z < 10) continue;
            if (z < 9 && type === 'S' && !icao) continue;
            out.push(adMarker(layer, { ident, type, name, lat, lon, elev, icao, iata, city, rwy, frq }, z));
          }
        } else {
          layer.total += part.nav.length;
          for (const n of part.nav) {
            const [ident, type, name, lat, lon, khz, elev, apt] = n;
            if (!inView(lat, lon)) continue;
            const vor = /VOR|TACAN/.test(type);
            const col = vor ? '#1565c0' : /NDB/.test(type) ? '#8d4b1f' : '#546e7a';
            const mk = L.circleMarker([lat, lon], { ...style(layer, col, { weight: vor ? 2.2 : 1.5, fill: vor ? 0.05 : 0.5 }), radius: vor ? 6 : 4 });
            const freq = khz ? (khz >= 100000 ? (khz / 1000).toFixed(2) + ' MHz' : khz + ' kHz') : '–';
            mk.bindPopup(() => pop(`${esc(ident)} · ${esc(type)}`, esc(name), [row('Frekvencia', freq), row('Nadm. výška', elev != null ? elev + ' ft' : ''), row('Letisko', esc(apt || ''))]), { maxWidth: 300 });
            if (z >= 10) mk.bindTooltip(`${esc(ident)} ${freq}`, { permanent: true, direction: 'right', className: 'aero-lbl', pane: 'tooltipPane' });
            out.push(tag(mk, layer, { point: true, title: `${ident} · ${type}`, sub: `${name} · ${freq}`, color: col }));
          }
        }
      }
      return out;
    },
    async openaip(layer) {
      const d = await fetchJSON(layer.def.file);
      layer.total = d.features.length;
      const out = [];
      const lim2 = (x) => (x ? `${x.value ?? ''} ${['m', 'ft', '', '', '', '', 'FL'][x.unit] ?? ''} ${['GND', 'MSL', 'STD'][x.referenceDatum] ?? ''}`.trim() : '–');
      const g = L.geoJSON(d, {
        pane: layer.paneName, renderer: layer.renderer, interactive: false,
        style: (f) => {
          const p = f.properties; const cls = OAIP_CLASS[p.icaoClass] || '';
          const col = [1, 2, 3].includes(p.type) ? '#c2185b' : cls === 'C' || cls === 'D' || p.type === 4 ? '#1f5f99' : cls === 'E' ? '#6a1b9a' : '#455a64';
          return style(layer, col, { weight: 1.4, fill: 0.08, area: true });
        },
        pointToLayer: (f, ll) => L.circleMarker(ll, { ...style(layer, '#e65100', { fill: 0.6 }), radius: 4 }),
      });
      g.eachLayer((l) => {
        const p = l.feature.properties;
        const sub = [OAIP_TYPE[p.type], OAIP_CLASS[p.icaoClass] ? 'trieda ' + OAIP_CLASS[p.icaoClass] : ''].filter(Boolean).join(' · ');
        const rows = [row('Spodná hranica', esc(lim2(p.lowerLimit))), row('Horná hranica', esc(lim2(p.upperLimit))),
          row('Nadm. výška', p.elevation ? esc(lim2(p.elevation)) : ''), row('Výška', p.height ? esc(lim2(p.height)) : '')];
        const isPt = l instanceof L.CircleMarker;
        if (isPt) l.bindPopup(() => pop(esc(p.name || 'openAIP'), esc(sub), rows), { maxWidth: 320 });
        out.push(tag(l, layer, { point: isPt, title: p.name || 'openAIP', sub, color: l.options.color, html: () => body(esc(sub), rows),
          limits: p.lowerLimit ? `${lim2(p.lowerLimit)} – ${lim2(p.upperLimit)}` : '' }));
      });
      return out;
    },
    async arcgis(layer) {
      const def = layer.def; const map = ctx.map; const z = map.getZoom();
      const fmt = FMT[def.fmt] || FMT.generic;
      layer.msgs = [];
      if (z < (def.minz || 0)) { layer.total = 0; layer.note = `zobrazí sa od z${def.minz}`; return []; }
      const vb = map.getBounds().pad(0.1);
      let bb = [Math.max(-180, vb.getWest()), Math.max(-85, vb.getSouth()), Math.min(180, vb.getEast()), Math.min(85, vb.getNorth())];
      if (def.bbox) {
        const b = def.bbox;
        if (bb[0] > b[2] || bb[2] < b[0] || bb[1] > b[3] || bb[3] < b[1]) { layer.total = 0; layer.note = 'mimo pokrytia'; return []; }
        bb = [Math.max(bb[0], b[0]), Math.max(bb[1], b[1]), Math.min(bb[2], b[2]), Math.min(bb[3], b[3])];
      }
      const res = await Promise.all((def.urls || []).map((u) => agsQuery(u, bb, z, def).catch((e) => ({ error: e }))));
      const errs = res.filter((r) => r.error);
      if (errs.length === res.length && res.length) throw errs[0].error;
      const t = now().getTime();
      const cats = st.notamCats;
      const out = [];
      let total = 0, capped = false;
      res.forEach((fc, i) => {
        if (!fc || fc.error) return;
        const feats = fc.features || [];
        total += feats.length;
        if (fc.exceededTransferLimit || fc.properties?.exceededTransferLimit || feats.length >= (def.max || 1000)) capped = true;
        for (const f of feats) {
          const p = f.properties || {};
          if (!f.geometry) continue;
          if (fmt.time) { const [a, b] = fmt.time(p); if (!validAt(a, b, t)) continue; }
          if (fmt.cat && cats && !cats.has(fmt.cat(p))) continue;
          const s = fmt.style(p, i, def);
          const title = fmt.title(p, i, def); const sub = fmt.sub(p, i, def);
          const rows = fmt.rows(p, i, def); const raw = fmt.raw ? fmt.raw(p) : null;
          const isPt = /Point/.test(f.geometry.type);
          const g = L.geoJSON(f, {
            pane: layer.paneName, renderer: layer.renderer, interactive: false,
            style: () => style(layer, s.color, { fill: s.fill, dash: s.dash, weight: s.weight, area: true }),
            pointToLayer: (_, ll) => L.circleMarker(ll, { ...style(layer, '#ffffff', { weight: 1, fill: 0.95 }), radius: s.radius || 5, fillColor: s.color }),
          });
          const info = { title, sub, color: s.color, html: () => body(esc(sub), rows, raw), limits: fmt.limits ? fmt.limits(p) : '' };
          g.eachLayer((l) => {
            if (isPt) l.bindPopup(() => pop(esc(title), esc(sub), rows, raw), { maxWidth: 420 });
            out.push(tag(l, layer, { ...info, point: isPt }));
          });
          if (fmt.msg) {
            const c = isPt ? L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) : g.getBounds().getCenter();
            const [a, b] = fmt.time ? fmt.time(p) : [null, null];
            layer.msgs.push({ type: fmt.msg, title, sub, text: raw || '', from: a, to: b, latlng: c, bounds: isPt ? null : g.getBounds(), color: s.color,
              src: def.name, html: () => pop(esc(title), esc(sub), rows, raw), sort: fmt.msg === 'res' ? 1 : 2 });
          }
        }
      });
      layer.total = total;
      if (capped) layer.note = `načítaných ${total} objektov (limit služby) – priblížte`;
      if (errs.length) layer.note = (layer.note ? layer.note + ' · ' : '') + `${errs.length} z ${res.length} podvrstiev nedostupných`;
      return out;
    },
  };
  function notamIsArea(p) { return !!(p.r && p.r < 100 && (/[WE]/.test(p.scope || '') || ['airspace', 'warning', 'obstacle'].includes(p.cat))); }

  // ------------------------------------------------------------------ obsah popupov
  function metarHTML(m) {
    const [id, , , obs, cat, wd, ws, wg, vis, t, td, qnh, wx, clouds, raw] = m;
    const col = CAT_COLORS[cat] || '#8a9592';
    const visTxt = vis ? (vis.endsWith('+') ? `≥ ${Math.round(parseFloat(vis) * 1.609)} km` : `${(parseFloat(vis) * 1.609).toFixed(1)} km`) + ` (${vis} SM)` : '–';
    return pop(`${esc(id)} · METAR`, `pozorovanie ${fmtZ(obs)} · pred ${minsAgo(obs)} min`, [
      row('Kategória', cat ? `<b style="color:${col}">${esc(cat)}</b>` : '–'),
      row('Vietor', ws == null ? '–' : `${wd === 'VRB' ? 'premenlivý' : esc(wd) + '°'} ${ws} kt${wg ? ` náraz ${wg} kt` : ''}`),
      row('Dohľadnosť', visTxt), row('Oblačnosť', esc(clouds || 'bez významnej')), row('Javy', esc(wx || '')),
      row('Teplota / rosný bod', t == null ? '–' : `${t} / ${td ?? '–'} °C`), row('QNH', qnh ? qnh + ' hPa' : '–'),
    ], raw);
  }
  function sigmetHTML(p, bare) {
    const hz = HAZ[(p.hazard || '').toUpperCase()] || [p.hazard || 'jav', '#555555'];
    const rows = [row('Platnosť', `${fmtShort(p.from)} – ${fmtShort(p.to)} UTC`), row('Hladiny', `${ft(p.base ?? 'SFC')} – ${ft(p.top)}`),
      row('Pohyb', p.dir ? `${esc(p.dir)} ${esc(p.spd || '')} kt` : ''), row('Vývoj', esc(p.chng || ''))];
    const sub = `${esc(p.firName || p.fir || '')} · séria ${esc(p.series || '–')}`;
    return bare ? body(sub, rows, p.raw) : pop(`${esc(p.src)} · ${esc(hz[0])} ${esc(p.qual || '')}`, sub, rows, p.raw);
  }
  const NOTAM_POS = { psn: 'presná – súradnice v texte', q: 'stred z Q-riadku', ad: 'letisko / zariadenie', fir: 'približná – stred FIR alebo oblasti' };
  function notamHTML(p, bare) {
    const over = notamOverdue(p);
    const rows = [
      row('Platnosť', `${fmtZ(p.b)} – ${p.perm ? 'PERM' : p.c ? fmtZ(p.c) : p.ufn ? 'UFN (do odvolania)' : '–'}${p.est ? ' (EST – odhad)' : ''}` +
        (over ? '<br><b class="warn-txt">odhadovaný koniec uplynul – NOTAM nebol zrušený ani nahradený, overte u vydavateľa</b>' : '')),
      row('Rozvrh (D)', esc(p.d || '')),
      row('Výšky', p.f || p.g ? `${esc(p.f || 'GND')} – ${esc(p.g || '')}` : p.q ? `${fl(p.lo ?? 0)} – ${fl(p.hi ?? 999)}` : ''),
      row('Prekážka', esc(p.elev || '')), row('Polomer', p.r ? `${p.r} NM` : ''),
      row('Poloha', esc(NOTAM_POS[p.pos] || (p.precise ? NOTAM_POS.psn : ''))),
      row('FIR', esc(p.fir)), row('Typ', p.type === 'R' ? `nahrádza ${esc(p.ref || '')}` : p.type === 'C' ? `ruší ${esc(p.ref || '')}` : p.type === 'N' ? 'nový' : ''),
      row('Druh', p.dom ? (p.url ? 'list letcom (Letter to Airmen, FAA)' : 'domáci NOTAM USA (FAA)') : ''),
      row('Plné znenie', p.url && /^https:\/\/notams\.aim\.faa\.gov\//.test(p.url) ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">FAA – LTA</a>` : ''),
      row('Stiahnuté', p.u ? `${fmtZ(p.u)} (FAA NOTAM Search)` : ''),
    ];
    const sub = [p.subj, p.cond].filter(Boolean).map(esc).join(' – ') + (p.q ? ` · ${esc(p.q)}` : '');
    return bare ? body(sub, rows, p.e) : pop(`${esc(p.id)} · ${esc(p.loc)}`, sub, rows, p.e);
  }

  function adMarker(layer, a, z) {
    const [r, col] = AD_STYLE[a.type] || AD_STYLE.S;
    const mk = L.circleMarker([a.lat, a.lon], { ...style(layer, '#ffffff', { weight: 1.5, fill: 0.95 }), radius: z >= 10 ? r + 1 : r, fillColor: col });
    mk.bindPopup(() => adHTML(a) + `<div class="aero-taf" data-taf="${esc(a.icao || a.ident)}"></div>`, { maxWidth: 360 });
    mk.on('popupopen', (e) => attachTaf(e.popup, a.icao || a.ident, true));
    if ((a.icao && z >= 9 && a.type !== 'H') || z >= 12) mk.bindTooltip(esc(a.icao || a.ident), { permanent: true, direction: 'right', className: 'aero-lbl', pane: 'tooltipPane' });
    return tag(mk, layer, { point: true, title: `${a.icao || a.ident} · ${a.name}`, sub: AD_NAME[a.type] || '', color: col });
  }
  function adHTML(a) {
    return pop(`${esc(a.icao || a.ident)}${a.iata ? ' / ' + esc(a.iata) : ''} · ${esc(a.name)}`, `${AD_NAME[a.type] || ''}${a.city ? ' · ' + esc(a.city) : ''}`, [
      row('Nadm. výška', a.elev != null ? `${a.elev} ft (${Math.round(a.elev * 0.3048)} m)` : ''),
      row('Dráhy', esc(a.rwy || '')), row('Frekvencie', esc(a.frq || '')),
      row('Zdroj', `<a href="https://ourairports.com/airports/${encodeURIComponent(a.ident)}/" target="_blank" rel="noopener">OurAirports</a>`),
    ]);
  }
  async function adParts(vb) {
    const idx = await fetchJSON('ad/index.json');
    const keys = Object.entries(idx).filter(([, b]) => b[0] <= vb.getEast() && b[2] >= vb.getWest() && b[1] <= vb.getNorth() && b[3] >= vb.getSouth()).map(([k]) => k);
    return Promise.all(keys.slice(0, 24).map((k) => fetchJSON('ad/' + k + '.json').catch(() => null)));
  }

  // METAR, TAF a NOTAM pre letisko (doplnenie popupu aj informácie o mieste)
  async function adExtras(id, withMetar, ll) {
    const parts = [];
    if (withMetar && has('metar')) {
      const m = await fetchJSON('metar.json').catch(() => null);
      const r = m && m.rows.find((x) => x[0] === id);
      if (r) parts.push(`<p class="muted">METAR ${fmtZ(r[3])} · <b style="color:${CAT_COLORS[r[4]] || 'inherit'}">${esc(r[4] || '')}</b></p><pre>${esc(r[14])}</pre>`);
    }
    if (has('taf')) {
      const d = await fetchJSON('taf.json').catch(() => null);
      const r = d && d.rows.find((x) => x[0] === id);
      if (r) parts.push(`<p class="muted">TAF platné ${fmtShort(r[4])} – ${fmtShort(r[5])} UTC</p><pre>${esc(r[6])}</pre>`);
    }
    if (has('notam') && ll) {
      const n = await notamsIn(L.latLng(ll).toBounds(2000), NOTAM_POINT).catch(() => null);
      if (n) {
        const t = now().getTime();
        const list = n.features.filter((f) => f.properties.loc === id && notamValid(f.properties, t));
        if (list.length) parts.push(`<p class="muted">NOTAM platné k ${fmtZ(now().toISOString())}: ${list.length}</p>` +
          list.slice(0, 8).map((f) => `<pre>${esc(f.properties.id)} ${esc(f.properties.e)}</pre>`).join('') + (list.length > 8 ? `<p class="muted">… a ďalších ${list.length - 8}</p>` : ''));
      }
    }
    return parts;
  }
  async function attachTaf(popup, id, withMetar) {
    const el = popup.getElement()?.querySelector('.aero-taf');
    if (!el) return;
    let parts = [];
    try { parts = await adExtras(id, withMetar, popup.getLatLng()); } catch (e) { console.warn('[aero] doplnenie popupu', e); }
    if (!parts.length || !popup.isOpen()) return;
    el.innerHTML = parts.join('');
    // obsah popupu je funkcia; update() by ho prepočítal a doplnok zmazal, preto dočasne nastavíme hotové HTML
    const orig = popup.getContent();
    popup.setContent(popup.getElement().querySelector('.leaflet-popup-content').innerHTML);
    popup.once('remove', () => popup.setContent(orig));
  }

  // ------------------------------------------------------------------ klik do mapy: letecké informácie v bode
  function inRing(ring, ll) {
    let ins = false; const x = ll.lng, y = ll.lat;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) ins = !ins;
    }
    return ins;
  }
  function polyContains(lls, ll) {
    if (!lls || !lls.length) return false;
    if (L.LineUtil.isFlat(lls)) return inRing(lls, ll);
    if (L.LineUtil.isFlat(lls[0])) return inRing(lls[0], ll) && !lls.slice(1).some((h) => inRing(h, ll));
    return lls.some((p) => polyContains(p, ll));
  }
  function hitLayer(l, ll, pt) {
    const map = ctx.map;
    if (l instanceof L.Circle) return map.distance(ll, l.getLatLng()) <= l.getRadius();
    if (l instanceof L.CircleMarker) return map.latLngToLayerPoint(l.getLatLng()).distanceTo(pt) <= l.getRadius() + 5;
    if (l instanceof L.Polygon) {
      if (!l.getBounds().pad(0.01).contains(ll)) return false;
      return polyContains(l.getLatLngs(), ll);
    }
    if (l instanceof L.Polyline) {
      const pts = l.getLatLngs().flat(3).map((x) => map.latLngToLayerPoint(x));
      for (let i = 1; i < pts.length; i++) if (L.LineUtil.pointToSegmentDistance(pt, pts[i - 1], pts[i]) <= 6) return true;
    }
    return false;
  }
  function entryHTML(ai, l) {
    let inner = '';
    try {
      if (ai.html) inner = ai.html();
      else if (l.getPopup && l.getPopup()) { const c = l.getPopup().getContent(); inner = typeof c === 'function' ? c(l) : c; }
    } catch { /* bez detailu */ }
    return `<details class="hit"><summary><i style="background:${esc(ai.color || '#546e7a')}"></i><span><b>${esc(ai.title)}</b>
      ${ai.limits ? `<span class="mono lim">${esc(ai.limits)}</span>` : ''}<small>${esc(ai.sub || '')}${ai.sub ? ' · ' : ''}${esc(ai.layer || '')}</small></span></summary>
      <div class="hit-body">${inner}${ai.raw && !inner ? `<pre>${esc(ai.raw)}</pre>` : ''}</div></details>`;
  }
  // synchrónna časť: objekty aktívnych leteckých vrstiev v bode
  function hitsAt(latlng) {
    const map = ctx.map; const pt = map.latLngToLayerPoint(latlng);
    const hits = []; const seen = new Set();
    for (const lay of layers) {
      if (!(lay instanceof AeroLayer)) continue;
      lay.eachLayer((l) => {
        const ai = l._ai; if (!ai) return;
        if (!hitLayer(l, latlng, pt)) return;
        const k = ai.layer + '|' + ai.title + '|' + (ai.point ? 'p' : 'a');
        if (seen.has(k)) return; seen.add(k);
        hits.push({ ai, l });
      });
    }
    hits.sort((a, b) => (GROUP_ORDER[a.ai.group] ?? 9) - (GROUP_ORDER[b.ai.group] ?? 9) || (a.ai.point ? 1 : 0) - (b.ai.point ? 1 : 0));
    return hits;
  }
  const activeSources = () => new Set([...layers].map((l) => l.def.source));
  // asynchrónna časť: z hodinových údajov (aj keď vrstvy nie sú zapnuté) – NOTAM a SIGMET v bode, najbližšie letiská s METAR/TAF
  async function contextAt(latlng) {
    const out = [];
    const t = now().getTime();
    const act = activeSources();
    const map = ctx.map;
    if (!act.has('notam') && has('notam')) {
      const n = await notamsIn(L.latLngBounds(latlng, latlng), NOTAM_POINT).catch(() => null);
      if (n) {
        const list = n.features.filter((f) => {
          const p = f.properties; if (!notamIsArea(p)) return false;
          if (!notamValid(p, t)) return false;
          const [lon, lat] = f.geometry.coordinates;
          return map.distance(latlng, [lat, lon]) <= Math.max(p.r * NM, 300);
        });
        if (list.length) out.push(`<h5>NOTAM pokrývajúce bod · ${list.length}</h5>` + list.slice(0, 12).map((f) => {
          const p = f.properties; const col = (NOTAM_CATS[p.cat] || NOTAM_CATS.other)[1];
          return entryHTML({ title: `${p.id} · ${p.loc}`, sub: notamSub(p), color: col, layer: 'NOTAM', html: () => notamHTML(p, true), limits: p.f || p.g ? `${p.f || 'GND'} – ${p.g || ''}` : `${fl(p.lo)} – ${fl(p.hi)}` });
        }).join(''));
      }
    }
    if (!act.has('sigmet') && has('sigmet')) {
      const d = await fetchJSON('sigmet.json').catch(() => null);
      if (d) {
        const list = d.features.filter((f) => {
          const p = f.properties; if (!(tms(p.from) <= t && t < tms(p.to)) || !f.geometry) return false;
          const g = L.geoJSON(f); let hit = false;
          g.eachLayer((l) => { if (l instanceof L.Polygon && polyContains(l.getLatLngs(), latlng)) hit = true; });
          return hit;
        });
        if (list.length) out.push(`<h5>SIGMET/AIRMET v bode · ${list.length}</h5>` + list.map((f) => {
          const p = f.properties; const hz = HAZ[(p.hazard || '').toUpperCase()] || [p.hazard || 'jav', '#555555'];
          return entryHTML({ title: `${p.src} · ${hz[0]} ${p.qual || ''}`, sub: p.firName || p.fir || '', color: hz[1], layer: 'SIGMET', html: () => sigmetHTML(p, true) });
        }).join(''));
      }
    }
    // najbližšie letiská do 30 km
    try {
      const vb = L.latLngBounds([latlng.lat - 0.3, latlng.lng - 0.45], [latlng.lat + 0.3, latlng.lng + 0.45]);
      const parts = await adParts(vb);
      const ads = [];
      for (const part of parts) for (const a of part?.ad || []) {
        const [ident, type, name, lat, lon, elev, icao] = a;
        if (type === 'H') continue;
        const d = map.distance(latlng, [lat, lon]);
        if (d <= 30000) ads.push({ ident, type, name, lat, lon, elev, icao, d });
      }
      ads.sort((a, b) => (a.icao ? 0 : 1) - (b.icao ? 0 : 1) || a.d - b.d);
      const top = ads.slice(0, 3);
      if (top.length) {
        const blocks = await Promise.all(top.map(async (a) => {
          const ex = a.icao ? await adExtras(a.icao, true, [a.lat, a.lon]).catch(() => []) : [];
          return `<details class="hit"${a === top[0] ? ' open' : ''}><summary><i style="background:${(AD_STYLE[a.type] || AD_STYLE.S)[1]};border-radius:50%"></i><span><b>${esc(a.icao || a.ident)} · ${esc(a.name)}</b>
            <small>${(a.d / 1000).toFixed(1)} km · ${AD_NAME[a.type] || ''}${a.elev != null ? ` · ${a.elev} ft` : ''}</small></span></summary>
            <div class="hit-body">${ex.join('') || '<p class="muted">Bez METAR, TAF a NOTAM v hodinových údajoch.</p>'}</div></details>`;
        }));
        out.push(`<h5>Najbližšie letiská</h5>${blocks.join('')}`);
      }
    } catch { /* bez letísk */ }
    return out.join('');
  }
  function clickInfo(latlng) {
    const hits = hitsAt(latlng);
    let html = '';
    let g = null;
    for (const { ai, l } of hits) {
      if (ai.group !== g) { g = ai.group; html += `<h5>${esc(GROUP_LABEL[g] || g)}</h5>`; }
      html += entryHTML(ai, l);
    }
    return { html, count: hits.length, more: contextAt(latlng).catch(() => '') };
  }

  // ------------------------------------------------------------------ správy vo výreze
  let msgList = [];
  let msgTimer = 0;
  function scheduleMessages() { clearTimeout(msgTimer); msgTimer = setTimeout(updateMessages, 200); }
  async function collectMessages(bounds) {
    const t = now().getTime();
    const out = [];
    const bb = bounds;
    if (has('sigmet')) {
      const d = await fetchJSON('sigmet.json').catch(() => null);
      for (const f of d?.features || []) {
        const p = f.properties; if (!f.geometry || !(tms(p.from) <= t && t < tms(p.to))) continue;
        const g = L.geoJSON(f); const b = g.getBounds(); if (!b.isValid() || !b.intersects(bb)) continue;
        const hz = HAZ[(p.hazard || '').toUpperCase()] || [p.hazard || 'jav', '#555555'];
        out.push({ type: 'sigmet', title: `${p.src} ${hz[0]} ${p.qual || ''}`.trim(), sub: p.firName || p.fir || '', text: p.raw || '', from: p.from, to: p.to,
          latlng: b.getCenter(), bounds: b, color: hz[1], sort: 0, html: () => sigmetHTML(p) });
      }
    }
    let notamCapped = null;
    if (has('notam')) {
      const d = await notamsIn(bb).catch(() => null);
      if (d && d.capped) notamCapped = d.inTiles;
      const cats = st.notamCats;
      for (const f of d?.features || []) {
        const p = f.properties; if (!notamValid(p, t)) continue;
        if (cats && !cats.has(p.cat)) continue;
        const [lon, lat] = f.geometry.coordinates; const ll = L.latLng(lat, lon);
        const r = notamIsArea(p) ? Math.max(p.r * NM, 300) : 0;
        if (!(r ? ll.toBounds(2 * r).intersects(bb) : bb.contains(ll))) continue;
        const col = (NOTAM_CATS[p.cat] || NOTAM_CATS.other)[1];
        out.push({ type: 'notam', title: `${p.id} · ${p.loc}${notamOverdue(p, t) ? ' · EST uplynul' : ''}`, sub: notamSub(p), text: p.e || '', from: p.b, to: p.perm ? null : p.c, est: !!p.est, ufn: !!p.ufn, latlng: ll, bounds: r ? ll.toBounds(2 * r) : null,
          color: col, sort: ['airspace', 'warning', 'obstacle'].includes(p.cat) ? 1 : 3, html: () => notamHTML(p) });
      }
    }
    for (const lay of layers) for (const m of lay.msgs || []) if (m.bounds ? m.bounds.intersects(bb) : bb.contains(m.latlng)) out.push(m);
    if (has('metar')) {
      const d = await fetchJSON('metar.json').catch(() => null);
      const ms = (d?.rows || []).filter((m) => bb.contains([m[1], m[2]]));
      ms.sort((a, b) => (CAT_RANK[a[4]] ?? 4) - (CAT_RANK[b[4]] ?? 4) || String(a[0]).localeCompare(b[0]));
      for (const m of ms.slice(0, 120)) {
        out.push({ type: 'metar', title: `${m[0]} · ${m[4] || '–'}`, sub: `pred ${minsAgo(m[3])} min`, text: m[14] || '', from: m[3], latlng: L.latLng(m[1], m[2]),
          color: CAT_COLORS[m[4]] || '#8a9592', sort: 4 + (CAT_RANK[m[4]] ?? 4) / 10, html: () => metarHTML(m) });
      }
    }
    if (has('taf')) {
      const d = await fetchJSON('taf.json').catch(() => null);
      const ts = (d?.rows || []).filter((r) => bb.contains([r[1], r[2]]) && tms(r[4]) <= t && t < tms(r[5]));
      for (const r of ts.slice(0, 80)) {
        out.push({ type: 'taf', title: `${r[0]} · TAF`, sub: `${fmtShort(r[4])} – ${fmtShort(r[5])}`, text: r[6] || '', from: r[4], to: r[5], latlng: L.latLng(r[1], r[2]),
          color: '#5e35b1', sort: 5, html: () => pop(`${esc(r[0])} · TAF`, `vydané ${fmtZ(r[3])} · platné ${fmtShort(r[4])} – ${fmtShort(r[5])} UTC`, [], r[6]) });
      }
    }
    out.sort((a, b) => a.sort - b.sort || String(a.title).localeCompare(String(b.title)));
    out.notamCapped = notamCapped;
    return out;
  }
  async function updateMessages() {
    const el = document.getElementById('aero-msgs');
    if (!el || !ctx) return;
    const bounds = ctx.map.getBounds();
    const seq = (updateMessages._seq = (updateMessages._seq || 0) + 1);
    const all = await collectMessages(bounds);
    if (seq !== updateMessages._seq) return;
    const types = st.msgTypes;
    const counts = {}; all.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    msgList = all.filter((m) => !types || types.has(m.type));
    const chips = Object.entries(MSG_TYPES).map(([k, lab]) => `<button type="button" class="chip" data-msg-type="${k}" aria-pressed="${!types || types.has(k)}">${esc(lab)} <span class="mono">${counts[k] || 0}</span></button>`).join('');
    const shown = msgList.slice(0, 250);
    const items = shown.map((m, i) => `<button type="button" class="msg" data-msg="${i}">
        <span class="msg-badge" style="--c:${esc(m.color)}">${esc(MSG_BADGE[m.type] || m.type)}</span>
        <span class="msg-main"><b>${esc(m.title)}</b> <span class="muted">${esc(m.sub || '')}</span>
        ${m.from || m.to ? `<span class="mono msg-when">${m.type === 'metar' ? fmtShort(m.from) : `${fmtShort(m.from)} – ${m.to ? fmtShort(m.to) + (m.est ? ' EST' : '') : m.ufn ? 'UFN' : 'PERM'}`}</span>` : ''}
        ${m.text ? `<span class="msg-text">${esc(String(m.text).slice(0, 180))}${String(m.text).length > 180 ? '…' : ''}</span>` : ''}</span></button>`).join('');
    const noData = !has('notam') && !has('metar') && ![...layers].some((l) => (l.msgs || []).length);
    const capNote = all.notamCapped ? `<p class="muted small">NOTAM: vo výreze je ${all.notamCapped.toLocaleString('sk-SK')} správ – priblížte mapu, aby sa zobrazili.</p>` : '';
    st.lastMsg = {
      chips, count: `${msgList.length}`,
      list: (items || `<p class="empty small">${noData ? 'Hodinové letecké údaje ešte nie sú spracované; zobrazia sa správy zo zapnutých živých vrstiev.' : 'Vo výreze nie sú platné správy zvoleného typu.'}</p>`) +
        (msgList.length > shown.length ? `<p class="muted small">… a ďalších ${msgList.length - shown.length}; priblížte mapu.</p>` : '') + capNote,
    };
    const cur = document.getElementById('aero-msgs'); if (!cur) return;
    cur.querySelector('.msg-chips').innerHTML = st.lastMsg.chips;
    cur.querySelector('.msg-count').textContent = st.lastMsg.count;
    cur.querySelector('.msg-list').innerHTML = st.lastMsg.list;
  }
  function showMessage(i) {
    const m = msgList[i]; if (!m) return;
    const map = ctx.map;
    const open = () => L.popup({ maxWidth: 420, autoPanPaddingTopLeft: [20, 60] }).setLatLng(m.latlng).setContent(typeof m.html === 'function' ? m.html() : m.html).openOn(map);
    if (m.bounds && !map.getBounds().contains(m.bounds)) map.fitBounds(m.bounds, { maxZoom: 11, padding: [30, 30] });
    else if (!map.getBounds().pad(-0.05).contains(m.latlng)) map.panTo(m.latlng);
    setTimeout(open, 350);
  }

  // ------------------------------------------------------------------ panel „Letectvo“
  function notamLine(n, nr) {
    if (!n) return '';
    const c = n.coverage || {};
    const pct = (v) => (c.locations ? Math.round((100 * (v || 0)) / c.locations) + ' %' : '–');
    const parts = [`· ${Number(n.count || 0).toLocaleString('sk-SK')} platných`];
    if (nr.world) parts.push(`celý svet: ${Number(c.fetched_ever || 0).toLocaleString('sk-SK')} z ${Number(c.locations || 0).toLocaleString('sk-SK')} lokalít, obnovené do 6 h ${pct(c.fresh_6h)}, do 24 h ${pct(c.fresh_24h)}`);
    parts.push(`každú hodinu FIR ${esc((nr.firs || []).join(', '))} a letiská ${esc((nr.countries || []).join(', '))}`);
    return parts.join(' · ');
  }
  function sourceLine() {
    if (!meta || !meta.sources) return '<p class="aero-warn">Letecké údaje sa ešte nevygenerovali. Spustite scripts/build_aero.py (v nasadení beží každú hodinu).</p>';
    const s = meta.sources;
    const item = (k, label, extra = '') => {
      const v = s[k]; if (!v) return '';
      const stt = v.state === 'off' ? 'unknown' : v.state;
      return `<li><i class="dot ${esc(stt)}"></i>${label} <span class="mono">${v.updated ? fmtZ(v.updated).slice(11) : ''}</span> ${extra}${v.error ? `<span class="bad"> · ${esc(v.error)}</span>` : ''}</li>`;
    };
    const nr = meta.notam_region || {};
    return `<ul class="aero-src small">
      ${item('metar', 'METAR', `· ${s.metar?.count ?? 0} staníc, posledné ${s.metar?.newest ? fmtZ(s.metar.newest).slice(11) : '–'}`)}
      ${item('taf', 'TAF', `· ${s.taf?.count ?? 0}`)}
      ${item('sigmet', 'SIGMET/AIRMET', `· ${s.sigmet?.count ?? 0}`)}
      ${item('notam', 'NOTAM', notamLine(s.notam, nr))}
      ${item('airports', 'Letiská a navigačné zariadenia', `· ${s.airports?.airports ?? 0} / ${s.airports?.navaids ?? 0}`)}
      ${s.openaip?.state === 'off' ? '<li><i class="dot unknown"></i>openAIP priestory a prekážky · vypnuté (chýba OPENAIP_API_KEY)</li>' : item('openaip', 'openAIP', '')}
      <li><i class="dot ok"></i>Živé služby (LPS SR, FAA, ENAIRE, CAA SI, RainViewer) · dotaz podľa výrezu pri zapnutí vrstvy</li>
    </ul>`;
  }
  function headHTML() {
    const a = airac();
    const t = now();
    const offs = [0, 1, 3, 6, 12, 24];
    const notamChips = Object.entries(NOTAM_CATS).map(([k, [lab, col]]) => `<button type="button" class="chip" data-aero-cat="${k}" aria-pressed="${!st.notamCats || st.notamCats.has(k)}"><span class="sw" style="--c:${col};border-radius:50%"></span>${esc(lab)}</button>`).join('');
    return `<div class="aero-head">
      <div class="ctl-row"><span>čas platnosti</span>
        <select id="aero-offset" data-aero="offset" aria-label="Čas platnosti">${offs.map((o) => `<option value="${o}" ${o === st.offsetH ? 'selected' : ''}>${o ? 'o ' + o + ' h' : 'teraz'}</option>`).join('')}</select>
        <output class="mono" id="aero-now">${fmtZ(t.toISOString())}</output></div>
      <p class="mono small">AIRAC ${a.cycle} · platný od ${a.effective} · ďalší ${a.next}</p>
      <details class="aero-srcbox"${st.srcOpen ? ' open' : ''}><summary class="small">Stav zdrojov a upozornenie</summary>${sourceLine()}
      <p class="aero-warn small">${esc(meta?.disclaimer || 'Len informatívne údaje. Nenahrádzajú predletovú prípravu ani oficiálne zdroje (AIP, NOTAM/PIB, letecké meteorologické informácie).')}</p></details>
    </div>
    <details class="aero-msgs" id="aero-msgs"${st.msgOpen ? ' open' : ''}>
      <summary><span>Správy vo výreze</span> <span class="cnt msg-count">${st.lastMsg ? st.lastMsg.count : '…'}</span></summary>
      <p class="muted small msg-hint">NOTAM, SIGMET, rezervácie priestorov, METAR a TAF platné vo zvolenom čase v aktuálnom výreze mapy. Kliknutím zobrazíte detail na mape.</p>
      <div class="chips msg-chips">${st.lastMsg ? st.lastMsg.chips : ''}</div>
      <div class="chips aero-chips notam-chips" title="Kategórie NOTAM (platí pre vrstvu aj zoznam)">${notamChips}</div>
      <div class="msg-list">${st.lastMsg ? st.lastMsg.list : ''}</div>
    </details>`;
  }
  function legendHTML(rec) {
    const l = rec.def; const lay = rec.layer;
    let cnt = '';
    if (l.type === 'rainviewer') {
      cnt = `<span class="when">${lay.error ? 'chyba: ' + esc(lay.error) : lay.frame ? `snímka ${fmtZ(lay.frame.time * 1000).slice(11)}${lay.future ? ' (najnovšia – pre budúci čas radar nie je)' : ''}` : 'načítava sa'}</span>`;
      return cnt + '<div class="ramp rain"><span></span></div><div class="ramp-l"><span>slabé</span><span style="text-align:right">silné zrážky</span></div>';
    }
    if (lay && lay.count != null) cnt = `<span class="when">${lay.error ? 'chyba: ' + esc(lay.error) : lay.note && !lay.count ? esc(lay.note) : `zobrazené ${lay.count}${lay.total ? ' z ' + lay.total : ''} · k ${fmtZ(now().toISOString())}${lay.note ? ' · ' + esc(lay.note) : ''}`}</span>`;
    const sw = (col, lab, shape = '50%') => `<div><i style="background:${col};border-radius:${shape}"></i>${esc(lab)}</div>`;
    let b = '';
    if (l.source === 'metar') b = Object.entries(CAT_COLORS).map(([k, c]) => sw(c, k)).join('') + sw('#8a9592', 'staršie ako 2,5 h');
    if (l.source === 'notam' || l.fmt === 'enaire-notam') b = Object.entries(NOTAM_CATS).filter(([k]) => !st.notamCats || st.notamCats.has(k)).map(([, [lab, c]]) => sw(c, lab)).join('');
    if (l.source === 'sigmet') b = ['TS', 'TURB', 'ICE', 'VA', 'TC', 'MTW'].map((k) => sw(HAZ[k][1], HAZ[k][0], '2px')).join('');
    if (l.source === 'airports' && l.sub === 'ad') b = Object.entries(AD_STYLE).map(([k, [, c]]) => sw(c, AD_NAME[k])).join('');
    if (l.source === 'airports' && l.sub === 'nav') b = sw('#1565c0', 'VOR, VOR/DME, VORTAC, TACAN') + sw('#8d4b1f', 'NDB') + sw('#546e7a', 'DME');
    if (l.fmt === 'lps-asp' || l.fmt === 'faa-sua') b = sw('#c2185b', 'P, R', '2px') + sw('#e65100', 'D', '2px') + sw('#b8860b', 'TRA, TSA, MOA', '2px') + sw('#1f5f99', 'CTR, TMA', '2px') + sw('#6a1b9a', 'RMZ, TMZ', '2px');
    if (l.fmt === 'lps-lara') b = sw('#d7263d', 'aktívna', '2px') + sw('#e07b00', 'rezervovaná', '2px');
    if (l.fmt === 'faa-class') b = sw('#1f5f99', 'B, D', '2px') + sw('#c2185b', 'C, E', '2px');
    if (l.fmt === 'faa-uasfm') b = [[0, '0 ft'], [50, '50'], [100, '100'], [200, '200'], [300, '300'], [400, '400 ft']].map(([c, lab]) => sw(uasfmColor(c), lab, '2px')).join('');
    if (l.fmt === 'enaire-zg') b = Object.values(UAS_ZG).map(([lab, c]) => sw(c, lab, '2px')).join('');
    return cnt + (b ? `<div class="classes inline">${b}</div>` : '');
  }

  // ------------------------------------------------------------------ udalosti a obnova
  function refreshTimed() {
    for (const l of layers) if (TIMED_SOURCES.has(l.def.source) || l instanceof RainLayer) l.refresh();
    const o = document.getElementById('aero-now'); if (o) o.textContent = fmtZ(now().toISOString());
    scheduleMessages();
  }
  async function reload() {
    const changed = await loadMeta();
    if (changed) { for (const l of layers) l.refresh(); scheduleMessages(); }
    return changed;
  }
  function bind(list) {
    list.addEventListener('change', (e) => {
      if (e.target.id === 'aero-offset') {
        st.offsetH = +e.target.value; ctx.store.set('aeroOffset', st.offsetH); refreshTimed(); ctx.rerender();
      }
    });
    list.addEventListener('toggle', (e) => {
      if (e.target.id === 'aero-msgs') { st.msgOpen = e.target.open; ctx.store.set('msgOpen', st.msgOpen); if (st.msgOpen) scheduleMessages(); }
      if (e.target.classList?.contains('aero-srcbox')) st.srcOpen = e.target.open;
    }, true);
    list.addEventListener('click', (e) => {
      const m = e.target.closest('[data-msg]'); if (m) { showMessage(+m.dataset.msg); return; }
      const mt = e.target.closest('[data-msg-type]');
      if (mt) {
        const all = Object.keys(MSG_TYPES); const set = new Set(st.msgTypes || all);
        const k = mt.dataset.msgType; set.has(k) ? set.delete(k) : set.add(k);
        st.msgTypes = set.size === all.length || !set.size ? null : set;
        ctx.store.set('msgTypes', st.msgTypes ? [...st.msgTypes] : null);
        updateMessages();
        return;
      }
      const c = e.target.closest('[data-aero-cat]'); if (!c) return;
      const all = Object.keys(NOTAM_CATS);
      const set = new Set(st.notamCats || all);
      const k = c.dataset.aeroCat; set.has(k) ? set.delete(k) : set.add(k);
      st.notamCats = set.size === all.length || !set.size ? null : set;
      ctx.store.set('notamCats', st.notamCats ? [...st.notamCats] : null);
      list.querySelectorAll('[data-aero-cat]').forEach((b) => b.setAttribute('aria-pressed', String(!st.notamCats || st.notamCats.has(b.dataset.aeroCat))));
      for (const l of layers) if (l.def.source === 'notam' || l.def.fmt === 'enaire-notam') l.refresh();
      scheduleMessages();
      ctx.onLayerData(null);
    });
  }

  window.OrtoAero = {
    init(c) {
      ctx = c;
      st.offsetH = +(c.store.get('aeroOffset', 0)) || 0;
      const cats = c.store.get('notamCats', null);
      st.notamCats = Array.isArray(cats) ? new Set(cats) : null;
      const mt = c.store.get('msgTypes', null);
      st.msgTypes = Array.isArray(mt) ? new Set(mt) : null;
      st.msgOpen = c.store.get('msgOpen', true) !== false;
      bind(c.list);
      c.map.on('moveend', scheduleMessages);
      setInterval(() => { if (layers.size || document.getElementById('aero-msgs')) refreshTimed(); }, 60 * 1000);
      return loadMeta();
    },
    createLayer: (def, pane, extra) => (def.type === 'rainviewer' ? new RainLayer(def, pane, extra) : new AeroLayer(def, pane)),
    headHTML, legendHTML, reload, airac, clickInfo, updateMessages: scheduleMessages,
    timeLabel: () => fmtZ(now().toISOString()),
    status: (source) => meta?.sources?.[source] || null,
  };
})();
