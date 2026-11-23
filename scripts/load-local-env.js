import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Load the repository's ignored .env file without replacing shell/deployment values. */
export function loadLocalEnvironment(file = path.join(ROOT, '.env')) {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    // Do not echo parser/file errors: they may contain source lines with credentials.
    throw new Error('The local .env file could not be loaded. Check that it exists and has valid KEY=value syntax.');
  }
}
