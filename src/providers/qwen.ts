import type { ReviewContext } from '../types/index.js';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { AGY_SCHEMAS } from './schemas.js';
import { isRecord } from '../cascade/parse.js';
import { REVIEW_INSTRUCTIONS } from '../cascade/prompts.js';
import { ProviderCommands, quotaLanguage, remaining, type AdapterOptions } from './commands.js';
import { DEFAULT_QWEN_ENDPOINT, loopbackUrl } from './loopback.js';
import { ProviderError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

export const QWEN_REVIEW_PREFIX = REVIEW_INSTRUCTIONS + 'You have no file access or tools. The prompt diff is all the code you have; do not claim to inspect other files.\n';
export const MAX_QWEN_BYTES = 1024 * 1024;
export interface QwenOptions extends AdapterOptions { endpoint?: string; model?: string; fetch?: typeof globalThis.fetch }

class UnsupportedResponseFormat extends ProviderError {
  constructor() { super('unavailable', 'qwen server does not support response_format'); }
}

export class QwenProvider extends ProviderCommands implements ProviderAdapter {
  readonly name = 'qwen';
  readonly defaultFamily = 'local';
  private models?: string[];
  constructor(readonly qwenOptions: QwenOptions = {}) { super(qwenOptions); }

  private async request(route: string, options: ReviewOptions, body?: unknown): Promise<unknown> {
    const started = this.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, remaining(options, started, this.now));
    options.signal?.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = loopbackUrl(this.qwenOptions.endpoint ?? DEFAULT_QWEN_ENDPOINT, route);
      const response = await (this.qwenOptions.fetch ?? globalThis.fetch)(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (response.status === 429) {
        await response.body?.cancel();
        throw new ProviderError('quota', 'Qwen rate limited (429)');
      }
      if (Number(response.headers.get('content-length')) > MAX_QWEN_BYTES) {
        await response.body?.cancel();
        throw new ProviderError('unavailable', 'Qwen response exceeds 1 MiB');
      }
      reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_QWEN_BYTES) throw new ProviderError('unavailable', 'Qwen response exceeds 1 MiB');
        chunks.push(chunk.value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (response.status === 400 && /response_format|json_schema/i.test(text)) throw new UnsupportedResponseFormat();
      if (!response.ok) throw new ProviderError(quotaLanguage(text) ? 'quota' : 'unavailable', `Qwen HTTP error (${response.status})`);
      remaining(options, started, this.now);
      try { return JSON.parse(text) as unknown; }
      catch { return undefined; }
    } catch (error) {
      if (controller.signal.aborted || options.signal?.aborted) throw new ProviderError('timeout', 'Qwen deadline reached');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('unavailable', 'Qwen endpoint unavailable or refused');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (reader) { try { await reader.cancel(); } catch { /* Preserve the request failure. */ } }
    }
  }

  async listModels(options: ReviewOptions = { deadlineMs: 2000 }): Promise<string[]> {
    if (this.models) return [...this.models];
    const envelope = await this.request('models', options);
    if (!isRecord(envelope) || !Array.isArray(envelope.data) || !envelope.data.length
      || !envelope.data.every(item => isRecord(item) && typeof item.id === 'string' && item.id.trim())) {
      throw new ProviderError('unavailable', 'Qwen returned an invalid models list');
    }
    this.models = envelope.data.map(item => (item as { id: string }).id);
    return [...this.models];
  }
  async resolveModel(_modelId: string, options: ReviewOptions): Promise<string> {
    remaining(options, this.now(), this.now);
    return this.qwenOptions.model ?? (await this.listModels(options))[0]!;
  }
  async probe(modelId: string) {
    try { return { available: (await this.listModels()).includes(this.qwenOptions.model ?? (modelId === 'qwen' ? this.models![0]! : modelId)) }; }
    catch (error) { return { available: false, error: String(error) }; }
  }
  async getQuota(_modelId: string): Promise<Quota> { return 'unknown'; }
  async complete(model: string, prompt: string, options: ReviewOptions, system = QWEN_REVIEW_PREFIX): Promise<string | undefined> {
    const started = this.now();
    const purpose = options.purpose ?? 'review';
    const body = { model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0, max_tokens: 4096, stream: false };
    let envelope: unknown;
    try {
      envelope = await this.request('chat/completions', options, { ...body,
        response_format: { type: 'json_schema', json_schema: { name: purpose, strict: true, schema: AGY_SCHEMAS[purpose] } } });
    } catch (error) {
      if (!(error instanceof UnsupportedResponseFormat)) throw error;
      (options.warn ?? console.warn)(error.message);
      const deadlineMs = remaining(options, started, this.now);
      if (options.reserveRetry && !options.reserveRetry()) throw new ProviderError('unavailable', 'Qwen retry denied: review budget ceiling reached');
      envelope = await this.request('chat/completions', { ...options, deadlineMs }, body);
    }
    if (!isRecord(envelope) || !Array.isArray(envelope.choices)) return undefined;
    const first: unknown = envelope.choices[0];
    return isRecord(first) && isRecord(first.message) && typeof first.message.content === 'string' ? first.message.content : undefined;
  }
  async executeReview(_context: ReviewContext, modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult> {
    const started = this.now();
    const model = await this.resolveModel(modelId, options);
    const output = await this.complete(model, prompt, { ...options, deadlineMs: remaining(options, started, this.now) });
    return { rawOutput: output ?? 'Invalid Qwen result envelope', durationMs: this.now() - started, worktreeClean: true };
  }
}
