// HAPOEL home page (site/index.html): everything about Hapoel Tel Aviv in one place, EuroLeague + Winner League.
// Runs after the league builds. Reads the same official data the league sections are built from, so every number
// matches the league pages; league ranks and averages are computed against each competition.
//
//   node scripts/build-hapoel.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGame, formatName } from '../lib/parse.mjs';
import { validateGame } from '../lib/validate.mjs';
import { teamTable, playerTable, qualified, teamGames, quarterAverages, possessions } from '../lib/stats.mjs';
import { esc, f1, signed, page, fmtDate, assetVersion } from '../lib/render.mjs';
import { buildStints, checkStints, aggregate, rapm, repairPlusMinus } from '../lib/pbp.mjs';
import { clutch as clutchOf, afterTimeouts, onOff, rates as situRates, flowExtras } from '../lib/situ.mjs';
import { playerRates } from '../lib/advanced.mjs';
import { playLog, offensiveFouls } from '../lib/game.mjs';
import { indexPeople, findPerson, ageOn } from '../lib/people.mjs';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const OUT = 'site';
const cfg = { ...base, LEAGUE: 'hub', root: '', HOME: 'index.html', elLogo: base.leagueLogo, seasonLabel: 'Hapoel Tel Aviv 2026–27', sourceText: 'the official EuroLeague and Winner League box scores' };
const safe = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
const TK = ['pts', 'fgm2', 'fga2', 'fgm3', 'fga3', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'tov', 'blk', 'blka', 'pf', 'fd', 'pir'];
const KEEP_UPPER = new Set(['LDLC', 'ASVEL', 'AKTOR', 'BC', 'FC', 'KK', 'BK', 'AS', 'EA7', 'CSKA', 'PAOK', 'AEK', 'UNICS', 'ALBA', 'TSU']);
const titleCase = (s) => String(s || '').split(/\s+/).map((w) => (KEEP_UPPER.has(w) || w.length <= 2 || /\d/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
const ord = (n) => { const t = n % 100 >= 11 && n % 100 <= 13; return n + (t ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')); };
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

// ---- The two competitions Hapoel plays in ----
const IL = base.leagues?.il || {};
const COMPS = [
  { key: 'el', short: 'EuroLeague', name: 'EuroLeague', dir: join('data', 'raw', base.seasonCode), pfx: '', home: 'euroleague.html', logo: base.leagueLogo, code: base.hapoelCode || 'HTA' },
  { key: 'il', short: 'Winner League', name: IL.leagueName || 'Winner League', dir: join('data', 'raw', IL.dataDir || 'ISR2027'), pfx: 'il/', home: 'il/index.html', logo: IL.leagueLogo || '', code: null }
].filter((c) => existsSync(c.dir));

for (const C of COMPS) {
  const files = readdirSync(C.dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  C.raw = new Map();
  C.games = files.map((f) => { const raw = JSON.parse(readFileSync(join(C.dir, f))); const g = parseGame(raw); C.raw.set(g.gameCode, raw.pbp || null); return g; }).filter((g) => !validateGame(g).length);
  C.crests = new Map();
  try { for (const c of JSON.parse(readFileSync(join(C.dir, '_clubs.json')))) if (c.code && /^https:\/\//.test(c.crest || '')) C.crests.set(c.code, c.crest); } catch { /* no crests */ }
  try { C.clubs = JSON.parse(readFileSync(join(C.dir, '_clubs.json'))); } catch { C.clubs = []; }
  try { C.schedule = JSON.parse(readFileSync(join(C.dir, '_schedule.json'))); } catch { C.schedule = []; }
  try { C.people = indexPeople(JSON.parse(readFileSync(join(C.dir, '_people.json')))); } catch { C.people = indexPeople([]); }
  if (!C.code) C.code = C.clubs.find((c) => /hapoel/i.test(c.name || '') && /tel[ -]?aviv/i.test(c.name || ''))?.code
    || C.games.flatMap((g) => [g.home, g.away]).find((s) => /hapoel/i.test(s.name) && /tel[ -]?aviv/i.test(s.name))?.code;
}
const ACTIVE = COMPS.filter((c) => c.code && c.games.some((g) => g.home.code === c.code || g.away.code === c.code));
if (!ACTIVE.length) { console.error('No Hapoel games found.'); process.exit(0); }

// ---- Per competition: league context (ranks, averages, play-by-play, boards) ----
const isMine = (C, g) => g.home.code === C.code || g.away.code === C.code;
for (const C of ACTIVE) {
  C.teams = teamTable(C.games);
  C.team = C.teams.find((t) => t.code === C.code);
  C.players = playerTable(C.games);
  C.qual = qualified(C.players, C.teams, base);
  C.rates = playerRates(C.games);
  C.pbpOk = [];
  for (const g of C.games) {
    const pbp = C.raw.get(g.gameCode); if (!pbp) continue;
    const r = buildStints(g, pbp); if (!r.ok) continue;
    repairPlusMinus(g, r.stints);
    if (!checkStints(g, r.stints)) C.pbpOk.push({ game: g, stints: r.stints, periodStints: r.periodStints, events: r.events });
  }
  C.OO = C.pbpOk.length ? onOff(C.pbpOk.filter((e) => isMine(C, e.game))).filter((x) => x.team === C.code) : [];
  C.CL = C.pbpOk.length ? clutchOf(C.pbpOk) : null;
  C.ATO = C.pbpOk.some((e) => e.events.some((x) => x.type === 'TOUT')) ? afterTimeouts(C.pbpOk) : null;
  C.PBP = C.pbpOk.length ? aggregate(C.pbpOk) : null;
  C.IMPACT = C.PBP ? rapm(C.PBP.rows) : null;
  C.OFP = new Map();
  for (const g of C.games) { const pbp = C.raw.get(g.gameCode); if (!pbp) continue; for (const [id, n] of offensiveFouls(playLog(g, pbp).plays).drawers) C.OFP.set(id, (C.OFP.get(id) || 0) + n); }
  C.mine = C.games.filter((g) => isMine(C, g)).sort((a, b) => a.date.localeCompare(b.date) || String(a.gameCode).localeCompare(String(b.gameCode)));
  C.roster = C.players.filter((p) => C.mine.some((g) => (g.home.code === C.code ? g.home : g.away).players.some((x) => x.id === p.id && x.min > 0)));
  C.lg = (k) => C.teams.reduce((s, t) => s + t[k], 0) / (C.teams.length || 1);
  C.onoff = (id) => {
    const o = C.PBP?.onoff.get(id); if (!o) return null;
    const off = { poss: o.teamTot.poss - o.on.poss, pf: o.teamTot.pf - o.on.pf, pa: o.teamTot.pa - o.on.pa };
    const net = (x) => (x.poss > 0 ? 100 * (x.pf - x.pa) / x.poss : null);
    return { onMin: o.on.secs / 60, onPoss: o.on.poss, onNet: net(o.on), offNet: net(off), swing: net(o.on) != null && net(off) != null && off.poss >= 20 ? net(o.on) - net(off) : null,
      onDrtg: o.on.poss >= 300 ? 100 * o.on.pa / o.on.poss : null, defSwing: o.on.poss >= 300 && off.poss >= 50 ? 100 * off.pa / off.poss - 100 * o.on.pa / o.on.poss : null };
  };
}

// ---- Games: every Hapoel game, both competitions, with full box scores ----
const gameRows = [];
for (const C of ACTIVE) for (const g of C.mine) {
  const home = g.home.code === C.code, me = home ? g.home : g.away, op = home ? g.away : g.home;
  const line = (p) => [p.name, p.id, p.starter ? 1 : 0, r2(p.min), p.pm, ...TK.map((k) => p[k])];
  gameRows.push({ c: C.key, id: String(g.gameCode), d: g.date, r: g.round, h: home ? 1 : 0, w: me.score > op.score ? 1 : 0,
    opp: [titleCase(op.name), C.crests.get(op.code) || null, op.tv], s: [me.score, op.score],
    q: [me.quarters || [], op.quarters || []], href: `${C.pfx}game-${safe(g.gameCode)}.html`, rep: (C.key === 'el' || C.key === 'il') ? `${C.pfx}game-${safe(g.gameCode)}-hapoel.html` : null,
    me: { p: me.players.filter((p) => p.min > 0 || p.starter).map(line), t: TK.map((k) => me.totals[k]), min: me.teamMinutes || 200 },
    op: { p: op.players.filter((p) => p.min > 0 || p.starter).map(line), t: TK.map((k) => op.totals[k]), min: op.teamMinutes || 200 } });
}
gameRows.sort((a, b) => b.d.localeCompare(a.d));

// One identity per Hapoel player across both competitions (same person, two league ids).
const people = new Map(); // key -> { name, ids:Set, href:{comp:href} }
const keyOf = new Map();
for (const C of ACTIVE) for (const p of C.roster) {
  const k = normName(p.name);
  if (!people.has(k)) people.set(k, { key: k, name: p.name, ids: new Set(), href: {} });
  const e = people.get(k); e.ids.add(p.id); e.href[C.key] = `${C.pfx}player-${safe(p.id)}.html`; keyOf.set(C.key + '|' + p.id, k);
}
for (const G of gameRows) for (const row of G.me.p) row[1] = keyOf.get(G.c + '|' + row[1]) || row[1];

// ---- Lineups: Hapoel's five on the court, every stint, from games whose play-by-play matches the box score ----
const stintRows = [];
for (const C of ACTIVE) for (const { game, stints } of C.pbpOk) {
  if (!isMine(C, game)) continue;
  const home = game.home.code === C.code, op = home ? game.away.code : game.home.code;
  for (const s of stints) {
    const ids = (home ? s.home : s.away).map((id) => keyOf.get(C.key + '|' + id) || id);
    const pMe = home ? s.possH : s.possA, pOp = home ? s.possA : s.possH;
    stintRows.push([String(game.gameCode), C.key, ids.join('|'), Math.round(s.secs), s.pts[C.code], s.pts[op], r2(pMe), r2(pOp)]);
  }
}
const lineupGames = new Set(stintRows.map((r) => r[1] + '|' + r[0]));

// ---- Team stats: per competition (with league rank and average) and both competitions together ----
// Shooting made/attempted per game (team and opponents) and points per possession, ranked like the rest.
const EXTRA = [['fgm2', 1], ['fga2', 1], ['fgm3', 1], ['fga3', 1], ['ftm', 1], ['fta', 1]];
function augment(t) {
  if (!t?.raw || !t.gp) return t;
  for (const [k] of EXTRA) { t[k + 'pg'] = t.raw.tot[k] / t.gp; t['o' + k + 'pg'] = t.raw.opp[k] / t.gp; }
  t.ppp = t.raw.poss ? t.raw.pf / t.raw.poss : null; t.oppp = t.raw.poss ? t.raw.pa / t.raw.poss : null;
  return t;
}
const EXTRA_DIR = { ppp: true, oppp: false, ...Object.fromEntries(EXTRA.flatMap(([k]) => [[k + 'pg', true], ['o' + k + 'pg', false]])) };
for (const C of ACTIVE) {
  C.teams.forEach(augment);
  for (const [k, better] of Object.entries(EXTRA_DIR)) {
    if (better == null) continue;
    const sorted = [...C.teams].filter((t) => t[k] != null).sort((a, b) => (better ? b[k] - a[k] : a[k] - b[k]));
    sorted.forEach((t, i) => { t.ranks ||= {}; t.ranks[k] = i + 1; });
  }
}
const STATS = [
  ['Record', null, (t) => `${t.w}–${t.l}`],
  ['Points', 'ppg'], ['Points allowed', 'oppg'], ['Offensive rating', 'ortg'], ['Defensive rating', 'drtg'], ['Net rating', 'net', null, true], ['Pace', 'pace'], ['Points per possession (PPP)', 'ppp', (t) => (t.ppp == null ? '–' : t.ppp.toFixed(3))], ['Opp points per possession', 'oppp', (t) => (t.oppp == null ? '–' : t.oppp.toFixed(3))],
  ['2-pointers made', 'fgm2pg'], ['2-pointers attempted', 'fga2pg'], ['3-pointers made', 'fgm3pg'], ['3-pointers attempted', 'fga3pg'], ['Free throws made', 'ftmpg'], ['Free throws attempted', 'ftapg'],
  ['Opp 2-pointers made', 'ofgm2pg'], ['Opp 2-pointers attempted', 'ofga2pg'], ['Opp 3-pointers made', 'ofgm3pg'], ['Opp 3-pointers attempted', 'ofga3pg'], ['Opp free throws made', 'oftmpg'], ['Opp free throws attempted', 'oftapg'],
  ['eFG%', 'efg'], ['True shooting %', 'ts'], ['Turnovers / 100', 'tov100'], ['Offensive rebound %', 'orebPct'], ['Free-throw rate', 'ftr'],
  ['Opp eFG%', 'efgD'], ['Forced turnovers / 100', 'tov100D'], ['Defensive rebound %', 'drebPct'], ['Opp free-throw rate', 'ftrD'],
  ['2P%', 'twoPct'], ['3P%', 'threePct'], ['3-point rate', 'threeRate'], ['FT%', 'ftPct'], ['Assist rate', 'astRate'],
  ['Opp 2P%', 'twoPctD'], ['Opp 3P%', 'threePctD'], ['Opp 3-point rate', 'threeRateD'],
  ['Rebounds', 'rpg'], ['Assists', 'apg'], ['Steals', 'spg'], ['Blocks', 'bpg']
];
// Both competitions together: Hapoel's games, with the Israeli code mapped to one team.
const allMine = ACTIVE.flatMap((C) => C.mine.map((g) => { const map = (s) => (s.code === C.code ? { ...s, code: 'HAP', tv: 'HTA' } : s); return { ...g, gameCode: C.key + g.gameCode, home: map(g.home), away: map(g.away) }; }));
const tAll = augment(teamTable(allMine).find((t) => t.code === 'HAP'));
const splitRow = (gs) => (gs.length ? augment(teamTable(gs).find((t) => t.code === 'HAP')) : null);
const wins = allMine.filter((g) => (g.home.code === 'HAP' ? g.home.score > g.away.score : g.away.score > g.home.score));
const losses = allMine.filter((g) => !wins.includes(g));
const tW = splitRow(wins), tL = splitRow(losses);
const tH = splitRow(allMine.filter((g) => g.home.code === 'HAP')), tA = splitRow(allMine.filter((g) => g.away.code === 'HAP'));
for (const C of ACTIVE) {
  const won = (g) => (g.home.code === C.code ? g.home.score > g.away.score : g.away.score > g.home.score);
  const one = (gs) => (gs.length ? augment(teamTable(gs).find((t) => t.code === C.code)) || null : null);
  C.split = { w: one(C.mine.filter(won)), l: one(C.mine.filter((g) => !won(g))), h: one(C.mine.filter((g) => g.home.code === C.code)), a: one(C.mine.filter((g) => g.away.code === C.code)) };
}
const fmtV = (t, k, fmt) => (!t ? '–' : fmt ? fmt(t) : k === 'net' ? signed(t[k]) : f1(t[k]));
const rk = (C, k) => (C.team?.ranks?.[k] ? `<span class="rank ${C.team.ranks[k] <= 3 ? 'top' : C.team.ranks[k] > C.teams.length - 3 ? 'bottom' : ''}">${ord(C.team.ranks[k])}</span>` : '');
const teamStatsTable = `<div class="scroll"><table class="hap-stats"><thead><tr><th scope="col">Stat</th><th scope="col" class="num" data-comp-col="all">All</th>
${ACTIVE.map((C) => `<th scope="col" class="num" data-comp-col="${C.key}">${esc(C.short)}</th><th scope="col" class="num muted" data-comp-col="${C.key}">${esc(C.short)} avg</th>${[['w', 'Wins'], ['l', 'Losses'], ['h', 'Home'], ['a', 'Away']].map(([k, l]) => `<th scope="col" class="num" data-comp-col="${C.key}">${l}${C.split[k] ? ` <span class="muted small">${C.split[k].w}–${C.split[k].l}</span>` : ''}</th>`).join('')}`).join('')}
<th scope="col" class="num" data-comp-col="all">Wins</th><th scope="col" class="num" data-comp-col="all">Losses</th><th scope="col" class="num" data-comp-col="all">Home</th><th scope="col" class="num" data-comp-col="all">Away</th></tr></thead><tbody>
${STATS.map(([label, k, fmt]) => `<tr><th scope="row">${label}</th><td class="num" data-comp-col="all"><strong>${fmtV(tAll, k, fmt)}</strong></td>
${ACTIVE.map((C) => `<td class="num" data-comp-col="${C.key}">${fmtV(C.team, k, fmt)} ${k ? rk(C, k) : ''}</td><td class="num muted" data-comp-col="${C.key}">${k ? (/ppp$/.test(k) ? C.lg(k).toFixed(3) : f1(C.lg(k))) : ''}</td>${['w', 'l', 'h', 'a'].map((x) => `<td class="num" data-comp-col="${C.key}">${fmtV(C.split[x], k, fmt)}</td>`).join('')}`).join('')}
<td class="num" data-comp-col="all">${fmtV(tW, k, fmt)}</td><td class="num" data-comp-col="all">${fmtV(tL, k, fmt)}</td><td class="num" data-comp-col="all">${fmtV(tH, k, fmt)}</td><td class="num" data-comp-col="all">${fmtV(tA, k, fmt)}</td></tr>`).join('')}
</tbody></table></div>
<p class="muted small">Per game; ratings are points per 100 possessions. Rank = place in that league (1st = best); avg = league average. Wins, losses, home and away are within the competition chosen above ("All competitions" combines both).</p>`;
const quarterTable = (() => {
  const rows = ACTIVE.map((C) => { const q = quarterAverages(teamGames(C.games, C.code)); return q ? `<tr><th scope="row">${esc(C.short)}</th>${q.map((x) => `<td class="num">${f1(x.for)}–${f1(x.against)} <small class="${x.margin >= 0 ? 'pos' : 'neg'}">${signed(x.margin)}</small></td>`).join('')}</tr>` : ''; }).join('');
  return rows ? `<div class="scroll"><table><thead><tr><th scope="col"></th><th scope="col" class="num">Q1</th><th scope="col" class="num">Q2</th><th scope="col" class="num">Q3</th><th scope="col" class="num">Q4</th></tr></thead><tbody>${rows}</tbody></table></div>` : '';
})();

// ---- Leaderboards: every home-page board, Hapoel players only, with their rank in the league ----
function boardsFor(C) {
  const R = (k) => (p) => C.rates.get(p.id)?.[k] ?? null;
  const defs = [
    ['Points', 'Per game', (p) => p.ppg, 'qual'], ['PIR', 'Performance Index Rating per game', (p) => p.pirpg, 'qual'],
    ['PRA', 'Points + rebounds + assists per game', (p) => p.pra, 'qual'], ['Stocks', 'Steals + blocks per game', (p) => p.stocks, 'qual'],
    ['Rebounds', 'Per game', (p) => p.rpg, 'qual'], ['Assists', 'Per game', (p) => p.apg, 'qual'],
    ['True shooting %', 'Scoring efficiency', (p) => p.ts, 'qual'], ['Usage %', 'Share of possessions used on the court', (p) => p.usg, 'qual'],
    ['PIR per 40', 'Per 40 minutes', R('pir40'), 'qual'], ['Points per 40', 'Per 40 minutes', R('pts40'), 'qual'],
    ['Rebounds per 40', 'Per 40 minutes', R('reb40'), 'qual'], ['Assists per 40', 'Per 40 minutes', R('ast40'), 'qual'],
    ['Steal %', 'Opponent possessions ending in his steal', R('stlPct'), 'qual'], ['Block %', 'Opponent 2-point shots he blocked', R('blkPct'), 'qual'],
    ['Defensive rebound %', 'Available defensive rebounds he grabbed', R('drebPct'), 'qual'], ['Stocks per 40', 'Steals + blocks per 40 minutes', R('stocks40'), 'qual'],
    ['Offensive fouls drawn', 'Charges and other offensive fouls drawn, season total', (p) => C.OFP.get(p.id) || null, 'all', (v) => String(Math.round(v))],
    ['On/off', 'Team net rating per 100 with him on the court minus off it', (p) => C.onoff(p.id)?.swing ?? null, 'all', signed],
    ['Impact (RAPM)', 'Adjusted plus-minus per 100 possessions', (p) => C.IMPACT?.values.get(p.id) ?? null, 'all', signed],
    ['On-court defense', 'Points allowed per 100 with him on the court (lower is better, 300+ possessions)', (p) => C.onoff(p.id)?.onDrtg ?? null, 'all', f1, true],
    ['Defensive on/off', 'Fewer points allowed per 100 with him on than off (300+ possessions)', (p) => C.onoff(p.id)?.defSwing ?? null, 'all', signed]
  ];
  const isQ = new Set(C.qual.map((q) => q.id));
  return defs.map(([title, sub, val, poolKind, fmt = f1, asc = false]) => {
    const pool = poolKind === 'qual' ? C.qual : C.players;
    const ranked = pool.map((p) => ({ p, v: val(p) })).filter((x) => x.v != null && Number.isFinite(x.v)).sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
    const rankOf = new Map(ranked.map((x, i) => [x.p.id, i + 1]));
    const mine = C.roster.map((p) => ({ p, v: val(p) })).filter((x) => x.v != null && Number.isFinite(x.v)).sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
    if (!mine.length) return '';
    const vals = mine.map((x) => x.v), hi = Math.max(...vals), lo = Math.min(...vals);
    const width = (v) => (asc ? (hi === lo ? 100 : 5 + 95 * (hi - v) / (hi - lo)) : hi > 0 ? 100 * Math.max(0, v) / hi : 50);
    return `<section class="card board open"><h2>${title}</h2><p class="muted">${sub}. Ranked within Hapoel.</p><ol>
${mine.map(({ p, v }, i) => `<li><span class="muted num">${ord(i + 1)}</span><div><a href="${C.pfx}player-${safe(p.id)}.html">${esc(p.name)}</a>${poolKind === 'qual' && !isQ.has(p.id) ? ' <span class="muted small">(few minutes)</span>' : ''}<div class="bar"><span style="width:${Math.max(3, width(v)).toFixed(1)}%"></span></div></div><strong class="num">${fmt(v)}</strong></li>`).join('')}
</ol></section>`;
  }).filter(Boolean);
}
// MVP index (same formula as the league home page), Hapoel players with their place in the league race.
function mvpFor(C) {
  const F = [[(p) => p.pirpg, 0.30], [(p) => C.IMPACT?.values.get(p.id) ?? null, 0.20], [(p) => { const t = C.teams.find((x) => x.code === p.team); return t && t.gp ? 100 * t.w / t.gp : null; }, 0.15], [(p) => p.ppg, 0.15], [(p) => p.ts, 0.10], [(p) => C.onoff(p.id)?.swing ?? null, 0.10]];
  const vals = F.map(([get]) => C.qual.map(get));
  const st = vals.map((arr) => { const v = arr.filter((x) => x != null && Number.isFinite(x)); const m = v.reduce((s, x) => s + x, 0) / (v.length || 1); const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1; return { m, sd }; });
  const rows = C.qual.map((p, i) => ({ p, score: F.reduce((s, [, w], j) => { const v = vals[j][i]; return s + (v == null || !Number.isFinite(v) ? 0 : (v - st[j].m) / st[j].sd) * w; }, 0) })).sort((a, b) => b.score - a.score);
  const mine = rows.map((x, i) => ({ ...x, r: i + 1 })).filter((x) => C.roster.some((p) => p.id === x.p.id));
  if (!mine.length) return '';
  return `<section class="card board open"><h2>MVP race</h2><p class="muted">HTA LAB MVP index (PIR 30%, impact 20%, team win % 15%, points 15%, TS% 10%, on/off 10%) — ranked within Hapoel.</p><ol>
${mine.map((x, i) => `<li><span class="muted num">${ord(i + 1)}</span><div><a href="${C.pfx}player-${safe(x.p.id)}.html">${esc(x.p.name)}</a><div class="bar"><span style="width:${Math.max(3, Math.min(100, 50 + 25 * x.score)).toFixed(1)}%"></span></div></div><strong class="num">${x.score.toFixed(2)}</strong></li>`).join('')}
</ol></section>`;
}

// ---- Player details (per competition) for the players table: position, height, age, on/off, impact ----
const today = new Date().toISOString().slice(0, 10);
const extra = {};
for (const C of ACTIVE) for (const p of C.roster) {
  const k = keyOf.get(C.key + '|' + p.id), person = findPerson(C.people, p), oo = C.onoff(p.id), rt = C.rates.get(p.id);
  extra[k] ||= { pos: '', ht: null, age: null, num: '' };
  const e = extra[k];
  e.pos ||= person?.position || ''; e.ht ||= person?.height || null; e.age ??= person ? ageOn(person.birthDate, today) : null; e.num ||= p.number || person?.dorsal || '';
  e[C.key] = { usg: r2(p.usg), swing: r2(oo?.swing ?? null), imp: r2(C.IMPACT?.values.get(p.id) ?? null), onMin: r2(oo?.onMin ?? null), stlPct: r2(rt?.stlPct), blkPct: r2(rt?.blkPct), drebPct: r2(rt?.drebPct), ofd: C.OFP.get(p.id) || 0 };
}

// ---- Schedule: next games and results, both competitions ----
const sched = [];
for (const C of COMPS) {
  const code = C.code; if (!code) continue;
  const played = new Set(C.games.map((g) => String(g.gameCode)));
  for (const x of C.schedule) {
    if (x.h?.code !== code && x.a?.code !== code) continue;
    const home = x.h.code === code, o = home ? x.a : x.h;
    const g = C.games.find((gg) => String(gg.gameCode) === String(x.c));
    const me = g ? (home ? g.home : g.away) : null, op = g ? (home ? g.away : g.home) : null;
    sched.push({ c: C.key, oc: o.code, gc: x.c, utc: x.utc || null, ok: x.ok !== false, r: x.r, rn: x.rn || '', home, opp: titleCase(o.name || o.code), crest: C.crests.get(o.code) || null, venue: x.venue || '',
      res: me ? [me.score, op.score] : null, href: g ? `${C.pfx}game-${safe(g.gameCode)}.html` : null, played: !!me || played.has(String(x.c)) });
  }
}
sched.sort((a, b) => String(a.utc).localeCompare(String(b.utc)));
const nowISO = new Date().toISOString();
const nextGames = sched.filter((x) => !x.res && String(x.utc) >= nowISO.slice(0, 10)).slice(0, 6);
const compShort = Object.fromEntries(COMPS.map((C) => [C.key, C.short]));
const compBadge = (k) => `<span class="comp-tag comp-${k}">${k === 'el' ? 'EL' : 'IL'}</span>`;
const timeTag = (x) => `<time data-utc="${esc(x.utc || '')}" datetime="${esc(x.utc || '')}">${esc(x.utc ? x.utc.slice(0, 16).replace('T', ' ') + ' UTC' : 'Date to be confirmed')}</time>`;
const schedRow = (x) => `<tr data-comp="${x.c}"><td>${compBadge(x.c)}</td><td>${timeTag(x)}${x.ok ? '' : ' <span class="muted small">(time TBC)</span>'}</td><td>${x.home ? 'vs' : 'at'} ${x.crest ? `<img class="crest small" src="${esc(x.crest)}" alt="" width="20" height="20">` : ''}${esc(x.opp)}</td>
<td>${x.res ? `<a class="${x.res[0] > x.res[1] ? 'pos' : 'neg'}" href="${x.href}"><strong>${x.res[0] > x.res[1] ? 'W' : 'L'} ${x.res[0]}–${x.res[1]}</strong></a>` : '<span class="muted">–</span>'}</td><td class="muted small">${esc(x.rn || (x.r ? 'Round ' + x.r : ''))}</td></tr>`;

// ---- Leagues: every league section, with its logo ----
const LEAGUES = [['el', { leagueName: 'EuroLeague', shortName: 'EuroLeague', leagueLogo: base.leagueLogo, seasonLabel: base.seasonLabel }], ...Object.entries(base.leagues || {})];
const leaguesGrid = `<div class="league-grid">${LEAGUES.map(([k, L]) => `<a class="league-card" href="${k === 'el' ? 'euroleague.html' : k + '/index.html'}">${L.leagueLogo ? `<img src="${esc(L.leagueLogo)}" alt="" loading="lazy">` : `<i class="lg-dot big">${esc((L.shortName || k).slice(0, 3))}</i>`}<span class="lc-name">${esc(L.leagueName || L.shortName)}</span><span class="lc-sub muted small">${esc(L.seasonLabel || '')}</span></a>`).join('')}</div>`;

// ---- Page ----
const elC = ACTIVE.find((c) => c.key === 'el'), ilC = ACTIVE.find((c) => c.key === 'il');
const crest = elC?.crests.get(elC.code) || ilC?.crests.get(ilC.code) || '';
const rec = (C) => (C?.team ? `${C.team.w}–${C.team.l}` : '');
const hero = `<section class="cover hap-cover"><div class="wrap"><div>
<span class="kicker">HTA LAB · Home</span><h1>Hapoel Tel Aviv</h1>
<div class="cover-meta">${ACTIVE.map((C) => `<span>${esc(C.short)} ${rec(C)}${C.team ? ` · ${ord(C.team.rank)}` : ''}</span>`).join('<span class="sep">/</span>')}</div>
<p class="cover-lede">${nextGames[0] ? `Next: <strong>${nextGames[0].home ? 'vs' : 'at'} ${esc(nextGames[0].opp)}</strong> (${esc(compShort[nextGames[0].c])}) · ${timeTag(nextGames[0])}` : 'Every Hapoel game, box score, lineup and stat — EuroLeague and Winner League.'}</p>
<div class="strip">${tAll ? `<span><b>${tAll.w}–${tAll.l}</b> all games</span><span><b>${f1(tAll.ortg)}</b> ORtg</span><span><b>${f1(tAll.drtg)}</b> DRtg</span><span><b>${signed(tAll.net)}</b> net</span>` : ''}</div>
</div>${crest ? `<div class="side cover-crest"><img src="${esc(crest)}" alt=""></div>` : ''}</div></section>`;

const tabs = `<div class="comp-tabs" role="tablist" aria-label="Competition"><button type="button" role="tab" data-comp="all" aria-selected="true">All competitions</button>${ACTIVE.map((C) => `<button type="button" role="tab" data-comp="${C.key}" aria-selected="false">${C.logo ? `<img src="${esc(C.logo)}" alt="" width="18" height="18">` : ''}${esc(C.short)}</button>`).join('')}</div>`;
const navLinks = `<nav class="hap-toc" aria-label="On this page"><a href="weekly.html"><strong>This week</strong></a><a href="#schedule">Schedule</a><a href="#boxscores">Box scores</a><a href="#team">Team stats</a><a href="#players">Players</a><a href="#next">Next opponent</a><a href="#last-game">Last game</a>${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}-wins-losses.html">Wins vs losses (${esc(C.short)})</a>`).join('')}${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}-benchmark.html">Vs top 10 (${esc(C.short)})</a>`).join('')}${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}-lineup-builder.html">Lineup builder (${esc(C.short)})</a>`).join('')}${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}-inside.html">Inside our games (${esc(C.short)})</a>`).join('')}<a href="keys.html">Keys to the game &amp; goals</a><a href="hapoel-form.html">Form lines</a><a href="injuries.html">Injury report</a><a href="coach-habits.html">Coach habits</a><a href="clips.html">Clip list</a><a href="shot-quality.html">Shot quality</a><a href="team-HTA-weakspots.html">Turnovers, possessions &amp; rebounds</a><a href="team-HTA-profiles.html">Percentile profiles</a><a href="league-trends.html">League trends</a><a href="travel.html">Travel &amp; rest</a><a href="cards.html">Scouting cards</a>${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}-passing.html">Passing network (${esc(C.short)})</a>`).join('')}<a href="#onoff">On/Off</a><a href="#clutch">Clutch</a><a href="#load">Load &amp; rest</a><a href="#referees">Referees</a><a href="#lineups">Lineups</a><a href="compare.html">Compare players</a><a href="recruit.html">Recruiting</a><a href="#boards">Leaderboards</a><a href="#leagues">Leagues</a></nav>`;

const person = (k) => (people.get(k)?.name || k);
const data = {
  comps: Object.fromEntries(ACTIVE.map((C) => [C.key, C.short])), tk: TK,
  games: gameRows,
  people: Object.fromEntries([...people.values()].map((e) => [e.key, [e.name, e.href.el || e.href.il || null, extra[e.key] || {}]])),
  stints: stintRows, lineupGames: [...lineupGames]
};
// ---- Next opponent: pre-game scouting report (team report of the next opponent, rebuilt every night) ----
const sgn1 = (v) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
const nextByComp = ACTIVE.map((C) => nextGames.find((x) => x.c === C.key)).filter(Boolean);
const nextHtml = nextByComp.length ? `<section class="card next-opp" id="next"><h2>Next opponent — pre-game report</h2>
<p class="muted">Rebuilt every night from the latest games: the opponent's profile, wins vs losses, compared with the league and with Hapoel, starting fives, personnel and player keys, lineups, form in the last 5 games, clutch and after-timeout plays. Print it or save it as a PDF.</p>
<div class="next-grid">${nextByComp.map((x) => { const C = ACTIVE.find((c) => c.key === x.c); const href = `${C.pfx}team-${safe(x.oc)}-report.html`; const t = C.teams.find((tt) => tt.code === x.oc); return `<a class="next-card" href="${href}">${x.crest ? `<img src="${esc(x.crest)}" alt="" width="56" height="56">` : ''}<span class="nc-body"><span class="kicker">${compBadge(x.c)} ${esc(x.rn || (x.r ? 'Round ' + x.r : ''))}</span><strong>${x.home ? 'vs' : 'at'} ${esc(x.opp)}</strong><span class="muted small">${timeTag(x)}${t ? ` · ${t.w}–${t.l} · ${ord(t.rank)}` : ''}</span><span class="btn">Open pre-game report →</span></span></a>`; }).join('')}</div><p class="gd-links">${nextByComp.map((x) => { const C = ACTIVE.find((c) => c.key === x.c); return `<a class="btn" href="${C.pfx}gameday-next.html">Game-day pack: ${esc(x.opp)} (${esc(C.short)}) →</a>`; }).join(' ')}</p>${nextByComp.some((x) => x.c === 'el') ? `<p class="small">During the EuroLeague game: ${nextByComp.filter((x) => x.c === 'el').map((x) => `<a href="live.html?game=${x.gc}"><strong>Live</strong></a> · <a href="live.html?game=${x.gc}&view=half"><strong>Halftime report</strong></a> · <a href="live.html?game=${x.gc}&view=bench"><strong>Bench screen</strong></a>`).join('')}</p>` : ''}</section>` : '';

// ---- Post-game summary: the last game in each competition ----
const lastGameHtml = (() => {
  const blocks = ACTIVE.map((C) => {
    const g = C.mine[C.mine.length - 1]; if (!g) return '';
    const home = g.home.code === C.code, me = home ? g.home : g.away, op = home ? g.away : g.home, won = me.score > op.score;
    const tt = teamTable([g]), tm = tt.find((x) => x.code === me.code), to = tt.find((x) => x.code === op.code);
    const top = (side) => side.players.filter((x) => x.min > 0).sort((a, b) => b.pir - a.pir || b.pts - a.pts).slice(0, 3).map((x) => `<li><strong>${esc(x.name)}</strong> ${x.pts} pts, ${x.reb} reb, ${x.ast} ast <span class="muted">· PIR ${x.pir}</span></li>`).join('');
    const entry = C.pbpOk.find((e) => e.game.gameCode === g.gameCode);
    let lu = '', fl = '';
    if (entry) {
      const m = new Map();
      for (const s2 of entry.stints) { const ids = home ? s2.home : s2.away, k = ids.join(','); const u = m.get(k) || { ids, secs: 0, d: 0 }; u.secs += s2.secs; u.d += s2.pts[me.code] - s2.pts[op.code]; m.set(k, u); }
      const nm = new Map(me.players.map((x) => [x.id, x.name]));
      const L = [...m.values()].filter((u) => u.secs >= 120).sort((a, b) => b.d - a.d);
      const line = (u) => `${u.ids.map((id) => esc(nm.get(id) || id)).join(' · ')} <span class="muted">(${Math.round(u.secs / 60)} min, ${u.d > 0 ? '+' : ''}${u.d})</span>`;
      if (L.length) lu = `<p class="small"><strong>Best lineup:</strong> ${line(L[0])}${L.length > 1 ? `<br><strong>Worst lineup:</strong> ${line(L[L.length - 1])}` : ''}</p>`;
      const F = flowExtras([entry]).find((x) => x.code === me.code);
      if (F) fl = `<p class="small">Points off turnovers ${F.offTO}–${F.offTOA} · second-chance points ${F.second}–${F.secondA} · runs of 8+ ${F.runs}–${F.runsA} (biggest ${F.best}–0 / ${F.bestA}–0)</p>`;
    }
    const k = (label, a, b, d = 1, low = false) => { const better = a === b ? '' : (low ? a < b : a > b) ? 'pos' : 'neg'; return `<tr><td>${label}</td><td class="num ${better}">${d ? a.toFixed(d) : a}</td><td class="num">${d ? b.toFixed(d) : b}</td></tr>`; };
    return `<div class="comp-block lg-card" data-comp="${C.key}"><h3 class="comp-h">${C.logo ? `<img src="${esc(C.logo)}" alt="" width="22" height="22">` : ''}${esc(C.short)} · ${esc(fmtDate(g.date))}</h3>
<p class="lg-res"><span class="${won ? 'pos' : 'neg'}"><strong>${won ? 'W' : 'L'} ${me.score}–${op.score}</strong></span> ${home ? 'vs' : 'at'} <strong>${esc(titleCase(op.name))}</strong> <span class="muted small">Quarters ${(me.quarters || []).join('-')} / ${(op.quarters || []).join('-')}</span> <a href="${C.pfx}game-${safe(g.gameCode)}.html">Full game page →</a></p>
<div class="r-two"><div>${tm && to ? `<table class="rtab"><thead><tr><th>Key numbers</th><th class="num">Hapoel</th><th class="num">${esc(op.tv)}</th></tr></thead><tbody>
${k('Offensive rating', tm.ortg, to.ortg)}${k('Effective FG%', tm.efg, to.efg)}${k('Turnovers / 100', tm.tov100, to.tov100, 1, true)}${k('Offensive reb %', tm.orebPct, to.orebPct)}${k('Free-throw rate', tm.ftr, to.ftr)}${k('3P%', tm.threePct, to.threePct)}${k('Assists', me.totals.ast, op.totals.ast, 0)}
</tbody></table>` : ''}</div>
<div><h4>Best Hapoel players</h4><ol class="small">${top(me)}</ol><h4>Best ${esc(op.tv)} players</h4><ol class="small">${top(op)}</ol></div></div>${lu}${fl}</div>`;
  }).filter(Boolean);
  return blocks.length ? `<section class="card" id="last-game"><h2>Last game — summary</h2><p class="muted">Built automatically the night after every game: result, key numbers, best players, best and worst lineups, game flow.</p>${blocks.join('')}</section>` : '';
})();

// ---- Player load and rest: minutes across both competitions, days of rest, results by rest ----
const loadHtml = (() => {
  const all = ACTIVE.flatMap((C) => C.mine.map((g) => ({ C, g, t: Date.parse(g.date + 'T12:00:00Z') }))).sort((a, b) => a.t - b.t);
  if (all.length < 3) return '';
  const DAY = 86400000;
  all.forEach((x, i) => { x.rest = i ? Math.round((x.t - all[i - 1].t) / DAY) - 1 : null; });
  // results by days of rest (days without a game in between)
  const bucket = (r) => (r == null ? null : r <= 1 ? '0–1 days' : r === 2 ? '2 days' : '3+ days');
  const B = new Map();
  for (const x of all) { const b = bucket(x.rest); if (!b) continue; const me = x.g.home.code === x.C.code ? x.g.home : x.g.away, op = me === x.g.home ? x.g.away : x.g.home; const e = B.get(b) || { w: 0, l: 0, m: 0, n: 0, comps: {} }; e.n++; e.m += me.score - op.score; if (me.score > op.score) e.w++; else e.l++; const c = (e.comps[x.C.short] ||= { w: 0, l: 0 }); if (me.score > op.score) c.w++; else c.l++; B.set(b, e); }
  const restRows = ['0–1 days', '2 days', '3+ days'].filter((b) => B.has(b)).map((b) => { const e = B.get(b); return `<tr><td>${b}</td><td class="num">${e.n}</td><td class="num"><strong class="${e.w >= e.l ? 'pos' : 'neg'}">${e.w}–${e.l}</strong></td><td class="num ${e.m >= 0 ? 'pos' : 'neg'}">${e.m / e.n > 0 ? '+' : ''}${(e.m / e.n).toFixed(1)}</td><td class="small">${Object.entries(e.comps).map(([k, c]) => `${esc(k)} ${c.w}–${c.l}`).join(' · ')}</td></tr>`; }).join('');
  // minutes per player per week (Monday–Sunday) across both competitions
  const weekOf = (t) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; return t - day * DAY; };
  const weeks = [...new Set(all.map((x) => weekOf(x.t)))].sort((a, b) => a - b).slice(-8);
  const P = new Map();
  for (const x of all) { const me = x.g.home.code === x.C.code ? x.g.home : x.g.away, w = weekOf(x.t); for (const p of me.players) { if (!(p.min > 0)) continue; const k = keyOf.get(x.C.key + '|' + p.id) || normName(p.name); const e = P.get(k) || { name: p.name, wk: new Map(), short: [], normal: [], games: [] }; e.wk.set(w, (e.wk.get(w) || 0) + p.min); e.games.push({ t: x.t, min: p.min, pir: p.pir, rest: x.rest }); if (x.rest != null) (x.rest <= 1 ? e.short : e.normal).push(p); P.set(k, e); } }
  const last = all[all.length - 1].t;
  const rows = [...P.values()].map((e) => { const m7 = e.games.filter((g) => last - g.t < 7 * DAY).reduce((a, g) => a + g.min, 0), m14 = e.games.filter((g) => last - g.t < 14 * DAY).reduce((a, g) => a + g.min, 0), g7 = e.games.filter((g) => last - g.t < 7 * DAY).length; const avg = (arr, k) => (arr.length ? arr.reduce((a, p) => a + p[k], 0) / arr.length : null); return { ...e, m7, m14, g7, shPir: avg(e.short, 'pir'), nPir: avg(e.normal, 'pir'), shMin: avg(e.short, 'min'), nMin: avg(e.normal, 'min'), tot: e.games.reduce((a, g) => a + g.min, 0) }; }).sort((a, b) => b.m14 - a.m14 || b.tot - a.tot);
  const maxW = Math.max(...rows.flatMap((r) => weeks.map((w) => r.wk.get(w) || 0)), 1);
  const wLabel = (w) => new Date(w).toISOString().slice(5, 10).split('-').reverse().join('/');
  const flag = (r) => r.m7 >= 75 || (r.g7 >= 3 && r.m7 >= 60);
  return `<section class="card" id="load"><h2>Player load and rest</h2><p class="muted">Minutes across the EuroLeague and the Winner League together, up to the last game (${esc(new Date(last).toISOString().slice(0, 10))}). Red flag = 75+ minutes in 7 days, or 3 games and 60+ minutes in 7 days.</p>
<div class="scroll"><table class="rtab load-t"><thead><tr><th>Player</th><th class="num">Last 7 days</th><th class="num">Last 14 days</th><th class="num">Season</th>${weeks.map((w) => `<th class="num">Week of ${wLabel(w)}</th>`).join('')}<th class="num">PIR on 0–1 days rest</th><th class="num">PIR with 2+ days</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${flag(r) ? '<span class="load-flag" title="High load">●</span> ' : ''}<strong>${esc(r.name)}</strong></td><td class="num"><strong>${Math.round(r.m7)}</strong> <small class="muted">${r.g7} g</small></td><td class="num">${Math.round(r.m14)}</td><td class="num muted">${Math.round(r.tot)}</td>${weeks.map((w) => { const v = r.wk.get(w) || 0; return `<td class="num load-c" style="background:rgba(200,16,46,${(0.5 * v / maxW).toFixed(2)})">${v ? Math.round(v) : ''}</td>`; }).join('')}<td class="num">${r.shPir == null ? '–' : r.shPir.toFixed(1)} <small class="muted">${r.short.length ? r.short.length + ' g' : ''}</small></td><td class="num">${r.nPir == null ? '–' : r.nPir.toFixed(1)} <small class="muted">${r.normal.length ? r.normal.length + ' g' : ''}</small></td></tr>`).join('')}
</tbody></table></div>
<h3>Results by days of rest</h3><div class="scroll"><table class="rtab"><thead><tr><th>Rest before the game</th><th class="num">Games</th><th class="num">W–L</th><th class="num">Avg margin</th><th>By competition</th></tr></thead><tbody>${restRows}</tbody></table></div>
<p class="muted small">Rest = full days without a game before it (a game the next day = 0 days), counting both competitions. Travel distance is not in the data; away games show in the box scores.</p></section>`;
})();

// ---- Referees: Hapoel's record with each referee, all competitions ----
const refsHtml = (() => {
  const m = new Map();
  for (const C of ACTIVE) for (const g of C.mine) for (const r0 of g.refs || []) {
    const r = /[A-Za-z]/.test(r0) ? formatName(r0) : r0, me = g.home.code === C.code ? g.home : g.away, op = me === g.home ? g.away : g.home;
    if (!m.has(r)) m.set(r, { r, comps: new Set(), w: 0, l: 0, pf: 0, opf: 0, fta: 0, ofta: 0, n: 0, list: [] });
    const e = m.get(r); e.comps.add(C.short); e.n++; if (me.score > op.score) e.w++; else e.l++; e.pf += me.totals.pf; e.opf += op.totals.pf; e.fta += me.totals.fta; e.ofta += op.totals.fta;
    e.list.push(`<a href="${C.pfx}game-${safe(g.gameCode)}.html" class="${me.score > op.score ? 'pos' : 'neg'}">${me.score > op.score ? 'W' : 'L'} ${me.score}–${op.score} ${esc(op.tv)}</a>`);
  }
  const rows = [...m.values()].sort((a, b) => b.n - a.n || (b.w - b.l) - (a.w - a.l));
  if (!rows.length) return '';
  return `<section class="card" id="referees"><h2>Referees</h2><p class="muted">Hapoel's record with every referee this season, with fouls and free throws per game (Hapoel – opponent). Full tables: ${ACTIVE.map((C) => `<a href="${C.pfx}referees.html">${esc(C.short)} referees</a>`).join(' · ')}.</p>
<div class="scroll"><table class="rtab"><thead><tr><th>Referee</th><th>Competition</th><th class="num">Games</th><th class="num">W–L</th><th class="num">Fouls</th><th class="num">FTA</th><th>Games</th></tr></thead><tbody>
${rows.map((e) => `<tr><td><strong>${esc(e.r)}</strong></td><td class="small">${[...e.comps].map(esc).join(', ')}</td><td class="num">${e.n}</td><td class="num"><strong class="${e.w >= e.l ? 'pos' : 'neg'}">${e.w}–${e.l}</strong></td><td class="num">${(e.pf / e.n).toFixed(1)} – ${(e.opf / e.n).toFixed(1)}</td><td class="num ${e.fta >= e.ofta ? 'pos' : 'neg'}">${(e.fta / e.n).toFixed(1)} – ${(e.ofta / e.n).toFixed(1)}</td><td class="small">${e.list.join(' · ')}</td></tr>`).join('')}
</tbody></table></div></section>`;
})();

// ---- On/Off: Hapoel with and without each player ----
const onOffHtml = ACTIVE.some((C) => C.OO.length) ? `<section class="card" id="onoff"><h2>On/Off</h2>
<p class="muted">How Hapoel plays with each player on the court and without him (same games), from the official play-by-play. Ratings per 100 possessions. Diff = on minus off; green = the team is better with him on the court.</p>
${ACTIVE.filter((C) => C.OO.length).map((C) => { const nm = new Map(C.players.map((p) => [p.id, p])); const rows = C.OO.filter((x) => nm.has(x.id) && x.on.secs >= 600).map((x) => ({ x, p: nm.get(x.id), on: situRates(x.on), off: situRates(x.off) })).sort((a, b) => b.x.on.secs - a.x.on.secs);
  const d = (a, b, good = 1) => { if (a == null || b == null) return '<td class="num">–</td>'; const v = a - b; return `<td class="num ${!good || Math.abs(v) < 0.05 ? '' : (good * v > 0 ? 'pos' : 'neg')}">${sgn1(v)}</td>`; };
  const trio = (k, good = 1, fmt = (v) => f1(v)) => (r) => `<td class="num">${r.on[k] == null ? '–' : fmt(r.on[k])}</td><td class="num muted">${r.off[k] == null ? '–' : fmt(r.off[k])}</td>${d(r.on[k], r.off[k], good)}`;
  const cols = [['Net', trio('net', 1, sgn1)], ['ORtg', trio('ortg')], ['DRtg', trio('drtg', -1)], ['eFG%', trio('efg')], ['Opp eFG%', trio('efgD', -1)], ['TO%', trio('tovPct', -1)], ['Forced TO%', trio('tovPctD')], ['OREB%', trio('orebPct')], ['DREB%', trio('drebPct')], ['3PA rate', trio('threeRate', 0)], ['Pace', trio('pace', 0)]];
  return `<div class="comp-block" data-comp="${C.key}"><h3 class="comp-h">${C.logo ? `<img src="${esc(C.logo)}" alt="" width="22" height="22">` : ''}${esc(C.short)} <small class="muted">${C.OO.length ? `${new Set(C.pbpOk.filter((e) => isMine(C, e.game)).map((e) => e.game.gameCode)).size} games` : ''}</small></h3>
<div class="scroll"><table class="hap-onoff"><thead><tr><th rowspan="2">Player</th><th rowspan="2" class="num">GP</th><th rowspan="2" class="num">MIN on</th><th rowspan="2" class="num">MIN off</th><th rowspan="2" class="num">Score on</th><th rowspan="2" class="num">Score off</th>${cols.map(([l]) => `<th colspan="3" class="grp">${l}</th>`).join('')}</tr><tr>${cols.map(() => '<th class="num">On</th><th class="num">Off</th><th class="num">Diff</th>').join('')}</tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="${C.pfx}${r.p.href || `player-${safe(r.p.id)}.html`}"><strong>${esc(r.p.name)}</strong></a></td><td class="num">${r.x.games}</td><td class="num">${f1(r.on.min)}</td><td class="num">${f1(r.off.min)}</td><td class="num">${r.on.pf}–${r.on.pa}</td><td class="num">${r.off.pf}–${r.off.pa}</td>${cols.map(([, f]) => f(r)).join('')}</tr>`).join('')}
</tbody></table></div>${rows.some((r) => r.off.min < 40) ? '<p class="muted small">Off-court numbers based on fewer than 40 minutes are a small sample.</p>' : ''}</div>`; }).join('')}
</section>` : '';

// ---- Clutch and after timeouts: Hapoel ----
const clutchHtml = ACTIVE.some((C) => C.CL) ? `<section class="card" id="clutch"><h2>Clutch &amp; after timeouts</h2>
<p class="muted">Clutch = the last 5 minutes of the 4th quarter or overtime with the score within 5. After timeouts = Hapoel's first possession after its own timeout. Ranks are within the league.</p>
${ACTIVE.filter((C) => C.CL).map((C) => { const ct = C.CL.teams.find((x) => x.code === C.code); const R = (x) => situRates({ secs: x.secs, poss: x.poss, possD: x.possD, pf: x.pf, pa: x.pa, box: x.box, opp: x.opp }); const r = ct ? R(ct) : null; const rk = ct ? 1 + C.CL.teams.filter((x) => (R(x).net ?? -999) > (r.net ?? -999)).length : null;
  const nm = new Map(C.players.map((p) => [p.id, p])); const pl = C.CL.players.filter((x) => x.team === C.code && nm.has(x.id)).sort((a, b) => b.box.pts - a.box.pts || b.secs - a.secs);
  const at = C.ATO?.find((x) => x.code === C.code); const atR = at && at.off.n ? 1 + C.ATO.filter((x) => x.off.n && x.off.pts / x.off.n > at.off.pts / at.off.n).length : null;
  return `<div class="comp-block" data-comp="${C.key}"><h3 class="comp-h">${C.logo ? `<img src="${esc(C.logo)}" alt="" width="22" height="22">` : ''}${esc(C.short)}</h3>
${ct ? `<div class="strip dark-strip"><span><b>${ct.games}</b> clutch games (${ct.w}–${ct.l})</span><span><b>${f1(r.min)}</b> clutch min</span><span><b>${ct.pf}–${ct.pa}</b> score</span><span><b>${sgn1(r.net)}</b> net · ${ord(rk)} of ${C.CL.teams.length}</span>${at && at.off.n ? `<span><b>${(at.off.pts / at.off.n).toFixed(2)}</b> PPP after timeouts · ${ord(atR)} of ${C.ATO.length} (${at.off.n} poss.)</span><span><b>${(C.team.ortg / 100).toFixed(2)}</b> normal PPP</span>` : ''}</div>` : '<p class="muted">No clutch games yet.</p>'}
${pl.length ? `<div class="scroll"><table class="hap-clutch"><thead><tr><th>Player</th><th class="num">GP</th><th class="num">MIN</th><th class="num">PTS</th><th class="num">FG</th><th class="num">3P</th><th class="num">FT</th><th class="num">REB</th><th class="num">AST</th><th class="num">TOV</th><th class="num">STL</th><th class="num">+/-</th></tr></thead><tbody>${pl.map((x) => { const b = x.box; return `<tr><td>${esc(nm.get(x.id).name)}</td><td class="num">${x.games}</td><td class="num">${f1(x.secs / 60)}</td><td class="num"><strong>${b.pts}</strong></td><td class="num">${b.fgm2 + b.fgm3}/${b.fga2 + b.fga3}</td><td class="num">${b.fgm3}/${b.fga3}</td><td class="num">${b.ftm}/${b.fta}</td><td class="num">${b.oreb + b.dreb}</td><td class="num">${b.ast}</td><td class="num">${b.tov}</td><td class="num">${b.stl}</td><td class="num ${x.pm >= 0 ? 'pos' : 'neg'}">${x.pm > 0 ? '+' : ''}${x.pm}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
<p class="small"><a href="${C.pfx}clutch.html"><strong>${esc(C.short)} clutch &amp; after-timeout rankings, every team and player →</strong></a></p></div>`; }).join('')}
</section>` : '';

const body = `${tabs}${navLinks}
<section class="card" id="schedule"><h2>Schedule</h2><p class="muted">Next games and every result — EuroLeague and Winner League (times in your time zone). <a href="hapoel-schedule.html"><strong>Full schedule and calendar file →</strong></a></p>
<div class="scroll"><table class="hap-sched"><thead><tr><th scope="col"></th><th scope="col">Date</th><th scope="col">Opponent</th><th scope="col">Result</th><th scope="col">Round</th></tr></thead><tbody>
${[...nextGames.slice(0, 4)].map(schedRow).join('')}${sched.filter((x) => x.res).reverse().slice(0, 8).map(schedRow).join('')}
</tbody></table></div></section>

${nextHtml}
${lastGameHtml}

<section class="card" id="boxscores"><h2>Box scores</h2><p class="muted">Every Hapoel game. Open a game for its full box score — basic, shooting, advanced and by quarter — or go to the game page for the flow chart, play-by-play and lineups.</p>
<div id="hap-games"><p class="muted">Loading…</p></div></section>

<section class="card" id="team"><h2>Team stats</h2><p class="muted">Hapoel's numbers in each competition, with the league rank and league average, and both competitions together split by wins, losses, home and away.</p>
${teamStatsTable}
${quarterTable ? `<h3>Average by quarter</h3>${quarterTable}` : ''}
<p class="small"><a href="quarter-split.html"><strong>EuroLeague quarter splits — every player and team, quarter by quarter →</strong></a></p>
<p class="small">${ACTIVE.map((C) => `<a href="${C.pfx}team-${safe(C.code)}.html"><strong>${esc(C.short)} team page →</strong></a> · <a href="${C.pfx}team-${safe(C.code)}-report.html">${esc(C.short)} team report</a>`).join(' · ')}</p></section>

<section class="card" id="players"><h2>Players</h2><p class="muted">Every Hapoel player, every stat, in the competition chosen above — per game, totals or per 40 minutes, over all games, wins, losses, home, away, the last few, or any games you tick. Click a column to sort.</p>
<div id="hap-players"><p class="muted">Loading…</p></div></section>

${onOffHtml}
${clutchHtml}
${loadHtml}
${refsHtml}
<section class="card" id="lineups"><h2>Lineups</h2><p class="muted">Hapoel's five-man units — and 2-, 3- and 4-man combinations — from the official play-by-play. Pick the games: all of them, the last few, wins or losses, one competition, or any games you tick.</p>
<div id="hap-lineups"><p class="muted">Loading…</p></div></section>

<section id="boards"><h2 class="sec-title">Leaderboards — Hapoel players</h2><p class="muted sec-sub">Every leaderboard from the league home pages, with Hapoel's players ranked within the team.</p>
${ACTIVE.map((C) => `<div class="comp-block" data-comp="${C.key}"><h3 class="comp-h">${C.logo ? `<img src="${esc(C.logo)}" alt="" width="22" height="22">` : ''}${esc(C.short)}</h3><div class="row-3">${[mvpFor(C), ...boardsFor(C)].filter(Boolean).join('')}</div></div>`).join('')}
</section>

<section class="card" id="leagues"><h2>Leagues</h2><p class="muted">Every league on HTA LAB — standings, games, players, teams, lineups and reports.</p>${leaguesGrid}</section>
<script type="application/json" id="hap-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

// ---- Weekly summary: the last 7 days (Hapoel, both competitions) and the 7 days ahead ----
{
  const DAY = 86400000, nowT = Date.now();
  const all = ACTIVE.flatMap((C) => C.mine.map((g) => ({ C, g, t: Date.parse(g.date + 'T12:00:00Z') }))).sort((a, b) => a.t - b.t);
  // the week = the 7 days up to today; if Hapoel did not play in them, the 7 days up to the last game
  let end = nowT; if (!all.some((x) => x.t > nowT - 7 * DAY) && all.length) end = all[all.length - 1].t + DAY / 2;
  const wk = all.filter((x) => x.t > end - 7 * DAY && x.t <= end), before = all.filter((x) => x.t <= end - 7 * DAY);
  const d10 = (t) => new Date(t).toISOString().slice(0, 10);
  const sideOf = (x) => (x.g.home.code === x.C.code ? [x.g.home, x.g.away] : [x.g.away, x.g.home]);
  const res = wk.map((x) => { const [me, op] = sideOf(x); const won = me.score > op.score; const top = me.players.filter((p) => p.min > 0).sort((a, b) => b.pir - a.pir)[0]; return `<tr><td>${esc(fmtDate(x.g.date))}</td><td>${compBadge(x.C.key)}</td><td>${x.g.home.code === x.C.code ? 'vs' : 'at'} ${esc(titleCase(op.name))}</td><td class="num"><strong class="${won ? 'pos' : 'neg'}">${won ? 'W' : 'L'} ${me.score}–${op.score}</strong></td><td class="small">${top ? `${esc(top.name)} ${top.pts} pts · PIR ${top.pir}` : ''}</td><td><a href="${x.C.pfx}game-${safe(x.g.gameCode)}.html">Game →</a> · <a href="${x.C.pfx}game-${safe(x.g.gameCode)}-hapoel.html">Report</a></td></tr>`; }).join('');
  // players: this week vs before
  const agg = (list) => { const M = new Map(); for (const x of list) { const [me] = sideOf(x); for (const p of me.players) { if (!(p.min > 0)) continue; const k = keyOf.get(x.C.key + '|' + p.id) || normName(p.name); const e = M.get(k) || { name: p.name, g: 0, min: 0, pts: 0, pir: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, pm: 0 }; e.g++; e.min += p.min; e.pts += p.pts; e.pir += p.pir; e.pm += p.pm ?? p.plusMinus ?? 0; M.set(k, e); } } return M; };
  const W = agg(wk), Bf = agg(before);
  const prow = [...W.entries()].map(([k, e]) => { const b = Bf.get(k); const ptsD = b ? e.pts / e.g - b.pts / b.g : null, pirD = b ? e.pir / e.g - b.pir / b.g : null; return { ...e, ptsD, pirD, bPts: b ? b.pts / b.g : null, bPir: b ? b.pir / b.g : null }; }).sort((a, b) => b.pir - a.pir);
  const mvp = prow[0];
  const dTag = (v) => (v == null ? '<span class="muted">–</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}</span>`);
  const up = prow.filter((r) => r.pirD != null && r.pirD >= 3).sort((a, b) => b.pirD - a.pirD).slice(0, 3), down = prow.filter((r) => r.pirD != null && r.pirD <= -3).sort((a, b) => a.pirD - b.pirD).slice(0, 3);
  // standings
  const stand = ACTIVE.map((C) => { const t = C.team; return t ? `<div class="rs"><span>${esc(C.short)}</span><b>${t.w}–${t.l} · ${ord(t.rank)}</b></div>` : ''; }).join('');
  // the week ahead with predictions (EuroLeague forecast file from the league build)
  let fc = []; for (const C of ACTIVE) { try { fc.push(...JSON.parse(readFileSync(join(OUT, C.pfx, 'forecast-hapoel.json'))).map((f) => ({ ...f, comp: C.key }))); } catch { /* no forecast */ } }
  const ahead = sched.filter((x) => !x.res && x.utc && Date.parse(x.utc) >= nowT - DAY / 2 && Date.parse(x.utc) < nowT + 8 * DAY);
  const aheadRows = ahead.map((x) => { const C = COMPS.find((c) => c.key === x.c); const f = fc.find((y) => y.comp === x.c && String(y.c) === String(x.gc)); const hw = f ? (x.home ? f.win : 1 - f.win) : null; return `<tr><td>${timeTag(x)}</td><td>${compBadge(x.c)}</td><td>${x.home ? 'vs' : 'at'} <strong>${esc(x.opp)}</strong></td><td class="num">${f ? `${x.home ? f.ph : f.pa}–${x.home ? f.pa : f.ph}` : '–'}</td><td class="num">${hw == null ? '–' : Math.round(100 * hw) + '%'}</td><td><a href="${C.pfx}team-${safe(x.oc)}-report.html">Pre-game report</a>${nextByComp.some((n) => n.gc === x.gc && n.c === x.c) ? ` · <a href="${C.pfx}gameday-next.html">Game-day pack</a>` : ''}</td></tr>`; }).join('');
  // load warnings for the week ahead
  const mins7 = new Map(); for (const x of all.filter((y) => y.t > end - 7 * DAY)) { const [me] = sideOf(x); for (const p of me.players) if (p.min > 0) { const k = normName(p.name); const e = mins7.get(k) || { name: p.name, m: 0, g: 0 }; e.m += p.min; e.g++; mins7.set(k, e); } }
  const heavy = [...mins7.values()].filter((e) => e.m >= 75 || (e.g >= 3 && e.m >= 60)).sort((a, b) => b.m - a.m);
  const wins = wk.filter((x) => { const [me, op] = sideOf(x); return me.score > op.score; }).length;
  const bodyW = `<p class="no-print" style="margin:0"><button type="button" class="btn" id="print-btn">Download as PDF</button></p>
<header class="print-only split-ph"><div class="r-kicker">HTA LAB · Weekly summary</div><h1>Hapoel — week of ${esc(d10(end - 7 * DAY + DAY))} to ${esc(d10(end))}</h1></header>
<section class="card"><h2>The week</h2><div class="r-grid"><div class="rs"><span>Record this week</span><b>${wk.length ? `${wins}–${wk.length - wins}` : 'No games'}</b></div>${stand}${mvp ? `<div class="rs"><span>Player of the week</span><b>${esc(mvp.name)} <small>${(mvp.pir / mvp.g).toFixed(1)} PIR/g</small></b></div>` : ''}</div>
${res ? `<div class="scroll"><table class="rtab"><thead><tr><th>Date</th><th></th><th>Opponent</th><th class="num">Result</th><th>Best player</th><th></th></tr></thead><tbody>${res}</tbody></table></div>` : '<p class="muted">Hapoel did not play this week.</p>'}</section>
${prow.length ? `<section class="card"><h2>Players this week</h2><div class="scroll"><table class="rtab"><thead><tr><th>Player</th><th class="num">G</th><th class="num">MIN/g</th><th class="num">PTS/g</th><th class="num">vs before</th><th class="num">PIR/g</th><th class="num">vs before</th></tr></thead><tbody>${prow.map((r) => `<tr><td><strong>${esc(r.name)}</strong></td><td class="num">${r.g}</td><td class="num">${(r.min / r.g).toFixed(1)}</td><td class="num">${(r.pts / r.g).toFixed(1)}</td><td class="num">${dTag(r.ptsD)}</td><td class="num"><strong>${(r.pir / r.g).toFixed(1)}</strong></td><td class="num">${dTag(r.pirD)}</td></tr>`).join('')}</tbody></table></div>
<div class="r-two"><div><h3>Up</h3>${up.length ? `<ul class="small">${up.map((r) => `<li><strong>${esc(r.name)}</strong>: PIR ${(r.pir / r.g).toFixed(1)} this week vs ${r.bPir.toFixed(1)} before</li>`).join('')}</ul>` : '<p class="muted small">No big jumps.</p>'}</div><div><h3>Down</h3>${down.length ? `<ul class="small">${down.map((r) => `<li><strong>${esc(r.name)}</strong>: PIR ${(r.pir / r.g).toFixed(1)} this week vs ${r.bPir.toFixed(1)} before</li>`).join('')}</ul>` : '<p class="muted small">No big drops.</p>'}</div></div>
<p class="muted small">"vs before" = this week's average minus his average in all earlier games this season (both competitions). Up/down = PIR changed by 3 or more.</p></section>` : ''}
<section class="card"><h2>The week ahead</h2>${aheadRows ? `<div class="scroll"><table class="rtab"><thead><tr><th>When</th><th></th><th>Opponent</th><th class="num">Expected score</th><th class="num">Hapoel win chance</th><th></th></tr></thead><tbody>${aheadRows}</tbody></table></div>` : '<p class="muted">No Hapoel games in the next 7 days.</p>'}
${heavy.length ? `<h3>Load warning</h3><ul class="small">${heavy.map((e) => `<li><span class="load-flag">●</span> <strong>${esc(e.name)}</strong>: ${Math.round(e.m)} minutes in ${e.g} games in the last 7 days</li>`).join('')}</ul>` : '<p class="muted small">No player over the load limit (75 minutes in 7 days).</p>'}
<p class="muted small">Predictions come from the forecast model (team ratings and home court). Winner League predictions appear once that league has enough games.</p></section>`;
  writeFileSync(join(OUT, 'weekly.html'), page({ title: 'Weekly summary', cfg, info: { games: gameRows.length, lastDate: gameRows[0]?.d, lastRound: null }, active: 'index.html', sample: false,
    body: `<div class="split-page">${bodyW}</div>`, hero: `<section class="cover"><div class="wrap"><div><div class="kicker">Weekly summary</div><h1>Hapoel's week</h1><p class="lede">${esc(d10(end - 7 * DAY + DAY))} to ${esc(d10(end))}: results, players up and down, standings, the games ahead with predictions, and load warnings. Rebuilt every night.</p></div></div></section>`,
    scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script>` }));
}

// ---- Keys to the game + season goals (graded from the box scores; the targets themselves are staff data, encrypted) ----
{
  const pkey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const pc = (m, a) => (a ? +(100 * m / a).toFixed(1) : null);
  const METRICS = [['pts', 'Our points', 1], ['opp_pts', 'Their points', 0], ['margin', 'Margin', 1], ['tov', 'Our turnovers', 0], ['opp_tov', 'Their turnovers (forced)', 1], ['oreb_pct', 'Our offensive rebound %', 1], ['dreb_pct', 'Our defensive rebound %', 1],
    ['reb', 'Our rebounds', 1], ['opp_oreb', 'Their offensive rebounds', 0], ['ast', 'Our assists', 1], ['efg', 'Our eFG%', 1], ['opp_efg', 'Their eFG%', 0], ['p3', 'Our 3P%', 1], ['opp_p3', 'Their 3P%', 0], ['p3a', 'Our 3-point attempts', 1], ['opp_p3a', 'Their 3-point attempts', 0],
    ['fta', 'Our free-throw attempts', 1], ['opp_fta', 'Their free-throw attempts', 0], ['ft_pct', 'Our FT%', 1], ['stl', 'Our steals', 1], ['pf', 'Our fouls', 0]];
  const games = [];
  for (const C of ACTIVE) for (const g of C.mine) {
    const me = g.home.code === C.code ? g.home : g.away, op = me === g.home ? g.away : g.home, a = me.totals, b = op.totals;
    const m = { pts: me.score, opp_pts: op.score, margin: me.score - op.score, tov: a.tov, opp_tov: b.tov, oreb_pct: pc(a.oreb, a.oreb + b.dreb), dreb_pct: pc(a.dreb, a.dreb + b.oreb), reb: a.reb, opp_oreb: b.oreb, ast: a.ast,
      efg: pc(a.fgm2 + 1.5 * a.fgm3, a.fga2 + a.fga3), opp_efg: pc(b.fgm2 + 1.5 * b.fgm3, b.fga2 + b.fga3), p3: pc(a.fgm3, a.fga3), opp_p3: pc(b.fgm3, b.fga3), p3a: a.fga3, opp_p3a: b.fga3, fta: a.fta, opp_fta: b.fta, ft_pct: pc(a.ftm, a.fta), stl: a.stl, pf: a.pf };
    const pl = {}; for (const [side, s] of [['H', me], ['O', op]]) for (const p of s.players) if (p.min > 0) pl[pkey(p.name)] = [p.name, side, p.pts, p.reb, p.ast, Math.round(p.min), p.pir];
    games.push({ c: C.key, comp: C.short, code: g.gameCode, date: g.date, opp: titleCase(op.name), oppCode: op.code, home: me === g.home, res: `${me.score > op.score ? 'W' : 'L'} ${me.score}–${op.score}`, href: `${C.pfx}game-${safe(g.gameCode)}.html`, m, pl });
  }
  games.sort((a, b) => a.date.localeCompare(b.date));
  // the next games and their opponents' players (to set "keep X under N points")
  const up = sched.filter((x) => !x.res && x.utc && Date.parse(x.utc) > Date.now() - 6 * 3600e3).slice(0, 6).map((x) => {
    const C = COMPS.find((c) => c.key === x.c);
    const oppPl = new Map(); for (const g of (C?.games || [])) for (const s of [g.home, g.away]) if (s.code === x.oc) for (const p of s.players) if (p.min > 0) { const k = pkey(p.name); const o = oppPl.get(k) || [p.name, 0, 0]; o[1]++; o[2] += p.pts; oppPl.set(k, o); }
    return { c: x.c, comp: C?.short || x.c, gc: String(x.gc), utc: x.utc, opp: x.opp, oppCode: x.oc, home: x.home, players: [...oppPl].filter(([, o]) => o[1] >= 2).sort((a, b) => b[1][2] / b[1][1] - a[1][2] / a[1][1]).slice(0, 14).map(([k, o]) => [k, o[0], +(o[2] / o[1]).toFixed(1)]) };
  });
  const hap = new Map(); for (const g of games) for (const [k, v] of Object.entries(g.pl)) if (v[1] === 'H') hap.set(k, v[0]);
  writeFileSync(join(OUT, 'hapoel-games.json'), JSON.stringify({ metrics: METRICS, games, upcoming: up, hapPlayers: [...hap] }));
  const staffCfg = JSON.stringify({ salt: base.internal?.salt, iterations: base.internal?.iterations, repo: process.env.GITHUB_REPOSITORY || 'hta-lab/hta-lab.github.io', branch: process.env.GITHUB_REF_NAME || 'main', path: 'scouting/plan.enc', root: '', comp: 'hub' }).replace(/</g, '\\u003c');
  writeFileSync(join(OUT, 'keys.html'), page({ title: 'Keys to the game & season goals', cfg, info: { games: gameRows.length, lastDate: gameRows[0]?.d, lastRound: null }, active: 'index.html', sample: false,
    body: `<div id="keys-app"><p class="muted">Loading…</p></div>`,
    hero: `<section class="cover"><div class="wrap"><div><div class="kicker">Hapoel · staff</div><h1>Keys to the game & season goals</h1><p class="lede">Set 3–5 targets before a game (under 12 turnovers, keep their best scorer under 15…) and the site grades them after the game from the official box score. Season goals are tracked game by game. Targets are encrypted with the team password.</p></div></div></section>`,
    scripts: `<script>window.HTA_STAFF_CFG = ${staffCfg};</script><script src="staff.js?v=${assetVersion()}" defer></script><script src="keys.js?v=${assetVersion()}" defer></script>` }));
  // ---- Form lines: rolling 5-game averages for every Hapoel player (both competitions) ----
  const byP = new Map();
  for (const g of games) for (const [k, v] of Object.entries(g.pl)) { if (v[1] !== 'H') continue; if (!byP.has(k)) byP.set(k, { name: v[0], g: [] }); }
  for (const C of ACTIVE) for (const g of C.mine) { const me = g.home.code === C.code ? g.home : g.away; for (const p of me.players) { if (!(p.min > 0)) continue; const o = byP.get(pkey(p.name)); if (o) o.g.push({ date: g.date, comp: C.key, pts: p.pts, pir: p.pir, min: p.min, tsa: p.fga2 + p.fga3 + 0.44 * p.fta, reb: p.reb, ast: p.ast }); } }
  const roll = (arr, f, w = 5) => arr.map((_, i) => { const s = arr.slice(Math.max(0, i - w + 1), i + 1); return f(s); });
  const avg = (k) => (s) => s.reduce((a, x) => a + x[k], 0) / s.length;
  const ts = (s) => { const t = s.reduce((a, x) => a + x.tsa, 0); return t ? 100 * s.reduce((a, x) => a + x.pts, 0) / (2 * t) : null; };
  const spark = (vals, season, color) => { const v = vals.map((x) => (x == null ? null : x)); const ok = v.filter((x) => x != null); if (ok.length < 2) return ''; const lo = Math.min(...ok, season), hi = Math.max(...ok, season), W = 220, H = 46, X = (i) => 4 + (W - 8) * i / (v.length - 1), Y = (y) => H - 5 - (H - 10) * (hi === lo ? 0.5 : (y - lo) / (hi - lo));
    const pts = v.map((y, i) => (y == null ? null : `${X(i).toFixed(1)},${Y(y).toFixed(1)}`)).filter(Boolean).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" class="fl-spark"><line x1="4" x2="${W - 4}" y1="${Y(season).toFixed(1)}" y2="${Y(season).toFixed(1)}" stroke="#bbb" stroke-dasharray="3 3"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/><circle cx="${X(v.length - 1).toFixed(1)}" cy="${Y(v[v.length - 1] ?? season).toFixed(1)}" r="3" fill="${color}"/></svg>`; };
  const cards = [...byP.values()].filter((o) => o.g.length >= 5).map((o) => { o.g.sort((a, b) => a.date.localeCompare(b.date)); o.min = o.g.reduce((a, x) => a + x.min, 0); return o; }).sort((a, b) => b.min - a.min).map((o) => {
    const S = [['Points', roll(o.g, avg('pts')), avg('pts')(o.g)], ['PIR', roll(o.g, avg('pir')), avg('pir')(o.g)], ['TS%', roll(o.g, ts), ts(o.g)], ['Minutes', roll(o.g, avg('min')), avg('min')(o.g)]];
    return `<article class="pcard fl-card"><header><strong>${esc(o.name)}</strong><span class="muted small">${o.g.length} games</span></header>${S.map(([l, v, s]) => { const now = v[v.length - 1], d = now != null && s != null ? now - s : null; return `<div class="fl-row"><div><span class="small muted">${l}</span><br><b>${now == null ? '–' : now.toFixed(1)}</b> <small class="${d == null ? '' : d >= 0 ? 'pos' : 'neg'}">${d == null ? '' : (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1)}</small></div>${spark(v, s, d == null || d >= 0 ? '#1a7f37' : '#c8102e')}</div>`; }).join('')}<p class="muted small">Last game ${esc(o.g[o.g.length - 1].date)}. Line = 5-game average; dashed = season average.</p></article>`; }).join('');
  writeFileSync(join(OUT, 'hapoel-form.html'), page({ title: 'Hapoel form lines', cfg, info: { games: gameRows.length, lastDate: gameRows[0]?.d, lastRound: null }, active: 'index.html', sample: false,
    body: `<div class="pcards fl-grid">${cards}</div><p class="muted small">Every EuroLeague and Winner League game, in date order. The big number is the average of the last 5 games; the small one is the difference from his season average.</p>`,
    hero: `<section class="cover"><div class="wrap"><div><div class="kicker">Hapoel</div><h1>Form lines</h1><p class="lede">Each player's 5-game rolling average for points, PIR, true shooting and minutes, against his season average — who is trending up, who is cooling off.</p></div></div></section>` }));
}

const info = { games: gameRows.length, lastDate: gameRows[0]?.d, lastRound: null };
copyFileSync('static/hapoel.js', join(OUT, 'hapoel.js'));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) if (existsSync(join('static', f))) copyFileSync(join('static', f), join(OUT, f));
// ---- Pages that use every league: Compare players and Recruiting ----
{
  const leaguesForBrain = LEAGUES.map(([k, L]) => [k, L.leagueName || L.shortName, k === 'el' ? '' : k + '/', L.leagueLogo || '']);
  // Player comparison across every league
  copyFileSync('static/compare.js', join(OUT, 'compare.js'));
  writeFileSync(join(OUT, 'compare.html'), page({ title: 'Compare players', cfg: { ...cfg }, info, active: 'compare.html', sample: false,
    body: `<section class="card"><h2>Compare players</h2>
<p class="muted">Two or three players side by side — from the same league or from different ones (EuroLeague, EuroCup, Winner League, ACB, BBL, Greece, NBL, ABA, VTB, LBA). Per game, per 40 minutes or totals. The link keeps your selection, so you can send it. <a href="recruit.html">Search all players →</a></p>
<div id="compare-app"><p class="muted">Loading…</p></div></section>
<script type="application/json" id="compare-leagues">${JSON.stringify(leaguesForBrain).replace(/</g, '\\u003c')}</script>`,
    hero: null, scripts: `<script src="compare.js?v=${assetVersion()}" defer></script>` }));
  // Recruiting: all players of all leagues, shortlist
  copyFileSync('static/recruit.js', join(OUT, 'recruit.js'));
  writeFileSync(join(OUT, 'recruit.html'), page({ title: 'Recruiting', cfg: { ...cfg }, info, active: 'recruit.html', sample: false,
    body: `<section class="card"><h2>Recruiting</h2>
<p class="muted">Every player in every league on HTA LAB in one table. Filter by league, position, age, height, games and minutes; sort by any stat; tap ☆ to build a shortlist. <a href="compare.html">Compare players side by side →</a></p>
<div id="recruit-app"><p class="muted">Loading…</p></div></section>
<script type="application/json" id="recruit-leagues">${JSON.stringify(leaguesForBrain).replace(/</g, '\\u003c')}</script>`,
    hero: null, scripts: `<script src="recruit.js?v=${assetVersion()}" defer></script>` }));
}
writeFileSync(join(OUT, 'index.html'), page({ title: 'Hapoel Tel Aviv', cfg, info, active: 'index.html', sample: false, body, hero, scripts: `<script src="hapoel.js?v=${assetVersion()}" defer></script>` }));
console.log(`✓ Hapoel home page: ${gameRows.length} games (${ACTIVE.map((C) => `${C.short} ${C.mine.length}`).join(', ')}), ${people.size} players, ${lineupGames.size} games with lineups`);
