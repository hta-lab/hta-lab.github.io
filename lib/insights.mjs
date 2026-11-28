// Deeper game analysis from the official play-by-play: scoring runs, foul trouble, start and end of quarters,
// score situations, win probability, passing networks, shot quality and coaches' habits.
// Every function works on games that passed the box-score check (pbpOk entries) and their play logs.
//
// plays: playLog rows [period, clock, side ('H'|'A'|''), playerId, type, homeScore, awayScore, t (elapsed seconds)]

import { groupOf } from './zones.mjs';

const PTS = { '2FGM': 2, '3FGM': 3, FTM: 1 };
const FOUL = new Set(['CM', 'OF', 'CMU', 'CMT', 'CMD']);
const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
const gameEnd = (plays) => Math.max(2400, ...plays.map((p) => p[7] || 0));
/** Seconds each player was on the court between a and b (elapsed game seconds). */
export function onCourtSecs(periodStints, side, a, b) {
  const out = new Map();
  for (const s of periodStints) { if (s.start == null) continue; const lo = Math.max(a, s.start), hi = Math.min(b, s.start + s.secs); if (hi <= lo) continue; for (const id of s[side]) out.set(id, (out.get(id) || 0) + hi - lo); }
  return out;
}
/** Who was on the court at time t (the stint that covers t). */
export function onCourtAt(periodStints, t) {
  const s = periodStints.find((x) => x.start != null && t >= x.start && t < x.start + Math.max(x.secs, 1)) || periodStints.filter((x) => x.start != null && x.start <= t).pop();
  return s ? { home: s.home, away: s.away } : { home: [], away: [] };
}

// ---------- runs ----------
/** Unanswered scoring runs of minLen+ points. Each: { side, pts, t0, t1, period, clock0, clock1, scoreBefore, oppTov, oppMiss, oppMiss3, timeoutBy (side or ''), stopper, stopT, onStart } */
export function runs(plays, periodStints, minLen = 8) {
  const out = []; let cur = null;
  const close = (stopRow) => {
    if (cur && cur.pts >= minLen) {
      const victim = cur.side === 'H' ? 'A' : 'H';
      const during = plays.filter((p) => p[7] >= cur.t0s && p[7] <= cur.t1 && p !== stopRow);
      const oc = onCourtAt(periodStints, cur.t0);
      out.push({ side: cur.side, pts: cur.pts, t0: cur.t0, t1: cur.t1, period: cur.period, clock0: cur.clock0, clock1: cur.clock1, scoreBefore: cur.scoreBefore,
        oppTov: during.filter((p) => p[2] === victim && p[4] === 'TO').length, oppMiss: during.filter((p) => p[2] === victim && (p[4] === '2FGA' || p[4] === '3FGA')).length,
        oppMiss3: during.filter((p) => p[2] === victim && p[4] === '3FGA').length,
        timeoutBy: during.some((p) => p[4] === 'TOUT' && p[2] === victim) ? victim : during.some((p) => p[4] === 'TOUT' && p[2] === cur.side) ? cur.side : '',
        subsBy: during.filter((p) => p[4] === 'IN' && p[2] === victim).length,
        stopper: stopRow ? stopRow[3] : null, stopType: stopRow ? stopRow[4] : null, stopT: stopRow ? stopRow[7] : null,
        onStart: { H: oc.home, A: oc.away } });
    }
    cur = null;
  };
  let lastScoreT = 0, prevH = 0, prevA = 0;
  for (const p of plays) {
    const pts = PTS[p[4]]; if (!pts || !p[2]) continue;
    if (cur && cur.side === p[2]) { cur.pts += pts; cur.t1 = p[7]; cur.clock1 = p[1]; }
    else { close(p); cur = { side: p[2], pts, t0: p[7], t0s: lastScoreT, t1: p[7], period: p[0], clock0: p[1], clock1: p[1], scoreBefore: [prevH, prevA] }; }
    lastScoreT = p[7]; prevH = p[5]; prevA = p[6];
  }
  close(null);
  return out;
}

