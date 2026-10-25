import { createBrowserSource } from './browser-source';
import { findDuplicates } from './duplicates';
import { errorMessage, ScanError } from './errors';
import { readPlaylist, type PlaylistSource } from './playlist-reader';
import { detectPlaylist } from './playlist-url';
import type { DuplicateGroup } from './types';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('Missing popup element');
  return found as T;
}
const scan = element<HTMLButtonElement>('scan');
const playlistName = element('playlist-name');
const status = element('status');
const statusTitle = element('status-title');
const statusDetail = element('status-detail');
const results = element('results');
const list = element('duplicate-list');
const scrollArea = element('results-scroll');
const notes = element('scan-notes');
const progress = element<HTMLProgressElement>('scan-progress');
const showMore = element<HTMLButtonElement>('show-more');
const number = (value: number): string => value.toLocaleString();
let source: PlaylistSource | null = null;
let busy = false;
const batchSize = 50;
let groups: DuplicateGroup[] = [];
let displayed = 0;

function setStatus(title: string, detail: string, error = false): void {
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  status.dataset.error = String(error);
}

function clearGroups(): void {
  groups = [];
  displayed = 0;
  list.replaceChildren();
  results.hidden = true;
  showMore.hidden = true;
  notes.hidden = true;
  notes.textContent = '';
}

function appendGroups(): void {
  const fragment = document.createDocumentFragment();
  const end = Math.min(displayed + batchSize, groups.length);
  for (const group of groups.slice(displayed, end)) {
    const item = document.createElement('li');
    const fields = [
      ['song', group.name],
      ['artist', group.artist],
      ['counts', group.copies === 2 ? 'This song appears twice' : `This song appears ${number(group.copies)} times`],
      ['positions', `Playlist positions: ${group.positions.map(number).join(', ')}`],
    ];
    for (const [className, value] of fields) {
      const p = document.createElement('p');
      p.className = className!;
      // API-provided text is always text, never HTML.
      p.textContent = value!;
      item.append(p);
    }
    fragment.append(item);
  }
  list.append(fragment);
  displayed = end;
  showMore.hidden = displayed === groups.length;
  showMore.textContent = `Show ${number(Math.min(batchSize, groups.length - displayed))} more songs`;
  element('results-title').textContent = displayed < groups.length ?
    `Repeated songs · ${number(displayed)} of ${number(groups.length)} shown` : 'Repeated songs';
  results.hidden = groups.length === 0;
}

async function initialize(): Promise<void> {
  busy = true;
  source = null;
  scan.disabled = true;
  scan.textContent = 'Connecting…';
  playlistName.textContent = 'Detecting playlist…';
  playlistName.title = '';
  setStatus('Connecting to Apple Music…', 'Checking the current playlist.');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const playlist = detectPlaylist(tab?.url ?? '');
    if (tab?.id === undefined) throw new Error('Tab unavailable');
    const candidate = createBrowserSource(tab.id, playlist);
    const info = await candidate.metadata();
    source = candidate;
    playlistName.textContent = info.name;
    playlistName.title = info.name;
    setStatus('Ready to scan', 'Find songs listed more than once. Keep this popup open while scanning.');
  } catch (error) {
    playlistName.textContent = 'Playlist unavailable';
    setStatus('Could not connect', errorMessage(error), true);
  } finally {
    busy = false;
    scan.disabled = false;
    scan.textContent = source ? 'Scan for Duplicates' : 'Retry connection';
  }
}

showMore.addEventListener('click', () => {
  const firstNew = displayed;
  appendGroups();
  // Keep keyboard users in the list when the last batch removes the button.
  scrollArea.focus({ preventScroll: true });
  list.children[firstNew]?.scrollIntoView({ block: 'start' });
});

scan.addEventListener('click', async () => {
  if (busy) return;
  if (!source) { await initialize(); return; }
  busy = true;
  scan.disabled = true;
  scan.textContent = 'Scanning…';
  clearGroups();
  progress.hidden = false;
  progress.removeAttribute('value');
  setStatus('Scanning playlist…', 'Connecting to Apple Music…');
  try {
    const result = await readPlaylist(source, ({ retrieved, total }) => {
      const count = total === null ? number(retrieved) : `${number(retrieved)} of ${number(total)}`;
      setStatus('Scanning playlist…', `${count} songs retrieved\nKeep this popup open while scanning.`);
      if (total !== null && total > 0) {
        progress.max = total;
        progress.value = retrieved;
      } else progress.removeAttribute('value');
    });
    const duplicates = findDuplicates(result.tracks);
    playlistName.textContent = result.info.name;
    playlistName.title = result.info.name;
    const summary = `${number(result.tracks.length)} songs scanned\n` +
      `${number(duplicates.groups.length)} ${duplicates.groups.length === 1 ? 'song appears' : 'songs appear'} more than once`;
    const coverage = duplicates.unidentified ?
      `\n${number(duplicates.unidentified)} ${duplicates.unidentified === 1 ? 'entry' : 'entries'} had no reliable song ID and ${duplicates.unidentified === 1 ? 'was' : 'were'} excluded from matching.` : '';
    const verification = result.countVerified ? '' : '\nAll API pages read; Apple supplied no total to independently verify the count.';
    const hasGroups = duplicates.groups.length > 0;
    setStatus(hasGroups ? 'Scan complete' : duplicates.unidentified ?
      'No duplicates among identified songs' : 'No exact duplicates found', summary + (hasGroups ? '' : coverage + verification));
    notes.textContent = (coverage + verification).trim();
    notes.hidden = !notes.textContent;
    groups = duplicates.groups;
    appendGroups();
  } catch (error) {
    setStatus('Scan failed', errorMessage(error), true);
    if (error instanceof ScanError && ['PAGE_CHANGED', 'AUTH', 'MUSICKIT_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)) {
      source = null;
    }
  } finally {
    busy = false;
    scan.disabled = false;
    scan.textContent = source ? 'Scan for Duplicates' : 'Retry connection';
    progress.hidden = true;
  }
});

void initialize();
