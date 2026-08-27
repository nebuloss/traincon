// Traincon — frontend.
//
// Design rule: times shown big are SNCF's own live forecast (hard data).
// Positions are derived and always labelled as estimates.

import { t, setLang, getLang, detectLang, intlLocale, LOCALES } from './i18n.js';

// Alias for scopes where a local `t` holds a train object.
const tr = t;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const REFRESH_MS = 30_000;

const state = {
  watch: migrateWatch(load('watch', [])),   // ['8540', '8582', …]
  view: 'watch',
  family: 'all',
  query: '',
  map: null,
  mapTheme: null,
  markers: new Map(),
  mtab: 'apercu',        // sub-tab of the train modal
  mapMode: load('mapMode', 'train'),  // 'train' = close in, 'route' = whole journey
  mapPathFor: null,
  openTrain: null,                 // number shown in the modal
  feedDown: false,
  lastSeen: new Map(),             // number -> delay at previous poll
};

/** Earlier versions stored [{number, stopId}]; keep those bookmarks. */
function migrateWatch(v) {
  if (!Array.isArray(v)) return [];
  const nums = v.map((x) => (typeof x === 'string' ? x : x?.number)).filter(Boolean);
  return [...new Set(nums.map(String))];
}

function load(k, dflt) {
  try {
    const v = localStorage.getItem('sncf.' + k);
    return v === null ? dflt : (JSON.parse(v) ?? dflt);
  } catch { return dflt; }
}
function save(k, v) {
  try { localStorage.setItem('sncf.' + k, JSON.stringify(v)); } catch { /* private mode */ }
}

/* ---------------- language ---------------- */

/** Fill every element carrying an i18n key. */
function applyStaticI18n() {
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  const d = $('#mapDisclaimer');
  if (d) d.innerHTML = t('map.disclaimer');   // this one carries <strong>
  document.title = t('app.title');
}

function applyLang(lang) {
  setLang(lang);
  save('lang', getLang());
  const sel = $('#langSel');
  if (sel) {
    sel.innerHTML = Object.entries(LOCALES)
      .map(([code, l]) => `<option value="${code}">${esc(l.name)}</option>`).join('');
    sel.value = getLang();
  }
  applyStaticI18n();
  renderCurrent();
}

/* ---------------- theme ---------------- */

const MAP_STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
function themeMode() {
  const t = load('theme', 'auto');
  return t === 'dark' || t === 'light' ? t : 'auto';
}
const isDark = () => (themeMode() === 'auto' ? prefersDark() : themeMode() === 'dark');
const token = (n) => getComputedStyle(document.documentElement).getPropertyValue('--' + n).trim();

function applyTheme(mode) {
  save('theme', mode);
  const root = document.documentElement;
  if (mode === 'auto') delete root.dataset.theme; else root.dataset.theme = mode;
  for (const b of $$('#themeToggle button')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode));
  }
  // The static media-query <meta theme-color> pair cannot know about an
  // explicit override, so drive the browser chrome directly.
  requestAnimationFrame(() => {
    const bg = token('bg');
    for (const m of $$('meta[name="theme-color"]')) m.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = bg || (isDark() ? '#0e1116' : '#ffffff');
    document.head.appendChild(meta);
  });
  restyleMap();
}

/**
 * Swap the basemap to match the theme.
 * setStyle() drops every custom source and layer, so they are rebuilt once
 * the new style reports ready.
 */
function restyleMap() {
  if (!state.map) return;
  const want = isDark() ? 'dark' : 'light';
  if (state.mapTheme === want) return;
  state.mapTheme = want;
  state.mapPathFor = null;
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  state.map.setStyle(MAP_STYLES[want]);
  state.map.once('styledata', () => { addRailLayers(); refreshModal().catch(() => {}); });
}

/* ---------------- client cache ----------------
   The upstream proxy goes down regularly, and the server can only cache what
   it managed to fetch. Keeping responses in the browser too means a reload
   during an outage still shows your trains — stale, and labelled as such —
   instead of an empty app. */

const CACHE_PREFIX = 'sncf.c1:';
const CACHE_MAX_AGE = 12 * 3600 * 1000;
/** path -> timestamp of the cached copy currently being served. */
const cacheMeta = new Map();

function cacheGet(path) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (!e || Date.now() - e.at > CACHE_MAX_AGE) return null;
    return e;
  } catch { return null; }
}

function cacheSet(path, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota reached: drop the oldest half, then try once more.
    try {
      const dated = Object.keys(localStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .map((k) => {
          let at = 0;
          try { at = JSON.parse(localStorage.getItem(k)).at ?? 0; } catch { /* corrupt */ }
          return { k, at };
        })
        .sort((a, b) => a.at - b.at);
      for (const { k } of dated.slice(0, Math.ceil(dated.length / 2))) localStorage.removeItem(k);
      localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ at: Date.now(), data }));
    } catch { /* the cache is an optimisation, not a requirement */ }
  }
}

/**
 * Fetch, caching every good response and falling back to the cached copy when
 * the network or the server fails. `cacheMeta` records which paths are served
 * from cache so the UI can say so rather than implying the data is live.
 */
async function api(path, { allowCache = true } = {}) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (allowCache && r.ok) { cacheSet(path, data); cacheMeta.delete(path); }
    return data;
  } catch (e) {
    if (allowCache) {
      const hit = cacheGet(path);
      if (hit) { cacheMeta.set(path, hit.at); return hit.data; }
    }
    throw e;
  }
}

/** Newest cache timestamp in play, or null when everything is live. */
function servedFromCache() {
  return cacheMeta.size ? Math.max(...cacheMeta.values()) : null;
}

/* ---------------- formatting ---------------- */

