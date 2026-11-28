// Scouting-card generator: draws each player's card on a <canvas> (1672×941, same layout as the hand-made Milano cards).
(() => {
  const D = window.SC_DATA; if (!D) return;
  const W = 1672, H = 941, F = "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif";
  const RED = '#C8102E', DARK = '#8E0C20', INK = '#111111', BG = '#F4F2EF';
  const $ = (id) => document.getElementById(id);
  const sel = $('sc-team'), grid = $('sc-grid'), msg = $('sc-msg');
  const photos = new Map(); // player id -> Image (this device only)
  let logo = null; const logos = new Map(); // team code -> Image
  const crest = new Image(); crest.src = 'hapoel-crest.png';
  const load = (src, cors) => new Promise((res) => { const i = new Image(); if (cors) i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const fileImg = (file) => new Promise((res) => { const r = new FileReader(); r.onload = () => load(r.result).then(res); r.readAsDataURL(file); });

  function poly(c, pts) { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); }
  function fitText(c, t, font, size, maxW) { let s = size; c.font = font.replace('{s}', s); while (s > 20 && c.measureText(t).width > maxW) { s -= 2; c.font = font.replace('{s}', s); } return s; }
  function contain(c, img, x, y, w, h, bottom) {
    const r = Math.min(w / img.width, h / img.height), iw = img.width * r, ih = img.height * r;
    c.drawImage(img, x + (w - iw) / 2, bottom ? y + h - ih : y + (h - ih) / 2, iw, ih);
  }
  function draw(cv, p, team) {
    const c = cv.getContext('2d'); c.clearRect(0, 0, W, H);
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    // striped wedge on the left
    c.save(); poly(c, [[0, 0], [760, 0], [502, H], [0, H]]); c.clip();
    c.translate(0, 0); c.rotate((118 - 90) * Math.PI / 180);
    const band = [[RED, 70], ['#141414', 34], [BG, 22], ['#E63946', 24]];
    for (let x = -800; x < 2200;) for (const [col, w] of band) { c.fillStyle = col; c.fillRect(x, -1200, w, 3200); x += w; }
    c.restore();
    c.save(); c.globalAlpha = 0.92; c.fillStyle = BG; poly(c, [[486, 0], [760, 0], [502, H], [228, H]]); c.fill(); c.restore();
    // photo or placeholder
    const ph = photos.get(p.id);
    if (ph) contain(c, ph, 20, 70, 660, 880, true);
    else {
      c.save(); c.fillStyle = 'rgba(255,255,255,0.55)'; c.strokeStyle = 'rgba(17,17,17,0.35)'; c.lineWidth = 4; c.setLineDash([14, 10]);
      c.beginPath(); c.moveTo(80, H); c.lineTo(80, 441); c.arc(340, 441, 260, Math.PI, 0); c.lineTo(600, H); c.fill(); c.stroke(); c.restore();
      c.textAlign = 'center'; c.fillStyle = 'rgba(200,16,46,0.18)'; c.font = `italic 900 300px ${F}`; c.fillText(p.num || '', 340, 640);
      c.fillStyle = 'rgba(17,17,17,0.55)'; c.font = `700 34px ${F}`; c.fillText('PLAYER PHOTO', 340, 720);
    }
    // top-right banner
    c.fillStyle = DARK; poly(c, [[W - 440 + 70, 0], [W, 0], [W, 220], [W - 440, 220]]); c.fill();
    c.textAlign = 'right'; c.fillStyle = '#fff'; fitText(c, 'SCOUTING REPORT', `700 {s}px ${F}`, 46, 330); c.fillText('SCOUTING REPORT', W - 44, 82);
    fitText(c, D.season, `800 {s}px ${F}`, 96, 340); c.fillText(D.season, W - 44, 168); c.fillStyle = '#E63946'; c.fillRect(W - 44 - 220, 182, 220, 6);
    // logos: opponent · VS · Hapoel
    const lg = logos.get(team.code);
    if (lg) contain(c, lg, 770, 66, 180, 180);
    else { c.save(); c.strokeStyle = 'rgba(17,17,17,0.3)'; c.lineWidth = 3; c.setLineDash([10, 8]); c.strokeRect(770, 66, 180, 180); c.restore(); c.textAlign = 'center'; c.fillStyle = 'rgba(17,17,17,0.5)'; c.font = `700 28px ${F}`; c.fillText('TEAM LOGO', 860, 165); }
    c.fillStyle = INK; c.fillRect(999, 76, 3, 60); c.fillRect(999, 176, 3, 60); c.textAlign = 'center'; c.font = `800 52px ${F}`; c.fillText('VS', 1000, 175);
    if (crest.complete && crest.naturalWidth) contain(c, crest, 1048, 66, 180, 180);
    // name block
    c.fillStyle = RED; c.fillRect(740, 298, 900, 5); c.fillRect(740, 552, 900, 5);
    c.textAlign = 'left'; c.fillStyle = INK;
    const numT = '#' + (p.num || ''); c.font = `italic 900 250px ${F}`; const nw = c.measureText(numT).width; c.fillText(numT, 740, 520);
    const nx = 740 + nw + 30, room = 1640 - nx;
    fitText(c, p.first.toUpperCase(), `italic 800 {s}px ${F}`, 96, room); c.fillText(p.first.toUpperCase(), nx, 420);
    const L = p.last.toUpperCase(); fitText(c, L, `italic 800 {s}px ${F}`, L.length > 11 ? 80 : L.length > 8 ? 96 : 112, room); c.fillText(L, nx, 525);
    // position / age / height
    const cols3 = [['POSITION', p.pos], ['AGE', p.age], ['HEIGHT', p.height === '–' ? '–' : p.height + ' CM']];
    cols3.forEach(([k, v], i) => { const x = 740 + 300 * i; c.textAlign = 'center'; c.fillStyle = INK; c.font = `700 36px ${F}`; c.fillText(k, x + 150, 610); c.font = `700 54px ${F}`; c.fillText(v, x + 150, 662); if (i < 2) c.fillRect(x + 298, 572, 3, 100); });
    // stat bar
    c.fillStyle = '#0E0E0E'; c.fillRect(740, 690, 900, 150);
    const cw = 150, stats = [['PTS', p.pts], ['AST', p.ast], ['REB', p.reb], ['2PT', p.p2, p.p2sub], ['3PT', p.p3, p.p3sub], ['MIN', p.min]];
    stats.forEach(([k, v, sub], i) => {
      const x = 740 + cw * i + cw / 2; c.textAlign = 'center';
      if (i < 5) { c.fillStyle = '#3A3A3A'; c.fillRect(740 + cw * (i + 1) - 1, 690, 2, 150); }
      c.fillStyle = '#fff';
      if (sub != null) { fitText(c, v, `700 {s}px ${F}`, 52, cw - 12); c.fillText(v, x, 752); c.fillStyle = '#DDDDDD'; c.font = `600 28px ${F}`; c.fillText(sub, x, 786); }
      else { c.font = `700 76px ${F}`; c.fillText(v, x, 770); }
      c.fillStyle = '#FF2A3D'; c.font = `700 40px ${F}`; c.fillText(k, x, 826);
    });
    // footer band
    c.fillStyle = RED; poly(c, [[800 + 31, 840], [1580, 840], [1580 - 31, 904], [800, 904]]); c.fill();
    c.fillStyle = '#fff'; c.textAlign = 'center'; const ft = `STATS: EUROLEAGUE ${D.season} · ${p.gp} GAMES`; fitText(c, ft, `700 {s}px ${F}`, 40, 660); c.fillText(ft, 1190, 886);
  }
  const fname = (p, t) => `${t.code}-${(p.num || 'x')}-${(p.last || 'player').replace(/[^A-Za-z0-9]+/g, '')}.png`;
  function save(cv, name) {
    try { cv.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }, 'image/png'); }
    catch { msg.textContent = 'This browser blocked the download because of the team logo. Choose the logo with “Opponent logo” instead and try again.'; }
  }
  let current = null;
  function render() {
    const t = D.teams.find((x) => x.code === sel.value) || D.teams[0]; current = t;
    grid.innerHTML = '';
    for (const p of t.players) {
      const box = document.createElement('figure'); box.className = 'sc-card';
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.title = 'Drop a photo here, or click to choose one';
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
      const cap = document.createElement('figcaption');
      cap.innerHTML = `<span>#${p.num || '–'} ${p.first} ${p.last} <span class="muted small">· ${p.gp} games, ${p.min} min</span></span>`;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Download PNG'; b.onclick = () => save(cv, fname(p, t)); cap.appendChild(b);
      const setPhoto = async (f) => { if (!f || !/^image\//.test(f.type)) return; const i = await fileImg(f); if (i) { photos.set(p.id, i); draw(cv, p, t); } };
      cv.onclick = () => inp.click(); inp.onchange = () => setPhoto(inp.files[0]);
      cv.ondragover = (e) => { e.preventDefault(); box.classList.add('sc-over'); }; cv.ondragleave = () => box.classList.remove('sc-over');
      cv.ondrop = (e) => { e.preventDefault(); box.classList.remove('sc-over'); setPhoto(e.dataTransfer.files[0]); };
      box.append(cv, inp, cap); grid.appendChild(box); draw(cv, p, t); cv._p = p;
    }
    if (!logos.has(t.code) && t.crest) load(t.crest, true).then((i) => { if (i && current === t) { logos.set(t.code, i); redraw(); } });
  }
  const redraw = () => grid.querySelectorAll('canvas').forEach((cv) => draw(cv, cv._p, current));
  sel.innerHTML = D.teams.map((t, i) => `<option value="${t.code}">${t.name}${i === 0 ? ' (next opponent)' : ''}</option>`).join('');
  sel.onchange = render;
  $('sc-logo').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const i = await fileImg(f); if (i) { logos.set(current.code, i); redraw(); } };
  $('sc-all').onclick = () => { const cs = [...grid.querySelectorAll('canvas')]; cs.forEach((cv, k) => setTimeout(() => save(cv, fname(cv._p, current)), k * 350)); msg.textContent = `Downloading ${cs.length} cards…`; };
  crest.onload = () => current && redraw();
  (document.fonts ? Promise.all(['italic 900 100px "Barlow Condensed"', 'italic 800 100px "Barlow Condensed"', '700 100px "Barlow Condensed"', '600 100px "Barlow Condensed"'].map((f) => document.fonts.load(f))).catch(() => {}) : Promise.resolve()).then(render);
})();
