import { createBrowserSource } from './browser-source';
import { findDuplicates } from './duplicates';
import { errorCode, errorMessage, ScanError } from './errors';
import { readPlaylist, type PlaylistSource } from './playlist-reader';
import { detectPlaylist } from './playlist-url';
import { csvFilename, formatGroupText, formatResultsText, summarize, summaryLine, toCsv, visibleGroups, type SortMode } from './results';
import { cacheFreshness, clearCachedScan, loadCachedScan, loadThemePreference, saveCachedScan, saveThemePreference, type CachedScan } from './storage';
import { nextTheme, themeLabel, type ThemePreference } from './theme';
import type { DuplicateGroup, PlaylistInfo, PlaylistRef } from './types';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('Missing popup element');
  return found as T;
}
const scan = element<HTMLButtonElement>('scan');
const cancel = element<HTMLButtonElement>('cancel');
const playlistName = element('playlist-name');
const status = element('status');
const statusTitle = element('status-title');
const statusDetail = element('status-detail');
const statusCode = element('status-code');
const results = element('results');
const list = element('duplicate-list');
const notes = element('scan-notes');
const progress = element<HTMLProgressElement>('scan-progress');
const showMore = element<HTMLButtonElement>('show-more');
const resultsSearch = element<HTMLInputElement>('results-search');
const resultsSort = element<HTMLSelectElement>('results-sort');
const resultsMin = element<HTMLSelectElement>('results-min');
const copyResults = element<HTMLButtonElement>('copy-results');
const downloadResults = element<HTMLButtonElement>('download-results');
const clearResults = element<HTMLButtonElement>('clear-results');
const resetFilters = element<HTMLButtonElement>('reset-filters');
const popOut = element<HTMLButtonElement>('pop-out');
const popoutSeparator = element('popout-separator');
const statusAnnouncer = element('status-announcer');
const resultsAnnouncer = element('results-announcer');
const resultsFeedback = element('results-feedback');
const resultsEmpty = element('results-empty');
const version = element('version');
const themeToggle = element<HTMLButtonElement>('theme-toggle');
const numberFormat = new Intl.NumberFormat();
const number = (value: number): string => numberFormat.format(value);
const batchSize = 50;
const maxInlinePositions = 50;
/**
 * The last fully completed scan. It stays in memory so a failed or cancelled
 * rescan can restore valid results (and the badge) instead of erasing them.
 */
interface CompletedScan {
  playlistName: string;
  scannedAt: number;
  groups: DuplicateGroup[];
  totalTracks: number;
  unidentified: number;
  notes: string;
  cached: boolean;
}
let lastCompleted: CompletedScan | null = null;
let source: PlaylistSource | null = null;
// Fetched while connecting; reused once so the first scan skips a round trip.
let pendingInfo: PlaylistInfo | null = null;
let currentPlaylist: PlaylistRef | null = null;
let connectedTabId: number | null = null;
let currentPlaylistName = '';
let busy = false;
let scanFailed = false;
let hasScanResult = false;
let groups: DuplicateGroup[] = [];
let visible: DuplicateGroup[] = [];
let displayed = 0;
let totalTracks = 0;
let unidentified = 0;
let scanNotes = '';
let scanController: AbortController | null = null;
// Progress arrives once per page; the live region must not re-announce the whole
// status block hundreds of times during a large scan.
const statusThrottleMs = 1_000;
let lastStatusWrite = 0;

const manifestVersion = chrome.runtime?.getManifest?.()?.version;
if (manifestVersion) version.textContent = `v${manifestVersion}`;

// Applied before the first scan so an explicit choice never flashes the wrong palette.
let themePreference: ThemePreference = loadThemePreference();
function applyTheme(): void {
  document.documentElement.dataset.theme = themePreference;
  const label = themeLabel(themePreference);
  themeToggle.textContent = `Theme: ${label}`;
  themeToggle.setAttribute('aria-label', `Theme: ${label}. Switch to ${themeLabel(nextTheme(themePreference))}.`);
}
applyTheme();
themeToggle.addEventListener('click', () => {
  themePreference = nextTheme(themePreference);
  saveThemePreference(themePreference);
  applyTheme();
});

