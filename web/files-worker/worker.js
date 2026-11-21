// The locked file host of the WebSim copy (docs/web.md): serves the packed
// game files (Mojang's, so never public) only with the access key, and only to
// pages on websim.com. The files are the Worker's static assets, which this
// script guards (`run_worker_first`); web/publish.sh deploys it.
const WEBSIM = /^https:\/\/([a-z0-9-]+\.)*websim\.(com|ai)$/;

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares digests, so the time taken says nothing about the key.
async function keyMatches(given, expected) {
  if (!expected) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = { vary: 'origin' };
    if (WEBSIM.test(origin)) {
      Object.assign(cors, {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'x-access-key',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
      });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: cors });
    }
    if (!(await keyMatches(request.headers.get('x-access-key') || '', env.ACCESS_KEY))) {
      return new Response('locked', { status: 401, headers: cors });
    }
    const response = await env.ASSETS.fetch(request);
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('cache-control', 'private, max-age=604800');
    return out;
  },
};
