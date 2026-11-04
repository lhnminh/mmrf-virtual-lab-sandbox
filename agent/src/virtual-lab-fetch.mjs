export function createVirtualLabFetch({
  origin = process.env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080',
  username = process.env.SANDBOX_ACCESS_USERNAME,
  password = process.env.SANDBOX_ACCESS_PASSWORD,
  fetchImpl = fetch,
} = {}) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('VIRTUAL_LAB_ORIGIN must be an HTTP(S) URL without credentials');
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('Both sandbox access credentials must be configured');
  }
  return async (path, options = {}) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('Virtual Lab requests must stay on the configured origin');
    const headers = new Headers(options.headers);
    if (username) {
      headers.set('authorization', 'Basic ' + Buffer.from(username + ':' + password).toString('base64'));
    }
    return fetchImpl(url, { ...options, headers });
  };
}
