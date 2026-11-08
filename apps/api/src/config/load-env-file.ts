import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// src/config (or dist/config) -> repository root.
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));

/**
 * Loads the repository's .env file for local development. Production never reads a .env file:
 * its settings come from the host's environment and secret manager. Variables that are already
 * set are not overwritten.
 */
export function loadLocalEnvFile(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
}