// ---------- foul trouble ----------
/** Foul trouble episodes: 2nd foul in the first half, or 4th foul before the last 2 minutes of the 4th quarter. */
export function foulTrouble(plays, periodStints, side) {
  const fouls = new Map(), out = [];
  const sk = side === 'H' ? 'home' : 'away';
  for (const p of plays) {
    if (p[2] !== side || !p[3] || !FOUL.has(p[4])) continue;
    const n = (fouls.get(p[3]) || 0) + 1; fouls.set(p[3], n);
    const t = p[7];
    let until = null, kind = null;
    if (n === 2 && t < 1200) { until = 1200; kind = '2nd foul, 1st half'; }
    else if (n === 3 && t < 900) { until = 1200; kind = '3rd foul, 1st half'; }
    else if (n === 4 && t < 2280 && t >= 1200) { until = 2400; kind = '4th foul, 2nd half'; }
    if (!until) continue;
    const played = onCourtSecs(periodStints, sk, t, until).get(p[3]) || 0;
    const prior = onCourtSecs(periodStints, sk, 0, t).get(p[3]) || 0;
    out.push({ pid: p[3], kind, t, left: until - t, played, share: t ? prior / t : 0 });
  }
  const fouledOut = [...fouls].filter(([, n]) => n >= 5).map(([id]) => id);
  return { episodes: out, fouledOut, fouls };
}

// ---------- windows: start and end of quarters ----------
export const WINDOWS = [['q1s', 'First 3 min of the game', 0, 180], ['q3s', 'First 3 min after halftime', 1200, 1380],
  ['q1e', 'Last 2 min of Q1', 480, 600], ['q2e', 'Last 2 min before halftime', 1080, 1200], ['q3e', 'Last 2 min of Q3', 1680, 1800], ['q4e', 'Last 2 min of Q4', 2280, 2400]];
/** Points for and against in each window, from the side's point of view. */
export function windowPoints(plays, side) {
  const o = Object.fromEntries(WINDOWS.map(([k]) => [k, { pf: 0, pa: 0 }]));
  for (const p of plays) { const pts = PTS[p[4]]; if (!pts || !p[2]) continue; for (const [k, , a, b] of WINDOWS) if (p[7] > a && p[7] <= b) o[k][p[2] === side ? 'pf' : 'pa'] += pts; }
  return o;
}

// ---------- score situations ----------
export const STATES = [['up10', 'Up 10 or more'], ['close', 'Within 9'], ['dn10', 'Down 10 or more'], ['garbage', 'Garbage time (left out above)']];
/** Points and possessions by the score margin before each play (side's view). Garbage time: 4th quarter with a 20+ margin, or 15+ in the last 4 minutes. */
export function scoreStates(plays, side) {
  const o = Object.fromEntries(STATES.map(([k]) => [k, { pf: 0, pa: 0, fga: 0, oreb: 0, tov: 0, fta: 0, ofga: 0, ooreb: 0, otov: 0, ofta: 0, secs: 0 }]));
  let m = 0, lastT = 0;
  const stateOf = (t) => { const a = Math.abs(m); if (t >= 1800 && (a >= 20 || (t >= 2160 && a >= 15))) return 'garbage'; return m >= 10 ? 'up10' : m <= -10 ? 'dn10' : 'close'; };
  for (const p of plays) {
    const t = p[7], st = o[stateOf(t)]; st.secs += Math.max(0, Math.min(t, 2400) - lastT); lastT = Math.max(lastT, Math.min(t, 2400));
    if (!p[2]) continue;
    const mine = p[2] === side, ty = p[4];
    if (PTS[ty]) st[mine ? 'pf' : 'pa'] += PTS[ty];
    if (ty === '2FGM' || ty === '2FGA' || ty === '3FGM' || ty === '3FGA') st[mine ? 'fga' : 'ofga']++;
    else if (ty === 'O') st[mine ? 'oreb' : 'ooreb']++;
    else if (ty === 'TO') st[mine ? 'tov' : 'otov']++;
    else if (ty === 'FTM' || ty === 'FTA') st[mine ? 'fta' : 'ofta']++;
    const d = p[5] - p[6]; m = side === 'H' ? d : -d;
  }
  return o;
}
export const possOf = (s) => ({ off: s.fga - s.oreb + s.tov + 0.44 * s.fta, def: s.ofga - s.ooreb + s.otov + 0.44 * s.ofta });

