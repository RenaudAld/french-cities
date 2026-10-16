// Builds every data file the game needs, from public open-data sources.
//   node scripts/build-data.mjs            (uses cached downloads in data/raw/)
//   node scripts/build-data.mjs --refresh  (re-downloads everything)
//
// Outputs (in data/):
//   cities.json            game pool: metropolitan + Corsica cities with tiers & facts
//   cities.csv             same, flat, for spreadsheets
//   departements.geojson   department borders
//   rivers.geojson         main rivers (OpenStreetMap), clipped to France

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const REFRESH = process.argv.includes('--refresh');
const UA = 'french-cities-game/0.1 (personal geography game)';

const SOURCES = {
  communes: 'https://geo.api.gouv.fr/communes?fields=nom,code,population,centre,surface,codeDepartement,codeRegion,codesPostaux&format=json',
  departementsCog: 'https://www.insee.fr/fr/statistiques/fichier/8377162/v_departement_2025.csv',
  regionsCog: 'https://www.insee.fr/fr/statistiques/fichier/8377162/v_region_2025.csv',
  arrondissementsCog: 'https://www.insee.fr/fr/statistiques/fichier/8377162/v_arrondissement_2025.csv',
  departementsGeo: 'https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/departements-version-simplifiee.geojson',
  overpass: 'https://overpass-api.de/api/interpreter',
};

const MIN_POPULATION = 10000; // below this, only chef-lieux (prefectures / sous-prefectures) are kept

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init = {}, label = url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      console.log(`  ${label}: HTTP ${res.status}, retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} -> HTTP ${res.status}`);
  }
}

// Caches an expensive JSON computation in data/raw/ (skipped with --refresh).
async function cachedJson(name, compute) {
  const file = path.join(RAW, name);
  if (!REFRESH) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  }
  const value = await compute();
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

async function cached(name, url) {
  const file = path.join(RAW, name);
  if (!REFRESH) {
    try { return await fs.readFile(file, 'utf8'); } catch {}
  }
  console.log(`  downloading ${name} ...`);
  const res = await fetchRetry(url);
  const text = await res.text();
  await fs.writeFile(file, text);
  return text;
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/).map((line) =>
    line.split(',').map((v) => v.replace(/^"|"$/g, '')));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const isMetroDep = (code) => /^(0[1-9]|[1-8]\d|9[0-5]|2A|2B)$/.test(code);

// ---------------------------------------------------------------- cities

function tierOf(c) {
  if (c.population >= 130000 || c.isRegionCapital) return 1;
  if (c.isPrefecture || c.population >= 75000) return 2;
  if (c.population >= 40000 || (c.isSubPrefecture && c.population >= 20000)) return 3;
  if (c.population >= 20000 || c.isSubPrefecture) return 4;
  return 5;
}

async function sparql(query) {
  const res = await fetchRetry('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query }),
  }, 'wikidata');
  return (await res.json()).results.bindings;
}

async function wikidataFacts(codes) {
  const out = {};
  const chunkSize = 400;
  for (let i = 0; i < codes.length; i += chunkSize) {
    const values = codes.slice(i, i + chunkSize).map((c) => `"${c}"`).join(' ');
    const rows = await sparql(`
      SELECT ?insee ?item ?article ?demonym ?elev ?area WHERE {
        VALUES ?insee { ${values} }
        ?item wdt:P374 ?insee .
        ?article schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> .
        FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
        OPTIONAL { ?item wdt:P1549 ?demonym . FILTER(LANG(?demonym) = "fr") }
        OPTIONAL { ?item wdt:P2044 ?elev }
        OPTIONAL { ?item wdt:P2046 ?area }
      }`);
    for (const r of rows) {
      const code = r.insee.value;
      const entry = (out[code] ??= {
        wikidata: r.item.value.split('/').pop(),
        wikipedia: decodeURIComponent(r.article.value.split('/wiki/').pop()).replace(/_/g, ' '),
        demonyms: [],
      });
      if (r.demonym && !entry.demonyms.includes(r.demonym.value)) entry.demonyms.push(r.demonym.value);
      if (r.elev && entry.elevation == null) entry.elevation = Math.round(Number(r.elev.value));
      if (r.area && entry.areaKm2 == null) entry.areaKm2 = Number(r.area.value);
    }
    console.log(`  wikidata: ${Math.min(i + chunkSize, codes.length)}/${codes.length}`);
  }
  return out;
}

async function wikipediaIntros(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', redirects: '1',
      prop: 'extracts|pageimages', exintro: '1', explaintext: '1', exlimit: '20',
      piprop: 'thumbnail', pithumbsize: '400', pilimit: '20',
      titles: batch.join('|'),
    });
    const res = await fetchRetry(`https://fr.wikipedia.org/w/api.php?${params}`, {}, 'wikipedia');
    await sleep(300);
    const json = await res.json();
    const alias = {};
    for (const n of json.query.normalized ?? []) alias[n.to] = n.from;
    for (const r of json.query.redirects ?? []) alias[r.to] = alias[r.from] ?? r.from;
    for (const p of json.query.pages) {
      if (p.missing) continue;
      const original = alias[p.title] ?? p.title;
      out[original] = { extract: (p.extract ?? '').trim(), thumbnail: p.thumbnail?.source ?? null };
    }
    if ((i / 20) % 10 === 0) console.log(`  wikipedia: ${Math.min(i + 20, titles.length)}/${titles.length}`);
  }
  return out;
}

