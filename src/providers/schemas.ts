import { isRecord, parseFindings } from '../cascade/parse.js';
import type { ReviewPurpose } from './types.js';

interface Schema {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  if?: Schema;
  then?: Schema;
}
const text: Schema = { type: 'string', minLength: 1 };
const line: Schema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const confidence: Schema = { type: 'number', minimum: 0, maximum: 1 };
const finding: Schema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['BLOCKER', 'IMPORTANT', 'OPTIONAL'] },
    origin: { type: 'string', enum: ['introduced', 'pre-existing', 'improvement'] },
    file: text, line, trigger: text, impact: text, evidence_quote: text, fix: text, confidence,
  },
  required: ['severity', 'origin', 'file', 'line', 'trigger', 'impact', 'evidence_quote', 'fix', 'confidence'],
};

// agy rejects array roots; every inference purpose has an object envelope.
export const AGY_SCHEMAS: Record<ReviewPurpose, Schema> = {
  review: { type: 'object', properties: { findings: { type: 'array', items: finding } }, required: ['findings'] },
  confirm: { type: 'object', properties: {
    decision: { type: 'string', enum: ['confirm', 'reject'] }, evidence_quote: text,
    line, confidence, trigger: text, impact: text, fix: text,
  }, required: ['decision'],
  if: { type: 'object', properties: { decision: { type: 'string', enum: ['confirm'] } }, required: ['decision'] },
  then: { type: 'object', required: ['evidence_quote'] } },
  'confirm-batch': { type: 'object', properties: { decisions: { type: 'array', items: {
    type: 'object', properties: { id: text, decision: { type: 'string', enum: ['confirm', 'reject'] }, line, evidence_quote: text },
    required: ['id', 'decision'],
  } } }, required: ['decisions'] },
  adjudicate: { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'] },
  reproduce: { type: 'object', properties: { path: text, content: text, expect: text }, required: ['path', 'content', 'expect'] },
};

function matches(value: unknown, schema: Schema): boolean {
  switch (schema.type) {
    case 'object': return isRecord(value) && (schema.required ?? []).every(key => Object.hasOwn(value, key))
      && Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || matches(value[key], child));
    case 'array': return Array.isArray(value) && value.every(item => matches(item, schema.items!));
    case 'string': return typeof value === 'string' && value.trim().length >= (schema.minLength ?? 0)
      && (!schema.enum || schema.enum.includes(value));
    case 'boolean': return typeof value === 'boolean';
    case 'integer':
    case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (schema.type !== 'integer' || Number.isSafeInteger(value))
      && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  }
}

export function validStructuredOutput(value: unknown, purpose: ReviewPurpose): boolean {
  if (!matches(value, AGY_SCHEMAS[purpose])) return false;
  if (purpose === 'review') {
    // Use the downstream parser too: optional fields (for example reproduction) must not invalidate findings.
    const parsed = parseFindings(JSON.stringify(value), {
      provider: 'agy', id: 'structured-validation', family: 'google', defaultTier: 'review', quotaGroup: 'agy',
    });
    return !parsed.error && !parsed.dropped.length;
  }
  return purpose !== 'confirm' || !isRecord(value) || value.decision !== 'confirm'
    || (matches(value.evidence_quote, text) && (value.reproduction === undefined || matches(value.reproduction, AGY_SCHEMAS.reproduce)));
}
