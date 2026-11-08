import { createBrowserSource } from './browser-source';
import { findDuplicates } from './duplicates';
import { errorCode, errorMessage, ScanError } from './errors';
import { readPlaylist, type PlaylistSource } from './playlist-reader';
import { detectPlaylist } from './playlist-url';
import { csvFilename, formatResultsText, summarize, summaryLine, toCsv, visibleGroups, type SortMode } from './results';
import { clearCachedScan, loadCachedScan, loadThemePreference, saveCachedScan, saveThemePreference, type CachedScan } from './storage';
import { nextTheme, themeLabel, type ThemePreference } from './theme';
import type { DuplicateGroup, PlaylistRef } from './types';

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
const copyResults = element<HTMLButtonElement>('copy-results');
const downloadResults = element<HTMLButtonElement>('download-results');
const clearResults = element<HTMLButtonElement>('clear-results');
const resultsFeedback = element('results-feedback');
const resultsEmpty = element('results-empty');
const version = element('version');
const themeToggle = element<HTMLButtonElement>('theme-toggle');
const number = (value: number): string => value.toLocaleString();
const batchSize = 50;
const maxInlinePositions = 50;
let source: PlaylistSource | null = null;
let currentPlaylist: PlaylistRef | null = null;
let currentPlaylistName = '';
let busy = false;
let scanFailed = false;
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

function setStatus(title: string, detail: string, error = false, code?: string): void {
  // Assigning identical text still replaces the node and re-triggers a live
  // region announcement, so only write what actually changed.
  if (statusTitle.textContent !== title) statusTitle.textContent = title;
  if (statusDetail.textContent !== detail) statusDetail.textContent = detail;
  status.dataset.error = String(error);
  statusCode.textContent = code ? `Error code: ${code}` : '';
  statusCode.hidden = !code;
  lastStatusWrite = Date.now();
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
  clearResults.hidden = true;
}

function currentGroups(): DuplicateGroup[] {
  const mode = resultsSort.value as SortMode;
  return visibleGroups(groups, resultsSearch.value, mode || 'playlist');
}

function appendGroup(group: DuplicateGroup): void {
  const item = document.createElement('li');
  item.tabIndex = -1;
  const fields = [
    ['song', group.name],
    ['artist', group.artist],
    ['counts', group.copies === 2 ? 'This song appears twice' : `This song appears ${number(group.copies)} times`],
  ];
  for (const [className, value] of fields) {
    const p = document.createElement('p');
    p.className = className!;
    // API-provided text is always text, never HTML.
    p.textContent = value!;
    item.append(p);
  }
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
    showAll.textContent = `Show all ${number(group.positions.length)} positions`;
    showAll.addEventListener('click', () => {
      positions.textContent = `Playlist positions: ${group.positions.map(number).join(', ')}`;
      showAll.remove();
    });
    item.append(showAll);
  }
  list.append(item);
}

function updateResultsTitle(): void {
  const title = element('results-title');
  const matching = resultsSearch.value.trim() ?
    ` · ${number(visible.length)} of ${number(groups.length)} matching` : '';
  title.textContent = displayed < visible.length ?
    `Repeated songs · ${number(displayed)} of ${number(visible.length)} shown${matching}` :
    `Repeated songs${matching}`;
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
}