async function buildCities() {
  console.log('Cities');
  const communes = JSON.parse(await cached('communes.json', SOURCES.communes));
  const departements = parseCsv(await cached('v_departement_2025.csv', SOURCES.departementsCog));
  const regions = parseCsv(await cached('v_region_2025.csv', SOURCES.regionsCog));
  const arrondissements = parseCsv(await cached('v_arrondissement_2025.csv', SOURCES.arrondissementsCog));

  const depName = Object.fromEntries(departements.map((d) => [d.DEP, d.LIBELLE]));
  const regName = Object.fromEntries(regions.map((r) => [r.REG, r.LIBELLE]));
  const regionCapitals = new Set(regions.map((r) => r.CHEFLIEU));
  const prefectures = new Set(departements.map((d) => d.CHEFLIEU));
  const subPrefectures = new Set(arrondissements.map((a) => a.CHEFLIEU).filter((c) => !prefectures.has(c)));

  let cities = communes
    .filter((c) => isMetroDep(c.codeDepartement) && c.centre)
    .filter((c) => (c.population ?? 0) >= MIN_POPULATION || prefectures.has(c.code) || subPrefectures.has(c.code))
    .map((c) => {
      const city = {
        id: c.code,
        name: c.nom,
        lat: c.centre.coordinates[1],
        lon: c.centre.coordinates[0],
        population: c.population ?? 0,
        departmentCode: c.codeDepartement,
        department: depName[c.codeDepartement],
        regionCode: c.codeRegion,
        region: regName[c.codeRegion],
        postalCodes: c.codesPostaux ?? [],
        surfaceKm2: c.surface ? Math.round(c.surface) / 100 : null, // geo.api gives hectares
        isRegionCapital: regionCapitals.has(c.code),
        isPrefecture: prefectures.has(c.code),
        isSubPrefecture: subPrefectures.has(c.code),
      };
      city.status = city.isRegionCapital ? 'Préfecture de région'
        : city.isPrefecture ? 'Préfecture'
        : city.isSubPrefecture ? 'Sous-préfecture' : 'Commune';
      city.tier = tierOf(city);
      return city;
    })
    .sort((a, b) => b.population - a.population);

  // Disambiguate homonyms with the department name when prompting.
  const byName = {};
  for (const c of cities) (byName[c.name] ??= []).push(c);
  for (const group of Object.values(byName)) {
    if (group.length > 1) for (const c of group) c.disambiguation = c.department;
  }

  const wd = await cachedJson('wikidata.json', () => wikidataFacts(cities.map((c) => c.id)));
  for (const c of cities) {
    const f = wd[c.id];
    if (!f) continue;
    c.wikidata = f.wikidata;
    c.wikipedia = f.wikipedia;
    c.demonyms = f.demonyms;
    c.elevationM = f.elevation ?? null;
  }

  const intros = await cachedJson('wikipedia.json',
    () => wikipediaIntros(cities.filter((c) => c.wikipedia).map((c) => c.wikipedia)));
  for (const c of cities) {
    const intro = c.wikipedia && intros[c.wikipedia];
    if (!intro) continue;
    c.summary = intro.extract;
    c.image = intro.thumbnail;
  }

  return cities;
}

// ---------------------------------------------------------------- map layers

async function buildDepartements() {
  console.log('Departments');
  const geo = JSON.parse(await cached('departements.geojson', SOURCES.departementsGeo));
  geo.features = geo.features.filter((f) => isMetroDep(f.properties.code));
  return roundCoords(geo, 4);
}

// Main rivers, by display name. `major` rivers are drawn thicker.
const RIVERS = {
  major: ['Seine', 'Loire', 'Garonne', 'Rhône', 'Rhin', 'Meuse', 'Moselle', 'Saône', 'Dordogne', 'Allier',
    'Marne', 'Oise', 'Isère', 'Durance', 'Lot', 'Tarn', 'Vienne', 'Charente'],
  minor: ['Yonne', 'Aisne', 'Aube', 'Cher', 'Indre', 'Creuse', 'Loir', 'Sarthe', 'Mayenne', 'Maine', 'Vilaine', 'Orne',
    'Somme', 'Escaut', 'Doubs', 'Ain', 'Drôme', 'Ardèche', 'Gard', 'Hérault', 'Aude', 'Ariège', 'Aveyron',
    'Adour', 'Gave de Pau', 'Vézère', 'Var', 'Arve', 'Eure', 'Ill', 'Sarre', 'Golo', 'Tavignano', 'Gers', 'Baïse'],
};

