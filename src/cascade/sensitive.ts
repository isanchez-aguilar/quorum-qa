/** Match words and identifier components, never arbitrary substrings. */
export function isSensitiveChunk(diff: string, files: readonly string[], focus: readonly string[]): boolean {
  const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const text = ` ${words([...files, diff].join('\n')).join(' ')} `;
  const money = ['billing', 'payment', 'charge', 'refund', 'price', 'invoice', 'webhook', 'lock'];
  const auth = ['auth', 'token', 'session', 'role', 'permission'];
  // Stems only where no ordinary word shares them (author, authority do not).
  const authStems = / (?:authenticat|authoriz|authoris)\w*(?= )/;
  return focus.some(term => {
    const normalized = words(term).join(' ');
    const authLike = ['auth', 'permission', 'permissions'].includes(normalized);
    const terms = [normalized, ...(normalized === 'money' ? money : authLike ? auth : [])];
    // Plurals count: payments, tokens, webhooks, sessions.
    return terms.some(value => value.length > 0 && [value, `${value}s`, `${value}es`].some(form => text.includes(` ${form} `)))
      || (authLike && authStems.test(text));
  });
}
