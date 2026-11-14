import { createBrowserSource } from './browser-source';
import { findDuplicates } from './duplicates';
import { connectFailure, errorCode, errorMessage, errorRecovery, recoveryLabel, ScanError, type Recovery } from './errors';
import { readPlaylist, scanLimits, type PlaylistSource, type ScanProgress } from './playlist-reader';
import { detectPlaylist } from './playlist-url';
import { appleMusicId, csvFilename, exportLabels, formatGroupText, formatResultsText, lookalikeIdentities, outcomeTitle, positionParts, scanOutcome, splitPositions, summarize, summaryLine, toCsv, visibleGroups, type ResultSummary, type SortMode } from './results';
import { cacheFreshness, clearCachedScan, loadCachedScan, loadThemePreference, saveCachedScan, saveThemePreference, type CachedScan, type CacheFreshness } from './storage';
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
const statusProblem = element('status-problem');
const statusCode = element('status-code');
const results = element('results');
const list = element('duplicate-list');
const notes = element('scan-notes');
const progress = element<HTMLProgressElement>('scan-progress');
const showMore = element<HTMLButtonElement>('show-more');
const showAll = element<HTMLButtonElement>('show-all');
const resultsTitle = element('results-title');
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
// Show all stops here so one press cannot freeze the popup on the largest cached scan.
const showAllLimit = 2_000;
const maxInlinePositions = 50;
const copiedMs = 2_000;
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
// A popped-out window can stay open while the playlist is edited, so an old
// copy is not a valid "before" snapshot: past this age the scan refetches it.
let pendingInfo: PlaylistInfo | null = null;
let pendingInfoAt = 0;
const pendingInfoMaxAgeMs = 30_000;
let currentPlaylist: PlaylistRef | null = null;
let connectedTabId: number | null = null;
let currentPlaylistName = '';
let busy = false;
// How the last failure can be recovered from, straight from the error policy table.
let failure: Recovery | null = null;
// The playlist the popup currently describes; a pop-out compares it with its tab when it regains focus.
let shownPlaylistId: string | null = null;
let groups: DuplicateGroup[] = [];
let visible: DuplicateGroup[] = [];
let displayed = 0;
// Rows whose name and artist another row shares; computed once per scan, not per render.
let lookalikes = new Set<string>();
let totalTracks = 0;
let unidentified = 0;
let scanNotes = '';
let scanController: AbortController | null = null;
// Progress arrives once per page, so the text is rewritten at most this often.
const statusThrottleMs = 1_000;

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

/**
 * Badge count survives closing the popup, so it is the glanceable result. It is
 * scoped to the scanned tab: a global badge would label every other tab too.
 */
function setBadge(count: number | null): void {
  try {
    if (!chrome.action) return;
    const target = connectedTabId === null ? {} : { tabId: connectedTabId };
    // Fixed red: the badge text is white, and the dark-theme accent is too light for white text.
    void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: '#c7284e', ...target })).catch(() => {});
    void Promise.resolve(chrome.action.setBadgeText({ text: count === null ? '' : count > 999 ? '999+' : String(count), ...target }))
      .catch(() => {});
  } catch {
    // Decorative only; never let a badge failure affect a scan.
  }
}

/** What the one scan button says. Failures take their label from the error policy, never from the error code. */
function scanControl(hasSource: boolean, recovery: Recovery | null, hasResult: boolean): { label: string; hidden: boolean } {
  const retry = (kind: 'rescan' | 'reconnect') => ({ label: recoveryLabel[kind] ?? '', hidden: false });
  // Nothing on this page can fix a failure that needs a different page or cannot be fixed.
  if (recovery === 'navigate' || recovery === 'none') return { label: '', hidden: true };
  if (recovery === 'reconnect' || !hasSource) return retry('reconnect');
  if (recovery === 'rescan') return retry('rescan');
  return { label: hasResult ? 'Scan again' : 'Scan for duplicates', hidden: false };
}

