// Reads the saved box scores, runs every accuracy check, calculates the stats
// and writes the website to site/.  If any check fails, nothing is written.
//
//   node scripts/build.mjs                          -> real data in data/raw/<season>
//   node scripts/build.mjs --data data/sample --sample

import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGame, formatName } from '../lib/parse.mjs';
import { validateSeason, validateGame } from '../lib/validate.mjs';
import { teamTable, playerTable, qualified, leaders, seasonInfo, teamGames, quarterAverages, playerGameLogs } from '../lib/stats.mjs';
import { esc, f1, signed, scatter, page, fmtDate, assetVersion } from '../lib/render.mjs';
import { indexPeople, findPerson, ageOn } from '../lib/people.mjs';
import { buildStints, checkStints, aggregate, rapm, BOX_KEYS, repairPlusMinus } from '../lib/pbp.mjs';
import { GLOSSARY } from '../lib/glossary.mjs';
import { teamSplits } from '../lib/teamsplits.mjs';
import { poolRows, poolFromDir } from '../lib/pool.mjs';
import { playerRates } from '../lib/advanced.mjs';
import { loadShots, courtSvg, zoneRows } from '../lib/shots.mjs';
import { clutch as clutchOf, afterTimeouts, rates as situRates, rotation as rotationOf, flowExtras } from '../lib/situ.mjs';
import { playLog, flowStats, flowDetail, connections, offensiveFouls, LABEL as PLAY_LABEL, GROUP as PLAY_GROUP } from '../lib/game.mjs';
import { runs as runsOf, foulTrouble, WINDOWS, windowPoints, STATES, scoreStates, possOf, winProb, winProbSvg, assistPairs, passingSvg, shotModel, coachGame } from '../lib/insights.mjs';

const args = process.argv.slice(2);
const LEAGUE = args.includes('--league') ? args[args.indexOf('--league') + 1] : 'el';
const baseCfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const cfg = LEAGUE === 'el' ? { ...baseCfg, LEAGUE: 'el', root: '' } : { ...baseCfg, ...(baseCfg.leagues?.[LEAGUE] || {}), LEAGUE };
// The site's home page (root index.html) is Hapoel Tel Aviv; the EuroLeague's own home is euroleague.html.
cfg.HOME = LEAGUE === 'el' ? 'euroleague.html' : 'index.html';
cfg.elLogo = baseCfg.leagueLogo;
const HOME = cfg.HOME;
const IS_EL = LEAGUE === 'el';
const dataDir = args.includes('--data') ? args[args.indexOf('--data') + 1] : IS_EL ? join('data', 'raw', cfg.seasonCode) : join('data', 'raw', cfg.dataDir);
const sample = args.includes('--sample');
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : IS_EL ? 'site' : join('site', LEAGUE);

if (!existsSync(dataDir)) { console.error(`No data in ${dataDir}. Run "npm run fetch" first.`); process.exit(1); }
const files = readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
const rawPbp = new Map();
const rawShots = new Map();
let games = files.map((f) => { const raw = JSON.parse(readFileSync(join(dataDir, f))); const g = parseGame(raw); if (raw.pbp) rawPbp.set(g.gameCode, raw.pbp); if (Array.isArray(raw.shots) && raw.shots.length) rawShots.set(g.gameCode, raw.shots); return g; });
if (cfg.dropInvalid) {
  // Secondary leagues: a game that fails the checks is left out (and reported) instead of stopping the build.
  games = games.filter((g) => { const e = validateGame(g); if (e.length) console.warn(`Left out game ${g.gameCode}: ${e[0]}`); return !e.length; });
}

// Official club crests (optional). Only https image links are used.
const crests = new Map();
try {
  for (const c of JSON.parse(readFileSync(join(dataDir, '_clubs.json')))) {
    if (c.code && typeof c.crest === 'string' && /^https:\/\/[^\s"'<>]+$/.test(c.crest)) crests.set(c.code, c.crest);
  }
} catch { /* no crest file: team codes are shown instead */ }
// Season schedule (optional): upcoming games with date, time and venue.
let schedule = [];
try { schedule = JSON.parse(readFileSync(join(dataDir, '_schedule.json'))); } catch { /* no schedule: only played games are shown */ }
// Player details (optional). Never includes photos.
let peopleIndex = indexPeople([]);
try { peopleIndex = indexPeople(JSON.parse(readFileSync(join(dataDir, '_people.json')))); } catch { /* stats-only player pages */ }
const playerHref = (id) => `player-${String(id).replace(/[^A-Za-z0-9]/g, '')}.html`;
const badge = (code, tv) => crests.has(code)
  ? `<img class="crest" src="${esc(crests.get(code))}" alt="" width="22" height="22" loading="lazy">`
  : `<span class="code">${esc(tv)}</span>`;

// ---- 1. Accuracy checks: stop if anything is wrong ----
const { errors, warnings } = validateSeason(games);
for (const w of warnings) console.warn('Warning: ' + w);
if (errors.length) {
  console.error(`\n${errors.length} accuracy check(s) failed. The site was NOT updated:\n`);
  for (const e of errors.slice(0, 50)) console.error('  ✗ ' + e);
  if (errors.length > 50) console.error(`  …and ${errors.length - 50} more`);
  process.exit(1);
}
console.log(`✓ ${games.length} games passed all accuracy checks`);

// ---- Play-by-play: on/off, lineups, impact (only games that match the box score exactly) ----
const pbpOk = [], pbpBad = [], pbpNear = new Map(), pmRepaired = new Map();
for (const g of games) {
  const raw = rawPbp.get(g.gameCode);
  if (!raw) continue;
  const r = buildStints(g, raw);
  if (r.ok) { const fix = repairPlusMinus(g, r.stints); if (fix) { pmRepaired.set(g.gameCode, fix.fixed); console.log(`  game ${g.gameCode} (${g.home.tv}–${g.away.tv}): official +/- is wrong for ${fix.fixed} players (off by up to ${fix.maxDiff}), recalculated from the play-by-play`); } }
  const why = r.ok ? checkStints(g, r.stints) : r.reason;
  if (why && r.ok && !why.startsWith('play-by-play score')) pbpNear.set(g.gameCode, { stints: r.stints, why });
  if (why) pbpBad.push(`game ${g.gameCode} (${g.home.tv}–${g.away.tv}): ${why}`); else pbpOk.push({ game: g, stints: r.stints, periodStints: r.periodStints, events: r.events });
}
const PBP = pbpOk.length ? aggregate(pbpOk) : null;

// ---- 2. Stats ----
// Offensive fouls (incl. charges) drawn and committed, from the play-by-play
const OFT = new Map(), OFP = new Map(), OFE = [], OFC = new Map();
for (const g of games) {
  const raw = rawPbp.get(g.gameCode); if (!raw) continue;
  const r = offensiveFouls(playLog(g, raw).plays);
  for (const [side, code] of [['H', g.home.code], ['A', g.away.code]]) {
    if (!OFT.has(code)) OFT.set(code, { gp: 0, drawn: 0, committed: 0 });
    const e = OFT.get(code); e.gp++; e.drawn += r.drawn[side]; e.committed += r.committed[side];
  }
  for (const [id, n] of r.drawers) OFP.set(id, (OFP.get(id) || 0) + n);
  for (const e of r.events) { OFE.push({ g, ...e }); if (e.committedBy) OFC.set(e.committedBy, (OFC.get(e.committedBy) || 0) + 1); }
}
const teams = teamTable(games);
const players = playerTable(games);
if (OFT.size) {
  const rows = [...OFT].map(([c, e]) => [teams.find((t) => t.code === c)?.tv || c, e.drawn, e.gp, e.drawn / e.gp, e.committed]).sort((a, b) => b[3] - a[3]);
  console.log('Offensive fouls drawn (charges etc.), per game: ' + rows.map((r, i) => `${i + 1}. ${r[0]} ${r[3].toFixed(2)} (${r[1]} in ${r[2]})`).join(' | '));
}
const qual = qualified(players, teams, cfg);
const info = seasonInfo(games);

const IMPACT = PBP ? rapm(PBP.rows) : null;
// Clutch (last 5 min of Q4/OT, within 5) and after-timeout possessions, from the checked play-by-play.
const CLUTCH = pbpOk.length ? clutchOf(pbpOk) : null;
const ATO = pbpOk.some((e) => e.events.some((x) => x.type === 'TOUT')) ? afterTimeouts(pbpOk) : null;
if (CLUTCH) cfg.hasClutch = true;
const FLOW = pbpOk.length ? flowExtras(pbpOk) : null;
// Shot locations (EuroLeague / EuroCup feed), only games whose shots match the box score
const SHOTS = loadShots(dataDir, games); // Winner League shot locations (raw.shots) are saved but not shown yet: their coordinate scale is not confirmed
if (SHOTS) console.log(`Shots: ${SHOTS.shots.length} field-goal attempts from ${SHOTS.ok} games (${SHOTS.bad} games left out: shot feed does not match the box score)`);
const ALLSHOTS = SHOTS?.shots || [];
const shotBlock = (list, { title, note = '', id = '' }) => {
  if (!list.length) return '';
  const rows = zoneRows(list, ALLSHOTS);
  const pc = (v) => (v == null ? '–' : v.toFixed(1));
  return `<div class="shot-wrap"${id ? ` id="${id}"` : ''}><div class="shot-two"><figure>${courtSvg(list, { mode: 'dots', title: title + ' — every shot' })}<figcaption><span class="lg-m"></span> made <span class="lg-x"></span> missed · ${list.length} shots</figcaption></figure>
<figure>${courtSvg(list, { mode: 'zones', league: ALLSHOTS, title: title + ' — zones' })}<figcaption><span class="zn-key zn-hot2"></span> much better than league <span class="zn-key zn-hot"></span> better <span class="zn-key zn-avg"></span> average <span class="zn-key zn-cold"></span> worse <span class="zn-key zn-cold2"></span> much worse</figcaption></figure></div>
<div class="scroll"><table class="shot-zones"><thead><tr><th>Zone</th><th class="num">FG</th><th class="num">FG%</th><th class="num">League FG%</th><th class="num">Diff</th><th class="num">Share of shots</th><th class="num">League share</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r.label}</td><td class="num">${r.m}/${r.a}</td><td class="num"><strong>${pc(r.pct)}</strong></td><td class="num muted">${pc(r.lpct)}</td><td class="num ${r.pct != null && r.lpct != null ? (r.pct >= r.lpct ? 'pos' : 'neg') : ''}">${r.pct != null && r.lpct != null ? (r.pct >= r.lpct ? '+' : '−') + Math.abs(r.pct - r.lpct).toFixed(1) : '–'}</td><td class="num">${pc(r.share)}%</td><td class="num muted">${pc(r.lshare)}%</td></tr>`).join('')}
</tbody></table></div>${note ? `<p class="muted small">${note}</p>` : ''}</div>`;
};

if (CLUTCH) console.log(`Clutch: ${CLUTCH.teams.reduce((s, t) => s + t.games, 0) / 2} clutch games; after timeouts: ${ATO ? ATO.reduce((s, t) => s + t.off.n, 0) + ' possessions' : 'no timeouts in this feed'}`);
if (rawPbp.size) {
  console.log(`✓ Play-by-play: ${pbpOk.length} of ${rawPbp.size} games match the box score exactly and are used for on/off, lineups and impact`);
  for (const b of pbpBad.slice(0, 8)) console.log('  left out: ' + b);
}
const onOffOf = (id) => {
  const o = PBP?.onoff.get(id);
  if (!o) return null;
  const off = { secs: o.teamTot.secs - o.on.secs, poss: o.teamTot.poss - o.on.poss, pf: o.teamTot.pf - o.on.pf, pa: o.teamTot.pa - o.on.pa };
  const net = (x) => (x.poss > 0 ? 100 * (x.pf - x.pa) / x.poss : null);
  return { onMin: o.on.secs / 60, offMin: off.secs / 60, onNet: net(o.on), offNet: net(off), swing: net(o.on) != null && net(off) != null && off.poss >= 20 ? net(o.on) - net(off) : null };
};
const avg = (arr, k) => arr.reduce((s, x) => s + x[k], 0) / (arr.length || 1);
const teamName = new Map(teams.map((t) => [t.code, t.name]));
// "FC BARCELONA" -> "FC Barcelona", "LDLC ASVEL VILLEURBANNE" -> "LDLC ASVEL Villeurbanne"
const KEEP_UPPER = new Set(['LDLC', 'ASVEL', 'AKTOR', 'BC', 'FC', 'KK', 'BK', 'AS', 'EA7', 'CSKA', 'PAOK', 'AEK', 'UNICS', 'ALBA', 'TSU']);
const titleCase = (s) => s.split(/\s+/).map((w) => (KEEP_UPPER.has(w) || w.length <= 2 || /\d/.test(w)
  ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');

// ---- 3. Pages ----
const ord = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return n + (teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
};
const N = teams.length;
const lg = (k) => avg(teams, k);
const safe = (code) => String(code).replace(/[^A-Za-z0-9]/g, '');
const teamHref = (code) => `team-${safe(code)}.html`;
const rankTag = (r, total = N) => { const band = Math.max(3, Math.round(total * 0.1)); return `<span class="rank ${r <= band ? 'top' : r > total - band ? 'bottom' : ''}">${ord(r)}</span>`; };
const mmss = (m) => { const t = Math.round(m * 60); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

const crestImg = (code, size = 'big') => crests.has(code) ? `<img class="crest ${size}" src="${esc(crests.get(code))}" alt="" width="56" height="56">` : '';
const coverCrest = (code) => crests.has(code) ? `<div class="side cover-crest"><img src="${esc(crests.get(code))}" alt=""></div>` : '';
const cover = ({ crumbs = '', kicker = '', title, meta = '', lede = '', strip = [], side = '', actions = '' }) => `<section class="cover"><div class="wrap"><div>
${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}${kicker ? `<span class="kicker">${kicker}</span>` : ''}
<h1>${title}</h1>${meta ? `<div class="cover-meta">${meta}</div>` : ''}${lede ? `<p class="cover-lede">${lede}</p>` : ''}
${strip.length ? `<div class="strip">${strip.map(([b, t]) => `<span><b>${b}</b> ${t}</span>`).join('')}</div>` : ''}${actions ? `<div class="cover-actions">${actions}</div>` : ''}
</div>${side}</div></section>`;
const roundLine = info.lastDate ? `Through ${info.lastRound ? `Round ${info.lastRound}, ` : ''}${fmtDate(info.lastDate)}` : 'Season';
const qualNote = `Players averaging at least ${cfg.minMinutesForLeaders} minutes and playing ${Math.round(cfg.minGamesShare * 100)}% of their team's games.`;
// ---- Game pages: every game in full (modelled on the EuroLeague Media Game Center) ----
const gameHref = (code) => `game-${safe(code)}.html`;
const stintsOf = new Map(pbpOk.map(({ game, stints }) => [game.gameCode, stints]));
const QB_CHECK = { games: 0, stats: 0, time: 0, why: {} };
const periodStintsOf = new Map(pbpOk.map(({ game, periodStints }) => [game.gameCode, periodStints]));
const nameOf = new Map(players.map((q) => [q.id, q.name]));
const pctTxt = (m, a) => (a ? f1(100 * m / a) : '–');
const sortTh = (label, num = true, title = '') => `<th scope="col"${num ? ' class="num"' : ''}${title ? ` title="${esc(title)}"` : ''}><button type="button">${label}</button></th>`;
const GBOX = [['min', 'MIN'], ['pts', 'PTS'], ['fg2', '2P'], ['fg3', '3P'], ['ft', 'FT'], ['oreb', 'OR'], ['dreb', 'DR'], ['reb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['tov', 'TOV'], ['blk', 'BLK'], ['pf', 'PF'], ['fd', 'FD'], ['pm', '+/-'], ['pir', 'PIR']];
const boxCell = (s, k, isTeam) => {
  if (k === 'min') return isTeam ? `<td class="num">${Math.round(s.min || 200)}</td>` : `<td class="num" data-v="${s.min}">${mmss(s.min)}</td>`;
  if (k === 'fg2') return `<td class="num" data-v="${s.fgm2 + s.fga2 / 1000}">${s.fgm2}/${s.fga2}</td>`;
  if (k === 'fg3') return `<td class="num" data-v="${s.fgm3 + s.fga3 / 1000}">${s.fgm3}/${s.fga3}</td>`;
  if (k === 'ft') return `<td class="num" data-v="${s.ftm + s.fta / 1000}">${s.ftm}/${s.fta}</td>`;
  if (k === 'pm') return isTeam ? '<td class="num"></td>' : `<td class="num ${s.pm > 0 ? 'pos' : s.pm < 0 ? 'neg' : ''}" data-v="${s.pm}">${s.pm > 0 ? '+' : ''}${s.pm}</td>`;
  return `<td class="num" data-v="${s[k]}">${k === 'pts' ? `<strong>${s[k]}</strong>` : s[k]}</td>`;
};
function gameBox(side) {
  const ps = side.players.filter((p) => p.min > 0).sort((a, b) => b.starter - a.starter || b.min - a.min);
  const dnp = side.players.filter((p) => p.min <= 0);
  const T = side.totals;
  return `<div class="scroll"><table class="sortable gbox"><thead><tr>${sortTh('#')}${sortTh('Player', false)}${GBOX.map(([, l]) => sortTh(l)).join('')}</tr></thead><tbody>
${ps.map((p) => `<tr><td class="num muted" data-v="${Number(p.number) || 0}">${esc(p.number ?? '')}</td><td data-v="${esc(p.name)}"><a href="${playerHref(p.id)}">${esc(p.name)}</a>${p.starter ? '<span class="muted">*</span>' : ''}</td>${GBOX.map(([k]) => boxCell(p, k)).join('')}</tr>`).join('')}
</tbody><tfoot><tr><td></td><th scope="row">Team</th>${GBOX.map(([k]) => boxCell({ ...T, min: side.teamMinutes }, k, true)).join('')}</tr>
<tr class="muted"><td></td><th scope="row">Shooting</th><td></td><td></td><td class="num">${pctTxt(T.fgm2, T.fga2)}%</td><td class="num">${pctTxt(T.fgm3, T.fga3)}%</td><td class="num">${pctTxt(T.ftm, T.fta)}%</td><td colspan="11"></td></tr></tfoot></table></div>
${dnp.length ? `<p class="muted small">Did not play: ${dnp.map((p) => esc(p.name)).join(', ')}. * started.</p>` : '<p class="muted small">* started.</p>'}`;
}
function flowSvg(line, periods, hTv, aTv) {
  const W = 900, H = 240, L = 40, R = 10, T = 14, B = 26;
  const total = periods <= 4 ? 2400 : 2400 + (periods - 4) * 300;
  const m = Math.max(10, ...line.map(([, v]) => Math.abs(v)));
  const top = Math.ceil(m / 5) * 5;
  const sx = (t) => L + (Math.min(t, total) / total) * (W - L - R);
  const sy = (v) => T + ((top - v) / (2 * top)) * (H - T - B);
  let d = `M${sx(0)},${sy(0)}`;
  for (const [t, v] of line) d += ` H${sx(t).toFixed(1)} V${sy(v).toFixed(1)}`;
  d += ` H${sx(total)}`;
  const area = `${d} V${sy(0)} H${sx(0)} Z`;
  const marks = [];
  for (let p = 1; p < periods; p++) marks.push(p <= 4 ? p * 600 : 2400 + (p - 4) * 300);
  const labels = Array.from({ length: periods }, (_, i) => { const s = i < 4 ? i * 600 : 2400 + (i - 4) * 300, e = i < 4 ? s + 600 : s + 300; return [(s + e) / 2, i < 4 ? `Q${i + 1}` : `OT${i - 3}`]; });
  const ticks = [top, top / 2, 0, -top / 2, -top];
  return `<svg class="flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score margin through the game. Above the line ${esc(hTv)} lead, below it ${esc(aTv)} lead.">
<defs><clipPath id="fl-up"><rect x="0" y="0" width="${W}" height="${sy(0)}"/></clipPath><clipPath id="fl-dn"><rect x="0" y="${sy(0)}" width="${W}" height="${H}"/></clipPath></defs>
${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="${v === 0 ? 'zero' : 'grid'}"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${v > 0 ? '+' + v : v < 0 ? '+' + -v : '0'}</text>`).join('')}
${marks.map((t) => `<line x1="${sx(t)}" x2="${sx(t)}" y1="${T}" y2="${H - B}" class="grid"/>`).join('')}
${labels.map(([t, l]) => `<text x="${sx(t)}" y="${H - 8}" text-anchor="middle">${l}</text>`).join('')}
<path d="${area}" class="fa-h" clip-path="url(#fl-up)"/><path d="${area}" class="fa-a" clip-path="url(#fl-dn)"/><path d="${d}" class="fl"/>
<text x="${L + 6}" y="${T + 12}" class="lbl">${esc(hTv)} ahead</text><text x="${L + 6}" y="${H - B - 6}" class="lbl">${esc(aTv)} ahead</text></svg>`;
}
const per100 = (pts, poss) => (poss ? 100 * pts / poss : 0);
function compareRows(g, x = {}) {
  const h = g.home.totals, a = g.away.totals;
  const poss = (t) => t.fga2 + t.fga3 - t.oreb + t.tov + 0.44 * t.fta;
  const P = (poss(h) + poss(a)) / 2;
  const efg = (t) => (t.fga2 + t.fga3 ? 100 * (t.fgm2 + t.fgm3 + 0.5 * t.fgm3) / (t.fga2 + t.fga3) : 0);
  const ts = (t) => (t.fga2 + t.fga3 + 0.44 * t.fta ? 100 * t.pts / (2 * (t.fga2 + t.fga3 + 0.44 * t.fta)) : 0);
  const pct = (m, n) => (n ? 100 * m / n : 0);
  const sum = (side, k) => side.players.reduce((acc, p) => acc + (p[k] || 0), 0);
  const fdH = h.fd ?? sum(g.home, 'fd'), fdA = a.fd ?? sum(g.away, 'fd');
  const stB = (side) => { const st = side.players.filter((p) => p.starter).reduce((acc, p) => acc + p.pts, 0); return [st, side.score - st]; };
  const [sH, bH] = stB(g.home), [sA, bA] = stB(g.away);
  const D = x.detail?.pts, fb = x.fastBreak;
  // [label, home, away, decimals, home note, away note, fewer is better, neutral (no "better" side), home text, away text]
  const groups = [
    ['Scoring', [
      ['Points', h.pts, a.pts],
      ['2-pointers', pct(h.fgm2, h.fga2), pct(a.fgm2, a.fga2), 1, `${h.fgm2}/${h.fga2}`, `${a.fgm2}/${a.fga2}`],
      ['3-pointers', pct(h.fgm3, h.fga3), pct(a.fgm3, a.fga3), 1, `${h.fgm3}/${h.fga3}`, `${a.fgm3}/${a.fga3}`],
      ['Free throws', pct(h.ftm, h.fta), pct(a.ftm, a.fta), 1, `${h.ftm}/${h.fta}`, `${a.ftm}/${a.fta}`],
      ['Effective FG %', efg(h), efg(a), 1], ['True shooting %', ts(h), ts(a), 1],
      ['Possessions', poss(h), poss(a), 1, '', '', false, true],
      ['Points per possession', P ? h.pts / P : 0, P ? a.pts / P : 0, 2],
      fb ? ['Fast-break points', fb.H, fb.A] : null,
      D ? ['Points off turnovers', D.H.offTO, D.A.offTO] : null
    ]],
    ['Rebounds & ball', [
      ['Rebounds', h.reb, a.reb, 0, `(${h.oreb}+${h.dreb})`, `(${a.oreb}+${a.dreb})`],
      ['Offensive rebound %', pct(h.oreb, h.oreb + a.dreb), pct(a.oreb, a.oreb + h.dreb), 1],
      ['Defensive rebound %', pct(h.dreb, h.dreb + a.oreb), pct(a.dreb, a.dreb + h.oreb), 1],
      ['Assists', h.ast, a.ast], ['Assists / turnovers', h.tov ? h.ast / h.tov : h.ast, a.tov ? a.ast / a.tov : a.ast, 2],
      ['Turnovers', h.tov, a.tov, 0, '', '', true], ['Steals', h.stl, a.stl], ['Blocks', h.blk, a.blk],
      ['Fouls', h.pf, a.pf, 0, '', '', true], ['Fouls drawn', fdH, fdA], ['PIR', h.pir, a.pir]
    ]],
    ['Game flow', [
      ['Starters · bench points', sH + bH, sA + bA, 0, '', '', false, true, `${sH} · ${bH}`, `${sA} · ${bA}`],
      D ? ['Points after steals', D.H.afterSteal, D.A.afterSteal] : null,
      D ? ['Second-chance points', D.H.second, D.A.second] : null,
      x.flow ? ['Biggest lead', x.flow.maxLead.H, x.flow.maxLead.A] : null,
      x.flow ? ['Biggest run', x.flow.bestRun.H, x.flow.bestRun.A, 0, '', '', false, false, `${x.flow.bestRun.H}–0`, `${x.flow.bestRun.A}–0`] : null
    ]]
  ];
  const row = ([label, hv, av, dec, sx, sy, low, neutral, tx, ty]) => {
    const tot = Math.abs(hv) + Math.abs(av) || 1, wx = (100 * Math.abs(hv) / tot).toFixed(1);
    const better = neutral || hv === av ? '' : (low ? hv < av : hv > av) ? 'h' : 'a';
    const fx = tx ?? (dec ? hv.toFixed(dec) : hv), fy = ty ?? (dec ? av.toFixed(dec) : av);
    return `<div class="cmp ${better ? 'b-' + better : ''}"><span class="v h">${fx}${sx ? ` <small>${sx}</small>` : ''}</span><span class="lab">${label}${low ? ' <small>(fewer is better)</small>' : ''}</span><span class="v a">${fy}${sy ? ` <small>${sy}</small>` : ''}</span><div class="split"><i style="width:${wx}%"></i><i style="width:${(100 - wx).toFixed(1)}%"></i></div></div>`;
  };
  // ties and lead changes, in order, with who did it
  const chips = (list) => list.map((r) => `<span class="fl-chip fl-${r.side === 'H' ? 'h' : 'a'}"><b>${esc(r.side === 'H' ? g.home.tv : g.away.tv)}</b> ${r.period <= 4 ? 'Q' + r.period : 'OT' + (r.period - 4)} ${esc(r.clock)} <strong>${r.hs}–${r.as}</strong> ${esc(nameOf.get(r.pid) || '')} ${r.type === 'FTM' ? 'FT' : r.type === '3FGM' ? '3PT' : '2PT'}</span>`).join('');
  const lists = x.detail ? `<div class="fl-list"><h4>Times tied · ${x.detail.ties.length} <small>in order, who tied the game</small></h4>${chips(x.detail.ties) || '<span class="muted small">None</span>'}</div>
<div class="fl-list"><h4>Lead changes · ${x.detail.changes.length} <small>in order, who took the lead</small></h4>${chips(x.detail.changes) || '<span class="muted small">None</span>'}</div>` : '';
  return { P, html: groups.map(([title, rows]) => `<h3 class="cmp-grp">${title}</h3>${rows.filter(Boolean).map(row).join('')}`).join('') + lists };
}
const sideHead = (s) => `<h3 class="side-h">${badge(s.code, s.tv)} ${esc(titleCase(s.name))}</h3>`;
function gameUnits(g, stints, size) {
  const out = { H: new Map(), A: new Map() };
  const A = g.home.code, B = g.away.code;
  const combos = (ids, k) => { const r = []; const rec = (st, acc) => { if (acc.length === k) { r.push(acc); return; } for (let i = st; i < ids.length; i++) rec(i + 1, [...acc, ids[i]]); }; rec(0, []); return r; };
  const zero = () => Object.fromEntries(BOX_KEYS.map((k) => [k, 0]));
  for (const s of stints) for (const [side, ids, me, op, poss, oposs] of [['H', s.home, A, B, s.possH, s.possA], ['A', s.away, B, A, s.possA, s.possH]]) for (const c of combos(ids, size)) {
    const k = c.join(','); if (!out[side].has(k)) out[side].set(k, { ids: c, secs: 0, pf: 0, pa: 0, poss: 0, oposs: 0, me: zero(), op: zero() });
    const e = out[side].get(k); e.secs += s.secs; e.pf += s.pts[me]; e.pa += s.pts[op]; e.poss += poss; e.oposs += oposs;
    for (const x of BOX_KEYS) { e.me[x] += s.box[me][x]; e.op[x] += s.box[op][x]; }
  }
  for (const s of ['H', 'A']) out[s] = [...out[s].values()].filter((e) => e.secs > 0 || e.pf || e.pa).sort((x, y) => y.secs - x.secs);
  return out;
}
const UCOLS = [['MIN', 'Minutes together'], ['PTS', 'Points scored'], ['OPP', 'Points allowed'], ['+/-', 'Plus-minus'], ['POSS', 'Possessions (average of both teams)'], ['ORtg', 'Points scored per 100 possessions'], ['DRtg', 'Points allowed per 100 possessions'], ['Net', 'ORtg minus DRtg'], ['2P', '2-pointers made/attempted'], ['3P', '3-pointers made/attempted'], ['FT', 'Free throws made/attempted'], ['eFG%', 'Effective field goal %'], ['OR', 'Offensive rebounds'], ['DR', 'Defensive rebounds'], ['AST', 'Assists'], ['TOV', 'Turnovers'], ['STL', 'Steals'], ['BLK', 'Blocks'], ['PF', 'Fouls'], ['OPP 3P', 'Opponent 3-pointers'], ['OPP TOV', 'Opponent turnovers'], ['OPP OR', 'Opponent offensive rebounds']];
const unitTable = (list) => {
  const td = (v, txt = v, cls = '') => `<td class="num ${cls}" data-v="${v}">${txt}</td>`;
  const fr = (m, a) => td(m + a / 1000, `${m}/${a}`);
  return `<div class="scroll"><table class="sortable units"><thead><tr>${sortTh('Players', false)}${UCOLS.map(([l, t]) => sortTh(l, true, t)).join('')}</tr></thead><tbody>
${list.map((u) => {
    const P = (u.poss + u.oposs) / 2, o = P ? 100 * u.pf / P : null, d = P ? 100 * u.pa / P : null, m = u.me, x = u.op;
    const fga = m.fga2 + m.fga3, efg = fga ? 100 * (m.fgm2 + 1.5 * m.fgm3) / fga : null, pm = u.pf - u.pa;
    const n = (v, f = f1) => (v == null ? td(-999, '–') : td(v.toFixed(2), f(v)));
    return `<tr><td data-v="${esc(u.ids.map((id) => nameOf.get(id) || id).join(' '))}">${u.ids.map((id) => `<a href="${playerHref(id)}">${esc(nameOf.get(id) || id)}</a>`).join('<span class="muted"> · </span>')}</td>${td(u.secs, mmss(u.secs / 60))}${td(u.pf)}${td(u.pa)}${td(pm, `${pm > 0 ? '+' : ''}${pm}`, pm > 0 ? 'pos' : pm < 0 ? 'neg' : '')}${td(P.toFixed(1), f1(P))}${n(o)}${n(d)}${o == null ? td(-999, '–') : td((o - d).toFixed(2), signed(o - d), o > d ? 'pos' : o < d ? 'neg' : '')}${fr(m.fgm2, m.fga2)}${fr(m.fgm3, m.fga3)}${fr(m.ftm, m.fta)}${n(efg)}${td(m.oreb)}${td(m.dreb)}${td(m.ast)}${td(m.tov)}${td(m.stl)}${td(m.blk)}${td(m.pf)}${fr(x.fgm3, x.fga3)}${td(x.tov)}${td(x.oreb)}</tr>`;
  }).join('')}</tbody></table></div>`;
};
function lineupBlock(g, stints, note) {
  const sizes = [5, 4, 3, 2], U = Object.fromEntries(sizes.map((k) => [k, gameUnits(g, stints, k)]));
  const name = { 5: 'Five-man lineups', 4: '4-man', 3: '3-man', 2: 'Pairs' };
  const mm = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
  const nmL = (ids) => ids.map((id) => esc(nameOf.get(id) || id)).join(' · ');
  const sumSide = (side) => {
    const fives = U[5][side], pairs = U[2][side];
    const f2 = fives.filter((u) => u.secs >= 120), p5 = pairs.filter((u) => u.secs >= 300);
    const by = (list, dir) => list.slice().sort((x, y) => dir * ((y.pf - y.pa) - (x.pf - x.pa)) || y.secs - x.secs)[0];
    const rows = [['Most used five', fives[0]], ['Best five +/-', by(f2, 1)], ['Worst five +/-', by(f2, -1)], ['Best pair +/-', by(p5, 1)], ['Worst pair +/-', by(p5, -1)]];
    return rows.filter(([, u]) => u).map(([l, u]) => { const d = u.pf - u.pa; return `<tr><th scope="row">${l}</th><td>${nmL(u.ids)}</td><td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}"><strong>${d > 0 ? '+' : ''}${d}</strong></td><td class="num muted">${mm(u.secs)}</td></tr>`; }).join('');
  };
  const summary = `<div class="lu-sum">${[['H', g.home], ['A', g.away]].map(([k, S]) => `<div>${sideHead(S)}<table class="lu-sum-t"><tbody>${sumSide(k)}</tbody></table></div>`).join('')}</div><p class="muted small">Best and worst: fives with at least 2:00 together, pairs with at least 5:00.</p>`;
  return `<section class="card" id="lineups"><h2>Lineups</h2>${summary}<p class="muted">Every unit that played in this game, with the full stats while it was on the court. Click any column to sort.</p>
${note ? `<p class="note-warn">${note}</p>` : ''}
<div class="seg" role="group" aria-label="Lineup size">${sizes.map((k, i) => `<button type="button" data-size="${k}" aria-pressed="${i === 0}">${name[k]}</button>`).join('')}</div>
${sizes.map((k, i) => `<div class="unit-size" data-size="${k}"${i ? ' hidden' : ''}>${sideHead(g.home)}${unitTable(U[k].H)}${sideHead(g.away)}${unitTable(U[k].A)}</div>`).join('')}
</section>`;
}
const gameMvp = (g) => {
  const win = g.home.score > g.away.score ? g.home : g.away;
  const p = win.players.filter((x) => x.min > 0).sort((x, y) => y.pir - x.pir || y.pts - x.pts)[0];
  return p ? { p, s: win } : null;
};
// ---- Hapoel game report: one printable page per Hapoel game (EuroLeague and Winner League) ----
const HAP_GAME_CODE = (LEAGUE === 'el' || LEAGUE === 'il') ? (IS_EL ? (cfg.hapoelCode || 'HTA') : teams.find((t) => /hapoel/i.test(t.name) && /tel[ -]?aviv/i.test(t.name))?.code) : null;
const isHapGame = (g) => !!HAP_GAME_CODE && (g.home.code === HAP_GAME_CODE || g.away.code === HAP_GAME_CODE);
const hapReportHref = (code) => `game-${safe(code)}-hapoel.html`;
// how a team got its points in one game
function scoringBreakdown(g, side, plays) {
  const me = side === 'H' ? g.home : g.away, op = side === 'H' ? g.away : g.home, t = me.totals;
  const det = plays ? flowDetail(plays).pts[side] : null;
  const shotsG = ALLSHOTS.filter((x) => x.g === g.gameCode && x.team === me.code && x.made);
  const raw = rawShots.get(g.gameCode)?.filter((r) => r[0] === me.code && /M$/.test(r[2]));
  const fb = shotsG.length || ALLSHOTS.some((x) => x.g === g.gameCode) ? shotsG.filter((x) => x.fb).reduce((s, x) => s + (x.is3 ? 3 : 2), 0) : raw?.length ? raw.filter((r) => r[5]).reduce((s, r) => s + (r[2].startsWith('3') ? 3 : 2), 0) : null;
  const paint = ALLSHOTS.some((x) => x.g === g.gameCode) ? shotsG.filter((x) => !x.is3 && (x.z === 'rim' || x.z === 'paint')).length * 2 : null;
  const starters = me.players.filter((p) => p.starter).reduce((s, p) => s + p.pts, 0);
  const fgm = t.fgm2 + t.fgm3;
  return { pts: me.score, two: 2 * t.fgm2, three: 3 * t.fgm3, ft: t.ftm, paint, fb, offTO: det?.offTO ?? null, afterSteal: det?.afterSteal ?? null, second: det?.second ?? null, bench: me.score - starters, starters, assisted: fgm ? 100 * t.ast / fgm : null, opp: op.code };
}
const teamGameMetrics = (g, side) => {
  const me = side === 'H' ? g.home : g.away, op = side === 'H' ? g.away : g.home, t = me.totals, o = op.totals;
  const poss = (x) => x.fga2 + x.fga3 - x.oreb + x.tov + 0.44 * x.fta, P = (poss(t) + poss(o)) / 2, fga = t.fga2 + t.fga3, ofga = o.fga2 + o.fga3;
  return { pts: me.score, opp: op.score, ppp: P ? me.score / P : 0, oppp: P ? op.score / P : 0, efg: fga ? 100 * (t.fgm2 + 1.5 * t.fgm3) / fga : 0, oefg: ofga ? 100 * (o.fgm2 + 1.5 * o.fgm3) / ofga : 0,
    p2: t.fga2 ? 100 * t.fgm2 / t.fga2 : 0, p3: t.fga3 ? 100 * t.fgm3 / t.fga3 : 0, fg3m: t.fgm3, fta: t.fta, ft: t.fta ? 100 * t.ftm / t.fta : 0, oreb: t.oreb, dreb: t.dreb, orebPct: 100 * t.oreb / ((t.oreb + o.dreb) || 1), drebPct: 100 * t.dreb / ((t.dreb + o.oreb) || 1),
    ast: t.ast, tov: t.tov, stl: t.stl, blk: t.blk, pf: t.pf, fd: t.fd ?? 0, oTov: o.tov, oFta: o.fta, o3m: o.fgm3, oReb: o.oreb + o.dreb };
};
let HAP_SEASON = null;
function hapSeason() {
  if (HAP_SEASON) return HAP_SEASON;
  const list = games.filter(isHapGame).map((g) => { const side = g.home.code === HAP_GAME_CODE ? 'H' : 'A'; const raw = rawPbp.get(g.gameCode); const plays = raw ? playLog(g, raw).plays : null; return { g, side, m: teamGameMetrics(g, side), s: scoringBreakdown(g, side, plays), so: scoringBreakdown(g, side === 'H' ? 'A' : 'H', plays) }; });
  const avg = (f) => { const v = list.map(f).filter((x) => x != null && Number.isFinite(x)); const m = v.reduce((a, b) => a + b, 0) / (v.length || 1); const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1)); return v.length ? { m, sd, n: v.length } : null; };
  HAP_SEASON = { list, avg };
  return HAP_SEASON;
}
function hapoelGameReport(g, { log, stints, qbJson }) {
  const side = g.home.code === HAP_GAME_CODE ? 'H' : 'A', me = side === 'H' ? g.home : g.away, op = side === 'H' ? g.away : g.home;
  const won = me.score > op.score, S = hapSeason(), plays = log?.plays || null;
  const sc = scoringBreakdown(g, side, plays), sco = scoringBreakdown(g, side === 'H' ? 'A' : 'H', plays);
  const M = teamGameMetrics(g, side), opT = titleCase(op.name);
  const f1x = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1)), sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  // 1. How the points came
  const rowsS = [['2-pointers', 'two'], ['3-pointers', 'three'], ['Free throws', 'ft'], ['In the paint', 'paint'], ['Fast break', 'fb'], ['Off turnovers', 'offTO'], ['After steals', 'afterSteal'], ['Second chance', 'second'], ['Starters', 'starters'], ['Bench', 'bench']];
  const scoreTable = `<table class="rtab"><thead><tr><th>Points</th><th class="num">Hapoel</th><th class="num muted">Hapoel avg</th><th class="num">${esc(op.tv)}</th><th class="num muted">Allowed avg</th></tr></thead><tbody>
${rowsS.filter(([, k]) => sc[k] != null).map(([l, k]) => { const a = S.avg((x) => x.s[k]), b = S.avg((x) => x.so[k]); const cls = (v, av, good) => (av && Math.abs(v - av.m) >= Math.max(3, 0.75 * av.sd) ? ((v > av.m) === good ? 'pos' : 'neg') : ''); return `<tr><td>${l}</td><td class="num ${cls(sc[k], a, true)}"><strong>${sc[k]}</strong></td><td class="num muted">${a ? f1x(a.m) : '–'}</td><td class="num ${cls(sco[k], b, false)}"><strong>${sco[k]}</strong></td><td class="num muted">${b ? f1x(b.m) : '–'}</td></tr>`; }).join('')}
<tr><td>Assisted baskets</td><td class="num">${f1x(sc.assisted)}%</td><td class="num muted">${f1x(S.avg((x) => x.s.assisted)?.m)}%</td><td class="num">${f1x(sco.assisted)}%</td><td class="num muted">${f1x(S.avg((x) => x.so.assisted)?.m)}%</td></tr>
</tbody></table><p class="muted small">Green / red: clearly better / worse than Hapoel's average this season in this competition (${S.list.length} games). Paint and fast-break points come from the official shot data${sc.paint == null ? ' (paint not available in this league)' : ''}.</p>`;
  // 2. Lineups
  let lineups = '<p class="muted">Lineups are not available for this game (the play-by-play does not match the box score).</p>';
  if (stints) {
    const U5 = gameUnits(g, stints, 5)[side], U2 = gameUnits(g, stints, 2)[side];
    const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const nmL = (ids) => ids.map((id) => esc(nameOf.get(id) || id)).join(' · ');
    const rt = (u) => { const P = (u.poss + u.oposs) / 2; return P ? [100 * u.pf / P, 100 * u.pa / P] : [null, null]; };
    const unitRows = (list) => list.map((u) => { const d = u.pf - u.pa, [o, dd] = rt(u); return `<tr><td class="small">${nmL(u.ids)}</td><td class="num">${mm(u.secs)}</td><td class="num">${u.pf}–${u.pa}</td><td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}"><strong>${d > 0 ? '+' : ''}${d}</strong></td><td class="num">${f1x(o)}</td><td class="num">${f1x(dd)}</td></tr>`; }).join('');
    const pairs = U2.filter((u) => u.secs >= 300).sort((a, b) => (b.pf - b.pa) - (a.pf - a.pa));
    const startIds = me.players.filter((p) => p.starter).map((p) => p.id).sort().join(',');
    const start = U5.find((u) => u.ids.slice().sort().join(',') === startIds);
    lineups = `${start ? `<p><strong>Starting five:</strong> ${nmL(start.ids)} — ${mm(start.secs)} together, ${start.pf}–${start.pa} (${start.pf - start.pa > 0 ? '+' : ''}${start.pf - start.pa}).</p>` : ''}
<table class="rtab"><thead><tr><th>Five-man lineup</th><th class="num">MIN</th><th class="num">Score</th><th class="num">+/-</th><th class="num">ORtg</th><th class="num">DRtg</th></tr></thead><tbody>${unitRows(U5.slice(0, 10))}</tbody></table>
${pairs.length ? `<div class="r-two"><div><h3>Best pairs</h3><table class="rtab"><tbody>${pairs.slice(0, 4).map((u) => `<tr><td class="small">${nmL(u.ids)}</td><td class="num">${mm(u.secs)}</td><td class="num pos">${u.pf - u.pa > 0 ? '+' : ''}${u.pf - u.pa}</td></tr>`).join('')}</tbody></table></div><div><h3>Worst pairs</h3><table class="rtab"><tbody>${pairs.slice(-4).reverse().map((u) => `<tr><td class="small">${nmL(u.ids)}</td><td class="num">${mm(u.secs)}</td><td class="num neg">${u.pf - u.pa > 0 ? '+' : ''}${u.pf - u.pa}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
<p class="muted small">10 most used five-man lineups. ORtg / DRtg = points scored / allowed per 100 possessions while that five was on the court. Pairs: at least 5:00 together.</p>`;
  }
  // 3. Quarter by quarter (from the play-by-play)
  let quarters = '';
  if (plays) {
    const nP = Math.max(4, ...plays.map((p) => p[0]));
    const Z = () => ({ pts: 0, fgm2: 0, fga2: 0, fgm3: 0, fga3: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, tov: 0, stl: 0, pf: 0 });
    const Q = Array.from({ length: nP }, () => ({ H: Z(), A: Z(), sc: new Map() }));
    const MAP = { '2FGM': ['fgm2', 'fga2'], '2FGA': ['fga2'], '3FGM': ['fgm3', 'fga3'], '3FGA': ['fga3'], FTM: ['ftm', 'fta'], FTA: ['fta'], O: ['oreb'], D: ['dreb'], AS: ['ast'], TO: ['tov'], ST: ['stl'], CM: ['pf'], OF: ['pf'] };
    for (const [per, , s2, pid, type] of plays) { if (s2 !== 'H' && s2 !== 'A') continue; const q = Q[per - 1]; if (!q) continue; for (const k of MAP[type] || []) q[s2][k]++; const p = type === '2FGM' ? 2 : type === '3FGM' ? 3 : type === 'FTM' ? 1 : 0; if (p) { q[s2].pts += p; if (s2 === side && pid) q.sc.set(pid, (q.sc.get(pid) || 0) + p); } }
    const o = side === 'H' ? 'A' : 'H';
    const BP = flowDetail(plays).byPeriod, zz = { offTO: 0, second: 0 };
    const qd = Q.map((q, i) => { const fd = BP[i + 1] || { H: zz, A: zz }; return { ...q, offTO: fd[side].offTO, oOffTO: fd[o].offTO, second: fd[side].second, oSecond: fd[o].second }; });
    const lbl = (i) => (i < 4 ? 'Q' + (i + 1) : 'OT' + (nP > 5 ? i - 3 : ''));
    const r = (label, f, good = 1) => `<tr><td>${label}</td>${qd.map((q) => { const [a, b, txt] = f(q); const c = a === b || good === 0 ? '' : (good * (a - b) > 0 ? 'pos' : 'neg'); return `<td class="num ${c}">${txt ?? `${a}–${b}`}</td>`; }).join('')}</tr>`;
    const pc = (m, a) => (a ? Math.round(100 * m / a) + '%' : '–');
    quarters = `<table class="rtab qtab"><thead><tr><th>Hapoel – ${esc(op.tv)}</th>${qd.map((_, i) => `<th class="num">${lbl(i)}</th>`).join('')}</tr></thead><tbody>
${r('Score', (q) => [q[side].pts, q[o].pts, `<strong>${q[side].pts}–${q[o].pts}</strong>`])}
${r('Margin', (q) => [q[side].pts - q[o].pts, 0, `${q[side].pts - q[o].pts > 0 ? '+' : ''}${q[side].pts - q[o].pts}`])}
${r('2-pointers', (q) => [q[side].fga2 ? q[side].fgm2 / q[side].fga2 : 0, q[o].fga2 ? q[o].fgm2 / q[o].fga2 : 0, `${q[side].fgm2}/${q[side].fga2} · ${q[o].fgm2}/${q[o].fga2}`])}
${r('3-pointers', (q) => [q[side].fga3 ? q[side].fgm3 / q[side].fga3 : 0, q[o].fga3 ? q[o].fgm3 / q[o].fga3 : 0, `${q[side].fgm3}/${q[side].fga3} · ${q[o].fgm3}/${q[o].fga3}`])}
${r('Free throws', (q) => [q[side].ftm, q[o].ftm, `${q[side].ftm}/${q[side].fta} · ${q[o].ftm}/${q[o].fta}`])}
${r('Rebounds (off.)', (q) => [q[side].oreb + q[side].dreb, q[o].oreb + q[o].dreb, `${q[side].oreb + q[side].dreb} (${q[side].oreb}) · ${q[o].oreb + q[o].dreb} (${q[o].oreb})`])}
${r('Assists', (q) => [q[side].ast, q[o].ast])}${r('Turnovers', (q) => [q[side].tov, q[o].tov], -1)}${r('Fouls', (q) => [q[side].pf, q[o].pf], -1)}
${r('Points off turnovers', (q) => [q.offTO, q.oOffTO])}${r('Second-chance points', (q) => [q.second, q.oSecond])}
<tr><td>Hapoel top scorer</td>${qd.map((q) => { const t = [...q.sc.entries()].sort((a, b) => b[1] - a[1])[0]; return `<td class="num small">${t ? `${esc(nameOf.get(t[0]) || '')} ${t[1]}` : '–'}</td>`; }).join('')}</tr>
</tbody></table><p class="muted small">Hapoel first, ${esc(op.tv)} second. Green: Hapoel better in that quarter.</p>
${(() => { const best = qd.map((q, i) => [i, q[side].pts - q[o].pts]).sort((a, b) => b[1] - a[1]); return `<p><strong>Best quarter:</strong> ${lbl(best[0][0])} (${best[0][1] > 0 ? '+' : ''}${best[0][1]}). <strong>Worst quarter:</strong> ${lbl(best[best.length - 1][0])} (${best[best.length - 1][1] > 0 ? '+' : ''}${best[best.length - 1][1]}).</p>`; })()}`;
  }
  // 4. Ups and downs: players against their season, team against its season and the opponent
  const seasonOf = new Map(players.filter((p) => p.team === me.code).map((p) => [p.id, p]));
  const ups = [], downs = [];
  const tsOf = (p) => { const a = p.fga2 + p.fga3 + 0.44 * p.fta; return a ? 100 * p.pts / (2 * a) : null; };
  const lines = me.players.filter((p) => p.min > 0).map((p) => {
    const s = seasonOf.get(p.id), ts = tsOf(p), fga = p.fga2 + p.fga3;
    const out = { p, s, ts, notes: [] };
    if (s && s.gp >= 3) {
      const dPir = p.pir - s.pirpg, dPts = p.pts - s.ppg;
      if (p.min >= 8 && (dPir >= Math.max(6, 0.6 * Math.abs(s.pirpg)) || dPts >= 8)) ups.push([dPir + dPts / 2, `<strong>${esc(p.name)}</strong>: ${p.pts} pts${fga ? ` on ${p.fgm2 + p.fgm3}/${fga}` : ''}${ts != null && fga >= 5 ? ` (TS ${ts.toFixed(0)}%)` : ''}, ${p.reb} reb, ${p.ast} ast, PIR ${p.pir} — <span class="pos">${sgn(dPir)} PIR, ${sgn(dPts)} pts vs his average</span>.`]);
      if (p.min >= 10 && s.pirpg >= 4 && dPir <= -Math.max(6, 0.6 * s.pirpg)) downs.push([-dPir, `<strong>${esc(p.name)}</strong>: PIR ${p.pir} in ${Math.round(p.min)} min — <span class="neg">${sgn(dPir)} vs his average ${s.pirpg.toFixed(1)}</span>${fga ? ` (${p.fgm2 + p.fgm3}/${fga} FG)` : ''}.`]);
    }
    if (fga >= 7 && ts != null && ts < 42) downs.push([8, `<strong>${esc(p.name)}</strong>: inefficient shooting — ${p.fgm2 + p.fgm3}/${fga} FG, ${p.fgm3}/${p.fga3} 3P (TS ${ts.toFixed(0)}%).`]);
    if (p.tov >= 4) downs.push([p.tov + 2, `<strong>${esc(p.name)}</strong>: ${p.tov} turnovers.`]);
    if (p.pf >= 4 && p.min < 22) downs.push([5, `<strong>${esc(p.name)}</strong>: foul trouble — ${p.pf} fouls in ${Math.round(p.min)} min.`]);
    if (p.min >= 10 && p.pm <= -12) downs.push([-p.pm / 2, `<strong>${esc(p.name)}</strong>: ${p.pm} while on the court.`]);
    if (p.min >= 10 && p.pm >= 12) ups.push([p.pm / 2, `<strong>${esc(p.name)}</strong>: +${p.pm} while on the court.`]);
    if (fga >= 6 && ts != null && ts >= 70) ups.push([7, `<strong>${esc(p.name)}</strong>: efficient — ${p.pts} pts on ${fga} shots (TS ${ts.toFixed(0)}%).`]);
    return out;
  });
  // team: this game against Hapoel's season (z-score) and against the opponent
  const TK = [['Points per possession', 'ppp', 1, 2], ['Effective FG%', 'efg', 1, 1], ['3-pointers made', 'fg3m', 1, 0], ['3P%', 'p3', 1, 1], ['2P%', 'p2', 1, 1], ['Free-throw attempts', 'fta', 1, 0], ['Offensive rebound %', 'orebPct', 1, 1], ['Defensive rebound %', 'drebPct', 1, 1], ['Assists', 'ast', 1, 0], ['Turnovers', 'tov', -1, 0], ['Steals', 'stl', 1, 0], ['Opponent points per possession', 'oppp', -1, 2], ['Opponent eFG%', 'oefg', -1, 1], ['Opponent 3-pointers made', 'o3m', -1, 0], ['Opponent free-throw attempts', 'oFta', -1, 0], ['Forced turnovers', 'oTov', 1, 0]];
  for (const [label, k, good, dp] of TK) {
    const a = S.avg((x) => x.m[k]); if (!a || a.n < 3 || !a.sd) continue;
    const z = (M[k] - a.m) / a.sd;
    if (Math.abs(z) < 1) continue;
    const txt = `<strong>${label}</strong>: ${M[k].toFixed(dp)} — season average ${a.m.toFixed(dp)}.`;
    (good * z > 0 ? ups : downs).push([Math.abs(z) * 5, txt]);
  }
  const gaps = [['Rebounds', M.oreb + M.dreb, M.oReb, 8], ['Turnovers', M.tov, M.oTov, 5, true], ['Free-throw attempts', M.fta, M.oFta, 8], ['3-pointers made', M.fg3m, M.o3m, 4]];
  if (sc.offTO != null) gaps.push(['Points off turnovers', sc.offTO, sco.offTO, 8], ['Second-chance points', sc.second, sco.second, 8]);
  if (sc.fb != null) gaps.push(['Fast-break points', sc.fb, sco.fb, 6]);
  if (sc.paint != null) gaps.push(['Points in the paint', sc.paint, sco.paint, 10]);
  for (const [label, a, b, lim, low] of gaps) { const d = low ? b - a : a - b; if (Math.abs(d) < lim) continue; (d > 0 ? ups : downs).push([Math.abs(d) / lim * 6, `<strong>${label}</strong>: Hapoel ${a} – ${b} ${esc(op.tv)}.`]); }
  const li = (arr) => { const seen = new Set(); return arr.sort((a, b) => b[0] - a[0]).filter(([, t]) => { const k = t.match(/<strong>([^<]*)<\/strong>: (?!\d)/)?.[1] + '|' + /season average/.test(t); const lab = t.match(/^<strong>([^<]*)<\/strong>/)?.[1]; if (!/vs his|while on|turnovers\.|foul trouble|inefficient|efficient/.test(t) && seen.has(lab)) return false; seen.add(lab); return true; }).slice(0, 9).map(([, t]) => `<li>${t}</li>`).join('') || '<li class="muted">Nothing stood out.</li>'; };
  // player lines against their averages
  const plTable = `<table class="rtab"><thead><tr><th>Player</th><th class="num">MIN</th><th class="num">PTS</th><th class="num">FG</th><th class="num">3P</th><th class="num">FT</th><th class="num">REB</th><th class="num">AST</th><th class="num">TOV</th><th class="num">PF</th><th class="num">+/-</th><th class="num">PIR</th><th class="num muted">avg PIR</th><th class="num">vs avg</th></tr></thead><tbody>
${lines.sort((a, b) => b.p.min - a.p.min).map(({ p, s }) => { const d = s ? p.pir - s.pirpg : null; return `<tr><td>${p.starter ? '● ' : ''}${esc(p.name)}</td><td class="num">${Math.round(p.min)}</td><td class="num"><strong>${p.pts}</strong></td><td class="num">${p.fgm2 + p.fgm3}/${p.fga2 + p.fga3}</td><td class="num">${p.fgm3}/${p.fga3}</td><td class="num">${p.ftm}/${p.fta}</td><td class="num">${p.reb}</td><td class="num">${p.ast}</td><td class="num">${p.tov}</td><td class="num">${p.pf}</td><td class="num ${p.pm > 0 ? 'pos' : p.pm < 0 ? 'neg' : ''}">${p.pm > 0 ? '+' : ''}${p.pm}</td><td class="num"><strong>${p.pir}</strong></td><td class="num muted">${s ? s.pirpg.toFixed(1) : '–'}</td><td class="num ${d == null ? '' : d >= 3 ? 'pos' : d <= -3 ? 'neg' : ''}">${d == null ? '–' : sgn(d)}</td></tr>`; }).join('')}
</tbody></table>`;
  let n = 0; const sec = (t) => `<h2>${++n}. ${t}</h2>`;
  const body = `<p class="no-print r-actions"><button type="button" class="btn" id="print-btn">Print / save as PDF</button> <a class="btn ghost" href="${gameHref(g.gameCode)}">← Game page</a></p>
<article class="report">
<header class="r-head"><div class="r-id">${crests.has(op.code) ? `<img src="${esc(crests.get(op.code))}" alt="" width="64" height="64">` : ''}<div><div class="r-kicker">HTA LAB · Hapoel game report · ${esc(cfg.shortName || cfg.leagueName || 'EuroLeague')}</div><h1>Hapoel ${me.score}–${op.score} ${esc(opT)}</h1>
<div class="r-meta">${esc(fmtDate(g.date))} · ${side === 'H' ? 'Home' : 'Away'}${g.round ? ` · Round ${g.round}` : ''} · <span class="${won ? 'pos' : 'neg'}"><strong>${won ? 'Win' : 'Loss'}</strong></span> · Quarters ${(me.quarters || []).join('-')} / ${(op.quarters || []).join('-')}</div></div></div>
<div class="r-date">Generated ${esc(fmtDate(new Date().toISOString().slice(0, 10)))}</div></header>
<section class="r-sec">${sec('Ups and downs')}<div class="r-two"><div><h3 class="pos">What went well</h3><ul class="ud">${li(ups)}</ul></div><div><h3 class="neg">What went wrong</h3><ul class="ud">${li(downs)}</ul></div></div>
<p class="muted small">Players compared with their own average this season, the team with Hapoel's average and spread this season (${S.list.length} games), and with ${esc(op.tv)} in this game.</p></section>
<section class="r-sec">${sec('How the points came')}${scoreTable}</section>
<section class="r-sec">${sec('Quarter by quarter')}${quarters || '<p class="muted">No play-by-play for this game.</p>'}</section>
<section class="r-sec">${sec('Lineups')}${lineups}</section>
<section class="r-sec">${sec('Hapoel players')}${plTable}<p class="muted small">● = starter. "vs avg" = PIR in this game minus his average PIR this season.</p></section>
<footer class="r-foot">HTA LAB · Official box score and play-by-play (${esc(cfg.leagueName || 'EuroLeague')}), checked before publishing · hta-lab.github.io</footer>
</article>`;
  writePage(hapReportHref(g.gameCode), `Hapoel game report — ${me.tv} ${me.score}–${op.score} ${op.tv}`, body, HOME, '', { scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script>` });
}
const WP_HCA = Math.max(0, Math.min(5, games.reduce((a, g) => a + g.home.score - g.away.score, 0) / Math.max(1, games.length)));
const sortedGames = [...games].sort((a, b) => a.date.localeCompare(b.date) || a.gameCode - b.gameCode);
for (const g of sortedGames) {
  const H = g.home, A = g.away, raw = rawPbp.get(g.gameCode);
  const log = raw ? playLog(g, raw) : null;
  const flow = log ? flowStats(log.plays) : null;
  const periods = log ? Math.max(4, ...log.plays.map((p) => p[0])) : 4;
  const near = pbpNear.get(g.gameCode);
  const stints = stintsOf.get(g.gameCode) || near?.stints;
  const hWin = H.score > A.score;
  const qs = (s) => { const q = s.quarters || []; const ot = q.length ? s.score - q.reduce((x, y) => x + y, 0) : 0; return [...q, ...(periods > 4 || ot ? [ot] : [])]; };
  const qH = qs(H), qA = qs(A);
  const mvp = gameMvp(g);
  const gShots = ALLSHOTS.filter((x) => x.g === g.gameCode && x.made && x.fb);
  const fastBreak = ALLSHOTS.some((x) => x.g === g.gameCode) ? { H: gShots.filter((x) => x.team === H.code).reduce((acc, x) => acc + (x.is3 ? 3 : 2), 0), A: gShots.filter((x) => x.team === A.code).reduce((acc, x) => acc + (x.is3 ? 3 : 2), 0) } : null;
  const cmp = compareRows(g, { detail: log ? flowDetail(log.plays) : null, flow, fastBreak });
  const best = (side, k) => side.players.filter((p) => p.min > 0).sort((x, y) => y[k] - x[k] || y.pir - x.pir)[0];
  const perf = [['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['pir', 'PIR']].map(([k, l]) => {
    const x = best(H, k), y = best(A, k);
    const cell = (p) => p ? `<a href="${playerHref(p.id)}">${esc(p.name)}</a><strong>${p[k]}</strong>` : '';
    return `<div class="perf"><span class="ph">${cell(x)}</span><span class="lab">${l}</span><span class="pa">${cell(y)}</span></div>`;
  }).join('');
  const conn = log ? connections(log.plays) : [];
  const connList = (side) => { const l = conn.filter((c) => c.side === side).slice(0, 6); return l.length ? `<ol class="conn">${l.map((c) => `<li><span>${esc(nameOf.get(c.from) || log.names[c.from] || c.from)} <span class="muted">→</span> ${esc(nameOf.get(c.to) || log.names[c.to] || c.to)}</span><strong>${c.pts} pts</strong><span class="muted small">${c.n} assist${c.n > 1 ? 's' : ''}</span></li>`).join('')}</ol>` : '<p class="muted">No assisted baskets recorded.</p>'; };
  const pbpJson = log ? JSON.stringify({
    H: H.tv, A: A.tv, hName: titleCase(H.name), aName: titleCase(A.name),
    names: Object.fromEntries([...H.players, ...A.players].map((p) => [p.id, p.name])),
    plays: log.plays.map((p) => p.slice(0, 7)), labels: PLAY_LABEL, groups: PLAY_GROUP
  }).replace(/</g, '\\u003c') : null;
  // Quarter box score + playing time (games whose play-by-play matches the box score)
  const pst = periodStintsOf.get(g.gameCode);
  let qbJson = null;
  if (pst && log) {
    const QK = ['secs', 'pm', 'pts', 'fgm2', 'fga2', 'fgm3', 'fga3', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'tov', 'blk', 'blka', 'fl', 'fd'];
    const QX = Object.fromEntries(QK.map((k, i) => [k, i]));
    const EVQ = { '2FGM': [['pts', 2], ['fgm2', 1], ['fga2', 1]], '2FGA': [['fga2', 1]], '3FGM': [['pts', 3], ['fgm3', 1], ['fga3', 1]], '3FGA': [['fga3', 1]], FTM: [['pts', 1], ['ftm', 1], ['fta', 1]], FTA: [['fta', 1]], O: [['oreb', 1]], D: [['dreb', 1]], AS: [['ast', 1]], ST: [['stl', 1]], TO: [['tov', 1]], FV: [['blk', 1]], AG: [['blka', 1]], RV: [['fd', 1]], OF: [['fl', 1]] };
    const nP = Math.max(4, ...pst.map((x) => x.period));
    const box = {}, team = { H: {}, A: {} }, iv = {};
    const cellQ = (o, id, q) => { o[id] ||= {}; return (o[id][q] ||= QK.map(() => 0)); };
    let t0 = 0;
    for (const x of pst) {
      for (const [ids, me, op, side] of [[x.home, H.code, A.code, 'H'], [x.away, A.code, H.code, 'A']]) {
        for (const id of ids) {
          const c = cellQ(box, id, x.period); c[QX.secs] += x.secs; c[QX.pm] += x.pts[me] - x.pts[op];
          const list = (iv[id] ||= []); const last = list[list.length - 1];
          if (x.secs > 0) { if (last && Math.abs(last[1] - t0) < 0.5) last[1] = t0 + x.secs; else list.push([t0, t0 + x.secs]); }
        }
        const tc = cellQ(team, side, x.period); tc[QX.secs] += x.secs; tc[QX.pm] += x.pts[me] - x.pts[op];
      }
      t0 += x.secs;
    }
    for (const [per, , side, pid, type] of log.plays) {
      const ev = EVQ[type] || (/^CM/.test(type) ? [['fl', 1]] : null); if (!ev || !side) continue;
      const tc = cellQ(team, side, per); for (const [k, v] of ev) tc[QX[k]] += v;
      if (pid) { const c = cellQ(box, pid, per); for (const [k, v] of ev) c[QX[k]] += v; }
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    // Reliability check: each player's quarters must add up to his official box-score line.
    const CHK = [['pts', 'pts'], ['fgm2', 'fgm2'], ['fga2', 'fga2'], ['fgm3', 'fgm3'], ['fga3', 'fga3'], ['ftm', 'ftm'], ['fta', 'fta'], ['oreb', 'oreb'], ['dreb', 'dreb'], ['ast', 'ast'], ['stl', 'stl'], ['tov', 'tov'], ['blk', 'blk'], ['pf', 'fl']];
    let statsOk = true, timeOk = true, tdiff = 0;
    for (const p of [...H.players, ...A.players]) {
      const tot = QK.map(() => 0); for (const c of Object.values(box[p.id] || {})) c.forEach((v, i) => { tot[i] += v; });
      for (const [bk, qk] of CHK) if ((p[bk] || 0) !== tot[QX[qk]]) { statsOk = false; QB_CHECK.why[bk] = (QB_CHECK.why[bk] || 0) + 1; }
      tdiff = Math.max(tdiff, Math.abs(p.min * 60 - tot[QX.secs]));
      if (Math.abs(p.min * 60 - tot[QX.secs]) > 30) { timeOk = false; QB_CHECK.why.secs = (QB_CHECK.why.secs || 0) + 1; if (!QB_CHECK.ex) QB_CHECK.ex = `${g.gameCode} ${p.name} ${p.min * 60} vs ${tot[QX.secs]}`; }
      if ((p.pm || 0) !== tot[QX.pm]) { timeOk = false; QB_CHECK.why.pm = (QB_CHECK.why.pm || 0) + 1; }
    }
    QB_CHECK.games++; if (statsOk) QB_CHECK.stats++; if (timeOk) QB_CHECK.time++;
    if (timeOk) qbJson = JSON.stringify({ ok: statsOk, tdiff: Math.round(tdiff), k: QK, periods: nP, total: r1(t0), H: [H.tv, titleCase(H.name)], A: [A.tv, titleCase(A.name)],
      players: [...H.players.map((p) => [p.id, p.name, 'H', p.starter ? 1 : 0, playerHref(p.id)]), ...A.players.map((p) => [p.id, p.name, 'A', p.starter ? 1 : 0, playerHref(p.id)])].filter(([id]) => box[id] || iv[id]),
      box, team, iv: Object.fromEntries(Object.entries(iv).map(([id, l]) => [id, l.map(([a, b]) => [r1(a), r1(b)])])) }).replace(/</g, '\\u003c');
  }
  const hero = `<section class="cover game-cover"><div class="wrap gc-wrap">
<div class="crumbs"><a href="${HOME}#games">Games</a> / ${g.round ? `Round ${g.round}` : esc(g.phase || '')}</div>
<span class="kicker">${g.round ? `Round ${g.round} · ` : ''}${esc(fmtDate(g.date))}</span>
<div class="scoreboard">
<a class="sb-team" href="${teamHref(H.code)}">${crests.has(H.code) ? `<span class="sb-crest"><img src="${esc(crests.get(H.code))}" alt=""></span>` : ''}<span class="sb-name">${esc(titleCase(H.name))}</span><span class="muted-w">Home</span></a>
<div class="sb-score"><span class="${hWin ? 'win' : ''}">${H.score}</span><span class="dash">–</span><span class="${hWin ? '' : 'win'}">${A.score}</span><small>Final${periods > 4 ? ` · ${periods > 5 ? (periods - 4) + ' OT' : 'OT'}` : ''}</small></div>
<a class="sb-team" href="${teamHref(A.code)}">${crests.has(A.code) ? `<span class="sb-crest"><img src="${esc(crests.get(A.code))}" alt=""></span>` : ''}<span class="sb-name">${esc(titleCase(A.name))}</span><span class="muted-w">Away</span></a>
</div>
${qH.length ? `<table class="qtable"><thead><tr><th scope="col"></th>${qH.map((_, i) => `<th scope="col">${i < 4 ? 'Q' + (i + 1) : 'OT'}</th>`).join('')}<th scope="col">Final</th></tr></thead><tbody>
<tr><th scope="row">${esc(H.tv)}</th>${qH.map((v, i) => `<td class="${v > (qA[i] ?? 0) ? 'w' : ''}">${v}</td>`).join('')}<td class="w">${H.score}</td></tr>
<tr><th scope="row">${esc(A.tv)}</th>${qA.map((v, i) => `<td class="${v > (qH[i] ?? 0) ? 'w' : ''}">${v}</td>`).join('')}<td class="w">${A.score}</td></tr></tbody></table>` : ''}
${g.refs?.length ? `<p class="gc-refs"><a href="referees.html">Referees</a>: ${g.refs.map((r) => esc(/[A-Za-z]/.test(r) ? formatName(r) : r)).join(' · ')}</p>` : ''}
${isHapGame(g) ? `<p class="gc-actions"><a class="btn white" href="${hapReportHref(g.gameCode)}">Hapoel game report →</a></p>` : ''}
</div></section>`;
  writePage(gameHref(g.gameCode), `${H.tv} ${H.score}–${A.score} ${A.tv}`, `
<div class="tiles">
${mvp ? `<a class="tile mvp-tile" href="${playerHref(mvp.p.id)}"><span class="label">Game MVP</span><span class="big">${mvp.p.pir}</span><span class="sub">PIR · ${mvp.p.pts} pts, ${mvp.p.reb} reb, ${mvp.p.ast} ast</span><span class="chip hot">${esc(mvp.p.name)} · ${esc(mvp.s.tv)}</span></a>` : ''}
${flow ? `<div class="tile"><span class="label">Lead changes</span><span class="big">${flow.leadChanges}</span><span class="sub">and ${flow.ties} tie${flow.ties === 1 ? '' : 's'}</span></div>
<div class="tile"><span class="label">Biggest lead</span><span class="big">${Math.max(flow.maxLead.H, flow.maxLead.A)}</span><span class="sub">${esc(H.tv)} +${flow.maxLead.H} · ${esc(A.tv)} +${flow.maxLead.A}</span></div>
<div class="tile"><span class="label">Biggest run</span><span class="big">${Math.max(flow.bestRun.H, flow.bestRun.A)}–0</span><span class="sub">${esc(H.tv)} ${flow.bestRun.H}–0 · ${esc(A.tv)} ${flow.bestRun.A}–0</span></div>` : `<div class="tile"><span class="label">Possessions</span><span class="big">${f1(cmp.P)}</span><span class="sub">per team</span></div>`}
</div>
${log && flow ? (() => { const W = winProb(log.plays, { hca: WP_HCA, sigma: 12 }); const nm = (id) => nameOf.get(id) || log.names[id] || ''; const lbl = { '3FGM': 'three', '2FGM': 'two', FTM: 'free throw' };
  return `<section class="card"><h2>Win probability</h2><p class="muted">${esc(H.tv)}'s chance to win after every basket, from the score and the time left (home court counted). The numbered dots are the 5 baskets that swung it most.</p>${winProbSvg(W.line, W.end, { home: esc(H.tv), away: esc(A.tv), marks: W.swings.map((x) => ({ t: x.row[7], v: x.after })) })}
<ol class="wp-swings">${W.swings.map((x) => `<li><strong>Q${x.row[0] > 4 ? 'OT' : x.row[0]} ${esc(x.row[1])}</strong> — ${esc(nm(x.row[3]))} ${lbl[x.row[4]] || ''} (${esc(x.row[2] === 'H' ? H.tv : A.tv)}), ${x.row[5]}–${x.row[6]}: ${esc(H.tv)} ${Math.round(100 * x.before)}% → <strong>${Math.round(100 * x.after)}%</strong></li>`).join('')}</ol></section>`; })() : ''}
${flow ? `<section class="card"><h2>Game flow</h2><p class="muted">The score margin after every basket. Red: ${esc(H.tv)} ahead. Dark: ${esc(A.tv)} ahead.</p>${flowSvg(flow.line, periods, H.tv, A.tv)}</section>` : ''}
<div class="row">
<section class="card"><h2>Top performers</h2><div class="perf-head"><span>${badge(H.code, H.tv)} ${esc(H.tv)}</span><span></span><span>${esc(A.tv)} ${badge(A.code, A.tv)}</span></div>${perf}</section>
<section class="card"><h2>Team comparison</h2><div class="perf-head"><span>${badge(H.code, H.tv)} ${esc(H.tv)}</span><span>${f1(cmp.P)} possessions</span><span>${esc(A.tv)} ${badge(A.code, A.tv)}</span></div>${cmp.html}</section>
</div>
<section class="card"><h2>Box score</h2>${pmRepaired.has(g.gameCode) ? `<p class="note-warn">The league's published +/- for this game is wrong (${pmRepaired.get(g.gameCode)} players). The +/- shown here is recalculated from the official play-by-play, which reproduces the final score and every player's minutes.</p>` : ''}${sideHead(H)}${gameBox(H)}${sideHead(A)}${gameBox(A)}<p class="muted small">Click any column to sort. PIR = Performance Index Rating.</p></section>
${(() => { const gs = ALLSHOTS.filter((x) => x.g === g.gameCode); if (!gs.length) return ''; const side = (S) => { const l = gs.filter((x) => x.team === S.code); const m = l.filter((x) => x.made).length; return `<figure><figcaption><strong>${esc(titleCase(S.name))}</strong> <span class="muted small">${m}/${l.length} FG</span></figcaption>${courtSvg(l, { mode: 'dots', title: S.name + ' shots' })}</figure>`; }; return `<section class="card" id="game-shots"><h2>Shot chart</h2><p class="muted">Every field-goal attempt of the game. ${qbJson ? 'The quarter buttons in the quarter box score below also filter these shots.' : ''}</p><div class="shot-two">${side(H)}${side(A)}</div><p class="small muted"><span class="lg-m"></span> made <span class="lg-x"></span> missed</p></section>`; })()}
${qbJson ? `<section class="card" id="quarters"><h2>Quarter box score &amp; playing time</h2><p class="muted">Pick one or more quarters: every player's line in just those quarters, from the official play-by-play. Below, when each player was on the court.</p><div id="qb-app"><p class="muted">Loading…</p></div></section>
<script type="application/json" id="qb-data">${qbJson}</script>` : ''}
${stints ? lineupBlock(g, stints, near ? `Small difference with the official box score in this game (${esc(near.why)}). These lineups are shown for this game only and are not used in the season lineup, on/off or impact numbers.` : '') : raw ? '<p class="muted small">Lineups are not available for this game: the official play-by-play does not say who was on the court at every moment.</p>' : ''}
${log ? `<section class="card"><h2>Best connections</h2><p class="muted">Who assisted whom, by points created.</p><div class="row two">${['H', 'A'].map((s) => `<div>${sideHead(s === 'H' ? H : A)}${connList(s)}</div>`).join('')}</div></section>
<section class="card"><h2>Play-by-play</h2><div id="pbp-app"><p class="muted">Loading…</p></div></section>
<script type="application/json" id="pbp-data">${pbpJson}</script>` : ''}`, HOME, hero, { scripts: `<script src="game.js?v=${assetVersion()}" defer></script>${qbJson ? `<script src="gamequarters.js?v=${assetVersion()}" defer></script>` : ''}` });
  if (isHapGame(g)) hapoelGameReport(g, { log, stints, qbJson });
}
console.log(`✓ Game pages: ${sortedGames.length}`);
// ---- Home: MVP race (several factors) and MVP of each round ----
const MVP_F = [
  ['pirpg', 'PIR', 0.30, (p) => p.pirpg, f1],
  ['imp', 'Impact', 0.20, (p) => IMPACT?.values.get(p.id) ?? null, signed],
  ['win', 'Team win %', 0.15, (p) => { const t = teams.find((x) => x.code === p.team); return t && t.gp ? 100 * t.w / t.gp : null; }, (v) => f1(v)],
  ['ppg', 'Points', 0.15, (p) => p.ppg, f1],
  ['ts', 'TS%', 0.10, (p) => p.ts, f1],
  ['swing', 'On/off', 0.10, (p) => onOffOf(p.id)?.swing ?? null, signed]
];
const mvpRows = (() => {
  const vals = MVP_F.map(([, , , get]) => qual.map(get));
  const stat = vals.map((arr) => { const v = arr.filter((x) => x != null && Number.isFinite(x)); const m = v.reduce((s, x) => s + x, 0) / (v.length || 1); const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1; return { m, sd }; });
  return qual.map((p, i) => {
    const f = MVP_F.map((F, j) => { const v = vals[j][i]; return { v, z: v == null || !Number.isFinite(v) ? 0 : (v - stat[j].m) / stat[j].sd }; });
    return { p, f, score: f.reduce((s, x, j) => s + x.z * MVP_F[j][2], 0) };
  }).sort((a, b) => b.score - a.score);
})();
const roundMvps = (() => {
  const by = new Map();
  for (const g of games) { if (!g.round) continue; if (!by.has(g.round)) by.set(g.round, []); by.get(g.round).push(g); }
  return [...by].sort((a, b) => b[0] - a[0]).map(([r, gs]) => {
    const best = gs.map((g) => ({ g, ...gameMvp(g) })).filter((x) => x.p).sort((x, y) => y.p.pir - x.p.pir || y.p.pts - x.p.pts)[0];
    return { r, ...best };
  }).filter((x) => x.p);
})();
const mvpCount = new Map();
for (const x of roundMvps) mvpCount.set(x.p.id, (mvpCount.get(x.p.id) || 0) + 1);
const mvpTop = mvpRows.slice(0, 10), mvpMax = Math.max(0.01, mvpTop[0]?.score || 0);
const mvpSection = mvpTop.length ? `<section class="card mvp-race"><h2>MVP race</h2>
<p class="muted">HTA LAB MVP index: each factor is compared with every qualified player (z-score) and weighted — PIR 30%, impact rating (RAPM) 20%, team win % 15%, points 15%, true shooting 10%, on/off 10%.</p>
<div id="mvp-app"><div class="scroll"><table class="mvp"><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col" class="num">Index</th>${MVP_F.map(([, l, w]) => `<th scope="col" class="num">${l} <small class="muted">${Math.round(w * 100)}%</small></th>`).join('')}<th scope="col" class="num" title="Times MVP of a round">Rd MVP</th></tr></thead><tbody>
${mvpTop.map((x, i) => `<tr${i < 3 ? ` class="rk-row-${i + 1}"` : ''}><td class="num"><span class="mvp-rank r${i + 1}">${i + 1}</span></td><td><a href="${playerHref(x.p.id)}">${esc(x.p.name)}</a> <span class="muted">${badge(x.p.team, x.p.tv)}${esc(x.p.tv)}</span><div class="bar"><span style="width:${Math.max(4, 100 * x.score / mvpMax).toFixed(1)}%"></span></div></td><td class="num"><strong>${x.score.toFixed(2)}</strong></td>${x.f.map((f, j) => `<td class="num ${f.z >= 1 ? 'hi' : f.z <= -0.5 ? 'lo' : ''}">${f.v == null ? '–' : MVP_F[j][4](f.v)}</td>`).join('')}<td class="num">${mvpCount.get(x.p.id) || ''}</td></tr>`).join('')}
</tbody></table></div></div><p class="muted small">${qualNote} Green = well above average for that factor. Impact and on/off come from the play-by-play and are still noisy this early in the season.</p>
<script type="application/json" id="mvp-data">${JSON.stringify({
  factors: MVP_F.map(([k, l, w]) => [k, l, Math.round(w * 100), k === 'imp' || k === 'swing' ? 's' : '']),
  players: mvpRows.map((x) => [x.p.name, x.p.tv, crests.get(x.p.team) || null, playerHref(x.p.id), x.f.map((f) => (f.v == null || !Number.isFinite(f.v) ? null : +f.v.toFixed(2))), mvpCount.get(x.p.id) || 0])
}).replace(/</g, '\\u003c')}</script></section>` : '';
const roundMvpSection = roundMvps.length ? `<section class="card"><h2>MVP of each round</h2><p class="muted">Highest PIR of the round among players on the winning team.</p>
<div class="scroll"><table><thead><tr><th scope="col">Rd</th><th scope="col">Player</th><th scope="col" class="num">PTS</th><th scope="col" class="num">REB</th><th scope="col" class="num">AST</th><th scope="col" class="num">PIR</th><th scope="col">Game</th></tr></thead><tbody>
${roundMvps.map((x) => `<tr><td class="num">${x.r}</td><td><a href="${playerHref(x.p.id)}">${esc(x.p.name)}</a> <span class="muted">${badge(x.s.code, x.s.tv)}${esc(x.s.tv)}</span></td><td class="num">${x.p.pts}</td><td class="num">${x.p.reb}</td><td class="num">${x.p.ast}</td><td class="num"><strong>${x.p.pir}</strong></td><td><a href="${gameHref(x.g.gameCode)}">${esc(x.g.home.tv)} ${x.g.home.score}–${x.g.away.score} ${esc(x.g.away.tv)}</a></td></tr>`).join('')}
</tbody></table></div></section>` : '';
// ---- Home: every game of the season ----
const playedCodes = new Set(games.map((g) => Number(g.gameCode)));
const upcoming = schedule.filter((x) => !playedCodes.has(Number(x.c)) && x.h?.code && x.a?.code).sort((a, b) => String(a.utc).localeCompare(String(b.utc)) || a.c - b.c);
const roundsList = [...new Set([...games.map((g) => g.round), ...upcoming.map((x) => x.r)].filter(Boolean))].sort((a, b) => a - b);
const currentRound = upcoming.length ? upcoming[0].r : roundsList[roundsList.length - 1];
const timeTag = (x) => `<time data-utc="${esc(x.utc || '')}" datetime="${esc(x.utc || '')}">${esc(x.utc ? x.utc.slice(0, 16).replace('T', ' ') + ' UTC' : 'Date to be confirmed')}</time>`;
const upcomingCard = (x) => {
  const line = (s) => `<span class="gl">${crests.has(s.code) ? `<img src="${esc(crests.get(s.code))}" alt="" width="22" height="22">` : '<i></i>'}<span class="gn">${esc(titleCase(s.name || s.code))}</span><b></b></span>`;
  return `<a class="gcard upcoming" href="${IS_EL ? `live.html?game=${Number(x.c)}` : `#games`}" data-r="${x.r || 0}" data-t="${esc(x.h.code)} ${esc(x.a.code)}"><span class="gd">Rd ${x.r} · ${timeTag(x)}</span>${line(x.h)}${line(x.a)}<span class="gm">${x.venue ? esc(titleCase(x.venue)) : ''}${x.ok ? '' : ' · time to be confirmed'}</span></a>`;
};

const gameCard = (g) => {
  const hw = g.home.score > g.away.score, m = gameMvp(g);
  const line = (s, w) => `<span class="gl ${w ? 'w' : ''}">${crests.has(s.code) ? `<img src="${esc(crests.get(s.code))}" alt="" width="22" height="22">` : '<i></i>'}<span class="gn">${esc(titleCase(s.name))}</span><b>${s.score}</b></span>`;
  return `<a class="gcard" href="${gameHref(g.gameCode)}" data-r="${g.round || 0}" data-t="${esc(g.home.code)} ${esc(g.away.code)}"><span class="gd">${g.round ? `Rd ${g.round} · ` : ''}${esc(fmtDate(g.date))}</span>${line(g.home, hw)}${line(g.away, !hw)}${m ? `<span class="gm">MVP ${esc(m.p.name)} · ${m.p.pir} PIR</span>` : ''}</a>`;
};
const gamesSection = `<section class="card" id="games"><h2>All games</h2><p class="muted">Every game of the season, played and still to come (times in your time zone). Click a played game for the full picture${IS_EL ? '; click an upcoming game to follow it live' : ''}.</p>
<div class="filters" id="games-filter"><label>Team <select data-g="team"><option value="">All teams</option>${teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.code)}">${esc(titleCase(t.name))}</option>`).join('')}</select></label>
<label>Round <select data-g="round"><option value="">All rounds</option>${roundsList.map((r) => `<option value="${r}"${r === currentRound ? ' selected' : ''}>Round ${r}</option>`).join('')}</select></label>
<span class="muted small" data-g="count"></span></div>
<div class="gcards">${upcoming.map(upcomingCard).join('')}${[...sortedGames].reverse().map(gameCard).join('')}</div></section>`;

const standingsRows = teams.map((t) => `<tr>
<td class="num muted">${t.rank}</td>
<td class="team"><a href="team-${esc(String(t.code).replace(/[^A-Za-z0-9]/g, ''))}.html">${badge(t.code, t.tv)} ${esc(titleCase(t.name))}</a></td>
<td class="num">${t.w}–${t.l}</td>
<td class="num">${f1(t.ortg)}</td>
<td class="num">${f1(t.drtg)}</td>
<td class="num ${t.net >= 0 ? 'pos' : 'neg'}">${signed(t.net)}</td>
</tr>`).join('');

const teamChart = scatter(teams.map((t) => ({
  x: t.ortg, y: t.drtg, label: t.tv, img: crests.get(t.code),
  title: `${titleCase(t.name)}: ${t.w}–${t.l}, offensive rating ${f1(t.ortg)}, defensive rating ${f1(t.drtg)}, net ${signed(t.net)}`
})), { xLabel: 'Points scored per 100 possessions', yLabel: 'Points allowed per 100', invertY: true, big: true, avgX: avg(teams, 'ortg'), avgY: avg(teams, 'drtg'), cornerGood: 'Good at both ends', cornerBad: 'Struggling at both ends' });

const moreBtn = (n) => (n > 10 ? `<button type="button" class="btn-ghost board-more" data-n="${n}" aria-expanded="false">Show all ${n} players</button>` : '');
// Every home leaderboard is registered here so the browser can re-rank it with filters.
const BOARD_REG = [];
const regBoard = (def) => { const id = 'b' + BOARD_REG.length; BOARD_REG.push({ id, ...def }); return id; };
// Per-40 and defensive boards
const RATES = playerRates(games);
const defOf = (id) => {
  const o = PBP?.onoff.get(id);
  if (!o || o.on.poss < 300) return null;
  const off = { poss: o.teamTot.poss - o.on.poss, pa: o.teamTot.pa - o.on.pa };
  const on = 100 * o.on.pa / o.on.poss;
  return { onDrtg: on, defSwing: off.poss >= 50 ? 100 * off.pa / off.poss - on : null };
};
function rateBoard(title, sub, val, { fmt = f1, asc = false, pool = qual } = {}) {
  const bid = regBoard({ val, fmt: fmt === signed ? 's' : '1', asc, all: pool !== qual });
  const list = pool.map((p) => ({ p, v: val(p) })).filter((x) => x.v != null && Number.isFinite(x.v))
    .sort((a, b) => (asc ? a.v - b.v : b.v - a.v) || a.p.name.localeCompare(b.p.name));
  if (!list.length) return '';
  const vals = list.map((x) => x.v), hi = Math.max(...vals), lo = Math.min(...vals);
  const width = (v) => (asc ? (hi === lo ? 100 : 5 + 95 * (hi - v) / (hi - lo)) : 100 * v / (hi || 1));
  return `<section class="card board" data-board="${bid}"><h2>${title}</h2><p class="muted">${sub}</p><ol>
${list.map(({ p, v }, i) => `<li${i >= 10 ? ' class="more"' : ''}><span class="muted num">${i + 1}</span><div><a href="${playerHref(p.id)}">${esc(p.name)}</a> <span class="muted">${esc(p.tv)}</span><div class="bar"><span style="width:${Math.max(3, width(v)).toFixed(1)}%"></span></div></div><strong class="num">${fmt(v)}</strong></li>`).join('')}
</ol>${moreBtn(list.length)}</section>`;
}
const R = (k) => (p) => RATES.get(p.id)?.[k] ?? null;
const per40Section = `<h2 class="sec-title" id="per40">Per 40 minutes</h2>
<p class="muted sec-sub">What each player produces for every 40 minutes on the court, so bench players and starters can be compared. ${qualNote}</p>
<div class="row">${rateBoard('PIR per 40', 'Performance Index Rating per 40 minutes', R('pir40'))}${rateBoard('Points per 40', 'Points per 40 minutes', R('pts40'))}</div>
<div class="row">${rateBoard('Rebounds per 40', 'Rebounds per 40 minutes', R('reb40'))}${rateBoard('Assists per 40', 'Assists per 40 minutes', R('ast40'))}</div>`;
const defenseSection = `<h2 class="sec-title" id="defense">Defense</h2>
<p class="muted sec-sub">Advanced defensive stats. Steal, block and defensive rebound % estimate how many of the chances available while the player was on the court he converted.</p>
<div class="row">${rateBoard('Steal %', 'Share of opponent possessions ending in his steal while he plays', R('stlPct'))}${rateBoard('Block %', "Share of opponent 2-point shots he blocked while he plays", R('blkPct'))}</div>
<div class="row">${rateBoard('Defensive rebound %', 'Share of available defensive rebounds he grabbed while he plays', R('drebPct'))}${rateBoard('Stocks per 40', 'Steals + blocks per 40 minutes', R('stocks40'))}</div>
${OFT.size ? `<div class="row">${teamOfBoard()}${rateBoard('Offensive fouls drawn', 'Charges and other offensive fouls drawn, season total. <a href="charges.html"><strong>Full list →</strong></a>', (p) => OFP.get(p.id) || null, { fmt: (v) => String(Math.round(v)), pool: players })}</div>` : ''}
${PBP ? `<div class="row">${rateBoard('On-court defense', 'Points allowed per 100 possessions by his team with him on the court. Lower is better. At least 300 possessions on the court.', (p) => defOf(p.id)?.onDrtg ?? null, { asc: true, pool: players })}${rateBoard('Defensive on/off', 'How many fewer points per 100 possessions his team allows with him on the court than off it. At least 300 possessions on the court.', (p) => defOf(p.id)?.defSwing ?? null, { fmt: signed, pool: players })}</div>` : ''}`;
function teamOfBoard() {
  const rows = teams.map((t) => ({ t, e: OFT.get(t.code) })).filter((x) => x.e && x.e.gp).map((x) => ({ ...x, v: x.e.drawn / x.e.gp })).sort((a, b) => b.v - a.v);
  const top = rows[0]?.v || 1;
  return `<section class="card board open"><h2>Charges drawn — teams</h2><p class="muted">Offensive fouls drawn per game (charges, illegal screens, push-offs), from the play-by-play. Grey: offensive fouls the team commits per game. <a href="charges.html"><strong>Full list of every charge →</strong></a></p><ol>
${rows.map(({ t, e, v }, i) => `<li><span class="muted num">${i + 1}</span><div><a href="${teamHref(t.code)}">${badge(t.code, t.tv)} ${esc(titleCase(t.name))}</a> <span class="muted small">${e.drawn} in ${e.gp} games · commits ${f1(e.committed / e.gp)}</span><div class="bar"><span style="width:${(100 * v / top).toFixed(1)}%"></span></div></div><strong class="num">${v.toFixed(2)}</strong></li>`).join('')}
</ol></section>`;
}
// Composite boards (PRA, Stocks): each part gets its own colour.
const PARTS = { pra: [['ppg', 'Points', 'c1'], ['rpg', 'Rebounds', 'c2'], ['apg', 'Assists', 'c3']], stocks: [['spg', 'Steals', 'c1'], ['bpg', 'Blocks', 'c2']] };
function board(title, sub, key, fmt = f1) {
  const bid = regBoard({ val: (p) => p[key], fmt: '1', asc: false, all: false, parts: PARTS[key]?.map(([k, l, c]) => [k, l, c]) });
  const list = leaders(qual, key, Infinity);
  const top = list[0]?.[key] || 1;
  const parts = PARTS[key];
  const legend = parts ? `<div class="legend">${parts.map(([, l, c]) => `<span><i class="${c}"></i>${l}</span>`).join('')}</div>` : '';
  const bar = (p) => parts
    ? `<div class="bar stack" title="${esc(parts.map(([k, l]) => `${l} ${f1(p[k])}`).join(' · '))}">${parts.map(([k, , c]) => `<span class="${c}" style="width:${(100 * p[k] / top).toFixed(1)}%"></span>`).join('')}</div><div class="parts">${parts.map(([k, l, c]) => `<span class="${c}" title="${l}">${f1(p[k])}</span>`).join('')}</div>`
    : `<div class="bar"><span style="width:${(100 * p[key] / top).toFixed(1)}%"></span></div>`;
  return `<section class="card board" data-board="${bid}"><h2>${title}</h2><p class="muted">${sub}</p>${legend}<ol>
${list.map((p, i) => `<li${i >= 10 ? ' class="more"' : ''}><span class="muted num">${i + 1}</span><div><a href="${playerHref(p.id)}">${esc(p.name)}</a> <span class="muted">${esc(p.tv)}</span>${bar(p)}</div><strong class="num">${fmt(p[key])}</strong></li>`).join('')}
</ol>${moreBtn(list.length)}</section>`;
}


const lead = teams[0];
const topBy = (k) => leaders(qual, k, 1)[0];
const bestO = [...teams].sort((x, y) => y.ortg - x.ortg)[0], bestD = [...teams].sort((x, y) => x.drtg - y.drtg)[0];
const leaderTile = (k, label, sub) => {
  const p = topBy(k);
  if (!p) return '';
  return `<a class="tile" href="${playerHref(p.id)}"><span class="label">${label}</span><span class="big">${f1(p[k])}</span><span class="sub">${sub}</span>
<span class="chip hot">${esc(p.name)} · ${esc(p.tv)}</span></a>`;
};
const homeHero = cover({
  kicker: esc(roundLine),
  title: esc(cfg.seasonLabel),
  lede: lead ? `<strong>${esc(titleCase(lead.name))}</strong> lead the league at ${lead.w}–${lead.l}. ` +
    (topBy('pirpg') ? `<strong>${esc(topBy('pirpg').name)}</strong> tops the PIR chart at ${f1(topBy('pirpg').pirpg)} a game.` : '') : '',
  strip: [[info.games, 'games played'], [esc(bestO?.tv || ''), `best offense, ${f1(bestO?.ortg)}`], [esc(bestD?.tv || ''), `best defense, ${f1(bestD?.drtg)}`]],
  side: cfg.leagueLogo ? `<div class="side league-badge"><img src="${esc(cfg.leagueLogo)}" alt="${esc(cfg.leagueName)}" width="190" height="43"></div>` : ''
});
writePage(HOME, cfg.seasonLabel, `
<div class="tiles">
${leaderTile('ppg', 'Scoring', 'points per game, 1st in the league')}
${leaderTile('pirpg', 'All-round', 'PIR per game, 1st in the league')}
${leaderTile('rpg', 'Rebounding', 'rebounds per game, 1st in the league')}
${leaderTile('apg', 'Playmaking', 'assists per game, 1st in the league')}
</div>
${gamesSection}
${mvpSection}
${roundMvpSection}
<div class="row">
<section class="card"><h2>Standings</h2><p class="muted">Top 6 go to the playoffs, 7–10 to the play-in.</p>
<div class="scroll"><table class="standings"><thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col" class="num">W–L</th><th scope="col" class="num" title="Points scored per 100 possessions">ORtg</th><th scope="col" class="num" title="Points allowed per 100 possessions">DRtg</th><th scope="col" class="num">Net</th></tr></thead>
<tbody>${standingsRows}</tbody></table></div>
<p class="muted small">Ranked by wins, then point difference. Official tiebreakers use head-to-head results.</p>
</section>
<section class="card wide"><h2>Who scores, who defends</h2><p class="muted">Right = better offense. Up = better defense. Dashed lines are the league average.</p>
${teamChart}<p class="hover-info" aria-live="polite"></p></section>
</div>
<div id="board-filter" class="card board-filter"></div>
<div class="row">
${board('Points', 'Per game', 'ppg')}
${board('PIR', 'Performance Index Rating per game', 'pirpg')}
</div>
<div class="row">
${board('PRA', 'Points + rebounds + assists per game', 'pra')}
${board('Stocks', 'Steals + blocks per game', 'stocks')}
</div>
<p class="muted small">${qualNote}</p>
${per40Section}
${defenseSection}
<script type="application/json" id="boards-data">${boardsJson()}</script>`, HOME, homeHero, { scripts: `<script src="mvp.js?v=${assetVersion()}" defer></script><script src="boards.js?v=${assetVersion()}" defer></script>` });


// Players page
const VIEWS = [
  { id: 'usage', label: 'Usage vs efficiency', x: 'usg', y: 'ts', xl: 'Usage rate %', yl: 'True shooting %' },
  { id: 'threes', label: '3-point volume vs accuracy', x: 'threeApg', y: 'threePct', xl: '3-point attempts per game', yl: '3P%', filter: (p) => p.totals.fga3 >= 15 },
  { id: 'scoring', label: 'Scoring vs playmaking', x: 'ppg', y: 'apg', xl: 'Points per game', yl: 'Assists per game' },
  { id: 'minutes', label: 'Minutes vs PIR', x: 'mpg', y: 'pirpg', xl: 'Minutes per game', yl: 'PIR per game' }
];
const playerCharts = VIEWS.map((v, i) => scatter(qual.filter(v.filter || (() => true)).map((p) => ({
  x: p[v.x], y: p[v.y],
  title: `${p.name} (${p.tv}): ${v.xl} ${f1(p[v.x])}, ${v.yl} ${f1(p[v.y])}`,
  attrs: { 'data-id': p.id, 'data-team': p.team }
})), { xLabel: v.xl, yLabel: v.yl, view: v.id, hidden: i > 0 })).join('');

const cols = [['name', 'Player', 's'], ['tv', 'Team', 's'], ['gp', 'GP'], ['mpg', 'MIN'], ['ppg', 'PTS'], ['rpg', 'REB'], ['apg', 'AST'], ['spg', 'STL'], ['bpg', 'BLK'], ['tpg', 'TOV'], ['pirpg', 'PIR'], ['pra', 'PRA'], ['fgPct', 'FG%'], ['threePct', '3P%'], ['ftPct', 'FT%'], ['ts', 'TS%'], ['usg', 'USG%']];
const sortedPlayers = [...players].sort((a, b) => b.ppg - a.ppg);
const playerRows = sortedPlayers.map((p) => `<tr id="${esc(p.id)}" data-team="${esc(p.team)}">${cols.map(([k, , t]) => t === 's'
  ? `<td data-v="${esc(p[k])}">${k === 'name' ? `<a href="${playerHref(p.id)}">${esc(p[k])}</a>` : esc(p[k])}</td>`
  : `<td class="num" data-v="${p[k].toFixed(3)}">${k === 'gp' ? p.gp : f1(p[k])}</td>`).join('')}</tr>`).join('');
const teamOptions = teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.code)}">${esc(titleCase(t.name))}</option>`).join('');

writePage('players.html', 'Players', `
<section class="card">
<div class="controls">
<div role="group" aria-label="Chart" class="tabs">${VIEWS.map((v, i) => `<button type="button" data-show="${v.id}" aria-pressed="${i === 0}">${v.label}</button>`).join('')}</div>
<label>Team <select id="team-filter"><option value="">All teams</option>${teamOptions}</select></label>
</div>
<div class="chart-row"><div class="charts">${playerCharts}</div>
<aside class="detail" aria-live="polite"><p class="muted">Hover or tab to a dot to see the player.</p></aside></div>
<p class="muted small">Chart: ${qualNote} 3-point chart: at least 15 attempts.</p>
</section>
<h2 class="sec-title" id="all-stats">All player stats</h2>
<div id="players-app"><noscript><div class="scroll"><table id="players"><thead><tr>${cols.map(([k, l, t]) => `<th scope="col"${t === 's' ? '' : ' class="num"'}>${l}</th>`).join('')}</tr></thead>
<tbody>${playerRows}</tbody></table></div></noscript><p class="muted">Loading player stats…</p></div>`, 'players.html', cover({ kicker: esc(roundLine), title: 'Players', lede: `${players.length} players have stepped on the court this season. Every stat we have — traditional, shooting, advanced, defense, on/off and impact, highs and profile — per game, totals or per 40 minutes. Filter by team, position, minutes or games, and click any column to sort.`, strip: [[qual.length, 'qualified for leaderboards'], [players.length, 'players used']], actions: `<a class="btn white" href="${cfg.root || ''}compare.html">Compare players →</a> <a class="btn white" href="${cfg.root || ''}recruit.html">Recruiting search →</a>` }), { scripts: `<script src="players.js?v=${assetVersion()}" defer></script>` });

// ---- Quarter splits (EuroLeague): every player's and team's season, quarter by quarter ----
// From the games whose play-by-play matches the box score: minutes and on-court points/possessions from the
// lineups, counting stats from the plays. Quarter 5 = all overtimes.
if (IS_EL && pbpOk.length) {
  const QF = ['g', 'secs', 'pf', 'pa', 'poss', 'pts', 'fgm2', 'fga2', 'fgm3', 'fga3', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'tov', 'blk', 'blka', 'fl', 'fd'];
  const QI = Object.fromEntries(QF.map((k, i) => [k, i]));
  const EV = { '2FGM': [['pts', 2], ['fgm2', 1], ['fga2', 1]], '2FGA': [['fga2', 1]], '3FGM': [['pts', 3], ['fgm3', 1], ['fga3', 1]], '3FGA': [['fga3', 1]], FTM: [['pts', 1], ['ftm', 1], ['fta', 1]], FTA: [['fta', 1]],
    O: [['oreb', 1]], D: [['dreb', 1]], AS: [['ast', 1]], ST: [['stl', 1]], TO: [['tov', 1]], FV: [['blk', 1]], AG: [['blka', 1]], RV: [['fd', 1]], OF: [['fl', 1]] };
  const evOf = (type) => EV[type] || (/^CM/.test(type) ? [['fl', 1]] : null);
  const P = new Map(), T = new Map(), O = new Map(), teamOf = new Map();
  const cell = (map, id, q) => { if (!map.has(id)) map.set(id, {}); const m = map.get(id); return (m[q] ||= QF.map(() => 0)); };
  const qOf = (per) => Math.min(5, per);
  for (const { game, periodStints } of pbpOk) {
    const H = game.home.code, A = game.away.code;
    for (const side of [game.home, game.away]) for (const pl of side.players) teamOf.set(pl.id, side.code);
    const seen = new Set();
    for (const s of periodStints) {
      const q = qOf(s.period);
      for (const [ids, me, op, possMe, possOp] of [[s.home, H, A, s.possH, s.possA], [s.away, A, H, s.possA, s.possH]]) {
        const poss = (possMe + possOp) / 2;
        for (const id of ids) { const c = cell(P, id, q); c[QI.secs] += s.secs; c[QI.pf] += s.pts[me]; c[QI.pa] += s.pts[op]; c[QI.poss] += poss; if (!seen.has(id + '|' + q) && s.secs > 0) { seen.add(id + '|' + q); c[QI.g]++; } }
        const t = cell(T, me, q); t[QI.secs] += s.secs; t[QI.pf] += s.pts[me]; t[QI.pa] += s.pts[op]; t[QI.poss] += poss;
        if (!seen.has('T' + me + '|' + q)) { seen.add('T' + me + '|' + q); t[QI.g]++; }
      }
    }
    for (const [per, , side, pid, type] of playLog(game, rawPbp.get(game.gameCode)).plays) {
      const ev = evOf(type); if (!ev || !side) continue;
      const q = qOf(per), me = side === 'H' ? H : A, op = side === 'H' ? A : H;
      const t = cell(T, me, q), o = cell(O, op, q);
      for (const [k, v] of ev) { t[QI[k]] += v; o[QI[k]] += v; }
      if (pid) { const c = cell(P, pid, q); for (const [k, v] of ev) c[QI[k]] += v; }
    }
  }
  const nameOf = new Map(players.map((p) => [p.id, p]));
  const qData = {
    f: QF, games: pbpOk.length, total: games.length, hapoel: cfg.hapoelCode || 'HTA',
    players: [...P].filter(([id]) => nameOf.has(id)).map(([id, q]) => { const p = nameOf.get(id); return [p.name, p.tv, teamOf.get(id) || p.team, playerHref(id), q]; }),
    teams: [...T].map(([code, q]) => { const t = teams.find((x) => x.code === code); return [t ? titleCase(t.name) : code, code, crests.get(code) || null, `team-${safe(code)}.html`, q, O.get(code) || {}]; })
  };
  const tOpts = teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.code)}">${esc(titleCase(t.name))}</option>`).join('');
  writePage('quarter-split.html', 'Quarter splits', `<section class="card"><h2>Quarter splits</h2>
<p class="muted">Every player's and every team's EuroLeague season, quarter by quarter: pick one or more quarters and see the stats accumulated over the season. From the ${pbpOk.length} of ${games.length} games whose official play-by-play matches the box score (minutes, +/- and on-court ratings from the lineups; counting stats from the plays).</p>
<div class="filters qs-filters">
<div class="seg" role="group" aria-label="View"><button type="button" data-view="players" aria-pressed="true">Players</button><button type="button" data-view="teams" aria-pressed="false">Teams</button></div>
<div class="seg" role="group" aria-label="Quarters">${['Q1', 'Q2', 'Q3', 'Q4', 'OT'].map((l, i) => `<button type="button" data-q="${i + 1}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
<div class="seg" role="group" aria-label="Show"><button type="button" data-mode="tot" aria-pressed="true">Totals</button><button type="button" data-mode="pg" aria-pressed="false">Per game</button><button type="button" data-mode="40" aria-pressed="false">Per 40</button></div>
<label>Team <select data-f="team"><option value="">All teams</option>${tOpts}</select></label>
<label>Min. minutes <input data-f="min" type="number" min="0" step="5" value="30" style="width:70px"></label>
<label>Min. games <input data-f="gp" type="number" min="0" value="3" style="width:60px"></label>
<label><input data-f="q" type="search" placeholder="Search player…"></label>
</div>
<p class="muted small" id="qs-note"></p>
<div class="scroll"><table class="qs-table"><thead></thead><tbody></tbody></table></div>
</section>
<script type="application/json" id="qs-data">${JSON.stringify(qData).replace(/</g, '\\u003c')}</script>`, 'quarter-split.html', null, { scripts: `<script src="quarter-split.js?v=${assetVersion()}" defer></script>` });
}

// ---- Clutch and after-timeout page ----
if (CLUTCH) {
  const sgn = (v) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
  const pc = (m, a) => (a ? (100 * m / a).toFixed(1) : '–');
  const cell = (v, txt, cls = '') => `<td class="num ${cls}" data-v="${v == null || !Number.isFinite(v) ? -1e9 : v}">${txt}</td>`;
  const tcell = (txt, v = txt) => `<td data-v="${esc(String(v))}">${txt}</td>`;
  const head = (cols) => `<thead><tr>${cols.map(([l, num, tip]) => `<th scope="col"${num ? ' class="num"' : ''}${tip ? ` title="${esc(tip)}"` : ''}><button type="button">${l}</button></th>`).join('')}</tr></thead>`;
  const tname = (code) => { const t = teams.find((x) => x.code === code); return t ? titleCase(t.name) : code; };
  const crest = (code) => (crests.has(code) ? `<img class="crest small" src="${esc(crests.get(code))}" alt="" width="20" height="20"> ` : '');
  const CT = CLUTCH.teams.map((t) => ({ t, r: situRates({ secs: t.secs, poss: t.poss, possD: t.possD, pf: t.pf, pa: t.pa, box: t.box, opp: t.opp }) })).sort((a, b) => (b.t.w - b.t.l) - (a.t.w - a.t.l) || (b.r.net ?? -99) - (a.r.net ?? -99));
  const teamRows = CT.map(({ t, r }) => `<tr${t.code === (cfg.hapoelCode || 'HTA') ? ' class="hap-row"' : ''}>${tcell(`${crest(t.code)}<a href="${teamHref(t.code)}">${esc(tname(t.code))}</a>`, tname(t.code))}${cell(t.games, t.games)}${cell(t.w - t.l, `${t.w}–${t.l}`)}${cell(r.min, f1(r.min))}${cell(t.pf - t.pa, `${t.pf}–${t.pa}`)}${cell(r.ortg, f1(r.ortg))}${cell(r.drtg, f1(r.drtg))}${cell(r.net, sgn(r.net), r.net >= 0 ? 'pos' : 'neg')}${cell(r.efg, f1(r.efg))}${cell(r.efgD, f1(r.efgD))}${cell(r.tovPct, f1(r.tovPct))}${cell(r.ftr, f1(r.ftr))}${cell(t.box.ftm / (t.box.fta || 1), pc(t.box.ftm, t.box.fta))}</tr>`).join('');
  const CP = CLUTCH.players.filter((p) => nameOf.has(p.id)).map((p) => ({ p, b: p.box, reb: p.box.oreb + p.box.dreb })).sort((a, b) => b.b.pts - a.b.pts || b.p.secs - a.p.secs);
  const plRows = CP.map(({ p, b, reb }) => `<tr data-team="${esc(p.team)}"${p.team === (cfg.hapoelCode || 'HTA') ? ' class="hap-row"' : ''}>${tcell(`<a href="${playerHref(p.id)}">${esc(nameOf.get(p.id))}</a>`, nameOf.get(p.id))}${tcell(esc(teams.find((x) => x.code === p.team)?.tv || p.team), p.team)}${cell(p.games, p.games)}${cell(p.secs, f1(p.secs / 60))}${cell(b.pts, `<strong>${b.pts}</strong>`)}${cell(b.fgm2 + b.fgm3, `${b.fgm2 + b.fgm3}/${b.fga2 + b.fga3}`)}${cell((b.fgm2 + b.fgm3) / (b.fga2 + b.fga3 || 1), pc(b.fgm2 + b.fgm3, b.fga2 + b.fga3))}${cell(b.fgm3, `${b.fgm3}/${b.fga3}`)}${cell(b.ftm, `${b.ftm}/${b.fta}`)}${cell(reb, reb)}${cell(b.ast, b.ast)}${cell(b.tov, b.tov)}${cell(b.stl, b.stl)}${cell(b.blk, b.blk)}${cell(p.pm, sgn(p.pm).replace('.0', ''), p.pm >= 0 ? 'pos' : 'neg')}</tr>`).join('');
  let atoHtml = '';
  if (ATO) {
    const A = ATO.map((t) => ({ t, ppp: t.off.n ? t.off.pts / t.off.n : null, dppp: t.def.n ? t.def.pts / t.def.n : null, base: (teams.find((x) => x.code === t.code)?.ortg ?? 0) / 100 })).sort((a, b) => (b.ppp ?? 0) - (a.ppp ?? 0));
    atoHtml = `<section class="card" id="ato"><h2>After timeouts</h2>
<p class="muted">The first possession after a team's own timeout, when it has the ball: points per possession (PPP), how often it scores, turns it over, and how that compares with its normal offense (season points per possession). "Allowed" = opponents' first possession after <em>their</em> timeouts against this team.</p>
<div class="scroll"><table class="sortable">${head([['Team'], ['ATO poss', 1], ['Pts', 1], ['PPP', 1, 'Points per possession after own timeout'], ['Normal PPP', 1, 'Season points per possession'], ['Diff', 1], ['Score %', 1, 'Possessions with at least 1 point'], ['TO %', 1], ['FG', 1], ['3P', 1], ['Last 2 min', 1, 'ATO possessions in the last 2 minutes of Q4/OT: points / possessions'], ['Allowed PPP', 1, "Opponents' PPP after their own timeouts"]])}
<tbody>${A.map(({ t, ppp, dppp, base }) => `<tr${t.code === (cfg.hapoelCode || 'HTA') ? ' class="hap-row"' : ''}>${tcell(`${crest(t.code)}<a href="${teamHref(t.code)}">${esc(tname(t.code))}</a>`, tname(t.code))}${cell(t.off.n, t.off.n)}${cell(t.off.pts, t.off.pts)}${cell(ppp, ppp == null ? '–' : ppp.toFixed(2))}${cell(base, base.toFixed(2))}${cell(ppp == null ? null : ppp - base, ppp == null ? '–' : (ppp - base >= 0 ? '+' : '−') + Math.abs(ppp - base).toFixed(2), ppp != null && ppp >= base ? 'pos' : 'neg')}${cell(t.off.scored / (t.off.n || 1), pc(t.off.scored, t.off.n))}${cell(t.off.tov / (t.off.n || 1), pc(t.off.tov, t.off.n))}${cell(t.off.fgm / (t.off.fga || 1), `${t.off.fgm}/${t.off.fga}`)}${cell(t.off.fgm3 / (t.off.fga3 || 1), `${t.off.fgm3}/${t.off.fga3}`)}${cell(t.off.late.n ? t.off.late.pts / t.off.late.n : null, t.off.late.n ? `${t.off.late.pts}/${t.off.late.n}` : '–')}${cell(dppp, dppp == null ? '–' : dppp.toFixed(2), dppp != null && dppp <= 1 ? 'pos' : '')}</tr>`).join('')}</tbody></table></div>
</section>`;
  }
  writePage('clutch.html', 'Clutch & after timeouts', `<section class="card" id="clutch-teams"><h2>Clutch — teams</h2>
<p class="muted">Clutch = the last 5 minutes of the 4th quarter or overtime with the score within 5 points. From the ${pbpOk.length} of ${games.length} games whose official play-by-play matches the box score. Record = results of games that had clutch time. Ratings per 100 possessions in clutch time only. Click a column to sort.</p>
<div class="scroll"><table class="sortable">${head([['Team'], ['Games', 1], ['W–L', 1], ['MIN', 1], ['Score', 1, 'Points for–against in clutch time'], ['ORtg', 1], ['DRtg', 1], ['Net', 1], ['eFG%', 1], ['Opp eFG%', 1], ['TO%', 1], ['FT rate', 1], ['FT%', 1]])}<tbody>${teamRows}</tbody></table></div></section>
<section class="card" id="clutch-players"><h2>Clutch — players</h2>
<p class="muted">Every player's totals in clutch time. +/- = points scored minus allowed by his team while he was on the court in clutch time.</p>
<div class="scroll"><table class="sortable">${head([['Player'], ['Team'], ['GP', 1], ['MIN', 1], ['PTS', 1], ['FG', 1], ['FG%', 1], ['3P', 1], ['FT', 1], ['REB', 1], ['AST', 1], ['TOV', 1], ['STL', 1], ['BLK', 1], ['+/-', 1]])}<tbody>${plRows}</tbody></table></div></section>
${atoHtml}`, 'clutch.html', cover({ kicker: esc(roundLine), title: 'Clutch & after timeouts', lede: 'Who wins the close ones, who delivers in the last five minutes, and who draws up the best plays out of a timeout.' }));
}

// ---- Player stats tool data (player-stats.json): everything we have for every player ----
{
  const logsAll = playerGameLogs(games);
  const isQ = new Set(qual.map((q) => q.id));
  const todayISO = new Date().toISOString().slice(0, 10);
  const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const TK = ['pts', 'fgm2', 'fga2', 'fgm3', 'fga3', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'tov', 'blk', 'blka', 'pf', 'fd', 'pir'];
  const out = players.map((p) => {
    const person = findPerson(peopleIndex, p), rt = RATES.get(p.id), o = PBP?.onoff.get(p.id), lg = logsAll.get(p.id) || [];
    let pb = null;
    if (o && o.on.poss > 0) {
      const off = { poss: o.teamTot.poss - o.on.poss, pf: o.teamTot.pf - o.on.pf, pa: o.teamTot.pa - o.on.pa };
      const onO = 100 * o.on.pf / o.on.poss, onD = 100 * o.on.pa / o.on.poss;
      const offO = off.poss > 0 ? 100 * off.pf / off.poss : null, offD = off.poss > 0 ? 100 * off.pa / off.poss : null;
      pb = [r2(o.on.secs / 60), r2(o.on.poss), r2(onO), r2(onD), r2(offO), r2(offD), r2(IMPACT?.values.get(p.id) ?? null)];
    }
    const dd = lg.filter((g) => [g.line.pts, g.line.reb, g.line.ast, g.line.stl, g.line.blk].filter((v) => v >= 10).length >= 2).length;
    const td = lg.filter((g) => [g.line.pts, g.line.reb, g.line.ast, g.line.stl, g.line.blk].filter((v) => v >= 10).length >= 3).length;
    const hi = (k) => (lg.length ? Math.max(...lg.map((g) => g.line[k])) : null);
    return [p.name, p.tv, p.team, playerHref(p.id), person?.position || '', person?.height || null, person?.weight || null, person ? ageOn(person.birthDate, todayISO) : null, person?.country || '', p.number || person?.dorsal || '',
      p.gp, p.gs, r2(p.totalMin), p.totalPm, isQ.has(p.id) ? 1 : 0, TK.map((k) => p.totals[k]), r2(p.usg),
      rt ? [r2(rt.ctx.oppPoss), r2(rt.ctx.opp2a), r2(rt.ctx.drebCh), r2(rt.ctx.orebCh), r2(rt.ctx.rebCh), r2(rt.ctx.teamFgm)] : null,
      pb, [OFP.get(p.id) || 0, OFC.get(p.id) || 0], [dd, td, lg.filter((g) => g.line.pts >= 20).length, hi('pts'), hi('reb'), hi('ast'), hi('pir')], p.teams.length > 1 ? 1 : 0];
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'player-stats.json'), JSON.stringify({
    note: `${info.games} games, ${roundLine.toLowerCase()}.`, tk: TK, pbpGames: pbpOk.length, games: info.games,
    teams: teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.code, titleCase(t.name), crests.get(t.code) || null]),
    players: out
  }));
}


// Teams page
const TEAM_SPLITS = teamSplits(games, teams);
// Hapoel Tel Aviv as the reference team in every team report (same league; otherwise its EuroLeague numbers).
const CMP = [['Points', 'ppg', true], ['Points allowed', 'oppg', false], ['Offensive rating', 'ortg', true], ['Defensive rating', 'drtg', false], ['Net rating', 'net', true], ['Pace', 'pace', null],
  ['eFG%', 'efg', true], ['True shooting %', 'ts', true], ['Turnovers / 100', 'tov100', false], ['Offensive rebound %', 'orebPct', true], ['Free-throw rate', 'ftr', true],
  ['Opp eFG%', 'efgD', false], ['Forced turnovers / 100', 'tov100D', true], ['Defensive rebound %', 'drebPct', true], ['Opp free-throw rate', 'ftrD', false],
  ['2P%', 'twoPct', true], ['3P%', 'threePct', true], ['3-point rate', 'threeRate', null], ['FT%', 'ftPct', true], ['Assist rate', 'astRate', true],
  ['Opp 2P%', 'twoPctD', false], ['Opp 3P%', 'threePctD', false], ['Opp 3-point rate', 'threeRateD', null], ['Rebounds', 'rpg', true], ['Assists', 'apg', true], ['Steals', 'spg', true], ['Blocks', 'bpg', true]];
const HAP_CODE = IS_EL ? (cfg.hapoelCode || 'HTA') : teams.find((t) => /hapoel/i.test(t.name) && /tel[ -]?aviv/i.test(t.name))?.code;
let HAP = HAP_CODE && teams.some((t) => t.code === HAP_CODE) ? { t: teams.find((t) => t.code === HAP_CODE), label: `Hapoel Tel Aviv (${IS_EL ? 'EuroLeague' : cfg.shortName || cfg.leagueName})`, same: true } : null;
if (IS_EL && HAP) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'hapoel-ref.json'), JSON.stringify({ team: Object.fromEntries(['w', 'l', 'gp', ...CMP.map((c) => c[1])].map((k) => [k, HAP.t[k]])) })); }
if (!HAP) { try { const j = JSON.parse(readFileSync(join('site', 'hapoel-ref.json'))); HAP = { t: j.team, label: 'Hapoel Tel Aviv (EuroLeague)', same: false }; } catch { /* no reference yet */ } }
const splitOf = (code, gs) => (gs.length ? teamTable(gs).find((x) => x.code === code) || null : null);
// ---- Before / after splits (e.g. a coach change): config.splits = [{ team, from, title, before, after }] ----
const SPLITS = (cfg.splits || []).filter((s) => teams.some((t) => t.code === s.team));
const splitHref = (s) => `team-${safe(s.team)}-split-${s.from}.html`;
// Hapoel: wins against losses (EuroLeague and Winner League), on the same comparison page.
const WL_SPECS = HAP_GAME_CODE ? [{ team: HAP_GAME_CODE, wl: true, title: 'Wins vs losses', href: `team-${safe(HAP_GAME_CODE)}-wins-losses.html` }] : [];
for (const S of [...SPLITS.map((x) => ({ ...x, href: splitHref(x) })), ...WL_SPECS]) {
  const t = teams.find((x) => x.code === S.team), TN = titleCase(t.name);
  const all = games.filter((g) => g.home.code === S.team || g.away.code === S.team).sort((a, b) => a.date.localeCompare(b.date) || a.gameCode - b.gameCode);
  const isWin = (g) => (g.home.code === S.team ? g.home.score > g.away.score : g.away.score > g.home.score);
  const A = S.wl ? all.filter(isWin) : all.slice(0, S.from - 1), B = S.wl ? all.filter((g) => !isWin(g)) : all.slice(S.from - 1);
  if (!A.length || !B.length) continue;
  const lA = S.wl ? `Wins (${A.length})` : S.before || `Games 1–${A.length}`, lB = S.wl ? `Losses (${B.length})` : S.after || `Games ${S.from}–${all.length}`;
  const cA = S.wl ? 'Wins' : 'Before', cB = S.wl ? 'Losses' : 'After', cD = S.wl ? 'Diff' : 'Change', flip = !!S.wl; // in wins vs losses the difference is wins minus losses
  const tA = splitOf(S.team, A), tB = splitOf(S.team, B);
  const setA = new Set(A.map((g) => g.gameCode)), setB = new Set(B.map((g) => g.gameCode));
  const pA = pbpOk.filter((e) => setA.has(e.game.gameCode)), pB = pbpOk.filter((e) => setB.has(e.game.gameCode));
  const fA = pA.length ? flowExtras(pA).find((x) => x.code === S.team) : null, fB = pB.length ? flowExtras(pB).find((x) => x.code === S.team) : null;
  const shA = ALLSHOTS.filter((x) => setA.has(x.g)), shB = ALLSHOTS.filter((x) => setB.has(x.g));
  const fbPg = (list, n) => list.filter((x) => x.team === S.team && x.made && x.fb).reduce((s, x) => s + (x.is3 ? 3 : 2), 0) / n;
  const paintPg = (list, n, side = 'team') => list.filter((x) => x[side] === S.team && x.made && !x.is3 && (x.z === 'rim' || x.z === 'paint')).length * 2 / n;
  const wl = (gs) => gs.reduce((s, g) => s + ((g.home.code === S.team ? g.home.score > g.away.score : g.away.score > g.home.score) ? 1 : 0), 0);
  const wA = wl(A), wB = wl(B);
  // rows: [label, a, b, decimals, higher is better (true/false/null), a text, b text]
  const row = ([label, a, b, dp = 1, good = true, ta, tb]) => {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return '';
    const tot = Math.abs(a) + Math.abs(b) || 1, wa = (100 * Math.abs(a) / tot).toFixed(1);
    const bt = good == null || Math.abs(a - b) < 0.05 ? '' : (good ? a > b : a < b) ? 'h' : 'a';
    const d = flip ? a - b : b - a;
    return `<div class="cmp ${bt ? 'b-' + bt : ''}"><span class="v h">${ta ?? a.toFixed(dp)}</span><span class="lab">${label}${good == null ? '' : ` <small class="${(good ? d > 0 : d < 0) ? 'pos' : 'neg'}">${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(dp)}</small>`}</span><span class="v a">${tb ?? b.toFixed(dp)}</span><div class="split"><i style="width:${wa}%"></i><i style="width:${(100 - wa).toFixed(1)}%"></i></div></div>`;
  };
  const K = (k) => [tA[k], tB[k]];
  const groups = [
    ['Results', [S.wl ? null : ['Win %', 100 * wA / A.length, 100 * wB / B.length, 0, true, `${wA}–${A.length - wA}`, `${wB}–${B.length - wB}`], ['Points', ...K('ppg')], ['Points allowed', ...K('oppg'), 1, false], ['Point differential', tA.ppg - tA.oppg, tB.ppg - tB.oppg]]],
    ['Efficiency', [['Offensive rating', ...K('ortg')], ['Defensive rating', ...K('drtg'), 1, false], ['Net rating', ...K('net')], ['Pace', ...K('pace'), 1, null]]],
    ['Offense', [['eFG%', ...K('efg')], ['True shooting %', ...K('ts')], ['2P%', ...K('twoPct')], ['3P%', ...K('threePct')], ['3-point rate', ...K('threeRate'), 1, null], ['Free-throw rate', ...K('ftr')], ['Turnovers / 100', ...K('tov100'), 1, false], ['Offensive rebound %', ...K('orebPct')], ['Assist rate', ...K('astRate')]]],
    ['Defense', [['Opp eFG%', ...K('efgD'), 1, false], ['Opp 2P%', ...K('twoPctD'), 1, false], ['Opp 3P%', ...K('threePctD'), 1, false], ['Opp 3-point rate', ...K('threeRateD'), 1, null], ['Forced turnovers / 100', ...K('tov100D')], ['Defensive rebound %', ...K('drebPct')], ['Opp free-throw rate', ...K('ftrD'), 1, false]]],
    ['How the points came (per game)', [
      fA && fB ? ['Points off turnovers', fA.offTO / fA.games, fB.offTO / fB.games] : null, fA && fB ? ['Second-chance points', fA.second / fA.games, fB.second / fB.games] : null,
      shA.length && shB.length ? ['Fast-break points', fbPg(shA, A.length), fbPg(shB, B.length)] : null, shA.length && shB.length ? ['Points in the paint', paintPg(shA, A.length), paintPg(shB, B.length)] : null,
      fA && fB ? ['Opp points off turnovers', fA.offTOA / fA.games, fB.offTOA / fB.games, 1, false] : null, fA && fB ? ['Opp second-chance points', fA.secondA / fA.games, fB.secondA / fB.games, 1, false] : null,
      shA.length && shB.length ? ['Opp points in the paint', paintPg(shA, A.length, 'opp'), paintPg(shB, B.length, 'opp'), 1, false] : null,
      fA && fB ? ['Runs of 8+ (for – against)', fA.runs / fA.games - fA.runsA / fA.games, fB.runs / fB.games - fB.runsA / fB.games, 1, true, `${(fA.runs / fA.games).toFixed(1)} – ${(fA.runsA / fA.games).toFixed(1)}`, `${(fB.runs / fB.games).toFixed(1)} – ${(fB.runsA / fB.games).toFixed(1)}`] : null
    ].filter(Boolean)]
  ];
  // average margin per quarter in each set of games
  const qMargin = (gs, qi) => { let m = 0, k = 0; for (const g of gs) { const me = g.home.code === S.team ? g.home : g.away, op = g.home.code === S.team ? g.away : g.home; if (me.quarters?.length > qi && op.quarters?.length > qi) { m += me.quarters[qi] - op.quarters[qi]; k++; } } return k ? m / k : null; };
  groups.push(['Quarter by quarter (average margin)', [0, 1, 2, 3].map((qi) => { const a = qMargin(A, qi), b = qMargin(B, qi); return a == null || b == null ? null : [`Q${qi + 1}`, a, b, 1, true, (a > 0 ? '+' : '') + a.toFixed(1), (b > 0 ? '+' : '') + b.toFixed(1)]; }).filter(Boolean)]);
  // home / away and close games inside each set
  const where = (gs) => { const h = gs.filter((g) => g.home.code === S.team).length; const close = gs.filter((g) => Math.abs(g.home.score - g.away.score) <= 5).length; return `${h} home · ${gs.length - h} away · ${close} decided by 5 or less`; };
  // the opponents' best individual games (wins vs losses: who hurt us)
  const oppBest = (gs) => gs.flatMap((g) => { const op = g.home.code === S.team ? g.away : g.home; return op.players.filter((p) => p.min > 0).map((p) => ({ p, g, op })); }).sort((x, y) => y.p.pir - x.p.pir || y.p.pts - x.p.pts).slice(0, 8)
    .map(({ p, g, op }) => `<tr><td><a href="${playerHref(p.id)}">${esc(p.name)}</a> <span class="muted small">${esc(op.tv)}</span></td><td class="num"><a href="${gameHref(g.gameCode)}">${esc(fmtDate(g.date))}</a></td><td class="num"><strong>${p.pts}</strong></td><td class="num">${p.fgm2 + p.fgm3}/${p.fga2 + p.fga3}</td><td class="num">${p.reb}</td><td class="num">${p.ast}</td><td class="num"><strong>${p.pir}</strong></td></tr>`).join('');
  const oppSec = S.wl ? `<section class="card"><h2>Opponents who hurt Hapoel</h2><p class="muted">The best individual games against Hapoel (by PIR), in its losses and in its wins.</p><div class="r-two">${[[lB, B], [lA, A]].map(([l, gs]) => `<div><h3>In ${esc(l.toLowerCase())}</h3><table class="rtab"><thead><tr><th>Player</th><th class="num">Date</th><th class="num">PTS</th><th class="num">FG</th><th class="num">REB</th><th class="num">AST</th><th class="num">PIR</th></tr></thead><tbody>${oppBest(gs)}</tbody></table></div>`).join('')}</div></section>` : '';
  // lineups in each set of games (5, 4, 3 and 2 players), filtered on the page by splitlineups.js
  const luData = (() => {
    const side = (list) => { const out = { 5: {}, 4: {}, 3: {}, 2: {} }; for (const e of list) { const sd = e.game.home.code === S.team ? 'H' : 'A'; for (const k of [5, 4, 3, 2]) for (const u of gameUnits(e.game, e.stints, k)[sd]) { const key = u.ids.slice().sort().join(','); const o = out[k][key] ||= [0, 0, 0, 0, 0, 0]; o[0] += u.secs; o[1] += u.pf; o[2] += u.pa; o[3] += u.poss; o[4] += u.oposs; o[5]++; } } for (const k of [5, 4, 3, 2]) for (const key of Object.keys(out[k])) out[k][key] = out[k][key].map((v, i) => (i === 5 ? v : Math.round(v * 10) / 10)); return out; };
    const ids = new Set(); for (const e of [...pA, ...pB]) { const sd = e.game.home.code === S.team ? e.game.home : e.game.away; for (const p of sd.players) ids.add(p.id); }
    return { a: cA, b: cB, gA: pA.length, gB: pB.length, names: Object.fromEntries([...ids].map((id) => [id, nameOf.get(id) || id])), A: side(pA), B: side(pB) };
  })();
  // players: role before and after
  const plA = new Map(playerTable(A).filter((p) => p.team === S.team).map((p) => [p.id, p])), plB = new Map(playerTable(B).filter((p) => p.team === S.team).map((p) => [p.id, p]));
  const ids = [...new Set([...plA.keys(), ...plB.keys()])].sort((x, y) => (plB.get(y)?.mpg || 0) - (plB.get(x)?.mpg || 0) || (plA.get(y)?.mpg || 0) - (plA.get(x)?.mpg || 0));
  const cellPair = (a, b, k, dp = 1, flag = 3) => { const x = a?.[k], y = b?.[k]; const d = x != null && y != null ? (flip ? x - y : y - x) : null; return `<td class="num muted">${x == null ? '–' : x.toFixed(dp)}</td><td class="num"><strong>${y == null ? '–' : y.toFixed(dp)}</strong></td><td class="num ${d == null ? '' : d >= flag ? 'pos' : d <= -flag ? 'neg' : ''}">${d == null ? (S.wl ? '–' : x == null ? 'new' : 'out') : (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(dp)}</td>`; };
  const plRows = ids.map((id) => { const a = plA.get(id), b = plB.get(id); return `<tr><td><a href="${playerHref(id)}">${esc(nameOf.get(id) || id)}</a></td><td class="num muted">${a ? `${a.gp} (${a.gs})` : '–'}</td><td class="num">${b ? `${b.gp} (${b.gs})` : '–'}</td>${cellPair(a, b, 'mpg', 1, 4)}${cellPair(a, b, 'ppg', 1, 3)}${cellPair(a, b, 'pirpg', 1, 3)}${cellPair(a, b, 'pmpg', 1, 4)}</tr>`; }).join('');
  // rotation heat maps and starting fives
  const rotTable = (list, n) => { const R = rotationOf(list, S.team); const pl = R.players.filter((x) => x.mpg >= 3).sort((a, b) => (b.share[0] - a.share[0]) || (b.mpg - a.mpg)); return pl.length ? `<div class="scroll"><table class="rot"><thead><tr><th>Player</th><th class="num">MIN</th>${Array.from({ length: 40 }, (_, m) => `<th class="rot-m${m % 10 === 0 ? ' rot-q' : ''}">${m % 10 === 0 ? 'Q' + (m / 10 + 1) : ''}</th>`).join('')}</tr></thead><tbody>${pl.map((x) => `<tr><td>${esc(nameOf.get(x.id) || x.id)}</td><td class="num">${f1(x.mpg)}</td>${x.share.map((v, m) => `<td class="rot-c${m % 10 === 0 ? ' rot-q' : ''}" style="--a:${Math.min(1, v).toFixed(2)}" title="minute ${m + 1}: ${Math.round(100 * v)}% of games"></td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted small">${R.games} of ${n} games with lineups from the play-by-play.</p>` : '<p class="muted">No lineup data.</p>'; };
  const starters = (gs) => { const m = new Map(); for (const g of gs) { const me = g.home.code === S.team ? g.home : g.away; const k = me.players.filter((p) => p.starter).map((p) => p.id).sort().join(','); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `<li>${k.split(',').map((id) => esc(nameOf.get(id) || id)).join(' · ')} <span class="muted">× ${n}</span></li>`).join(''); };
  const gameList = (gs, off) => gs.map((g, i) => { const home = g.home.code === S.team, me = home ? g.home : g.away, op = home ? g.away : g.home, w = me.score > op.score; return `<tr><td class="muted">${i + 1 + off}</td><td>${esc(fmtDate(g.date))}</td><td>${home ? 'vs' : 'at'} ${esc(titleCase(op.name))}</td><td class="${w ? 'pos' : 'neg'}"><a href="${gameHref(g.gameCode)}">${w ? 'W' : 'L'} ${me.score}–${op.score}</a></td></tr>`; }).join('');
  const zone = (sh) => zoneRows(sh.filter((x) => x.team === S.team), ALLSHOTS);
  const zA = shA.length ? zone(shA) : null, zB = shB.length ? zone(shB) : null;
  const body = `<div class="split-page"><p class="no-print" style="margin:0 0 12px"><button type="button" class="btn" id="print-btn">Download as PDF</button> <span class="muted small">Opens the print window: choose “Save as PDF”.</span></p>
<header class="print-only split-ph"><div class="r-kicker">HTA LAB · ${esc(TN)}</div><h1>${esc(S.title || 'Before and after')}</h1><div class="r-meta">${esc(lA)}: ${wA}–${A.length - wA} · ${esc(lB)}: ${wB}–${B.length - wB} · Data through ${esc(fmtDate(info.lastDate))}</div></header>
<section class="card"><h2>${esc(TN)}: ${esc(lA)} vs ${esc(lB)}</h2>
<div class="perf-head split-head"><span>${esc(lA)}<small>${S.wl ? where(A) : `${A.length} games · ${wA}–${A.length - wA}`}</small></span><span>${esc(S.title || 'Before and after')}</span><span>${esc(lB)}<small>${S.wl ? where(B) : `${B.length} games · ${wB}–${B.length - wB}`}</small></span></div>
${groups.map(([g, rows]) => `<h3 class="cmp-grp">${g}</h3>${rows.filter(Boolean).map(row).join('')}`).join('')}
<p class="muted small">Per game and per 100 possessions. The small number under each label is the change (${S.wl ? 'wins minus losses; green = better in wins' : `green = better since game ${S.from}`}). Bars: share of the two periods; red marks the better one. ${B.length} games is a small sample.</p></section>
${zA && zB ? `<section class="card"><h2>Shot profile</h2><div class="shot-two"><figure><figcaption><strong>${esc(lA)}</strong></figcaption>${courtSvg(shA.filter((x) => x.team === S.team), { mode: 'zones', league: ALLSHOTS, title: lA })}</figure><figure><figcaption><strong>${esc(lB)}</strong></figcaption>${courtSvg(shB.filter((x) => x.team === S.team), { mode: 'zones', league: ALLSHOTS, title: lB })}</figure></div>
<div class="scroll"><table><thead><tr><th>Zone</th><th class="num">FG% ${cA.toLowerCase()}</th><th class="num">FG% ${cB.toLowerCase()}</th><th class="num">Share ${cA.toLowerCase()}</th><th class="num">Share ${cB.toLowerCase()}</th><th class="num">${S.wl ? 'Share: wins − losses' : 'Change in share'}</th></tr></thead><tbody>${zA.map((r, i) => { const b = zB[i], d = flip ? r.share - b.share : b.share - r.share; return `<tr><td>${r.label}</td><td class="num muted">${r.pct == null ? '–' : r.pct.toFixed(1)} <small>${r.m}/${r.a}</small></td><td class="num"><strong>${b.pct == null ? '–' : b.pct.toFixed(1)}</strong> <small>${b.m}/${b.a}</small></td><td class="num muted">${r.share.toFixed(1)}%</td><td class="num"><strong>${b.share.toFixed(1)}%</strong></td><td class="num">${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)}</td></tr>`; }).join('')}</tbody></table></div><p class="muted small">Zone colours compare with the league average in each zone. Share = part of all field-goal attempts.</p></section>` : ''}
<section class="card"><h2>${S.wl ? 'Players — in wins and in losses' : 'Players — role before and after'}</h2><div class="scroll"><table class="split-pl"><thead><tr><th rowspan="2">Player</th><th colspan="2" class="grp">GP (starts)</th><th colspan="3" class="grp">Minutes</th><th colspan="3" class="grp">Points</th><th colspan="3" class="grp">PIR</th><th colspan="3" class="grp">+/-</th></tr><tr><th class="num">${cA}</th><th class="num">${cB}</th>${`<th class="num">${cA}</th><th class="num">${cB}</th><th class="num">${cD}</th>`.repeat(4)}</tr></thead><tbody>${plRows}</tbody></table></div><p class="muted small">${S.wl ? `Per game, in Hapoel's wins and in its losses. Diff = wins minus losses (green: he does more in wins). Sorted by minutes in losses.` : `Per game. "new" = did not play in the first period; "out" = has not played since game ${S.from}. Sorted by minutes in the second period.`}</p></section>
${oppSec}
<section class="card" id="split-lineups"><h2>Lineups — ${esc(cA.toLowerCase())} and ${esc(cB.toLowerCase())}</h2><div id="sl-app"><p class="muted">Loading…</p></div><script type="application/json" id="sl-data">${JSON.stringify(luData).replace(/</g, '\\u003c')}</script></section>
<section class="card"><h2>Starting fives</h2><div class="r-two"><div><h3>${esc(lA)}</h3><ol>${starters(A)}</ol></div><div><h3>${esc(lB)}</h3><ol>${starters(B)}</ol></div></div></section>
<section class="card"><h2>Rotation pattern</h2><h3>${esc(lA)}</h3>${rotTable(pA, A.length)}<h3>${esc(lB)}</h3>${rotTable(pB, B.length)}<p class="muted small">Each square is one minute of the game; the darker, the more often the player was on the court in that minute.</p></section>
<section class="card"><h2>Games</h2><div class="r-two"><div><h3>${esc(lA)}</h3><table class="rtab"><tbody>${gameList(A, 0)}</tbody></table></div><div><h3>${esc(lB)}</h3><table class="rtab"><tbody>${gameList(B, A.length)}</tbody></table></div></div></section>
<p class="print-only muted small">HTA LAB · official EuroLeague box scores, play-by-play and shot locations · hta-lab.github.io</p></div>`;
  writePage(S.href, `${TN} — ${S.title || 'before and after'}`, body, 'teams.html', cover({ kicker: esc(TN), title: S.title || 'Before and after', lede: `${esc(lA)} against ${esc(lB)}: results, efficiency, how the points came, shot profile, roles, starting fives and rotation.`, strip: [[`${wA}–${A.length - wA}`, lA], [`${wB}–${B.length - wB}`, lB]], actions: `<a class="btn white" href="#" onclick="window.print();return false">Download as PDF</a> <a class="btn white" href="${teamHref(S.team)}">${esc(TN)} team page</a> <a class="btn white" href="team-${safe(S.team)}-report.html">Team report</a>` }), { scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script><script src="splitlineups.js?v=${assetVersion()}" defer></script>` });
}
const tcols = [['name', 'Team', 's'], ['gp', 'GP'], ['w', 'W'], ['l', 'L'], ['ppg', 'PTS'], ['oppg', 'OPP'], ['ortg', 'ORtg'], ['drtg', 'DRtg'], ['net', 'Net'], ['pace', 'Pace'], ['ts', 'TS%'], ['efg', 'eFG%'], ['tov100', 'TOV/100'], ['orebPct', 'OREB%']];
{
  const splits = teamSplits(games, teams);
  writeFileSync(join(OUT, 'teams.json'), JSON.stringify({
    note: `${info.games} games, ${roundLine.toLowerCase()}. Calculated from ${cfg.sourceText}.`,
    teams: teams.map((t) => ({ code: t.code, tv: t.tv, name: titleCase(t.name), crest: crests.get(t.code) || null, href: teamHref(t.code), gp: t.gp, w: t.w, l: t.l, raw: t.raw, split: splits[t.code] }))
  }));
  // A simple table stays in the page for browsers without JavaScript.
  const tcols = [['name', 'Team', 's'], ['gp', 'GP'], ['w', 'W'], ['l', 'L'], ['ppg', 'PTS'], ['oppg', 'OPP'], ['ortg', 'ORtg'], ['drtg', 'DRtg'], ['net', 'Net'], ['pace', 'Pace']];
  writePage('teams.html', 'Teams', `<div id="teams-app"><p class="muted">Loading team stats…</p></div>
<noscript><section class="card"><div class="scroll"><table><thead><tr>${tcols.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead><tbody>${teams.map((t) => `<tr>${tcols.map(([k, , ty]) => ty === 's' ? `<td><a href="${teamHref(t.code)}">${esc(titleCase(t.name))}</a></td>` : `<td class="num">${['gp', 'w', 'l'].includes(k) ? t[k] : f1(t[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section></noscript>`,
    'teams.html', cover({ kicker: esc(roundLine), title: 'Teams', lede: 'Every team stat: traditional, opponents, advanced, four factors, shooting profile and splits. Per game, totals or per 100 possessions, coloured by league rank. Click a team for its scouting report.', strip: [[teams.length, 'clubs'], [f1(avg(teams, 'ortg')), 'league ORtg'], [f1(avg(teams, 'pace')), 'possessions per 40 min']] }),
    { scripts: `<script src="teams.js?v=${assetVersion()}" defer></script>` });
}

// Scouting page for every team
function scoutNotes(t, roster, qa) {
  const notes = [];
  const top = (k) => t.ranks[k] <= 3, bottom = (k) => t.ranks[k] > N - 3;
  const say = (cond, text) => { if (cond) notes.push(text); };
  say(top('threeRate'), `Shoots a lot of threes: ${f1(t.threeRate)}% of their shots are threes (${ord(t.ranks.threeRate)} in the league).`);
  say(bottom('threeRate'), `Rarely shoots threes: only ${f1(t.threeRate)}% of their shots (${ord(t.ranks.threeRate)}). They attack inside.`);
  say(top('threePct'), `Dangerous from outside: ${f1(t.threePct)}% from three (${ord(t.ranks.threePct)}).`);
  say(bottom('threePct'), `Struggles from outside: ${f1(t.threePct)}% from three (${ord(t.ranks.threePct)}).`);
  say(top('orebPct'), `Crashes the offensive glass: grabs ${f1(t.orebPct)}% of their own misses (${ord(t.ranks.orebPct)}). Box out.`);
  say(bottom('orebPct'), `Doesn't chase offensive rebounds: ${f1(t.orebPct)}% (${ord(t.ranks.orebPct)}).`);
  say(top('tov100'), `Takes care of the ball: ${f1(t.tov100)} turnovers per 100 possessions (${ord(t.ranks.tov100)}).`);
  say(bottom('tov100'), `Turnover-prone: ${f1(t.tov100)} turnovers per 100 possessions (${ord(t.ranks.tov100)}). Pressure the ball.`);
  say(top('tov100D'), `Forces turnovers: opponents give it away ${f1(t.tov100D)} times per 100 possessions (${ord(t.ranks.tov100D)}).`);
  say(top('ftr'), `Gets to the line: ${f1(t.ftr)} free throws per 100 shots (${ord(t.ranks.ftr)}). Avoid cheap fouls.`);
  say(top('ftrD'), `Rarely fouls: opponents get only ${f1(t.ftrD)} free throws per 100 shots (${ord(t.ranks.ftrD)}).`);
  say(top('pace'), `Plays fast: ${f1(t.pace)} possessions per 40 minutes (${ord(t.ranks.pace)}).`);
  say(bottom('pace'), `Plays slow: ${f1(t.pace)} possessions per 40 minutes (${ord(t.ranks.pace)}).`);
  say(top('drtg'), `Elite defense: allows ${f1(t.drtg)} points per 100 possessions (${ord(t.ranks.drtg)}).`);
  say(bottom('drtg'), `Weak defense: allows ${f1(t.drtg)} points per 100 possessions (${ord(t.ranks.drtg)}).`);
  say(top('ortg'), `Elite offense: scores ${f1(t.ortg)} points per 100 possessions (${ord(t.ranks.ortg)}).`);
  say(top('threePctD'), `Defends the three-point line well: opponents shoot ${f1(t.threePctD)}% (${ord(t.ranks.threePctD)}).`);
  say(bottom('threePctD'), `Gives up threes: opponents shoot ${f1(t.threePctD)}% from three against them (${ord(t.ranks.threePctD)}).`);
  if (qa) {
    const best = [...qa].sort((a, b) => b.margin - a.margin)[0];
    const worst = [...qa].sort((a, b) => a.margin - b.margin)[0];
    notes.push(`Best quarter: Q${best.q} (${signed(best.margin)} per game on average). Worst quarter: Q${worst.q} (${signed(worst.margin)}).`);
  }
  const reg = roster.filter((p) => p.mpg >= 10);
  const byUsg = [...reg].sort((a, b) => b.usg - a.usg)[0];
  if (byUsg) notes.push(`Main option: ${byUsg.name}, who uses ${f1(byUsg.usg)}% of possessions when on court (${f1(byUsg.ppg)} points, ${f1(byUsg.ts)} TS%).`);
  const shooter = reg.filter((p) => p.threeApg >= 2).sort((a, b) => b.threePct - a.threePct)[0];
  if (shooter) notes.push(`Best volume shooter: ${shooter.name}, ${f1(shooter.threePct)}% on ${f1(shooter.threeApg)} threes per game.`);
  const glass = [...reg].sort((a, b) => b.rpg - a.rpg)[0];
  if (glass) notes.push(`Top rebounder: ${glass.name}, ${f1(glass.rpg)} per game.`);
  const creator = [...reg].sort((a, b) => b.apg - a.apg)[0];
  if (creator) notes.push(`Main playmaker: ${creator.name}, ${f1(creator.apg)} assists per game.`);
  return notes;
}

const factorRow = (label, k, kd, hint) => `<tr><th scope="row">${label}${hint ? ` <span class="muted">${hint}</span>` : ''}</th>
<td class="num">${f1(curTeam[k])} ${rankTag(curTeam.ranks[k])}</td><td class="num muted">${f1(lg(k))}</td>
<td class="num">${kd ? `${f1(curTeam[kd])} ${rankTag(curTeam.ranks[kd])}` : '–'}</td><td class="num muted">${kd ? f1(lg(kd)) : '–'}</td></tr>`;
let curTeam;

for (const t of teams) {
  curTeam = t;
  const list = teamGames(games, t.code);
  const qa = quarterAverages(list);
  const roster = players.filter((p) => p.team === t.code).sort((a, b) => b.totalMin - a.totalMin);
  const notes = scoutNotes(t, roster, qa);
  const last5 = list.slice(0, 5).map((g) => (g.win ? 'W' : 'L')).join(' ');
  const form = list.slice(0, 5).reverse().map((g) => `<span class="form ${g.win ? 'w' : 'l'}" title="${g.win ? 'Win' : 'Loss'} ${g.isHome ? 'vs' : 'at'} ${esc(g.opp.tv)} ${g.for}–${g.against}">${g.win ? 'W' : 'L'}</span>`).join('');
  const best = Object.entries(t.ranks).filter(([k]) => ['ortg', 'drtg', 'net', 'efg', 'efgD', 'tov100D', 'orebPct', 'drebPct', 'threePct', 'twoPct'].includes(k)).sort((a, b) => a[1] - b[1])[0];
  const LBL = { ortg: 'offense', drtg: 'defense', net: 'net rating', efg: 'shooting (eFG%)', efgD: 'shooting defense', tov100D: 'forcing turnovers', orebPct: 'offensive rebounding', drebPct: 'defensive rebounding', threePct: '3-point shooting', twoPct: '2-point shooting' };
  const nameOf = new Map(players.map((q) => [q.id, q.name]));
  const short = (id) => { const n = nameOf.get(id) || id; const parts = n.split(' '); return parts.length > 1 ? parts.slice(1).join(' ') : n; };
  const sg = (v) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
  let lineupCard = '', onoffTeamCard = '';
  if (PBP) {
    const L = PBP.lineups.filter((l) => l.team === t.code && l.secs >= 300).sort((a, b) => b.secs - a.secs).slice(0, 12);
    if (L.length) lineupCard = `<section class="card"><h2>Lineups</h2><p class="muted">Five-man groups with at least 5 minutes together, most used first. Ratings are points per 100 possessions.</p>
<div class="scroll"><table><thead><tr><th scope="col">Lineup</th><th scope="col" class="num">MIN</th><th scope="col" class="num">Poss</th><th scope="col" class="num">ORtg</th><th scope="col" class="num">DRtg</th><th scope="col" class="num">Net</th></tr></thead><tbody>
${L.map((l) => { const o = l.poss ? 100 * l.pf / l.poss : 0, d = l.poss ? 100 * l.pa / l.poss : 0; return `<tr><td class="team">${l.ids.map((id) => `<a href="${playerHref(id)}">${esc(short(id))}</a>`).join('<span class="muted"> · </span>')}</td><td class="num">${f1(l.secs / 60)}</td><td class="num">${Math.round(l.poss)}</td><td class="num">${f1(o)}</td><td class="num">${f1(d)}</td><td class="num ${o - d >= 0 ? 'pos' : 'neg'}">${sg(o - d)}</td></tr>`; }).join('')}
</tbody></table></div><p class="muted small">Lineups with few minutes swing a lot from game to game. Treat them as clues, not verdicts. <a href="lineups.html?team=${encodeURIComponent(t.code)}"><strong>Open the full lineups tool →</strong></a></p></section>`;
    const R = roster.map((q) => ({ q, oo: onOffOf(q.id), imp: IMPACT?.values.get(q.id) })).filter((x) => x.oo);
    if (R.length) onoffTeamCard = `<section class="card"><h2>With and without</h2><p class="muted">Team margin per 100 possessions with each player on the court and on the bench (games he played), and his impact rating.</p>
<div class="scroll"><table><thead><tr><th scope="col">Player</th><th scope="col" class="num">MIN on</th><th scope="col" class="num">On</th><th scope="col" class="num">Off</th><th scope="col" class="num">Swing</th><th scope="col" class="num">Impact</th></tr></thead><tbody>
${R.map(({ q, oo, imp }) => `<tr><td><a href="${playerHref(q.id)}">${esc(q.name)}</a></td><td class="num">${Math.round(oo.onMin)}</td><td class="num">${sg(oo.onNet)}</td><td class="num">${sg(oo.offNet)}</td><td class="num ${oo.swing == null ? '' : oo.swing >= 0 ? 'pos' : 'neg'}">${sg(oo.swing)}</td><td class="num">${imp == null ? '–' : sg(imp)}</td></tr>`).join('')}
</tbody></table></div></section>`;
  }
  const BOXK = ['pts', 'fgm2', 'fga2', 'fgm3', 'fga3', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'tov', 'blk', 'blka', 'pf', 'fd', 'pir'];
  const boxJson = JSON.stringify({
    keys: BOXK,
    players: Object.fromEntries(players.filter((q) => list.some((g) => (g.isHome ? games.find((x) => x.gameCode === g.gameCode).home : games.find((x) => x.gameCode === g.gameCode).away).players.some((pl) => pl.id === q.id))).map((q) => [q.id, [q.name, playerHref(q.id)]])),
    games: list.map((g) => {
      const gm = games.find((x) => x.gameCode === g.gameCode), me = g.isHome ? gm.home : gm.away;
      return { h: g.isHome ? 1 : 0, w: g.win ? 1 : 0, d: g.date, o: g.opp.tv,
        team: BOXK.map((k) => me.totals[k]), min: me.teamMinutes || 200, pm: g.for - g.against,
        p: me.players.filter((pl) => pl.min > 0).map((pl) => [pl.id, pl.starter ? 1 : 0, +pl.min.toFixed(2), pl.pm, ...BOXK.map((k) => pl[k])]) };
    })
  }).replace(/</g, '\\u003c');
  const teamHero = cover({
    crumbs: `<a href="teams.html">Teams</a> / Scouting report`,
    kicker: best && best[1] <= 3 ? `${ord(best[1])} in the league in ${LBL[best[0]]}` : `${ord(t.rank)} in the standings`,
    title: esc(titleCase(t.name)),
    meta: `<span>${t.w}–${t.l}</span><span class="sep">/</span><span>${ord(t.rank)} in the standings</span><span class="sep">/</span><span>Home ${t.home} · Away ${t.away}</span><span class="sep">/</span><span class="formrow">${form}</span>`,
    strip: [[f1(t.ortg), `ORtg · ${ord(t.ranks.ortg)}`], [f1(t.drtg), `DRtg · ${ord(t.ranks.drtg)}`], [signed(t.net), `Net · ${ord(t.ranks.net)}`], [f1(t.pace), `Pace · ${ord(t.ranks.pace)}`]],
    side: coverCrest(t.code),
    actions: `<a class="btn white" href="team-${safe(t.code)}-report.html">Generate team report</a>${SPLITS.filter((x) => x.team === t.code).map((x) => ` <a class="btn white" href="${splitHref(x)}">${esc(x.title || 'Before and after')}</a>`).join('')}${WL_SPECS.filter((x) => x.team === t.code).map((x) => ` <a class="btn white" href="${x.href}">Wins vs losses</a>`).join('')}${t.code === HAP_GAME_CODE ? ` <a class="btn white" href="team-${safe(t.code)}-benchmark.html">Against the top 10</a>` : ''}`
  });
  // ---- Printable team report ----
  {
    const sp = TEAM_SPLITS[t.code] || {};
    const todayISO = new Date().toISOString().slice(0, 10);
    const pctS = (m, a) => (a ? f1(100 * m / a) : '–');
    const rk = (k) => (t.ranks?.[k] ? `<span class="rk ${t.ranks[k] <= 3 ? 'rk-top' : t.ranks[k] > N - 3 ? 'rk-bot' : ''}">${ord(t.ranks[k])}</span>` : '');
    const stat = (label, v, k) => `<div class="rs"><span>${label}</span><b>${v}</b>${k ? rk(k) : ''}</div>`;
    const gameOf = (code) => games.find((x) => x.gameCode === code);
    // Last 5 games for "form" stats and starting fives
    const last5 = list.slice(0, 5);
    const last5Lines = new Map();
    for (const g of last5) { const gm = gameOf(g.gameCode), me = g.isHome ? gm.home : gm.away; for (const p of me.players) { if (!(p.min > 0)) continue; if (!last5Lines.has(p.id)) last5Lines.set(p.id, { gp: 0, min: 0, pts: 0, pir: 0 }); const a = last5Lines.get(p.id); a.gp++; a.min += p.min; a.pts += p.pts; a.pir += p.pir; } }
    const starters = last5.map((g) => { const gm = gameOf(g.gameCode), me = g.isHome ? gm.home : gm.away; return { g, ids: me.players.filter((p) => p.starter).map((p) => p.id) }; });
    const startCount = new Map(); for (const s of starters) for (const id of s.ids) startCount.set(id, (startCount.get(id) || 0) + 1);
    const startKey = (ids) => [...ids].sort().join(',');
    const sameFive = starters.length ? starters.filter((s) => startKey(s.ids) === startKey(starters[0].ids)).length : 0;
    const nm = (id) => nameOf.get(id) || id;
    // Personnel
    const R = roster.filter((p) => p.gp > 0).map((p) => {
      const person = findPerson(peopleIndex, p), s = p.totals, oo = onOffOf(p.id), imp = IMPACT?.values.get(p.id), l5 = last5Lines.get(p.id), rt = RATES.get(p.id);
      return { p, person, s, oo, imp, l5, rt, age: person ? ageOn(person.birthDate, todayISO) : null };
    });
    const per = (v, gp) => (gp ? f1(v / gp) : '–');
    const keyPoints = (x) => {
      const { p, s, rt } = x, out = [];
      const tpa = s.fga3 / p.gp, fta = s.fta / p.gp, astTo = s.tov ? s.ast / s.tov : s.ast;
      if (tpa >= 4) out.push(`Volume 3-pt shooter: ${f1(tpa)} attempts a game at ${pctS(s.fgm3, s.fga3)}%`);
      else if (tpa >= 2 && s.fga3 >= 15 && 100 * s.fgm3 / s.fga3 >= 40) out.push(`Efficient from three: ${pctS(s.fgm3, s.fga3)}% on ${f1(tpa)} a game`);
      else if (p.mpg >= 15 && tpa < 0.7) out.push('Rarely shoots threes — plays inside the arc');
      if (fta >= 4) out.push(`Gets to the line: ${f1(fta)} FTA a game (${pctS(s.ftm, s.fta)}%)`);
      if (s.fta >= 15 && 100 * s.ftm / s.fta < 65) out.push(`Weak free-throw shooter: ${pctS(s.ftm, s.fta)}% — foul candidate`);
      if (p.apg >= 4 && astTo >= 2) out.push(`Playmaker: ${f1(p.apg)} assists, ${f1(astTo)} AST/TO`);
      else if (p.tpg >= 2.5) out.push(`Turnover-prone: ${f1(p.tpg)} a game`);
      if (rt && rt.drebPct >= 20 && p.mpg >= 12) out.push(`Strong defensive rebounder: ${f1(rt.drebPct)}% DREB`);
      if (rt && rt.blkPct >= 4 && p.mpg >= 10) out.push(`Rim protector: ${f1(rt.blkPct)}% block rate`);
      if (rt && rt.stlPct >= 2.5 && p.mpg >= 10) out.push(`Active hands: ${f1(rt.stlPct)}% steal rate`);
      if (p.usg >= 26) out.push(`High usage: ${f1(p.usg)}% of possessions when on the court`);
      if (x.l5 && x.l5.gp >= 3 && p.gp >= 6) { const d = x.l5.pts / x.l5.gp - p.ppg; if (d >= 4) out.push(`Hot: ${f1(x.l5.pts / x.l5.gp)} pts a game in the last 5 (season ${f1(p.ppg)})`); if (d <= -4) out.push(`Cold: ${f1(x.l5.pts / x.l5.gp)} pts a game in the last 5 (season ${f1(p.ppg)})`); }
      if (x.oo?.swing != null && x.oo.onMin >= 80 && Math.abs(x.oo.swing) >= 12) out.push(`Team is ${x.oo.swing > 0 ? 'much better' : 'much worse'} with him on the court (${sg(x.oo.swing)} per 100)`);
      return out.slice(0, 4);
    };
    // Lineups and pairs from the play-by-play
    const teamStints = pbpOk.flatMap(({ game, stints }) => (game.home.code === t.code || game.away.code === t.code) ? stints.map((s) => ({ game, s })) : []);
    const units = (k) => {
      const m = new Map();
      const combos = (ids) => { const r = []; const rec = (st, acc) => { if (acc.length === k) { r.push(acc); return; } for (let i = st; i < ids.length; i++) rec(i + 1, [...acc, ids[i]]); }; rec(0, []); return r; };
      for (const { game, s } of teamStints) {
        const home = game.home.code === t.code, ids = home ? s.home : s.away, me = t.code, op = home ? game.away.code : game.home.code, poss = (s.possH + s.possA) / 2;
        for (const c of combos(ids)) { const key = c.join(','); if (!m.has(key)) m.set(key, { ids: c, secs: 0, poss: 0, pf: 0, pa: 0, g: new Set() }); const e = m.get(key); e.secs += s.secs; e.poss += poss; e.pf += s.pts[me]; e.pa += s.pts[op]; e.g.add(game.gameCode); }
      }
      return [...m.values()].map((e) => ({ ...e, ortg: e.poss ? 100 * e.pf / e.poss : 0, drtg: e.poss ? 100 * e.pa / e.poss : 0 })).map((e) => ({ ...e, net: e.ortg - e.drtg }));
    };
    const L5 = units(5), L2 = units(2), L3 = units(3);
    const uRow = (u, i) => `<tr><td class="num muted">${i + 1}</td><td>${u.ids.map((id) => esc(nm(id))).join('<span class="muted"> · </span>')}</td><td class="num">${u.g.size}</td><td class="num">${f1(u.secs / 60)}</td><td class="num">${Math.round(u.poss)}</td><td class="num">${u.pf}–${u.pa}</td><td class="num">${f1(u.ortg)}</td><td class="num">${f1(u.drtg)}</td><td class="num ${u.net >= 0 ? 'pos' : 'neg'}">${sg(u.net)}</td></tr>`;
    const uTable = (arr) => arr.length ? `<table class="rtab"><thead><tr><th>#</th><th>Players</th><th class="num">GP</th><th class="num">MIN</th><th class="num">Poss</th><th class="num">Score</th><th class="num">ORtg</th><th class="num">DRtg</th><th class="num">Net</th></tr></thead><tbody>${arr.map(uRow).join('')}</tbody></table>` : '<p class="muted">Not enough data.</p>';
    const byMin = (arr, n) => [...arr].sort((a, b) => b.secs - a.secs).slice(0, n);
    const byNet = (arr, n, minPoss, dir) => arr.filter((u) => u.poss >= minPoss).sort((a, b) => dir * (b.net - a.net)).slice(0, n);
    const upcomingT = upcoming.filter((x) => x.h.code === t.code || x.a.code === t.code).slice(0, 5);
    // Wins vs losses, league comparison, Hapoel comparison
    const myGames = games.filter((g) => g.home.code === t.code || g.away.code === t.code);
    const won = (g) => (g.home.code === t.code ? g.home.score > g.away.score : g.away.score > g.home.score);
    const wG = myGames.filter(won), lG = myGames.filter((g) => !won(g));
    const tWin = splitOf(t.code, wG), tLoss = splitOf(t.code, lG);
    const dv = (k, v) => (v == null || !Number.isFinite(v) ? '–' : k === 'net' ? sg(v) : f1(v));
    const better = (good, a, b) => (good == null || a == null || b == null || Math.abs(a - b) < 0.05 ? '' : (good ? a > b : a < b) ? 'pos' : 'neg');
    const wlTable = `<table class="rtab"><thead><tr><th>Stat</th><th class="num">In wins (${wG.length})</th><th class="num">In losses (${lG.length})</th><th class="num">Difference</th></tr></thead><tbody>
${CMP.map(([label, k, good]) => { const a = tWin?.[k], b = tLoss?.[k]; const d = a != null && b != null ? a - b : null; return `<tr><td>${label}</td><td class="num ${better(good, a, b)}">${dv(k, a)}</td><td class="num">${dv(k, b)}</td><td class="num">${d == null ? '–' : sg(d)}</td></tr>`; }).join('')}
</tbody></table>`;
    const pW = new Map(playerTable(wG).filter((p) => p.team === t.code).map((p) => [p.id, p])), pL = new Map(playerTable(lG).filter((p) => p.team === t.code).map((p) => [p.id, p]));
    const wlPlayers = roster.filter((p) => p.gp > 0 && (pW.has(p.id) || pL.has(p.id))).map((p) => ({ p, w: pW.get(p.id), l: pL.get(p.id) }));
    const wlPlayerTable = `<table class="rtab tight"><thead><tr><th>Player</th><th class="num">GP W/L</th><th class="num">MIN W</th><th class="num">MIN L</th><th class="num">PTS W</th><th class="num">PTS L</th><th class="num">TS% W</th><th class="num">TS% L</th><th class="num">REB W</th><th class="num">REB L</th><th class="num">AST W</th><th class="num">AST L</th><th class="num">TOV W</th><th class="num">TOV L</th><th class="num">PIR W</th><th class="num">PIR L</th><th class="num">+/- W</th><th class="num">+/- L</th></tr></thead><tbody>
${wlPlayers.map(({ p, w, l }) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${w?.gp || 0}/${l?.gp || 0}</td>${[['mpg'], ['ppg'], ['ts'], ['rpg'], ['apg'], ['tpg'], ['pirpg'], ['pmpg', true]].map(([k, sgn]) => `<td class="num">${w ? (sgn ? sg(w[k]) : f1(w[k])) : '–'}</td><td class="num">${l ? (sgn ? sg(l[k]) : f1(l[k])) : '–'}</td>`).join('')}</tr>`).join('')}
</tbody></table>`;
    const lgTable = `<table class="rtab"><thead><tr><th>Stat</th><th class="num">${esc(titleCase(t.name))}</th><th class="num">League avg</th><th class="num">Difference</th><th class="num">Rank</th></tr></thead><tbody>
${CMP.map(([label, k, good]) => { const a = t[k], b = lg(k), d = a - b; return `<tr><td>${label}</td><td class="num ${better(good, a, b)}">${dv(k, a)}</td><td class="num muted">${dv(k, b)}</td><td class="num">${sg(d)}</td><td class="num">${t.ranks?.[k] ? rk(k) : '–'}</td></tr>`; }).join('')}
</tbody></table>`;
    const isHap = HAP?.same && t.code === HAP_CODE;
    const hapTable = HAP && !isHap ? `<table class="rtab"><thead><tr><th>Stat</th><th class="num">${esc(titleCase(t.name))}</th><th class="num">${esc(HAP.label)}</th><th class="num">Difference</th><th>Edge</th></tr></thead><tbody>
<tr><td>Record</td><td class="num">${t.w}–${t.l}</td><td class="num">${HAP.t.w}–${HAP.t.l}</td><td></td><td></td></tr>
${CMP.map(([label, k, good]) => { const a = t[k], b = HAP.t[k]; if (b == null) return ''; const d = a - b, cls = better(good, a, b); return `<tr><td>${label}</td><td class="num ${cls}">${dv(k, a)}</td><td class="num">${dv(k, b)}</td><td class="num">${sg(d)}</td><td class="small">${good == null ? '' : cls === 'pos' ? esc(titleCase(t.name)) : cls === 'neg' ? 'Hapoel' : 'Even'}</td></tr>`; }).join('')}
</tbody></table>${HAP.same ? '' : '<p class="muted small">Hapoel does not play in this league, so its EuroLeague numbers are used. Different leagues: compare styles, not levels.</p>'}` : '';
    const lineupsWL = (() => {
      if (!PBP) return '';
      const sub = (set) => { const m = new Map(); for (const { game, s } of teamStints) { if (!set.has(game.gameCode)) continue; const home = game.home.code === t.code, ids = home ? s.home : s.away, op = home ? game.away.code : game.home.code, poss = (s.possH + s.possA) / 2; const key = ids.join(','); if (!m.has(key)) m.set(key, { ids, secs: 0, poss: 0, pf: 0, pa: 0, g: new Set() }); const e = m.get(key); e.secs += s.secs; e.poss += poss; e.pf += s.pts[t.code]; e.pa += s.pts[op]; e.g.add(game.gameCode); } return [...m.values()].map((e) => ({ ...e, ortg: e.poss ? 100 * e.pf / e.poss : 0, drtg: e.poss ? 100 * e.pa / e.poss : 0 })).map((e) => ({ ...e, net: e.ortg - e.drtg })); };
      const W = sub(new Set(wG.map((g) => g.gameCode))), Ls = sub(new Set(lG.map((g) => g.gameCode)));
      return `<div class="r-two"><div><h3>Most used lineups in wins</h3>${uTable(byMin(W, 6))}</div><div><h3>Most used lineups in losses</h3>${uTable(byMin(Ls, 6))}</div></div>`;
    })();
    // Form: last 5 games against the season
    const l5Games = last5.map((x) => gameOf(x.gameCode)).filter(Boolean);
    const tL5 = l5Games.length ? splitOf(t.code, l5Games) : null;
    const formTable = tL5 ? `<table class="rtab"><thead><tr><th>Stat</th><th class="num">Last ${l5Games.length}</th><th class="num">Season</th><th class="num">Difference</th></tr></thead><tbody>
${CMP.map(([label, k, good]) => { const a = tL5?.[k], b = t[k]; if (a == null || b == null) return ''; return `<tr><td>${label}</td><td class="num ${better(good, a, b)}">${dv(k, a)}</td><td class="num muted">${dv(k, b)}</td><td class="num">${sg(a - b)}</td></tr>`; }).join('')}
</tbody></table>` : '';
    const l5Rows = last5.map((g) => { const gm = gameOf(g.gameCode); if (!gm) return ''; const me = g.isHome ? gm.home : gm.away, op = g.isHome ? gm.away : gm.home; const top = me.players.slice().sort((a, b) => b.pts - a.pts).slice(0, 3); const q = (side) => (side.quarters || []).join('-'); return `<tr><td>${esc(fmtDate(g.date))}</td><td>${g.isHome ? 'vs' : 'at'} ${esc(titleCase(g.opp.name))}</td><td class="${g.win ? 'pos' : 'neg'}"><a href="${gameHref(g.gameCode)}">${g.win ? 'W' : 'L'} ${g.for}–${g.against}</a></td><td class="small">${q(me)}${me.quarters ? ' <span class="muted">/</span> ' + q(op) : ''}</td><td class="small">${top.map((x) => `${esc(x.name)} ${x.pts}`).join(' · ')}</td></tr>`; }).join('');
    // Clutch and after timeouts for this team
    const ct = CLUTCH?.teams.find((x) => x.code === t.code);
    const ctR = ct ? situRates({ secs: ct.secs, poss: ct.poss, possD: ct.possD, pf: ct.pf, pa: ct.pa, box: ct.box, opp: ct.opp }) : null;
    const ctRank = ct ? 1 + (CLUTCH.teams.map((x) => situRates({ secs: x.secs, poss: x.poss, possD: x.possD, pf: x.pf, pa: x.pa, box: x.box, opp: x.opp }).net ?? -999).filter((v) => v > (ctR.net ?? -999)).length) : null;
    const ctPlayers = CLUTCH ? CLUTCH.players.filter((x) => x.team === t.code && x.secs >= 60).sort((a, b) => b.box.pts - a.box.pts || b.secs - a.secs).slice(0, 8) : [];
    const at = ATO?.find((x) => x.code === t.code);
    const atRank = at && at.off.n ? 1 + ATO.filter((x) => x.off.n && x.off.pts / x.off.n > at.off.pts / at.off.n).length : null;
    const situHtml = (ct || at) ? `${ct ? `<h3>Clutch <small class="muted">(last 5 min of Q4/OT, score within 5)</small></h3>
<div class="r-grid">${stat('Clutch games', `${ct.games} <small>(${ct.w}–${ct.l})</small>`)}${stat('Clutch minutes', f1(ctR.min))}${stat('Score in clutch', `${ct.pf}–${ct.pa}`)}${stat('Net rating', `${sg(ctR.net)} <span class="rk ${ctRank <= 3 ? 'rk-top' : ctRank > CLUTCH.teams.length - 3 ? 'rk-bot' : ''}">${ord(ctRank)}</span>`)}${stat('eFG% / Opp eFG%', `${f1(ctR.efg)} / ${f1(ctR.efgD)}`)}${stat('FT', `${ct.box.ftm}/${ct.box.fta}`)}</div>
${ctPlayers.length ? `<table class="rtab"><thead><tr><th>Player</th><th class="num">MIN</th><th class="num">PTS</th><th class="num">FG</th><th class="num">3P</th><th class="num">FT</th><th class="num">AST</th><th class="num">TOV</th><th class="num">+/-</th></tr></thead><tbody>${ctPlayers.map((x) => `<tr><td>${esc(nm(x.id))}</td><td class="num">${f1(x.secs / 60)}</td><td class="num"><strong>${x.box.pts}</strong></td><td class="num">${x.box.fgm2 + x.box.fgm3}/${x.box.fga2 + x.box.fga3}</td><td class="num">${x.box.fgm3}/${x.box.fga3}</td><td class="num">${x.box.ftm}/${x.box.fta}</td><td class="num">${x.box.ast}</td><td class="num">${x.box.tov}</td><td class="num ${x.pm >= 0 ? 'pos' : 'neg'}">${x.pm > 0 ? '+' : ''}${x.pm}</td></tr>`).join('')}</tbody></table>` : ''}` : ''}
${at && at.off.n ? `<h3>After timeouts</h3><div class="r-grid">${stat('Possessions after own timeout', at.off.n)}${stat('Points per possession', `${(at.off.pts / at.off.n).toFixed(2)} <span class="rk ${atRank <= 3 ? 'rk-top' : atRank > ATO.length - 3 ? 'rk-bot' : ''}">${ord(atRank)}</span>`)}${stat('Normal offense (PPP)', (t.ortg / 100).toFixed(2))}${stat('Scored on', `${(100 * at.off.scored / at.off.n).toFixed(0)}%`)}${stat('Turnovers', `${(100 * at.off.tov / at.off.n).toFixed(0)}%`)}${stat('3P after timeouts', `${at.off.fgm3}/${at.off.fga3}`)}${at.off.late.n ? stat('Last 2 minutes', `${at.off.late.pts} pts on ${at.off.late.n}`) : ''}${at.def.n ? stat('Allowed after opp. timeouts', (at.def.pts / at.def.n).toFixed(2) + ' PPP') : ''}</div>` : ''}` : '';
    // Rotation pattern: share of each minute on the court
    const rot = PBP ? rotationOf(pbpOk, t.code) : null;
    const rotPlayers = rot ? rot.players.filter((x) => x.mpg >= 3 && x.gp >= Math.min(3, rot.games)).sort((a, b) => (b.share[0] - a.share[0]) || (b.mpg - a.mpg)) : [];
    const rotHtml = rotPlayers.length ? `<div class="scroll"><table class="rot"><thead><tr><th>Player</th><th class="num">MIN</th>${Array.from({ length: 40 }, (_, m) => `<th class="rot-m${m % 10 === 0 ? ' rot-q' : ''}">${m % 10 === 0 ? 'Q' + (m / 10 + 1) : ''}</th>`).join('')}</tr></thead><tbody>
${rotPlayers.map((x) => `<tr><td>${esc(nm(x.id))}</td><td class="num">${f1(x.mpg)}</td>${x.share.map((v, m) => `<td class="rot-c${m % 10 === 0 ? ' rot-q' : ''}" style="--a:${Math.min(1, v).toFixed(2)}" title="${esc(nm(x.id))}, minute ${m + 1}: on the court in ${Math.round(100 * v)}% of games"></td>`).join('')}</tr>`).join('')}
</tbody></table></div><p class="muted small">Each square is one minute of a 40-minute game; the darker, the more often the player was on the court in that minute (${rot.games} games from the play-by-play). Starters first.</p>` : '';
    // Game flow: runs, points off turnovers, second chance, last minute of quarters
    const fl = FLOW?.find((x) => x.code === t.code);
    const flRank = (k, dir = 1) => { const arr = FLOW.map((x) => x[k] / (x.games || 1)).sort((a, b) => dir * (b - a)); return 1 + arr.indexOf(fl[k] / (fl.games || 1)); };
    const flAvg = (k) => FLOW.reduce((a, x) => a + x[k] / (x.games || 1), 0) / FLOW.length;
    const flRow = (label, k, kA, dir = 1) => { const v = fl[k] / fl.games, va = fl[kA] / fl.games, r = flRank(k, dir), ra = flRank(kA, -dir); const cls = (x, n) => (x <= 3 ? 'rk-top' : x > n - 3 ? 'rk-bot' : ''); return `<tr><td>${label}</td><td class="num">${f1(v)} <span class="rk ${cls(r, FLOW.length)}">${ord(r)}</span></td><td class="num">${f1(va)} <span class="rk ${cls(ra, FLOW.length)}">${ord(ra)}</span></td><td class="num muted">${f1(flAvg(k))}</td></tr>`; };
    const flowHtml = fl && fl.games ? `<table class="rtab"><thead><tr><th>Per game</th><th class="num">${esc(titleCase(t.name))}</th><th class="num">Opponents</th><th class="num">League avg</th></tr></thead><tbody>
${flRow('Points off turnovers', 'offTO', 'offTOA')}${flRow('Second-chance points', 'second', 'secondA')}${flRow('Points in the last minute of quarters', 'lastMin', 'lastMinA')}${flRow('Scoring runs of 8+ (unanswered)', 'runs', 'runsA')}
<tr><td>Biggest run</td><td class="num">${fl.best}–0</td><td class="num">${fl.bestA}–0</td><td></td></tr>
<tr><td>When its runs start</td><td colspan="3" class="small">${['Q1', 'Q2', 'Q3', 'Q4', 'OT'].map((q, i) => `${q}: <strong>${fl.runQ[i]}</strong>`).join(' · ')}</td></tr>
</tbody></table><p class="muted small">From the play-by-play (${fl.games} games). Ranks: 1st = most for the team's own column, fewest allowed for the opponents' column.</p>` : '';
    // Head-to-head with Hapoel (same league)
    const h2hGames = HAP?.same && t.code !== HAP_CODE ? myGames.filter((g) => g.home.code === HAP_CODE || g.away.code === HAP_CODE).sort((a, b) => a.date.localeCompare(b.date)) : [];
    const h2hNext = HAP?.same && t.code !== HAP_CODE ? upcoming.filter((x) => (x.h.code === t.code && x.a.code === HAP_CODE) || (x.a.code === t.code && x.h.code === HAP_CODE)) : [];
    let h2hHtml = '';
    if (h2hGames.length || h2hNext.length) {
      const rowsH = h2hGames.map((g) => { const me = g.home.code === t.code ? g.home : g.away, hp = g.home.code === t.code ? g.away : g.home; const top = (side) => side.players.slice().sort((a, b) => b.pts - a.pts).slice(0, 3).map((x) => `${esc(x.name)} ${x.pts}`).join(' · '); return `<tr><td>${esc(fmtDate(g.date))}</td><td>${g.home.code === t.code ? `${esc(t.tv)} vs Hapoel` : `Hapoel vs ${esc(t.tv)}`}</td><td class="${hp.score > me.score ? 'pos' : 'neg'}"><a href="${gameHref(g.gameCode)}">${hp.score > me.score ? 'Hapoel won' : 'Hapoel lost'} ${hp.score}–${me.score}</a></td><td class="small">${top(me)}</td><td class="small">${top(hp)}</td></tr>`; }).join('');
      const tH = h2hGames.length ? splitOf(t.code, h2hGames) : null, hH = h2hGames.length ? splitOf(HAP_CODE, h2hGames) : null;
      h2hHtml = `${rowsH ? `<table class="rtab"><thead><tr><th>Date</th><th>Game</th><th>Result</th><th>${esc(t.tv)} top scorers</th><th>Hapoel top scorers</th></tr></thead><tbody>${rowsH}</tbody></table>` : '<p>No meeting yet this season.</p>'}
${tH && hH ? `<h3>Team stats in these games</h3><table class="rtab"><thead><tr><th>Stat</th><th class="num">${esc(titleCase(t.name))}</th><th class="num">Hapoel</th></tr></thead><tbody>${CMP.map(([label, k, good]) => { const a = tH[k], b = hH[k]; if (a == null || b == null) return ''; return `<tr><td>${label}</td><td class="num ${better(good, a, b)}">${dv(k, a)}</td><td class="num ${better(good, b, a)}">${dv(k, b)}</td></tr>`; }).join('')}</tbody></table>` : ''}
${h2hNext.length ? `<p><strong>Next meeting:</strong> ${h2hNext.map((x) => `${timeTag(x)} · Rd ${x.r} · ${x.h.code === HAP_CODE ? 'Hapoel at home' : 'Hapoel away'}`).join(' / ')}</p>` : ''}`;
    }
    let secN = 0; const sec = (title) => `<h2>${++secN}. ${title}</h2>`;
    const body = `
<div class="report-bar no-print"><a href="${teamHref(t.code)}">← Back to team page</a><button type="button" class="btn" id="print-btn">Print / Save as PDF</button><span class="muted small">Tip: in the print window choose “Save as PDF”. Landscape fits the wide tables best.</span></div>
<article class="report">
<header class="r-head"><div class="r-id">${crests.has(t.code) ? `<img src="${esc(crests.get(t.code))}" alt="" width="64" height="64">` : ''}<div><div class="r-kicker">HTA LAB · Team report</div><h1>${esc(titleCase(t.name))}</h1>
<div class="r-meta">${esc(cfg.seasonLabel)} · ${t.w}–${t.l} · ${ord(t.rank)} in the standings · Home ${t.home} · Away ${t.away} · Last 5: ${list.slice(0, 5).map((g) => (g.win ? 'W' : 'L')).join(' ')}${sp.streak ? ` · Streak ${sp.streak}` : ''}</div></div></div>
<div class="r-date">Data through ${esc(fmtDate(info.lastDate))}<br>Generated ${esc(fmtDate(todayISO))}</div></header>

<section class="r-sec">${sec('Team profile')}
<div class="r-grid">
<div><h3>Ratings</h3>${stat('Offensive rating', f1(t.ortg), 'ortg')}${stat('Defensive rating', f1(t.drtg), 'drtg')}${stat('Net rating', sg(t.net), 'net')}${stat('Pace', f1(t.pace), 'pace')}${stat('Points', f1(t.ppg), 'ppg')}${stat('Points allowed', f1(t.oppg), 'oppg')}</div>
<div><h3>Four factors — offense</h3>${stat('eFG%', f1(t.efg), 'efg')}${stat('Turnovers / 100', f1(t.tov100), 'tov100')}${stat('Offensive reb %', f1(t.orebPct), 'orebPct')}${stat('Free-throw rate', f1(t.ftr), 'ftr')}<h3>Four factors — defense</h3>${stat('Opp eFG%', f1(t.efgD), 'efgD')}${stat('Forced TO / 100', f1(t.tov100D), 'tov100D')}${stat('Defensive reb %', f1(t.drebPct), 'drebPct')}${stat('Opp FT rate', f1(t.ftrD), 'ftrD')}${OFT.get(t.code)?.gp ? (() => { const arr = [...OFT.values()].filter((e) => e.gp).map((e) => e.drawn / e.gp).sort((a, b) => b - a); const v = OFT.get(t.code).drawn / OFT.get(t.code).gp; const r = arr.indexOf(v) + 1; return `<div class="rs"><span>Charges drawn / game</span><b>${v.toFixed(2)}</b><span class="rk ${r <= 3 ? 'rk-top' : r > arr.length - 3 ? 'rk-bot' : ''}">${ord(r)}</span></div>`; })() : ''}</div>
<div><h3>Shooting</h3>${stat('3-pt rate', f1(t.threeRate) + '%', 'threeRate')}${stat('3P%', f1(t.threePct), 'threePct')}${stat('2P%', f1(t.twoPct), 'twoPct')}${stat('FT%', f1(t.ftPct), 'ftPct')}${stat('True shooting', f1(t.ts), 'ts')}${stat('Assist rate', f1(t.astRate) + '%', 'astRate')}<h3>Opponent shooting</h3>${stat('Opp 3-pt rate', f1(t.threeRateD) + '%', 'threeRateD')}${stat('Opp 3P%', f1(t.threePctD), 'threePctD')}${stat('Opp 2P%', f1(t.twoPctD), 'twoPctD')}</div>
<div><h3>Splits</h3>${stat('Home', t.home)}${stat('Away', t.away)}${sp.close ? stat('Close games (≤5)', `${sp.close[0]}–${sp.close[1]}`) : ''}${sp.big ? stat('Decided by 10+', `${sp.big[0]}–${sp.big[1]}`) : ''}${sp.ot ? stat('Overtime', `${sp.ot[0]}–${sp.ot[1]}`) : ''}
${qa ? `<h3>By quarter (avg)</h3>${qa.map((q) => stat(`Q${q.q}`, `${f1(q.for)}–${f1(q.against)} <small class="${q.margin >= 0 ? 'pos' : 'neg'}">${sg(q.margin)}</small>`)).join('')}` : ''}</div>
</div>
<h3>Scouting notes</h3><ul class="r-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</section>

<section class="r-sec">${sec('Wins vs losses')}
<p class="muted small">How the team plays when it wins and when it loses (per game; ratings per 100 possessions). Green = better in that split.</p>
${wlTable}
<h3>Players in wins and losses</h3><div class="scroll">${wlPlayerTable}</div>
${lineupsWL}
</section>

<section class="r-sec">${sec('Compared with the league')}
<p class="muted small">Every key stat against the league average (${N} teams). Rank 1st = best in the league.</p>
${lgTable}
</section>

${hapTable ? `<section class="r-sec">${sec('Compared with Hapoel Tel Aviv')}
<p class="muted small">Side by side with Hapoel. Edge = which team is better in that stat.</p>
${hapTable}
</section>` : ''}

${h2hHtml ? `<section class="r-sec">${sec('Head-to-head with Hapoel')}
${h2hHtml}
</section>` : ''}

<section class="r-sec">${sec(`Starting five — last ${starters.length} games`)}
${sameFive === starters.length && starters.length > 1 ? `<p><strong>Same starting five in all ${starters.length} games.</strong></p>` : `<p>${sameFive} of the last ${starters.length} games with the most recent starting five.</p>`}
<table class="rtab"><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>Starters</th></tr></thead><tbody>
${starters.map(({ g, ids }) => `<tr><td>${esc(fmtDate(g.date))}</td><td>${g.isHome ? 'vs' : 'at'} ${esc(g.opp.tv)}</td><td class="${g.win ? 'pos' : 'neg'}">${g.win ? 'W' : 'L'} ${g.for}–${g.against}</td><td>${ids.map((id) => esc(nm(id))).join('<span class="muted"> · </span>')}</td></tr>`).join('')}
</tbody></table>
<p class="small"><strong>Starts in the last ${starters.length}:</strong> ${[...startCount].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(nm(id))} ${n}`).join(' · ')}<br><strong>Season starts:</strong> ${R.filter((x) => x.p.gs > 0).sort((a, b) => b.p.gs - a.p.gs).map((x) => `${esc(x.p.name)} ${x.p.gs}/${x.p.gp}`).join(' · ')}</p>
</section>

${(() => { const off = ALLSHOTS.filter((x) => x.team === t.code), def = ALLSHOTS.filter((x) => x.opp === t.code); return off.length ? `<section class="r-sec">${sec('Shot zones')}
<div class="r-two"><div><h3>Offense</h3>${courtSvg(off, { mode: 'zones', league: ALLSHOTS, title: 'Offense zones' })}</div><div><h3>Defense — opponents' shots</h3>${courtSvg(def, { mode: 'zones', league: ALLSHOTS, title: 'Defense zones' })}</div></div>
<table class="rtab"><thead><tr><th>Zone</th><th class="num">FG% (share)</th><th class="num">League FG% (share)</th><th class="num">Opp FG% (share)</th></tr></thead><tbody>${zoneRows(off, ALLSHOTS).map((r, i) => { const d = zoneRows(def, ALLSHOTS)[i]; const f = (x, sh) => (x == null ? '–' : `${x.toFixed(1)} <span class="muted">(${sh.toFixed(0)}%)</span>`); return `<tr><td>${r.label}</td><td class="num">${f(r.pct, r.share)}</td><td class="num muted">${f(r.lpct, r.lshare || 0)}</td><td class="num">${f(d.pct, d.share)}</td></tr>`; }).join('')}</tbody></table>
<p class="muted small">Red = better than the league average in that zone, blue = worse (for the defense chart: red = opponents shoot well there). ${off.length} shots for, ${def.length} against.</p>
</section>` : ''; })()}

${rotHtml ? `<section class="r-sec">${sec('Rotation pattern')}
${rotHtml}
</section>` : ''}

<section class="r-sec">${sec('Personnel')}
<div class="scroll"><table class="rtab tight"><thead><tr><th>#</th><th>Player</th><th>Pos</th><th class="num">Ht</th><th class="num">Age</th><th class="num">GP/GS</th><th class="num">MIN</th><th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th><th class="num">STL</th><th class="num">BLK</th><th class="num">TOV</th><th class="num">2P</th><th class="num">3P</th><th class="num">3PA</th><th class="num">FT%</th><th class="num">FTA</th><th class="num">TS%</th><th class="num">USG%</th><th class="num">PIR</th><th class="num">+/-</th><th class="num" title="Team net per 100 with him on minus off">On/off</th><th class="num">Impact</th><th class="num" title="Last 5 games: minutes / points">Last 5</th></tr></thead><tbody>
${R.map((x) => { const { p, s, person, oo, imp, l5 } = x; return `<tr><td class="num muted">${esc(p.number || person?.dorsal || '')}</td><td><strong>${esc(p.name)}</strong>${p.teams.length > 1 ? ' <span class="muted small">(traded)</span>' : ''}</td><td>${esc((person?.position || '').slice(0, 1))}</td><td class="num">${person?.height || '–'}</td><td class="num">${x.age ?? '–'}</td><td class="num">${p.gp}/${p.gs}</td><td class="num">${f1(p.mpg)}</td><td class="num"><strong>${f1(p.ppg)}</strong></td><td class="num">${f1(p.rpg)}</td><td class="num">${f1(p.apg)}</td><td class="num">${f1(p.spg)}</td><td class="num">${f1(p.bpg)}</td><td class="num">${f1(p.tpg)}</td><td class="num">${pctS(s.fgm2, s.fga2)}</td><td class="num">${pctS(s.fgm3, s.fga3)}</td><td class="num">${per(s.fga3, p.gp)}</td><td class="num">${pctS(s.ftm, s.fta)}</td><td class="num">${per(s.fta, p.gp)}</td><td class="num">${f1(p.ts)}</td><td class="num">${f1(p.usg)}</td><td class="num">${f1(p.pirpg)}</td><td class="num">${sg(p.pmpg)}</td><td class="num">${oo?.swing == null ? '–' : sg(oo.swing)}</td><td class="num">${imp == null ? '–' : sg(imp)}</td><td class="num">${l5 ? `${f1(l5.min / l5.gp)} / ${f1(l5.pts / l5.gp)}` : '–'}</td></tr>`; }).join('')}
</tbody></table></div>
<p class="muted small">Per game. 2P/3P/FT are percentages; 3PA and FTA are attempts per game. On/off and impact (RAPM) are points per 100 possessions from the play-by-play.</p>
<h3>Player keys</h3>
<div class="r-keys">${R.filter((x) => x.p.mpg >= 8).map((x) => { const k = keyPoints(x); return `<div class="r-key"><strong>${esc(x.p.name)}</strong> <span class="muted">${esc(x.person?.position || '')}${x.p.number ? ` · #${esc(x.p.number)}` : ''} · ${f1(x.p.mpg)} min</span><ul>${(k.length ? k : ['No standout tendency in the numbers']).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`; }).join('')}</div>
</section>

${PBP ? `<section class="r-sec">${sec('Lineups')}
<h3>Most used five-man lineups</h3>${uTable(byMin(L5, 10))}
<div class="r-two"><div><h3>Best lineups <small class="muted">(30+ possessions)</small></h3>${uTable(byNet(L5, 5, 30, 1))}</div><div><h3>Worst lineups <small class="muted">(30+ possessions)</small></h3>${uTable(byNet(L5, 5, 30, -1))}</div></div>
<div class="r-two"><div><h3>Most used pairs</h3>${uTable(byMin(L2, 10))}</div><div><h3>Most used trios</h3>${uTable(byMin(L3, 10))}</div></div>
<div class="r-two"><div><h3>Best pairs <small class="muted">(100+ possessions)</small></h3>${uTable(byNet(L2, 5, 100, 1))}</div><div><h3>Worst pairs <small class="muted">(100+ possessions)</small></h3>${uTable(byNet(L2, 5, 100, -1))}</div></div>
<p class="muted small">From ${new Set(teamStints.map((x) => x.game.gameCode)).size} of ${list.length} games where the official play-by-play matches the box score exactly. ORtg/DRtg = points scored/allowed per 100 possessions.</p>
</section>` : ''}

${l5Rows ? `<section class="r-sec">${sec(`Form — last ${l5Games.length} games`)}
<table class="rtab"><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>Quarters (team / opp)</th><th>Top scorers</th></tr></thead><tbody>${l5Rows}</tbody></table>
${formTable ? `<h3>Last ${l5Games.length} games against the season</h3>${formTable}` : ''}
</section>` : ''}

${situHtml || flowHtml ? `<section class="r-sec">${sec('Game flow, clutch and after timeouts')}
${flowHtml ? `<h3>Game flow</h3>${flowHtml}` : ''}
${situHtml}
<p class="muted small">From the games whose official play-by-play matches the box score. Ratings per 100 possessions.</p>
</section>` : ''}

<section class="r-sec">${sec(`Results${upcomingT.length ? ' and schedule' : ''}`)}
<table class="rtab"><thead><tr><th>Date</th><th>Rd</th><th>Opponent</th><th>Result</th><th>Top scorer</th></tr></thead><tbody>
${list.map((g) => { const gm = gameOf(g.gameCode), me = g.isHome ? gm.home : gm.away, top = me.players.slice().sort((a, b) => b.pts - a.pts)[0]; return `<tr><td>${esc(fmtDate(g.date))}</td><td class="num">${g.round}</td><td>${g.isHome ? 'vs' : 'at'} ${esc(titleCase(g.opp.name))}</td><td class="${g.win ? 'pos' : 'neg'}">${g.win ? 'W' : 'L'} ${g.for}–${g.against}</td><td>${top ? `${esc(top.name)} ${top.pts}` : ''}</td></tr>`; }).join('')}
</tbody></table>
${upcomingT.length ? `<h3>Next games</h3><table class="rtab"><tbody>${upcomingT.map((x) => { const home = x.h.code === t.code, o = home ? x.a : x.h; return `<tr><td>${timeTag(x)}</td><td>Rd ${x.r}</td><td>${home ? 'vs' : 'at'} ${esc(titleCase(o.name || o.code))}</td><td class="muted">${esc(titleCase(x.venue || ''))}</td></tr>`; }).join('')}</tbody></table>` : ''}
</section>
<footer class="r-foot">HTA LAB · Official box scores and play-by-play (${esc(cfg.leagueName)}), checked before publishing · hta-lab.github.io</footer>
</article>`;
    writePage(`team-${safe(t.code)}-report.html`, `${titleCase(t.name)} — team report`, body, 'teams.html', '', { scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script>` });
  }
  writePage(teamHref(t.code), titleCase(t.name), `
<div class="row">
<section class="card"><h2>Scouting notes</h2><p class="muted">Generated from this season's box scores. Ranks are out of ${N} teams.</p>
<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>
<section class="card"><h2>Ratings</h2>
<div class="kpis">
<div><span class="muted">Offense</span><strong>${f1(t.ortg)}</strong>${rankTag(t.ranks.ortg)}</div>
<div><span class="muted">Defense</span><strong>${f1(t.drtg)}</strong>${rankTag(t.ranks.drtg)}</div>
<div><span class="muted">Net</span><strong class="${t.net >= 0 ? 'pos' : 'neg'}">${signed(t.net)}</strong>${rankTag(t.ranks.net)}</div>
<div><span class="muted">Pace</span><strong>${f1(t.pace)}</strong>${rankTag(t.ranks.pace)}</div>
</div>
${qa ? `<h3>Scoring by quarter <span class="muted">(per game)</span></h3>
<div class="scroll"><table><thead><tr><th scope="col"></th>${qa.map((x) => `<th scope="col" class="num">Q${x.q}</th>`).join('')}</tr></thead><tbody>
<tr><th scope="row">Scored</th>${qa.map((x) => `<td class="num">${f1(x.for)}</td>`).join('')}</tr>
<tr><th scope="row">Allowed</th>${qa.map((x) => `<td class="num">${f1(x.against)}</td>`).join('')}</tr>
<tr><th scope="row">Margin</th>${qa.map((x) => `<td class="num ${x.margin >= 0 ? 'pos' : 'neg'}">${signed(x.margin)}</td>`).join('')}</tr>
</tbody></table></div>` : ''}
</section></div>
<section class="card"><h2>Four factors and shooting</h2><p class="muted">Ranks: 1st = best in the league. On defense, "best" means the lowest value for opponents.</p>
<div class="scroll"><table class="factors"><thead><tr><th scope="col"></th><th scope="col" class="num">Offense</th><th scope="col" class="num">League avg</th><th scope="col" class="num">Defense (opponents)</th><th scope="col" class="num">League avg</th></tr></thead><tbody>
${factorRow('Effective FG%', 'efg', 'efgD')}
${factorRow('Turnovers per 100', 'tov100', 'tov100D', '(defense: forced)')}
${factorRow('Offensive rebound %', 'orebPct', null)}
${factorRow('Defensive rebound %', 'drebPct', null)}
${factorRow('Free throws per 100 shots', 'ftr', 'ftrD')}
${factorRow('Share of shots that are threes', 'threeRate', 'threeRateD')}
${factorRow('3P%', 'threePct', 'threePctD')}
${factorRow('2P%', 'twoPct', 'twoPctD')}
${factorRow('FT%', 'ftPct', null)}
${factorRow('Assisted baskets %', 'astRate', null)}
</tbody></table></div></section>
<section class="card"><h2>Season box score</h2><p class="muted">Every player's cumulative stats for this team. Filter by home, away, wins or losses, switch totals and per game, and click any column to sort from highest to lowest.</p>
<div id="teambox-app"><noscript><div><p class="muted">Sorted by total minutes played. Season stats for players whose most recent game was for this team.</p>
<div class="scroll"><table><thead><tr>${['Player', 'GP', 'GS', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'TOV', 'PIR', 'USG%', 'TS%', '3PA', '3P%', 'FT%'].map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>
${roster.map((p) => `<tr><td><a href="${playerHref(p.id)}">${esc(p.name)}</a></td><td class="num">${p.gp}</td><td class="num">${p.gs}</td><td class="num">${f1(p.mpg)}</td><td class="num">${f1(p.ppg)}</td><td class="num">${f1(p.rpg)}</td><td class="num">${f1(p.apg)}</td><td class="num">${f1(p.spg)}</td><td class="num">${f1(p.tpg)}</td><td class="num">${f1(p.pirpg)}</td><td class="num">${f1(p.usg)}</td><td class="num">${f1(p.ts)}</td><td class="num">${f1(p.threeApg)}</td><td class="num">${f1(p.threePct)}</td><td class="num">${f1(p.ftPct)}</td></tr>`).join('')}
</tbody></table></div></div>
</noscript><p class="muted">Loading…</p></div></section>
<script type="application/json" id="teambox-data">${boxJson}</script>
${onoffTeamCard}${PBP ? `<section class="lu-embed"><h2 class="sec-title">All lineups</h2><p class="muted">Every five-man unit and 2-, 3- and 4-man combination this team has used. Filter by home/away, wins/losses and dates.</p><div id="lineups-app" data-team="${esc(t.code)}" data-lock="1" data-min-poss="0"><p class="muted">Loading lineups…</p></div></section>` : ""}
${(() => { const up = upcoming.filter((x) => x.h.code === t.code || x.a.code === t.code); return up.length ? `<section class="card"><h2>Upcoming games</h2>
<div class="scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Rd</th><th scope="col"></th><th scope="col">Opponent</th><th scope="col">Venue</th><th scope="col"></th></tr></thead><tbody>
${up.map((x) => { const home = x.h.code === t.code, o = home ? x.a : x.h; return `<tr><td>${timeTag(x)}</td><td class="num">${x.r}</td><td class="muted">${home ? 'vs' : 'at'}</td><td><a href="${teamHref(o.code)}">${badge(o.code, o.tv)} ${esc(titleCase(o.name || o.code))}</a></td><td class="muted">${esc(titleCase(x.venue || ''))}</td><td>${IS_EL ? `<a href="live.html?game=${Number(x.c)}">Follow live ›</a>` : ''}</td></tr>`; }).join('')}
</tbody></table></div></section>` : ''; })()}
${(() => { const off = ALLSHOTS.filter((x) => x.team === t.code), def = ALLSHOTS.filter((x) => x.opp === t.code); return off.length ? `<section class="card" id="shots"><h2>Shot chart</h2><div class="seg" role="group" aria-label="Side"><button type="button" data-shots="off" aria-pressed="true">Offense</button><button type="button" data-shots="def" aria-pressed="false">Defense (opponents' shots)</button></div><div data-shots-pane="off">${shotBlock(off, { title: t.name + ' offense' })}</div><div data-shots-pane="def" hidden>${shotBlock(def, { title: t.name + ' defense', note: 'Where opponents shoot against this team, and how well, compared with the league.' })}</div></section>` : ''; })()}
<section class="card staff-notes"><h2>Staff notes</h2><p class="muted">Private notes on ${esc(titleCase(t.name))}, kept encrypted in Hapoel Internal.</p><p><a class="btn" href="${cfg.root || ''}internal-upload.html?cat=${encodeURIComponent('Team note')}&title=${encodeURIComponent(titleCase(t.name))}&opp=${encodeURIComponent(titleCase(t.name))}">Add a note</a> <a class="btn ghost" href="${cfg.root || ''}internal.html?q=${encodeURIComponent(titleCase(t.name))}">Read notes</a></p></section>
<section class="card"><h2>Results</h2>
<div class="scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Rd</th><th scope="col"></th><th scope="col">Opponent</th><th scope="col">Result</th></tr></thead><tbody>
${list.map((g) => `<tr><td>${esc(g.date)}</td><td class="num">${g.round}</td><td class="muted">${g.isHome ? 'vs' : 'at'}</td><td><a href="${teamHref(g.opp.code)}">${badge(g.opp.code, g.opp.tv)} ${esc(titleCase(g.opp.name))}</a></td><td><a class="${g.win ? 'pos' : 'neg'}" href="${gameHref(g.gameCode)}">${g.win ? 'W' : 'L'} ${g.for}–${g.against} ›</a></td></tr>`).join('')}
</tbody></table></div></section>`, 'teams.html', teamHero, { scripts: `<script src="teambox.js?v=${assetVersion()}" defer></script>${PBP ? `<script src="lineups.js?v=${assetVersion()}" defer></script>` : ''}` });
}

// ---- Player pages ----
{
  const matched = players.filter((p) => findPerson(peopleIndex, p)).length;
  console.log(`Player details matched for ${matched} of ${players.length} players`);
  const missing = players.filter((p) => !findPerson(peopleIndex, p)).slice(0, 10).map((p) => `${p.name} (${p.id})`);
  if (missing.length && peopleIndex.byId.size) console.log('  No details for: ' + missing.join(', ') + (players.length - matched > 10 ? ', …' : ''));
}
const logs = playerGameLogs(games);
// Season trend: per game bars and a 3-game rolling average, for points, minutes, PIR and true shooting.
function trendSvg(log) {
  const L = [...log].sort((a, b) => String(a.date).localeCompare(String(b.date))).filter((g) => g.line.min > 0);
  if (L.length < 4) return '';
  const series = [['Points', (l) => l.pts], ['Minutes', (l) => l.min], ['PIR', (l) => l.pir], ['True shooting %', (l) => { const a = l.fga2 + l.fga3 + 0.44 * l.fta; return a ? 100 * l.pts / (2 * a) : null; }]];
  const W = 520, H = 130, P = 26;
  const chart = ([label, f]) => {
    const v = L.map((g) => f(g.line));
    const nums = v.filter((x) => x != null), max = Math.max(...nums, 1), min = Math.min(0, ...nums);
    const xs = (i) => P + (i + 0.5) * (W - P - 6) / L.length, ys = (x) => H - 18 - (H - 30) * (x - min) / (max - min || 1);
    const roll = v.map((_, i) => { const w = v.slice(Math.max(0, i - 2), i + 1).filter((x) => x != null); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null; });
    const bw = Math.max(3, (W - P - 6) / L.length - 3);
    const avg = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
    const first = nums.slice(0, Math.ceil(nums.length / 2)), last = nums.slice(Math.ceil(nums.length / 2));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1), dir = mean(last) - mean(first);
    return `<figure class="trend"><figcaption><strong>${label}</strong> <span class="muted small">season ${avg.toFixed(1)} · 2nd half of games ${dir >= 0 ? '▲' : '▼'} ${Math.abs(dir).toFixed(1)}</span></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} game by game">
<line x1="${P}" x2="${W - 4}" y1="${ys(avg).toFixed(1)}" y2="${ys(avg).toFixed(1)}" class="tr-avg"/>
${v.map((x, i) => (x == null ? '' : `<rect x="${(xs(i) - bw / 2).toFixed(1)}" y="${ys(Math.max(x, min)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, ys(min) - ys(x)).toFixed(1)}" class="tr-bar${L[i].win ? '' : ' tr-l'}"><title>${esc(L[i].date)} ${L[i].isHome ? 'vs' : 'at'} ${esc(L[i].opp.tv)}: ${x.toFixed(label === 'Minutes' || label.startsWith('True') ? 1 : 0)}</title></rect>`)).join('')}
<polyline class="tr-roll" points="${roll.map((x, i) => (x == null ? '' : `${xs(i).toFixed(1)},${ys(x).toFixed(1)}`)).filter(Boolean).join(' ')}"/>
<text x="2" y="${ys(max) + 4}" class="tr-ax">${max.toFixed(0)}</text><text x="2" y="${H - 14}" class="tr-ax">${min.toFixed(0)}</text>
</svg></figure>`;
  };
  return `<section class="card" id="trend"><h2>Season trend</h2><p class="muted">Game by game (red = win, grey = loss), with the 3-game rolling average (line) and the season average (dashed). Hover a bar for the game.</p><div class="trend-grid">${series.map(chart).join('')}</div></section>`;
}
const today = new Date().toISOString().slice(0, 10);
const pct = (m, a) => (a > 0 ? f1(100 * m / a) : '–');
const per = (v, gp) => f1(gp ? v / gp : 0);
const RANK_KEYS = [['ppg', 'Points'], ['rpg', 'Rebounds'], ['apg', 'Assists'], ['spg', 'Steals'], ['bpg', 'Blocks'], ['pirpg', 'PIR'], ['pra', 'PRA'], ['ts', 'TS%'], ['usg', 'Usage']];
const qualRank = {};
for (const [k] of RANK_KEYS) {
  const sorted = [...qual].sort((a, b) => b[k] - a[k]);
  sorted.forEach((p, i) => { (qualRank[p.id] ||= {})[k] = i + 1; });
}

function boxCells(s, gp, perGame) {
  const v = (x) => (perGame ? per(x, gp) : String(x));
  return [v(s.pts), v(s.fgm2), v(s.fga2), pct(s.fgm2, s.fga2), v(s.fgm3), v(s.fga3), pct(s.fgm3, s.fga3), v(s.ftm), v(s.fta), pct(s.ftm, s.fta),
    v(s.oreb), v(s.dreb), v(s.reb), v(s.ast), v(s.stl), v(s.tov), v(s.blk), v(s.blka), v(s.pf), v(s.fd), v(s.pir)];
}
const BOX_HEAD = ['PTS', '2PM', '2PA', '2P%', '3PM', '3PA', '3P%', 'FTM', 'FTA', 'FT%', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'TOV', 'BLK', 'BLKA', 'PF', 'FD', 'PIR'];
const th = (h) => `<th scope="col" class="num">${h}</th>`;

const posOf = new Map(players.map((q) => [q.id, findPerson(peopleIndex, q)?.position || null]));
for (const p of players) {
  const person = findPerson(peopleIndex, p);
  const log = logs.get(p.id) || [];
  const s = p.totals, gp = p.gp;
  const age = person ? ageOn(person.birthDate, today) : null;
  const teamT = teams.find((t) => t.code === p.team);
  const fga = s.fga2 + s.fga3, fgm = s.fgm2 + s.fgm3;
  const per40 = (x) => f1(p.totalMin ? 40 * x / p.totalMin : 0);
  const high = (key, label) => {
    const best = [...log].sort((a, b) => b.line[key] - a.line[key])[0];
    return best ? `<div><dt>${label}</dt><dd>${best.line[key]}</dd><span class="muted small">${best.isHome ? 'vs' : 'at'} ${esc(best.opp.tv)}, ${esc(best.date)}</span></div>` : '';
  };
  const bio = [
    ['Team', teamT ? `<a href="${teamHref(p.team)}">${badge(p.team, p.tv)}${esc(titleCase(teamT.name))}</a>` : esc(p.tv)],
    ['Number', esc(person?.dorsal || p.number || '–')],
    ['Position', esc(person?.position || '–')],
    ['Age', age != null ? `${age} <span class="muted">(born ${esc(fmtDate(person.birthDate))})</span>` : '–'],
    ['Height', person?.height ? `${person.height} cm` : '–'],
    ['Weight', person?.weight ? `${person.weight} kg` : '–'],
    ['Nationality', esc(person?.country || '–') + (person?.birthCountry && person.birthCountry !== person.country ? ` <span class="muted">(born in ${esc(person.birthCountry)})</span>` : '')]
  ];
  const ranks = qualRank[p.id];

  // ---- infographic sections ----
  const position = person?.position || null;
  const peersAll = position ? qual.filter((q) => (posOf.get(q.id) || null) === position) : [];
  const peers = peersAll.length >= 10 ? peersAll : qual;
  const peerLabel = peersAll.length >= 10 ? `${position.toLowerCase()}s` : 'players';
  const isQual = qual.some((q) => q.id === p.id);
  const r = qualRank[p.id] || {};
  const LBLS = { ppg: 'points', rpg: 'rebounds', apg: 'assists', spg: 'steals', bpg: 'blocks', pirpg: 'PIR', pra: 'PRA', ts: 'true shooting' };
  const tops = Object.entries(r).filter(([k, v]) => LBLS[k] && v <= 10).sort((a, b) => a[1] - b[1]);
  const firsts = tops.filter(([, v]) => v === 1).map(([k]) => LBLS[k]);
  const kicker = firsts.length ? `1st in the league in ${firsts.slice(0, 2).join(' and ')}`
    : tops.length ? `${ord(tops[0][1])} in the league in ${LBLS[tops[0][0]]}`
    : esc([position, p.tv].filter(Boolean).join(' · '));
  const wonWith = log.filter((g) => g.win).length;
  const ledeParts = [`Averages <strong>${f1(p.ppg)} points</strong>, ${f1(p.rpg)} rebounds and ${f1(p.apg)} assists in ${f1(p.mpg)} minutes, at ${f1(p.ts)}% true shooting.`,
    `His team is ${wonWith}–${log.length - wonWith} in the games he played.`];
  if (tops.length > 1) ledeParts.push(`Top 10 in the league in ${tops.slice(0, 3).map(([k, v]) => `${LBLS[k]} (${ord(v)})`).join(', ')}.`);
  const num = person?.dorsal || p.number;
  const hero = cover({
    crumbs: `<a href="players.html">Players</a> / <a href="${teamHref(p.team)}">${esc(p.tv)}</a>`,
    kicker, title: esc(p.name),
    meta: `${crests.has(p.team) ? `<img class="crest" src="${esc(crests.get(p.team))}" alt="">` : ''}<span>${esc(teamT ? titleCase(teamT.name) : p.tv)}</span>${position ? `<span class="sep">/</span><span>${esc(position)}</span>` : ''}${age != null ? `<span class="sep">/</span><span>${age} years</span>` : ''}${person?.height ? `<span class="sep">/</span><span>${person.height} cm</span>` : ''}${person?.country ? `<span class="sep">/</span><span>${esc(person.country)}</span>` : ''}`,
    lede: ledeParts.join(' '),
    actions: `<button type="button" id="share-btn" class="btn white">Download as image</button> <a class="btn white" href="${cfg.root || ''}compare.html#${LEAGUE}:${playerHref(p.id)}">Compare with…</a>`,
    side: num ? `<div class="side jersey" aria-hidden="true">${esc(String(num).replace(/^0+(?=\d)/, ''))}</div>` : coverCrest(p.team)
  });

  const chip = (k) => !isQual ? '<span class="chip">Not enough minutes yet</span>'
    : `<span class="chip ${r[k] <= 3 ? 'hot' : r[k] <= 20 ? 'warm' : ''}">${ord(r[k])} in the league</span>`;
  const fourth = [['rpg', 'Rebounding', 'rebounds per game'], ['apg', 'Playmaking', 'assists per game'], ['stocks', 'Defense', 'steals + blocks per game']]
    .map((x) => ({ x, rank: isQual ? (qualRank[p.id]?.[x[0]] ?? [...qual].sort((a, b) => b[x[0]] - a[x[0]]).findIndex((q) => q.id === p.id) + 1) : 0 }))
    .sort((a, b) => a.rank - b.rank)[0].x;
  if (isQual && r[fourth[0]] == null) r[fourth[0]] = [...qual].sort((a, b) => b[fourth[0]] - a[fourth[0]]).findIndex((q) => q.id === p.id) + 1;
  const oo = onOffOf(p.id), imp = IMPACT?.values.get(p.id);
  const rankIn = (map) => { if (!isQual || map == null) return null; const list = qual.map((q) => [q.id, map(q)]).filter(([, v]) => v != null).sort((x, y) => y[1] - x[1]); const i = list.findIndex(([id]) => id === p.id); return i < 0 ? null : { r: i + 1, n: list.length }; };
  const chipR = (rk) => !rk ? '<span class="chip">Not enough minutes yet</span>' : `<span class="chip ${rk.r <= 3 ? 'hot' : rk.r <= 20 ? 'warm' : ''}">${ord(rk.r)} in the league</span>`;
  const sgn = (v) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
  const tiles = (oo && imp != null) ? `<div class="tiles">
<div class="tile"><span class="label">Scoring</span><span class="big">${f1(p.ppg)}</span><span class="sub">points per game</span>${chip('ppg')}</div>
<div class="tile"><span class="label">Impact rating</span><span class="big">${sgn(imp)}</span><span class="sub">RAPM, points per 100 possessions</span>${chipR(rankIn((q) => IMPACT.values.get(q.id) ?? null))}</div>
<div class="tile"><span class="label">On / off swing</span><span class="big">${sgn(oo.swing)}</span><span class="sub">team margin per 100, on v off</span>${chipR(oo.swing == null ? null : rankIn((q) => onOffOf(q.id)?.swing ?? null))}</div>
<div class="tile"><span class="label">All-round</span><span class="big">${f1(p.pirpg)}</span><span class="sub">PIR per game</span>${chip('pirpg')}</div>
</div>` : `<div class="tiles">
<div class="tile"><span class="label">Scoring</span><span class="big">${f1(p.ppg)}</span><span class="sub">points per game</span>${chip('ppg')}</div>
<div class="tile"><span class="label">All-round</span><span class="big">${f1(p.pirpg)}</span><span class="sub">PIR per game</span>${chip('pirpg')}</div>
<div class="tile"><span class="label">Efficiency</span><span class="big">${f1(p.ts)}</span><span class="sub">true shooting %</span>${chip('ts')}</div>
<div class="tile"><span class="label">${fourth[1]}</span><span class="big">${f1(p[fourth[0]])}</span><span class="sub">${fourth[2]}</span>${chip(fourth[0])}</div>
</div>`;
  const teamShort = esc(teamT ? titleCase(teamT.name) : p.tv);
  const onoffCard = (oo && oo.onNet != null && oo.offNet != null) ? (() => {
    const max = Math.max(10, Math.abs(oo.onNet), Math.abs(oo.offNet));
    const bar = (v) => `<div class="oo-track"><span class="oo-mid"></span><span class="oo-fill ${v >= 0 ? 'up' : 'down'}" style="${v >= 0 ? 'left:50%' : `right:50%`};width:${(50 * Math.abs(v) / max).toFixed(1)}%"></span></div>`;
    return `<section class="card oo"><h2>${teamShort} with him, and without him</h2><p class="muted">Points the team wins or loses by per 100 possessions, in the games he played.</p>
<div class="oo-row"><div><strong>On the floor</strong><span class="muted small">${Math.round(oo.onMin)} minutes</span></div>${bar(oo.onNet)}<span class="oo-val ${oo.onNet >= 0 ? 'pos' : 'neg'}">${sgn(oo.onNet)}</span></div>
<div class="oo-row"><div><strong>On the bench</strong><span class="muted small">${Math.round(oo.offMin)} minutes</span></div>${bar(oo.offNet)}<span class="oo-val ${oo.offNet >= 0 ? 'pos' : 'neg'}">${sgn(oo.offNet)}</span></div>
${oo.offMin < 30 ? '<p class="muted small">Few bench minutes so far, so the "without him" number is a small sample.</p>' : ''}</section>`;
  })() : '';

  // Game by game: last 10 games, oldest left
  const recent = log.slice(0, 10).reverse();
  let gbg = '';
  if (recent.length) {
    const W = 640, H = 250, top = 34, base = 180, max = Math.max(10, ...recent.map((g) => g.line.pts));
    const slot = W / recent.length, bw = Math.min(56, slot * 0.62);
    const bars = recent.map((g, i) => {
      const l = g.line, h = Math.max(3, (l.pts / max) * (base - top)), x = i * slot + (slot - bw) / 2;
      const fgm = l.fgm2 + l.fgm3, fga = l.fga2 + l.fga3;
      return `<g><title>${esc(g.date)} ${g.isHome ? 'vs' : 'at'} ${esc(g.opp.tv)}: ${l.pts} points, ${fgm}/${fga} FG, ${g.win ? 'win' : 'loss'} ${g.for}–${g.against}</title>
<rect class="${g.win ? 'b-win' : 'b-loss'}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4"/>
<text class="v" x="${(x + bw / 2).toFixed(1)}" y="${(base - h - 8).toFixed(1)}" text-anchor="middle">${l.pts}</text>
<text class="o" x="${(x + bw / 2).toFixed(1)}" y="${base + 20}" text-anchor="middle">${esc(g.opp.tv)}</text>
<text class="f" x="${(x + bw / 2).toFixed(1)}" y="${base + 35}" text-anchor="middle">${fgm}/${fga} FG</text>
<text class="f" x="${(x + bw / 2).toFixed(1)}" y="${base + 49}" text-anchor="middle">${g.win ? 'Win' : 'Loss'}</text></g>`;
    }).join('');
    const last3 = log.slice(0, 3);
    const l3pts = last3.reduce((a, g) => a + g.line.pts, 0) / (last3.length || 1);
    const l3m = last3.reduce((a, g) => a + g.line.fgm2 + g.line.fgm3, 0), l3a = last3.reduce((a, g) => a + g.line.fga2 + g.line.fga3, 0);
    const l3w = last3.filter((g) => g.win).length;
    gbg = `<section class="card gbg"><h2>Game by game</h2><p class="muted">Points in his last ${recent.length} games. Last ${last3.length}: ${f1(l3pts)} a night on ${l3a ? f1(100 * l3m / l3a) : '–'}% shooting, ${l3w} win${l3w === 1 ? '' : 's'}. Red = win.</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Points per game, last ${recent.length} games">${bars}<line class="base" x1="0" x2="${W}" y1="${base}" y2="${base}"/></svg></section>`;
  }

  // Percentiles against players at the same position
  const PCT = [['ppg', 'Points'], ['rpg', 'Rebounds'], ['apg', 'Assists'], ['stocks', 'Stocks'], ['pirpg', 'PIR'], ['ts', 'TS%'], ['threePct', '3P%', (q) => q.totals.fga3 >= 15], ['usg', 'Usage'], ['tpg', 'Ball security', null, true]];
  const pctl = PCT.map(([k, label, filt, low]) => {
    const pool = peers.filter(filt || (() => true));
    if (!pool.some((q) => q.id === p.id) && !(isQual === false && (!filt || filt(p)))) return '';
    const vals = [...pool.filter((q) => q.id !== p.id).map((q) => q[k])];
    if (!vals.length) return '';
    const below = vals.filter((v) => (low ? v > p[k] : v < p[k])).length;
    const pc = Math.round(100 * below / vals.length);
    return `<div class="p"><span>${label}</span><span class="track" role="img" aria-label="${label}: better than ${pc}% of ${peerLabel}"><span class="fill" style="width:${Math.max(3, pc)}%"></span></span><span>${pc}<small>${f1(p[k])}</small></span></div>`;
  }).join('');
  const pctlCard = pctl ? `<section class="card"><h2>Profile vs ${esc(peerLabel)}</h2><p class="muted">Percentile: better than this share of ${peers.length} qualified ${esc(peerLabel)}. The line marks the middle.${isQual ? '' : ' He has not played enough minutes to qualify yet.'}</p><div class="pctl">${pctl}</div></section>` : '';

  // How he stacks up against the best at his position
  const SC = [['ppg', 'PPG'], ['rpg', 'RPG'], ['apg', 'APG'], ['pirpg', 'PIR'], ['ts', 'TS%'], ['usg', 'USG%']];
  const stackList = [...peers].sort((a, b) => b.pirpg - a.pirpg).slice(0, 5);
  if (!stackList.some((q) => q.id === p.id)) stackList.push(p);
  const bestIn = Object.fromEntries(SC.map(([k]) => [k, Math.max(...stackList.map((q) => q[k]))]));
  const stack = `<section class="card"><h2>How he stacks up</h2><p class="muted">The top 5 ${esc(peerLabel)} by PIR${stackList.length > 5 ? `, plus ${esc(p.name)}` : ''}. Red marks the best in each column.</p>
<div class="scroll"><table><thead><tr><th scope="col">Player</th>${SC.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join('')}</tr></thead><tbody>
${stackList.map((q) => `<tr${q.id === p.id ? ' class="me"' : ''}><td><a href="${playerHref(q.id)}">${badge(q.team, q.tv)}${esc(q.name)}</a></td>${SC.map(([k]) => `<td class="num">${q[k] === bestIn[k] ? `<span class="best">${f1(q[k])}</span>` : f1(q[k])}</td>`).join('')}</tr>`).join('')}
</tbody></table></div></section>`;

  const tileData = (oo && imp != null)
    ? [['Scoring', f1(p.ppg), 'points per game', isQual ? r.ppg : null], ['Impact', sgn(imp), 'RAPM per 100 poss', rankIn((q) => IMPACT.values.get(q.id) ?? null)?.r], ['On / off', sgn(oo.swing), 'margin per 100, on v off', oo.swing == null ? null : rankIn((q) => onOffOf(q.id)?.swing ?? null)?.r], ['All-round', f1(p.pirpg), 'PIR per game', isQual ? r.pirpg : null]]
    : [['Scoring', f1(p.ppg), 'points per game', isQual ? r.ppg : null], ['All-round', f1(p.pirpg), 'PIR per game', isQual ? r.pirpg : null], ['Efficiency', f1(p.ts), 'true shooting %', isQual ? r.ts : null], [fourth[1], f1(p[fourth[0]]), fourth[2], isQual ? r[fourth[0]] : null]];
  const shareJson = JSON.stringify({
    site: cfg.siteName, season: `${cfg.seasonLabel}, ${roundLine.toLowerCase()}`, kicker: kicker.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&'), name: p.name, number: num ? String(num).replace(/^0+(?=\d)/, '') : '',
    crest: crests.get(p.team) || null,
    meta: [teamT ? titleCase(teamT.name) : p.tv, position, age != null ? `${age} years` : null].filter(Boolean).join('  ·  '),
    lede: `Averages ${f1(p.ppg)} points, ${f1(p.rpg)} rebounds and ${f1(p.apg)} assists in ${f1(p.mpg)} minutes, at ${f1(p.ts)}% true shooting. His team is ${wonWith}–${log.length - wonWith} when he plays.`,
    tiles: tileData.map(([label, value, sub, rk]) => ({ label, value, sub, rank: rk ? `${ord(rk)} in the league` : '', hot: rk != null && rk <= 3 })),
    games: log.slice(0, 8).reverse().map((g) => ({ pts: g.line.pts, opp: g.opp.tv, win: g.win })),
    gbgNote: `Points in his last ${Math.min(8, log.length)} games. Red = win.`,
    footer: `Calculated from ${cfg.sourceText} and play-by-play.`,
    file: `${p.name.replace(/[^A-Za-z0-9]+/g, '-')}-HTA-LAB.png`
  }).replace(/</g, '\\u003c');
  writePage(`player-${safe(p.id)}.html`, p.name, `
${tiles}
<div class="row">${onoffCard}${gbg}</div>
<div class="row">${pctlCard}</div>
${stack}
<div class="row">
<section class="card"><h2>Profile</h2><dl class="bio">${bio.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
${person ? '' : '<p class="muted small">Personal details are not available for this player in the official roster feed.</p>'}</section>
<section class="card"><h2>League ranks</h2>${ranks ? `<p class="muted">Among ${qual.length} players with enough minutes.</p><div class="kpis">${RANK_KEYS.map(([k, l]) => `<div><span class="muted">${l}</span><strong>${k === 'ts' || k === 'usg' ? f1(p[k]) + '%' : f1(p[k])}</strong>${rankTag(ranks[k], qual.length)}</div>`).join('')}</div>` : `<p class="muted">${esc(qualNote)} This player doesn't qualify yet.</p>`}</section>
</div>
<section class="card"><h2>Season stats</h2>
<div class="scroll"><table><thead><tr><th scope="col"></th>${th('GP')}${th('GS')}${th('MIN')}${BOX_HEAD.map(th).join('')}${th('+/-')}</tr></thead><tbody>
<tr><th scope="row">Per game</th><td class="num">${gp}</td><td class="num">${p.gs}</td><td class="num">${f1(p.mpg)}</td>${boxCells(s, gp, true).map((c) => `<td class="num">${c}</td>`).join('')}<td class="num">${signed(p.pmpg)}</td></tr>
<tr><th scope="row">Totals</th><td class="num">${gp}</td><td class="num">${p.gs}</td><td class="num">${f1(p.totalMin)}</td>${boxCells(s, gp, false).map((c) => `<td class="num">${c}</td>`).join('')}<td class="num">${p.totalPm > 0 ? '+' : ''}${p.totalPm}</td></tr>
<tr><th scope="row">Per 40 min</th><td class="num">–</td><td class="num">–</td><td class="num">40.0</td>${[s.pts, s.fgm2, s.fga2, null, s.fgm3, s.fga3, null, s.ftm, s.fta, null, s.oreb, s.dreb, s.reb, s.ast, s.stl, s.tov, s.blk, s.blka, s.pf, s.fd, s.pir].map((x, i) => `<td class="num">${x === null ? boxCells(s, gp, true)[i] : per40(x)}</td>`).join('')}<td class="num">${per40(p.totalPm)}</td></tr>
</tbody></table></div></section>
<div class="row">
<section class="card"><h2>Shooting and efficiency</h2><dl class="bio">
${[['FG%', pct(fgm, fga) + ` <span class="muted">(${fgm}/${fga})</span>`], ['2P%', pct(s.fgm2, s.fga2) + ` <span class="muted">(${s.fgm2}/${s.fga2})</span>`], ['3P%', pct(s.fgm3, s.fga3) + ` <span class="muted">(${s.fgm3}/${s.fga3})</span>`], ['FT%', pct(s.ftm, s.fta) + ` <span class="muted">(${s.ftm}/${s.fta})</span>`],
    ['True shooting %', f1(p.ts)], ['Effective FG%', f1(p.efg)], ['Usage rate %', f1(p.usg)], ['Share of shots that are threes', pct(s.fga3, fga)], ['Free throws per 100 shots', fga ? f1(100 * s.fta / fga) : '–'],
    ['Assists per turnover', s.tov ? (s.ast / s.tov).toFixed(2) : '–'], ['PRA per game', f1(p.pra)], ['Stocks per game', f1(p.stocks)]]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
</dl></section>
<section class="card"><h2>Season highs</h2><dl class="bio highs">${high('pts', 'Points')}${high('reb', 'Rebounds')}${high('ast', 'Assists')}${high('fgm3', 'Threes made')}${high('stl', 'Steals')}${high('blk', 'Blocks')}${high('pir', 'PIR')}</dl></section>
</div>
${trendSvg(log)}<section class="card staff-notes"><h2>Staff notes</h2><p class="muted">Private notes on ${esc(p.name)} (team password needed). A note is saved on his scouting card and also in Hapoel Internal, under Player notes.</p><p><a class="btn" href="${cfg.root || ''}scouting.html?player=${encodeURIComponent((LEAGUE === 'el' ? 'EL' : cfg.poolCode) + ':' + p.id)}&note=1">Add a note</a> <a class="btn ghost" href="${cfg.root || ''}scouting.html?player=${encodeURIComponent((LEAGUE === 'el' ? 'EL' : cfg.poolCode) + ':' + p.id)}">Scouting card and notes</a> <a class="btn ghost" href="${cfg.root || ''}internal.html?q=${encodeURIComponent(p.name)}">Notes in Hapoel Internal</a></p></section>${(() => { const mine = ALLSHOTS.filter((x) => x.pid === p.id); return mine.length >= 10 ? `<section class="card" id="shots"><h2>Shot chart</h2><p class="muted">Every field-goal attempt this season from the official shot locations, and his shooting by zone against the league.</p>${shotBlock(mine, { title: p.name })}</section>` : ''; })()}
<section class="card"><h2>Game log</h2>
<div class="scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Rd</th><th scope="col">Opponent</th><th scope="col">Result</th>${['MIN', 'PTS', '2P', '3P', 'FT', 'REB', 'AST', 'STL', 'TOV', 'BLK', 'PF', '+/-', 'PIR'].map(th).join('')}</tr></thead><tbody>
${log.map((g) => { const l = g.line; return `<tr><td>${esc(g.date)}</td><td class="num">${g.round}</td><td><a href="${teamHref(g.opp.code)}"><span class="muted">${g.isHome ? 'vs' : 'at'}&nbsp;</span>${badge(g.opp.code, g.opp.tv)}${esc(g.opp.tv)}</a></td><td><a class="${g.win ? 'pos' : 'neg'}" href="${gameHref(g.gameCode)}">${g.win ? 'W' : 'L'} ${g.for}–${g.against} ›</a></td>
<td class="num">${mmss(l.min)}${l.starter ? '<span class="muted">*</span>' : ''}</td><td class="num"><strong>${l.pts}</strong></td><td class="num">${l.fgm2}/${l.fga2}</td><td class="num">${l.fgm3}/${l.fga3}</td><td class="num">${l.ftm}/${l.fta}</td><td class="num">${l.reb}</td><td class="num">${l.ast}</td><td class="num">${l.stl}</td><td class="num">${l.tov}</td><td class="num">${l.blk}</td><td class="num">${l.pf}</td><td class="num">${l.pm > 0 ? '+' : ''}${l.pm}</td><td class="num">${l.pir}</td></tr>`; }).join('')}
</tbody></table></div><p class="muted small">* started the game.</p></section>
<script type="application/json" id="share-data">${shareJson}</script>`, 'players.html', hero, { scripts: `<script src="share.js?v=${assetVersion()}" defer></script>` });
}

// Method page
writePage('method.html', 'How we calculate', `

<section class="card prose">
<h2>Where the data comes from</h2>
<p>${IS_EL ? "Each night the site downloads the box score of every finished game from the EuroLeague's live data feed, the same feed behind euroleaguebasketball.net." : 'Each night the site downloads the box score and play-by-play of every finished game from the league\'s official LiveStats files on basket.co.il, the same data behind the league\'s own game pages.'} All games are downloaded again every night, so any correction the league makes after a game is picked up.</p>
<h2>Accuracy checks</h2>
<p>Before the site is updated, every game must pass all of these checks. If one fails, the site keeps showing the previous day's numbers.</p>
<ul>
<li>The final score in the box score equals the official result.</li>
<li>Each player's points equal 2 × two-pointers + 3 × three-pointers + free throws.</li>
<li>Players' points, shots, rebounds, assists, steals, blocks, turnovers and fouls add up to the team total.</li>
<li>Players' minutes add up to 200 (plus 25 for each overtime).</li>
<li>No player made more shots than he attempted, and offensive + defensive rebounds equal total rebounds.</li>
<li>No game is counted twice, and no team is missing games.</li>
</ul>
<h2>Formulas</h2>
<dl>
<dt>Possessions</dt><dd>FGA − offensive rebounds + turnovers + 0.44 × FTA, averaged over both teams in the game.</dd>
<dt>Offensive rating (ORtg)</dt><dd>Points scored per 100 possessions.</dd>
<dt>Defensive rating (DRtg)</dt><dd>Points allowed per 100 possessions. Lower is better.</dd>
<dt>Net rating</dt><dd>ORtg − DRtg.</dd>
<dt>Pace</dt><dd>Possessions per 40 minutes.</dd>
<dt>True shooting % (TS%)</dt><dd>Points ÷ (2 × (FGA + 0.44 × FTA)). Counts threes and free throws fairly.</dd>
<dt>Effective FG% (eFG%)</dt><dd>(FGM + 0.5 × 3PM) ÷ FGA.</dd>
<dt>Usage rate (USG%)</dt><dd>Share of the team's plays a player finished while on the court: 100 × (FGA + 0.44 × FTA + TOV) × (team minutes ÷ 5) ÷ (player minutes × (team FGA + 0.44 × team FTA + team TOV)).</dd>
<dt>PIR</dt><dd>The official Performance Index Rating (VAL), taken directly from the box score.</dd>
<dt>PRA</dt><dd>Points + rebounds + assists per game.</dd>
<dt>Stocks</dt><dd>Steals + blocks per game.</dd>
</dl>
<h2>On/off, lineups and impact</h2>
<p>From the official play-by-play we track exactly which ten players are on the court at every moment. A game is only used if this reproduces the official final score and every player's official +/- and minutes; otherwise it is left out of these numbers.</p>
<dl>
<dt>On / off</dt><dd>The team's points scored minus points allowed per 100 possessions with the player on the court, and with him on the bench, in the games he played. The swing is the difference.</dd>
<dt>Lineups</dt><dd>The same, for each five-man group that played together.</dd>
<dt>Impact rating (RAPM)</dt><dd>Regularised adjusted plus-minus: a ridge regression over every stint of the season that estimates how many points per 100 possessions each player adds, after accounting for his teammates and opponents. It is pulled towards zero on purpose, so early in the season most values are small. Players with fewer than 150 possessions are not rated.</dd>
</dl>
<h2>Leaderboards</h2>
<p>${qualNote}</p>
</section>`, 'method.html', cover({ kicker: 'Methodology', title: 'How we calculate', lede: `Every number on this site comes from ${cfg.sourceText}. Nothing is typed in by hand, and every game is checked before it is published.` }));


// ---- Lineups tool data: one row per team, game and lineup (stints merged) ----
if (PBP) {
  const K = BOX_KEYS.filter((k) => k !== 'pts');
  const rows = new Map();
  for (const { game, stints } of pbpOk) {
    const A = game.home.code, B = game.away.code;
    for (const st of stints) {
      for (const [code, opp, ids, isHome, won] of [[A, B, st.home, 1, game.home.score > game.away.score ? 1 : 0], [B, A, st.away, 0, game.away.score > game.home.score ? 1 : 0]]) {
        const key = `${game.gameCode}|${code}|${ids.join(',')}`;
        if (!rows.has(key)) rows.set(key, { code, ids, g: game.gameCode, isHome, won, secs: 0, me: Object.fromEntries(K.map((k) => [k, 0])), op: Object.fromEntries(K.map((k) => [k, 0])) });
        const r = rows.get(key); r.secs += st.secs;
        for (const k of K) { r.me[k] += st.box[code][k]; r.op[k] += st.box[opp][k]; }
      }
    }
  }
  const usedIds = new Set([...rows.values()].flatMap((r) => r.ids));
  const out = {
    keys: K,
    players: Object.fromEntries(players.filter((q) => usedIds.has(q.id)).map((q) => [q.id, [q.name, q.tv, playerHref(q.id)]])),
    teams: Object.fromEntries(teams.map((t) => [t.code, [t.tv, titleCase(t.name), crests.get(t.code) || null, teamHref(t.code)]])),
    games: Object.fromEntries(pbpOk.map(({ game }) => [game.gameCode, [game.date, game.round]])),
    rows: [...rows.values()].map((r) => [r.code, r.ids.join(','), r.g, r.isHome, r.won, r.secs, ...K.map((k) => r.me[k]), ...K.map((k) => r.op[k])]),
    note: `${pbpOk.length} of ${rawPbp.size} games`
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'lineups.json'), JSON.stringify(out));
}
writePage('lineups.html', 'Lineups', `<div id="lineups-app"><p class="muted">Loading…</p></div>`, 'lineups.html',
  cover({ kicker: esc(roundLine), title: 'Lineups', lede: 'Every five-man unit, and every 2-, 3- and 4-man combination, built from the official play-by-play. Filter, sort any column, and switch between totals, per game, per 40 minutes and per 100 possessions.' }),
  { scripts: `<script src="lineups.js?v=${assetVersion()}" defer></script>` });

// ---- Live games (read from the official live feed in the browser) ----
if (IS_EL) writePage('live.html', 'Live', `<div id="live-app"><p class="muted">Connecting to the EuroLeague live feed…</p></div>
<script type="application/json" id="live-config">${JSON.stringify({
  season: cfg.seasonCode,
  firstCode: Math.max(0, ...games.map((g) => Number(g.gameCode) || 0)) + 1,
  schedule: upcoming.slice(0, 40).map((x) => ({ c: Number(x.c), r: x.r, utc: x.utc, ok: x.ok, venue: x.venue ? titleCase(x.venue) : '', h: x.h, a: x.a })),
  crests: Object.fromEntries([...crests]),
  players: Object.fromEntries(players.map((q) => [q.id, playerHref(q.id)]))
}).replace(/</g, '\\u003c')}</script>`, 'live.html',
  cover({ kicker: 'Live', title: 'Live games', lede: 'Follow any EuroLeague game as it happens: score, box scores, who is on the court, game flow and every play, straight from the official live feed.' }),
  { scripts: `<script type="module" src="live.js?v=${assetVersion()}"></script>` });

// ---- Charges drawn: every offensive foul of the season ----
if (OFE.length) {
  const used = new Set(OFE.flatMap((e) => [e.drawnBy, e.committedBy]).filter(Boolean));
  const data = {
    teams: Object.fromEntries(teams.map((t) => [t.code, [t.tv, titleCase(t.name), crests.get(t.code) || null, teamHref(t.code)]])),
    teamGp: Object.fromEntries([...OFT].map(([c, e]) => [c, e.gp])),
    players: Object.fromEntries(players.filter((q) => used.has(q.id)).map((q) => [q.id, [q.name, q.tv, playerHref(q.id), q.gp, Math.round(q.totalMin)]])),
    games: Object.fromEntries([...new Set(OFE.map((e) => e.g))].map((g) => [g.gameCode, [g.date, g.round, gameHref(g.gameCode), g.home.code, g.away.code, g.home.score, g.away.score]])),
    ev: OFE.map((e) => { const draw = e.side === 'H' ? e.g.home.code : e.g.away.code, com = e.side === 'H' ? e.g.away.code : e.g.home.code; return [e.g.gameCode, e.period, e.clock, draw, e.drawnBy, com, e.committedBy, e.hs, e.as]; })
  };
  writePage('charges.html', 'Charges drawn', `<div id="charges-app"><p class="muted">Loading…</p></div>
<script type="application/json" id="charges-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`, HOME,
    cover({ kicker: esc(roundLine), title: 'Charges drawn', lede: `Every offensive foul of the season — ${OFE.length} in ${new Set(OFE.map((e) => e.g.gameCode)).size} games — with who drew it, who committed it, when and the score. The league's play-by-play records charges, illegal screens and push-offs all as "offensive foul", so all three are included.` }),
    { scripts: `<script src="charges.js?v=${assetVersion()}" defer></script>` });
}

// ---- Referees: every referee of the season, and Hapoel's record with each ----
const refName = (r) => (/[A-Za-z]/.test(r) ? formatName(r) : r);
const REFS = (() => {
  const m = new Map();
  for (const g of games) for (const r0 of g.refs || []) {
    const r = refName(r0); if (!m.has(r)) m.set(r, { name: r, games: [], hapW: 0, hapL: 0 });
    const e = m.get(r); e.games.push(g);
    if (HAP_GAME_CODE && (g.home.code === HAP_GAME_CODE || g.away.code === HAP_GAME_CODE)) { const me = g.home.code === HAP_GAME_CODE ? g.home : g.away, op = me === g.home ? g.away : g.home; if (me.score > op.score) e.hapW++; else e.hapL++; }
  }
  return [...m.values()].sort((a, b) => b.games.length - a.games.length || a.name.localeCompare(b.name));
})();
if (!REFS.length) writePage('referees.html', 'Referees', '<section class="card"><p class="muted">This league\'s data does not list the referees.</p></section>', HOME, cover({ kicker: esc(roundLine), title: 'Referees', lede: 'Referee data is not available for this league.' }));
if (REFS.length) {
  const avg = (list, f) => list.reduce((s, g) => s + f(g), 0) / (list.length || 1);
  const fouls = (g) => g.home.totals.pf + g.away.totals.pf, fta = (g) => g.home.totals.fta + g.away.totals.fta, pts = (g) => g.home.score + g.away.score;
  const lg = { f: avg(games, fouls), t: avg(games, fta), p: avg(games, pts), h: 100 * games.filter((g) => g.home.score > g.away.score).length / (games.length || 1) };
  const cell = (v, txt, base, hiIsMore = true) => `<td class="num ${base != null && Math.abs(v - base) >= 0.1 * base ? (v > base ? 'ref-hi' : 'ref-lo') : ''}" data-v="${v}">${txt}</td>`;
  const rows = REFS.map((r) => { const n = r.games.length, F = avg(r.games, fouls), T = avg(r.games, fta), P = avg(r.games, pts), H = 100 * r.games.filter((g) => g.home.score > g.away.score).length / n; const hg = r.hapW + r.hapL;
    return `<tr><td data-v="${esc(r.name)}"><strong>${esc(r.name)}</strong></td><td class="num" data-v="${n}">${n}</td>${cell(F, F.toFixed(1), lg.f)}${cell(T, T.toFixed(1), lg.t)}${cell(P, P.toFixed(1), lg.p)}${cell(H, H.toFixed(0) + '%', lg.h)}<td class="num" data-v="${hg ? r.hapW / hg + hg / 1000 : -1}">${hg ? `<span class="${r.hapW >= r.hapL ? 'pos' : 'neg'}"><strong>${r.hapW}–${r.hapL}</strong></span>` : '–'}</td></tr>`; }).join('');
  // Hapoel games, one line per game, with the crew
  const hapGames = HAP_GAME_CODE ? games.filter((g) => g.home.code === HAP_GAME_CODE || g.away.code === HAP_GAME_CODE).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const hapRows = hapGames.map((g) => { const me = g.home.code === HAP_GAME_CODE ? g.home : g.away, op = me === g.home ? g.away : g.home, w = me.score > op.score;
    return `<tr><td>${esc(fmtDate(g.date))}</td><td>${me === g.home ? 'vs' : 'at'} ${esc(titleCase(op.name))}</td><td class="${w ? 'pos' : 'neg'}"><a href="${gameHref(g.gameCode)}">${w ? 'W' : 'L'} ${me.score}–${op.score}</a></td><td class="small">${(g.refs || []).map((r) => esc(refName(r))).join(' · ') || '–'}</td><td class="num">${me.totals.pf}–${op.totals.pf}</td><td class="num">${me.totals.fta}–${op.totals.fta}</td></tr>`; }).join('');
  const hapByRef = REFS.filter((r) => r.hapW + r.hapL > 0).map((r) => { const hg = r.games.filter((g) => g.home.code === HAP_GAME_CODE || g.away.code === HAP_GAME_CODE); const side = (g) => (g.home.code === HAP_GAME_CODE ? [g.home, g.away] : [g.away, g.home]);
    const pf = avg(hg, (g) => side(g)[0].totals.pf), opf = avg(hg, (g) => side(g)[1].totals.pf), ft = avg(hg, (g) => side(g)[0].totals.fta), oft = avg(hg, (g) => side(g)[1].totals.fta);
    return `<tr><td><strong>${esc(r.name)}</strong></td><td class="num">${hg.length}</td><td class="num"><span class="${r.hapW >= r.hapL ? 'pos' : 'neg'}"><strong>${r.hapW}–${r.hapL}</strong></span></td><td class="num">${pf.toFixed(1)} – ${opf.toFixed(1)}</td><td class="num ${ft - oft >= 0 ? 'pos' : 'neg'}">${ft.toFixed(1)} – ${oft.toFixed(1)}</td></tr>`; }).join('');
  writePage('referees.html', 'Referees', `${hapByRef ? `<section class="card"><h2>Hapoel with each referee</h2><div class="scroll"><table class="rtab"><thead><tr><th>Referee</th><th class="num">Games</th><th class="num">Hapoel W–L</th><th class="num">Fouls (Hapoel – opp)</th><th class="num">Free throws (Hapoel – opp)</th></tr></thead><tbody>${hapByRef}</tbody></table></div><p class="muted small">Per game, in Hapoel's games refereed by him. Records with a few games are a small sample.</p></section>` : ''}
<section class="card"><h2>All referees this season</h2><p class="muted">Per game in the games each referee worked. League average: ${lg.f.toFixed(1)} fouls, ${lg.t.toFixed(1)} free-throw attempts, ${lg.p.toFixed(1)} points, home teams win ${lg.h.toFixed(0)}%. Red = at least 10% above the league average, blue = at least 10% below. Click a column to sort.</p>
<div class="scroll"><table class="sortable ref-t"><thead><tr><th scope="col"><button type="button">Referee</button></th><th scope="col" class="num"><button type="button">Games</button></th><th scope="col" class="num"><button type="button">Fouls</button></th><th scope="col" class="num"><button type="button">FTA</button></th><th scope="col" class="num"><button type="button">Points</button></th><th scope="col" class="num"><button type="button">Home wins</button></th><th scope="col" class="num"><button type="button">Hapoel W–L</button></th></tr></thead><tbody>${rows}</tbody></table></div></section>
${hapRows ? `<section class="card"><h2>Hapoel games and their crews</h2><div class="scroll"><table class="rtab"><thead><tr><th>Date</th><th>Game</th><th>Result</th><th>Referees</th><th class="num">Fouls</th><th class="num">FTA</th></tr></thead><tbody>${hapRows}</tbody></table></div></section>` : ''}`, HOME,
    cover({ kicker: esc(roundLine), title: 'Referees', lede: `Every referee of the season (${REFS.length}), how their games are called, and Hapoel's record with each of them.` }));
}

// ---- Game predictions and standings forecast (team ratings from this season, simulated to the end) ----
const FORECAST = (() => {
  if (games.length < 10 || teams.length < 4) return null;
  const P = teams.reduce((s, t) => s + t.pace, 0) / teams.length;
  const lgRtg = teams.reduce((s, t) => s + t.ortg, 0) / teams.length;
  const hm = games.reduce((s, g) => s + (g.home.score - g.away.score), 0) / games.length;
  const HCA = Math.max(0, Math.min(5, hm));
  const T = new Map(teams.map((t) => { const k = t.gp / (t.gp + 4); return [t.code, { t, o: lgRtg + (t.ortg - lgRtg) * k, d: lgRtg + (t.drtg - lgRtg) * k, pace: P + (t.pace - P) * k }]; }));
  const predict = (h, a) => { const H = T.get(h), A = T.get(a); if (!H || !A) return null; const pace = (H.pace + A.pace) / 2; const ph = pace * (H.o + A.d - lgRtg) / 100 + HCA / 2, pa = pace * (A.o + H.d - lgRtg) / 100 - HCA / 2; return { ph, pa, m: ph - pa }; };
  // spread of real results around the prediction (for win probabilities)
  const res = games.map((g) => { const p = predict(g.home.code, g.away.code); return p ? (g.home.score - g.away.score) - p.m : 0; });
  const sigma = Math.max(9, Math.min(14, Math.sqrt(res.reduce((s, x) => s + x * x, 0) / (res.length || 1))));
  const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  const prob = (h, a) => { const p = predict(h, a); return p ? { ...p, win: Phi(p.m / sigma) } : null; };
  const left = upcoming.filter((x) => T.has(x.h.code) && T.has(x.a.code) && !/play.?off|final/i.test(x.rn || ''));
  const N = 5000, cut = [1, 4, 6, 8, 10], count = new Map(teams.map((t) => [t.code, { wins: 0, pos: cut.map(() => 0) }]));
  const pr = left.map((x) => [x.h.code, x.a.code, prob(x.h.code, x.a.code).win]);
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < N; i++) {
    const w = new Map(teams.map((t) => [t.code, t.w]));
    for (const [h, a, p] of pr) { if (rnd() < p) w.set(h, w.get(h) + 1); else w.set(a, w.get(a) + 1); }
    const order = teams.map((t) => [t.code, w.get(t.code) + rnd() * 0.5 + (T.get(t.code).o - T.get(t.code).d) * 0.001]).sort((x, y) => y[1] - x[1]);
    order.forEach(([c], k) => { const e = count.get(c); e.wins += w.get(c); cut.forEach((n, j) => { if (k < n) e.pos[j]++; }); });
  }
  const table = teams.map((t) => { const e = count.get(t.code); return { code: t.code, name: t.name, tv: t.tv, w: t.w, l: t.l, rating: T.get(t.code).o - T.get(t.code).d, expW: e.wins / N, games: t.gp + left.filter((x) => x.h.code === t.code || x.a.code === t.code).length, p: e.pos.map((v) => v / N) }; }).sort((a, b) => b.expW - a.expW);
  return { prob, table, cut, sigma, HCA, left: left.length, N };
})();
if (!FORECAST) writePage('forecast.html', 'Forecast', '<section class="card"><p class="muted">The forecast starts once enough games have been played.</p></section>', HOME, cover({ kicker: esc(roundLine), title: 'Forecast', lede: 'Not enough games yet.' }));
if (FORECAST) {
  const pc = (v) => (v >= 0.995 ? '>99%' : v <= 0.005 ? (v > 0 ? '<1%' : '–') : Math.round(100 * v) + '%');
  const heat = (v) => `style="background:rgba(200,16,46,${(0.08 + 0.6 * v).toFixed(2)})"`;
  const nextRound = upcoming.length ? upcoming.filter((x) => x.r === upcoming[0].r) : [];
  const predRow = (x) => { const p = FORECAST.prob(x.h.code, x.a.code); if (!p) return ''; const hap = x.h.code === HAP_GAME_CODE || x.a.code === HAP_GAME_CODE; return `<tr${hap ? ' class="hap-row"' : ''}><td>${timeTag(x)}</td><td>${esc(titleCase(x.h.name))} <span class="muted">vs</span> ${esc(titleCase(x.a.name))}</td><td class="num"><strong>${Math.round(p.ph)}–${Math.round(p.pa)}</strong></td><td class="num">${pc(p.win)} – ${pc(1 - p.win)}</td></tr>`; };
  const hapNext = HAP_GAME_CODE ? upcoming.filter((x) => x.h.code === HAP_GAME_CODE || x.a.code === HAP_GAME_CODE).slice(0, 8) : [];
  writePage('forecast.html', 'Forecast', `${hapNext.length ? `<section class="card"><h2>Hapoel's next games</h2><div class="scroll"><table class="rtab"><thead><tr><th>Date</th><th>Game</th><th class="num">Expected score</th><th class="num">Win chance (home – away)</th></tr></thead><tbody>${hapNext.map(predRow).join('')}</tbody></table></div></section>` : ''}
<section class="card"><h2>Standings forecast</h2><p class="muted">${FORECAST.N.toLocaleString('en')} simulations of the ${FORECAST.left} games left, from each team's ratings this season (offense, defense and pace, pulled towards the league average early in the season) and home court (+${FORECAST.HCA.toFixed(1)}).${IS_EL ? ' EuroLeague: 1–6 go to the playoffs, 7–10 to the play-in.' : ''}</p>
<div class="scroll"><table class="rtab fc-t"><thead><tr><th>Team</th><th class="num">Now</th><th class="num">Rating</th><th class="num">Projected</th>${FORECAST.cut.map((n) => `<th class="num">${n === 1 ? '1st' : 'Top ' + n}</th>`).join('')}</tr></thead><tbody>
${FORECAST.table.map((r) => `<tr${r.code === HAP_GAME_CODE ? ' class="hap-row"' : ''}><td>${crests.has(r.code) ? `<img class="crest small" src="${esc(crests.get(r.code))}" alt="" width="20" height="20"> ` : ''}<a href="${teamHref(r.code)}">${esc(titleCase(r.name))}</a></td><td class="num">${r.w}–${r.l}</td><td class="num">${r.rating > 0 ? '+' : ''}${r.rating.toFixed(1)}</td><td class="num"><strong>${r.expW.toFixed(1)}–${(r.games - r.expW).toFixed(1)}</strong></td>${r.p.map((v) => `<td class="num" ${heat(v)}>${pc(v)}</td>`).join('')}</tr>`).join('')}
</tbody></table></div><p class="muted small">Rating = expected points per 100 possessions against an average team. A forecast, not a certainty: injuries, trades and coaching changes are not in the numbers.</p></section>
${nextRound.length ? `<section class="card"><h2>Next round: predictions</h2><div class="scroll"><table class="rtab"><thead><tr><th>Date</th><th>Game</th><th class="num">Expected score</th><th class="num">Win chance (home – away)</th></tr></thead><tbody>${nextRound.map(predRow).join('')}</tbody></table></div><p class="muted small">Typical miss: about ±${FORECAST.sigma.toFixed(0)} points on the margin.</p></section>` : ''}`, HOME,
    cover({ kicker: esc(roundLine), title: 'Forecast', lede: 'Expected scores and win chances for the next games, and how the final standings are likely to look — simulated from this season’s numbers.' }));
  writeFileSync(join(OUT, 'forecast-hapoel.json'), JSON.stringify(hapNext.map((x) => { const p = FORECAST.prob(x.h.code, x.a.code); return { c: x.c, h: x.h.code, a: x.a.code, ph: Math.round(p.ph), pa: Math.round(p.pa), win: x.h.code === HAP_GAME_CODE ? p.win : 1 - p.win }; })));
}

// ---- Hapoel against the top 10 of the league ----
if (HAP_GAME_CODE && teams.some((t) => t.code === HAP_GAME_CODE)) {
  const H = teams.find((t) => t.code === HAP_GAME_CODE);
  const top = teams.filter((t) => t.code !== HAP_GAME_CODE).sort((a, b) => a.rank - b.rank).slice(0, 10);
  const situ = (t) => { const fl = FLOW?.find((x) => x.code === t.code), sh = ALLSHOTS.filter((x) => x.team === t.code), shD = ALLSHOTS.filter((x) => x.opp === t.code), n = t.gp || 1; const ct = CLUTCH?.teams.find((x) => x.code === t.code), at = ATO?.find((x) => x.code === t.code);
    return { offTO: fl ? fl.offTO / fl.games : null, offTOA: fl ? fl.offTOA / fl.games : null, second: fl ? fl.second / fl.games : null, secondA: fl ? fl.secondA / fl.games : null, runs: fl ? fl.runs / fl.games : null, runsA: fl ? fl.runsA / fl.games : null,
      fb: sh.length ? sh.filter((x) => x.made && x.fb).reduce((a, x) => a + (x.is3 ? 3 : 2), 0) / n : null, paint: sh.length ? 2 * sh.filter((x) => x.made && !x.is3 && (x.z === 'rim' || x.z === 'paint')).length / n : null, paintA: shD.length ? 2 * shD.filter((x) => x.made && !x.is3 && (x.z === 'rim' || x.z === 'paint')).length / n : null,
      clutch: ct ? situRates({ secs: ct.secs, poss: ct.poss, possD: ct.possD, pf: ct.pf, pa: ct.pa, box: ct.box, opp: ct.opp }).net : null, ato: at && at.off.n ? at.off.pts / at.off.n : null }; };
  const S = new Map(teams.map((t) => [t.code, situ(t)]));
  const val = (t, k) => (k in t ? t[k] : S.get(t.code)[k]);
  const ROWS = [
    ['Efficiency', [['Net rating', 'net', true], ['Offensive rating', 'ortg', true], ['Defensive rating', 'drtg', false], ['Pace', 'pace', null], ['Points', 'ppg', true], ['Points allowed', 'oppg', false]]],
    ['Offense', [['eFG%', 'efg', true], ['True shooting %', 'ts', true], ['2P%', 'twoPct', true], ['3P%', 'threePct', true], ['3-point rate', 'threeRate', null], ['Free-throw rate', 'ftr', true], ['FT%', 'ftPct', true], ['Turnovers / 100', 'tov100', false], ['Offensive rebound %', 'orebPct', true], ['Assist rate', 'astRate', true]]],
    ['Defense', [['Opp eFG%', 'efgD', false], ['Opp 2P%', 'twoPctD', false], ['Opp 3P%', 'threePctD', false], ['Opp 3-point rate', 'threeRateD', false], ['Forced turnovers / 100', 'tov100D', true], ['Defensive rebound %', 'drebPct', true], ['Opp free-throw rate', 'ftrD', false], ['Steals', 'spg', true], ['Blocks', 'bpg', true]]],
    ['How the points come (per game)', [['Points off turnovers', 'offTO', true], ['Opp points off turnovers', 'offTOA', false], ['Second-chance points', 'second', true], ['Opp second-chance points', 'secondA', false], ['Fast-break points', 'fb', true], ['Points in the paint', 'paint', true], ['Opp points in the paint', 'paintA', false], ['Runs of 8+', 'runs', true], ['Opp runs of 8+', 'runsA', false]]],
    ['Close games', [['Clutch net rating', 'clutch', true], ['Points per possession after timeouts', 'ato', true]]]
  ];
  const gaps = [], okList = [];
  const body = ROWS.map(([grp, rows]) => {
    const r = rows.map(([label, k, good]) => {
      const hv = val(H, k); const tv = top.map((t) => val(t, k)).filter((v) => v != null && Number.isFinite(v)); if (hv == null || !tv.length) return '';
      const avg = tv.reduce((a, b) => a + b, 0) / tv.length, sd = Math.sqrt(tv.reduce((a, b) => a + (b - avg) ** 2, 0) / tv.length) || 1;
      const all = teams.map((t) => val(t, k)).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => (good === false ? a - b : b - a));
      const rank = good == null ? null : 1 + all.indexOf(hv), best = good == null ? null : all[0];
      const d = hv - avg, z = good == null ? 0 : (good ? d : -d) / sd;
      if (good != null) (z < -0.5 ? gaps : z > 0.3 ? okList : []).push([z, label, hv, avg, rank]);
      const dp = k === 'ato' ? 2 : 1, f = (v) => (v == null ? '–' : v.toFixed(dp));
      const lo = Math.min(hv, ...tv), hi = Math.max(hv, ...tv), pos = (v) => (hi === lo ? 50 : 100 * (v - lo) / (hi - lo));
      return `<tr><td>${label}</td><td class="num"><strong class="${good == null ? '' : z >= 0 ? 'pos' : 'neg'}">${f(hv)}</strong>${rank ? ` <small class="muted">${ord(rank)}</small>` : ''}</td><td class="num">${f(avg)}</td><td class="num ${good == null ? '' : z >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(dp)}</td><td class="bm-strip"><span class="bm-rng"></span>${tv.map((v) => `<i style="left:${pos(v).toFixed(1)}%"></i>`).join('')}<b style="left:${pos(hv).toFixed(1)}%" title="Hapoel"></b><em style="left:${pos(avg).toFixed(1)}%" title="Top-10 average"></em></td><td class="num muted">${best == null ? '–' : f(best)}</td></tr>`;
    }).join('');
    return r ? `<tr class="bm-grp"><th colspan="6">${grp}</th></tr>${r}` : '';
  }).join('');
  const li = (arr, cls) => arr.sort((a, b) => (cls === 'neg' ? a[0] - b[0] : b[0] - a[0])).slice(0, 8).map(([z, l, hv, avg, rank]) => `<li><strong>${l}</strong>: Hapoel ${hv.toFixed(l.includes('timeouts') ? 2 : 1)}${rank ? ` (${ord(rank)})` : ''}, top 10 average ${avg.toFixed(l.includes('timeouts') ? 2 : 1)}</li>`).join('') || '<li class="muted">None</li>';
  writePage(`team-${safe(HAP_GAME_CODE)}-benchmark.html`, 'Hapoel against the top 10', `<p class="no-print" style="margin:0"><button type="button" class="btn" id="print-btn">Download as PDF</button></p>
<section class="card"><h2>Where Hapoel stands</h2><div class="r-two"><div><h3 class="neg">Biggest gaps to the top 10</h3><ol class="ud">${li(gaps, 'neg')}</ol></div><div><h3 class="pos">Already at top-10 level or better</h3><ol class="ud">${li(okList, 'pos')}</ol></div></div>
<p class="muted small">Top 10 = the ten best teams in the standings apart from Hapoel: ${top.map((t) => esc(t.tv)).join(', ')}. A gap counts when Hapoel is more than half a spread (standard deviation) of those teams below their average.</p></section>
<section class="card"><h2>Every category</h2><div class="scroll"><table class="rtab bm-t"><thead><tr><th>Stat</th><th class="num">Hapoel (rank)</th><th class="num">Top-10 avg</th><th class="num">Gap</th><th>Hapoel among the top 10</th><th class="num">Best in league</th></tr></thead><tbody>${body}</tbody></table></div>
<p class="muted small">In the strip: grey dots = the top-10 teams, black line = their average, red dot = Hapoel (left = lowest value, right = highest). Green / red = better / worse than the top-10 average.</p></section>`, 'teams.html',
    cover({ kicker: esc(cfg.shortName || cfg.leagueName || 'EuroLeague'), title: 'Hapoel against the top 10', lede: 'Every category next to the average of the ten best teams in the standings: what is already at that level, and the biggest gaps to close.', actions: `<a class="btn white" href="${teamHref(HAP_GAME_CODE)}">Hapoel team page</a>` }),
    { scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script>` });
}

// ---- Lineup builder: pick any Hapoel players and see how they have done together ----
if (HAP_GAME_CODE && pbpOk.some((e) => e.game.home.code === HAP_GAME_CODE || e.game.away.code === HAP_GAME_CODE)) {
  const mine = pbpOk.filter((e) => e.game.home.code === HAP_GAME_CODE || e.game.away.code === HAP_GAME_CODE);
  const U = { 5: {}, 4: {}, 3: {}, 2: {}, 1: {} };
  for (const e of mine) { const sd = e.game.home.code === HAP_GAME_CODE ? 'H' : 'A'; for (const k of [5, 4, 3, 2, 1]) for (const u of gameUnits(e.game, e.stints, k)[sd]) { const key = u.ids.slice().sort().join(','); const o = U[k][key] ||= [0, 0, 0, 0, 0, 0]; o[0] += u.secs; o[1] += u.pf; o[2] += u.pa; o[3] += u.poss; o[4] += u.oposs; o[5]++; } }
  for (const k of Object.keys(U)) for (const key of Object.keys(U[k])) U[k][key] = U[k][key].map((v, i) => (i === 5 ? v : Math.round(v * 10) / 10));
  // team totals (to show each player's "off the court" numbers)
  const tot = [0, 0, 0, 0, 0]; for (const e of mine) for (const s2 of e.stints) { const h = e.game.home.code === HAP_GAME_CODE; tot[0] += s2.secs; tot[1] += h ? s2.pts[e.game.home.code] : s2.pts[e.game.away.code]; tot[2] += h ? s2.pts[e.game.away.code] : s2.pts[e.game.home.code]; tot[3] += h ? s2.possH : s2.possA; tot[4] += h ? s2.possA : s2.possH; }
  const ids = Object.keys(U[1]).sort((a, b) => U[1][b][0] - U[1][a][0]);
  const data = { games: mine.length, tot: tot.map((v) => Math.round(v * 10) / 10), players: ids.map((id) => [id, nameOf.get(id) || id, Math.round(U[1][id][0] / 60)]), U: { 5: U[5], 4: U[4], 3: U[3], 2: U[2] } };
  copyFileSync('static/lineupbuilder.js', join(OUT, 'lineupbuilder.js'));
  writePage(`team-${safe(HAP_GAME_CODE)}-lineup-builder.html`, 'Lineup builder', `<section class="card"><div id="lb-app"><p class="muted">Loading…</p></div></section>
<script type="application/json" id="lb-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`, 'lineups.html',
    cover({ kicker: esc(cfg.shortName || cfg.leagueName || 'EuroLeague'), title: 'Lineup builder', lede: `Pick up to five Hapoel players: how they have played together (${mine.length} games of lineups from the play-by-play), every pair and trio inside the group, and an estimate when the five have never shared the court.` }),
    { scripts: `<script src="lineupbuilder.js?v=${assetVersion()}" defer></script>` });
}

/** Same person key as static/staff.js: accents, case, punctuation and word order ignored. */
const pkey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
// Compact game log for the cross-league pages (injury report, opponents' domestic games): scripts/build-availability.mjs
writeFileSync(join(OUT, 'gamelog.json'), JSON.stringify({ league: LEAGUE, name: cfg.leagueName || cfg.shortName || LEAGUE, short: cfg.shortName || LEAGUE, hap: HAP_GAME_CODE || null,
  teams: Object.fromEntries(teams.map((t) => [t.code, [titleCase(t.name), t.tv]])),
  upcoming: upcoming.slice(0, 60).map((x) => [x.utc || null, x.h.code, x.a.code, x.r || null, Number(x.c) || null]),
  games: sortedGames.map((g) => [g.date, g.gameCode, g.round ?? null, g.home.code, g.home.score, g.away.code, g.away.score, [...g.home.players.map((q) => [q.name, g.home.code, +(q.min || 0).toFixed(1), q.pts, q.reb, q.ast, q.pir, q.id]), ...g.away.players.map((q) => [q.name, g.away.code, +(q.min || 0).toFixed(1), q.pts, q.reb, q.ast, q.pir, q.id])]]) }));
// Staff store (availability marks, keys to the game, season goals): encrypted with the team password, see static/staff.js
const STAFF_CFG = JSON.stringify({ salt: cfg.internal?.salt, iterations: cfg.internal?.iterations, repo: process.env.GITHUB_REPOSITORY || cfg.internal?.repo || 'hta-lab/hta-lab.github.io', branch: process.env.GITHUB_REF_NAME || 'main', path: 'scouting/plan.enc', root: IS_EL ? '' : '../', comp: LEAGUE }).replace(/</g, '\\u003c');
const STAFF_TAG = `<script>window.HTA_STAFF_CFG = ${STAFF_CFG};</script><script src="${IS_EL ? '' : '../'}staff.js?v=${assetVersion()}" defer></script>`;
// ---- Insights: inside our games (runs, foul trouble, quarter edges, score situations), coach habits, passing, shot quality, clip list ----
const INS = (() => {
  if (!HAP_GAME_CODE || !pbpOk.length) return null;
  const sgn = (v) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
  const per = pbpOk.map((e) => { const raw = rawPbp.get(e.game.gameCode); return raw ? { e, g: e.game, plays: playLog(e.game, raw).plays, ps: e.periodStints } : null; }).filter(Boolean);
  const sideOf = (g, code) => (g.home.code === code ? 'H' : g.away.code === code ? 'A' : null);
  const T = new Map(teams.map((t) => [t.code, { code: t.code, tv: t.tv, name: titleCase(t.name), g: 0, runsF: 0, runsA: 0, win: Object.fromEntries(WINDOWS.map(([k]) => [k, { pf: 0, pa: 0 }])), st: Object.fromEntries(STATES.map(([k]) => [k, { pf: 0, pa: 0, fga: 0, oreb: 0, tov: 0, fta: 0, ofga: 0, ooreb: 0, otov: 0, ofta: 0, secs: 0 }])), coach: [], pairs: [], drawn: new Map() }]));
  const runList = [];
  for (const x of per) {
    const rr = runsOf(x.plays, x.ps, 8);
    for (const side of ['H', 'A']) {
      const code = side === 'H' ? x.g.home.code : x.g.away.code, o = T.get(code); if (!o) continue;
      o.g++;
      o.runsF += rr.filter((r) => r.side === side).length; o.runsA += rr.filter((r) => r.side !== side).length;
      const w = windowPoints(x.plays, side); for (const k in w) { o.win[k].pf += w[k].pf; o.win[k].pa += w[k].pa; }
      const st = scoreStates(x.plays, side); for (const k in st) for (const f in st[k]) o.st[k][f] += st[k][f];
      const sideObj = side === 'H' ? x.g.home : x.g.away;
      o.coach.push({ g: x.g, ...coachGame(x.plays, x.ps, side, sideObj.players.filter((p) => p.starter).map((p) => p.id)) });
      o.pairs.push({ pairs: connections(x.plays), side });
      for (const p of x.plays) if (p[4] === 'RV' && p[2] === side && p[3]) o.drawn.set(p[3], (o.drawn.get(p[3]) || 0) + 1);
    }
    for (const r of rr) runList.push({ ...r, g: x.g });
  }
  const TL = [...T.values()].filter((o) => o.g);
  const rankBy = (f, hi = true) => { const v = TL.map(f).sort((a, b) => (hi ? b - a : a - b)); return (o) => 1 + v.indexOf(f(o)); };
  const H0 = T.get(HAP_GAME_CODE);
  const hapGames = per.filter((x) => sideOf(x.g, HAP_GAME_CODE));
  const nm = (id) => nameOf.get(id) || id;
  const qc = (per0, clock) => `Q${per0 > 4 ? 'OT' : per0} ${clock}`;
  const gameLbl = (g) => { const s = sideOf(g, HAP_GAME_CODE), op = s === 'H' ? g.away : g.home; return `${s === 'H' ? 'vs' : 'at'} ${op.tv}`; };
  // ---- Inside our games ----
  let insideHtml = '';
  if (H0 && hapGames.length) {
    const myRuns = runList.filter((r) => sideOf(r.g, HAP_GAME_CODE)).map((r) => ({ ...r, mine: (r.side === 'H') === (r.g.home.code === HAP_GAME_CODE) })).sort((a, b) => b.g.date.localeCompare(a.g.date) || a.t0 - b.t0);
    const against = myRuns.filter((r) => !r.mine), forUs = myRuns.filter((r) => r.mine);
    const onCount = (list, mineSide) => { const m = new Map(); for (const r of list) { const s = r.g.home.code === HAP_GAME_CODE ? 'H' : 'A'; for (const id of r.onStart[s] || []) m.set(id, (m.get(id) || 0) + 1); } return m; };
    const onA = onCount(against), onF = onCount(forUs);
    const ids = [...new Set([...onA.keys(), ...onF.keys()])].sort((a, b) => ((onF.get(b) || 0) - (onA.get(b) || 0)) - ((onF.get(a) || 0) - (onA.get(a) || 0)));
    const toStop = against.filter((r) => r.timeoutBy && r.timeoutBy !== r.side);
    const runRow = (r) => { const s = r.g.home.code === HAP_GAME_CODE ? 'H' : 'A'; const sc = s === 'H' ? r.scoreBefore : [r.scoreBefore[1], r.scoreBefore[0]];
      return `<tr><td><a href="${gameHref(r.g.gameCode)}">${esc(fmtDate(r.g.date))} ${esc(gameLbl(r.g))}</a></td><td class="num">${qc(r.period, r.clock0)}</td><td class="num"><strong class="${r.mine ? 'pos' : 'neg'}">${r.pts}–0</strong></td><td class="num">${sc[0]}–${sc[1]}</td><td class="small">${r.oppTov ? `${r.oppTov} TO` : ''}${r.oppTov && r.oppMiss ? ' · ' : ''}${r.oppMiss ? `${r.oppMiss} missed (${r.oppMiss3} threes)` : ''}</td><td class="small">${r.timeoutBy && r.timeoutBy !== r.side ? '<span class="chip">Timeout</span> ' : ''}${r.stopper ? esc(nm(r.stopper)) : 'end of game'}</td><td class="small">${(r.onStart[s] || []).map((id) => esc(nm(id))).join(' · ')}</td></tr>`; };
    const runTable = (list) => `<div class="scroll"><table class="rtab"><thead><tr><th>Game</th><th class="num">Started</th><th class="num">Run</th><th class="num">Score before (us–them)</th><th>During the run, the other team had</th><th>Stopped by</th><th>Hapoel five at the start</th></tr></thead><tbody>${list.slice(0, 25).map(runRow).join('')}</tbody></table></div>`;
    // foul trouble: each time a player picks up his 2nd foul in the 1st half (3rd before the last 5 min) or his 4th in the 2nd half
    const ft = new Map(), fo = new Map(), eps = [];
    // what he normally plays in those minutes: his share of games on the court in each minute (Q1 to Q4), all our games
    const ROT = new Map((rotationOf(pbpOk, HAP_GAME_CODE)?.players || []).map((r) => [r.id, r.share]));
    const usual = (pid, a, b) => { const sh = ROT.get(pid); if (!sh) return 0; let v = 0; for (let m = Math.floor(a / 60); m < Math.ceil(b / 60) && m < 40; m++) { const lo = Math.max(a, m * 60), hi = Math.min(b, m * 60 + 60); if (hi > lo) v += (sh[m] || 0) * (hi - lo); } return v; };
    const clockOf = (t) => { const q = Math.floor(t / 600) + 1, rem = Math.round(600 - (t % 600)); return `Q${q} ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`; };
    for (const x of hapGames) {
      const s = sideOf(x.g, HAP_GAME_CODE), sk = s === 'H' ? 'home' : 'away', me = HAP_GAME_CODE, op = s === 'H' ? x.g.away.code : x.g.home.code;
      const r = foulTrouble(x.plays, x.ps, s);
      for (const e of r.episodes) {
        // score from the foul to the end of the half, only while he was on the bench
        let pf = 0, pa = 0, bench = 0;
        for (const st of x.ps) { if (st.start == null) continue; const lo = Math.max(e.t, st.start), hi = Math.min(e.t + e.left, st.start + st.secs); if (hi <= lo || st[sk].includes(e.pid)) continue; const f = st.secs ? (hi - lo) / st.secs : 0; pf += (st.pts?.[me] || 0) * f; pa += (st.pts?.[op] || 0) * f; bench += hi - lo; }
        const exp = usual(e.pid, e.t, e.t + e.left), lost = Math.max(0, exp - e.played);
        eps.push({ ...e, g: x.g, exp, lost, pf, pa, bench });
        const o = ft.get(e.pid) || { n: 0, played: 0, exp: 0, lost: 0, pf: 0, pa: 0, kinds: {} };
        o.n++; o.played += e.played; o.exp += exp; o.lost += lost; o.pf += pf; o.pa += pa; o.kinds[e.kind] = (o.kinds[e.kind] || 0) + 1; ft.set(e.pid, o);
      }
      for (const id of r.fouledOut) fo.set(id, (fo.get(id) || 0) + 1);
    }
    const totalLost = eps.reduce((a, e) => a + e.lost, 0) / 60;
    const sitPf = eps.reduce((a, e) => a + e.pf, 0), sitPa = eps.reduce((a, e) => a + e.pa, 0);
    const maxLost = Math.max(1, ...[...ft.values()].map((o) => o.lost));
    const ftRows = [...ft].sort((a, b) => b[1].lost - a[1].lost).map(([id, o]) => { const net = Math.round(o.pf - o.pa); return `<tr><td><a href="${playerHref(id)}"><strong>${esc(nm(id))}</strong></a><br><span class="muted small">${Object.entries(o.kinds).map(([k, v]) => `${v}× ${k}`).join(' · ')}</span></td><td class="num"><strong>${o.n}</strong></td><td class="num">${(o.played / 60 / o.n).toFixed(1)} <span class="muted">of</span> ${(o.exp / 60 / o.n).toFixed(1)}</td><td><div class="ft-bar"><span style="width:${(100 * o.lost / maxLost).toFixed(0)}%"></span><b>${(o.lost / 60).toFixed(1)} min</b></div></td><td class="num"><strong class="${net >= 0 ? 'pos' : 'neg'}">${net > 0 ? '+' : ''}${net}</strong></td><td class="num">${fo.get(id) || '–'}</td></tr>`; }).join('');
    const worst = [...eps].sort((a, b) => b.lost - a.lost).slice(0, 5).map((e) => { const net = Math.round(e.pf - e.pa); return `<li><strong>${esc(nm(e.pid))}</strong> — <a href="${gameHref(e.g.gameCode)}">${esc(fmtDate(e.g.date))} ${esc(gameLbl(e.g))}</a>: ${esc(e.kind.split(',')[0])} at <strong>${clockOf(e.t)}</strong>. From there to ${e.left + e.t > 1200 ? 'the end of the game' : 'halftime'} he usually plays about ${Math.round(e.exp / 60)} minutes; this time he played ${Math.round(e.played / 60)}. While he sat we were <strong class="${net >= 0 ? 'pos' : 'neg'}">${net > 0 ? '+' : ''}${net}</strong>.</li>`; }).join('');
    // windows
    const winRank = (k) => rankBy((o) => (o.win[k].pf - o.win[k].pa) / o.g);
    const winRows = WINDOWS.map(([k, l]) => { const w = H0.win[k], n = (w.pf - w.pa) / H0.g; const lg = TL.reduce((a, o) => a + o.win[k].pf, 0) / TL.reduce((a, o) => a + o.g, 0); return `<tr><td>${l}</td><td class="num">${(w.pf / H0.g).toFixed(1)}</td><td class="num">${(w.pa / H0.g).toFixed(1)}</td><td class="num"><strong class="${n >= 0 ? 'pos' : 'neg'}">${sgn(n)}</strong></td><td class="num">${ord(winRank(k)(H0))}</td><td class="num muted">${lg.toFixed(1)}</td></tr>`; }).join('');
    // score states
    const stRate = (o, k) => { const s = o.st[k], p = possOf(s); return { ortg: p.off ? 100 * s.pf / p.off : null, drtg: p.def ? 100 * s.pa / p.def : null, min: s.secs / 60 }; };
    const lgSt = (k) => { const s = TL.reduce((a, o) => { for (const f in o.st[k]) a[f] = (a[f] || 0) + o.st[k][f]; return a; }, {}); const p = possOf(s); return p.off ? 100 * s.pf / p.off : null; };
    const stRows = STATES.map(([k, l]) => { const r = stRate(H0, k); return `<tr${k === 'garbage' ? ' class="muted"' : ''}><td>${l}</td><td class="num">${(r.min / H0.g).toFixed(1)}</td><td class="num">${f1(r.ortg)}</td><td class="num">${f1(r.drtg)}</td><td class="num"><strong class="${(r.ortg ?? 0) - (r.drtg ?? 0) >= 0 ? 'pos' : 'neg'}">${r.ortg == null || r.drtg == null ? '–' : sgn(r.ortg - r.drtg)}</strong></td><td class="num muted">${f1(lgSt(k))}</td></tr>`; }).join('');
    insideHtml = `<nav class="hap-toc"><a href="#runs">Runs</a><a href="#fouls">Foul trouble</a><a href="#quarters">Start and end of quarters</a><a href="#states">Score situations</a></nav>
<section class="card" id="runs"><h2>Scoring runs (8–0 or more)</h2><div class="r-grid"><div class="rs"><span>Our runs per game</span><b>${(H0.runsF / H0.g).toFixed(2)} <small>${ord(rankBy((o) => o.runsF / o.g)(H0))}</small></b></div><div class="rs"><span>Runs against per game</span><b>${(H0.runsA / H0.g).toFixed(2)} <small>${ord(rankBy((o) => o.runsA / o.g, false)(H0))}</small></b></div><div class="rs"><span>Runs against stopped with a timeout</span><b>${toStop.length} of ${against.length}</b></div><div class="rs"><span>Turnovers during runs against</span><b>${against.reduce((a, r) => a + r.oppTov, 0)}</b></div></div>
<h3>Runs against us</h3>${against.length ? runTable(against) : '<p class="muted">None.</p>'}
<h3>Our runs</h3>${forUs.length ? runTable(forUs) : '<p class="muted">None.</p>'}
<h3>Who is on the court when runs start</h3><div class="scroll"><table class="rtab"><thead><tr><th>Player</th><th class="num">Our runs</th><th class="num">Runs against</th><th class="num">Difference</th></tr></thead><tbody>${ids.slice(0, 14).map((id) => { const f = onF.get(id) || 0, a = onA.get(id) || 0; return `<tr><td>${esc(nm(id))}</td><td class="num">${f}</td><td class="num">${a}</td><td class="num"><strong class="${f - a >= 0 ? 'pos' : 'neg'}">${f - a > 0 ? '+' : ''}${f - a}</strong></td></tr>`; }).join('')}</tbody></table></div><p class="muted small">A run is unanswered points by one team. "During the run" counts the other team's turnovers and missed shots from their last basket to the end of the run.</p></section>
<section class="card" id="fouls"><h2>Foul trouble</h2>
<p class="ft-explain"><strong>How to read this:</strong> a player is in foul trouble when he picks up his <strong>2nd foul in the first half</strong> or his <strong>4th foul in the second half</strong>. Coaches usually sit him so he doesn’t foul out. Below: how many minutes that cost us, and how we played without him.</p>
<div class="r-grid"><div class="rs"><span>Times a player got into foul trouble</span><b>${eps.length} <small>in ${H0.g} games</small></b></div><div class="rs"><span>Minutes lost</span><b>${totalLost.toFixed(0)} <small>about ${(totalLost / H0.g).toFixed(1)} a game</small></b></div><div class="rs"><span>Our score while they sat</span><b class="${sitPf - sitPa >= 0 ? 'pos' : 'neg'}">${sitPf - sitPa >= 0 ? '+' : ''}${Math.round(sitPf - sitPa)}</b></div><div class="rs"><span>Fouled out</span><b>${[...fo.values()].reduce((a, b) => a + b, 0)} <small>times</small></b></div></div>
${ftRows ? `<h3>By player</h3><div class="scroll"><table class="rtab ft-t"><thead><tr><th>Player</th><th class="num">Times</th><th class="num">Played after the foul <span class="muted small">of usual min, each time</span></th><th>Minutes lost</th><th class="num">Score while he sat</th><th class="num">Fouled out</th></tr></thead><tbody>${ftRows}</tbody></table></div>
<h3>The 5 most costly cases</h3><ol class="ft-cases">${worst}</ol>` : '<p class="muted">No foul trouble yet.</p>'}
<p class="muted small">“He’d normally play” = how much he usually plays in those same minutes, from all our games this season. “Minutes lost” is the difference, up to halftime (1st-half fouls) or the end of the game (2nd-half fouls). Also counted: a 3rd foul before the last 5 minutes of the first half.</p></section>
<section class="card" id="quarters"><h2>Start and end of quarters</h2><div class="scroll"><table class="rtab"><thead><tr><th>Stretch</th><th class="num">Our pts/g</th><th class="num">Their pts/g</th><th class="num">Margin</th><th class="num">League rank</th><th class="num">League avg pts</th></tr></thead><tbody>${winRows}</tbody></table></div></section>
<section class="card" id="states"><h2>Score situations</h2><div class="scroll"><table class="rtab"><thead><tr><th>Score</th><th class="num">Min/g</th><th class="num">Off. rating</th><th class="num">Def. rating</th><th class="num">Net</th><th class="num">League off. rating</th></tr></thead><tbody>${stRows}</tbody></table></div><p class="muted small">The margin before each possession. Garbage time (4th quarter, 20+ points apart, or 15+ in the last 4 minutes) is shown separately and left out of the other rows. Close games in the last 5 minutes: see the clutch page.</p></section>`;
    writePage(`team-${safe(HAP_GAME_CODE)}-inside.html`, 'Inside our games', `<div class="split-page">${insideHtml}</div>`, HOME,
      cover({ kicker: 'Hapoel', title: 'Inside our games', lede: `Runs for and against, foul trouble, the start and end of quarters, and how we play by score — from the play-by-play of ${H0.g} ${cfg.shortName || ''} games.` }));
  }
  // ---- Coach habits (every team) ----
  const habit = (o) => { const c = o.coach, tos = c.flatMap((x) => x.tos), n = c.length; const fs = c.map((x) => x.firstSub).filter((v) => v != null).sort((a, b) => a - b); const sq = c.map((x) => x.startersQ1).filter((v) => v != null); const close = c.filter((x) => x.close35);
    return { n, toG: tos.length / n, run6: tos.length ? tos.filter((t) => t.oppRun >= 6).length / tos.length : null, avgRun: tos.length ? tos.reduce((a, t) => a + t.oppRun, 0) / tos.length : null, byQ: [1, 2, 3, 4].map((q) => tos.filter((t) => t.period === q).length / n), late: tos.filter((t) => t.t >= 2280 && t.period === 4).length / n, firstSub: fs.length ? fs[Math.floor(fs.length / 2)] : null, sq: sq.length ? sq.reduce((a, b) => a + b, 0) / sq.length : null, lateUsed: close.length ? close.reduce((a, x) => a + x.lateUsed, 0) / close.length : null, used: c.reduce((a, x) => a + x.used, 0) / n, closeN: close.length }; };
  const HB = new Map(TL.map((o) => [o.code, habit(o)]));
  const clk = (s) => { if (s == null) return '–'; const rem = Math.round(600 - (s % 600)); return `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`; };
  const tRow = (o, cells) => `<tr${o.code === HAP_GAME_CODE ? ' class="hap-row"' : ''}><td><a href="${teamHref(o.code)}">${badge(o.code, o.tv)} ${esc(o.name)}</a></td>${cells.map((c) => `<td class="num">${c}</td>`).join('')}</tr>`;
  const TS = TL.sort((a, b) => a.tv.localeCompare(b.tv));
  const toRows = TS.map((o) => { const h = HB.get(o.code); return tRow(o, [h.toG.toFixed(1), h.avgRun == null ? '–' : h.avgRun.toFixed(1), h.run6 == null ? '–' : Math.round(100 * h.run6) + '%', ...h.byQ.map((v) => v.toFixed(1)), h.late.toFixed(1)]); }).join('');
  const rotRows = TS.map((o) => { const h = HB.get(o.code); return tRow(o, [clk(h.firstSub), h.sq == null ? '–' : (h.sq / 60).toFixed(1), h.used.toFixed(1), h.lateUsed == null ? '–' : `${h.lateUsed.toFixed(1)} <small class="muted">(${h.closeN} g)</small>`]); }).join('');
  writePage('coach-habits.html', 'Coach habits', `<section class="card"><h2>Timeouts</h2><div class="scroll"><table class="rtab"><thead><tr><th>Team</th><th class="num">Per game</th><th class="num">Opp. run before it (pts)</th><th class="num">After a 6+ run</th><th class="num">Q1</th><th class="num">Q2</th><th class="num">Q3</th><th class="num">Q4</th><th class="num">Last 2 min Q4</th></tr></thead><tbody>${toRows}</tbody></table></div>
<p class="muted small">Timeouts per game in each quarter. "Opp. run before it" = opponent points since the team's own last basket when it called the timeout. TV timeouts are not counted.</p></section>
<section class="card"><h2>Rotation</h2><div class="scroll"><table class="rtab"><thead><tr><th>Team</th><th class="num">First sub (Q1 clock)</th><th class="num">Starters' Q1 min</th><th class="num">Players used / game</th><th class="num">Used in last 5 min of close games</th></tr></thead><tbody>${rotRows}</tbody></table></div>
<p class="muted small">First sub = the median game clock of the team's first substitution. Close game = within 8 points with 5 minutes left. From the play-by-play of every checked game.</p></section>`, HOME,
    cover({ kicker: 'Opponents', title: 'Coach habits', lede: 'When each coach calls timeouts, how fast he goes to the bench, how long his starters play in the first quarter, and how short his rotation gets late.' }));
  // ---- Passing networks (every team) ----
  for (const o of TL) {
    const pairs = assistPairs(o.pairs);
    const pl = players.filter((p) => p.team === o.code && p.gp >= 2);
    const madeBy = new Map(pl.map((p) => [p.id, { m2: p.totals.fgm2, m3: p.totals.fgm3 }]));
    const recv = new Map(); for (const e of pairs) { const r = recv.get(e.to) || { a2: 0, a3: 0 }; if (e.pts === 2 * e.n) r.a2 += e.n; else { const n3 = e.pts - 2 * e.n; r.a3 += n3; r.a2 += e.n - n3; } recv.set(e.to, r); }
    const nodes = pl.filter((p) => p.mpg >= 8).slice(0, 12).map((p) => ({ id: p.id, label: esc(p.name.split(' ').slice(-1)[0]), ast: pairs.filter((e) => e.from === p.id).reduce((a, e) => a + e.n, 0), made: pairs.filter((e) => e.to === p.id).reduce((a, e) => a + e.n, 0) }));
    const edges = pairs.map((e) => ({ ...e, fromLabel: esc(nm(e.from)), toLabel: esc(nm(e.to)) }));
    const selfRows = pl.filter((p) => p.totals.fgm2 + p.totals.fgm3 >= 10).map((p) => { const r = recv.get(p.id) || { a2: 0, a3: 0 }, m = madeBy.get(p.id); return { p, u2: m.m2 ? 1 - r.a2 / m.m2 : null, u3: m.m3 ? 1 - r.a3 / m.m3 : null, u: 1 - (r.a2 + r.a3) / (m.m2 + m.m3), made: m.m2 + m.m3 }; }).sort((a, b) => b.u * b.made - a.u * a.made);
    const pct0 = (v) => (v == null ? '–' : Math.round(100 * Math.max(0, v)) + '%');
    writePage(`team-${safe(o.code)}-passing.html`, `${o.tv} passing network`, `<section class="card"><h2>Who assists whom</h2>${passingSvg(nodes, edges)}<p class="muted small">Arrows go from the passer to the scorer; thicker = more assists (2 or more shown). The number in each circle is assists given.</p></section>
<div class="r-two"><section class="card"><h2>Top connections</h2><table class="rtab"><thead><tr><th>Passer → scorer</th><th class="num">Assists</th><th class="num">Points</th></tr></thead><tbody>${pairs.slice(0, 15).map((e) => `<tr><td>${esc(nm(e.from))} → ${esc(nm(e.to))}</td><td class="num">${e.n}</td><td class="num">${e.pts}</td></tr>`).join('')}</tbody></table></section>
<section class="card"><h2>Creates his own shot</h2><table class="rtab"><thead><tr><th>Player</th><th class="num">Made FG</th><th class="num">Unassisted</th><th class="num">Unassisted 2s</th><th class="num">Unassisted 3s</th></tr></thead><tbody>${selfRows.slice(0, 12).map((x) => `<tr><td>${esc(x.p.name)}</td><td class="num">${x.made}</td><td class="num"><strong>${pct0(x.u)}</strong></td><td class="num">${pct0(x.u2)}</td><td class="num">${pct0(x.u3)}</td></tr>`).join('')}</tbody></table><p class="muted small">Unassisted = made shots with no assist credited. Free throws not counted.</p></section></div>`, HOME,
      cover({ kicker: `<a href="${teamHref(o.code)}">${esc(o.name)}</a>`, title: 'Passing network', lede: `Assists between ${esc(o.name)} players in ${o.g} checked games, and who scores without help.` }));
  }
  // ---- Shot quality (leagues with shot locations) ----
  if (ALLSHOTS.some((s) => s.z)) {
    const M = shotModel(ALLSHOTS);
    const byP = new Map(); for (const s of ALLSHOTS) { if (!s.z) continue; if (!byP.has(s.pid)) byP.set(s.pid, []); byP.get(s.pid).push(s); }
    const pRows = [...byP].map(([id, sh]) => ({ id, p: players.find((q) => q.id === id), r: M.sum(sh) })).filter((x) => x.p && x.r.a >= 60).sort((a, b) => b.r.diff - a.r.diff);
    const tRows = TL.map((o) => ({ o, off: M.sum(ALLSHOTS.filter((s) => s.team === o.code)), def: M.sum(ALLSHOTS.filter((s) => s.opp === o.code)) })).sort((a, b) => (b.off.diff - b.def.diff) - (a.off.diff - a.def.diff));
    const pr = (x) => `<tr${x.p.team === HAP_GAME_CODE ? ' class="hap-row"' : ''}><td><a href="${playerHref(x.id)}">${esc(x.p.name)}</a> <span class="muted small">${esc(x.p.tv)}</span></td><td class="num">${x.r.a}</td><td class="num">${x.r.xpps.toFixed(2)}</td><td class="num">${x.r.pps.toFixed(2)}</td><td class="num"><strong class="${x.r.diff >= 0 ? 'pos' : 'neg'}">${sgn(x.r.diff)}</strong></td></tr>`;
    const zl = Object.entries(M.pps).map(([k, v]) => `${{ rim: 'At the rim', paint: 'Paint', mid: 'Mid-range', c3: 'Corner 3', ab3: 'Above-the-break 3' }[k] || k} ${v.toFixed(2)}`).join(' · ');
    writePage('shot-quality.html', 'Shot quality', `<section class="card"><h2>Teams</h2><div class="scroll"><table class="rtab"><thead><tr><th>Team</th><th class="num">Expected pts/shot</th><th class="num">Actual</th><th class="num">Shot-making (pts per 100 shots over expected)</th><th class="num">Opponents expected</th><th class="num">Opponents actual</th><th class="num">Opp shot-making</th></tr></thead><tbody>${tRows.map((x) => `<tr${x.o.code === HAP_GAME_CODE ? ' class="hap-row"' : ''}><td>${badge(x.o.code, x.o.tv)} ${esc(x.o.name)}</td><td class="num">${x.off.xpps.toFixed(2)}</td><td class="num">${x.off.pps.toFixed(2)}</td><td class="num"><strong class="${x.off.diff >= 0 ? 'pos' : 'neg'}">${sgn(x.off.diff)}</strong></td><td class="num">${x.def.xpps.toFixed(2)}</td><td class="num">${x.def.pps.toFixed(2)}</td><td class="num"><strong class="${x.def.diff <= 0 ? 'pos' : 'neg'}">${sgn(x.def.diff)}</strong></td></tr>`).join('')}</tbody></table></div>
<p class="muted small">Expected = what an average shooter scores from the same zones (league points per shot: ${zl}). A team far above expected on offense, or opponents far above on defense, usually comes back toward the middle. Free throws not counted.</p></section>
<div class="r-two"><section class="card"><h2>Shooting above expected</h2><table class="rtab"><thead><tr><th>Player</th><th class="num">Shots</th><th class="num">Expected pts/shot</th><th class="num">Actual</th><th class="num">Per 100 shots</th></tr></thead><tbody>${pRows.slice(0, 25).map(pr).join('')}</tbody></table></section>
<section class="card"><h2>Shooting below expected</h2><table class="rtab"><thead><tr><th>Player</th><th class="num">Shots</th><th class="num">Expected pts/shot</th><th class="num">Actual</th><th class="num">Per 100 shots</th></tr></thead><tbody>${pRows.slice(-25).reverse().map(pr).join('')}</tbody></table></section></div>
${pRows.some((x) => x.p.team === HAP_GAME_CODE) ? `<section class="card"><h2>Hapoel</h2><table class="rtab"><thead><tr><th>Player</th><th class="num">Shots</th><th class="num">Expected pts/shot</th><th class="num">Actual</th><th class="num">Per 100 shots</th></tr></thead><tbody>${pRows.filter((x) => x.p.team === HAP_GAME_CODE).map(pr).join('')}</tbody></table><p class="muted small">Players with 60+ shots with a location.</p></section>` : ''}`, HOME,
      cover({ kicker: 'Shots', title: 'Shot quality', lede: 'How good the shots are (expected points from where they are taken) and how well they are made. Shows who is shooting above his level and which teams are likely to cool off.' }));
  }
  // ---- Clip list: every play of Hapoel's games and of the next opponent's games ----
  const nxt = upcoming.find((x) => x.h.code === HAP_GAME_CODE || x.a.code === HAP_GAME_CODE), nOpp = nxt ? (nxt.h.code === HAP_GAME_CODE ? nxt.a.code : nxt.h.code) : null;
  const clipGames = per.filter((x) => sideOf(x.g, HAP_GAME_CODE) || (nOpp && sideOf(x.g, nOpp))).sort((a, b) => b.g.date.localeCompare(a.g.date));
  const clipData = { teams: Object.fromEntries(TL.map((o) => [o.code, o.tv])), hap: HAP_GAME_CODE, opp: nOpp, names: {}, games: [] };
  for (const x of clipGames) {
    for (const p of [...x.g.home.players, ...x.g.away.players]) clipData.names[p.id] = p.name;
    let lastTO = { H: -99, A: -99 };
    const rows = [];
    x.plays.forEach((p, i) => {
      if (p[4] === 'TOUT' && p[2]) { lastTO[p[2]] = i; return; }
      if (!p[2] || p[4] === 'IN' || p[4] === 'OUT') return;
      const ato = i - lastTO[p[2]] <= 4 ? 1 : 0;
      const m = Math.abs(p[5] - p[6]), clutch = p[7] >= 2100 && m <= 5 ? 1 : 0;
      rows.push([p[0], p[1], p[2] === 'H' ? x.g.home.code : x.g.away.code, p[3], p[4], p[5], p[6], ato, clutch]);
    });
    clipData.games.push({ code: x.g.gameCode, date: x.g.date, h: x.g.home.code, a: x.g.away.code, hs: x.g.home.score, as: x.g.away.score, rows });
  }
  writeFileSync(join(OUT, 'clips.json'), JSON.stringify(clipData));
  writePage('clips.html', 'Clip list', `<div id="clips-app"><p class="muted">Loading…</p></div>`, HOME,
    cover({ kicker: 'Video', title: 'Clip list', lede: `Pick games and a filter (our turnovers, plays after timeouts, clutch possessions, threes…) and get a list with quarter and game clock, ready for the video coordinator. Covers Hapoel's games${nOpp ? ` and ${esc(T.get(nOpp)?.name || nOpp)}'s games` : ''}. Download as CSV.` }),
    { scripts: `<script src="clips.js?v=${assetVersion()}" defer></script>` });
  return { HB, T, habitFor: (code) => HB.get(code), clk };
})();

// ---- Game-day pack for Hapoel's next game: summary, end-of-game sheet, opponent player cards (printable) ----
{
  const nx = HAP_GAME_CODE ? upcoming.find((x) => x.h.code === HAP_GAME_CODE || x.a.code === HAP_GAME_CODE) : null;
  const oc = nx ? (nx.h.code === HAP_GAME_CODE ? nx.a.code : nx.h.code) : null, O = oc && teams.find((t) => t.code === oc), Hh = teams.find((t) => t.code === HAP_GAME_CODE);
  if (nx && O && Hh) {
    const sg = (v) => (v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1));
    const home = nx.h.code === HAP_GAME_CODE, ON = titleCase(O.name);
    const pr = FORECAST?.prob(nx.h.code, nx.a.code);
    const hapWin = pr ? (home ? pr.win : 1 - pr.win) : null;
    const KEYS = [['Net rating', 'net', true], ['Offensive rating', 'ortg', true], ['Defensive rating', 'drtg', false], ['Pace', 'pace', null], ['eFG%', 'efg', true], ['3P%', 'threePct', true], ['3-point rate', 'threeRate', null], ['Turnovers / 100', 'tov100', false], ['Forced turnovers / 100', 'tov100D', true], ['Offensive rebound %', 'orebPct', true], ['Defensive rebound %', 'drebPct', true], ['Free-throw rate', 'ftr', true], ['Opp eFG%', 'efgD', false]];
    const kv = (t, k) => `${t[k] == null ? '–' : k === 'net' ? sg(t[k]) : f1(t[k])} <small class="muted">${t.ranks?.[k] ? ord(t.ranks[k]) : ''}</small>`;
    const compTable = `<table class="rtab"><thead><tr><th>Stat</th><th class="num">Hapoel</th><th class="num">${esc(O.tv)}</th></tr></thead><tbody>${KEYS.map(([l, k, good]) => { const a = Hh[k], b = O[k]; const ca = good == null || a === b ? '' : (good ? a > b : a < b) ? 'pos' : 'neg'; return `<tr><td>${l}</td><td class="num ${ca}">${kv(Hh, k)}</td><td class="num">${kv(O, k)}</td></tr>`; }).join('')}</tbody></table>`;
    // end of game: their free-throw shooters, closers, closing lineups, after timeouts, clutch
    const roster = players.filter((p) => p.team === oc && p.gp >= 2).sort((a, b) => b.totalMin - a.totalMin);
    const rot = PBP ? rotationOf(pbpOk, oc) : null, rotBy = new Map((rot?.players || []).map((x) => [x.id, x]));
    const closeShare = (id) => { const r = rotBy.get(id); return r ? r.share.slice(36, 40).reduce((a, b) => a + b, 0) / 4 : 0; };
    const ftList = roster.filter((p) => p.mpg >= 8 && p.totals.fta >= 4).map((p) => ({ p, pct: 100 * p.totals.ftm / p.totals.fta, close: closeShare(p.id) })).sort((a, b) => a.pct - b.pct);
    const closers = roster.map((p) => ({ p, close: closeShare(p.id) })).filter((x) => x.close > 0.15).sort((a, b) => b.close - a.close).slice(0, 8);
    // fives in the last 5 minutes of the 4th quarter, any score
    const lastFives = new Map();
    for (const e of pbpOk.filter((x) => x.game.home.code === oc || x.game.away.code === oc)) { const side = e.game.home.code === oc ? 'home' : 'away', me = oc, op = side === 'home' ? e.game.away.code : e.game.home.code; for (const s2 of e.periodStints) { if (s2.period !== 4 || s2.start == null) continue; const a = Math.max(s2.start, 2100), b = Math.min(s2.start + s2.secs, 2400); if (b <= a) continue; const k = s2[side].slice().sort().join(','); const f = b - a, frac = s2.secs ? f / s2.secs : 0; const o = lastFives.get(k) || { ids: s2[side], secs: 0, pf: 0, pa: 0, g: new Set() }; o.secs += f; o.pf += s2.pts[me] * frac; o.pa += s2.pts[op] * frac; o.g.add(e.game.gameCode); lastFives.set(k, o); } }
    const lf = [...lastFives.values()].sort((a, b) => b.secs - a.secs).slice(0, 4);
    const at = ATO?.find((x) => x.code === oc), ct = CLUTCH?.teams.find((x) => x.code === oc);
    const ctR = ct ? situRates({ secs: ct.secs, poss: ct.poss, possD: ct.possD, pf: ct.pf, pa: ct.pa, box: ct.box, opp: ct.opp }) : null;
    const clutchBy = new Map((CLUTCH?.players || []).filter((x) => x.team === oc).map((x) => [x.id, x]));
    const mmss = (s2) => `${Math.floor(s2 / 60)}:${String(Math.round(s2 % 60)).padStart(2, '0')}`;
    const endSheet = `<div class="r-two"><div><h3>Free-throw shooters — worst first</h3><table class="rtab"><thead><tr><th>Player</th><th class="num">FT</th><th class="num">FT%</th><th class="num">On court at the end</th></tr></thead><tbody>${ftList.map((x) => `<tr data-pname="${esc(pkey(x.p.name))}"${x.pct < 70 && x.close > 0.3 ? ' class="hap-row"' : ''}><td>${esc(x.p.name)}</td><td class="num">${x.p.totals.ftm}/${x.p.totals.fta}</td><td class="num ${x.pct < 70 ? 'neg' : x.pct >= 85 ? 'pos' : ''}"><strong>${x.pct.toFixed(0)}%</strong></td><td class="num">${Math.round(100 * x.close)}%</td></tr>`).join('')}</tbody></table><p class="muted small">Highlighted: under 70% from the line and often on the court in the last 4 minutes — candidates to foul.</p></div>
<div><h3>Who closes games</h3><table class="rtab"><thead><tr><th>Player</th><th class="num">On court, last 4 min</th><th class="num">Clutch PTS</th><th class="num">Clutch FG</th></tr></thead><tbody>${closers.map((x) => { const c = clutchBy.get(x.p.id); return `<tr data-pname="${esc(pkey(x.p.name))}"><td>${esc(x.p.name)}</td><td class="num"><strong>${Math.round(100 * x.close)}%</strong></td><td class="num">${c ? c.box.pts : '–'}</td><td class="num">${c ? `${c.box.fgm2 + c.box.fgm3}/${c.box.fga2 + c.box.fga3}` : '–'}</td></tr>`; }).join('')}</tbody></table></div></div>
${lf.length ? `<h3>Their most used fives in the last 5 minutes of the 4th quarter</h3><table class="rtab"><thead><tr><th>Lineup</th><th class="num">MIN</th><th class="num">Games</th><th class="num">Score</th></tr></thead><tbody>${lf.map((u) => `<tr data-pnames="${esc(u.ids.map((id) => pkey(nameOf.get(id) || id)).join('|'))}"><td class="small">${u.ids.map((id) => esc(nameOf.get(id) || id)).join(' · ')}</td><td class="num">${mmss(u.secs)}</td><td class="num">${u.g.size}</td><td class="num">${Math.round(u.pf)}–${Math.round(u.pa)}</td></tr>`).join('')}</tbody></table>` : ''}
<div class="r-grid">${ct ? `<div class="rs"><span>Clutch record</span><b>${ct.w}–${ct.l}</b></div><div class="rs"><span>Clutch net rating</span><b>${sg(ctR.net)}</b></div><div class="rs"><span>Clutch FT</span><b>${ct.box.ftm}/${ct.box.fta}</b></div>` : ''}${at && at.off.n ? `<div class="rs"><span>Points per possession after their timeouts</span><b>${(at.off.pts / at.off.n).toFixed(2)} <small>${ord(1 + ATO.filter((x) => x.off.n && x.off.pts / x.off.n > at.off.pts / at.off.n).length)}</small></b></div><div class="rs"><span>Last 2 min after timeouts</span><b>${at.off.late.n ? `${at.off.late.pts} pts / ${at.off.late.n}` : '–'}</b></div>` : ''}<div class="rs"><span>Team FT%</span><b>${f1(O.ftPct)}</b></div></div>`;
    // opponent player cards
    const cards = roster.filter((p) => p.mpg >= 10).slice(0, 9).map((p) => {
      const sh = ALLSHOTS.filter((x) => x.pid === p.id), r = rotBy.get(p.id), c = clutchBy.get(p.id), oo = onOffOf(p.id);
      const last = games.filter((g) => [...g.home.players, ...g.away.players].some((x) => x.id === p.id && x.min > 0)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((g) => { const x = [...g.home.players, ...g.away.players].find((y) => y.id === p.id); return `${x.pts}<small>/${Math.round(x.min)}′</small>`; }).join(' · ');
      const t = p.totals;
      return `<article class="pcard" data-pname="${esc(pkey(p.name))}"><header><strong>${esc(p.name)}</strong><span class="muted small">${esc(posOf.get(p.id) || '')}</span></header>
<div class="pc-stats"><span><b>${f1(p.ppg)}</b> pts</span><span><b>${f1(p.rpg)}</b> reb</span><span><b>${f1(p.apg)}</b> ast</span><span><b>${f1(p.mpg)}</b> min</span><span><b>${f1(p.ts)}</b> TS%</span><span><b>${f1(p.usg)}</b> USG%</span><span><b>${t.fga3 ? (100 * t.fgm3 / t.fga3).toFixed(0) : '–'}%</b> 3P (${(t.fga3 / p.gp).toFixed(1)}/g)</span><span><b>${t.fta ? (100 * t.ftm / t.fta).toFixed(0) : '–'}%</b> FT</span>${oo?.swing != null ? `<span><b>${sg(oo.swing)}</b> on/off</span>` : ''}${c ? `<span><b>${c.box.pts}</b> clutch pts</span>` : ''}</div>
<p class="small"><span class="muted">Last 5 (pts/min):</span> ${last}</p>
${r ? `<div class="pc-rot" title="Share of games on the court in each minute">${r.share.map((v, m) => `<i class="${m % 10 === 0 ? 'q' : ''}" style="opacity:${(0.08 + 0.92 * Math.min(1, v)).toFixed(2)}"></i>`).join('')}</div><p class="muted small">Minutes pattern: Q1 → Q4</p>` : ''}
${sh.length >= 15 ? courtSvg(sh, { mode: 'zones', league: ALLSHOTS, title: p.name + ' zones' }) : ''}</article>`;
    }).join('');
    const H2H = games.filter((g) => (g.home.code === HAP_GAME_CODE && g.away.code === oc) || (g.away.code === HAP_GAME_CODE && g.home.code === oc));
    const body = `<p class="no-print" style="margin:0"><button type="button" class="btn" id="print-btn">Download the pack as PDF</button> <a class="btn ghost" href="team-${safe(oc)}-report.html">Full pre-game report</a> <a class="btn ghost" href="matchup.html?a=${encodeURIComponent(HAP_GAME_CODE)}&b=${encodeURIComponent(oc)}">Matchup</a></p>
<header class="print-only split-ph"><div class="r-kicker">HTA LAB · Game-day pack</div><h1>${home ? 'Hapoel vs ' + esc(ON) : 'Hapoel at ' + esc(ON)}</h1><div class="r-meta">${esc(nx.utc ? nx.utc.slice(0, 16).replace('T', ' ') + ' UTC' : '')}${nx.rn ? ' · ' + esc(nx.rn) : ''}</div></header>
<section class="card"><h2>The game</h2><div class="r-grid"><div class="rs"><span>Records</span><b>Hapoel ${Hh.w}–${Hh.l} · ${esc(O.tv)} ${O.w}–${O.l}</b></div>${pr ? `<div class="rs"><span>Expected score</span><b>${home ? `Hapoel ${Math.round(pr.ph)}–${Math.round(pr.pa)}` : `Hapoel ${Math.round(pr.pa)}–${Math.round(pr.ph)}`}</b></div><div class="rs"><span>Hapoel win chance</span><b>${Math.round(100 * hapWin)}%</b></div>` : ''}<div class="rs"><span>Earlier meetings</span><b>${H2H.length ? H2H.map((g) => { const me = g.home.code === HAP_GAME_CODE ? g.home : g.away, op = me === g.home ? g.away : g.home; return `${me.score > op.score ? 'W' : 'L'} ${me.score}–${op.score}`; }).join(', ') : 'None this season'}</b></div></div>
<h3>Team numbers</h3>${compTable}<p class="muted small">Small numbers are league ranks. Green = Hapoel better.</p></section>
<div id="avail-note" class="no-print"></div>
<section class="card gd-end"><h2>End-of-game sheet — ${esc(ON)}</h2>${endSheet}</section>
${(() => { const h = INS?.habitFor(oc); if (!h) return ''; return `<section class="card"><h2>${esc(ON)} coach habits</h2><div class="r-grid"><div class="rs"><span>Timeouts per game</span><b>${h.toG.toFixed(1)}</b></div><div class="rs"><span>Calls a timeout after a 6+ run</span><b>${h.run6 == null ? '–' : Math.round(100 * h.run6) + '%'}</b></div><div class="rs"><span>Our run before his timeout (avg)</span><b>${h.avgRun == null ? '–' : h.avgRun.toFixed(1)} pts</b></div><div class="rs"><span>First substitution (Q1 clock)</span><b>${INS.clk(h.firstSub)}</b></div><div class="rs"><span>Starters' Q1 minutes</span><b>${h.sq == null ? '–' : (h.sq / 60).toFixed(1)}</b></div><div class="rs"><span>Players used in last 5 min of close games</span><b>${h.lateUsed == null ? '–' : h.lateUsed.toFixed(1)}</b></div></div><p class="muted small"><a href="coach-habits.html">Every coach</a> · <a href="team-${safe(oc)}-passing.html">${esc(ON)} passing network</a></p></section>`; })()}
<!--DOMESTIC:${esc(oc)}-->

<section class="card gd-cards"><h2>${esc(ON)} — player cards</h2><div class="pcards">${cards}</div><p class="muted small">Season numbers. On/off = their team's net rating with him on minus off. Zones: red = better than the league, blue = worse.</p></section>`;
    writePage('gameday-next.html', `Game-day pack: Hapoel ${home ? 'vs' : 'at'} ${O.tv}`, `<div class="split-page">${body}</div>`, HOME,
      cover({ kicker: esc(nx.rn || 'Next game'), title: `Game-day pack: ${home ? 'vs' : 'at'} ${esc(ON)}`, lede: 'Everything for the next game in one place: the numbers, a prediction, the end-of-game sheet and a card for every opponent player. Download it as one PDF.' }),
      { scripts: `<script>document.getElementById('print-btn').addEventListener('click', () => window.print());</script>${STAFF_TAG}` });
  }
}

// ---- Glossary ----
{
  const all = GLOSSARY.flatMap(([, items]) => items);
  const live = all.filter((x) => x[5] === 'live').length;
  writePage('glossary.html', 'Glossary', `
<section class="card"><div class="gl-bar"><input type="search" id="gl-q" placeholder="Search: TS%, usage, rebound…" aria-label="Search the glossary">
<div class="tabs" role="group" aria-label="Show"><button type="button" data-gl="all" aria-pressed="true">All</button><button type="button" data-gl="live" aria-pressed="false">On HTA LAB</button><button type="button" data-gl="soon" aria-pressed="false">Coming</button></div></div></section>
${GLOSSARY.map(([section, items]) => `<section class="card gl-sec"><h2>${esc(section)}</h2><dl class="gl">
${items.map(([ab, name, def, formula, where, status]) => `<div class="gl-item" data-status="${status}" data-text="${esc((ab + ' ' + name + ' ' + def).toLowerCase())}"><dt><span class="gl-ab">${esc(ab)}</span><span class="gl-name">${esc(name)}</span><span class="chip ${status === 'live' ? 'hot' : ''}">${status === 'live' ? 'On HTA LAB' : 'Coming'}</span></dt>
<dd><p>${esc(def)}</p>${formula ? `<code>${esc(formula)}</code>` : ''}<p class="muted small">${status === 'live' ? 'Where: ' : ''}${esc(where)}</p></dd></div>`).join('')}
</dl></section>`).join('')}
<p class="muted small">${live} of ${all.length} stats are on HTA LAB today. Formulas in detail: <a href="method.html">How we calculate</a>.</p>
<script>(function(){var q=document.getElementById('gl-q'),mode='all';function f(){var t=q.value.toLowerCase();document.querySelectorAll('.gl-item').forEach(function(i){i.hidden=!((mode==='all'||i.dataset.status===mode)&&(!t||i.dataset.text.indexOf(t)>-1));});document.querySelectorAll('.gl-sec').forEach(function(s){s.hidden=!s.querySelector('.gl-item:not([hidden])');});}
q.addEventListener('input',f);document.querySelectorAll('[data-gl]').forEach(function(b){b.addEventListener('click',function(){mode=b.dataset.gl;document.querySelectorAll('[data-gl]').forEach(function(x){x.setAttribute('aria-pressed',x===b);});f();});});})();</script>`,
  'glossary.html', cover({ kicker: 'Reference', title: 'Glossary', lede: `Every stat in basketball analytics, explained in plain words with its formula. ${live} of ${all.length} are already on HTA LAB; the rest are marked as coming.` }));
}

// ---- Matchup (head-to-head) ----
{
  const METRICS = [['ortg', 'Offensive rating', true, 'points per 100'], ['drtg', 'Defensive rating', false, 'allowed per 100'], ['net', 'Net rating', true], ['pace', 'Pace', null, 'possessions per 40'],
    ['efg', 'Effective FG%', true], ['efgD', 'Opponent eFG%', false], ['threeRate', 'Share of shots from three', null], ['threePct', '3P%', true], ['threePctD', 'Opponent 3P%', false],
    ['tov100', 'Turnovers per 100', false], ['tov100D', 'Forced turnovers per 100', true], ['orebPct', 'Offensive rebound %', true], ['drebPct', 'Defensive rebound %', true],
    ['ftr', 'Free throws per 100 shots', true], ['ftrD', 'Opponent FT per 100 shots', false], ['astRate', 'Assisted baskets %', true]];
  const data = {
    defaultA: teams.some((t) => t.code === 'HTA') ? 'HTA' : teams[0]?.code,
    defaultB: teams.find((t) => t.code !== 'HTA')?.code,
    metrics: METRICS,
    teams: teams.map((t) => {
      const list = teamGames(games, t.code);
      return {
        code: t.code, tv: t.tv, name: titleCase(t.name), crest: crests.get(t.code) || null, href: teamHref(t.code),
        w: t.w, l: t.l, rank: t.rank, form: list.slice(0, 5).map((g) => (g.win ? 'W' : 'L')).join(' '),
        ...Object.fromEntries(METRICS.map(([k]) => [k, +t[k].toFixed(2)])), ranks: t.ranks,
        players: players.filter((p) => p.team === t.code).sort((a, b) => b.totalMin - a.totalMin).slice(0, 7)
          .map((p) => ({ name: p.name, href: playerHref(p.id), mpg: +p.mpg.toFixed(1), ppg: +p.ppg.toFixed(1), rpg: +p.rpg.toFixed(1), apg: +p.apg.toFixed(1), pir: +p.pirpg.toFixed(1) }))
      };
    }),
    games: games.map((g) => ({ h: g.home.code, v: g.away.code, hs: g.home.score, vs: g.away.score, date: g.date, round: g.round, gc: g.gameCode, href: gameHref(g.gameCode) }))
  };
  // ---- More for the matchup: situations, quarters, shot zones, every player (with ranks across the league) ----
  const rankIn = (vals, hi) => { const arr = Object.values(vals).filter((v) => v != null && Number.isFinite(v)).sort((x, y) => (hi ? y - x : x - y)); return (v) => (v == null || !Number.isFinite(v) ? null : 1 + arr.indexOf(v)); };
  const X = {};
  for (const t of teams) {
    const list = games.filter((g) => g.home.code === t.code || g.away.code === t.code), n = list.length || 1;
    const fl = FLOW?.find((x) => x.code === t.code), ct = CLUTCH?.teams.find((x) => x.code === t.code), at = ATO?.find((x) => x.code === t.code);
    const sh = ALLSHOTS.filter((x) => x.team === t.code), shD = ALLSHOTS.filter((x) => x.opp === t.code);
    const ctR = ct ? situRates({ secs: ct.secs, poss: ct.poss, possD: ct.possD, pf: ct.pf, pa: ct.pa, box: ct.box, opp: ct.opp }) : null;
    const q = [0, 1, 2, 3].map((i) => { let f = 0, a = 0, k = 0; for (const g of list) { const me = g.home.code === t.code ? g.home : g.away, op = g.home.code === t.code ? g.away : g.home; if (me.quarters?.length > i && op.quarters?.length > i) { f += me.quarters[i]; a += op.quarters[i]; k++; } } return k ? (f - a) / k : null; });
    const benchPg = list.reduce((s2, g) => { const me = g.home.code === t.code ? g.home : g.away; return s2 + me.players.filter((p) => !p.starter).reduce((a, p) => a + p.pts, 0); }, 0) / n;
    X[t.code] = {
      offTO: fl ? fl.offTO / fl.games : null, offTOA: fl ? fl.offTOA / fl.games : null, second: fl ? fl.second / fl.games : null, secondA: fl ? fl.secondA / fl.games : null,
      runs: fl ? fl.runs / fl.games : null, runsA: fl ? fl.runsA / fl.games : null, lastMin: fl ? fl.lastMin / fl.games : null,
      fb: sh.length ? sh.filter((x) => x.made && x.fb).reduce((a, x) => a + (x.is3 ? 3 : 2), 0) / n : null, fbA: shD.length ? shD.filter((x) => x.made && x.fb).reduce((a, x) => a + (x.is3 ? 3 : 2), 0) / n : null,
      paint: sh.length ? 2 * sh.filter((x) => x.made && !x.is3 && (x.z === 'rim' || x.z === 'paint')).length / n : null, paintA: shD.length ? 2 * shD.filter((x) => x.made && !x.is3 && (x.z === 'rim' || x.z === 'paint')).length / n : null,
      bench: benchPg, clutchNet: ctR?.net ?? null, clutchRec: ct ? `${ct.w}–${ct.l}` : null, atoPPP: at && at.off.n ? at.off.pts / at.off.n : null, atoN: at?.off.n ?? null, atoDef: at && at.def.n ? at.def.pts / at.def.n : null,
      q1: q[0], q2: q[1], q3: q[2], q4: q[3],
      zones: sh.length ? { off: zoneRows(sh, ALLSHOTS).map((r) => [r.label, r.pct, r.share, r.lpct, r.m, r.a]), def: zoneRows(shD, ALLSHOTS).map((r) => [r.label, r.pct, r.share, r.lpct, r.m, r.a]),
        svgOff: courtSvg(sh, { mode: 'zones', league: ALLSHOTS, title: 'Offense zones' }), svgDef: courtSvg(shD, { mode: 'zones', league: ALLSHOTS, title: 'Defense zones' }) } : null
    };
  }
  // [key, label, higher is better, hint]
  const XM = [['offTO', 'Points off turnovers', true], ['offTOA', 'Opp points off turnovers', false], ['second', 'Second-chance points', true], ['secondA', 'Opp second-chance points', false],
    ['fb', 'Fast-break points', true], ['fbA', 'Opp fast-break points', false], ['paint', 'Points in the paint', true], ['paintA', 'Opp points in the paint', false],
    ['bench', 'Bench points', true], ['runs', 'Runs of 8+ per game', true], ['runsA', 'Opp runs of 8+ per game', false], ['lastMin', 'Points in last minute of quarters', true],
    ['clutchNet', 'Clutch net rating', true, 'last 5 min, within 5'], ['atoPPP', 'Points per possession after timeouts', true], ['atoDef', 'Allowed after opp timeouts', false],
    ['q1', '1st quarter margin', true], ['q2', '2nd quarter margin', true], ['q3', '3rd quarter margin', true], ['q4', '4th quarter margin', true]].filter(([k]) => teams.some((t) => X[t.code][k] != null));
  for (const [k, , hi] of XM) { const r = rankIn(Object.fromEntries(teams.map((t) => [t.code, X[t.code][k]])), hi); for (const t of teams) { X[t.code].xr ||= {}; X[t.code].xr[k] = r(X[t.code][k]); } }
  data.xmetrics = XM;
  const r1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
  const clutchPts = new Map((CLUTCH?.players || []).map((p) => [p.id + '|' + p.team, p.box.pts]));
  for (const T of data.teams) {
    T.x = Object.fromEntries(Object.entries(X[T.code]).map(([k, v]) => [k, typeof v === 'number' ? r1(v, k.startsWith('ato') ? 2 : 1) : v]));
    T.roster = players.filter((p) => p.team === T.code && p.mpg >= 4 && p.gp >= 2).sort((a, b) => b.totalMin - a.totalMin).map((p) => {
      const t2 = p.totals; const oo = onOffOf(p.id);
      return { name: p.name, href: playerHref(p.id), pos: posOf.get(p.id) || '', gp: p.gp, gs: p.gs, mpg: r1(p.mpg), ppg: r1(p.ppg), rpg: r1(p.rpg), apg: r1(p.apg), spg: r1(p.spg), bpg: r1(p.bpg), tpg: r1(p.tpg),
        p2: t2.fga2 ? r1(100 * t2.fgm2 / t2.fga2) : null, p3: t2.fga3 ? r1(100 * t2.fgm3 / t2.fga3) : null, a3: r1(t2.fga3 / p.gp), ft: t2.fta ? r1(100 * t2.ftm / t2.fta) : null,
        ts: r1(p.ts), usg: r1(p.usg), pir: r1(p.pirpg), pm: r1(p.pmpg), onoff: r1(oo?.swing ?? null), imp: r1(IMPACT?.values.get(p.id) ?? null), clutch: clutchPts.get(p.id + '|' + p.team) ?? null };
    });
  }
  writeFileSync(join(OUT, 'matchup.json'), JSON.stringify(data));
  writePage('matchup.html', 'Matchup', `<div id="matchup-app"><p class="muted">Loading…</p></div>`, 'matchup.html',
    cover({ kicker: esc(roundLine), title: 'Matchup', lede: 'Put any two teams side by side: ratings, four factors, this season’s meetings, key players, and where the mismatches are.' }),
    { scripts: `<script src="matchup.js?v=${assetVersion()}" defer></script>` });
}

// ---- HAPOEL – SCHEDULE: every Hapoel Tel Aviv game of the season, EuroLeague + Winner League ----
if (IS_EL) {
  const H_EL = cfg.hapoelCode || 'HTA';
  const rows = [];
  const byCode = new Map(games.map((g) => [Number(g.gameCode), g]));
  // EuroLeague: the schedule has every game (played and to play) with its time; results from the box scores.
  for (const x of schedule) {
    if (x.h?.code !== H_EL && x.a?.code !== H_EL) continue;
    const g = byCode.get(Number(x.c)), home = x.h.code === H_EL, opp = home ? x.a : x.h;
    const me = g ? (home ? g.home : g.away) : null, op = g ? (home ? g.away : g.home) : null;
    rows.push({ comp: 'EL', utc: x.utc, round: x.r, home, opp: { name: titleCase(opp.name || opp.code), crest: crests.get(opp.code) || null, href: teamHref(opp.code) }, venue: x.venue ? titleCase(x.venue) : '',
      result: me ? { for: me.score, against: op.score } : null, href: g ? gameHref(g.gameCode) : null });
  }
  // EuroLeague games played but missing from the schedule file (should not happen, but never lose a result).
  for (const g of games) if ((g.home.code === H_EL || g.away.code === H_EL) && !schedule.some((x) => Number(x.c) === Number(g.gameCode))) {
    const home = g.home.code === H_EL, me = home ? g.home : g.away, op = home ? g.away : g.home;
    rows.push({ comp: 'EL', utc: g.date + 'T18:00:00Z', dateOnly: true, round: g.round, home, opp: { name: titleCase(op.name), crest: crests.get(op.code) || null, href: teamHref(op.code) }, venue: '', result: { for: me.score, against: op.score }, href: gameHref(g.gameCode) });
  }
  // Winner League (Israel): same data the /il/ pages are built from.
  let ilNote = '';
  const ilDir = join('data', 'raw', cfg.leagues?.il?.dataDir || 'ISR2027');
  if (!sample && existsSync(join(ilDir, '_schedule.json'))) {
    try {
      const ilClubs = JSON.parse(readFileSync(join(ilDir, '_clubs.json')));
      const me = ilClubs.find((c) => /hapoel/i.test(c.name) && /tel[ -]?aviv/i.test(c.name));
      const ilCrest = new Map(ilClubs.map((c) => [c.code, c.crest]));
      if (me) for (const x of JSON.parse(readFileSync(join(ilDir, '_schedule.json')))) {
        if (x.h?.code !== me.code && x.a?.code !== me.code) continue;
        const home = x.h.code === me.code, opp = home ? x.a : x.h;
        let result = null;
        const f = join(ilDir, `${x.c}.json`);
        if (x.played && existsSync(f)) { const g = parseGame(JSON.parse(readFileSync(f))); const mine = home ? g.home : g.away, theirs = home ? g.away : g.home; result = { for: mine.score, against: theirs.score }; }
        rows.push({ comp: 'IL', utc: x.utc, round: x.r, home, opp: { name: titleCase(opp.name || opp.code), crest: ilCrest.get(opp.code) || null, href: `il/team-${safe(opp.code)}.html` }, venue: x.venue || '',
          result, href: result ? `il/game-${safe(String(x.c))}.html` : null });
      }
      else ilNote = 'Hapoel Tel Aviv was not found in the Winner League team list.';
    } catch (err) { ilNote = 'The Winner League schedule could not be read: ' + err.message; }
  }
  rows.sort((a, b) => String(a.utc || '9').localeCompare(String(b.utc || '9')));
  const COMP = { EL: 'EuroLeague', IL: 'Winner League' };
  const rec = (c) => { const r = rows.filter((x) => x.result && (!c || x.comp === c)); const w = r.filter((x) => x.result.for > x.result.against).length; return `${w}–${r.length - w}`; };
  const next = rows.find((x) => !x.result && x.utc && Date.parse(x.utc) > Date.now() - 3 * 3600000);
  const last = [...rows].reverse().find((x) => x.result);
  const months = new Map();
  for (const x of rows) { const k = (x.utc || '').slice(0, 7) || 'tbd'; if (!months.has(k)) months.set(k, []); months.get(k).push(x); }
  const monthName = (k) => (k === 'tbd' ? 'Date to be confirmed' : new Date(k + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
  const row = (x) => {
    const res = x.result ? `<span class="hs-res ${x.result.for > x.result.against ? 'w' : 'l'}">${x.result.for > x.result.against ? 'W' : 'L'} ${x.result.for}–${x.result.against}</span>` : `<span class="hs-res up">${x.utc ? 'Upcoming' : 'TBD'}</span>`;
    const inner = `<span class="hs-date">${x.dateOnly ? esc(fmtDate(x.utc.slice(0, 10))) : x.utc ? `<time data-utc="${esc(x.utc)}" datetime="${esc(x.utc)}">${esc(x.utc.slice(0, 10))}</time>` : 'TBD'}</span>
<span class="hs-comp ${x.comp.toLowerCase()}">${COMP[x.comp]}${x.round ? ` · Rd ${x.round}` : ''}</span>
<span class="hs-ha">${x.home ? 'vs' : '@'}</span>
<span class="hs-opp">${x.opp.crest ? `<img src="${esc(x.opp.crest)}" alt="" width="26" height="26" loading="lazy">` : '<i></i>'}<b>${esc(x.opp.name)}</b></span>
<span class="hs-venue">${esc(x.venue || (x.home ? 'Home' : 'Away'))}</span>${res}`;
    return x.href ? `<a class="hs-row" href="${esc(x.href)}" data-c="${x.comp}" data-h="${x.home ? 1 : 0}" data-p="${x.result ? 1 : 0}">${inner}</a>`
      : `<div class="hs-row" data-c="${x.comp}" data-h="${x.home ? 1 : 0}" data-p="0">${inner}</div>`;
  };
  // Calendar file for phones and Outlook (times in UTC; every calendar shows them in local time).
  const icsDate = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z');
  const icsEsc = (t) => String(t).replace(/[\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HTA LAB//Hapoel schedule//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Hapoel Tel Aviv 2026-27',
    ...rows.filter((x) => x.utc && !x.dateOnly).flatMap((x) => {
      const end = new Date(Date.parse(x.utc) + 2 * 3600000).toISOString();
      return ['BEGIN:VEVENT', `UID:hta-${x.comp}-${x.utc}@hta-lab.github.io`, `DTSTAMP:${icsDate(new Date().toISOString())}`, `DTSTART:${icsDate(x.utc)}`, `DTEND:${icsDate(end)}`,
        `SUMMARY:${icsEsc((x.home ? 'Hapoel Tel Aviv vs ' : x.opp.name + ' vs ') + (x.home ? x.opp.name : 'Hapoel Tel Aviv') + ` (${COMP[x.comp]})` + (x.result ? ` ${x.result.for}–${x.result.against}` : ''))}`,
        ...(x.venue ? [`LOCATION:${icsEsc(x.venue)}`] : []), 'END:VEVENT'];
    }), 'END:VCALENDAR'].join('\r\n');
  writeFileSync(join(OUT, 'hapoel-schedule.ics'), ics);
  writePage('hapoel-schedule.html', 'Hapoel schedule', `
<div class="tiles">
<div class="tile"><span class="label">Season record</span><span class="big">${rec()}</span><span class="sub">EuroLeague ${rec('EL')} · Winner League ${rec('IL')}</span></div>
${next ? `<div class="tile mvp-tile"><span class="label">Next game</span><span class="big hs-next">${next.home ? 'vs' : '@'} ${esc(next.opp.name)}</span><span class="sub"><time data-utc="${esc(next.utc)}">${esc(next.utc.slice(0, 10))}</time> · ${COMP[next.comp]}</span></div>` : ''}
${last ? `<a class="tile" href="${esc(last.href || '#')}"><span class="label">Last game</span><span class="big">${last.result.for > last.result.against ? 'W' : 'L'} ${last.result.for}–${last.result.against}</span><span class="sub">${last.home ? 'vs' : '@'} ${esc(last.opp.name)} · ${COMP[last.comp]}</span></a>` : ''}
<div class="tile"><span class="label">Games</span><span class="big">${rows.length}</span><span class="sub">${rows.filter((x) => x.result).length} played · ${rows.filter((x) => !x.result).length} to play</span></div>
</div>
<section class="card">
<div class="hs-bar"><div class="filters" id="hs-filter">
<label>Competition <select data-f="c"><option value="">All</option><option value="EL">EuroLeague</option><option value="IL">Winner League</option></select></label>
<label>Venue <select data-f="h"><option value="">Home and away</option><option value="1">Home</option><option value="0">Away</option></select></label>
<label>Games <select data-f="p"><option value="">All</option><option value="0">Still to play</option><option value="1">Played</option></select></label>
<span class="muted small" data-f="n"></span></div>
<a class="btn" href="hapoel-schedule.ics" download>Add to my calendar (.ics)</a></div>
${ilNote ? `<p class="note-warn">${esc(ilNote)}</p>` : ''}
${[...months].map(([k, list]) => `<h2 class="hs-month">${esc(monthName(k))}</h2><div class="hs-list">${list.map(row).join('')}</div>`).join('')}
<p class="muted small">Times in your time zone. Click a played game for the full box score and analysis. The calendar file works with iPhone, Google Calendar and Outlook; download it again later to get time changes.</p>
</section>
<script>
(() => {
  const box = document.getElementById('hs-filter'); if (!box) return;
  const f = (k) => box.querySelector('[data-f="' + k + '"]');
  const apply = () => {
    let n = 0;
    document.querySelectorAll('.hs-row').forEach((r) => { const ok = (!f('c').value || r.dataset.c === f('c').value) && (!f('h').value || r.dataset.h === f('h').value) && (!f('p').value || r.dataset.p === f('p').value); r.hidden = !ok; if (ok) n++; });
    document.querySelectorAll('.hs-month').forEach((h) => { const list = h.nextElementSibling; h.hidden = ![...list.children].some((r) => !r.hidden); });
    f('n').textContent = n + ' game' + (n === 1 ? '' : 's');
  };
  box.addEventListener('change', apply); apply();
  const nx = [...document.querySelectorAll('.hs-row[data-p="0"]')][0]; if (nx) nx.classList.add('hs-isnext');
})();
</script>`, 'hapoel-schedule.html', cover({ kicker: 'Hapoel Tel Aviv', title: 'Hapoel schedule', lede: 'Every game of the season in one place — EuroLeague and Winner League — with results, upcoming games in your time zone and a calendar file for your phone.' }));
  console.log(`✓ Hapoel schedule: ${rows.length} games (${rows.filter((x) => x.comp === 'EL').length} EuroLeague, ${rows.filter((x) => x.comp === 'IL').length} Winner League)`);
}

// ---- HAPOEL – INTERNAL (password-protected, encrypted in the browser) ----
if (IS_EL) {
  const IC = cfg.internal || {};
  const encFiles = existsSync('internal') ? readdirSync('internal').filter((f) => /^[a-z0-9][a-z0-9-]{0,80}\.enc$/.test(f)).sort() : [];
  mkdirSync(join(OUT, 'internal'), { recursive: true });
  for (const f of encFiles) {
    const text = readFileSync(join('internal', f), 'utf8');
    try { const o = JSON.parse(text); if (![1, 2].includes(o.v) || !o.iv || !o.ct) throw new Error('not an encrypted document'); }
    catch (e) { console.warn(`Skipping internal/${f}: ${e.message}`); continue; }
    writeFileSync(join(OUT, 'internal', f), text);
  }
  // Encrypted file parts (binary). Published only if their description file is published.
  const partFiles = existsSync('internal') ? readdirSync('internal').filter((f) => /^[a-z0-9][a-z0-9-]{0,80}-\d{1,3}\.part$/.test(f)) : [];
  for (const f of partFiles) {
    const owner = f.replace(/-\d{1,3}\.part$/, '.enc');
    if (encFiles.includes(owner)) copyFileSync(join('internal', f), join(OUT, 'internal', f));
  }
  const published = encFiles.filter((f) => existsSync(join(OUT, 'internal', f)));
  writeFileSync(join(OUT, 'internal', 'index.json'), JSON.stringify(published));
  // Warn loudly if anything that is not an encrypted document was put in the folder.
  if (existsSync('internal')) for (const f of readdirSync('internal')) {
    if (f !== 'README.md' && !f.endsWith('.enc') && !f.endsWith('.part')) console.warn(`WARNING: internal/${f} is not an encrypted .enc file. It is NOT published, but it IS visible in the public GitHub repository. Delete it there.`);
  }
  // The repository is taken from GitHub Actions when building there, so the site keeps working if it moves.
  const REPO = process.env.GITHUB_REPOSITORY || IC.repo;
  const BRANCH = process.env.GITHUB_REF_NAME || 'main';
  const clientCfg = JSON.stringify({ salt: IC.salt, iterations: IC.iterations, uploadUrl: `https://github.com/${REPO}/upload/${BRANCH}/internal`, repo: REPO, branch: BRANCH, categories: IC.categories, teams: teams.map((t) => titleCase(t.name)).sort() }).replace(/</g, '\\u003c');
  const extra = {
    head: '<meta name="robots" content="noindex, nofollow">',
    scripts: `<script>window.HTA_INTERNAL = ${clientCfg};</script>\n<script src="internal.js?v=${assetVersion()}" defer></script>`
  };
  const internalCover = (lede) => cover({ kicker: 'Staff only', title: esc(IC.title || 'Internal'), lede });
  writePage('internal.html', IC.title || 'Internal', `<div id="internal-app" data-mode="vault"><p class="muted">Loading…</p></div>
<noscript><p>The internal section needs JavaScript.</p></noscript>`, 'internal.html',
    internalCover('Strategy, scouting reports and game plans for the Hapoel staff. Every document is locked with the team password and opened only on your device.'), extra);
  writePage('internal-upload.html', 'Add internal document', `<div id="internal-app" data-mode="upload"><p class="muted">Loading…</p></div>`, 'internal.html',
    internalCover('Add a document. It is locked here in your browser before it goes anywhere.'), extra);
  console.log(`✓ Internal section: ${published.length} encrypted document(s)`);
}

// ---- Scouting: staff database (encrypted in the repository) + official stats pool ----
if (IS_EL) {
  const IC = cfg.internal || {};
  const today = new Date().toISOString().slice(0, 10);
  const el = poolRows(players, { src: 'EL', teamName: (c) => titleCase(teams.find((t) => t.code === c)?.name || c), people: peopleIndex, crests, today });
  const ecRows = [], ecNotes = [];
  for (const season of sample ? [] : (cfg.scoutingSeasons || [])) {
    const r = poolFromDir(join('data', 'raw', season), season[0] === 'U' ? 'EC' : season[0], today);
    for (const row of r.rows) { row[4] = titleCase(row[4]); ecRows.push(row); }
    if (r.games) ecNotes.push(`EuroCup: ${r.rows.length} players from ${r.games} games`);
    console.log(`✓ Scouting pool ${season}: ${r.rows.length} players from ${r.games} games` + (r.skipped ? ` (${r.skipped} games left out by the checks)` : ''));
  }
  for (const [key, L] of sample ? [] : Object.entries(cfg.leagues || {})) {
    const r = poolFromDir(join('data', 'raw', L.dataDir), L.poolCode, today);
    for (const row of r.rows) { if (L.poolCode === 'EC') row[4] = titleCase(row[4]); ecRows.push(row); }
    if (r.games) ecNotes.push(`${L.leagueName}: ${r.rows.length} players from ${r.games} games`);
    console.log(`✓ Scouting pool ${key}: ${r.rows.length} players from ${r.games} games` + (r.skipped ? ` (${r.skipped} games left out by the checks)` : ''));
  }
  writeFileSync(join(OUT, 'scouting-pool.json'), JSON.stringify({ note: [`EuroLeague: ${el.length} players from ${info.games} games`, ...ecNotes].join(' · ') + '. Official stats, updated nightly.', players: [...el, ...ecRows] }));
  const REPO = process.env.GITHUB_REPOSITORY || IC.repo;
  const BRANCH = process.env.GITHUB_REF_NAME || 'main';
  const sc = JSON.stringify({ salt: IC.salt, iterations: IC.iterations, repo: REPO, branch: BRANCH, path: 'scouting/db.enc', seasonLabel: cfg.seasonLabel }).replace(/</g, '\\u003c');
  writePage('scouting.html', 'Scouting', `<div id="scouting-app"><p class="muted">Loading…</p></div><noscript><p>The scouting section needs JavaScript.</p></noscript>`, 'scouting.html',
    cover({ kicker: 'Staff only', title: 'Scouting', lede: 'Every EuroLeague and EuroCup player with official stats, plus anyone in the world you add or import. Build folders, rate players, write notes — locked with the team password and shared with the whole staff.' }),
    { head: '<meta name="robots" content="noindex, nofollow">', scripts: `<script>window.HTA_SCOUT = ${sc};</script>\n<script src="scouting.js?v=${assetVersion()}" defer></script>` });
}

// Static files + data for the browser
mkdirSync(OUT, { recursive: true });
copyFileSync('static/style.css', join(OUT, 'style.css'));
copyFileSync('static/app.js', join(OUT, 'app.js'));
copyFileSync('static/internal.js', join(OUT, 'internal.js'));
copyFileSync('static/matchup.js', join(OUT, 'matchup.js'));
copyFileSync('static/splitlineups.js', join(OUT, 'splitlineups.js'));
copyFileSync('static/lineups.js', join(OUT, 'lineups.js'));
copyFileSync('static/teams.js', join(OUT, 'teams.js'));
copyFileSync('static/teambox.js', join(OUT, 'teambox.js'));
copyFileSync('static/share.js', join(OUT, 'share.js'));
if (existsSync('static/gamequarters.js')) copyFileSync('static/gamequarters.js', join(OUT, 'gamequarters.js'));
if (existsSync('static/quarter-split.js')) copyFileSync('static/quarter-split.js', join(OUT, 'quarter-split.js'));
copyFileSync('static/game.js', join(OUT, 'game.js'));
copyFileSync('static/mvp.js', join(OUT, 'mvp.js'));
copyFileSync('static/boards.js', join(OUT, 'boards.js'));
copyFileSync('static/charges.js', join(OUT, 'charges.js'));
copyFileSync('static/players.js', join(OUT, 'players.js'));
copyFileSync('static/scouting.js', join(OUT, 'scouting.js'));
copyFileSync('static/live.js', join(OUT, 'live.js'));
for (const f of ['clips.js', 'staff.js', 'keys.js', 'injuries.js']) if (existsSync('static/' + f)) copyFileSync('static/' + f, join(OUT, f));
mkdirSync(join(OUT, 'lib'), { recursive: true });
for (const f of ['parse.mjs', 'pbp.mjs', 'game.mjs', 'zones.mjs']) copyFileSync(join('lib', f), join(OUT, 'lib', f));
writeFileSync(join(OUT, 'players.json'), JSON.stringify(players.map((p) => ({
  id: p.id, name: p.name, team: teamName.get(p.team) ? titleCase(teamName.get(p.team)) : p.team, tv: p.tv, gp: p.gp,
  stats: [['PTS', p.ppg], ['REB', p.rpg], ['AST', p.apg], ['STL', p.spg], ['BLK', p.bpg], ['PIR', p.pirpg], ['MIN', p.mpg], ['TS%', p.ts], ['USG%', p.usg]].map(([k, v]) => [k, f1(v)])
}))));
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`Quarter box: ${QB_CHECK.games} games with play-by-play, ${QB_CHECK.time} playing time exact, ${QB_CHECK.stats} quarter stats exact`, JSON.stringify(QB_CHECK.why), QB_CHECK.ex || '');
console.log(`✓ Site written to ${OUT}/ (${teams.length} teams, ${players.length} players)`);

function boardsJson() {
  const isQ = new Set(qual.map((q) => q.id));
  const PK = [...new Set(BOARD_REG.flatMap((b) => (b.parts || []).map(([k]) => k)))];
  const rnd = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  return JSON.stringify({
    boards: BOARD_REG.map((b) => ({ id: b.id, fmt: b.fmt, asc: b.asc, all: b.all, parts: b.parts ? b.parts.map(([k, l, c]) => [PK.indexOf(k), l, c]) : null })),
    teams: teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.code, titleCase(t.name)]),
    players: players.map((p) => [p.name, p.tv, p.team, playerHref(p.id), findPerson(peopleIndex, p)?.position || '', p.gp, +p.mpg.toFixed(1), isQ.has(p.id) ? 1 : 0,
      BOARD_REG.map((b) => rnd(b.val(p))), PK.map((k) => rnd(p[k]))])
  }).replace(/</g, '\\u003c');
}

function writePage(file, title, body, active, hero, extra = {}) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, file), page({ title, cfg, info, active, sample, body, hero, ...extra }));
}
