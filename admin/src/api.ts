const BASE = '';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly outcome?: 'failed' | 'unknown') { super(message); }
}

export function mutationOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  if (cause.outcome) return cause.outcome === 'unknown';
  return cause.status >= 500 || cause.status === 408;
}

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 401) window.location.hash = '#login';
    const retry = res.status === 429 ? ` Wait ${res.headers.get('retry-after') || '60'} seconds before retrying.` : '';
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    const remedy = typeof body?.next_action === 'string' ? ` ${body.next_action}` : '';
    const outcome = body?.outcome === 'unknown' || body?.outcome === 'failed' ? body.outcome : undefined;
    throw new ApiError(message + remedy + retry, res.status, outcome);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface ExploreFacets {
  sources: Array<{ id: string; name: string; pages: number }>;
  types: Array<{ type: string; pages: number }>;
}
export interface ExploreEntity { slug: string; title: string | null; type: string; source_id: string; backlinks: number }
export interface ExploreRow { key: string; slug: string | null; title: string; type: string; source_id: string; score: number; date: string | null; snippet: string; stale: boolean }
export interface ExplorePage {
  slug: string; title: string; type: string; source_id: string; updated_at: string; body: string;
  /** null means that section failed to load, which is not the same as empty. */
  backlinks: Array<{ from_slug: string }> | null;
  timeline: Array<{ id?: number; date: string; summary: string }> | null;
  facts: Array<{ id?: number; fact: string }> | null;
}
export interface ExploreThinkResult {
  answer: string; gaps: string[]; warnings: string[]; status: string;
  citations: Array<{ page_slug: string; source_id?: string | null }>;
}
export interface ExploreRunEstimate { estimated_usd: number; model: string; max_cap_usd: number }
export interface ExploreRunResult {
  ideas: Array<{ id: string; text: string; close_slug: string; far_slug: string; distance_score: number; passes: boolean; judge?: { weighted_score: number; note: string } }>;
  judge_failed: boolean;
  cost: { actual_usd: number };
  saved: { dbSaved: boolean } | null;
}

// Long runs answer newline-delimited JSON: progress lines, then one result or error line.
async function apiStream<T>(path: string, body: unknown, onProgress: (line: string) => void, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401) window.location.hash = '#login';
  if (!res.ok || !res.body) {
    const failure = await res.json().catch(() => null);
    throw new ApiError(typeof failure?.error === 'string' ? failure.error : `HTTP ${res.status}`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new ApiError('The run ended without a result.', 502);
    buffered += value;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new ApiError(event.error, 502);
      if ('result' in event) return event.result as T;
      if (event.progress) onProgress(event.progress);
    }
  }
}

export const api = {
  oauthRequest: (id: string) => apiFetch(`/admin/api/oauth-requests/${encodeURIComponent(id)}`),
  decideOAuthRequest: (id: string, decision: 'approve' | 'deny', csrf: string, sourceId?: string) =>
    apiFetch(`/admin/api/oauth-requests/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(sourceId === undefined ? { decision, csrf } : { decision, csrf, source_id: sourceId }) }),
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  agentsSpend: () => apiFetch('/admin/api/agents/spend'),
  sources: () => apiFetch('/admin/api/sources'),
  grantCatalog: () => apiFetch('/admin/api/grant-catalog'),
  clientGrant: (clientId: string) => apiFetch(`/admin/api/grants/${encodeURIComponent(clientId)}`),
  clientDetails: (clientId: string) => apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}`),
  clientSetup: (clientId: string, harness: string, flow?: string) => {
    const query = new URLSearchParams({ harness });
    if (flow) query.set('flow', flow);
    return apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}/setup?${query}`);
  },
  clientLifecycle: (clientId: string, body: Record<string, unknown>) => apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}/lifecycle`, { method: 'POST', body: JSON.stringify(body) }),
  registerClient: (body: Record<string, unknown>) => apiFetch('/admin/api/register-client', { method: 'POST', body: JSON.stringify(body) }),
  recoverClient: (clientId: string, harness?: string, flow?: string) => apiFetch('/admin/api/recover-client', { method: 'POST', body: JSON.stringify({ clientId, harness, flow }) }),
  updateClientGrant: (clientId: string, body: Record<string, unknown>) => apiFetch('/admin/api/rescope-client', { method: 'POST', body: JSON.stringify({ ...body, clientId }) }),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey(keyName: string, scopes: string[]) {
    return apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name: keyName, scopes }) });
  },
  revokeApiKey(id: string) {
    return apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ id }) });
  },
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  rescopeClient: (clientId: string, sourceId: string, federatedRead: string[]) =>
    apiFetch('/admin/api/rescope-client', {
      method: 'POST',
      body: JSON.stringify({ clientId, sourceId, federatedRead }),
    }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  exploreFacets: (): Promise<ExploreFacets> => apiFetch('/admin/api/explore/facets'),
  exploreEntities: (filter: string, source?: string): Promise<ExploreEntity[]> => {
    const query = new URLSearchParams({ q: filter });
    if (source) query.set('source', source);
    return apiFetch(`/admin/api/explore/entities?${query}`);
  },
  explorePage: (slug: string, source?: string): Promise<ExplorePage> => {
    const query = new URLSearchParams({ slug });
    if (source) query.set('source', source);
    return apiFetch(`/admin/api/explore/page?${query}`);
  },
  exploreSearch: (body: { query: string; mode: 'keyword' | 'hybrid'; source?: string; types?: string[]; offset?: number }): Promise<{ rows: ExploreRow[]; next_offset: number | null }> =>
    apiFetch('/admin/api/explore/search', { method: 'POST', body: JSON.stringify(body) }),
  exploreThink: (body: { question: string; source?: string }, onProgress: (line: string) => void, signal: AbortSignal) =>
    apiStream<ExploreThinkResult>('/admin/api/explore/think', body, onProgress, signal),
  exploreRunEstimate: (profile: 'brainstorm' | 'lsd'): Promise<ExploreRunEstimate> => apiFetch(`/admin/api/explore/run-estimate?profile=${profile}`),
  exploreRun: (body: { question: string; profile: 'brainstorm' | 'lsd'; source?: string; max_usd: number; save: boolean }, onProgress: (line: string) => void, signal: AbortSignal) =>
    apiStream<ExploreRunResult>('/admin/api/explore/run', body, onProgress, signal),
};
