export const fixture = `<!doctype html><title>Mock Apple Music</title><h1>Mock player — no account</h1>
<script>
window.scenario = 'duplicates';
window.apiMode = 'legacy';
window.requests = [];
window.MusicKit = { getInstance() {
  if (window.scenario === 'unavailable') throw new Error('not initialized');
  const api = {
    async get(path) {
      window.requests.push(path);
      const scenarioAtStart = window.scenario;
      await new Promise(resolve => setTimeout(resolve, window.fixtureDelay || 25));
      const scenario = window.scenario;
      const offset = Number(new URL(path, location.origin).searchParams.get('offset'));
      const length = scenario === 'empty' ? 0 : scenario === 'huge' ? 50001 : scenario === 'many' ? 2400 : 245;
      if (!path.includes('/tracks?')) return { data: [{ id: 'p.fixture', type: 'library-playlists',
        attributes: { name: scenario === 'coverage' ? 'Very long playlist name '.repeat(40) : '<img src=x onerror=alert(1)> My playlist', trackCount: scenario === 'coverage' ? undefined : scenario === 'incomplete' ? 250 : length,
          lastModifiedDate: scenario === 'noMarker' ? undefined : '2026-10-23T00:00:00Z' } }] };
      if (scenarioAtStart === 'lateFailure') { window.lateFailures = (window.lateFailures || 0) + 1; throw new TypeError('Late request failed'); }
      if (scenario === 'huge') return { data: [], meta: { total: 50001 } };
      if (scenario === 'rate') throw { status: 429 };
      if (scenario === 'expired' && offset >= 100) throw { data: { status: 401 }, reason: 'UNAUTHORIZED_ERROR' };
      if (scenario === 'resolvedError' && offset >= 100) return { response: { status: 401 }, data: { data: [] } };
      if (scenario === 'network' && offset >= 100) throw new TypeError('Failed to fetch');
      if (scenario === 'malformed' && offset >= 100) return { unexpected: [] };
      if (scenario === 'navigate') history.pushState({}, '', '/us/library/playlist/p.other');
      return { json: { data: Array.from({ length: Math.max(0, Math.min(100, length - offset)) }, (_, i) => {
        const index = offset + i;
        const repeated = scenario !== 'distinct' && [0, 100, 244].includes(index);
        return { id: scenario === 'unknown' || (scenario === 'coverage' && index === 2) ? 'entry-' + index : scenario === 'mixed' && repeated ? 'i.numb' : 'i.' + index, type: 'library-songs', attributes: {
          name: repeated ? 'Numb' : 'Song ' + index,
          artistName: repeated ? 'Linkin Park' : 'Artist',
          playParams: scenario === 'unknown' || (scenario === 'coverage' && index === 2) || (scenario === 'mixed' && index === 0) ? {} :
            { catalogId: scenario === 'many' ? String(1000 + index % 1200) : repeated ? '123' : String(1000 + index) }
        } };
      }), meta: { total: scenario === 'coverage' ? undefined : scenario === 'incomplete' ? 250 : length } } };
    }
  };
  if (window.apiMode === 'v3') {
    const legacyRead = api.get;
    api.music = async function(path, query, options) {
      if (this !== api || Object.keys(query).length || options?.fetchOptions?.method !== 'GET') throw new Error('Invalid v3 read');
      try {
        let abort;
        let body;
        try {
          body = await Promise.race([legacyRead(path), new Promise((_, reject) => {
            abort = () => {
              window.abortedRequests = (window.abortedRequests || 0) + 1;
              reject(new DOMException('Cancelled', 'AbortError'));
            };
            options.fetchOptions.signal?.addEventListener('abort', abort, { once: true });
          })]);
        } finally { if (abort) options.fetchOptions.signal?.removeEventListener('abort', abort); }
        if (body.response?.status >= 400) return body;
        return { data: body.json || body, response: { status: 200 } };
      } catch (error) {
        // Match MKError.responseError's nested Response shape.
        if (error.status) throw { data: new Response(null, { status: error.status }), reason: 'UNKNOWN_ERROR' };
        throw error;
      }
    };
    delete api.get;
  }
  return { isAuthorized: window.scenario !== 'auth', storefrontId: 'us', api };
} };
</script>`;