// Always Europe/Paris: the trains run on French time wherever you read this.
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString(intlLocale(),
  { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function delayClass(sec, cancelled) {
  if (cancelled) return 'cancelled';
  if (sec >= 1200) return 'verylate';
  if (sec >= 300) return 'late';
  return 'ontime';
}

/** "+45 min" under the hour, "+1 h 10" over it — as SNCF writes it. */
function delayText(sec) {
  const m = Math.round(sec / 60);
  if (m === 0) return t('delay.onTime');
  const sign = m > 0 ? '+' : '−';
  const a = Math.abs(m);
  if (a < 60) return t('delay.minutes', { sign, n: a });
  const h = Math.floor(a / 60), r = a % 60;
  return r === 0
    ? t('delay.hours', { sign, h })
    : t('delay.hoursMinutes', { sign, h, m: String(r).padStart(2, '0') });
}

function countdown(ts) {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s < -60) return t('countdown.gone');
  if (s < 0) return t('countdown.now');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0
    ? t('countdown.hours', { h, m: String(m).padStart(2, '0') })
    : t('countdown.minutes', { m });
}

const trendText = (k) => t(`trend.${k}`);

const CONF_CLS = { confirmed: 'ok', good: 'ok', estimated: 'coarse', stale: 'bad', scheduled: 'coarse' };
const confidenceOf = (k) => ({
  label: t(`conf.${k}`), txt: t(`conf.${k}Txt`), cls: CONF_CLS[k] ?? 'coarse',
});

/**
 * One row shape for the entire Journal.
 *
 * It previously mixed badge blocks, a time list and a definition list — three
 * visual languages in one panel. Everything is now the same three-slot row:
 * a fixed-width key on the left, the substance in the middle, a short note on
 * the right. `tone` colours the key only, so status still reads at a glance
 * without changing the shape.
 */
function jlRow(key, main, meta = '', tone = '') {
  return `<div class="jl-row${tone ? ' t-' + tone : ''}">
    <span class="jl-key">${key}</span>
    <span class="jl-main">${main}</span>
    <span class="jl-meta">${meta}</span>
  </div>`;
}

/** How much ground truth is behind the estimate, in one line. */
function observationLine(t) {
  const o = t.position?.observation;
  if (!o || !o.lastStop) return '';
  const c = confidenceOf(o.confidence in CONF_CLS ? o.confidence : 'estimated');
  const mins = Math.round((o.ageSec ?? 0) / 60);
  const leg = o.legSec ? Math.round(o.legSec / 60) : null;
  return jlRow(
    esc(c.label),
    `${esc(t('jl.seenAtTxt', { stop: `<strong>${esc(o.lastStop)}</strong>` }))} ${esc(c.txt)}`
      .replace('&lt;strong&gt;', '<strong>').replace('&lt;/strong&gt;', '</strong>'),
    esc(t('jl.ago', { n: mins })) + (leg ? ` / ${leg}` : ''),
    c.cls === 'ok' ? 'ok' : c.cls === 'bad' ? 'bad' : 'warn');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const labelOf = (t) => [t.number, ...(t.coupledWith ?? [])].join(' + ');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

/**
 * Where the train is, as a sentence.
 * The parameter is `train`, not `t` — `t` is the translate function, and
 * shadowing it here silently broke every string in this block.
 */
function statusSentence(train) {
  const p = train.position;
  if (train.cancelled) {
    return { main: t('status.cancelled'), sub: t('status.cancelledSub'), icon: '✕' };
  }
  switch (p.basis) {
    case 'not_departed':
      return {
        main: t('status.inStation', { stop: p.atStation }),
        sub: t('status.notDeparted', { time: hhmm(train.calls[0].time) }),
        icon: '🅿',
      };
    case 'at_station':
      return {
        main: t('status.inStation', { stop: p.atStation }),
        sub: train.next
          ? t('status.leavesFor', { stop: p.nextStop, time: hhmm(train.next.time) })
          : t('status.atPlatform'),
        icon: '🛑',
      };
    case 'arrived':
      return {
        main: t('status.arrived', { stop: p.atStation }),
        sub: t('status.journeyOver'), icon: '🏁',
      };
    case 'between': {
      const bits = [t('status.legProgress', { pct: Math.round((p.legProgress ?? 0) * 100) })];
      if (p.legKm) bits.push(t('status.legKm', { km: p.legKm }));
      if (p.speedKmh) bits.push(t('status.speed', { kmh: p.speedKmh }));
      return {
        main: t('status.between', { from: p.fromStop, to: p.nextStop }),
        sub: bits.join(' · '), icon: '🚆',
      };
    }
    default:
      return { main: t('status.unknown'), sub: '', icon: '❓' };
  }
}

function posText(p) {
  if (!p) return t('pos.unknown');
  if (p.basis === 'not_departed') return t('pos.notDeparted', { stop: esc(p.atStation) });
  if (p.basis === 'arrived') return t('pos.arrived', { stop: esc(p.atStation) });
  if (p.basis === 'at_station') return t('pos.inStation', { stop: esc(p.atStation) });
  if (p.basis === 'between')
    return t('pos.between', { from: esc(p.fromStop), to: esc(p.nextStop),
      pct: Math.round(p.legProgress * 100), km: p.legKm });
  return t('pos.unknown');
}

/**
 * Journey timeline — vertical.
 *
 * Horizontal was the wrong shape: stops sit at even intervals, so French
 * station names ("Saint-Jean-de-Luz - Ciboure") overlap their neighbours at
 * any realistic width. Stacked vertically each name gets a full row and they
 * can never collide, and the same component doubles as the stop list.
 *
 * Rows are a fixed height so the train marker is placed by arithmetic rather
 * than by measuring the DOM: row centre plus the live fraction of the leg,
 * which is what distinguishes "in the station" from "between two".
 */
const ROW_H = 46; // keep in sync with --row-h in the stylesheet

function journeyTimeline(t) {
  const calls = t.calls;
  const n = calls.length;
  if (n < 2) return '';
  const now = Math.floor(Date.now() / 1000);
  const p = t.position;

  // Marker position in row units (2.4 = 40 % of the way from stop 2 to 3).
  let pos;
  if (p.basis === 'arrived') pos = n - 1;
  else if (p.basis === 'at_station' || p.basis === 'not_departed') {
    const at = calls.findIndex((c) => c.name === p.atStation);
    pos = at >= 0 ? at : 0;
  } else {
    const from = calls.findIndex((c) => c.name === p.fromStop);
    pos = (from >= 0 ? from : 0) + (p.legProgress ?? 0);
  }
  const atStop = p.basis !== 'between';

  const shown = calls.map((_, i) => i);

  // Build rows, recording which display row each stop landed on.
  const rowOf = new Map();
  const rows = [];
  for (const i of shown) {
    rowOf.set(i, rows.length);
    const c = calls[i];
    const isNext = t.next && c.stopId === t.next.stopId;
    const past = c.time <= now && !isNext;
    const dcls = delayClass(c.delay, t.cancelled);
    // SNCF quotes the arrival at an intermediate stop (Bordeaux 16h30), not
    // the departure (16h36). Origin is a departure, terminus an arrival,
    // everything between shows the arrival with the dwell alongside.
    const isFirst = i === 0, isLast = i === n - 1;
    const shown = isFirst ? (c.departure ?? c.time)
      : isLast ? (c.arrival ?? c.time)
      : (c.arrival ?? c.time);
    const dep = c.departure ?? null;
    const dwell = !isFirst && !isLast && dep && c.arrival && dep > c.arrival ? dep : null;
    rows.push(`<li class="tl-row${past ? ' past' : ''}${isNext ? ' next' : ''}${c.skipped ? ' skipped' : ''}${isLast ? ' terminus' : ''}">
      <span class="tl-rail-cell"><i class="tl-dot"></i></span>
      <span class="tl-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="tl-times">
        <span class="tl-eta ${dcls}">${c.skipped ? '—' : hhmm(shown)}</span>
        <span class="tl-meta">${
          c.skipped ? esc(t('delay.cancelled'))
          : [
              dwell ? t('stop.departure', { time: hhmm(dwell) }) : '',
              c.delay >= 60 ? `<b class="${dcls}">${delayText(c.delay)}</b>` : esc(t('delay.onTime')),
            ].filter(Boolean).join(' · ')}</span>
      </span>
    </li>`);
  }

  const lo = Math.floor(pos), hi = Math.min(n - 1, Math.ceil(pos));
  const rLo = rowOf.get(lo) ?? 0;
  const rHi = rowOf.get(hi) ?? rLo;
  const frac = hi > lo ? pos - lo : 0;
  const markTop = ROW_H / 2 + (rLo + (rHi - rLo) * frac) * ROW_H;

  return `<div class="tl">
    <div class="tl-fill" style="height:${Math.max(0, markTop - ROW_H / 2)}px"></div>
    <ul class="tl-list">${rows.join('')}</ul>
    <div class="tl-train ${atStop ? 'at-stop' : ''}" style="top:${markTop}px"
         title="${esc(posText(p))}" aria-label="${esc(posText(p))}">🚆</div>
  </div>`;
}

/* ---------------- cards ---------------- */

/**
 * Compact progress bar for the bookmark list.
 *
 * Horizontal works here precisely because there are no station names: just
 * dots, a filled portion and the train. The vertical timeline exists because
 * *labels* collide, and this carries none — so several trains can be compared
 * at a glance instead of scrolling through a full timeline each.
 */
function miniProgress(t) {
  const calls = t.calls;
  const n = calls.length;
  if (n < 2) return '';
  const now = Math.floor(Date.now() / 1000);
  const p = t.position;

  let pos;
  if (p.basis === 'arrived') pos = n - 1;
  else if (p.basis === 'at_station' || p.basis === 'not_departed') {
    const at = calls.findIndex((c) => c.name === p.atStation);
    pos = at >= 0 ? at : 0;
  } else {
    const from = calls.findIndex((c) => c.name === p.fromStop);
    pos = (from >= 0 ? from : 0) + (p.legProgress ?? 0);
  }
  const pct = Math.min(100, Math.max(0, (pos / (n - 1)) * 100));
  const atStop = p.basis !== 'between';

  const dots = calls.map((c, i) => {
    const done = c.time <= now;
    return `<i class="mp-dot${done ? ' done' : ''}${i === n - 1 ? ' end' : ''}${c.skipped ? ' skip' : ''}"
      style="left:${(i / (n - 1)) * 100}%" title="${esc(c.name)}"></i>`;
  }).join('');

  return `<div class="mp" aria-hidden="true">
    <div class="mp-rail"></div>
    <div class="mp-fill" style="width:${pct}%"></div>
    ${dots}
    <span class="mp-train${atStop ? ' at-stop' : ''}" style="left:${pct}%">🚆</span>
  </div>`;
}

function focusBlock(t) {
  const target = t.next;
  if (!target) return '';
  const planned = target.time - target.delay;
  const cls = delayClass(target.delay, t.cancelled);
  const gone = target.time < Math.floor(Date.now() / 1000);
  return `<div class="focus">
    <div class="label">${esc(t('card.nextStop', { stop: target.name }))}</div>
    <div class="time-row">
      <span class="live-time ${cls}">${t.cancelled ? '—' : hhmm(target.time)}</span>
      ${target.delay >= 60 ? `<span class="planned-time">${hhmm(planned)}</span>` : ''}
      <span class="${cls}">${t.cancelled ? esc(t('delay.cancelled')) : delayText(target.delay)}</span>
    </div>
    <div class="countdown" data-cd="${target.time}">
      ${t.cancelled ? esc(t('card.cancelledWarning')) : (gone ? esc(t('card.alreadyPassed')) : `<strong>${countdown(target.time)}</strong>`)}
    </div>
  </div>`;
}

function trainCard(t, bookmarked = null) {
  const el = document.createElement('article');
  el.className = 'card' + (t.cancelled ? ' is-cancelled' : '');
  el.dataset.open = t.number;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const cls = delayClass(t.delay, t.cancelled);
  const nx = t.next;
  const terminus = t.calls[t.calls.length - 1];
  const st = statusSentence(t);
  // On the final leg the next stop *is* the terminus, so an "Arrivée" line
  // underneath would just repeat the same station and time.
  const lastLeg = !nx || nx.stopId === terminus.stopId;

  el.innerHTML = `
    <div class="cd-top">
      ${starBtn(bookmarked?.length ? bookmarked.join(',') : t.number)}
      <span class="badge ${t.family}">${esc(t.serviceLabel)}</span>
      <span class="cd-num">${esc(labelOf(t))}</span>
      ${t.coupledWith?.length ? '<span class="um-tag">UM</span>' : ''}
      <span class="cd-delay ${cls}">${t.cancelled ? esc(t('delay.cancelled')).toUpperCase() : delayText(t.delay)}</span>
    </div>
    <div class="cd-od">${esc(t.origin)} → ${esc(t.destination)}</div>
    ${miniProgress(t)}
    <div class="cd-foot">
      <span class="cd-where">${esc(st.main)}</span>
      ${nx ? `<span class="cd-next">
          <b>${esc(nx.name)}</b> ${hhmm(nx.time)}
          <i data-cd="${nx.time}"><b>${countdown(nx.time)}</b></i>
        </span>` : ''}
    </div>
    ${lastLeg ? '' : `<div class="cd-arr">
      ${esc(t('card.arrival', { stop: terminus.name }))} · <b class="${delayClass(terminus.delay, t.cancelled)}">${hhmm(terminus.arrival ?? terminus.time)}</b>
    </div>`}`;
  return el;
}

/* ---------------- modal ---------------- */

async function openTrain(number, tab = 'apercu') {
  state.openTrain = number;
  state.mapPathFor = null;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#modalHead').innerHTML = `<p class="hint">${esc(t('modal.loading'))}</p>`;
  setModalTab(tab);
  await refreshModal();
}

function closeModal() {
  state.openTrain = null;
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  state.mapPathFor = null;
}

async function refreshModal() {
  const num = state.openTrain;
  if (!num) return;
  const d = await api('/api/train/' + encodeURIComponent(num));

  if (!d.found) {
    $('#modalHead').innerHTML = `
      <div class="m-title" id="modalTitle">${starBtn(num)}<span>${esc(num)}</span></div>
      <div class="m-od">${esc(d.message ?? t('map.absent'))}</div>
      ${d.knownSchedule?.line ? `<div class="m-line">${esc(d.knownSchedule.line)}</div>` : ''}`;
    $('#mpanel-apercu').innerHTML = '';
    $('#mpanel-trajet').innerHTML = '';
    return;
  }

  const t = d.trains[0];
  const group = [t.number, ...(t.coupledWith ?? [])];
  const cls = delayClass(t.delay, t.cancelled);

  $('#modalHead').innerHTML = `
    <div class="m-title" id="modalTitle">
      ${starBtn(group.join(','))}
      <span class="badge ${t.family}">${esc(t.serviceLabel)}</span>
      <span>${esc(group.join(' + '))}</span>
      ${group.length > 1 ? '<span class="um-tag">UM</span>' : ''}
      <span class="${cls} m-delay">${t.cancelled ? esc(t('delay.cancelled')).toUpperCase() : delayText(t.delay)}</span>
    </div>
    <div class="m-od">${esc(t.origin)} → ${esc(t.destination)}</div>`;

  const st = statusSentence(t);
  const terminus = t.calls[t.calls.length - 1];
  const remaining = t.calls.filter((c) => c.time > Math.floor(Date.now() / 1000)).length;

  $('#mpanel-apercu').innerHTML = `
    <div class="ov-status${t.cancelled ? ' cancelled' : ''}">
      <span class="ov-ic" aria-hidden="true">${st.icon}</span>
      <span class="ov-txt">
        <strong>${esc(st.main)}</strong>
        ${st.sub ? `<span class="ov-sub">${esc(st.sub)}</span>` : ''}
      </span>
    </div>
    ${focusBlock(t)}
    <div class="ov-grid">
      <div class="ov-cell">
        <span class="ov-k">${esc(t('ov.terminus'))}</span>
        <span class="ov-v">${esc(terminus.name)}</span>
        <span class="ov-s ${delayClass(terminus.delay, t.cancelled)}">${hhmm(terminus.arrival ?? terminus.time)}</span>
      </div>
      <div class="ov-cell">
        <span class="ov-k">${esc(t('ov.delay'))}</span>
        <span class="ov-v ${cls}">${t.cancelled ? 'supprimé' : delayText(t.delay)}</span>
        <span class="ov-s trend ${t.trend}">${trendText(t.trend)}</span>
      </div>
      <div class="ov-cell">
        <span class="ov-k">${esc(t('ov.stopsLeft'))}</span>
        <span class="ov-v">${remaining}</span>
        <span class="ov-s">${esc(t('ov.outOf', { n: t.calls.length }))}</span>
      </div>
      <div class="ov-cell">
        <span class="ov-k">${esc(t('ov.speed'))}</span>
        <span class="ov-v">${t.position.speedKmh ? t.position.speedKmh + ' km/h' : '—'}</span>
        <span class="ov-s">${esc(t.serviceLabel)}</span>
      </div>
    </div>
    <div class="m-actions">
      <button data-act="togglewatch" data-num="${esc(group.join(','))}"
              class="${isWatched(t.number) ? 'danger' : 'accent'}">
        ${esc(isWatched(t.number) ? t('ov.removeFav') : t('ov.addFav'))}
      </button>
    </div>`;

  // Written for a passenger, not for me. Every row explains something they
  // might act on; nothing here assumes knowledge of how the app works.
  const hist = (t.history ?? []).slice().reverse();
  const o = t.position?.observation ?? {};
  const conf = confidenceOf(o.confidence in CONF_CLS ? o.confidence : 'estimated');
  const section = (title, body) =>
    body ? `<h3 class="jl-h">${title}</h3><div class="jl">${body}</div>` : '';

  const trust = [
    jlRow(esc(conf.label), esc(conf.txt), '',
      conf.cls === 'ok' ? 'ok' : conf.cls === 'bad' ? 'bad' : 'warn'),
    o.lastStop
      ? jlRow(esc(t('jl.seenAt')),
          esc(t('jl.seenAtTxt', { stop: '\u0001' })).replace('\u0001', `<strong>${esc(o.lastStop)}</strong>`),
          esc(t('jl.ago', { n: Math.round((o.ageSec ?? 0) / 60) })))
      : '',
    t.reconciled?.disagreement
      ? jlRow(esc(t('jl.twoNumbers')),
          esc(t('jl.twoNumbersTxt', {
            count: t.reconciled.disagreement.length,
            list: '\u0001', shown: '\u0002',
          })).replace('\u0001', t.reconciled.disagreement
                .map((x) => `<strong>${esc(x.number)}</strong> ${delayText(x.delay)}`).join(', '))
             .replace('\u0002', `<strong>${esc(t.number)}</strong>`),
          '', 'warn')
      : '',
  ].filter(Boolean).join('');

  const changes = hist.length > 1
    ? hist.map((h, k) => {
        const prev = hist[k + 1];
        if (!prev) return jlRow(hhmm(h.t), esc(t('jl.firstReading', { delay: delayText(h.delay) })));
        const diff = h.delay - prev.delay;
        if (diff === 0) return '';
        const better = diff < 0;
        return jlRow(hhmm(h.t),
          esc(t(better ? 'jl.regained' : 'jl.lost', {
            n: Math.abs(Math.round(diff / 60)), delay: delayText(h.delay),
          })),
          '', better ? 'ok' : 'bad');
      }).filter(Boolean).join('')
    : jlRow('—', esc(t('jl.noChange')));

  const source = [
    jlRow(esc(t('jl.schedules')),
      esc(t('jl.schedulesTxt'))),
    jlRow(esc(t('jl.pastStops')),
      esc(t('jl.pastStopsTxt')), '', 'warn'),
    jlRow(esc(t('jl.position')),
      esc(t('jl.positionTxt', {
        kmh: t.position.speedKmh || 0,
        km: Math.max(1, Math.round((t.position.speedKmh || 0) / 60)),
      })), '', 'warn'),
    t.worstDelay - t.delay >= 300
      ? jlRow(esc(t('jl.goodNews')),
          esc(t('jl.goodNewsTxt', { worst: delayText(t.worstDelay), now: delayText(t.delay) })), '', 'ok')
      : '',
  ].filter(Boolean).join('');

  $('#mpanel-journal').innerHTML =
    section(esc(t('jl.trustTitle')), trust) +
    section(esc(t('jl.changesTitle')), changes) +
    section(esc(t('jl.sourceTitle')), source);

  $('#mpanel-trajet').innerHTML = focusBlock(t) + journeyTimeline(t);

  if (state.mtab === 'carte') {
    for (const x of $$('[data-mapmode]')) {
      const on = x.dataset.mapmode === state.mapMode;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', String(on));
    }
    await renderMapPanel(t);
    if (state.mapReframe) { frameMap(t.position); state.mapReframe = false; }
  }
}

/** Which sub-tab of the train modal is showing. */
function setModalTab(tab) {
  state.mtab = tab;
  for (const b of $$('.m-tabs button')) {
    const on = b.dataset.mtab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const pnl of $$('.m-panel')) pnl.classList.remove('active');
  $('#mpanel-' + tab).classList.add('active');
  if (tab === 'carte') ensureMap().then(() => refreshModal()).catch(() => {});
}

/**
 * Frame the map.
 *
 * Fitting the whole journey is useless for the actual question — a
 * Bordeaux–Paris route fits at zoom 6, where the train is a speck and the
 * track under it is invisible. Default to a close view on the train and make
 * the overview an explicit choice.
 */
/**
 * Zoom chosen from speed.
 *
 * Not just ergonomics: positional uncertainty scales with speed. The estimate
 * comes from a timetable, so a one-minute error is 1.7 km at 100 km/h but
 * 5 km at 300. Zooming out as the train accelerates keeps the error inside
 * the viewport instead of implying platform-level precision at 300 km/h — and
 * a stopped train can be shown right down on its station.
 */
function zoomForSpeed(kmh) {
  if (!kmh) return 13.5;                       // at a stand: platform level
  const z = 13 - Math.log2(Math.max(25, kmh) / 25) * 0.8;
  return Math.max(9.8, Math.min(13.5, z));
}

function frameMap(p, { initial = false } = {}) {
  if (!state.map || !p) return;
  if (state.mapMode === 'route' && state.mapGeo) {
    const line = state.mapGeo.features.find((f) => f.geometry.type === 'LineString');
    if (line?.geometry.coordinates.length) {
      const b = line.geometry.coordinates.reduce((a, c) => [
        Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1]),
      ], [180, 90, -180, -90]);
      state.map.fitBounds([[b[0], b[1]], [b[2], b[3]]],
        { padding: 45, duration: initial ? 0 : 700 });
      return;
    }
  }
  const want = zoomForSpeed(p.speedKmh);
  state.lastAutoZoom = want;
  state.map.easeTo({
    center: [p.lon, p.lat],
    zoom: want,
    duration: initial ? 0 : 700,
  });
}

