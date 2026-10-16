/* global d3 */
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('fr-FR');
const BATCH = 10;

const state = {
  userId: null,
  meta: null,
  batch: [],
  index: 0,
  answered: false,
  shownAt: 0,
  session: [],
  lastBatchIds: [],
  tier: null,
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body && JSON.stringify(options.body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ------------------------------------------------------------------ map

const svg = d3.select('#map');
const root = svg.append('g');
const layers = {
  deps: root.append('g'),
  rivers: root.append('g'),
  overlay: root.append('g'),
};
let projection;
let currentK = 1;

const zoom = d3.zoom().scaleExtent([1, 12]).on('zoom', (e) => {
  root.attr('transform', e.transform);
  currentK = e.transform.k;
  rescaleOverlay();
});
svg.call(zoom).on('dblclick.zoom', null);

async function drawMap() {
  const [deps, rivers] = await Promise.all([
    fetch('/data/departements.geojson').then((r) => r.json()),
    fetch('/data/rivers.geojson').then((r) => r.json()),
  ]);
  const { width, height } = svg.node().getBoundingClientRect();
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  // Lambert conformal conic, the projection used by official French maps.
  projection = d3.geoConicConformal().parallels([44, 49]).rotate([-3, 0])
    .fitExtent([[16, 16], [width - 16, height - 16]], deps);
  const path = d3.geoPath(projection);

  layers.deps.selectAll('path').data(deps.features).join('path')
    .attr('class', 'dep').attr('d', path)
    .attr('data-code', (d) => d.properties.code);

  const named = rivers.features.filter((f) => f.properties.name);
  const unnamed = rivers.features.filter((f) => !f.properties.name);
  for (const set of [unnamed, named]) {
    layers.rivers.append('g').selectAll('path').data(set).join('path')
      .attr('class', (d) => `river ${d.properties.major ? 'major' : 'minor'}`).attr('d', path);
  }
  // Wide invisible strokes so river names show on hover without pixel hunting.
  const tip = $('tooltip');
  layers.rivers.append('g').selectAll('path').data(named).join('path')
    .attr('class', 'river-hit').attr('d', path)
    .on('mousemove', (e, d) => {
      const [x, y] = d3.pointer(e, svg.node().parentNode);
      tip.textContent = d.properties.name;
      tip.style.left = `${x + 12}px`;
      tip.style.top = `${y + 12}px`;
      tip.hidden = false;
    })
    .on('mouseleave', () => { tip.hidden = true; });

  svg.on('click', onMapClick);
}

function rescaleOverlay() {
  layers.overlay.selectAll('circle.marker').attr('r', 6 / currentK).attr('stroke-width', 1.5 / currentK);
  layers.overlay.selectAll('text').attr('font-size', 13 / currentK).attr('dx', 9 / currentK).attr('dy', 4 / currentK);
}

function kmToPx(lat, lon, km) {
  // Radius in projected pixels: project a point `km` north of the city.
  const [, y0] = projection([lon, lat]);
  const [, y1] = projection([lon, lat + km / 111.32]);
  return Math.abs(y0 - y1);
}

function showAnswer(guess, city, hit) {
  const g = projection([guess.lon, guess.lat]);
  const a = projection([city.lon, city.lat]);
  layers.overlay.selectAll('*').remove();
  layers.deps.selectAll('.dep').classed('target', (d) => d.properties.code === city.departmentCode);
  layers.overlay.append('circle').attr('class', 'hit-circle')
    .attr('cx', a[0]).attr('cy', a[1]).attr('r', kmToPx(city.lat, city.lon, state.meta.hitRadiusKm));
  layers.overlay.append('line').attr('class', 'guess-line')
    .attr('x1', g[0]).attr('y1', g[1]).attr('x2', a[0]).attr('y2', a[1]);
  layers.overlay.append('circle').attr('class', 'marker marker-guess').attr('cx', g[0]).attr('cy', g[1]);
  layers.overlay.append('circle').attr('class', 'marker marker-answer').attr('cx', a[0]).attr('cy', a[1]);
  layers.overlay.append('text').attr('class', 'answer-label').attr('x', a[0]).attr('y', a[1]).text(city.name);
  rescaleOverlay();
  if (!hit) {
    // Make sure both points are visible if the user was zoomed in elsewhere.
    const t = d3.zoomTransform(svg.node());
    const { width, height } = svg.node().viewBox.baseVal;
    const visible = ([x, y]) => {
      const [sx, sy] = t.apply([x, y]);
      return sx > 0 && sx < width && sy > 0 && sy < height;
    };
    if (!visible(a)) svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
  }
}

function clearAnswer() {
  layers.overlay.selectAll('*').remove();
  layers.deps.selectAll('.dep').classed('target', false);
}

// ------------------------------------------------------------------ game flow

async function onMapClick(event) {
  if (state.answered || !state.batch.length || event.defaultPrevented) return;
  const [x, y] = d3.pointer(event, root.node());
  const [lon, lat] = projection.invert([x, y]);
  const prompt = state.batch[state.index];
  state.answered = true;
  svg.classed('answered', true);
  const result = await api(`/users/${state.userId}/attempts`, {
    method: 'POST',
    body: { cityId: prompt.id, lat, lon, timeMs: Date.now() - state.shownAt },
  });
  state.session.push(result);
  showAnswer({ lat, lon }, result.city, result.hit);
  renderResult(result);
  refreshTiers();
}

function renderResult(r) {
  const c = r.city;
  $('result').hidden = false;
  $('result-badge').textContent = r.hit ? 'Bravo' : 'Raté';
  $('result-badge').className = `badge ${r.hit ? 'hit' : 'miss'}`;
  $('result-distance').textContent = `${fmt.format(r.distanceKm)} km`;
  $('result-points').textContent = `+${r.points} pts`;
  $('city-name').textContent = c.name;
  $('city-status').textContent = `${c.status} · ${c.department} (${c.departmentCode})`;
  const img = $('city-image');
  img.hidden = !c.image;
  if (c.image) img.src = c.image;
  const facts = [
    ['Région', c.region],
    ['Population', c.population ? `${fmt.format(c.population)} hab.` : null],
    ['Superficie', c.surfaceKm2 ? `${fmt.format(c.surfaceKm2)} km²` : null],
    ['Altitude', c.elevationM != null ? `${fmt.format(c.elevationM)} m` : null],
    ['Habitants', c.demonyms?.length ? c.demonyms.join(', ') : null],
    ['Code postal', c.postalCodes?.length ? c.postalCodes.slice(0, 3).join(', ') + (c.postalCodes.length > 3 ? '…' : '') : null],
  ].filter(([, v]) => v);
  $('city-facts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    return [dt, dd];
  }));
  $('city-summary').textContent = c.summary ?? '';
  const link = $('city-link');
  link.hidden = !c.wikipedia;
  if (c.wikipedia) link.href = `https://fr.wikipedia.org/wiki/${encodeURIComponent(c.wikipedia.replace(/ /g, '_'))}`;
  $('prompt-hint').textContent = 'Entrée ou « Suivant » pour continuer';
  $('next-btn').focus({ preventScroll: true });
}