function updateScanLabel(): void {
  const control = scanControl(source !== null, failure, lastCompleted !== null);
  scan.textContent = control.label;
  scan.hidden = control.hidden;
}

/** The popped-out window carries the tab it was opened from; the toolbar popup does not. */
function pinnedTabId(): number | null {
  const value = new URLSearchParams(location.search).get('tab');
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Only the pop-out has a real, resizable viewport; its CSS reflows down to 240px.
if (pinnedTabId() !== null) document.documentElement.dataset.window = 'pop-out';

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

interface StatusOptions {
  /** Error styling for the whole block. */
  error?: boolean;
  code?: string;
  /** A failure shown beside results that are still valid, so the title can stay neutral. */
  problem?: { message: string; error: boolean };
  /** Marks a progress update; repeats of the same phase are announced sparingly. */
  phase?: ScanProgress['phase'];
}

function setStatus(title: string, detail: string, { error = false, code, problem, phase }: StatusOptions = {}): void {
  // Assigning identical text still replaces the node and re-triggers a live
  // region announcement, so only write what actually changed.
  if (statusTitle.textContent !== title) statusTitle.textContent = title;
  if (statusDetail.textContent !== detail) statusDetail.textContent = detail;
  status.dataset.error = String(error);
  statusProblem.textContent = problem?.message ?? '';
  statusProblem.dataset.error = String(problem?.error ?? false);
  statusProblem.hidden = !problem;
  statusCode.textContent = code ? `Error code: ${code}` : '';
  statusCode.hidden = !code;
  announceStatus(phase ?? title, phase !== undefined,
    [title, detail, problem?.message ?? '', code ? `Error code ${code}` : ''].filter(Boolean).map(endSentence).join(' '));
}

/** Titles carry no final period and details do; a screen reader needs exactly one pause between them. */
function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

// Progress text changes every page, and a screen reader that repeats it is unusable.
// Every change of phase (or of title, for everything else) is announced at once;
// only repeated updates within one phase are held back.
const statusAnnounceIntervalMs = 20_000;
let lastAnnouncedKey = '';
let lastStatusAnnouncement = 0;
function announceStatus(key: string, repeatable: boolean, text: string): void {
  const now = Date.now();
  if (repeatable && key === lastAnnouncedKey && now - lastStatusAnnouncement < statusAnnounceIntervalMs) return;
  lastAnnouncedKey = key;
  lastStatusAnnouncement = now;
  if (statusAnnouncer.textContent !== text) statusAnnouncer.textContent = text;
}

function clearGroups(): void {
  groups = [];
  visible = [];
  displayed = 0;
  lookalikes = new Set();
  totalTracks = 0;
  unidentified = 0;
  scanNotes = '';
  list.replaceChildren();
  results.hidden = true;
  setResultsView(false);
  showMore.hidden = true;
  showAll.hidden = true;
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

/** Writes "#1 keep · #101 · #245"; the hidden label keeps the meaning for screen readers. */
function renderPositions(target: HTMLElement, group: DuplicateGroup, limit: number): void {
  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = 'Playlist positions: ';
  const parts = positionParts(group, limit);
  const keep = document.createElement('span');
  keep.className = 'keep';
  keep.textContent = parts.keep;
  const extras = document.createElement('span');
  extras.className = 'extras';
  extras.textContent = parts.extras;
  target.replaceChildren(label, keep, extras);
}

const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let announcedCopy = '';

/** The row's own button says it worked: feedback far above a long list would never be seen. */
function confirmRowCopy(button: HTMLButtonElement, ok: boolean, name: string): void {
  clearTimeout(copyTimers.get(button));
  button.textContent = ok ? 'Copied' : 'Failed';
  button.setAttribute('aria-label', ok ? `Copied ${name}` : `Copy failed: ${name}`);
  announcedCopy = ok ? `Copied ${name}.` : 'Copy failed. Use CSV instead.';
  resultsAnnouncer.textContent = announcedCopy;
  copyTimers.set(button, setTimeout(() => {
    button.textContent = 'Copy';
    button.setAttribute('aria-label', `Copy ${name}`);
    if (resultsAnnouncer.textContent === announcedCopy) resultsAnnouncer.textContent = '';
  }, copiedMs));
}

function buildGroup(group: DuplicateGroup): HTMLLIElement {
  const { extra } = splitPositions(group);
  const item = document.createElement('li');
  item.tabIndex = -1;
  const title = document.createElement('p');
  title.className = 'title';
  const song = document.createElement('span');
  song.className = 'song';
  // Let each name own its text direction; mixed-script titles then read in the
  // right order instead of inheriting the popup's left-to-right paragraph.
  song.dir = 'auto';
  // API-provided text is always text, never HTML.
  song.textContent = group.name;
  title.append(song);
  if (group.artist.trim()) {
    const artist = document.createElement('span');
    artist.className = 'artist';
    artist.dir = 'auto';
    artist.textContent = group.artist;
    title.append(artist);
  }
  item.append(title);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const counts = document.createElement('span');
  counts.className = 'counts';
  counts.textContent = `${number(group.copies)} copies · ${number(extra.length)} extra`;
  const positions = document.createElement('p');
  positions.className = 'positions';
  renderPositions(positions, group, maxInlinePositions);
  meta.append(counts, positions);
  item.append(meta);
  if (lookalikes.has(group.identity)) {
    const note = document.createElement('p');
    note.className = 'lookalike';
    note.textContent = `Different Apple Music song, same title · Apple Music ID ${appleMusicId(group)}`;
    item.append(note);
  }
  const name = group.artist.trim() ? `${group.name} by ${group.artist}` : group.name;
  if (group.positions.length > maxInlinePositions) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'more-positions';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `Show all ${number(group.positions.length)} positions`;
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? 'Show fewer positions' : `Show all ${number(group.positions.length)} positions`;
      if (expanded) {
        renderPositions(positions, group, Infinity);
        // Thousands of positions stay inside a short scroll area, and the
        // toggle keeps focus so a keyboard user can collapse it again.
        positions.tabIndex = 0;
        positions.setAttribute('role', 'group');
        positions.setAttribute('aria-label', `All playlist positions for ${name}`);
        positions.setAttribute('data-expanded', 'true');
      } else {
        renderPositions(positions, group, maxInlinePositions);
        positions.removeAttribute('tabindex');
        positions.removeAttribute('role');
        positions.removeAttribute('aria-label');
        positions.removeAttribute('data-expanded');
      }
    });
    item.append(toggle);
  }
  const copyGroup = document.createElement('button');
  copyGroup.type = 'button';
  copyGroup.className = 'copy-group';
  copyGroup.textContent = 'Copy';
  copyGroup.setAttribute('aria-label', `Copy ${name}`);
  copyGroup.addEventListener('click', async () => {
    confirmRowCopy(copyGroup, await copyText(formatGroupText(group)), name);
  });
  item.append(copyGroup);
  return item;
}