/** Badge count survives closing the popup, so it is the glanceable result. */
function setBadge(count: number | null): void {
  try {
    if (!chrome.action) return;
    void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: '#c7284e' })).catch(() => {});
    void Promise.resolve(chrome.action.setBadgeText({ text: count === null ? '' : count > 999 ? '999+' : String(count) }))
      .catch(() => {});
  } catch {
    // Decorative only; never let a badge failure affect a scan.
  }
}

function updateScanLabel(): void {
  scan.textContent = source ? (scanFailed ? 'Retry scan' : hasScanResult ? 'Scan again' : 'Scan for Duplicates') : 'Retry connection';
}

/** The popped-out window carries the tab it was opened from; the toolbar popup does not. */
function pinnedTabId(): number | null {
  const value = new URLSearchParams(location.search).get('tab');
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function updatePopOut(): void {
  // Hidden while a scan runs: opening the window closes this popup, which would
  // abort that scan before the new window could adopt the results.
  popOut.hidden = !(connectedTabId !== null && !busy && pinnedTabId() === null &&
    typeof chrome.windows?.create === 'function');
  // The footer separator belongs to the button; a popped-out window has neither.
  popoutSeparator.hidden = popOut.hidden;
}

popOut.addEventListener('click', () => {
  if (connectedTabId === null || busy) return;
  try {
    const url = `${chrome.runtime.getURL('popup.html')}?tab=${connectedTabId}`;
    void Promise.resolve(chrome.windows.create({ url, type: 'popup', width: 400, height: 760 })).catch(() => {});
  } catch {
    // The toolbar popup still works if a window cannot be created.
  }
});

function setStatus(title: string, detail: string, error = false, code?: string): void {
  // Assigning identical text still replaces the node and re-triggers a live
  // region announcement, so only write what actually changed.
  if (statusTitle.textContent !== title) statusTitle.textContent = title;
  if (statusDetail.textContent !== detail) statusDetail.textContent = detail;
  status.dataset.error = String(error);
  statusCode.textContent = code ? `Error code: ${code}` : '';
  statusCode.hidden = !code;
  lastStatusWrite = Date.now();
  announceStatus(title, detail, code);
}

// Progress text changes every page; a live region that repeats it floods a
// screen reader, so only phase changes and periodic progress reach the announcer.
const statusAnnounceIntervalMs = 20_000;
let lastStatusAnnouncement = 0;
function announceStatus(title: string, detail: string, code?: string): void {
  const progress = title === 'Scanning playlist…' || title === 'Checking playlist…';
  if (progress && Date.now() - lastStatusAnnouncement < statusAnnounceIntervalMs) return;
  lastStatusAnnouncement = Date.now();
  const text = [title, detail, code ? `Error code ${code}` : ''].filter(Boolean).join('. ');
  if (statusAnnouncer.textContent !== text) statusAnnouncer.textContent = text;
}

function clearGroups(): void {
  groups = [];
  visible = [];
  displayed = 0;
  totalTracks = 0;
  unidentified = 0;
  scanNotes = '';
  list.replaceChildren();
  results.hidden = true;
  showMore.hidden = true;
  notes.hidden = true;
  notes.textContent = '';
  resultsEmpty.hidden = true;
  resultsFeedback.textContent = '';
  resultsSearch.value = '';
  resultsMin.value = '2';
  resultsSort.value = 'playlist';
  clearResults.hidden = true;
}

function currentGroups(): DuplicateGroup[] {
  const mode = resultsSort.value as SortMode;
  return visibleGroups(groups, resultsSearch.value, mode || 'playlist', Number(resultsMin.value) || 2);
}

function appendGroup(group: DuplicateGroup): void {
  const item = document.createElement('li');
  item.tabIndex = -1;
  const song = document.createElement('p');
  song.className = 'song';
  // Let each name own its text direction; mixed-script titles then read in the
  // right order instead of inheriting the popup's left-to-right paragraph.
  song.dir = 'auto';
  // API-provided text is always text, never HTML.
  song.textContent = group.name;
  item.append(song);
  if (group.artist.trim()) {
    const artist = document.createElement('p');
    artist.className = 'artist';
    artist.dir = 'auto';
    artist.textContent = group.artist;
    item.append(artist);
  }
  const counts = document.createElement('p');
  counts.className = 'counts';
  counts.textContent = group.copies === 2 ? 'This song appears twice' : `This song appears ${number(group.copies)} times`;
  item.append(counts);
  const positions = document.createElement('p');
  positions.className = 'positions';
  const inline = group.positions.slice(0, maxInlinePositions);
  const hiddenCount = group.positions.length - inline.length;
  positions.textContent = `Playlist positions: ${inline.map(number).join(', ')}` +
    (hiddenCount > 0 ? ` …and ${number(hiddenCount)} more` : '');
  item.append(positions);
  if (hiddenCount > 0) {
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.className = 'more-positions';
    showAll.setAttribute('aria-expanded', 'false');
    const collapsedText = positions.textContent;
    const allText = `Playlist positions: ${group.positions.map(number).join(', ')}`;
    const groupLabel = group.artist.trim() ? `${group.name} by ${group.artist}` : group.name;
    showAll.textContent = `Show all ${number(group.positions.length)} positions`;
    showAll.addEventListener('click', () => {
      const expanded = showAll.getAttribute('aria-expanded') !== 'true';
      showAll.setAttribute('aria-expanded', String(expanded));
      showAll.textContent = expanded ? 'Show fewer positions' : `Show all ${number(group.positions.length)} positions`;
      positions.textContent = expanded ? allText : collapsedText;
      if (expanded) {
        // Thousands of positions stay inside a short scroll area, and the
        // toggle keeps focus so a keyboard user can collapse it again.
        positions.tabIndex = 0;
        positions.setAttribute('role', 'group');
        positions.setAttribute('aria-label', `All playlist positions for ${groupLabel}`);
        positions.setAttribute('data-expanded', 'true');
      } else {
        positions.removeAttribute('tabindex');
        positions.removeAttribute('role');
        positions.removeAttribute('aria-label');
        positions.removeAttribute('data-expanded');
      }
    });
    item.append(showAll);
  }
  const copyGroup = document.createElement('button');
  copyGroup.type = 'button';
  copyGroup.className = 'copy-group';
  copyGroup.textContent = 'Copy';
  copyGroup.setAttribute('aria-label', group.artist.trim() ?
    `Copy ${group.name} by ${group.artist}` : `Copy ${group.name}`);
  copyGroup.addEventListener('click', async () => {
    if (await copyText(formatGroupText(group))) {
      resultsFeedback.textContent = `Copied ${group.name}.`;
    } else {
      resultsFeedback.textContent = 'Copy failed. Use CSV instead.';
    }
  });
  item.append(copyGroup);
  list.append(item);
}

function updateResultsTitle(): void {
  const title = element('results-title');
  const query = resultsSearch.value.trim();
  const minCopies = Number(resultsMin.value) || 2;
  const batching = displayed < visible.length;
  const count = number(visible.length);
  let text: string;
  if (query) {
    text = `Repeated songs · ${count} of ${number(groups.length)} matching`;
    if (batching) text += ` · ${number(displayed)} shown`;
  } else if (minCopies > 2) {
    text = `Repeated songs · ${count} of ${number(groups.length)}`;
    if (batching) text += ` · ${number(displayed)} shown`;
  } else {
    text = batching ?
      `Repeated songs · ${number(displayed)} of ${count} shown` :
      `Repeated songs · ${count}`;
  }
  if (title.textContent !== text) title.textContent = text;
}

function appendBatch(): void {
  const end = Math.min(displayed + batchSize, visible.length);
  for (const group of visible.slice(displayed, end)) appendGroup(group);
  displayed = end;
  const remaining = Math.min(batchSize, visible.length - displayed);
  showMore.hidden = displayed === visible.length || visible.length === 0;
  showMore.textContent = `Show ${number(remaining)} more ${remaining === 1 ? 'song' : 'songs'}`;
  results.hidden = groups.length === 0;
  resultsEmpty.hidden = visible.length !== 0;
  copyResults.disabled = visible.length === 0;
  downloadResults.disabled = visible.length === 0;
  updateResultsTitle();
}

function renderResults(): void {
  visible = currentGroups();
  displayed = 0;
  list.replaceChildren();
  appendBatch();
  // Typing should not announce per character; the count is debounced, and a
  // scan's own status announcement already covers the first render.
  if (!busy) announceResults();
}

let resultsAnnounceTimer: ReturnType<typeof setTimeout> | undefined;
function announceResults(): void {
  clearTimeout(resultsAnnounceTimer);
  resultsAnnounceTimer = setTimeout(() => {
    if (busy) return;
    const text = visible.length === groups.length ?
      `${number(visible.length)} ${visible.length === 1 ? 'song' : 'songs'} shown.` :
      `${number(visible.length)} of ${number(groups.length)} songs match.`;
    if (resultsAnnouncer.textContent !== text) resultsAnnouncer.textContent = text;
  }, 500);
}

/** Paint one completed scan. Only a completed scan ever reaches this function. */
function applyCompleted(completed: CompletedScan): void {
  lastCompleted = completed;
  currentPlaylistName = completed.playlistName;
  groups = completed.groups;
  totalTracks = completed.totalTracks;
  unidentified = completed.unidentified;
  scanNotes = completed.notes;
  hasScanResult = true;
  notes.textContent = scanNotes;
  notes.hidden = !scanNotes;
  setBadge(groups.length);
  renderResults();
  clearResults.hidden = false;
}

function restoreCached(cached: CachedScan): void {
  applyCompleted({
    playlistName: cached.playlistName,
    scannedAt: cached.scannedAt,
    groups: cached.groups,
    totalTracks: cached.totalTracks,
    unidentified: cached.unidentified,
    notes: cached.notes,
    cached: true,
  });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Explains that results on screen are the previous completed scan, never the failed one. */
function lastCompletedNotice(completed: CompletedScan): string {
  const persistence = completed.cached ? '' :
    '\nThese results are too large to remember after the popup closes; use Copy or CSV if you need them.';
  return `Showing the last completed scan from ${formatDate(completed.scannedAt)}.${persistence}\n` +
    summaryLine(summarize(completed.totalTracks, completed.groups, completed.unidentified));
}

function cacheCurrent(playlist: PlaylistRef, info: PlaylistInfo, countVerified: boolean,
  modificationChecked: boolean, scannedAt: number): boolean {
  const cached: CachedScan = {
    version: 1,
    playlistId: playlist.id,
    playlistName: info.name,
    scannedAt,
    groups,
    unidentified,
    totalTracks,
    countVerified,
    modificationChecked,
    notes: scanNotes,
    modified: info.modified,
    revision: info.revision ?? null,
  };
  const saved = saveCachedScan(cached);
  if (!saved) {
    resultsFeedback.textContent = 'Results are too large to remember after the popup closes. Use Copy or CSV if you need them.';
  }
  clearResults.hidden = groups.length === 0 && !saved;
  return saved;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path for browsers that deny clipboard access.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try { return document.execCommand('copy'); } finally { textarea.remove(); }
}

function downloadCsv(): void {
  // The BOM lets Excel detect UTF-8 instead of mangling non-ASCII names.
  const blob = new Blob(['\uFEFF' + toCsv(visible)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = csvFilename(currentPlaylistName || 'playlist');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function cachedStatus(cached: CachedScan): string {
  return `${summaryLine(summarize(cached.totalTracks, cached.groups, cached.unidentified))}\nCached ${formatDate(cached.scannedAt)}.`;
}

async function initialize(): Promise<void> {
  busy = true;
  scanFailed = false;
  hasScanResult = false;
  // A new connection may target a different playlist; never carry the previous
  // playlist's results into it. A cache for this playlist is restored below.
  lastCompleted = null;
  currentPlaylistName = '';
  clearGroups();
  source = null;
  currentPlaylist = null;
  pendingInfo = null;
  scan.disabled = true;
  scan.textContent = 'Connecting…';
  playlistName.textContent = 'Detecting playlist…';
  playlistName.title = '';
  setStatus('Connecting to Apple Music…', 'Checking the current playlist.');
  connectedTabId = null;
  updatePopOut();
  let restored = false;
  try {
    const pinned = pinnedTabId();
    let tab: chrome.tabs.Tab | undefined;
    if (pinned !== null) {
      try { tab = await chrome.tabs.get(pinned); } catch { throw new ScanError('PAGE_CHANGED'); }
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (tab?.id === undefined) throw new Error('Tab unavailable');
    connectedTabId = tab.id;
    updatePopOut();
    const playlist = detectPlaylist(tab.url ?? '');
    const candidate = createBrowserSource(tab.id, playlist);
    // A cached scan does not need the player, so paint it before the round trip:
    // a slow, signed-out or unreachable MusicKit must not hide existing results.
    const cached = loadCachedScan(playlist.id);
    if (cached) {
      restoreCached(cached);
      restored = true;
      playlistName.textContent = cached.playlistName;
      playlistName.title = cached.playlistName;
      setStatus('Showing last scan', `${cachedStatus(cached)} Checking Apple Music…`);
    } else {
      // The badge outlives the popup, so a different playlist must not inherit it.
      setBadge(null);
    }
    try {
      const info = await candidate.metadata();
      pendingInfo = info;
      source = candidate;
      currentPlaylist = playlist;
      currentPlaylistName = info.name;
      playlistName.textContent = info.name;
      playlistName.title = info.name;
      if (cached && lastCompleted) {
        const fresh = cacheFreshness(cached, info);
        setStatus('Showing last scan', fresh === 'changed' ?
          `${cachedStatus(cached)} The playlist changed since this scan. Scan again to refresh.` :
          `${cachedStatus(cached)} Rescan to refresh.`);
      } else {
        // No cache, or the user cleared it while this connection was in flight:
        // neither case may claim to be showing a cached scan.
        setStatus('Ready to scan', 'Find songs listed more than once. Keep this popup open while scanning.');
      }
    } catch (error) {
      // Keep the cached results and explain why they cannot be refreshed.
      if (!cached || !lastCompleted) throw error;
      setStatus('Showing last scan', `${cachedStatus(cached)} ${errorMessage(error)}`, false, errorCode(error));
    }
  } catch (error) {
    playlistName.textContent = 'Playlist unavailable';
    setStatus('Could not connect', errorMessage(error), true, errorCode(error));
    if (!restored) setBadge(null);
  } finally {
    busy = false;
    scan.disabled = false;
    updateScanLabel();
    updatePopOut();
  }
}

showMore.addEventListener('click', () => {
  const firstNew = displayed;
  appendBatch();
  const first = list.children[firstNew] as HTMLElement | undefined;
  first?.focus({ preventScroll: true });
  first?.scrollIntoView({ block: 'start' });
  resultsFeedback.textContent = `Showing ${number(displayed)} of ${number(visible.length)}.`;
});

cancel.addEventListener('click', () => scanController?.abort());
window.addEventListener('pagehide', () => scanController?.abort());

// The debounced results announcer already reports the filtered count; writing
// a second live status message here would announce every filter twice.
resultsSearch.addEventListener('input', renderResults);
resultsSort.addEventListener('change', renderResults);
resultsMin.addEventListener('change', renderResults);

resetFilters.addEventListener('click', () => {
  resultsSearch.value = '';
  resultsMin.value = '2';
  renderResults();
  resultsSearch.focus();
  resultsFeedback.textContent = 'Search and filters cleared.';
});

// "/" is the common search shortcut; Escape clears the query before the popup closes.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (event.key === '/' && !typing && !results.hidden) {
    event.preventDefault();
    resultsSearch.focus();
    resultsSearch.select();
    return;
  }
  if (event.key === 'Escape' && target === resultsSearch) {
    if (resultsSearch.value) {
      resultsSearch.value = '';
      renderResults();
      resultsFeedback.textContent = '';
    } else {
      resultsSearch.blur();
    }
  }
});

copyResults.addEventListener('click', async () => {
  const text = formatResultsText(currentPlaylistName || 'Current playlist', visible, summarize(totalTracks, visible, unidentified), scanNotes);
  if (await copyText(text)) {
    resultsFeedback.textContent = `Copied ${number(visible.length)} ${visible.length === 1 ? 'song' : 'songs'}.`;
  } else {
    resultsFeedback.textContent = 'Copy failed. Use CSV instead.';
  }
});

downloadResults.addEventListener('click', () => {
  downloadCsv();
  resultsFeedback.textContent = `Downloaded ${number(visible.length)} ${visible.length === 1 ? 'song' : 'songs'} as CSV.`;
});

clearResults.addEventListener('click', () => {
  clearCachedScan();
  lastCompleted = null;
  hasScanResult = false;
  clearGroups();
  setBadge(null);
  updateScanLabel();
  setStatus('Results cleared', 'Run a scan to find repeated songs again.');
  // The button that had focus is now hidden; keep keyboard users in the popup.
  scan.focus();
});

scan.addEventListener('click', async () => {
  if (busy) return;
  if (!source || !currentPlaylist) { await initialize(); return; }
  busy = true;
  scanFailed = false;
  const baselineInfo = pendingInfo ?? undefined;
  pendingInfo = null;
  updatePopOut();
  const controller = new AbortController();
  scanController = controller;
  cancel.hidden = false;
  scan.disabled = true;
  scan.textContent = 'Scanning…';
  // The badge describes the last completed scan; keep it until a new completed
  // scan replaces it, so closing or failing this scan cannot erase an accurate badge.
  clearGroups();
  progress.hidden = false;
  progress.removeAttribute('value');
  setStatus('Scanning playlist…', 'Connecting to Apple Music…');
  try {
    const result = await readPlaylist(source, ({ retrieved, total, elapsedMs, phase }) => {
      if (total !== null && total > 0) {
        progress.max = total;
        progress.value = retrieved;
      } else progress.removeAttribute('value');
      const timestamp = Date.now();
      if (phase === 'reading' && timestamp - lastStatusWrite < statusThrottleMs) return;
      const count = total === null ? number(retrieved) : `${number(retrieved)} of ${number(total)}`;
      setStatus(phase === 'validating' ? 'Checking playlist…' : 'Scanning playlist…',
        `${count} songs retrieved · ${Math.floor(elapsedMs / 1000)}s elapsed\nKeep this popup open while scanning.`);
    }, { signal: controller.signal, ...(baselineInfo ? { info: baselineInfo } : {}) });
    const duplicates = findDuplicates(result.tracks);
    currentPlaylistName = result.info.name;
    playlistName.textContent = result.info.name;
    playlistName.title = result.info.name;
    totalTracks = result.tracks.length;
    unidentified = duplicates.unidentified;
    const resultSummary = summarize(totalTracks, duplicates.groups, unidentified);
    const coverage = duplicates.unidentified ?
      `\n${number(duplicates.unidentified)} ${duplicates.unidentified === 1 ? 'entry' : 'entries'} had no reliable song ID and ${duplicates.unidentified === 1 ? 'was' : 'were'} excluded from matching.` : '';
    const verification = result.countVerified ? '' : '\nAll API pages read; Apple supplied no total to independently verify the count.';
    const consistency = result.modificationChecked ?
      '\nModification markers matched, but Apple provides no atomic snapshot. Avoid editing the playlist during a scan.' :
      '\nApple supplied no modification marker. Same-count edits or reordering cannot be detected; scan again if you edited this playlist.';
    const notesText = (coverage + verification + consistency).trim();
    scanNotes = notesText;
    const hasGroups = duplicates.groups.length > 0;
    const scannedAt = Date.now();
    setStatus(hasGroups ? 'Scan complete' : duplicates.unidentified ?
      'No duplicates among identified songs' : 'No exact duplicates found',
      `${summaryLine(resultSummary)}${hasGroups ? '' : coverage + verification + consistency}\nScanned ${formatDate(scannedAt)}.`);
    // Only this completed, fully validated scan may replace the last success.
    applyCompleted({
      playlistName: result.info.name,
      scannedAt,
      groups: duplicates.groups,
      totalTracks,
      unidentified,
      notes: notesText,
      cached: false,
    });
    const saved = cacheCurrent(currentPlaylist, result.info, result.countVerified, result.modificationChecked, scannedAt);
    if (lastCompleted) lastCompleted.cached = saved;
  } catch (error) {
    // A failed or cancelled scan never replaces the last completed result. When
    // one exists, restore it and state plainly that it is not this scan's output.
    clearGroups();
    const cancelled = error instanceof ScanError && error.code === 'CANCELLED';
    scanFailed = !cancelled;
    const code = cancelled ? undefined : errorCode(error);
    if (lastCompleted) {
      const previous = lastCompleted;
      applyCompleted(previous);
      setStatus(cancelled ? 'Scan cancelled' : 'Scan failed',
        `${errorMessage(error)}\n${lastCompletedNotice(previous)}`, !cancelled, code);
    } else {
      setBadge(null);
      setStatus(cancelled ? 'Scan cancelled' : 'Scan failed', errorMessage(error), !cancelled, code);
    }
    if (error instanceof ScanError && ['PAGE_CHANGED', 'AUTH', 'MUSICKIT_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)) {
      source = null;
      currentPlaylist = null;
    }
  } finally {
    busy = false;
    scanController = null;
    cancel.hidden = true;
    scan.disabled = false;
    updateScanLabel();
    updatePopOut();
    progress.hidden = true;
  }
});

void initialize();
