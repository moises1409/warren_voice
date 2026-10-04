// Copies the mock data from the repository root into frontend/data, so that the frontend
// still has it when it is deployed on its own, without the rest of the repository.
// Where the root data folder is missing (such a deployment), the committed copy is used as is.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILES = ['clients.json', 'settings.json'];
const source = path.join(process.cwd(), '..', 'data');
const target = path.join(process.cwd(), 'data');

if (existsSync(path.join(source, FILES[0]))) {
  mkdirSync(target, { recursive: true });
  for (const name of FILES) copyFileSync(path.join(source, name), path.join(target, name));
}
