// Learning model and city picker.
//
// Each attempt is scored by distance. Per city we keep:
//   mastery  exponentially weighted average of attempt quality (0..1), recent attempts count more
//   box      Leitner box (0..6): a hit moves the city up a box, a miss sends it back down
//            (a near-perfect first guess goes straight to "mastered")
//   due      when the city should come back; higher boxes come back later (spaced repetition)
//
// A tier unlocks once enough of the previous tier is mastered. Each batch mixes
// due reviews (weakest first, with a boost for weak regions) and a few new cities
// from the easiest tier that still has unseen cities, biggest cities first.

export const HIT_RADIUS_KM = 25;
const QUALITY_SCALE_KM = 40; // quality = exp(-d / scale): 10 km -> 0.78, 25 km -> 0.54, 100 km -> 0.08
const MASTERY_ALPHA = 0.4;
const BOX_INTERVALS_MIN = [1, 5, 30, 4 * 60, 24 * 60, 3 * 24 * 60, 10 * 24 * 60];
const MASTERED_BOX = 3;
const MASTERED_LEVEL = 0.6;
const UNLOCK_RATIO = 0.7; // share of a tier to master before the next one opens
const KNOWN_KM = 10; // a first-ever guess this close means the player already knows the city

export const TIER_LABELS = {
  1: 'Grandes villes & capitales régionales',
  2: 'Préfectures & villes de 75 000+ hab.',
  3: 'Villes moyennes',
  4: 'Sous-préfectures & villes de 20 000+ hab.',
  5: 'Petites villes',
};

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function scoreGuess(city, lat, lon) {
  const distanceKm = haversineKm(city.lat, city.lon, lat, lon);
  const quality = Math.exp(-distanceKm / QUALITY_SCALE_KM);
  return {
    distanceKm: Math.round(distanceKm * 10) / 10,
    quality,
    hit: distanceKm <= HIT_RADIUS_KM,
    points: Math.round(1000 * quality),
  };
}

const isMastered = (s) => s && s.box >= MASTERED_BOX && s.mastery >= MASTERED_LEVEL;

export function recordAttempt(user, city, guess, now = Date.now()) {
  const result = scoreGuess(city, guess.lat, guess.lon);
  const s = (user.cities[city.id] ??= { attempts: 0, hits: 0, box: 0, mastery: null });
  const firstTry = s.attempts === 0;
  s.attempts += 1;
  s.hits += result.hit ? 1 : 0;
  s.mastery = s.mastery == null ? result.quality : (1 - MASTERY_ALPHA) * s.mastery + MASTERY_ALPHA * result.quality;
  if (firstTry && result.distanceKm <= KNOWN_KM) s.box = MASTERED_BOX;
  else if (result.hit) s.box = Math.min(s.box + 1, BOX_INTERVALS_MIN.length - 1);
  else s.box = result.quality < 0.2 ? 0 : Math.max(0, s.box - 2);
  s.lastSeen = now;
  s.due = now + BOX_INTERVALS_MIN[s.box] * 60_000;
  s.lastDistanceKm = result.distanceKm;
  s.bestDistanceKm = Math.min(s.bestDistanceKm ?? Infinity, result.distanceKm);
  user.totals.attempts += 1;
  user.totals.correct += result.hit ? 1 : 0;
  return { ...result, mastered: isMastered(s), box: s.box };
}

function tierProgress(user, cities) {
  const tiers = {};
  for (const c of cities) {
    const t = (tiers[c.tier] ??= { tier: c.tier, label: TIER_LABELS[c.tier], total: 0, seen: 0, mastered: 0 });
    t.total += 1;
    const s = user.cities[c.id];
    if (s) t.seen += 1;
    if (isMastered(s)) t.mastered += 1;
  }
  const list = Object.values(tiers).sort((a, b) => a.tier - b.tier);
  let unlocked = true;
  for (const t of list) {
    t.unlocked = unlocked;
    t.masteredRatio = t.mastered / t.total;
    unlocked = unlocked && t.masteredRatio >= UNLOCK_RATIO;
  }
  return list;
}

// Weakness per region, smoothed toward 0.5 so a single bad guess does not dominate.
function regionWeakness(user, cityById) {
  const acc = {};
  for (const [id, s] of Object.entries(user.cities)) {
    const c = cityById.get(id);
    if (!c || s.mastery == null) continue;
    const r = (acc[c.region] ??= { sum: 0, n: 0 });
    r.sum += s.mastery;
    r.n += 1;
  }
  const out = {};
  for (const [region, { sum, n }] of Object.entries(acc)) out[region] = 1 - (sum + 0.5 * 2) / (n + 2);
  return out;
}

