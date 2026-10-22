// The multi-platform index digest, verified on 2026-10-21 with
// `docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.64.0-noble`.
// To update it, run the same command, take the top-level Digest line, update
// PLAYWRIGHT_CORE to the matching version/integrity, then run the opt-in container test.
export const DEFAULT_RUNTIME_IMAGE = 'mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f';
export const PLAYWRIGHT_CORE = {
  version: '1.64.0',
  integrity: 'sha512-T9r+MZkTECl2+oUcZ26YgZzTrYidTsIhYYkJix+6iDOymOb1FB2RLLSOxRGnZGv5DStt+aduIVbt+E8WygXYpg==',
} as const;