/** Build the map lazily; it measures zero if created while hidden. */
async function ensureMap() {
  if (state.map) { requestAnimationFrame(() => state.map.resize()); return; }
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLES[isDark() ? 'dark' : 'light'],
    center: [2.4, 46.6], zoom: 4.7, attributionControl: true,
  });
  state.mapTheme = isDark() ? 'dark' : 'light';
  state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
  await new Promise((r) => state.map.on('load', r));
  addRailLayers();
  requestAnimationFrame(() => state.map.resize());
}

async function renderMapPanel(t) {
  if (!state.map) return;
  const p = t.position;

  if (state.mapPathFor !== t.number) {
    const geo = await api('/api/train/' + encodeURIComponent(t.number) + '/path');
    if (state.map.getSource('follow')) state.map.getSource('follow').setData(geo);
    else {
      state.map.addSource('follow', { type: 'geojson', data: geo });
      state.map.addLayer({
        id: 'follow-path', type: 'line', source: 'follow',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': token('accent'), 'line-width': 3.5, 'line-opacity': 0.9 },
      });
      state.map.addLayer({
        id: 'follow-stops', type: 'circle', source: 'follow',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'terminus'], 1], 5.5, 4],
          'circle-color': token('panel'),
          'circle-stroke-color': token('accent'),
          'circle-stroke-width': 1.5,
        },
      });
    }
    state.mapPathFor = t.number;
    state.mapGeo = geo;
    frameMap(p, { initial: true });
  } else if ($('#followLock')?.checked) {
    const want = zoomForSpeed(p.speedKmh);
    const cur = state.map.getZoom();
    // Follow the speed-derived zoom only while the view is still close to it;
    // once the user has zoomed themselves, just recentre.
    const auto = Math.abs(cur - (state.lastAutoZoom ?? cur)) < 0.35;
    state.map.easeTo({
      center: [p.lon, p.lat],
      zoom: auto ? want : cur,
      duration: 900,
    });
    if (auto) state.lastAutoZoom = want;
  }

  const cls = delayClass(t.delay, t.cancelled);
  let m = state.markers.get('self');
  if (!m) {
    const el = document.createElement('div');
    el.className = 'train-marker';
    el.innerHTML = '<svg viewBox="0 0 16 16" width="20" height="20">' +
      '<path d="M8 1 L13 14 L8 11 L3 14 Z" fill="currentColor" ' +
      'stroke="rgba(0,0,0,.55)" stroke-width="1" stroke-linejoin="round"/></svg>';
    m = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      .setLngLat([p.lon, p.lat]).addTo(state.map);
    state.markers.set('self', m);
  } else m.setLngLat([p.lon, p.lat]);
  m.setRotation(p.bearing ?? 0);
  const el = m.getElement();
  el.classList.toggle('is-stopped', !p.speedKmh);
  el.classList.toggle('is-coarse', p.geometry !== 'rail');
  el.style.color = token(cls === 'cancelled' ? 'dead' : cls === 'verylate' ? 'bad' : cls === 'late' ? 'warn' : 'ok');
}

