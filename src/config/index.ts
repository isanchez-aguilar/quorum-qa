import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { QuorumConfig } from '../types/index.js';
import { ConfigError, validateConfig } from './schema.js';

export { ConfigError, resolveAuthorFamily, validateConfig } from './schema.js';

export const CONFIG_FILE_NAME = 'quorum.config.json';

export async function loadConfig(configPath?: string): Promise<QuorumConfig> {
  const file = path.resolve(configPath ?? CONFIG_FILE_NAME);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError([`file not found: ${file}`], 'Cannot load config');
    }
    throw new ConfigError([`cannot read ${file}: ${(error as Error).message}`], 'Cannot load config');
  }

  let raw: unknown;
  try {
    // Windows editors and PowerShell often write a UTF-8 BOM.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigError([`${file} is not valid JSON: ${(error as Error).message}`], 'Cannot load config');
  }

  return validateConfig(raw);
}
