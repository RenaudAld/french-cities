# Villes de France

A geography game: place French cities (metropolitan France + Corsica) on a map showing department borders and the main rivers. A small file-based backend records every attempt, tracks strengths and weaknesses, and picks the next cities to ask, starting with the big ones and unlocking harder tiers as they are mastered.

## Run

```sh
npm start                 # http://localhost:3999  (PORT=... to change)
npm run build-data        # rebuild data/ from cached downloads in data/raw/
node scripts/build-data.mjs --refresh   # re-download everything
```

Requires Node 20+. There are no npm dependencies; the page loads D3 from jsDelivr.

## Data

`scripts/build-data.mjs` builds everything in `data/` from public sources:

| File | Content | Sources |
|---|---|---|
| `cities.json` / `cities.csv` | 1,074 cities: every commune of 10,000+ inhabitants, plus all prefectures and sub-prefectures | see below |
| `departements.geojson` | 96 department borders (simplified) | [france-geojson](https://github.com/gregoiredavid/france-geojson) |
| `rivers.geojson` | ~50 main rivers, clipped to France | OpenStreetMap via Overpass (ODbL) |

Each city has a name, coordinates (commune centre), population, department, region, postal codes and area, plus:
- **Administrative status**: regional prefecture, prefecture, sub-prefecture or commune, from the INSEE Code officiel géographique 2025.
- **Facts**: elevation and demonyms (Wikidata), an intro paragraph and a photo (French Wikipedia).
- **Difficulty tier**, 1 to 5.

Populations come from [geo.api.gouv.fr](https://geo.api.gouv.fr) (INSEE legal populations). Wikipedia text is CC BY-SA.

Ready-made downloads if you need the raw data elsewhere:
- INSEE COG (communes, departments, regions, chef-lieux): https://www.insee.fr/fr/information/8377162
- All communes with coordinates and population (JSON): https://geo.api.gouv.fr/communes?fields=nom,code,population,centre,codeDepartement,codeRegion&format=json
- Base officielle des codes postaux / communes (CSV, La Poste): https://www.data.gouv.fr/fr/datasets/base-officielle-des-codes-postaux/

No single official file combines population, coordinates, status and history, which is why the build script merges these sources.

## Tiers

| Tier | Rule | Cities |
|---|---|---|
| 1 | 130,000+ inhabitants, or regional capital | 31 |
| 2 | prefecture, or 75,000+ | 91 |
| 3 | 40,000+, or sub-prefecture of 20,000+ | 136 |
| 4 | 20,000+, or any sub-prefecture | 353 |
| 5 | other communes of 10,000+ | 463 |

## How cities are picked (`server/scheduler.mjs`)

- A guess is scored by distance: within **25 km** counts as a hit; points = `1000 · e^(-d/40km)`.
- Per city and player: **mastery** (a running average of guess quality that weights recent guesses more) and a **Leitner box** (0 to 6). A hit moves the city up one box. A miss moves it down two boxes, or back to box 0 if it was far off. The box sets when the city comes back: 1 min, 5 min, 30 min, 4 h, 1 day, 3 days, 10 days. A city counts as mastered at box 3 or above with mastery of at least 60 %. A first-ever guess within 10 km counts as mastered straight away.
- **Unlocking**: tier *n+1* opens once 70 % of tier *n* is mastered.
- **Each batch of 10** puts due reviews first, weakest first, with a bonus for cities in the player's weakest regions. New cities from the easiest unlocked tier fill the rest, biggest first, and always make up at least 30 % of the batch so progress never stalls. The previous batch is excluded when possible.
- A "Niveau N uniquement" mode lets you practise one tier, locked or not.

## Storage (no database)

- `data/users/<id>.json`: the player profile and per-city learning state, rewritten atomically (tmp file + rename). Writes are serialized per player.
- `data/users/<id>.attempts.jsonl`: an append-only log of every guess (time, city, click position, distance, response time).

## API

```
GET  /api/meta
GET  /api/users
POST /api/users                {name}
GET  /api/users/:id/next?count=10&tier=&exclude=id,id
POST /api/users/:id/attempts   {cityId, lat, lon, timeMs}   -> score + full city facts
GET  /api/users/:id/stats      tiers, weakest cities, regions ranked by weakness
```

Prompts never include coordinates. The department is shown only to tell apart cities with the same name (e.g. Marly, Nord / Moselle).