/* ---------------- alerts ---------------- */

function alertOnChange(t) {
  const prev = state.lastSeen.get(t.number);
  const cur = t.maxDelay;
  state.lastSeen.set(t.number, cur);
  if (prev === undefined) return;
  if (t.cancelled) return notify(tr('alerts.cancelled', { n: t.number }), `${t.origin} → ${t.destination}`);
  const diff = cur - prev;
  if (Math.abs(diff) < 120) return;
  const where = t.next?.name ?? '';
  const when = t.next ? hhmm(t.next.time) : '';
  notify(
    tr('alerts.delayChange', { n: t.number, sign: diff > 0 ? '+' : '−', m: Math.abs(Math.round(diff / 60)) }),
    tr('alerts.delayBody', { stop: where, time: when, delay: delayText(cur) }));
}

function notify(title, body) {
  toast(`${title} · ${body}`);
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: title });
    }
  } catch { /* unsupported */ }
}

async function askNotify() {
  try {
    if (typeof Notification === 'undefined') return toast(t('alerts.unsupported'));
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? t('alerts.granted') : t('alerts.denied'));
    renderNotifyBtn();
  } catch { toast(t('alerts.unavailable')); }
}

function renderNotifyBtn() {
  const b = $('#notifyBtn');
  if (!b) return;
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  b.textContent = granted ? t('alerts.enabled') : t('alerts.enable');
  b.disabled = granted;
}

