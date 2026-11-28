import { test } from 'node:test';
import assert from 'node:assert/strict';
import { possessions, byStart } from '../lib/possessions.mjs';
// [period, clock, side, pid, type, hs, as, t]
const plays = [
  [1, '10:00', '', '', 'BP', 0, 0, 0],
  [1, '09:40', 'H', 'h1', '2FGM', 2, 0, 20],          // H scores, A ball after made basket
  [1, '09:20', 'A', 'a1', 'TO', 2, 0, 40],            // A turnover, stolen by H
  [1, '09:19', 'H', 'h2', 'ST', 2, 0, 41],
  [1, '09:15', 'H', 'h2', '2FGM', 4, 0, 45],          // quick basket off the steal
  [1, '09:00', 'A', 'a2', 'TO', 4, 0, 60],            // A offensive foul (dead ball)
  [1, '09:00', 'A', 'a2', 'OF', 4, 0, 60],
  [1, '08:40', 'H', 'h1', '3FGA', 4, 0, 80],
  [1, '08:38', 'A', 'a1', 'D', 4, 0, 82],             // A defensive rebound
  [1, '08:30', 'A', 'a1', '3FGM', 4, 3, 90],
  [1, '00:00', '', '', 'EP', 4, 3, 600]
];
test('possessions: start types, points and quick points', () => {
  const P = possessions(plays);
  assert.deepEqual(P.map((x) => [x.team, x.start, x.pts, x.quick]), [['H', 'period', 2, 0], ['A', 'made', 0, 0], ['H', 'steal', 2, 2], ['A', 'made', 0, 0], ['H', 'offfoul', 0, 0], ['A', 'dreb', 3, 3], ['H', 'made', 0, 0]]);
  const h = byStart(P, 'H');
  assert.equal(h.steal.quick, 2);
  assert.equal(P.find((x) => x.start === 'steal').cause.by, 'h2');
});
