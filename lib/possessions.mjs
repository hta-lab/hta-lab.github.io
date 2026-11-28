// Splits the play-by-play into possessions and records how each one started.
// plays: playLog rows [period, clock, side ('H'|'A'|''), playerId, type, homeScore, awayScore, t (elapsed seconds)]
//
// A possession of team X starts after the other team's:
//   'made'    made basket or made last free throw (X brings the ball up against a set defense)
//   'dreb'    missed shot that X rebounded (a live ball, X can run)
//   'steal'   turnover that X stole (a live ball, X can run)
//   'offfoul' offensive foul / charge (dead ball, X inbounds)
//   'dead'    other turnover: out of bounds, travel, shot clock, 3 seconds… (dead ball, X inbounds)
//   'period'  start of a quarter
// pts = points X scored before the ball changed hands; quick = points scored in the first 8 seconds.

const PTS = { '2FGM': 2, '3FGM': 3, FTM: 1 };
const SHOT = new Set(['2FGM', '2FGA', '3FGM', '3FGA']);
const other = (s) => (s === 'H' ? 'A' : s === 'A' ? 'H' : '');
export const START_TYPES = [['made', 'After their made basket'], ['dreb', 'After a defensive rebound'], ['steal', 'After a steal (live ball)'], ['offfoul', 'After their offensive foul'], ['dead', 'After their other turnovers (dead ball)'], ['period', 'Start of a quarter']];

export function possessions(plays) {
  const out = [];
  let cur = null;
  const open = (team, start, t, cause = null) => { cur = { team, start, t0: t, t1: t, pts: 0, quick: 0, first: null, firstType: null, cause }; };
  const close = (t) => { if (cur) { cur.t1 = t; out.push(cur); } cur = null; };
  const lastFtOfTrip = (i) => { const p = plays[i]; for (let j = i + 1; j < plays.length && j <= i + 6; j++) { const q = plays[j]; if (q[7] !== p[7]) break; if ((q[4] === 'FTM' || q[4] === 'FTA') && q[2] === p[2]) return false; } return true; };
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i], [per, , side, pid, type, , , t] = p;
    if (type === 'EP') { close(t); continue; }
    if (type === 'BP') { close(t); continue; }
    if (!side || type === 'IN' || type === 'OUT' || type === 'TOUT' || type === 'TOUT_TV' || type === 'JB') {
      // team rebounds / team turnovers have a side but no player: handled below by type
      if (!side) continue;
      if (type === 'IN' || type === 'OUT' || type === 'TOUT' || type === 'TOUT_TV' || type === 'JB') continue;
    }
    const offensive = SHOT.has(type) || type === 'TO' || type === 'FTM' || type === 'FTA' || type === 'O';
    if (!cur) {
      const ps = per <= 4 ? (per - 1) * 600 : 2400 + (per - 5) * 300; // the quarter's first second
      if (offensive || type === 'D') open(side, 'period', ps);
      else continue;
    }
    // free throws right after the same team's made basket (and-one): they belong to that possession
    if ((type === 'FTM' || type === 'FTA') && side !== cur.team) {
      const prev = out[out.length - 1];
      if (prev && prev.team === side && Math.abs(t - prev.t1) <= 2) {
        if (type === 'FTM') { prev.pts += 1; if (t - prev.t0 <= 8) prev.quick += 1; }
        cur.t0 = t; // the other team's possession really starts after the free throw
        continue;
      }
      // a possession change we did not see (e.g. a foul on the floor before a shot): start one for this side
      close(t); open(side, 'other', t);
    }
    if (SHOT.has(type) && side !== cur.team) { close(t); open(side, 'dreb', t); }
    if (side === cur.team) {
      if (!cur.first && (SHOT.has(type) || type === 'TO' || type === 'FTM' || type === 'FTA')) { cur.first = pid || null; cur.firstType = type; }
      if (PTS[type]) { cur.pts += PTS[type]; if (t - cur.t0 <= 8) cur.quick += PTS[type]; }
      if (type === '2FGM' || type === '3FGM') { const team = cur.team; close(t); open(other(team), 'made', t, { type, pid }); continue; }
      if ((type === 'FTM' || type === 'FTA') && lastFtOfTrip(i)) {
        if (type === 'FTM') { const team = cur.team; close(t); open(other(team), 'made', t, { type, pid }); }
        continue; // a missed last free throw: the rebound decides
      }
      if (type === 'TO') {
        let kind = 'dead', by = null;
        for (let j = i + 1; j < plays.length && j <= i + 4; j++) { const q = plays[j]; if (q[7] - t > 3) break; if (q[4] === 'ST' && q[2] === other(side)) { kind = 'steal'; by = q[3]; break; } }
        if (kind === 'dead') for (let j = Math.max(0, i - 2); j < plays.length && j <= i + 2; j++) { const q = plays[j]; if (q[4] === 'OF' && q[2] === side && Math.abs(q[7] - t) <= 1) { kind = 'offfoul'; break; } }
        const team = cur.team; close(t); open(other(team), kind, t, { type: 'TO', pid, kind, by }); continue;
      }
    } else if (type === 'D') { const team = cur.team; close(t); open(other(team), 'dreb', t, { type: 'D', pid }); continue; }
  }
  close(plays.length ? plays[plays.length - 1][7] : 0);
  return out.filter((x) => x.team);
}

/** Sum possessions of one side into rows by start type. */
export function byStart(list, team) {
  const o = Object.fromEntries(START_TYPES.map(([k]) => [k, { n: 0, pts: 0, quick: 0, scored: 0 }]));
  for (const x of list) { if (x.team !== team || !o[x.start]) continue; const r = o[x.start]; r.n++; r.pts += x.pts; r.quick += x.quick; if (x.pts > 0) r.scored++; }
  return o;
}