function updateResultsTitle(): void {
  const query = resultsSearch.value.trim();
  const minCopies = Number(resultsMin.value) || 2;
  const batching = displayed < visible.length;
  const count = number(visible.length);
  let text: string;
  if (query) {
    text = `Repeated songs · ${count} of ${number(groups.length)} matching`;
    if (batching) text += ` · ${number(displayed)} shown`;
  } else if (minCopies > 2) {
    text = `Repeated songs · ${count} of ${number(groups.length)} matching`;
    if (batching) text += ` · ${number(displayed)} shown`;
  } else {
    text = batching ?
      `Repeated songs · ${number(displayed)} of ${count} shown` :
      `Repeated songs · ${count}`;
  }
  if (resultsTitle.textContent !== text) resultsTitle.textContent = text;
}

/** The scope Copy and CSV export: every song matching the filters, not just the rows drawn. */
function updateExportLabels(): void {
  const labels = exportLabels(visible.length, visible.length < groups.length);
  copyResults.textContent = labels.copy;
  copyResults.setAttribute('aria-label', labels.copyName);
  downloadResults.textContent = labels.csv;
  downloadResults.setAttribute('aria-label', labels.csvName);
}

function appendBatch(count: number = batchSize): void {
  const end = Math.min(displayed + count, visible.length);
  list.append(...visible.slice(displayed, end).map(buildGroup));
  displayed = end;
  const remaining = visible.length - displayed;
  const nextBatch = Math.min(batchSize, remaining);
  showMore.hidden = remaining <= 0;
  showMore.textContent = `Show ${number(nextBatch)} more ${nextBatch === 1 ? 'song' : 'songs'}`;
  // One batch is what Show more already does, so a second button would only repeat it.
  showAll.hidden = remaining <= batchSize;
  const step = Math.min(remaining, showAllLimit);
  showAll.textContent = step === remaining ? `Show all ${number(visible.length)}` : `Show next ${number(step)}`;
  showAll.setAttribute('aria-label', `${showAll.textContent} repeated songs`);
  results.hidden = groups.length === 0;
  setResultsView(!results.hidden);
  resultsEmpty.hidden = visible.length !== 0;
  copyResults.disabled = visible.length === 0;
  downloadResults.disabled = visible.length === 0;
  updateExportLabels();
  updateResultsTitle();
}

