// File-based persistence. No database:
//   data/users/<id>.json            profile + per-city learning state (rewritten atomically)
//   data/users/<id>.attempts.jsonl  append-only log of every attempt (for later analysis)

import fs from 'node:fs/promises';
import path from 'node:path';

export function createStore(dir) {
  const queues = new Map(); // per-user write serialization

  const profilePath = (id) => path.join(dir, `${id}.json`);
  const logPath = (id) => path.join(dir, `${id}.attempts.jsonl`);

  async function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, file);
  }

  function serialize(id, fn) {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(id, next);
    return next;
  }

  return {
    async init() {
      await fs.mkdir(dir, { recursive: true });
    },

    async listUsers() {
      const files = (await fs.readdir(dir)).filter((f) => /^[a-z0-9-]+\.json$/.test(f));
      const users = await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8').then(JSON.parse)));
      return users.map(({ id, name, createdAt, totals }) => ({ id, name, createdAt, totals }));
    },

    async getUser(id) {
      if (!/^[a-z0-9-]+$/.test(id)) return null;
      try {
        return JSON.parse(await fs.readFile(profilePath(id), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async createUser(name) {
      const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
      let id = base;
      for (let n = 2; await this.getUser(id); n++) id = `${base}-${n}`;
      const user = { id, name, createdAt: new Date().toISOString(), totals: { attempts: 0, correct: 0 }, cities: {} };
      await writeAtomic(profilePath(id), user);
      return user;
    },

    // Loads the user, lets `mutate` change it, then persists profile + log entry in order.
    updateUser(id, mutate) {
      return serialize(id, async () => {
        const user = await this.getUser(id);
        if (!user) return null;
        const { result, logEntry } = mutate(user);
        await writeAtomic(profilePath(id), user);
        if (logEntry) await fs.appendFile(logPath(id), `${JSON.stringify(logEntry)}\n`);
        return result;
      });
    },
  };
}