/* ---------------- views ---------------- */

async function renderWatch() {
  const wrap = $('#watchList'), empty = $('#watchEmpty');
  if (!state.watch.length) { wrap.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  if (state.feedDown) {
    wrap.innerHTML = `<p class="hint">${esc(t('watch.feedDown', { n: state.watch.length }))}</p>`;
    return;
  }

  const results = await Promise.all(state.watch.map(async (num) => ({
    num, d: await api('/api/train/' + encodeURIComponent(num)),
  })));

  // Bookmark two portions of one coupled set and you should see one card, not
  // two identical ones. Group by coupling and render the group once.
  const found = new Map();          // number -> train
  const missing = [];
  for (const { num, d } of results) {
    if (d.found && d.trains[0]) found.set(num, d.trains[0]);
    else missing.push({ num, message: d.message });
  }

  const done = new Set();
  wrap.innerHTML = '';
  for (const num of state.watch) {
    if (done.has(num)) continue;
    const t = found.get(num);
    if (!t) continue;
    // Every bookmarked number that is part of this physical train.
    const mates = (t.coupledWith ?? []).filter((n) => state.watch.includes(n));
    for (const n of [num, ...mates]) done.add(n);
    alertOnChange(t);
    wrap.appendChild(trainCard(t, [num, ...mates]));
  }
  for (const { num, message } of missing) {
    if (done.has(num)) continue;
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.open = num;
    el.innerHTML = `<div class="card-head">
        ${starBtn(num)}
        <div class="route">
          <div class="num">${esc(num)}</div>
          <div class="od">${esc(message ?? 'absent du flux')}</div>
        </div></div>`;
    wrap.appendChild(el);
  }
}

let sugTimer;
async function renderSearch() {
  const box = $('#suggestList'), hint = $('#searchHint');
  const q = state.query.trim();
  $('#searchClear').hidden = !q;
  $('#searchInput').setAttribute('aria-expanded', String(Boolean(q)));
  if (!q) {
    box.innerHTML = '';
    hint.textContent = t('search.prompt');
    return;
  }
  const params = new URLSearchParams({ q, limit: '25' });
  if (state.family !== 'all') params.set('family', state.family);
  const list = await api('/api/suggest?' + params);
  if (!Array.isArray(list)) throw new Error(t('error.badResponse'));
  if (!list.length) {
    box.innerHTML = '';
    hint.textContent = state.feedDown
      ? t('search.feedDown')
      : t('search.none', { q });
    return;
  }
  const cachedAt = cacheMeta.get('/api/suggest?' + params);
  hint.textContent = t('search.results', { n: list.length })
    + (cachedAt ? ` · ${t('search.cachedAt', { time: hhmm(Math.floor(cachedAt / 1000)) })}` : '');
  box.innerHTML = list.map((r) => {
    const cls = delayClass(r.delay, r.cancelled);
    return `<li role="option" class="sg-row">
      ${starBtn(r.number)}
      <button class="sg" data-open="${esc(r.number)}">
      <div class="sg-main">
        <div class="sg-top">
          <span class="badge ${r.family}">${esc(r.serviceLabel)}</span>
          <span class="sg-num">${esc([r.number, ...r.coupledWith].join(' + '))}</span>
          ${r.coupledWith.length ? '<span class="um-tag">UM</span>' : ''}

        </div>
        <div class="sg-od">${esc(r.origin)} → ${esc(r.destination)}</div>
        <div class="sg-why">${esc(r.why)}${r.next ? ` · prochain ${esc(r.next.name)} ${hhmm(r.next.time)}` : ''}</div>
      </div>
      <div class="sg-delay ${cls}">${r.cancelled ? 'suppr.' : delayText(r.delay)}</div>
    </button></li>`;
  }).join('');
}

function addRailLayers() {
  if (!state.map || state.map.getSource('rail')) return;
  try {
    state.map.addSource('rail', { type: 'geojson', data: '/api/rail.geojson' });
    state.map.addLayer({
      id: 'rail-classic', type: 'line', source: 'rail',
      filter: ['!=', ['get', 'hs'], 1],
      paint: {
        'line-color': token('rail'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 8, 0.9, 12, 1.8],
        'line-opacity': 0.6,
      },
    });
    state.map.addLayer({
      id: 'rail-hs', type: 'line', source: 'rail',
      filter: ['==', ['get', 'hs'], 1],
      paint: {
        'line-color': token('rail-hs'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.6, 12, 2.8],
        'line-opacity': 0.85,
      },
    });
  } catch (e) { console.warn('couche voie indisponible', e); }
}




/**
 * Say plainly what the data is worth right now.
 *
 * The upstream proxy goes down; when it does the page must not look like a
 * network with no trains running. Four degraded states, each stated rather
 * than implied: browser-cached copy, replayed fixture, frozen server
 * snapshot, and nothing at all.
 */
function renderBanner(s) {
  const el = $('#banner');
  const fmt = (ts) => (ts ? hhmm(ts) : '—');
  let kind = null, icon = '', title = '', sub = '';

  const localAt = servedFromCache();
  if (localAt) {
    kind = 'stale'; icon = '📦';
    title = t('banner.offlineTitle');
    sub = t('banner.offlineSub', { time: hhmm(Math.floor(localAt / 1000)) });
  } else if (s.replay) {
    kind = 'replay'; icon = '🧪';
    title = t('banner.demoTitle');
    sub = t('banner.demoSub', { n: s.total });
  } else if (!s.total) {
    kind = 'down'; icon = '⚠';
    title = t('banner.downTitle');
    sub = t('banner.downSub');
  } else if (s.stale) {
    kind = 'stale'; icon = '⏸';
    title = t('banner.downTitle');
    sub = t('banner.frozenSub', { time: fmt(s.feedTs) });
  } else if (s.ageSec != null && s.ageSec > 600) {
    kind = 'stale'; icon = '⏳';
    title = t('banner.slowTitle');
    sub = t('banner.slowSub', { n: Math.round(s.ageSec / 60), time: fmt(s.feedTs) });
  }

  if (!kind) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.className = 'banner ' + kind;
  el.innerHTML = `<span class="b-ic" aria-hidden="true">${icon}</span>
    <span class="b-txt"><strong>${esc(title)}</strong><span class="b-sub">${esc(sub)}</span></span>
    ${kind === 'replay' ? '' : `<button id="retryBtn">${esc(t('banner.retry'))}</button>`}`;
}

/**
 * Refresh the cached copy of every bookmarked train.
 *
 * The watch view only fetches what it draws, so a train you have not opened
 * recently would have no local copy when the feed drops. Priming them keeps
 * "Mes trains" populated through an outage.
 */
async function primeCache() {
  await Promise.allSettled(state.watch.map((n) =>
    api('/api/train/' + encodeURIComponent(n))));
}

async function renderFeedState() {
  try {
    const s = await api('/api/stats', { allowCache: false });
    renderBanner(s);
    state.feedDown = !s.total;
    const age = s.ageSec;
    const live = age != null && age < 240 && !s.stale;
    $('#feedDot').className = 'dot ' + (live ? 'live' : (s.total ? 'stale' : ''));
    $('#feedAge').textContent = age == null
      ? t('banner.downTitle')
      : `${s.total} · ${s.stale ? t('app.localData') : (age < 90 ? t('app.live') : t('app.minutesAgo', { n: Math.round(age / 60) }))}`;
  } catch {
    $('#feedDot').className = 'dot';
    const localAt = servedFromCache();
    $('#feedAge').textContent = localAt ? t('app.localData') : t('app.offline');
    renderBanner({ total: 0, ageSec: null, stale: false, replay: false });
    state.feedDown = !localAt;
  }
}

let lastRender = 0;
let rendering = false;

async function renderCurrent() {
  if (rendering) return;          // a manual wake must not race the interval
  rendering = true;
  try {
    if (state.view === 'watch') await renderWatch();
    else if (state.view === 'search') await renderSearch();
    if (state.openTrain) await refreshModal();
  } catch (e) {
    console.error('render', e);
    toast(tr('error.generic', { error: e.message }));
  }
  renderNotifyBtn();
  renderFeedState();
  lastRender = Date.now();
  rendering = false;
}

function goto(view) {
  state.view = view;
  for (const b of $$('.tab')) {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const v of $$('.view')) v.classList.remove('active');
  $('#view-' + view).classList.add('active');
  window.scrollTo(0, 0);
  renderCurrent();
  if (view === 'search') setTimeout(() => $('#searchInput').focus(), 60);
}

/* ---------------- events ---------------- */

for (const b of $$('.tab')) b.addEventListener('click', () => goto(b.dataset.view));
for (const b of $$('#themeToggle button')) {
  b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
}
$('#langSel')?.addEventListener('change', (e) => applyLang(e.target.value));

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mapmode]');
  if (!b) return;
  state.mapMode = b.dataset.mapmode;
  state.mapReframe = true;
  save('mapMode', state.mapMode);
  for (const x of $$('[data-mapmode]')) {
    const on = x.dataset.mapmode === state.mapMode;
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', String(on));
  }
  refreshModal().catch(() => {});
});
window.matchMedia?.('(prefers-color-scheme: dark)')
  .addEventListener?.('change', () => { if (themeMode() === 'auto') restyleMap(); });

