// Injury report and opponents' domestic games. Runs after every league section is built (called from build-cross.mjs).
//
// Injury report (EuroLeague and Winner League): built from the official box scores. A regular (3+ games, 10+ minutes)
// who is missing from his team's latest games is listed: "not on the game roster" (usually injured) or "on the roster,
// did not play". For EuroLeague players it also shows whether they played in their domestic league since.
// The EuroLeague's own injury report cannot be read automatically (its site blocks automated visits), so it is linked.
// Staff marks (out / doubtful / available, with a note) are added on the page and kept encrypted (static/staff.js).
//
// Domestic games: the EuroLeague game-day pack gets the next opponent's latest games in its own league.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { esc, page, fmtDate, assetVersion } from '../lib/render.mjs';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const SITE = 'site';
const dirOf = (k) => (k === 'el' ? SITE : join(SITE, k));
const pkey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const LOGS = new Map();
for (const k of ['el', ...Object.keys(base.leagues || {})]) { const f = join(dirOf(k), 'gamelog.json'); if (existsSync(f)) { try { LOGS.set(k, JSON.parse(readFileSync(f, 'utf8'))); } catch { /* skip */ } } }
const dayMs = 86400000, D = (s) => Date.parse(String(s).slice(0, 10) + 'T12:00:00Z');
// Media reports (EuroLeague): media/injuries.json, edited by hand from BasketNews and the league's own reports.
let MEDIA = null; try { MEDIA = JSON.parse(readFileSync(new URL('../media/injuries.json', import.meta.url), 'utf8')); } catch { MEDIA = null; }
const MSTATUS = { out: ['Out', 'neg'], doubt: ['Doubtful', 'neg'], uncertain: ['Uncertain', ''], expected: ['Expected to play', 'pos'], ready: ['Available', 'pos'] };
const MKIND = { injury: 'Injury', illness: 'Illness', coach: 'Coach’s decision', roster: 'Not registered', national: 'National team' };
const mediaFor = (code) => (MEDIA?.players || []).filter((p) => p.team === code);
const mediaByKey = new Map((MEDIA?.players || []).map((p) => [pkey(p.name), p]));

