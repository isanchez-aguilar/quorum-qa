import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The installed package version, read once from package.json (one level above src/ and dist/). */
export function packageVersion(): string {
  cached ??= (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return cached;
}