function restoreCached(cached: CachedScan): void {
  groups = cached.groups;
  totalTracks = cached.totalTracks;
  unidentified = cached.unidentified;
  scanNotes = cached.notes;
  notes.textContent = scanNotes;
  notes.hidden = !scanNotes;
  renderResults();
  clearResults.hidden = false;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function cacheCurrent(playlist: PlaylistRef, infoName: string, countVerified: boolean, modificationChecked: boolean): boolean {
  const cached: CachedScan = {
    version: 1,
    playlistId: playlist.id,
    playlistName: infoName,
    scannedAt: Date.now(),
    groups,
    unidentified,
    totalTracks,
    countVerified,
    modificationChecked,
    notes: scanNotes,
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
  const blob = new Blob([toCsv(visible)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = csvFilename(currentPlaylistName || 'playlist');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function initialize(): Promise<void> {
  busy = true;
  scanFailed = false;
  source = null;
  currentPlaylist = null;
  scan.disabled = true;
  scan.textContent = 'Connecting…';
  playlistName.textContent = 'Detecting playlist…';
  playlistName.title = '';
  setStatus('Connecting to Apple Music…', 'Checking the current playlist.');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('Tab unavailable');
    const playlist = detectPlaylist(tab.url ?? '');
    const candidate = createBrowserSource(tab.id, playlist);
    const info = await candidate.metadata();
    source = candidate;
    currentPlaylist = playlist;
    currentPlaylistName = info.name;
    playlistName.textContent = info.name;
    playlistName.title = info.name;
    const cached = loadCachedScan(playlist.id);
    if (cached) {
      restoreCached(cached);
      setStatus('Showing last scan',
        `${summaryLine(summarize(cached.totalTracks, cached.groups, cached.unidentified))}\nCached ${formatDate(cached.scannedAt)}. Rescan to refresh.`);
    } else {
      setStatus('Ready to scan', 'Find songs listed more than once. Keep this popup open while scanning.');
    }
  } catch (error) {
    playlistName.textContent = 'Playlist unavailable';
    setStatus('Could not connect', errorMessage(error), true, errorCode(error));
  } finally {
    busy = false;
    scan.disabled = false;
    scan.textContent = source ? 'Scan for Duplicates' : 'Retry connection';
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

resultsSearch.addEventListener('input', () => {
  renderResults();
  resultsFeedback.textContent = visible.length ? '' : 'No matching songs.';
});
resultsSort.addEventListener('change', renderResults);

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
  clearGroups();
  setStatus('Results cleared', 'Run a scan to find repeated songs again.');
});

scan.addEventListener('click', async () => {
  if (busy) return;
  if (!source || !currentPlaylist) { await initialize(); return; }
  busy = true;
  scanFailed = false;
  const controller = new AbortController();
  scanController = controller;
  cancel.hidden = false;
  scan.disabled = true;
  scan.textContent = 'Scanning…';
  clearGroups();
  progress.hidden = false;
  progress.removeAttribute('value');
  setStatus('Scanning playlist…', 'Connecting to Apple Music…');
  // A live region announces every text mutation. Hold announcements while pages
  // stream in, then release them once the final state has been written.
  status.setAttribute('aria-busy', 'true');
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
    }, { signal: controller.signal });
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
    setStatus(hasGroups ? 'Scan complete' : duplicates.unidentified ?
      'No duplicates among identified songs' : 'No exact duplicates found',
      `${summaryLine(resultSummary)}${hasGroups ? '' : coverage + verification + consistency}`);
    notes.textContent = notesText;
    notes.hidden = !notesText;
    groups = duplicates.groups;
    renderResults();
    cacheCurrent(currentPlaylist, result.info.name, result.countVerified, result.modificationChecked);
  } catch (error) {
    clearGroups();
    const cancelled = error instanceof ScanError && error.code === 'CANCELLED';
    scanFailed = !cancelled;
    setStatus(cancelled ? 'Scan cancelled' : 'Scan failed',
      errorMessage(error), !cancelled, cancelled ? undefined : errorCode(error));
    if (error instanceof ScanError && ['PAGE_CHANGED', 'AUTH', 'MUSICKIT_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)) {
      source = null;
      currentPlaylist = null;
    }
  } finally {
    busy = false;
    scanController = null;
    cancel.hidden = true;
    scan.disabled = false;
    scan.textContent = source ? (scanFailed ? 'Retry scan' : 'Scan for Duplicates') : 'Retry connection';
    progress.hidden = true;
    status.setAttribute('aria-busy', 'false');
  }
});

void initialize();
