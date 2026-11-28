// HTML building blocks. Charts are drawn as SVG at build time, so the site
// works without JavaScript; site/app.js only adds hover details and filters.

// Changes on every build so browsers fetch the new style.css / app.js instead of an old cached copy.
const BUILD = Date.now().toString(36);
export const assetVersion = () => BUILD;

export const esc =(s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');
export const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);

function niceRange(values, pad = 0.08) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

function ticks([lo, hi], n = 5) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/**
 * points: [{x, y, label?, title, attrs?}]
 * opts: {xLabel, yLabel, invertY, avgX, avgY, big (label inside dots), id, hidden, cornerGood, cornerBad}
 */
export function scatter(points, opts) {
  const W = 760, H = 500, L = 56, R = 16, T = 16, B = 48;
  const xr = niceRange(points.map((p) => p.x));
  const yr = niceRange(points.map((p) => p.y));
  const sx = (v) => L + ((v - xr[0]) / (xr[1] - xr[0])) * (W - L - R);
  const sy = (v) => opts.invertY
    ? T + ((v - yr[0]) / (yr[1] - yr[0])) * (H - T - B)
    : H - B - ((v - yr[0]) / (yr[1] - yr[0])) * (H - T - B);
  const rad = opts.big ? 17 : 6;
  const grid = [
    ...ticks(xr).map((v) => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${H - B}" class="grid"/><text x="${sx(v)}" y="${H - B + 18}" class="tick" text-anchor="middle">${v}</text>`),
    ...ticks(yr).map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="grid"/><text x="${L - 8}" y="${sy(v) + 4}" class="tick" text-anchor="end">${v}</text>`)
  ].join('');
  const avg = [
    opts.avgX != null ? `<line x1="${sx(opts.avgX)}" x2="${sx(opts.avgX)}" y1="${T}" y2="${H - B}" class="avg"/>` : '',
    opts.avgY != null ? `<line x1="${L}" x2="${W - R}" y1="${sy(opts.avgY)}" y2="${sy(opts.avgY)}" class="avg"/>` : ''
  ].join('');
  const corners = [
    opts.cornerGood ? `<text x="${W - R - 8}" y="${T + 18}" text-anchor="end" class="corner good">${esc(opts.cornerGood)}</text>` : '',
    opts.cornerBad ? `<text x="${L + 8}" y="${H - B - 10}" class="corner bad">${esc(opts.cornerBad)}</text>` : ''
  ].join('');
  const dots = points.map((p) => {
    const attrs = Object.entries(p.attrs || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const inner = opts.big && p.img
      ? `<circle r="${rad}" class="crest-bg" style="fill:#fff;stroke:#c9ced6;stroke-width:1.5"/><image href="${esc(p.img)}" x="-13" y="-13" width="26" height="26" preserveAspectRatio="xMidYMid meet"/>`
      : `<circle r="${rad}"/>${opts.big ? `<text y="4" text-anchor="middle">${esc(p.label)}</text>` : ''}`;
    return `<g class="dot${opts.big ? ' big' : ''}" tabindex="0" role="img" aria-label="${esc(p.title)}"${attrs} transform="translate(${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)})"><title>${esc(p.title)}</title>${inner}</g>`;
  }).join('');
  return `<figure class="chart"${opts.id ? ` id="${opts.id}"` : ''}${opts.view ? ` data-view="${opts.view}"` : ''}${opts.hidden ? ' hidden' : ''}>
<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(opts.yLabel)} against ${esc(opts.xLabel)}">
${grid}${avg}${corners}
<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" class="axis">${esc(opts.xLabel)} →</text>
<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="axis">${esc(opts.yLabel)} ${opts.invertY ? '(fewer is better) ↑' : '↑'}</text>
${dots}
</svg></figure>`;
}

export function page({ title, cfg, info, active, sample, body, hero, head = '', scripts = '' }) {
  // Shared staff pages live at the site root; league pages live in their own folder (EuroLeague at the root, others in /il/ etc.).
  const root = cfg.root || '', isEl = (cfg.LEAGUE || 'el') === 'el';
  // The site's home page is Hapoel Tel Aviv (root index.html). Each league has its own home: EuroLeague = euroleague.html
  // at the root, the others <key>/index.html. Every league is listed, with its logo, in the "Leagues" menu.
  const leagueHome = cfg.HOME || (isEl ? 'euroleague.html' : 'index.html');
  const homeTitle = isEl ? 'EuroLeague' : (cfg.shortName || 'League');
  // "More" menu: the analysis pages that do not fit in the bar
  const moreItems = [[root + 'weekly.html', 'Hapoel weekly summary'], ['el', 'il'].includes(cfg.LEAGUE || 'el') ? ['gameday-next.html', 'Game-day pack (next game)'] : null, ['el', 'il'].includes(cfg.LEAGUE || 'el') ? ['injuries.html', 'Injury report'] : null, [root + 'keys.html', 'Keys to the game & season goals'], [root + 'hapoel-form.html', 'Hapoel form lines'], ['el', 'il'].includes(cfg.LEAGUE || 'el') ? ['coach-habits.html', 'Coach habits'] : null, ['el', 'il'].includes(cfg.LEAGUE || 'el') ? ['clips.html', 'Clip list for video'] : null, isEl ? ['shot-quality.html', 'Shot quality'] : null, isEl ? ['team-HTA-weakspots.html', 'Turnovers, possessions & rebounds'] : null, isEl ? ['team-HTA-profiles.html', 'Percentile profiles & FT under pressure'] : null, isEl ? ['league-trends.html', 'League trends'] : null, isEl ? ['travel.html', 'Travel and rest'] : null, isEl ? ['cards.html', 'Scouting cards'] : null, isEl ? ['quarter-split.html', 'Quarter split'] : null, cfg.hasClutch ? ['clutch.html', 'Clutch & after timeouts'] : null, cfg.LEAGUE === 'hub' ? null : ['forecast.html', 'Forecast & predictions'], cfg.LEAGUE === 'hub' ? null : ['referees.html', 'Referees'], [root + 'compare.html', 'Compare players'], [root + 'recruit.html', 'Recruiting'], cfg.LEAGUE === 'hub' ? null : ['charges.html', 'Charges drawn']].filter(Boolean);
  const more = `<details class="nav-more"><summary${moreItems.some(([h]) => h === active) ? ' aria-current="page"' : ''}>More <span aria-hidden="true">▾</span></summary><div class="nav-more-list">${moreItems.map(([h, l]) => `<a href="${h}"${active === h ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div></details>`;
  const nav = [[root + 'index.html', 'Hapoel', 'nav-hapoel'], cfg.LEAGUE === 'hub' ? null : [leagueHome, homeTitle], isEl ? ['live.html', 'Live', 'nav-live'] : null, ['players.html', 'Players'], ['teams.html', 'Teams'], ['lineups.html', 'Lineups'], ['matchup.html', 'Matchup'], [root + 'hapoel-schedule.html', 'Schedule'], 'MORE', [root + 'scouting.html', 'Scouting', 'nav-internal'], [root + 'internal.html', 'Hapoel Internal', 'nav-internal']]
    .filter(Boolean).map((x) => (x === 'MORE' ? more : `<a href="${x[0]}"${x[2] ? ` class="${x[2]}"` : ''}${active === x[0] ? ' aria-current="page"' : ''}>${x[1]}</a>`)).join('');
  const allLeagues = [['el', { shortName: 'EuroLeague', leagueName: 'EuroLeague', leagueLogo: cfg.elLogo || (isEl ? cfg.leagueLogo : '') }], ...Object.entries(cfg.leagues || {})];
  const lgLogo = (L) => (L.leagueLogo ? `<img src="${esc(L.leagueLogo)}" alt="" width="28" height="28" loading="lazy">` : `<i class="lg-dot">${esc((L.shortName || '?').slice(0, 3))}</i>`);
  const leagues = `<details class="league-menu"><summary>Leagues <span aria-hidden="true">▾</span></summary><div class="league-menu-list">${allLeagues.map(([k, L]) => `<a href="${root}${k === 'el' ? 'euroleague.html' : k + '/index.html'}"${(cfg.LEAGUE || 'el') === k && cfg.LEAGUE !== 'hub' ? ' aria-current="true"' : ''}>${lgLogo(L)}<span>${esc(L.leagueName || L.shortName || k)}</span></a>`).join('')}</div></details>`;
  const updated = info.lastDate ? `Data through ${info.lastRound ? `Round ${info.lastRound}, ` : ''}${fmtDate(info.lastDate)} · ${info.games} games` : 'No games yet';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(cfg.siteName)}</title>
<meta name="description" content="${esc(cfg.seasonLabel)} team and player statistics, calculated from the official box scores.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="style.css?v=${BUILD}">
<link rel="manifest" href="${root}manifest.webmanifest"><link rel="apple-touch-icon" href="${root}apple-touch-icon.png"><meta name="theme-color" content="#c8102e"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="HTA LAB">
${head}
</head>
<body>
<header class="top"><div class="wrap">
<a class="logo" href="${root}index.html"><span class="logo-mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2v20M5 5c3 3 3 11 0 14M19 5c-3 3-3 11 0 14"/></svg></span>${esc(cfg.siteName)}<span class="logo-sub">${esc(cfg.seasonLabel)}</span></a>
${leagues}
<nav aria-label="Main">${nav}</nav>
</div></header>
${sample ? '<div class="sample">Preview with invented sample data. The live site uses the official box scores.</div>' : ''}
${hero || ''}
<main class="wrap">
${body}
</main>
<footer class="foot"><div class="wrap"><strong class="foot-logo">${esc(cfg.siteName)}</strong> ${esc(updated)}. Calculated from ${esc(cfg.sourceText || 'the official box scores')}. Every game passes automatic accuracy checks before it is published. <a href="glossary.html">Glossary</a> · <a href="method.html">How we calculate</a> · <a href="${root}internal.html">Hapoel Internal</a></div></footer>
<script src="app.js?v=${BUILD}" defer></script>
${scripts}
</body>
</html>`;
}

export function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