$('#searchInput').addEventListener('input', (e) => {
  state.query = e.target.value;
  clearTimeout(sugTimer);
  sugTimer = setTimeout(() => {
    renderSearch().catch((err) => {
      // A silent catch here looks exactly like "autocomplete is broken".
      $('#searchHint').textContent = t('search.failed', { error: err.message });
      console.error('renderSearch', err);
    });
  }, 180);
});
$('#searchClear').addEventListener('click', () => {
  state.query = ''; $('#searchInput').value = ''; renderSearch(); $('#searchInput').focus();
});
for (const b of $$('#familyChips button')) {
  b.addEventListener('click', () => {
    state.family = b.dataset.family;
    for (const x of $$('#familyChips button')) x.setAttribute('aria-pressed', String(x === b));
    renderCurrent();
  });
}

$('#notifyBtn').addEventListener('click', askNotify);

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#retryBtn')) return;
  const b = e.target.closest('#retryBtn');
  b.disabled = true; b.textContent = t('banner.retrying');
  try {
    const s = await api('/api/refresh');
    toast(s.total ? tr('banner.restored', { n: s.total }) : tr('banner.stillDown'));
  } catch { toast(t('banner.stillDown')); }
  renderCurrent();
});

const isWatched = (n) => state.watch.includes(String(n));