function renderResults(): void {
  // Feedback about the last copy, download or reveal describes a list that no longer exists.
  resultsFeedback.textContent = '';
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
  notes.textContent = scanNotes;
  notes.hidden = !scanNotes;
  lookalikes = lookalikeIdentities(groups);
  setBadge(groups.length);
  renderResults();
  // An empty playlist leaves nothing to clear.
  clearResults.hidden = completed.totalTracks === 0;
}

/** Caveats the summary line does not already state. */
function scanNotesText(summary: ResultSummary, countVerified: boolean, modificationChecked: boolean): string {
  const lines: string[] = [];
  // With no repeats, the summary line already says how many songs were skipped.
  if (scanOutcome(summary) === 'duplicates' && summary.unidentified > 0) {
    const one = summary.unidentified === 1;
    lines.push(`${number(summary.unidentified)} ${one ? 'song had' : 'songs had'} no Apple Music ID and ${one ? 'was' : 'were'} skipped.`);
  }
  if (!countVerified) lines.push('Apple Music gave no song total, so the count could not be double-checked.');
  if (!modificationChecked) {
    lines.push('Apple Music did not say when this playlist last changed, so edits that keep the song count the same cannot be detected. Scan again after you edit it.');
  }
  return lines.join('\n');
}

function restoreCached(cached: CachedScan): CompletedScan {
  const completed: CompletedScan = {
    playlistName: cached.playlistName,
    scannedAt: cached.scannedAt,
    groups: cached.groups,
    totalTracks: cached.totalTracks,
    unidentified: cached.unidentified,
    // Rebuilt rather than read back, so a scan saved by an older version gets today's wording.
    notes: scanNotesText(summarize(cached.totalTracks, cached.groups, cached.unidentified), cached.countVerified, cached.modificationChecked),
    cached: true,
  };
  applyCompleted(completed);
  return completed;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const tooLargeToKeep = 'These results are too large to keep after closing. Use Copy all or CSV to save them.';

/** Explains that results on screen are the previous completed scan, never the failed one. */
function lastCompletedNotice(completed: CompletedScan): string {
  const persistence = completed.cached ? '' : `\n${tooLargeToKeep}`;
  return `Showing your last scan from ${formatDate(completed.scannedAt)}.${persistence}\n` +
    summaryLine(summarize(completed.totalTracks, completed.groups, completed.unidentified));
}

/** The summary and date of the scan on screen, when the title already says it is the last scan. */
function lastScanDetail(completed: CompletedScan): string {
  return `${summaryLine(summarize(completed.totalTracks, completed.groups, completed.unidentified))}\nScanned ${formatDate(completed.scannedAt)}.`;
}

const refreshAdvice: Record<CacheFreshness, string> = {
  current: 'Scan again to refresh.',
  changed: 'The playlist changed since this scan. Scan again to refresh.',
  unknown: 'Could not check whether the playlist changed since then.',
};

/** Connect-time states that are not errors: retrying cannot help, so they get a plain title and no scan button. */
const neutralConnectTitles: Readonly<Record<string, string | undefined>> = {
  NOT_PLAYLIST: 'Open a playlist',
  LIMIT: 'Playlist too large to scan',
  TAB_CLOSED: 'Apple Music tab closed',
};

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
  if (!saved) resultsFeedback.textContent = tooLargeToKeep;
  clearResults.hidden = totalTracks === 0 || (groups.length === 0 && !saved);
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

/**
 * A name cut off by its line clamp becomes a toggle. A mouse tooltip is not enough:
 * keyboard and touch users expand it with Enter, Space or a tap.
 */
function updateNameToggle(): void {
  if (playlistName.dataset.expanded === 'true') return;
  if (playlistName.scrollHeight > playlistName.clientHeight + 1) {
    playlistName.setAttribute('role', 'button');
    playlistName.tabIndex = 0;
    playlistName.setAttribute('aria-expanded', 'false');
  } else {
    playlistName.removeAttribute('role');
    playlistName.removeAttribute('tabindex');
    playlistName.removeAttribute('aria-expanded');
  }
}

function toggleName(): void {
  if (playlistName.getAttribute('role') !== 'button') return;
  const expanded = playlistName.dataset.expanded !== 'true';
  playlistName.dataset.expanded = String(expanded);
  playlistName.setAttribute('aria-expanded', String(expanded));
  if (!expanded) updateNameToggle();
}
playlistName.addEventListener('click', toggleName);
playlistName.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleName();
});
// A pop-out can be resized, which changes where the name is cut off.
window.addEventListener('resize', updateNameToggle);

