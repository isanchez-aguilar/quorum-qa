// One mapping serves catalog identity and usage discovery; CLI bucket ids are not stable.
export const AGY_QUOTA_GROUPS = [
  { group: 'agy:argon', model: /^gemini-.*argon/i, description: /Argon/i },
  { group: 'agy:google', model: /^gemini-.*(?:flash|pro)/i, description: /Gemini\s+(?:Flash|Pro)/i },
  { group: 'agy:anthropic', model: /^(?:claude-|gpt-oss-)/i, description: /Claude\s+(?:Opus|Sonnet)|GPT[- ]OSS/i },
] as const;

export function agyQuotaGroup(model: string): string | undefined {
  return AGY_QUOTA_GROUPS.find(item => item.model.test(model))?.group;
}