/**
 * One tap on or off, from anywhere it appears.
 * `spec` may be several comma-separated numbers — a coupled set is one train
 * to the user, so its single star adds or removes the whole group.
 */
function toggleWatch(spec) {
  const nums = String(spec).split(',').map((n) => n.trim()).filter(Boolean);
  if (!nums.length || nums.some((n) => !/^\d{1,6}$/.test(n))) return toast(t('fav.invalid'));
  const on = nums.some((n) => isWatched(n));
  if (on) {
    state.watch = state.watch.filter((n) => !nums.includes(n));
    toast(nums.length > 1
      ? tr('fav.removedMany', { n: nums.join(' + ') })
      : tr('fav.removed', { n: nums[0] }));
  } else {
    for (const n of nums) if (!isWatched(n)) state.watch.push(n);
    toast(nums.length > 1
      ? tr('fav.addedMany', { n: nums.join(' + ') })
      : tr('fav.added', { n: nums[0] }));
  }
  save('watch', state.watch);
  for (const b of $$('[data-star]')) {
    const bn = b.dataset.star.split(',');
    if (bn.some((n) => nums.includes(n))) paintStar(b, bn.some(isWatched));
  }
  renderCurrent();
}

function paintStar(btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '★' : '☆';
  btn.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
}

const starBtn = (spec) => {
  const nums = String(spec).split(',');
  const on = nums.some(isWatched);
  const label = nums.join(' + ');
  return `<button class="star ${on ? 'on' : ''}" data-star="${esc(spec)}"
     aria-pressed="${on}" title="${on ? 'Retirer des favoris' : 'Ajouter aux favoris'}"
     aria-label="Favori ${esc(label)}">${on ? '★' : '☆'}</button>`;
};