// Douglas-Peucker on lon/lat degrees; good enough at country scale.
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [x1, y1] = points[first];
    const [x2, y2] = points[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [x, y] = points[i];
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const d = (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2;
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tolerance * tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Rivers are clipped to France itself (department polygons, plus a small margin so lines
// reach the border and the sea) rather than a bounding box, so foreign rivers stay off the map.
const MARGIN_DEG = 0.05;

function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makeFranceTest(departements) {
  const polys = departements.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
  const indexed = polys.map((rings) => {
    const xs = rings[0].map((p) => p[0]);
    const ys = rings[0].map((p) => p[1]);
    return { rings, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  const inside = ([x, y]) => indexed.some(({ rings, bbox }) =>
    x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]
    && ringContains(rings[0], [x, y]) && !rings.slice(1).some((h) => ringContains(h, [x, y])));
  const offsets = [[0, 0], [MARGIN_DEG, 0], [-MARGIN_DEG, 0], [0, MARGIN_DEG], [0, -MARGIN_DEG]];
  return ([x, y]) => offsets.some(([dx, dy]) => inside([x + dx, y + dy]));
}

function clipLine(coords, isInFrance) {
  const parts = [];
  let current = [];
  for (const p of coords) {
    if (isInFrance(p)) current.push(p);
    else if (current.length) { parts.push(current); current = []; }
  }
  if (current.length) parts.push(current);
  return parts.filter((p) => p.length > 1);
}

const stripArticle = (name) => name.replace(/^(la |le |les |l['’])/i, '');

async function buildRivers(departements) {
  console.log('Rivers');
  const isInFrance = makeFranceTest(departements);
  const names = [...new Set([...RIVERS.major, ...RIVERS.minor])];
  const pattern = `^(La |Le |L'|L’)?(${names.join('|')})$`;
  const query = `[out:json][timeout:300];
    ( rel["type"="waterway"]["waterway"="river"]["name"~"${pattern}"](41.2,-5.6,51.2,9.8);
      rel["type"="waterway"]["waterway"="river"]["name:fr"~"${pattern}"](41.2,-5.6,51.2,9.8); );
    out geom;`;
  const osm = JSON.parse(await cached('rivers_osm.json', `${SOURCES.overpass}?${new URLSearchParams({ data: query })}`));

  // Several relations can share a name (homonymous streams): keep the longest one per name.
  const best = {};
  for (const rel of osm.elements) {
    const name = stripArticle(rel.tags['name:fr'] ?? rel.tags.name);
    if (!names.includes(name)) continue;
    const lines = rel.members
      .filter((m) => m.type === 'way' && m.geometry && !['tributary', 'spring'].includes(m.role))
      .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
    const size = lines.reduce((n, l) => n + l.length, 0);
    if (!best[name] || size > best[name].size) best[name] = { lines, size };
  }

  const features = [];
  for (const [name, { lines }] of Object.entries(best)) {
    const clipped = lines.flatMap((l) => clipLine(simplify(l, 0.003), isInFrance));
    if (!clipped.length) continue;
    features.push({
      type: 'Feature',
      properties: { name, major: RIVERS.major.includes(name) },
      geometry: { type: 'MultiLineString', coordinates: clipped },
    });
  }
  const missing = names.filter((n) => !best[n]);
  if (missing.length) console.log(`  rivers not found in OSM: ${missing.join(', ')}`);
  return roundCoords({ type: 'FeatureCollection', features }, 3);
}

function roundCoords(geo, digits) {
  const k = 10 ** digits;
  const walk = (a) => (typeof a[0] === 'number' ? a.map((v) => Math.round(v * k) / k) : a.map(walk));
  for (const f of geo.features) f.geometry.coordinates = walk(f.geometry.coordinates);
  return geo;
}

// ---------------------------------------------------------------- output

function toCsv(cities) {
  const cols = ['id', 'name', 'lat', 'lon', 'population', 'departmentCode', 'department', 'region', 'status', 'tier',
    'surfaceKm2', 'elevationM', 'demonyms', 'wikidata', 'wikipedia', 'summary'];
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join(' / ') : v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...cities.map((c) => cols.map((k) => esc(c[k])).join(','))].join('\n');
}

await fs.mkdir(RAW, { recursive: true });
const departements = await buildDepartements();
const rivers = await buildRivers(departements);
const cities = await buildCities();

await fs.writeFile(path.join(DATA, 'departements.geojson'), JSON.stringify(departements));
await fs.writeFile(path.join(DATA, 'rivers.geojson'), JSON.stringify(rivers));
await fs.writeFile(path.join(DATA, 'cities.json'), JSON.stringify(cities, null, 1));
await fs.writeFile(path.join(DATA, 'cities.csv'), toCsv(cities));

const perTier = cities.reduce((acc, c) => ({ ...acc, [c.tier]: (acc[c.tier] ?? 0) + 1 }), {});
console.log(`\nDone: ${cities.length} cities`, perTier,
  `| ${cities.filter((c) => c.summary).length} with Wikipedia intro | ${departements.features.length} departments | ${rivers.features.length} river features`);