/** Per team: games in date order, and each player's appearances. */
function teamsOf(L) {
  const T = new Map();
  const games = [...L.games].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  const lastTeamOf = new Map(); // pid -> team of his latest game
  for (const [date, code, round, h, hs, a, as, pl] of games) {
    for (const side of [h, a]) { if (!T.has(side)) T.set(side, { code: side, games: [], players: new Map() }); }
    for (const side of [h, a]) {
      const t = T.get(side), idx = t.games.length;
      t.games.push({ date, code, round, opp: side === h ? a : h, home: side === h, pf: side === h ? hs : as, pa: side === h ? as : hs });
      for (const [name, team, min, pts, reb, ast, pir, pid] of pl) {
        if (team !== side) continue;
        const o = t.players.get(pid) || { pid, name, gp: 0, min: 0, pts: 0, apps: new Map() };
        o.apps.set(idx, { min, pts, listed: true }); if (min > 0) { o.gp++; o.min += min; o.pts += pts; } o.name = name;
        t.players.set(pid, o); if (min > 0) lastTeamOf.set(pid, side);
      }
    }
  }
  return { T, lastTeamOf };
}
/** Domestic appearances of one person (by name) after a date, in every league but `skip`. */
function domesticAfter(name, afterDate, skip) {
  const k = pkey(name), out = [];
  for (const [lg, L] of LOGS) { if (lg === skip) continue; for (const [date, code, , h, hs, a, as, pl] of L.games) { if (date <= afterDate) continue; for (const q of pl) if (pkey(q[0]) === k) out.push({ lg, short: L.short, date, min: q[2], pts: q[3], team: q[1], opp: q[1] === h ? a : h, res: q[1] === h ? `${hs}–${as}` : `${as}–${hs}` }); } }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

function absences(lg) {
  const L = LOGS.get(lg); const { T, lastTeamOf } = teamsOf(L);
  const rows = new Map();
  for (const t of T.values()) {
    const n = t.games.length, list = [];
    for (const o of t.players.values()) {
      if (lastTeamOf.get(o.pid) !== t.code) continue; // moved to another team
      if (o.gp < 3 || o.min / o.gp < 10) continue;
      let miss = 0, notListed = 0; for (let i = n - 1; i >= 0; i--) { const a = o.apps.get(i); if (a && a.min > 0) break; miss++; if (!a) notListed++; }
      if (!miss) continue;
      const lastIdx = [...o.apps].filter(([, a]) => a.min > 0).map(([i]) => i).pop();
      const last = t.games[lastIdx];
      const dom = lg === 'el' ? domesticAfter(o.name, last.date, 'el') : [];
      list.push({ ...o, mpg: o.min / o.gp, ppg: o.pts / o.gp, miss, notListed, last, dom });
    }
    rows.set(t.code, list.sort((a, b) => b.mpg - a.mpg));
  }
  return { L, T, rows };
}

function injuriesPage(lg) {
  const { L, T, rows } = absences(lg);
  const cfgL = lg === 'el' ? { ...base, LEAGUE: 'el', root: '' } : { ...base, ...(base.leagues?.[lg] || {}), LEAGUE: lg };
  const R = lg === 'el' ? '' : '../';
  const tname = (c) => L.teams[c]?.[0] || c;
  const row = (p, code) => `<tr data-pname="${esc(pkey(p.name))}" data-team="${esc(code)}"><td><strong>${esc(p.name)}</strong></td><td class="num">${p.mpg.toFixed(1)}</td><td class="num">${p.ppg.toFixed(1)}</td><td class="num"><strong class="neg">${p.miss}</strong></td><td class="small">${p.notListed === p.miss ? 'Not on the game roster' : p.notListed ? `Not on the roster ${p.notListed}×, on it but did not play ${p.miss - p.notListed}×` : 'On the roster, did not play'}</td><td class="small">${esc(fmtDate(p.last.date))}${p.last.round ? ` (Rd ${p.last.round})` : ''}</td>${lg === 'el' ? `<td class="small">${p.dom.length ? p.dom.slice(-3).map((d) => `${esc(d.short)} ${esc(fmtDate(d.date))}: ${Math.round(d.min)} min, ${d.pts} pts`).join('<br>') : '<span class="muted">–</span>'}</td>` : ''}<td class="small">${(() => { const m = mediaByKey.get(pkey(p.name)); return m && lg === 'el' ? `<span class="${MSTATUS[m.status]?.[1] || ''}"><strong>${MSTATUS[m.status]?.[0] || esc(m.status)}</strong></span> ${esc(m.reason)}` : '<span class="muted">–</span>'; })()}</td><td class="small staff-cell"></td></tr>`;
  const mediaTable = (code) => { if (lg !== 'el') return ''; const auto = new Set((rows.get(code) || []).map((p) => pkey(p.name))); const list = mediaFor(code).filter((m) => !auto.has(pkey(m.name))).sort((a, b) => ['out', 'doubt', 'uncertain', 'expected', 'ready'].indexOf(a.status) - ['out', 'doubt', 'uncertain', 'expected', 'ready'].indexOf(b.status));
    return list.length ? `<table class="rtab inj-t inj-media"><thead><tr><th>Also in the media report</th><th>Status</th><th>Why</th><th>Detail</th><th>Staff mark</th></tr></thead><tbody>${list.map((m) => `<tr data-pname="${esc(pkey(m.name))}" data-team="${esc(code)}"><td><strong>${esc(m.name)}</strong></td><td><span class="${MSTATUS[m.status]?.[1] || ''}"><strong>${MSTATUS[m.status]?.[0] || esc(m.status)}</strong></span></td><td class="small">${esc(MKIND[m.kind] || m.kind || '')}</td><td class="small">${esc(m.reason)}</td><td class="small staff-cell"></td></tr>`).join('')}</tbody></table>` : ''; };
  const table = (code) => { const list = rows.get(code) || []; return (list.length ? `<table class="rtab inj-t"><thead><tr><th>Player</th><th class="num">MIN/g</th><th class="num">PTS/g</th><th class="num">Games missed in a row</th><th>How</th><th>Last played</th>${lg === 'el' ? '<th>Domestic games since</th><th>Media report</th>' : '<th>Media report</th>'}<th>Staff mark</th></tr></thead><tbody>${list.map((p) => row(p, code)).join('')}</tbody></table>` : '<p class="muted small">No regular missing from the latest game.</p>') + mediaTable(code); };
  const next = (L.upcoming || []).filter((x) => x[1] && x[2]);
  const firstRound = next[0]?.[3];
  const nextGames = next.filter((x) => x[3] === firstRound || (!firstRound && next.indexOf(x) < 10));
  const used = new Set();
  const gameSec = nextGames.map(([utc, h, a, r]) => { used.add(h); used.add(a); const hap = h === L.hap || a === L.hap;
    return `<section class="card inj-game${hap ? ' hap-game' : ''}"><h2>${esc(tname(h))} vs ${esc(tname(a))}${utc ? ` <small class="muted">${esc(fmtDate(utc.slice(0, 10)))}</small>` : ''}</h2><h3>${esc(tname(h))}</h3><div class="scroll">${table(h)}</div><h3>${esc(tname(a))}</h3><div class="scroll">${table(a)}</div></section>`; }).join('');
  const others = [...T.keys()].filter((c) => !used.has(c)).sort((x, y) => tname(x).localeCompare(tname(y)));
  const otherSec = others.length ? `<section class="card"><h2>Other teams</h2>${others.map((c) => `<h3>${esc(tname(c))}</h3><div class="scroll">${table(c)}</div>`).join('')}</section>` : '';
  // every player of the league, for marking someone the box scores do not show yet
  const pool = new Map(); for (const t of T.values()) for (const p of t.players.values()) if (p.gp) pool.set(pkey(p.name), [p.name, t.code]);
  const staffCfg = JSON.stringify({ salt: base.internal?.salt, iterations: base.internal?.iterations, repo: process.env.GITHUB_REPOSITORY || 'hta-lab/hta-lab.github.io', branch: process.env.GITHUB_REF_NAME || 'main', path: 'scouting/plan.enc', root: R, comp: lg }).replace(/</g, '\\u003c');
  const body = `<section class="card"><h2>Staff marks</h2><div id="inj-staff"><p class="muted">Loading…</p></div><p class="muted small">Players marked out are crossed out in the game-day pack (closers, free-throw list, late lineups, player cards). Marks are encrypted with the team password and shared with the staff.${lg === 'el' ? ' The EuroLeague publishes an official injury report before every round on <a href="https://www.euroleaguebasketball.net/euroleague/news/" target="_blank" rel="noopener">euroleaguebasketball.net</a> (news); it cannot be read automatically, so check it there and mark players here.' : ''}</p></section>
${lg === 'el' && MEDIA ? `<section class="card"><h2>Media report — Round ${esc(String(MEDIA.round || ''))}</h2><p>Updated <strong>${esc(fmtDate(MEDIA.updated))}</strong> from ${MEDIA.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(' and ')}. ${(MEDIA.players || []).filter((p) => p.status === 'out' && (p.kind === 'injury' || p.kind === 'illness')).length} players out injured, ${(MEDIA.players || []).filter((p) => ['doubt', 'uncertain'].includes(p.status) && (p.kind === 'injury' || p.kind === 'illness')).length} doubtful or uncertain with an injury. Each team below shows them; your own staff marks always come first.</p></section>` : ''}
${gameSec}${otherSec}
<p class="muted small">Built from the official box scores: a regular (3+ games, 10+ min per game) missing from his team's latest games. "Not on the game roster" usually means injured or rested; "did not play" means he was listed but stayed on the bench.</p>
<script type="application/json" id="inj-pool">${JSON.stringify([...pool].map(([k, [n, c]]) => [k, n, c, tname(c)])).replace(/</g, '\\u003c')}</script>`;
  const mediaJs = lg === 'el' && MEDIA ? (() => { const mk = {}; for (const p of MEDIA.players) if (['out', 'doubt', 'uncertain'].includes(p.status)) mk[pkey(p.name)] = { status: p.status === 'uncertain' ? 'doubt' : p.status, label: MSTATUS[p.status][0], name: p.name, note: `${p.reason} (media, ${MEDIA.updated})` }; return `<script>window.HTA_MEDIA = ${JSON.stringify(mk).replace(/</g, '\\u003c')};</script>`; })() : '';
  const html = page({ title: 'Injury report', cfg: cfgL, info: { games: L.games.length, lastDate: L.games[L.games.length - 1]?.[0], lastRound: null }, active: 'injuries.html', sample: false, body,
    hero: `<section class="cover"><div class="wrap"><div><div class="kicker">${esc(L.short)}</div><h1>Injury report</h1><p class="lede">Who is missing from each team's latest games, the next round first${lg === 'el' ? ', and whether missing EuroLeague players have played in their domestic league since' : ''}. Add your own marks (out, doubtful, available) and they show across the site.</p></div></div></section>`,
    scripts: `${mediaJs}<script>window.HTA_STAFF_CFG = ${staffCfg};</script><script src="${R}staff.js?v=${assetVersion()}" defer></script><script src="${R}injuries.js?v=${assetVersion()}" defer></script>` });
  writeFileSync(join(dirOf(lg), 'injuries.html'), html);
  return rows;
}

/** EuroLeague opponent's latest domestic games, written into the game-day pack. */
function domesticSection() {
  const EL = LOGS.get('el'); if (!EL) return;
  const f = join(SITE, 'gameday-next.html'); if (!existsSync(f)) return;
  let html = readFileSync(f, 'utf8'); const m = html.match(/<!--DOMESTIC:([^>]*)-->/); if (!m) return;
  const oc = m[1];
  const { T } = teamsOf(EL); const t = T.get(oc);
  const nextG = (EL.upcoming || []).find((x) => (x[1] === oc || x[2] === oc) && (x[1] === EL.hap || x[2] === EL.hap));
  const gameT = nextG?.[0] ? Date.parse(nextG[0]) : Date.now();
  const regulars = t ? [...t.players.values()].filter((p) => p.gp >= 2).sort((a, b) => b.min - a.min).slice(0, 12) : [];
  const keys = new Set(regulars.map((p) => pkey(p.name)));
  // the domestic team: the one in another league with most of these players
  let best = null;
  for (const [lg, L] of LOGS) { if (lg === 'el') continue; const cnt = new Map(); for (const g of L.games) for (const q of g[7]) if (keys.has(pkey(q[0])) && q[2] > 0) { const k = q[1]; if (!cnt.has(k)) cnt.set(k, new Set()); cnt.get(k).add(pkey(q[0])); } for (const [code, s] of cnt) if (s.size >= 3 && (!best || s.size > best.n)) best = { lg, L, code, n: s.size }; }
  let sec = '';
  if (best) {
    const { L, code } = best, tn = (c) => L.teams[c]?.[0] || c;
    const gs = L.games.filter((g) => g[3] === code || g[5] === code).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5);
    const gRows = gs.map((g) => { const home = g[3] === code, pf = home ? g[4] : g[6], pa = home ? g[6] : g[4]; return `<tr><td>${esc(fmtDate(g[0]))}</td><td>${home ? 'vs' : 'at'} ${esc(tn(home ? g[5] : g[3]))}</td><td class="num"><strong class="${pf > pa ? 'pos' : 'neg'}">${pf > pa ? 'W' : 'L'} ${pf}–${pa}</strong></td></tr>`; }).join('');
    const last = gs[0];
    const pRows = regulars.map((p) => { const k = pkey(p.name); const apps = gs.map((g) => g[7].find((q) => pkey(q[0]) === k)).filter(Boolean); const lastApp = last ? last[7].find((q) => pkey(q[0]) === k) : null; const played = apps.filter((q) => q[2] > 0);
      const days = last ? Math.round((gameT - D(last[0])) / dayMs) : null; const heavy = lastApp && lastApp[2] >= 28 && days != null && days <= 3;
      return `<tr data-pname="${esc(k)}"${heavy ? ' class="hap-row"' : ''}><td>${esc(p.name)}</td><td class="num">${(p.min / p.gp).toFixed(1)}</td><td class="num">${lastApp ? (lastApp[2] > 0 ? `<strong>${Math.round(lastApp[2])}</strong>` : 'DNP') : '<span class="muted">not listed</span>'}</td><td class="num">${lastApp && lastApp[2] > 0 ? lastApp[3] : '–'}</td><td class="num">${played.length ? (played.reduce((a, q) => a + q[2], 0) / played.length).toFixed(1) : '–'}</td><td class="num">${played.length}/${apps.length || gs.length}</td></tr>`; }).join('');
    const days = last ? Math.round((gameT - D(last[0])) / dayMs) : null;
    sec = `<section class="card"><h2>${esc(tn(code))} in ${esc(L.name)}</h2><p class="muted">Their domestic games before they play us${last ? ` — the last one ${days} day${days === 1 ? '' : 's'} before our game` : ''}. Highlighted: 28+ minutes in a domestic game 3 days or less before ours.</p>
<div class="r-two"><div><h3>Last ${gs.length} games</h3><table class="rtab"><tbody>${gRows}</tbody></table></div><div><h3>EuroLeague regulars at home</h3><table class="rtab"><thead><tr><th>Player</th><th class="num">EL MIN/g</th><th class="num">Last domestic MIN</th><th class="num">PTS</th><th class="num">Domestic MIN/g (last 5)</th><th class="num">Played</th></tr></thead><tbody>${pRows}</tbody></table></div></div></section>`;
  }
  try {
    const TT = travelPage();
    const opp = TT?.get(oc), me = TT?.get(EL.hap);
    const nxO = opp?.list.find((g) => g.upcoming && !g.domestic && g.opp === EL.hap), nxH = me?.list.find((g) => g.upcoming && !g.domestic && g.opp === oc);
    if (nxO) {
      const tn = (c) => EL.teams[c]?.[0] || c;
      const played = opp.list.filter((g) => g.comp === 'EL' && !g.upcoming);
      const sameRest = played.filter((g) => restB(g.rest) === restB(nxO.rest)), sameKm = played.filter((g) => !g.home && kmB(g.km) === kmB(nxO.km));
      const rec = (arr) => { const w = arr.filter((g) => g.win).length; return arr.length ? `${w}–${arr.length - w}` : 'no games'; };
      const kmS = (g) => (g.km ? g.km.toLocaleString('en-US') + ' km' : 'no travel');
      const line = (g, who) => (g.prev ? `${who}: last game <strong>${esc(fmtDate(g.prev.date))}</strong> (${esc(g.prev.comp)}, ${g.prev.home ? 'at home' : g.prev.approx ? 'away' : 'in ' + esc(CITY[g.prev.opp]?.[2] || 'away')}) — <strong>${g.rest} day${g.rest === 1 ? '' : 's'} of rest</strong>, <strong>${kmS(g)}</strong> to this game.`
        : `${who}: rest unknown (we don’t have their domestic league) — <strong>${kmS(g)}</strong> from ${esc(CITY[g.prev?.opp]?.[2] || 'home')} to this game.`);
      sec += `<section class="card"><h2>Rest and travel before this game</h2><p>${line(nxO, esc(tn(oc)))}</p>${nxH ? `<p>${line(nxH, 'Hapoel')}</p>` : ''}
<div class="r-grid">${nxO.rest != null ? `<div class="rs"><span>${esc(tn(oc))} with ${esc(restB(nxO.rest))} of rest</span><b>${rec(sameRest)}</b></div>` : ''}${!nxO.home ? `<div class="rs"><span>${esc(tn(oc))} away after ${esc(kmB(nxO.km))}</span><b>${rec(sameKm)}</b></div><div class="rs"><span>${esc(tn(oc))} on the road, all trips</span><b>${rec(played.filter((g) => !g.home))}</b></div>` : `<div class="rs"><span>${esc(tn(oc))} at home</span><b>${rec(played.filter((g) => g.home))}</b></div>`}</div><p class="muted small">EuroLeague games this season. <a href="travel.html">Every team</a>.</p></section>`;
    }
  } catch (e) { console.log('travel section skipped:', e.message); }
  if (MEDIA) { const mk = {}; for (const p of MEDIA.players) if (['out', 'doubt', 'uncertain'].includes(p.status)) mk[pkey(p.name)] = { status: p.status === 'uncertain' ? 'doubt' : p.status, label: MSTATUS[p.status][0], name: p.name, note: `${p.reason} (media, ${MEDIA.updated})` }; sec += `<script>window.HTA_MEDIA = ${JSON.stringify(mk).replace(/</g, '\\u003c')};</script>`; }
  html = html.replace(m[0], sec);
  writeFileSync(f, html);
  return best;
}