// ---------- win probability ----------
/** Home win chance after every play. hca: home edge in points for a full game; sigma: spread of a full-game margin. */
export function winProb(plays, { hca = 2.5, sigma = 12 } = {}) {
  const end = gameEnd(plays);
  const wp = (m, t) => { const left = Math.max(0, Math.min(2400, 2400 - t) + (t > 2400 ? Math.max(0, end - t) : 0)); const f = left / 2400; if (f <= 0.0005) return m > 0 ? 1 : m < 0 ? 0 : 0.5; return Phi((m + hca * f) / (sigma * Math.sqrt(f))); };
  const line = [[0, wp(0, 0)]]; const swings = [];
  let prev = line[0][1];
  plays.forEach((p, i) => {
    if (!PTS[p[4]] && p[4] !== 'EP') return;
    const v = wp(p[5] - p[6], p[7]);
    if (PTS[p[4]]) swings.push({ i, d: v - prev, row: p, before: prev, after: v });
    line.push([p[7], v]); prev = v;
  });
  const last = plays[plays.length - 1]; if (last) line.push([last[7], last[5] > last[6] ? 1 : last[5] < last[6] ? 0 : 0.5]);
  swings.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return { line, swings: swings.slice(0, 5), end };
}
/** SVG of the win-probability line (home on top). */
export function winProbSvg(line, end, { home = 'Home', away = 'Away', hc = '#c8102e', ac = '#1f4e8c', marks = [] } = {}) {
  const W = 760, H = 220, P = 34, x = (t) => P + (W - 2 * P) * t / end, y = (v) => 12 + (H - 36) * (1 - v);
  const pts = line.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const qs = [600, 1200, 1800, 2400, ...(end > 2400 ? [2700, 3000, 3300].filter((q) => q < end) : [])];
  return `<svg class="wp-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Win probability through the game"><rect x="${P}" y="12" width="${W - 2 * P}" height="${H - 36}" fill="none" stroke="#ddd"/>
<line x1="${P}" x2="${W - P}" y1="${y(0.5)}" y2="${y(0.5)}" stroke="#bbb" stroke-dasharray="3 3"/>${qs.map((q) => `<line x1="${x(q)}" x2="${x(q)}" y1="12" y2="${H - 24}" stroke="#eee"/>`).join('')}
<polygon points="${P},${y(0.5)} ${pts} ${x(end)},${y(0.5)}" fill="${hc}" fill-opacity=".08"/><polyline points="${pts}" fill="none" stroke="#222" stroke-width="1.6"/>
${marks.map((m, i) => `<circle cx="${x(m.t).toFixed(1)}" cy="${y(m.v).toFixed(1)}" r="8" fill="#fff" stroke="#222"/><text x="${x(m.t).toFixed(1)}" y="${(y(m.v) + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700">${i + 1}</text>`).join('')}
<text x="${P + 4}" y="24" font-size="11" fill="${hc}" font-weight="700">${home} 100%</text><text x="${P + 4}" y="${H - 28}" font-size="11" fill="${ac}" font-weight="700">${away} 100%</text>
${['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => `<text x="${x(300 + 600 * i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#888">${q}</text>`).join('')}</svg>`;
}

// ---------- passing ----------
/** Assist pairs for one side over many games: Map "from|to" -> { from, to, n, pts }. */
export function assistPairs(list) {
  const m = new Map();
  for (const { pairs, side } of list) for (const e of pairs) { if (e.side !== side) continue; const k = e.from + '|' + e.to; const o = m.get(k) || { from: e.from, to: e.to, n: 0, pts: 0, p3: 0 }; o.n += e.n; o.pts += e.pts; m.set(k, o); }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
/** Circular passing-network SVG. nodes: [{id, label, ast, made}] edges: [{from, to, n}] */
export function passingSvg(nodes, edges) {
  const W = 560, H = 480, cx = W / 2, cy = H / 2 + 6, R = 175;
  const pos = new Map(nodes.map((n, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / nodes.length; return [n.id, [cx + R * Math.cos(a), cy + R * Math.sin(a), a]]; }));
  const maxN = Math.max(1, ...edges.map((e) => e.n)), maxA = Math.max(1, ...nodes.map((n) => n.ast + n.made));
  const ed = edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.n >= 2).sort((a, b) => a.n - b.n).map((e) => {
    const [x1, y1] = pos.get(e.from), [x2, y2] = pos.get(e.to); const mx = (x1 + x2) / 2 + (cy - (y1 + y2) / 2) * 0.18, my = (y1 + y2) / 2 - (cx - (x1 + x2) / 2) * 0.18;
    const w = 0.8 + 7 * e.n / maxN; return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="#c8102e" stroke-opacity="${(0.25 + 0.6 * e.n / maxN).toFixed(2)}" stroke-width="${w.toFixed(1)}" marker-end="url(#pn-arrow)"><title>${e.fromLabel} → ${e.toLabel}: ${e.n} assists</title></path>`;
  }).join('');
  const nd = nodes.map((n) => { const [x, y, a] = pos.get(n.id); const r = 10 + 16 * Math.sqrt((n.ast + n.made) / maxA); const lx = cx + (R + r + 12) * Math.cos(a), ly = cy + (R + r + 12) * Math.sin(a); const anchor = Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" stroke="#222" stroke-width="1.5"><title>${n.label}: ${n.ast} assists given, ${n.made} made shots</title></circle><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700">${n.ast}</text><text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="12">${n.label}</text>`; }).join('');
  return `<svg class="pn-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Passing network"><defs><marker id="pn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c8102e"/></marker></defs>${ed}${nd}</svg>`;
}