function showPlaylistName(name: string, tooltip = ''): void {
  playlistName.textContent = name;
  playlistName.title = tooltip;
  delete playlistName.dataset.expanded;
  updateNameToggle();
}

// The sticky bar grows as its toolbar wraps in a narrow pop-out, so the room scrolling
// must leave above a focused row (scroll-padding-top in the CSS) follows its live height.
const resultsControls = element('results-controls');
function syncControlsHeight(): void {
  document.documentElement.style.setProperty('--controls-height', `${resultsControls.offsetHeight}px`);
}
new ResizeObserver(syncControlsHeight).observe(resultsControls);

/** With results on screen the header shrinks (see .has-results) so more rows fit. */
function setResultsView(shown: boolean): void {
  if (document.body.classList.contains('has-results') === shown) return;
  document.body.classList.toggle('has-results', shown);
  updateNameToggle();
}

/** Give focus back to the scan button, or to the status when a failure left no button to press. */
function focusScan(): void {
  if (!scan.hidden) { scan.focus(); return; }
  statusTitle.tabIndex = -1;
  statusTitle.focus();
}

async function initialize(): Promise<void> {
  // "Retry connection" disables the focused button; give focus back afterwards.
  const refocus = document.activeElement === scan;
  busy = true;
  failure = null;
  shownPlaylistId = null;
  // A new connection may target a different playlist; never carry the previous
  // playlist's results into it. A cache for this playlist is restored below.
  lastCompleted = null;
  currentPlaylistName = '';
  clearGroups();
  source = null;
  currentPlaylist = null;
  pendingInfo = null;
  scan.disabled = true;
  scan.hidden = false;
  scan.textContent = 'Connecting…';
  showPlaylistName('Detecting playlist…');
  setStatus('Connecting to Apple Music…', 'Checking the current playlist.');
  connectedTabId = null;
  updatePopOut();
  try {
    const pinned = pinnedTabId();
    let tab: chrome.tabs.Tab | undefined;
    if (pinned !== null) {
      try { tab = await chrome.tabs.get(pinned); } catch { throw new ScanError('TAB_CLOSED'); }
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (tab?.id === undefined) throw new Error('Tab unavailable');
    connectedTabId = tab.id;
    updatePopOut();
    const playlist = detectPlaylist(tab.url ?? '');
    shownPlaylistId = playlist.id;
    const candidate = createBrowserSource(tab.id, playlist);
    // A cached scan does not need the player, so paint it before the round trip:
    // a slow, signed-out or unreachable MusicKit must not hide existing results.
    const cached = loadCachedScan(playlist.id);
    if (cached) {
      const restored = restoreCached(cached);
      showPlaylistName(cached.playlistName, cached.playlistName);
      setStatus('Showing last scan', `${lastScanDetail(restored)} Checking Apple Music…`);
    } else {
      // The badge outlives the popup, so a different playlist must not inherit it.
      setBadge(null);
    }
    const info = await candidate.metadata();
    currentPlaylistName = info.name;
    showPlaylistName(info.name, info.name);
    // Fail here rather than on a scan that could only fail the same way.
    if (info.total !== null && info.total > scanLimits.maxTracks) throw new ScanError('LIMIT');
    pendingInfo = info;
    pendingInfoAt = Date.now();
    source = candidate;
    currentPlaylist = playlist;
    if (cached && lastCompleted) {
      setStatus('Showing last scan', `${lastScanDetail(lastCompleted)} ${refreshAdvice[cacheFreshness(cached, info)]}`);
    } else {
      // No cache, or the user cleared it while this connection was in flight:
      // neither case may claim to be showing a cached scan.
      setStatus('Ready to scan', 'Find songs listed more than once. Keep this open while scanning.');
    }
  } catch (error) {
    const { message, recovery } = connectFailure(error);
    const code = errorCode(error);
    const neutralTitle = neutralConnectTitles[code];
    failure = recovery;
    if (lastCompleted) {
      // The results on screen are still valid: say why they cannot be refreshed next to them.
      setStatus('Showing last scan', lastScanDetail(lastCompleted), { code, problem: { message, error: !neutralTitle } });
    } else {
      if (recovery === 'navigate') showPlaylistName('No playlist open');
      else if (!currentPlaylistName) showPlaylistName('Playlist unavailable');
      setStatus(neutralTitle ?? 'Could not connect', message, { error: !neutralTitle, code });
      setBadge(null);
    }
  } finally {
    busy = false;
    scan.disabled = false;
    updateScanLabel();
    updatePopOut();
    if (refocus) focusScan();
    replayRecheck();
  }
}

/**
 * A toolbar popup closes when the page changes, but a pop-out stays open, so it follows
 * its tab. tabs.onUpdated and onRemoved need no "tabs" permission: they report the move
 * (with the URL while activeTab holds, and without it after a cross-origin move, which
 * then reads as "not a playlist"). Reconnect when the playlist is no longer the one shown,
 * or when the last failure offered no retry (a playlist over the limit may have been trimmed).
 */
let recheckPending = false;
async function recheckPinnedTab(): Promise<void> {
  const pinned = pinnedTabId();
  if (pinned === null) return;
  if (busy) { recheckPending = true; return; }
  let current: string | null;
  try { current = detectPlaylist((await chrome.tabs.get(pinned)).url ?? '').id; } catch { current = null; }
  if (busy) { recheckPending = true; return; }
  if (current !== shownPlaylistId || failure === 'none') await initialize();
}

/** An event that arrived while connecting or scanning described the page before that work finished. */
function replayRecheck(): void {
  if (!recheckPending) return;
  recheckPending = false;
  void recheckPinnedTab();
}
const pinnedTab = pinnedTabId();
if (pinnedTab !== null) {
  // Apple Music navigates without reloading, so a URL change alone (no status) counts too.
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (tabId === pinnedTab && (change.status === 'complete' || (change.url !== undefined && change.status === undefined))) {
      void recheckPinnedTab();
    }
  });
  chrome.tabs.onRemoved?.addListener(tabId => { if (tabId === pinnedTab) void recheckPinnedTab(); });
}

