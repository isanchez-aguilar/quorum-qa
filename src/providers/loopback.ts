export const DEFAULT_QWEN_ENDPOINT = 'http://127.0.0.1:8080/v1';

export function loopbackUrl(endpoint: string, route: string): URL {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password) throw new Error('Use an HTTP(S) loopback host (127.0.0.1, ::1 or localhost).');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${route}`;
  url.search = ''; url.hash = '';
  return url;
}