function weightedSample(items, k, weightOf) {
  const pool = items.map((item) => ({ item, w: Math.max(weightOf(item), 1e-6) }));
  const out = [];
  while (out.length < k && pool.length) {
    let r = Math.random() * pool.reduce((sum, p) => sum + p.w, 0);
    const i = pool.findIndex((p) => (r -= p.w) <= 0);
    out.push(pool.splice(i === -1 ? pool.length - 1 : i, 1)[0].item);
  }
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Picks the next `count` cities for a user.
 * options.tier    restrict to one tier (practice mode) instead of the unlocked tiers
 * options.exclude city ids to avoid (e.g. the previous batch), used only if enough other cities exist
 */
export function nextCities(user, cities, cityById, { count = 10, tier = null, exclude = [], now = Date.now() } = {}) {
  const tiers = tierProgress(user, cities);
  const allowed = new Set(tier ? [tier] : tiers.filter((t) => t.unlocked).map((t) => t.tier));
  const avoid = new Set(exclude);
  const pool = cities.filter((c) => allowed.has(c.tier));
  const fresh = pool.filter((c) => !avoid.has(c.id));
  const candidates = fresh.length >= count ? fresh : pool;

  const weakness = regionWeakness(user, cityById);
  const seen = candidates.filter((c) => user.cities[c.id]);
  const unseen = candidates.filter((c) => !user.cities[c.id]).sort((a, b) => a.tier - b.tier || b.population - a.population);

  const priority = (c) => {
    const s = user.cities[c.id];
    const overdue = Math.min((now - s.due) / (BOX_INTERVALS_MIN[s.box] * 60_000), 3) / 3;
    return (1 - s.mastery) + 0.3 * overdue + 0.3 * (weakness[c.region] ?? 0);
  };
  const due = seen.filter((c) => user.cities[c.id].due <= now).sort((a, b) => priority(b) - priority(a));

  // Reviews first; new cities fill the rest. With a big review backlog, still keep ~30% new
  // cities so progress never stalls.
  const newCount = Math.min(unseen.length, Math.max(count - due.length, Math.ceil(count * 0.3)));
  const reviewCount = Math.min(due.length, count - newCount);

  const picked = [
    ...weightedSample(due.slice(0, reviewCount * 2), reviewCount, priority),
    // Biggest unseen first, with a little variety among the next few candidates.
    ...weightedSample(unseen.slice(0, newCount * 3), newCount, (c) => 1 / (1 + unseen.indexOf(c))),
  ];

  // Not enough due or new cities: top up with the weakest / soonest-due seen cities.
  if (picked.length < count) {
    const taken = new Set(picked.map((c) => c.id));
    const rest = seen.filter((c) => !taken.has(c.id))
      .sort((a, b) => user.cities[a.id].mastery - user.cities[b.id].mastery || user.cities[a.id].due - user.cities[b.id].due);
    picked.push(...rest.slice(0, count - picked.length));
  }

  return { cities: shuffle(picked), tiers };
}

export function userStats(user, cities, cityById) {
  const tiers = tierProgress(user, cities);
  const weakness = regionWeakness(user, cityById);
  const regions = {};
  for (const [id, s] of Object.entries(user.cities)) {
    const c = cityById.get(id);
    if (!c) continue;
    const r = (regions[c.region] ??= { region: c.region, cities: 0, attempts: 0, hits: 0, distanceSum: 0 });
    r.cities += 1;
    r.attempts += s.attempts;
    r.hits += s.hits;
    r.distanceSum += s.lastDistanceKm;
  }
  const regionList = Object.values(regions).map((r) => ({
    region: r.region,
    cities: r.cities,
    hitRate: r.hits / r.attempts,
    avgLastDistanceKm: Math.round(r.distanceSum / r.cities),
    weakness: weakness[r.region],
  })).sort((a, b) => b.weakness - a.weakness);

  const seen = Object.entries(user.cities)
    .filter(([id]) => cityById.has(id))
    .map(([id, s]) => {
      const c = cityById.get(id);
      return { id, name: c.name, department: c.department, tier: c.tier, mastery: s.mastery, attempts: s.attempts,
        hits: s.hits, lastDistanceKm: s.lastDistanceKm, bestDistanceKm: s.bestDistanceKm, mastered: isMastered(s) };
    });
  const byMastery = [...seen].sort((a, b) => a.mastery - b.mastery);

  return {
    totals: user.totals,
    tiers,
    regions: regionList,
    weakest: byMastery.filter((c) => c.mastery < MASTERED_LEVEL).slice(0, 15),
    strongest: byMastery.reverse().filter((c) => c.mastery >= MASTERED_LEVEL).slice(0, 10),
  };
}