function showPrompt() {
  clearAnswer();
  state.answered = false;
  svg.classed('answered', false);
  $('result').hidden = true;
  $('session-end').hidden = true;
  const p = state.batch[state.index];
  const label = $('prompt');
  label.textContent = p.name;
  if (p.disambiguation) {
    const small = document.createElement('small');
    small.textContent = p.disambiguation;
    label.append(small);
  }
  $('progress-label').textContent = `${state.index + 1} / ${state.batch.length} · niveau ${p.tier}`;
  $('prompt-hint').textContent = 'Cliquez sur la carte pour placer la ville (molette pour zoomer)';
  state.shownAt = Date.now();
}

async function loadBatch() {
  const params = new URLSearchParams({ count: BATCH, exclude: state.lastBatchIds.join(',') });
  if (state.tier) params.set('tier', state.tier);
  const { cities, tiers } = await api(`/users/${state.userId}/next?${params}`);
  state.batch = cities;
  state.index = 0;
  state.session = [];
  state.lastBatchIds = cities.map((c) => c.id);
  renderTiers(tiers);
  if (cities.length) showPrompt();
}

function next() {
  if (!state.answered) return;
  if (state.index + 1 < state.batch.length) {
    state.index += 1;
    showPrompt();
    return;
  }
  const n = state.session.length;
  const hits = state.session.filter((r) => r.hit).length;
  const points = state.session.reduce((s, r) => s + r.points, 0);
  const median = [...state.session].sort((a, b) => a.distanceKm - b.distanceKm)[Math.floor(n / 2)]?.distanceKm ?? 0;
  $('session-summary').textContent =
    `${hits} / ${n} villes à moins de ${state.meta.hitRadiusKm} km · ${fmt.format(points)} points · distance médiane ${fmt.format(median)} km`;
  $('result').hidden = true;
  $('session-end').hidden = false;
  state.batch = [];
  $('continue-btn').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ progress & stats

function renderTiers(tiers) {
  const select = $('mode-select');
  if (select.options.length === 1) {
    for (const t of tiers) select.add(new Option(`Niveau ${t.tier} uniquement`, t.tier));
  }
  $('tiers').replaceChildren(...tiers.map((t) => {
    const div = document.createElement('div');
    div.className = `tier${t.unlocked ? '' : ' locked'}`;
    div.innerHTML = `
      <div class="row"><strong>${t.unlocked ? '' : '🔒 '}Niveau ${t.tier}</strong>
        <span>${t.mastered} / ${t.total} maîtrisées</span></div>
      <div class="hint"></div>
      <div class="bar bar-stack"><div class="seen" style="width:${(100 * t.seen) / t.total}%"></div>
        <div style="width:${(100 * t.mastered) / t.total}%"></div></div>`;
    div.querySelector('.hint').textContent = t.label;
    return div;
  }));
}

async function refreshTiers() {
  const stats = await api(`/users/${state.userId}/stats`);
  renderTiers(stats.tiers);
}

async function openStats() {
  if (!state.userId) return;
  const s = await api(`/users/${state.userId}/stats`);
  const body = $('stats-body');
  const rate = s.totals.attempts ? Math.round((100 * s.totals.correct) / s.totals.attempts) : 0;
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const table = (cols, rows) => `<table><thead><tr>${cols.map(([h, cls]) => `<th class="${cls ?? ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${cols[i][1] ?? ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  body.innerHTML = `
    <p>${fmt.format(s.totals.attempts)} essais · ${rate} % à moins de ${state.meta.hitRadiusKm} km</p>
    <h3>Villes à retravailler</h3>
    ${s.weakest.length ? table([['Ville'], ['Département'], ['Niveau', 'num'], ['Essais', 'num'], ['Dernier écart', 'num'], ['Maîtrise', 'num']],
      s.weakest.map((c) => [c.name, c.department, c.tier, c.attempts, `${fmt.format(c.lastDistanceKm)} km`, `${Math.round(c.mastery * 100)} %`]))
      : '<p class="hint">Rien pour l\'instant.</p>'}
    <h3>Régions (de la plus faible à la plus forte)</h3>
    ${s.regions.length ? table([['Région'], ['Villes vues', 'num'], ['Réussite', 'num'], ['Écart moyen', 'num']],
      s.regions.map((r) => [r.region, r.cities, `${Math.round(r.hitRate * 100)} %`, `${fmt.format(r.avgLastDistanceKm)} km`]))
      : '<p class="hint">Jouez quelques villes pour voir vos forces et faiblesses.</p>'}
    <h3>Points forts</h3>
    ${s.strongest.length ? table([['Ville'], ['Meilleur écart', 'num'], ['Maîtrise', 'num']],
      s.strongest.map((c) => [c.name, `${fmt.format(c.bestDistanceKm)} km`, `${Math.round(c.mastery * 100)} %`])) : ''}`;
  $('stats').showModal();
}

// ------------------------------------------------------------------ players

async function loadPlayers(selectId) {
  const users = await api('/users');
  const select = $('player-select');
  select.replaceChildren(
    new Option('— Joueur —', ''),
    ...users.map((u) => new Option(u.name, u.id)),
    new Option('+ Nouveau joueur', '__new'),
  );
  select.value = users.some((u) => u.id === selectId) ? selectId : '';
}

async function selectPlayer(id) {
  if (id === '__new') {
    $('player-select').value = state.userId ?? '';
    $('new-player-name').value = '';
    $('new-player').showModal();
    return;
  }
  state.userId = id || null;
  store.set('player', id);
  state.lastBatchIds = [];
  if (state.userId) await loadBatch();
}

$('new-player').addEventListener('close', async () => {
  if ($('new-player').returnValue !== 'ok') return;
  const name = $('new-player-name').value.trim();
  if (!name) return;
  const user = await api('/users', { method: 'POST', body: { name } });
  await loadPlayers(user.id);
  await selectPlayer(user.id);
});

$('player-select').addEventListener('change', (e) => selectPlayer(e.target.value));
$('mode-select').addEventListener('change', (e) => {
  state.tier = Number(e.target.value) || null;
  if (state.userId) loadBatch();
});
$('next-btn').addEventListener('click', next);
$('continue-btn').addEventListener('click', loadBatch);
$('stats-btn').addEventListener('click', openStats);
$('stats-close').addEventListener('click', () => $('stats').close());
$('zoom-in').addEventListener('click', () => svg.transition().call(zoom.scaleBy, 1.6));
$('zoom-out').addEventListener('click', () => svg.transition().call(zoom.scaleBy, 1 / 1.6));
$('zoom-reset').addEventListener('click', () => svg.transition().call(zoom.transform, d3.zoomIdentity));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || document.querySelector('dialog[open]')) return;
  if (!$('session-end').hidden) { e.preventDefault(); loadBatch(); } else if (state.answered) { e.preventDefault(); next(); }
});

(async function init() {
  state.meta = await api('/meta');
  await drawMap();
  const saved = store.get('player');
  await loadPlayers(saved);
  if ($('player-select').value) await selectPlayer(saved);
})();