document.addEventListener('click', (e) => {
  const mt = e.target.closest('[data-mtab]');
  if (mt) return setModalTab(mt.dataset.mtab);

  // Star toggles must never fall through to the row's open-detail handler.
  const star = e.target.closest('[data-star]');
  if (star) {
    e.preventDefault(); e.stopPropagation();
    return toggleWatch(star.dataset.star);
  }

  if (e.target.closest('[data-close]')) return closeModal();

  const goBtn = e.target.closest('[data-goto]');
  if (goBtn) return goto(goBtn.dataset.goto);

  const act = e.target.closest('[data-act]');
  if (act && act.tagName !== 'SELECT') {
    const num = act.dataset.num;
    if (act.dataset.act === 'togglewatch') { toggleWatch(num); refreshModal(); return; }
  }

  const opener = e.target.closest('[data-open]');
  if (opener) openTrain(opener.dataset.open);
});

/* ---------------- swipe to dismiss ----------------
   The grip looked draggable but only responded to a tap, which is worse than
   showing nothing. Dragging the grip or the header now moves the sheet and
   releases it: past a quarter of its height, or on a fast flick, it closes.
   Pointer Events cover touch and mouse alike, and the panels keep their own
   scrolling because the drag only starts on the handle area. */
(function enableSheetDrag() {
  const sheet = () => $('#modal .modal-sheet');
  let startY = 0, startT = 0, dy = 0, active = false, dragged = false;

  const handleFrom = (e) =>
    e.target.closest('.modal-grip, .m-head') && !e.target.closest('button, a, select, input');

  document.addEventListener('pointerdown', (e) => {
    if ($('#modal').hidden || !handleFrom(e)) return;
    active = true; startY = e.clientY; startT = performance.now(); dy = 0; dragged = false;
    const el = sheet();
    if (el) el.style.transition = 'none';
  });

  document.addEventListener('pointermove', (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);   // downward only
    if (dy > 4) dragged = true;
    const el = sheet();
    if (el) el.style.transform = `translateY(${dy}px)`;
  });

  const end = () => {
    if (!active) return;
    active = false;
    const el = sheet();
    if (!el) return;
    const height = el.getBoundingClientRect().height || 1;
    const velocity = dy / Math.max(1, performance.now() - startT);   // px per ms
    el.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1)';
    if (dy > height * 0.25 || velocity > 0.6) {
      el.style.transform = 'translateY(100%)';
      setTimeout(() => { el.style.transform = ''; el.style.transition = ''; closeModal(); }, 200);
    } else {
      el.style.transform = '';
    }
    dy = 0;
  };
  document.addEventListener('pointerup', end);

  // A drag that snapped back still emits a click; without this the grip's
  // data-close would fire and shut the sheet the user just decided to keep.
  document.addEventListener('click', (e) => {
    if (!dragged) return;
    dragged = false;
    if (e.target.closest('.modal-grip, .m-head')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  document.addEventListener('pointercancel', end);
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openTrain) closeModal();
  if (e.key === 'Enter' && e.target.id === 'searchInput') {
    const first = $('#suggestList .sg');
    if (first) openTrain(first.dataset.open);
  }
});

// Countdown ticks every second without refetching — but not while hidden.
setInterval(() => {
  if (document.visibilityState === 'hidden') return;
  for (const el of $$('[data-cd]')) {
    const strong = el.querySelector('strong');
    if (strong) strong.textContent = countdown(Number(el.dataset.cd));
  }
}, 1000);

/* ---------------- waking up ----------------
   A mobile browser freezes timers once you switch apps, and iOS restores the
   page from the back/forward cache without re-running any script. So coming
   back from another app would leave times frozen at whatever they were when
   you left, with no sign they were stale. Refresh on every signal that the
   page is being looked at again. */

const STALE_MS = 8_000;

function wake(reason) {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastRender < STALE_MS) return;   // already fresh
  const dot = $('#feedDot');
  if (dot) dot.classList.add('syncing');
  renderCurrent()
    .catch((e) => console.warn('wake', reason, e))
    .finally(() => dot?.classList.remove('syncing'));
}

document.addEventListener('visibilitychange', () => wake('visibility'));
window.addEventListener('focus', () => wake('focus'));
window.addEventListener('online', () => wake('online'));
window.addEventListener('offline', () => renderFeedState());
// bfcache restore: the page comes back intact, scripts never re-run.
window.addEventListener('pageshow', (e) => { if (e.persisted) wake('bfcache'); });

// Skip the poll entirely while hidden rather than queueing work the browser
// will throttle anyway.
setInterval(() => {
  if (document.visibilityState === 'visible') renderCurrent();
}, REFRESH_MS);

applyLang(load('lang', null) ?? detectLang());
applyTheme(themeMode());
renderSearch().catch((e) => { $('#searchHint').textContent = t('search.failed', { error: e.message }); });
renderCurrent();
primeCache().catch(() => { /* best effort */ });
setInterval(() => {
  if (document.visibilityState === 'visible') primeCache().catch(() => {});
}, 5 * 60_000);