/** Draw more rows and move focus to the first new one, so the revealing button can hide safely. */
function reveal(count: number): void {
  const firstNew = displayed;
  appendBatch(count);
  const first = list.children[firstNew] as HTMLElement | undefined;
  // The note joins the sticky bar; measure it before scrolling so the new row lands below the whole bar.
  resultsFeedback.textContent = `Showing ${number(displayed)} of ${number(visible.length)}.`;
  syncControlsHeight();
  first?.focus({ preventScroll: true });
  first?.scrollIntoView({ block: 'start' });
}

showMore.addEventListener('click', () => reveal(batchSize));
showAll.addEventListener('click', () => reveal(showAllLimit));

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
      // Blurring would drop focus onto the body; the heading keeps keyboard users in the results.
      resultsTitle.focus();
    }
  }
});

copyResults.addEventListener('click', async () => {
  const text = formatResultsText(currentPlaylistName || 'Current playlist', visible, summarize(totalTracks, visible, unidentified), scanNotes);
  if (await copyText(text)) {
    resultsFeedback.textContent = exportLabels(visible.length, visible.length < groups.length).copied;
  } else {
    resultsFeedback.textContent = 'Copy failed. Use CSV instead.';
  }
});

downloadResults.addEventListener('click', () => {
  downloadCsv();
  resultsFeedback.textContent = exportLabels(visible.length, visible.length < groups.length).downloaded;
});