// ---------- shot quality ----------
/** Points per shot in each zone across the league, then expected points for any group of shots. */
export function shotModel(allShots) {
  const z = {};
  for (const s of allShots) { if (!s.z) continue; const k = groupOf(s.z); z[k] ||= { a: 0, pts: 0 }; z[k].a++; if (s.made) z[k].pts += s.is3 ? 3 : 2; }
  const pps = Object.fromEntries(Object.entries(z).map(([k, v]) => [k, v.pts / v.a]));
  const sum = (shots) => { let a = 0, pts = 0, x = 0; for (const s of shots) { if (!s.z) continue; a++; if (s.made) pts += s.is3 ? 3 : 2; x += pps[groupOf(s.z)] || 0; } return { a, pts, x, diff: a ? 100 * (pts - x) / a : 0, xpps: a ? x / a : 0, pps: a ? pts / a : 0 }; };
  return { pps, sum };
}

// ---------- coaches' habits ----------
/** One team's habits in one game: timeouts (time, opponent run before), first substitution, starters' Q1 minutes, players used late. */
export function coachGame(plays, periodStints, side, starters) {
  const sk = side === 'H' ? 'home' : 'away', other = side === 'H' ? 'A' : 'H';
  const tos = [];
  plays.forEach((p, i) => {
    if (p[4] !== 'TOUT' || p[2] !== side) return;
    // opponent points since our last score (the run the timeout answered), and margin change in the last 2 minutes
    let oppRun = 0; for (let j = i - 1; j >= 0; j--) { const q = plays[j]; if (!PTS[q[4]] || !q[2]) continue; if (q[2] === side) break; oppRun += PTS[q[4]]; }
    let last2 = 0; for (let j = i - 1; j >= 0 && plays[j][7] >= p[7] - 120; j--) { const q = plays[j]; if (PTS[q[4]] && q[2]) last2 += q[2] === side ? PTS[q[4]] : -PTS[q[4]]; }
    const m = side === 'H' ? p[5] - p[6] : p[6] - p[5];
    tos.push({ t: p[7], period: p[0], oppRun, last2, margin: m });
  });
  const firstOut = plays.find((p) => p[0] === 1 && p[2] === side && p[4] === 'OUT');
  const q1 = onCourtSecs(periodStints, sk, 0, 600);
  const startersQ1 = starters.length ? starters.reduce((a, id) => a + (q1.get(id) || 0), 0) / starters.length : null;
  // last 5 minutes of the 4th quarter: who played, and was it close at 35:00
  const at35 = plays.filter((p) => p[7] <= 2100).pop(); const m35 = at35 ? Math.abs(at35[5] - at35[6]) : 0;
  const late = onCourtSecs(periodStints, sk, 2100, 2400);
  const all = onCourtSecs(periodStints, sk, 0, 2400);
  return { tos, firstSub: firstOut ? firstOut[7] : null, startersQ1, lateUsed: [...late.values()].filter((s) => s >= 30).length, close35: m35 <= 8, used: [...all.values()].filter((s) => s >= 60).length, other };
}
