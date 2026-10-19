import type { ReviewContext } from '../types/index.js';
import { ProviderCommands } from './commands.js';
import { NotImplementedError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

export class ClaudeProvider extends ProviderCommands implements ProviderAdapter {
  readonly name = 'claude';
  readonly defaultFamily = 'anthropic';
  async probe(_modelId: string) {
    return { available: false, error: 'not implemented in v1' };
  }
  async getQuota(_modelId: string): Promise<Quota> { return 'unknown'; }
  async executeReview(_context: ReviewContext, _modelId: string, _prompt: string, _options: ReviewOptions): Promise<RawProviderResult> {
    throw new NotImplementedError(this.name);
  }
}