clearResults.addEventListener('click', () => {
  clearCachedScan();
  lastCompleted = null;
  clearGroups();
  setBadge(null);
  // A failed rescan was about the scan being cleared; the button goes back to a first scan.
  if (failure === 'rescan') failure = null;
  updateScanLabel();
  setStatus('Results cleared', scan.hidden ? 'This playlist cannot be scanned from here.' :
    source ? 'Run a scan to find repeated songs again.' : `Press ${scan.textContent}, then scan again.`);
  // The button that had focus is now hidden; keep keyboard users in the popup.
  focusScan();
});

/** One progress report as status text. A retry says so, because the wait looks like a freeze. */
function progressStatus(event: ScanProgress, keepNote: string): { title: string; detail: string } {
  const count = event.total === null ? number(event.retrieved) : `${number(event.retrieved)} of ${number(event.total)}`;
  const retrieved = `${count} songs retrieved · ${Math.floor(event.elapsedMs / 1000)}s elapsed`;
  const keepOpen = `Keep this open while scanning.${keepNote}`;
  switch (event.phase) {
    case 'validating':
      return { title: 'Checking playlist…', detail: `${retrieved}\n${keepOpen}` };
    case 'retrying':
      return { title: 'Scanning playlist…',
        detail: `Apple Music is slow to respond. Retrying (${event.attempt} of ${event.attempts})…\n${retrieved}\n${keepOpen}` };
    case 'reading':
      return { title: 'Scanning playlist…', detail: `${retrieved}\n${keepOpen}` };
  }
}

