// Zero-dependency HTTP server: serves the game (public/), the map layers (data/), and the API.
//   node server/index.mjs        (PORT env var, default 3999)
//
// API
//   GET  /api/users                                   list players
//   POST /api/users            {name}                 create a player
//   GET  /api/users/:id/next?count=10&tier=&exclude=  next cities to place (no coordinates)
//   POST /api/users/:id/attempts {cityId, lat, lon, timeMs}  score a guess, returns the answer + facts
//   GET  /api/users/:id/stats                         strengths / weaknesses

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { nextCities, recordAttempt, userStats, TIER_LABELS, HIT_RADIUS_KM } from './scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3999);

const cities = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'cities.json'), 'utf8'));
const cityById = new Map(cities.map((c) => [c.id, c]));
const store = createStore(path.join(ROOT, 'data', 'users'));
await store.init();

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/data/departements.geojson': ['data/departements.geojson', 'application/geo+json'],
  '/data/rivers.geojson': ['data/rivers.geojson', 'application/geo+json'],
};

// What the player sees before answering: no coordinates, no department unless needed to disambiguate.
const prompt = (c) => ({ id: c.id, name: c.name, disambiguation: c.disambiguation ?? null, tier: c.tier });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e5) throw new HttpError(413, 'Body too large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function loadUser(id) {
  const user = await store.getUser(id);
  if (!user) throw new HttpError(404, 'Unknown user');
  return user;
}

const routes = [
  ['GET', /^\/api\/meta$/, async () => ({ tiers: TIER_LABELS, hitRadiusKm: HIT_RADIUS_KM, cityCount: cities.length })],

  ['GET', /^\/api\/users$/, async () => store.listUsers()],

  ['POST', /^\/api\/users$/, async (req) => {
    const { name } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new HttpError(400, 'name is required (max 40 chars)');
    const { id, createdAt } = await store.createUser(name.trim());
    return { id, name: name.trim(), createdAt };
  }],

  ['GET', /^\/api\/users\/([a-z0-9-]+)\/next$/, async (req, [id], url) => {
    const user = await loadUser(id);
    const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 10, 1), 50);
    const tier = Number(url.searchParams.get('tier')) || null;
    const exclude = (url.searchParams.get('exclude') ?? '').split(',').filter(Boolean);
    const { cities: picked, tiers } = nextCities(user, cities, cityById, { count, tier, exclude });
    return { cities: picked.map(prompt), tiers };
  }],

  ['POST', /^\/api\/users\/([a-z0-9-]+)\/attempts$/, async (req, [id]) => {
    const { cityId, lat, lon, timeMs } = await readJson(req);
    const city = cityById.get(cityId);
    if (!city) throw new HttpError(400, 'Unknown cityId');
    if (![lat, lon].every(Number.isFinite)) throw new HttpError(400, 'lat and lon must be numbers');
    const result = await store.updateUser(id, (user) => {
      const now = Date.now();
      const r = recordAttempt(user, city, { lat, lon }, now);
      return {
        result: r,
        logEntry: { at: new Date(now).toISOString(), cityId, tier: city.tier, lat, lon, timeMs: timeMs ?? null,
          distanceKm: r.distanceKm, hit: r.hit, points: r.points },
      };
    });
    if (!result) throw new HttpError(404, 'Unknown user');
    return { ...result, city };
  }],

  ['GET', /^\/api\/users\/([a-z0-9-]+)\/stats$/, async (req, [id]) => userStats(await loadUser(id), cities, cityById)],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) {
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(await fs.readFile(path.join(ROOT, file[0])));
      return;
    }
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || req.method !== method) continue;
      const body = await handler(req, m.slice(1), url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : e.message }));
  }
});

server.listen(PORT, () => console.log(`French cities game on http://localhost:${PORT} (${cities.length} cities)`));
