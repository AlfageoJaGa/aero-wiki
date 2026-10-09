/* AERO-wiki – knižnica voľných online leteckých zdrojov sveta (data/library.js, scripts/build_library.py).
   Filtre: text, kategória, prístup, len štáty vo výreze mapy, skryť nedostupné. Zdroje s mapovou službou
   sa dajú jedným klikom zapnúť na mape. */
(() => {
  'use strict';
  const CAT_ORDER = ['aip', 'notam', 'met', 'chart', 'uas', 'data', 'traffic', 'other'];
  const CAT_SHORT = { aip: 'AIP', notam: 'NOTAM', met: 'MET', chart: 'Mapy', uas: 'UAS', data: 'Dáta', traffic: 'ADS-B', other: 'Iné' };
  const FREE = new Set(['free', 'reg', 'key']);
  const EUROPE = [-25, 27, 45, 72];
  let ctx = null;
  let LIB = null;
  let bboxes = null; // cc -> [w,s,e,n]
  const st = { q: '', cats: null, freeOnly: true, inView: true, hideDown: false, open: new Set(['WW', 'EU']) };

  function loadBoxes() {
    if (LIB && LIB.bbox && Object.keys(LIB.bbox).length) { bboxes = LIB.bbox; return Promise.resolve(bboxes); }
    if (bboxes) return Promise.resolve(bboxes);
    return fetch('data/aero/ad/index.json', { cache: 'force-cache' }).then((r) => r.json()).then((idx) => {
      const m = {};
      for (const [k, b] of Object.entries(idx)) {
        const cc = k.slice(0, 2);
        // Aljaška a ostrovy cez 180° poludník – rozsah obmedzíme na západnú pologuľu
        let [w, s, e, n] = b; if (e - w > 180) { w = -180; e = -129; }
        m[cc] = m[cc] ? [Math.min(m[cc][0], w), Math.min(m[cc][1], s), Math.max(m[cc][2], e), Math.max(m[cc][3], n)] : [w, s, e, n];
      }
      bboxes = m; return m;
    }).catch(() => { bboxes = {}; return bboxes; });
  }
  const intersects = (b, v) => b && b[0] <= v.getEast() && b[2] >= v.getWest() && b[1] <= v.getNorth() && b[3] >= v.getSouth();
  function ccInView(cc, v) {
    if (cc === 'WW') return true;
    if (cc === 'EU') return intersects(EUROPE, v);
    const b = bboxes && bboxes[cc];
    return b ? intersects(b, v) : false;
  }
  const chk = (e) => e.check || {};
  const stOf = (e) => ({ ok: 'ok', warn: 'warn', down: 'down' }[chk(e).st] || 'unknown');
  function title(e) {
    const c = chk(e);
    const lab = { ok: 'dostupné', warn: 'odpovedá s obmedzením', down: 'nedostupné', unknown: 'zatiaľ neoverené' }[stOf(e)];
    const parts = [lab];
    if (c.err) parts.push(c.err);
    if (c.code) parts.push('HTTP ' + c.code);
    if (c.ms) parts.push(c.ms + ' ms');
    const when = c.checked || c.t; if (when) parts.push('kontrola ' + String(when).replace('T', ' ').replace('Z', ' UTC'));
    if (c.via) parts.push(c.via === 'server' ? 'zo servera' : 'z prehliadača v SR');
    if (c.note) parts.push(c.note);
    if (e.last_ok && stOf(e) !== 'ok') parts.push('naposledy dostupné ' + String(e.last_ok).slice(0, 10));
    return parts.join(' · ');
  }
  function hay(e) {
    const names = [e.cc, ...(e.ccs || [])].map((c) => (c.length === 2 ? ctx.regionName(c) : '')).join(' ');
    return [e.name, e.provider, e.url, e.note, e.region, e.cc, names, LIB.meta.categories[e.cat], CAT_SHORT[e.cat]].join(' ').toLowerCase();
  }
  function passes(e, q) {
    if (st.cats && !st.cats.has(e.cat)) return false;
    if (st.freeOnly && !FREE.has(e.access)) return false;
    if (st.hideDown && stOf(e) === 'down') return false;
    if (q && !e._hay.includes(q)) return false;
    return true;
  }
  function rowHTML(e) {
    const esc = ctx.esc;
    const acc = LIB.meta.access[e.access] || e.access;
    const lay = (e.layers || []).filter((id) => ctx.hasLayer(id));
    const on = lay.length && ctx.layersOn(lay);
    const host = (() => { try { return new URL(e.url).host.replace(/^www\./, ''); } catch { return ''; } })();
    return `<div class="lib-row${stOf(e) === 'down' ? ' is-down' : ''}">
      <i class="dot ${stOf(e)}" title="${esc(title(e))}"></i>
      <a class="lib-name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>
      <span class="lib-cat c-${esc(e.cat)}">${esc(CAT_SHORT[e.cat] || e.cat)}</span>
      <div class="lib-meta">${esc(e.provider || '')}<span class="acc a-${esc(e.access)}">${esc(acc)}</span><span class="mono">${esc(host)}</span>
        ${e.region ? `<span>${esc(e.region)}</span>` : ''}${e.note ? `<span class="lib-note">${esc(e.note)}</span>` : ''}</div>
      ${lay.length ? `<button type="button" class="btn small lib-map${on ? ' on' : ''}" data-lib-layers="${esc(lay.join(','))}">${on ? 'Na mape ✓' : 'Na mapu'}</button>` : ''}
    </div>`;
  }
  function render() {
    if (!LIB) return '<p class="empty">Knižnica data/library.js sa nenačítala. Spustite scripts/build_library.py.</p>';
    const esc = ctx.esc;
    const q = st.q.trim().toLowerCase();
    const v = ctx.map.getBounds();
    const groups = new Map();
    let shown = 0;
    const counts = {};
    for (const e of LIB.entries) {
      if (!passes({ ...e, cat: e.cat }, q)) continue;
      const ccs = [...new Set([e.cc, ...(e.ccs || [])])];
      const vis = st.inView && !q ? ccs.filter((c) => ccInView(c, v)) : ccs;
      if (!vis.length) continue;
      shown++;
      counts[e.cat] = (counts[e.cat] || 0) + 1;
      for (const c of (st.inView && !q ? vis : [e.cc])) { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(e); }
    }
    const order = [...groups.keys()].sort((a, b) => (a === 'WW' ? -2 : a === 'EU' ? -1 : 0) - (b === 'WW' ? -2 : b === 'EU' ? -1 : 0) ||
      (a.length === 2 && b.length === 2 ? ctx.regionName(a).localeCompare(ctx.regionName(b), 'sk') : a.localeCompare(b)));
    const label = (c) => LIB.meta.regions?.[c] || (c.length === 2 ? ctx.regionName(c) : c);
    const many = order.length > 6;
    const body = order.map((c) => {
      const es = groups.get(c).sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || a.name.localeCompare(b.name, 'sk'));
      const open = st.open.has(c) || !many || (q && es.length < 40);
      const nOk = es.filter((e) => stOf(e) === 'ok').length;
      return `<details class="lib-grp" data-lib-cc="${esc(c)}"${open ? ' open' : ''}><summary><span class="cc">${esc(c === 'WW' ? '🌐' : c === 'EU' ? 'EU' : c)}</span>
        <span class="cname">${esc(label(c))}<small>${es.length} zdrojov · ${nOk} overených</small></span>
        ${c.length === 2 && c !== 'WW' && c !== 'EU' && bboxes?.[c] ? `<button type="button" class="icon" data-lib-zoom="${esc(c)}" aria-label="Priblížiť na štát"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>` : ''}</summary>
        <div class="lib-rows">${open ? es.map(rowHTML).join('') : ''}</div></details>`;
    }).join('');
    const s = LIB.stats || {};
    const tot = {}; LIB.entries.forEach((e) => { tot[e.cat] = (tot[e.cat] || 0) + 1; });
    const chips = CAT_ORDER.filter((k) => LIB.meta.categories[k]).map((k) => `<button type="button" class="chip" data-lib-cat="${k}" aria-pressed="${!st.cats || st.cats.has(k)}" title="${esc(LIB.meta.categories[k])}"><span class="lib-cat c-${k}">${esc(CAT_SHORT[k])}</span><span class="mono">${counts[k] || 0}/${tot[k] || 0}</span></button>`).join('');
    return `<div class="lib-head">
      <input id="lib-q" type="search" placeholder="Hľadať štát, inštitúciu, typ (napr. Poľsko, VAAC, drony)…" autocomplete="off" aria-label="Hľadať v knižnici" value="${esc(st.q)}">
      <div class="chips">${chips}</div>
      <div class="toggles">
        <label><input type="checkbox" data-lib-opt="inView" ${st.inView ? 'checked' : ''}> len štáty vo výreze mapy</label>
        <label><input type="checkbox" data-lib-opt="freeOnly" ${st.freeOnly ? 'checked' : ''}> len voľne dostupné (aj s bezplatnou registráciou)</label>
        <label><input type="checkbox" data-lib-opt="hideDown" ${st.hideDown ? 'checked' : ''}> skryť nedostupné</label>
      </div>
      <p class="muted small mono">${s.entries ?? LIB.entries.length} zdrojov · ${s.countries ?? '–'} štátov · <i class="dot ok"></i> ${s.ok ?? '–'} <i class="dot warn"></i> ${s.warn ?? '–'} <i class="dot down"></i> ${s.down ?? '–'} · kontrola ${esc(String(LIB.generated || '').replace('T', ' ').replace('Z', ' UTC'))}</p>
      <p class="muted small">Zobrazené: ${shown}${st.inView && !q ? ' (štáty vo výreze; pri hľadaní celý svet)' : ''}. Odkaz otvorí zdroj v novom okne; „Na mapu“ zapne jeho mapové vrstvy.</p>
    </div>${body || '<p class="empty">Žiadny zdroj nezodpovedá filtru.</p>'}`;
  }
  function bind(list) {
    let qt = 0;
    list.addEventListener('input', (e) => {
      if (e.target.id !== 'lib-q') return;
      clearTimeout(qt);
      qt = setTimeout(() => { st.q = e.target.value; const pos = e.target.selectionStart; ctx.rerender(); const el = document.getElementById('lib-q'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }, 200);
    });
    list.addEventListener('change', (e) => {
      const o = e.target.dataset?.libOpt; if (!o) return;
      st[o] = e.target.checked; ctx.store.set('lib:' + o, st[o]); ctx.rerender();
    });
    list.addEventListener('click', (e) => {
      const c = e.target.closest('[data-lib-cat]');
      if (c) {
        const all = CAT_ORDER; const set = new Set(st.cats || all);
        const k = c.dataset.libCat;
        // prvé kliknutie pri všetkých zapnutých = len táto kategória
        if (!st.cats) { st.cats = new Set([k]); } else { set.has(k) ? set.delete(k) : set.add(k); st.cats = set.size === all.length || !set.size ? null : set; }
        ctx.rerender(); return;
      }
      const z = e.target.closest('[data-lib-zoom]');
      if (z) { e.preventDefault(); const b = bboxes?.[z.dataset.libZoom]; if (b) ctx.map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); return; }
      const m = e.target.closest('[data-lib-layers]');
      if (m) {
        const cc = m.closest('details.lib-grp')?.dataset.libCc;
        const b = cc && bboxes?.[cc];
        ctx.toggleLayers(m.dataset.libLayers.split(','), b ? [[b[1], b[0]], [b[3], b[2]]] : null);
        return;
      }
    });
    list.addEventListener('toggle', (e) => {
      const d = e.target; if (!d.matches?.('details.lib-grp')) return;
      const c = d.dataset.libCc;
      if (d.open) {
        st.open.add(c);
        const rows = d.querySelector('.lib-rows');
        if (!rows.innerHTML.trim()) {
          const q = st.q.trim().toLowerCase();
          const es = LIB.entries.filter((x) => (x.cc === c || (x.ccs || []).includes(c)) && passes(x, q))
            .sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || a.name.localeCompare(b.name, 'sk'));
          rows.innerHTML = es.map(rowHTML).join('');
        }
      } else st.open.delete(c);
    }, true);
  }
  function setData(d) {
    if (!d || !Array.isArray(d.entries)) return false;
    LIB = d;
    for (const e of LIB.entries) e._hay = hay(e);
    return true;
  }

  window.OrtoLibrary = {
    init(c) {
      ctx = c;
      for (const k of ['inView', 'freeOnly', 'hideDown']) { const v = c.store.get('lib:' + k, null); if (typeof v === 'boolean') st[k] = v; }
      setData(window.AEROWIKI_LIBRARY);
      bind(c.list);
      return loadBoxes();
    },
    render,
    count: () => (LIB ? LIB.entries.length : 0),
    reload() {
      return new Promise((res) => {
        const s = document.createElement('script');
        s.src = 'data/library.js?t=' + Date.now();
        s.onload = () => { s.remove(); res(setData(window.AEROWIKI_LIBRARY)); };
        s.onerror = () => { s.remove(); res(false); };
        document.head.appendChild(s);
      });
    },
  };
})();