scan.addEventListener('click', async () => {
  if (busy) return;
  if (!source || !currentPlaylist) { await initialize(); return; }
  busy = true;
  failure = null;
  const age = Date.now() - pendingInfoAt;
  const baselineInfo = pendingInfo && age >= 0 && age <= pendingInfoMaxAgeMs ? pendingInfo : undefined;
  pendingInfo = null;
  updatePopOut();
  const controller = new AbortController();
  scanController = controller;
  // Disabling the focused Scan button would drop keyboard focus onto the body.
  const focusCancel = document.activeElement === scan;
  cancel.hidden = false;
  scan.disabled = true;
  scan.textContent = 'Scanning…';
  if (focusCancel) cancel.focus();
  // The badge and the results on screen describe the last completed scan; keep
  // them (and the user's search/sort) until a new completed scan replaces them.
  // Clear stays unavailable so it cannot race the scan's own cache write.
  const showingPrevious = lastCompleted !== null;
  if (!showingPrevious) clearGroups();
  results.setAttribute('aria-busy', 'true');
  clearResults.disabled = true;
  resultsFeedback.textContent = '';
  const keepNote = showingPrevious ? '\nPrevious results stay visible until this scan completes.' : '';
  progress.hidden = false;
  progress.removeAttribute('value');
  setStatus('Scanning playlist…', `Connecting to Apple Music…${keepNote}`, { phase: 'reading' });
  // The first page shows at once; after that, steady reading updates are throttled.
  let lastReading = 0;
  try {
    const result = await readPlaylist(source, event => {
      const timestamp = Date.now();
      if (event.phase === 'reading' && lastReading > 0 && timestamp - lastReading < statusThrottleMs) return;
      lastReading = event.phase === 'reading' && event.retrieved > 0 ? timestamp : 0;
      // The bar moves with the text, so the two never disagree.
      if (event.total !== null && event.total > 0) {
        progress.max = event.total;
        progress.value = event.retrieved;
      } else progress.removeAttribute('value');
      const { title, detail } = progressStatus(event, keepNote);
      setStatus(title, detail, { phase: event.phase });
    }, { signal: controller.signal, ...(baselineInfo ? { info: baselineInfo } : {}) });
    const duplicates = findDuplicates(result.tracks);
    currentPlaylistName = result.info.name;
    showPlaylistName(result.info.name, result.info.name);
    totalTracks = result.tracks.length;
    unidentified = duplicates.unidentified;
    const resultSummary = summarize(totalTracks, duplicates.groups, unidentified);
    scanNotes = scanNotesText(resultSummary, result.countVerified, result.modificationChecked);
    // Without results on screen, the caveats have nowhere else to go.
    const notesInStatus = duplicates.groups.length === 0 && scanNotes ? `\n${scanNotes}` : '';
    const scannedAt = Date.now();
    // With a list below, the summary stays one line; the date is on the next visit's "last scan".
    const scannedLine = duplicates.groups.length === 0 ? `\nScanned ${formatDate(scannedAt)}.` : '';
    setStatus(outcomeTitle[scanOutcome(resultSummary)], `${summaryLine(resultSummary)}${notesInStatus}${scannedLine}`);
    // Only this completed, fully validated scan may replace the last success.
    applyCompleted({
      playlistName: result.info.name,
      scannedAt,
      groups: duplicates.groups,
      totalTracks,
      unidentified,
      notes: scanNotes,
      cached: false,
    });
    const saved = cacheCurrent(currentPlaylist, result.info, result.countVerified, result.modificationChecked, scannedAt);
    if (lastCompleted) lastCompleted.cached = saved;
  } catch (error) {
    // A failed or cancelled scan never replaces the last completed result. When
    // one exists, restore it and state plainly that it is not this scan's output.
    if (!lastCompleted) clearGroups();
    const cancelled = error instanceof ScanError && error.code === 'CANCELLED';
    const recovery = errorRecovery(error);
    // A cancel is the user's choice, not a failure: the ordinary scan button comes back.
    failure = cancelled ? null : recovery;
    const code = cancelled ? undefined : errorCode(error);
    if (lastCompleted) {
      const previous = lastCompleted;
      applyCompleted(previous);
      setStatus(cancelled ? 'Scan cancelled' : 'Scan failed',
        `${errorMessage(error)}\n${lastCompletedNotice(previous)}`, { error: !cancelled, code });
    } else {
      setBadge(null);
      setStatus(cancelled ? 'Scan cancelled' : 'Scan failed', errorMessage(error), { error: !cancelled, code });
    }
    if (recovery === 'reconnect') {
      source = null;
      currentPlaylist = null;
    }
  } finally {
    // Hiding the focused Cancel button would drop keyboard focus onto the body.
    const restoreFocus = document.activeElement === cancel || document.activeElement === scan;
    busy = false;
    scanController = null;
    cancel.hidden = true;
    scan.disabled = false;
    results.removeAttribute('aria-busy');
    clearResults.disabled = false;
    updateScanLabel();
    updatePopOut();
    progress.hidden = true;
    if (restoreFocus) focusScan();
    replayRecheck();
  }
});

void initialize();