// ---- Travel and rest: distance from each team's previous game (any competition) and days of rest, and how teams do in each situation ----
const CITY = { ASV: [45.77, 4.88, 'Villeurbanne'], BAR: [41.38, 2.12, 'Barcelona'], BAS: [42.85, -2.67, 'Vitoria'], BES: [41.04, 29.0, 'Istanbul'], DUB: [25.2, 55.27, 'Dubai'], HTA: [32.08, 34.78, 'Tel Aviv'], IST: [41.0, 28.97, 'Istanbul'], MAD: [40.42, -3.7, 'Madrid'], MIL: [45.46, 9.19, 'Milan'], MUN: [48.14, 11.58, 'Munich'], OLY: [37.94, 23.65, 'Piraeus'], PAM: [39.47, -0.38, 'Valencia'], PAN: [37.98, 23.73, 'Athens'], PAR: [44.79, 20.45, 'Belgrade'], PRS: [48.86, 2.35, 'Paris'], RED: [44.79, 20.45, 'Belgrade'], TEL: [32.08, 34.78, 'Tel Aviv'], ULK: [40.99, 29.03, 'Istanbul'], VIR: [44.49, 11.34, 'Bologna'], ZAL: [54.9, 23.9, 'Kaunas'] };
const km = (a, b) => { if (!a || !b) return null; const R = 6371, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };
/** The domestic team of a EuroLeague club: the team in another league with most of its players. */
function domesticOf(elCode) {
  const EL = LOGS.get('el'); if (!EL) return null; const { T } = teamsOf(EL); const t = T.get(elCode); if (!t) return null;
  const keys = new Set([...t.players.values()].filter((p) => p.gp >= 2).map((p) => pkey(p.name)));
  let best = null;
  for (const [lg, L] of LOGS) { if (lg === 'el') continue; const cnt = new Map(); for (const g of L.games) for (const q of g[7]) if (keys.has(pkey(q[0])) && q[2] > 0) { if (!cnt.has(q[1])) cnt.set(q[1], new Set()); cnt.get(q[1]).add(pkey(q[0])); } for (const [code, s] of cnt) if (s.size >= 3 && (!best || s.size > best.n)) best = { lg, L, code, n: s.size }; }
  return best;
}
function travelTable() {
  const EL = LOGS.get('el'); if (!EL) return null;
  const out = new Map();
  for (const code of Object.keys(EL.teams)) {
    const home = CITY[code]; if (!home) continue;
    const dom = domesticOf(code);
    const list = [];
    for (const g of EL.games) { if (g[3] !== code && g[5] !== code) continue; const isHome = g[3] === code; list.push({ comp: 'EL', date: g[0], code: g[1], home: isHome, opp: isHome ? g[5] : g[3], at: isHome ? home : CITY[g[3]], win: isHome ? g[4] > g[6] : g[6] > g[4], score: isHome ? `${g[4]}–${g[6]}` : `${g[6]}–${g[4]}` }); }
    if (dom) { for (const g of dom.L.games) { if (g[3] !== dom.code && g[5] !== dom.code) continue; list.push({ comp: dom.L.short, date: g[0], home: g[3] === dom.code, at: home /* away domestic games: their own country, counted at home city */, approx: g[3] !== dom.code }); }
      for (const u of (dom.L.upcoming || [])) if (u[1] === dom.code || u[2] === dom.code) list.push({ comp: dom.L.short, date: (u[0] || '').slice(0, 10), upcoming: true, domestic: true, home: u[1] === dom.code, at: home, approx: u[1] !== dom.code }); }
    for (const u of (EL.upcoming || [])) if (u[1] === code || u[2] === code) list.push({ comp: 'EL', date: (u[0] || '').slice(0, 10), upcoming: true, home: u[1] === code, opp: u[1] === code ? u[2] : u[1], at: u[1] === code ? home : CITY[u[1]], utc: u[0] });
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i++) {
      const prev = list[i - 1], g = list[i]; if (!prev) continue;
      const gap = Math.round((D(g.date) - D(prev.date)) / dayMs) - 1;
      if (dom) { g.rest = gap; g.km = km(prev.at, g.at); g.prev = prev; }
      else {
        // No domestic games for this team: a EuroLeague double week (0–1 days off) is exact; anything longer may hide a domestic game,
        // so rest is unknown, and the trip is counted from the team's own city.
        g.rest = gap <= 1 ? gap : null; g.km = g.home ? 0 : km(home, g.at); g.fromHome = true; if (gap <= 1) { g.prev = prev; g.km = km(prev.at, g.at); g.fromHome = false; }
      }
    }
    out.set(code, { list, dom: dom ? dom.L.short : null });
  }
  return out;
}
const restB = (r) => (r == null ? null : r <= 1 ? '0–1 days' : r === 2 ? '2 days' : '3+ days');
const kmB = (k) => (k == null ? null : k < 1000 ? 'under 1,000 km' : k < 2500 ? '1,000–2,500 km' : '2,500+ km');
function travelPage() {
  const TT = travelTable(); if (!TT) return null;
  const EL = LOGS.get('el'), tn = (c) => EL.teams[c]?.[0] || c;
  const rec = (arr) => { const w = arr.filter((g) => g.win).length; return arr.length ? `${w}–${arr.length - w}` : '–'; };
  const rows = [...TT.entries()].sort((a, b) => tn(a[0]).localeCompare(tn(b[0]))).map(([code, t]) => {
    const played = t.list.filter((g) => g.comp === 'EL' && !g.upcoming);
    const away = played.filter((g) => !g.home);
    const cells = ['0–1 days', '2 days', '3+ days'].map((b) => `<td class="num">${!t.dom && b !== '0–1 days' ? '<span class="muted">n/a</span>' : rec(played.filter((g) => restB(g.rest) === b))}</td>`).join('') + ['under 1,000 km', '1,000–2,500 km', '2,500+ km'].map((b) => `<td class="num">${rec(away.filter((g) => kmB(g.km) === b))}</td>`).join('');
    const nx = t.list.find((g) => g.upcoming && !g.domestic);
    return `<tr${code === EL.hap ? ' class="hap-row"' : ''}><td>${esc(tn(code))}${t.dom ? ` <span class="muted small">+ ${esc(t.dom)}</span>` : ' <span class="muted small">EuroLeague only</span>'}</td>${cells}<td class="small">${nx ? `${nx.home ? 'vs' : 'at'} ${esc(tn(nx.opp))}: ${nx.rest != null ? nx.rest + ' day' + (nx.rest === 1 ? '' : 's') + ' rest' : 'rest unknown'}, ${nx.km ? nx.km.toLocaleString('en-US') + ' km' : 'home game'}` : '–'}</td></tr>`; }).join('');
  const cfgL = { ...base, LEAGUE: 'el', root: '' };
  const html = page({ title: 'Travel and rest', cfg: cfgL, info: { games: EL.games.length, lastDate: EL.games[EL.games.length - 1]?.[0], lastRound: null }, active: 'travel.html', sample: false,
    body: `<section class="card"><h2>EuroLeague record by rest and travel</h2><div class="scroll"><table class="rtab"><thead><tr><th>Team</th><th class="num">0–1 days rest</th><th class="num">2 days</th><th class="num">3+ days</th><th class="num">Away, under 1,000 km</th><th class="num">1,000–2,500 km</th><th class="num">2,500+ km</th><th>Next game</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted small">Rest = full days off since the previous game in any competition the site covers (the EuroLeague plus the domestic league where we have it). Distance = straight line from the city of the previous game to the city of this one; domestic away games count from the team’s own city. Teams marked “EuroLeague only” play a domestic league the site doesn’t cover: for them only EuroLeague double weeks (0–1 days off) are exact, other rest is shown as n/a, and trips are counted from their own city.</p></section>`,
    hero: `<section class="cover"><div class="wrap"><div><div class="kicker">EuroLeague</div><h1>Travel and rest</h1><p class="lede">Days of rest and distance travelled before every game, and how each team does on short rest and long trips.</p></div></div></section>` });
  writeFileSync(join(SITE, 'travel.html'), html);
  return TT;
}

for (const lg of ['el', 'il']) if (LOGS.has(lg)) { injuriesPage(lg); console.log(`✓ Injury report (${lg})`); }
const d = domesticSection(); if (d) console.log(`✓ Domestic games of the next EuroLeague opponent (${d.L.short})`);
if (!existsSync(join(SITE, 'travel.html'))) travelPage();
console.log('✓ Travel and rest');
