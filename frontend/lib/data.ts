import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Dossier, PrepState, Settings } from '@/lib/types';

// The mock data lives at the repository root so the agent and the frontend read the same files.
// Deployed on its own, the frontend has no repository root: it reads the copy kept in
// frontend/data by scripts/sync-data.mjs. No saved sessions there, only the clients.
const SHARED_DIR = path.join(process.cwd(), '..', 'data');
const DATA_DIR =
  process.env.WARREN_DATA_DIR ??
  (existsSync(path.join(SHARED_DIR, 'clients.json'))
    ? SHARED_DIR
    : path.join(process.cwd(), 'data'));

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf-8')) as T;
}

export async function loadDossiers(): Promise<Dossier[]> {
  return (await readJson<{ clients: Dossier[] }>('clients.json')).clients;
}

export async function loadDossier(clientId: string): Promise<Dossier | undefined> {
  return (await loadDossiers()).find((d) => d.client.id === clientId);
}

/**
 * The client's session as the agent last saved it: what was recorded, the meeting points, the
 * simulation and the place in the review. Null when there is none; run `uv run python
 * src/seed.py` to write the starting session of every client.
 */
export async function loadSession(clientId: string): Promise<PrepState | null> {
  try {
    return await readJson<PrepState>(path.join('sessions', `${clientId}.json`));
  } catch {
    return null;
  }
}

export function loadSettings(): Promise<Settings> {
  return readJson<Settings>('settings.json');
}
