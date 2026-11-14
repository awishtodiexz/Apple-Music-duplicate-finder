export const fixture = `<!doctype html><title>Mock Apple Music</title><h1>Mock player — no account</h1>
<script>
window.scenario = 'duplicates';
window.apiMode = 'legacy';
window.revision = 'rev-1';
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
      // Echo the requested playlist id so a second fixture playlist behaves like a real one.
      const playlistId = (new URL(path, location.origin).pathname.split('/playlists/')[1] || 'p.fixture').split('/')[0];
      const catalog = playlistId.startsWith('pl.');
      const length = scenario === 'empty' ? 0 : scenario === 'huge' ? 50001 : scenario === 'many' ? 2400 : scenario === 'oneGroup' ? 6000 : scenario === 'fiftyOne' ? 102 : 245;
      if (!path.includes('/tracks?')) return { data: [{ id: playlistId, type: catalog ? 'playlists' : 'library-playlists',
        attributes: { name: scenario === 'coverage' ? 'Very long playlist name '.repeat(40) : '<img src=x onerror=alert(1)> My playlist', trackCount: scenario === 'coverage' || scenario === 'truncated' ? undefined : scenario === 'incomplete' ? 250 : length,
          lastModifiedDate: scenario === 'noMarker' ? undefined : scenario === 'edited' ? '2026-10-24T00:00:00Z' : '2026-10-23T00:00:00Z',
          playParams: scenario === 'revision' ? { versionHash: window.revision } : undefined } }] };
      if (scenarioAtStart === 'lateFailure') { window.lateFailures = (window.lateFailures || 0) + 1; throw new TypeError('Late request failed'); }
      if (scenario === 'huge') return { data: [], meta: { total: 50001 } };
      if (scenario === 'rate') throw { status: 429 };
      if (scenario === 'expired' && offset >= 100) throw { data: { status: 401 }, reason: 'UNAUTHORIZED_ERROR' };
      if (scenario === 'resolvedError' && offset >= 100) return { response: { status: 401 }, data: { data: [] } };
      if (scenario === 'network' && offset >= 100) throw new TypeError('Failed to fetch');
      if (scenario === 'internal' && offset >= 100) throw new TypeError('private internal failure');
      if (scenario === 'malformed' && offset >= 100) return { unexpected: [] };
      if (scenario === 'navigate') history.pushState({}, '', '/us/library/playlist/p.other');
      // Same ID, different regional storefront: the route is no longer the same playlist.
      if (scenario === 'navigateStorefront' && offset === 0) history.pushState({}, '', '/gb/playlist/fixture/pl.fixture');
      // The first page's continuation promises more entries; the next request
      // comes back empty, as a playlist shrunken or truncated mid-scan would.
      if (scenario === 'truncated' && offset > 0) return { json: { data: [], meta: {} } };
      return { json: { data: Array.from({ length: Math.max(0, Math.min(100, length - offset)) }, (_, i) => {
        const index = offset + i;
        const allSame = scenario === 'oneGroup';
        const repeated = allSame || scenario !== 'distinct' && (scenario === 'partial' ? [0, 100] : [0, 100, 244]).includes(index);
        const noId = scenario === 'unknown' || (scenario === 'coverage' && index === 2) || (scenario === 'mixed' && index === 0);
        const catalogId = noId ? undefined :
          allSame ? '123' : scenario === 'many' ? String(1000 + index % 1200) :
            scenario === 'fiftyOne' ? String(1000 + Math.floor(index / 2)) :
              repeated ? '123' : String(1000 + index);
        const libraryId = scenario === 'unknown' || (scenario === 'coverage' && index === 2) ? 'entry-' + index :
          scenario === 'mixed' && repeated ? 'i.numb' : 'i.' + index;
        return { id: catalog ? (catalogId || 'entry-' + index) : libraryId, type: catalog ? 'songs' : 'library-songs', attributes: {
          name: repeated ? 'Numb' : 'Song ' + index,
          artistName: repeated ? 'Linkin Park' : 'Artist',
          playParams: catalogId === undefined ? {} : { catalogId }
        } };
      }), meta: { total: scenario === 'coverage' || scenario === 'truncated' ? undefined : scenario === 'incomplete' ? 250 : length },
        ...(scenario === 'truncated' && offset === 0 ? {
          next: '/v1/me/library/playlists/' + playlistId + '/tracks?offset=100&limit=100' } : {}) } };
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
