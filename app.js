/* ===================================================================
   NIMBUS · Premium Tasks & Notes — app.js  (Vanilla JS, ES6+)
   No frameworks. Source of truth: Neon Postgres (SQL over HTTPS).
   LocalStorage acts only as a disposable cache for instant startup
   and offline resilience; queued changes sync when back online.
   =================================================================== */
(() => {
'use strict';

/* ------------------------------------------------------------------ *
 *  0. Tiny utilities
 * ------------------------------------------------------------------ */
const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const escapeHtml = (s = '') => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function debounce(fn, wait = 200) {
  let t;
  const wrapped = function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
function throttle(fn, wait = 60) {
  let last = 0, queued; return function (...a) {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn.apply(this, a); }
    else { clearTimeout(queued); queued = setTimeout(() => { last = Date.now(); fn.apply(this, a); }, wait - (now - last)); }
  };
}

/* ----- date helpers (work in local time, store YYYY-MM-DD) ----- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const addDays = (str, n) => { const d = parseDate(str); d.setDate(d.getDate() + n); return ymd(d); };
function parseDate(str) { const [y, m, dd] = str.split('-').map(Number); return new Date(y, m - 1, dd); }
function relativeDate(str) {
  if (!str) return '';
  const t = todayStr();
  if (str === t) return 'Today';
  if (str === addDays(t, 1)) return 'Tomorrow';
  if (str === addDays(t, -1)) return 'Yesterday';
  const d = parseDate(str), now = parseDate(t);
  const diff = Math.round((d - now) / 864e5);
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; const hr = h % 12 || 12;
  return `${hr}:${pad(m)} ${ap}`;
}
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* absolute timestamp: "12 Jul 2026, 15:25" */
function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ----- fuzzy match: returns score (higher better) or -1 ----- */
function fuzzy(needle, haystack) {
  if (!needle) return 0;
  needle = needle.toLowerCase(); haystack = haystack.toLowerCase();
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);
  let n = 0, score = 0, gap = 0;
  for (let h = 0; h < haystack.length && n < needle.length; h++) {
    if (haystack[h] === needle[n]) { score += 5 - Math.min(gap, 4); n++; gap = 0; } else gap++;
  }
  return n === needle.length ? score : -1;
}
function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) + '<mark>' +
    escapeHtml(text.slice(i, i + query.length)) + '</mark>' + escapeHtml(text.slice(i + query.length));
}
/* DOMParser documents are inert: nothing loads or executes while parsing. */
const stripHtml = (html = '') => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};
/* Sanitize note HTML: drop active elements, on* handlers and javascript: URLs.
   Run on every save AND render so imported/legacy data is covered too. */
function sanitizeHtml(html = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('script, style, iframe, object, embed, link, meta, form').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((a) => {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    });
  });
  return doc.body.innerHTML;
}

/* ------------------------------------------------------------------ *
 *  1. State + persistence
 * ------------------------------------------------------------------ */
const STORAGE_KEY = 'nimbus.v1';
const ACCENTS = [
  { name: 'Indigo', hex: '#6366f1', rgb: '99, 102, 241' },
  { name: 'Violet', hex: '#8b5cf6', rgb: '139, 92, 246' },
  { name: 'Blue',   hex: '#3b82f6', rgb: '59, 130, 246' },
  { name: 'Teal',   hex: '#14b8a6', rgb: '20, 184, 166' },
  { name: 'Emerald',hex: '#10b981', rgb: '16, 185, 129' },
  { name: 'Amber',  hex: '#f59e0b', rgb: '245, 158, 11' },
  { name: 'Rose',   hex: '#f43f5e', rgb: '244, 63, 94' },
  { name: 'Pink',   hex: '#ec4899', rgb: '236, 72, 153' },
];

const SMART_LISTS = [
  { id: 'all',       label: 'All Tasks',  icon: '🗂️' },
  { id: 'today',     label: 'Today',      icon: '☀️' },
  { id: 'tomorrow',  label: 'Tomorrow',   icon: '🌅' },
  { id: 'upcoming',  label: 'Upcoming',   icon: '📆' },
  { id: 'important', label: 'Important',  icon: '🔥' },
  { id: 'starred',   label: 'Starred',    icon: '⭐' },
  { id: 'scheduled', label: 'Scheduled',  icon: '🕓' },
  { id: 'overdue',   label: 'Overdue',    icon: '⚠️' },
  { id: 'notes',     label: 'Notes',      icon: '📝' },
  { id: 'completed', label: 'Completed',  icon: '✅' },
  { id: 'archived',  label: 'Archived',   icon: '📥' },
  { id: 'trash',     label: 'Trash',      icon: '🗑️' },
];

const STATUS_COLS = [
  { id: 'todo',       label: 'To Do',       color: '#94a3b8' },
  { id: 'inprogress', label: 'In Progress', color: '#3b82f6' },
  { id: 'waiting',    label: 'Waiting',     color: '#f59e0b' },
  { id: 'done',       label: 'Completed',   color: '#22c55e' },
];

const FOLDER_ICONS = ['📁', '💼', '🏠', '🎯', '💡', '🚀', '📚', '🎨', '🛒', '💰', '❤️', '✈️'];
const FOLDER_COLORS = ['#6366f1', '#8b5cf6', '#3b82f6', '#14b8a6', '#10b981', '#f59e0b', '#f43f5e', '#ec4899'];

let state = null;

const defaultState = () => ({
  tasks: [],
  folders: [],
  settings: {
    theme: 'light', accent: '#6366f1', accentRgb: '99, 102, 241',
    sidebarWidth: 300, listWidth: 450, sidebarCollapsed: false,
    view: 'list', sort: 'manual', sortDir: 'asc', group: 'none',
    appName: 'Nimbus', name: 'Salman Haider', current: 'all',
    defaultFolderId: null,
    filters: {},
  },
});

/* Every task belongs to a folder. New/orphaned tasks land in the default
   folder (Settings); falls back to the first live folder if unset/invalid. */
function getDefaultFolderId() {
  const f = folderById(state.settings.defaultFolderId);
  if (f && !f.archived) return f.id;
  const first = state.folders.find((x) => !x.archived);
  return first ? first.id : null;
}
function enforceFolderRule() {
  const def = getDefaultFolderId();
  if (!def) return false;
  let changed = false;
  state.tasks.forEach((t) => { if (!t.folderId) { t.folderId = def; changed = true; } });
  return changed;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state = JSON.parse(raw); state.settings = Object.assign(defaultState().settings, state.settings); }
    else { state = defaultState(); seed(); }
  } catch (e) { state = defaultState(); seed(); }
}

/* save(): LocalStorage is only a disposable cache for instant startup.
   The source of truth is Neon — every save also queues a cloud push.
   `savePending` is set synchronously so sync polls can never slip into
   the debounce window and adopt remote state over in-flight edits. */
let savePending = false;
const _cacheWrite = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(VERSION_KEY, String(remoteVersion));
    localStorage.setItem(DIRTY_KEY, '1'); // cleared on successful push
  } catch (e) { /* cache write failure is non-fatal — Neon is the real store */ }
};
const _saveDebounced = debounce(() => {
  savePending = false;
  _cacheWrite();
  flashSaved();
  syncDirty = true;
  schedulePush();
}, 250);
function save() { savePending = true; _saveDebounced(); }

/* ------------------------------------------------------------------ *
 *  1b. Cloud persistence — Neon Postgres over SQL-per-HTTPS
 *  Single jsonb document in `workspace`, optimistic version checking.
 *  NOTE: Content-Type header must NOT be sent — Neon's CORS preflight
 *  does not allow it (the body is still JSON text).
 * ------------------------------------------------------------------ */
const VERSION_KEY = 'nimbus.v1.version';
const DIRTY_KEY = 'nimbus.v1.dirty'; // survives tab close: unpushed edits exist
const WORKSPACE_ID = 'default';
const NEON_URL = 'https://ep-floral-silence-aq649dvc-pooler.c-8.us-east-1.aws.neon.tech/sql';
const NEON_CONN = 'postgresql://neondb_owner:npg_4HpuQNDlAg8M@ep-floral-silence-aq649dvc-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require';

let remoteVersion = 0;    // version of the remote row our state is based on
let syncDirty = false;    // local changes not yet pushed
let syncInFlight = false;
let syncReady = false;    // blocks pushes until the initial pull settles
let syncRetryTimer = null;
let bootWasSeeded = false; // this boot generated demo data (safe to replace)
let overwriteAuthorized = false; // user explicitly chose "keep this device's data"

async function neonQuery(query, params = []) {
  const res = await fetch(NEON_URL, {
    method: 'POST',
    headers: { 'Neon-Connection-String': NEON_CONN },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) throw new Error('Neon HTTP ' + res.status + ' — ' + (await res.text()).slice(0, 300));
  return res.json();
}

const schedulePush = debounce(() => { pushToRemote(); }, 800);

/* 4xx from Neon = bad credentials/config, not a flaky network. Retrying
   cannot help; surface it clearly instead of pretending to be offline. */
let authErrorToasted = false;
function isAuthError(e) { return /Neon HTTP 4\d\d/.test(String(e && e.message)); }
function reportSyncError(e) {
  if (isAuthError(e)) {
    setSyncStatus('autherror');
    if (!authErrorToasted) {
      authErrorToasted = true;
      toast('Neon rejected the connection — update the connection string in app.js', 'error');
    }
    return true; // do not schedule retries
  }
  setSyncStatus('offline');
  return false;
}

async function pushToRemote() {
  if (!syncReady || syncInFlight || !syncDirty) return;
  syncInFlight = true; setSyncStatus('syncing');
  let pushSucceeded = false;
  try {
    const payload = JSON.stringify(state);
    let r = await neonQuery(
      'UPDATE workspace SET data=$1::jsonb, version=version+1, updated_at=now() WHERE id=$2 AND version=$3 RETURNING version',
      [payload, WORKSPACE_ID, remoteVersion]
    );
    if (!r.rows.length) {
      const cur = await neonQuery('SELECT version FROM workspace WHERE id=$1', [WORKSPACE_ID]);
      if (!cur.rows.length) {
        r = await neonQuery('INSERT INTO workspace (id, data, version) VALUES ($1, $2::jsonb, 1) RETURNING version', [WORKSPACE_ID, payload]);
      } else if (remoteVersion === 0 && !overwriteAuthorized) {
        // This device has NEVER seen the cloud state (e.g. its boot sync
        // failed) yet the cloud has data. Overwriting blind could destroy a
        // real workspace with a fresh demo seed — reconcile instead.
        syncInFlight = false;
        setSyncStatus('syncing');
        await syncFromRemote(true); // adopts the cloud, or asks the user
        return;
      } else {
        // Version conflict: another session wrote meanwhile. The active
        // editor's intent wins; stale sessions catch up via polling.
        r = await neonQuery('UPDATE workspace SET data=$1::jsonb, version=version+1, updated_at=now() WHERE id=$2 RETURNING version', [payload, WORKSPACE_ID]);
      }
    }
    remoteVersion = +r.rows[0].version;
    try {
      localStorage.setItem(VERSION_KEY, String(remoteVersion));
      localStorage.removeItem(DIRTY_KEY); // everything local is now in Neon
    } catch (e) {}
    syncDirty = false;
    pushSucceeded = true;
    overwriteAuthorized = false; // one-shot consent, consumed by this push
    setSyncStatus('synced');
  } catch (e) {
    const fatal = reportSyncError(e);
    if (!fatal) {
      clearTimeout(syncRetryTimer);
      syncRetryTimer = setTimeout(() => { if (syncDirty) pushToRemote(); }, 15000);
    }
  } finally {
    syncInFlight = false;
    // Reschedule only after a SUCCESSFUL push (edits arrived mid-flight).
    // After a failure the 15s backoff owns the retry — rescheduling here
    // would hammer Neon in a ~1s hot loop for as long as the failure lasts.
    if (pushSucceeded && syncDirty && syncReady) schedulePush();
  }
}

async function syncFromRemote(initial = false) {
  if (syncInFlight) return;
  if (!initial) {
    // Capture any keystrokes still sitting in the detail pane, then refuse
    // to pull while local edits are pending or a save debounce is running —
    // a poll must never adopt remote state over in-flight edits.
    flushDetailEdits();
    if (syncDirty || savePending) return;
  }
  try {
    // Step 1 — version-only probe (a few bytes of egress, nothing more).
    const vr = await neonQuery('SELECT version FROM workspace WHERE id=$1', [WORKSPACE_ID]);
    if (!vr.rows.length) {
      // Empty database: first ever run — migrate whatever we have locally.
      const ins = await neonQuery(
        'INSERT INTO workspace (id, data, version) VALUES ($1, $2::jsonb, 1) ON CONFLICT (id) DO NOTHING RETURNING version',
        [WORKSPACE_ID, JSON.stringify(state)]
      );
      if (ins.rows.length) {
        remoteVersion = 1; syncDirty = false;
        try { localStorage.setItem(VERSION_KEY, '1'); } catch (e) {}
        if (initial) toast('Workspace uploaded to Neon ☁️', 'success');
      }
    } else if (+vr.rows[0].version !== remoteVersion) {
      // Boot with unpushed local edits (tab was closed before the push
      // fired): keep local — the active editor's intent wins, same as the
      // live conflict policy. The finally block pushes it up.
      if (initial && syncDirty && remoteVersion > 0) {
        setSyncStatus('syncing');
        return;
      }
      // First-ever sync on a device that already holds real (non-demo) data
      // while the cloud also has data: never discard either side silently.
      if (initial && remoteVersion === 0 && !bootWasSeeded && state.tasks.length) {
        const useCloud = confirm(
          'A cloud workspace already exists in Neon.\n\n' +
          'OK — load the CLOUD data (replaces this device’s local data)\n' +
          'Cancel — keep THIS DEVICE’s data and overwrite the cloud'
        );
        if (!useCloud) {
          syncDirty = true; // push local up; version-conflict path overwrites
          overwriteAuthorized = true; // explicit user consent for the overwrite
          setSyncStatus('syncing');
          return;
        }
      }
      // Step 2 — version changed: now fetch the full document and adopt it.
      setSyncStatus('syncing');
      const r = await neonQuery('SELECT data, version FROM workspace WHERE id=$1', [WORKSPACE_ID]);
      if (r.rows.length) {
        const data = typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
        state = Object.assign(defaultState(), data);
        state.settings = Object.assign(defaultState().settings, data.settings);
        remoteVersion = +r.rows[0].version; syncDirty = false;
        // any save queued for the PRE-adoption state is now meaningless —
        // cancel it or it re-pushes identical data as a pointless version bump
        savePending = false; _saveDebounced.cancel();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          localStorage.setItem(VERSION_KEY, String(remoteVersion));
          localStorage.removeItem(DIRTY_KEY);
        } catch (e) {}
        hideContextMenu(); hidePopover(); // their targets no longer exist
        applyAll();
        if (!initial) toast('Updated from another session', 'info');
      }
    }
    setSyncStatus('synced');
  } catch (e) {
    reportSyncError(e);
  } finally {
    if (initial) {
      syncReady = true;
      if (syncDirty) schedulePush(); // offline boot: push once we're back
    }
  }
}

function setSyncStatus(s) {
  const chip = $('syncChip'); if (!chip) return;
  const map = {
    syncing: ['Syncing…', 'syncing'],
    synced: ['Synced', 'synced'],
    offline: ['Offline', 'offline'],
    autherror: ['Sync error', 'offline'],
  };
  const [label, cls] = map[s] || map.synced;
  chip.querySelector('.sync-label').textContent = label;
  chip.className = 'sync-chip ' + cls;
  chip.title = s === 'offline' ? 'Cannot reach Neon — changes are kept locally and retried automatically'
    : s === 'autherror' ? 'Neon rejected the credentials — update NEON_CONN in app.js'
    : 'Cloud sync: ' + label;
}

/* ----- undo / redo ----- */
const undoStack = [], redoStack = [];
function snapshot() { return JSON.stringify({ tasks: state.tasks, folders: state.folders }); }
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) { const s = JSON.parse(snap); state.tasks = s.tasks; state.folders = s.folders; }
function undo() {
  if (!undoStack.length) return toast('Nothing to undo', 'info');
  redoStack.push(snapshot()); restore(undoStack.pop());
  save(); renderAll(); toast('Undo', 'info');
}
function redo() {
  if (!redoStack.length) return toast('Nothing to redo', 'info');
  undoStack.push(snapshot()); restore(redoStack.pop());
  save(); renderAll(); toast('Redo', 'info');
}

/* ----- seed demo content ----- */
function seed() {
  bootWasSeeded = true; // demo content: cloud data may replace it without asking
  const t = todayStr();
  const fWork = { id: uid(), name: 'Work', color: '#6366f1', icon: '💼', parentId: null, order: 0, archived: false };
  const fPersonal = { id: uid(), name: 'Personal', color: '#10b981', icon: '🏠', parentId: null, order: 1, archived: false };
  const fSide = { id: uid(), name: 'Side Project', color: '#f59e0b', icon: '🚀', parentId: fWork.id, order: 0, archived: false };
  state.folders = [fWork, fPersonal, fSide];

  const mk = (o) => Object.assign({
    id: uid(), title: '', description: '', notes: '', subtasks: [], priority: 'none',
    tags: [], folderId: null, due: '', time: '', repeat: '',
    starred: false, pinned: false, completed: false, archived: false, trashed: false,
    status: 'todo', isNote: false, order: 0, comments: [], activity: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  }, o);

  state.tasks = [
    mk({ title: 'Finalize Q3 product roadmap', priority: 'high', folderId: fWork.id, due: t, time: '15:00',
        status: 'inprogress', starred: true, pinned: true, tags: ['planning', 'urgent'],
        notes: '<h2>Roadmap goals</h2><p>Align engineering and design on the <b>three core bets</b> for next quarter.</p><ul><li>Onboarding revamp</li><li>Collaboration features</li><li>Performance pass</li></ul>',
        subtasks: [{ id: uid(), text: 'Collect team input', done: true }, { id: uid(), text: 'Draft slide deck', done: true }, { id: uid(), text: 'Review with leadership', done: false }],
        activity: [{ ts: Date.now() - 36e5, text: 'Task created' }], }),
    mk({ title: 'Reply to design review comments', priority: 'medium', folderId: fWork.id, due: t, time: '11:00', status: 'todo', tags: ['design'] }),
    mk({ title: 'Grocery shopping', priority: 'low', folderId: fPersonal.id, due: addDays(t, 1), tags: ['errand'],
        subtasks: [{ id: uid(), text: 'Vegetables', done: false }, { id: uid(), text: 'Coffee beans', done: false }, { id: uid(), text: 'Olive oil', done: true }] }),
    mk({ title: 'Ship landing page v2', priority: 'high', folderId: fSide.id, due: addDays(t, 3), status: 'inprogress', starred: true, tags: ['launch'] }),
    mk({ title: 'Book dentist appointment', priority: 'medium', folderId: fPersonal.id, due: addDays(t, -1), tags: ['health'] }),
    mk({ title: 'Weekly team sync notes', isNote: true, folderId: fWork.id, tags: ['meeting'],
        notes: '<h1>Team Sync</h1><p>Discussed sprint progress and upcoming deadlines.</p><blockquote>Velocity is up 12% this sprint.</blockquote>' }),
    mk({ title: 'Read “Shape Up”', priority: 'low', folderId: fPersonal.id, due: addDays(t, 7), status: 'waiting', tags: ['reading'] }),
    mk({ title: 'Refactor auth module', priority: 'high', folderId: fSide.id, status: 'waiting', tags: ['engineering'],
        subtasks: [{ id: uid(), text: 'Audit endpoints', done: true }, { id: uid(), text: 'Token rotation', done: false }] }),
    mk({ title: 'Plan weekend hike', priority: 'low', folderId: fPersonal.id, due: addDays(t, 4), tags: ['fun'] }),
    mk({ title: 'Submit expense report', priority: 'medium', folderId: fWork.id, completed: true, status: 'done', due: addDays(t, -2) }),
    mk({ title: 'Renew domain name', priority: 'medium', folderId: fSide.id, due: addDays(t, 14) }),
    mk({ title: 'Brainstorm app ideas', isNote: true, folderId: fSide.id, tags: ['ideas'],
        notes: '<p>A few raw ideas worth exploring:</p><ul data-type="check"><li class="done">Habit tracker</li><li>Recipe organizer</li><li>Focus timer</li></ul>' }),
  ];
  state.tasks.forEach((tk, i) => tk.order = i);
  save();
}

/* ------------------------------------------------------------------ *
 *  2. Selectors / filtering / sorting / grouping
 * ------------------------------------------------------------------ */
const ui = { selected: null, multi: new Set(), search: '', cal: new Date(), collapsedGroups: new Set(), preTagList: null };

function visibleBase() { return state.tasks.filter((t) => !t.trashed); }

function matchesSmart(t, id) {
  const today = todayStr();
  switch (id) {
    case 'all':       return !t.archived && !t.isNote;
    case 'today':     return !t.archived && !t.completed && t.due === today;
    case 'tomorrow':  return !t.archived && !t.completed && t.due === addDays(today, 1);
    case 'upcoming':  return !t.archived && !t.completed && t.due && t.due > today;
    case 'important': return !t.archived && t.priority === 'high';
    case 'starred':   return !t.archived && t.starred;
    case 'scheduled': return !t.archived && !!t.due;
    case 'overdue':   return !t.archived && !t.completed && t.due && t.due < today;
    case 'notes':     return !t.archived && t.isNote;
    case 'completed': return !t.archived && t.completed;
    case 'archived':  return t.archived;
    case 'trash':     return false; // handled separately
    default: return true;
  }
}

function currentTasks() {
  const cur = state.settings.current;
  let list;
  if (ui.search) {
    // Global search across all live tasks and notes (not Trash / Archived),
    // regardless of where the user currently is. Results render in their own
    // dedicated view grouped by folder path (see renderSearchResults).
    const q = ui.search;
    list = visibleBase().filter((t) => !t.archived)
      .filter((t) => fuzzy(q, t.title) >= 0 || stripHtml(t.notes).toLowerCase().includes(q.toLowerCase())
        || t.tags.some((tg) => tg.toLowerCase().includes(q.toLowerCase()))
        || t.subtasks.some((s) => s.text.toLowerCase().includes(q.toLowerCase())));
  } else if (cur === 'trash') list = state.tasks.filter((t) => t.trashed);
  else if (cur.startsWith('folder:')) {
    const fid = cur.slice(7);
    list = visibleBase().filter((t) => t.folderId === fid && !t.archived);
  } else if (cur.startsWith('tag:')) {
    const tag = cur.slice(4);
    list = visibleBase().filter((t) => t.tags.includes(tag) && !t.archived);
  } else {
    list = visibleBase().filter((t) => matchesSmart(t, cur));
  }

  // filters
  const f = state.settings.filters || {};
  if (f.priority) list = list.filter((t) => t.priority === f.priority);
  if (f.status) list = list.filter((t) => t.status === f.status);
  if (f.starred) list = list.filter((t) => t.starred);
  if (f.completion === 'done') list = list.filter((t) => t.completed);
  if (f.completion === 'open') list = list.filter((t) => !t.completed);
  if (f.date === 'has') list = list.filter((t) => !!t.due);
  if (f.date === 'none') list = list.filter((t) => !t.due);

  return sortTasks(list);
}

function sortTasks(list) {
  const { sort, sortDir } = state.settings;
  const dir = sortDir === 'asc' ? 1 : -1;
  const arr = list.slice();
  const cmp = {
    manual: (a, b) => a.order - b.order,
    due: (a, b) => (a.due || '9999').localeCompare(b.due || '9999'),
    priority: (a, b) => prioRank(b.priority) - prioRank(a.priority),
    created: (a, b) => a.createdAt - b.createdAt,
    updated: (a, b) => a.updatedAt - b.updatedAt,
    alpha: (a, b) => a.title.localeCompare(b.title),
  }[sort] || ((a, b) => a.order - b.order);
  arr.sort((a, b) => {
    // pinned always first, completed always last — regardless of sort direction
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const r = cmp(a, b);
    return sort === 'manual' ? r : r * dir;
  });
  return arr;
}
const prioRank = (p) => ({ high: 3, medium: 2, low: 1, none: 0 }[p] || 0);

function groupTasks(list) {
  const g = state.settings.group;
  if (g === 'none') return [{ key: '', label: '', tasks: list }];
  const map = new Map();
  const keyOf = (t) => {
    if (g === 'priority') return t.priority;
    if (g === 'folder') return t.folderId || '_none';
    if (g === 'status') return t.status;
    if (g === 'due') {
      if (!t.due) return '_none';
      const tt = todayStr();
      if (t.due < tt) return 'overdue';
      if (t.due === tt) return 'today';
      if (t.due === addDays(tt, 1)) return 'tomorrow';
      if (t.due <= addDays(tt, 7)) return 'week';
      return 'later';
    }
    return '';
  };
  list.forEach((t) => { const k = keyOf(t); if (!map.has(k)) map.set(k, []); map.get(k).push(t); });
  const labelMap = {
    priority: { high: '🔴 High', medium: '🟠 Medium', low: '🔵 Low', none: '⚪ No priority' },
    status: Object.fromEntries(STATUS_COLS.map((c) => [c.id, c.label])),
    due: { overdue: '⚠️ Overdue', today: '☀️ Today', tomorrow: '🌅 Tomorrow', week: '📆 This week', later: '🗓️ Later', _none: 'No date' },
  };
  const order = {
    priority: ['high', 'medium', 'low', 'none'],
    status: ['todo', 'inprogress', 'waiting', 'done'],
    due: ['overdue', 'today', 'tomorrow', 'week', 'later', '_none'],
  };
  let keys = Array.from(map.keys());
  if (order[g]) keys.sort((a, b) => order[g].indexOf(a) - order[g].indexOf(b));
  return keys.map((k) => ({
    key: k,
    label: g === 'folder' ? (k === '_none' ? '📂 No folder' : folderById(k) ? `${folderById(k).icon} ${folderById(k).name}` : 'Folder') : (labelMap[g] ? labelMap[g][k] : k),
    tasks: map.get(k),
  }));
}

const folderById = (id) => state.folders.find((f) => f.id === id);
const taskById = (id) => state.tasks.find((t) => t.id === id);
function allTags() {
  const m = new Map();
  state.tasks.forEach((t) => { if (!t.trashed) t.tags.forEach((tg) => m.set(tg, (m.get(tg) || 0) + 1)); });
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}
function tagColor(tag) {
  let h = 0; for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}
function progressOf(t) {
  if (!t.subtasks.length) return t.completed ? 100 : 0;
  return Math.round(t.subtasks.filter((s) => s.done).length / t.subtasks.length * 100);
}

/* ------------------------------------------------------------------ *
 *  3. Mutations
 * ------------------------------------------------------------------ */
function touch(t) { t.updatedAt = Date.now(); }
function logActivity(t, text) {
  (t.activity = t.activity || []).unshift({ ts: Date.now(), text });
  if (t.activity.length > 30) t.activity.length = 30;
}

function addTask(props = {}, opts = {}) {
  pushHistory();
  const cur = state.settings.current;
  const base = {
    id: uid(), title: '', description: '', notes: '', subtasks: [], priority: 'none',
    tags: [], folderId: null, due: '', time: '', repeat: '',
    starred: false, pinned: false, completed: false, archived: false, trashed: false,
    status: 'todo', isNote: false, order: -Date.now(), comments: [], activity: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  // contextual defaults from current list
  if (cur === 'today') base.due = todayStr();
  else if (cur === 'tomorrow') base.due = addDays(todayStr(), 1);
  else if (cur === 'important') base.priority = 'high';
  else if (cur === 'starred') base.starred = true;
  else if (cur === 'notes') base.isNote = true;
  else if (cur.startsWith('folder:')) base.folderId = cur.slice(7);
  else if (cur.startsWith('tag:')) base.tags = [cur.slice(4)];
  const t = Object.assign(base, props);
  if (!t.folderId) t.folderId = getDefaultFolderId(); // every task belongs to a folder
  logActivity(t, 'Task created');
  state.tasks.unshift(t);
  save();
  if (opts.silent !== true) { renderAll(); }
  return t;
}

function deleteTask(id, hard = false) {
  const t = taskById(id); if (!t) return;
  pushHistory();
  if (hard || t.trashed) { state.tasks = state.tasks.filter((x) => x.id !== id); }
  else { t.trashed = true; touch(t); }
  if (ui.selected === id) closeDetail();
  ui.multi.delete(id);
  save();
}

function toggleComplete(id) {
  const t = taskById(id); if (!t) return;
  pushHistory();
  t.completed = !t.completed;
  t.status = t.completed ? 'done' : (t.status === 'done' ? 'todo' : t.status);
  if (t.completed && t.repeat) spawnRepeat(t);
  logActivity(t, t.completed ? 'Marked complete' : 'Reopened');
  touch(t); save();
}
function spawnRepeat(t) {
  if (!t.due) return;
  const map = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
  // Deep-clone: the new occurrence must not share tags/comments/subtask
  // array references with the original, or edits to one leak into all.
  const next = Object.assign(JSON.parse(JSON.stringify(t)), {
    id: uid(), completed: false, status: 'todo', trashed: false, archived: false,
    due: addDays(t.due, map[t.repeat] || 1), createdAt: Date.now(), updatedAt: Date.now(),
    activity: [{ ts: Date.now(), text: 'Recurring task created' }], order: -Date.now(),
    subtasks: t.subtasks.map((s) => ({ id: uid(), text: s.text, done: false })),
    comments: [],
  });
  state.tasks.unshift(next);
}

function duplicateTask(id) {
  const t = taskById(id); if (!t) return;
  pushHistory();
  const copy = Object.assign({}, JSON.parse(JSON.stringify(t)), {
    id: uid(), title: t.title + ' (copy)', completed: false, createdAt: Date.now(), updatedAt: Date.now(), order: -Date.now(),
    activity: [{ ts: Date.now(), text: 'Duplicated' }],
  });
  state.tasks.unshift(copy); save(); renderAll();
  toast('Task duplicated', 'success');
}

/* ------------------------------------------------------------------ *
 *  4. Rendering — orchestration
 * ------------------------------------------------------------------ */
function renderAll() {
  renderSidebar();
  renderHeader();
  renderView();
  renderMiniSummary();
  renderDetail();
}

/* ----- sidebar ----- */
function renderSidebar() {
  // smart lists
  const counts = smartCounts();
  $('smartLists').innerHTML = SMART_LISTS.map((l) => {
    const c = counts[l.id] || 0;
    const active = state.settings.current === l.id ? ' active' : '';
    return `<li class="nav-item${active}" data-nav="${l.id}" role="button" tabindex="0">
      <span class="nav-ico">${l.icon}</span><span class="nav-label">${l.label}</span>
      ${c ? `<span class="nav-badge">${c}</span>` : ''}</li>`;
  }).join('');

  // folders (with one level of nesting)
  const roots = state.folders.filter((f) => !f.parentId && !f.archived).sort((a, b) => a.order - b.order);
  let html = '';
  const renderF = (f, child) => {
    const c = visibleBase().filter((t) => t.folderId === f.id && !t.archived && !t.completed).length;
    const active = state.settings.current === 'folder:' + f.id ? ' active' : '';
    html += `<li class="nav-item${child ? ' folder-child' : ''}${active}" data-nav="folder:${f.id}" data-folder-drop="${f.id}" role="button" tabindex="0">
      <span class="folder-dot" style="background:${f.color}"></span>
      <span class="nav-ico">${f.icon}</span>
      <span class="nav-label">${escapeHtml(f.name)}</span>
      ${c ? `<span class="nav-badge">${c}</span>` : ''}
      <span class="row-actions">
        <button class="icon-btn tiny" data-folder-menu="${f.id}" title="More">⋯</button>
      </span></li>`;
    state.folders.filter((x) => x.parentId === f.id && !x.archived).sort((a, b) => a.order - b.order).forEach((ch) => renderF(ch, true));
  };
  roots.forEach((f) => renderF(f, false));
  $('folderList').innerHTML = html || '<li class="nav-item" style="color:var(--text-3);cursor:default">No folders yet</li>';

  // tags
  $('tagCloud').innerHTML = allTags().map(([tag, n]) => {
    const active = state.settings.current === 'tag:' + tag ? ' active' : '';
    return `<span class="tag-pill${active}" data-tag="${escapeHtml(tag)}"><span class="tdot" style="background:${tagColor(tag)}"></span>${escapeHtml(tag)} ${n}</span>`;
  }).join('') || '<span style="font-size:12px;color:var(--text-3);padding:0 8px">No tags</span>';

  $('profileName').textContent = state.settings.name;
  $('avatar').textContent = (state.settings.name[0] || 'U').toUpperCase();
  $('profileStreak').textContent = '🔥 ' + computeStreak();
  renderDefaultFolderSelect();
}

function renderDefaultFolderSelect() {
  const sel = $('settingDefaultFolder'); if (!sel) return;
  const fs = state.folders.filter((f) => !f.archived);
  const def = getDefaultFolderId();
  sel.innerHTML = fs.length
    ? fs.map((f) => `<option value="${f.id}"${def === f.id ? ' selected' : ''}>${f.icon} ${escapeHtml(f.name)}</option>`).join('')
    : '<option value="" disabled selected>No folders yet</option>';
}

function smartCounts() {
  const c = {};
  SMART_LISTS.forEach((l) => {
    if (l.id === 'trash') c[l.id] = state.tasks.filter((t) => t.trashed).length;
    else c[l.id] = visibleBase().filter((t) => matchesSmart(t, l.id) && (['completed', 'archived'].includes(l.id) ? true : !t.completed)).length;
  });
  // completed/archived show totals
  c.completed = visibleBase().filter((t) => matchesSmart(t, 'completed')).length;
  c.archived = visibleBase().filter((t) => matchesSmart(t, 'archived')).length;
  c.all = visibleBase().filter((t) => matchesSmart(t, 'all') && !t.completed).length;
  return c;
}

/* ----- header ----- */
function renderHeader() {
  const cur = state.settings.current;
  let title = 'Tasks', emoji = '🗂️';
  if (ui.search) { title = 'Search results'; emoji = '🔍'; }
  else if (cur.startsWith('folder:')) { const f = folderById(cur.slice(7)); if (f) { title = f.name; emoji = f.icon; } }
  else if (cur.startsWith('tag:')) { title = '#' + cur.slice(4); emoji = '🏷️'; }
  else { const l = SMART_LISTS.find((x) => x.id === cur); if (l) { title = l.label; emoji = l.icon; } }
  $('listTitle').textContent = title;
  $('listEmoji').textContent = emoji;
  $('listCount').textContent = currentTasks().length;
  $('emptyTrashBtn').hidden = !(cur === 'trash' && !ui.search && state.tasks.some((t) => t.trashed));
  $$('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.settings.view));
  renderFilterChips();
}

function renderFilterChips() {
  const f = state.settings.filters || {};
  const chips = [];
  const labels = { priority: 'Priority', status: 'Status', starred: 'Starred', completion: 'Completion', date: 'Date' };
  Object.entries(f).forEach(([k, v]) => { if (v) chips.push(`<span class="filter-chip">${labels[k] || k}: ${v === true ? 'yes' : v}<button data-rmfilter="${k}">✕</button></span>`); });
  const box = $('filterChips');
  if (chips.length) { box.hidden = false; box.innerHTML = chips.join('') + '<button class="filter-chip" data-rmfilter="*" style="cursor:pointer">Clear all</button>'; $('filterDot').hidden = false; }
  else { box.hidden = true; box.innerHTML = ''; $('filterDot').hidden = true; }
}

/* ----- views switcher ----- */
function renderView() {
  const map = { list: 'viewList', board: 'viewBoard', calendar: 'viewCalendar', timeline: 'viewTimeline', dashboard: 'viewDashboard' };
  Object.values(map).forEach((id) => $(id).hidden = true);
  renderBulkBar();
  // Active search takes over the middle pane with its own grouped view;
  // clearing the search restores whatever view/list the user was on.
  if (ui.search) { $('viewList').hidden = false; renderSearchResults(); return; }
  const v = state.settings.view;
  $(map[v]).hidden = false;
  if (v === 'list') renderList();
  else if (v === 'board') renderBoard();
  else if (v === 'calendar') renderCalendar();
  else if (v === 'timeline') renderTimeline();
  else if (v === 'dashboard') renderDashboard();
}

/* ----- dedicated search-results view, grouped by folder path ----- */
function folderPathLabel(fid) {
  const parts = [];
  let f = folderById(fid), guard = 0;
  while (f && guard++ < 10) { parts.unshift(`${f.icon} ${escapeHtml(f.name)}`); f = folderById(f.parentId); }
  return parts.join(' / ') || '📂 No folder';
}
function searchGroups(tasks) {
  // bucket by folder, label with the full nested path
  const buckets = new Map();
  tasks.forEach((t) => {
    const key = t.folderId || '_none';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  });
  return [...buckets.entries()]
    .map(([key, list]) => ({ key: 'search:' + key, label: folderPathLabel(key === '_none' ? null : key), tasks: list }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
function renderSearchResults() {
  const container = $('viewList');
  const scroll = $('listScroll');
  scroll.classList.remove('virtual');
  virtual = null;
  container.style.height = ''; container.style.position = '';
  const tasks = currentTasks();
  if (!tasks.length) { container.innerHTML = emptyStateHtml(); return; }
  let html = '';
  searchGroups(tasks).forEach((g) => {
    html += groupHeadHtml(g);
    if (!ui.collapsedGroups.has(g.key)) g.tasks.forEach((t) => { html += taskCardHtml(t); });
  });
  container.innerHTML = html;
}
/* Task ids in the order the user actually SEES them (search grouping or
   list grouping), skipping collapsed groups — keyboard nav follows this. */
function displayedTaskIds() {
  const tasks = currentTasks();
  if (ui.search) {
    return searchGroups(tasks).filter((g) => !ui.collapsedGroups.has(g.key)).flatMap((g) => g.tasks).map((t) => t.id);
  }
  if (state.settings.view === 'list' && state.settings.group !== 'none') {
    return groupTasks(tasks).filter((g) => !ui.collapsedGroups.has(g.key)).flatMap((g) => g.tasks).map((t) => t.id);
  }
  return tasks.map((t) => t.id);
}

/* ------------------------------------------------------------------ *
 *  5. LIST VIEW (with virtual rendering for big lists)
 * ------------------------------------------------------------------ */
let virtual = null;
function renderList() {
  const tasks = currentTasks();
  const container = $('viewList');
  const scroll = $('listScroll');

  if (!tasks.length) {
    virtual = null;
    container.style.height = '';
    container.innerHTML = emptyStateHtml();
    return;
  }

  const groups = groupTasks(tasks);

  // Build a flat row list (headers + tasks) for virtualization
  const rows = [];
  groups.forEach((g) => {
    if (g.label) rows.push({ type: 'head', g });
    const collapsed = ui.collapsedGroups.has(g.key);
    if (!collapsed) g.tasks.forEach((t) => rows.push({ type: 'task', t }));
  });

  const HEAD_H = 40, TASK_H = 112; // must match .list-scroll.virtual .task-card height + margins
  // Virtualize only when many rows
  if (rows.length > 80) {
    scroll.classList.add('virtual');
    const offsets = []; let total = 0;
    rows.forEach((r) => { offsets.push(total); total += r.type === 'head' ? HEAD_H : TASK_H; });
    container.style.height = total + 'px';
    container.style.position = 'relative';
    virtual = { rows, offsets, total, HEAD_H, TASK_H };
    paintVirtual();
    if (!scroll._vbound) { scroll.addEventListener('scroll', throttle(paintVirtual, 30)); scroll._vbound = true; }
  } else {
    scroll.classList.remove('virtual');
    virtual = null;
    container.style.height = '';
    container.style.position = '';
    let html = '';
    groups.forEach((g) => {
      if (g.label) html += groupHeadHtml(g);
      if (!ui.collapsedGroups.has(g.key)) g.tasks.forEach((t) => { html += taskCardHtml(t); });
    });
    container.innerHTML = html;
  }
}

function paintVirtual() {
  if (!virtual || state.settings.view !== 'list') return;
  const scroll = $('listScroll'), container = $('viewList');
  const top = scroll.scrollTop, vh = scroll.clientHeight;
  const { rows, offsets, HEAD_H, TASK_H } = virtual;
  const buffer = 600;
  let html = '';
  for (let i = 0; i < rows.length; i++) {
    const y = offsets[i];
    const h = rows[i].type === 'head' ? HEAD_H : TASK_H;
    if (y + h < top - buffer || y > top + vh + buffer) continue;
    const inner = rows[i].type === 'head' ? groupHeadHtml(rows[i].g, true) : taskCardHtml(rows[i].t, true);
    html += `<div style="position:absolute;top:${y}px;left:0;right:0;height:${h}px;padding:0 4px">${inner}</div>`;
  }
  container.innerHTML = html;
}

function groupHeadHtml(g, flat) {
  const collapsed = ui.collapsedGroups.has(g.key);
  return `<div class="group-head${collapsed ? ' group-collapsed' : ''}" data-group="${escapeHtml(g.key)}">
    <span class="gh-toggle">▼</span>${escapeHtml(g.label)} <span class="gh-count">${g.tasks.length}</span></div>`;
}

function emptyStateHtml() {
  const cur = state.settings.current;
  const msg = ui.search ? `No results for “${escapeHtml(ui.search)}”`
    : cur === 'trash' ? 'Trash is empty' : cur === 'completed' ? 'No completed tasks yet' : 'Nothing here yet';
  return `<div class="empty-state"><div class="empty-art">🌤️</div><h3>${msg}</h3>
    <p>${ui.search ? 'Try a different search term.' : 'Add a task using the bar above or press Ctrl+N.'}</p></div>`;
}

function taskCardHtml(t, virt) {
  const prog = progressOf(t);
  const stCount = t.subtasks.length;
  const stDone = t.subtasks.filter((s) => s.done).length;
  const preview = t.isNote ? stripHtml(t.notes) : (t.description || stripHtml(t.notes));
  const today = todayStr();
  let dueCls = '', dueTxt = '';
  if (t.due) {
    dueTxt = relativeDate(t.due) + (t.time ? ' · ' + fmtTime(t.time) : '');
    if (t.due < today && !t.completed) dueCls = ' overdue';
    else if (t.due === today) dueCls = ' due-today';
  }
  const sel = ui.selected === t.id ? ' selected' : '';
  const multi = ui.multi.has(t.id) ? ' multi-selected' : '';
  const titleHtml = ui.search ? highlight(t.title || 'Untitled', ui.search) : escapeHtml(t.title || 'Untitled');
  return `<div class="task-card prio-${t.priority}${t.completed ? ' completed' : ''}${t.pinned ? ' pinned' : ''}${sel}${multi}"
      data-id="${t.id}" draggable="true" role="listitem">
    <div class="task-check${t.completed ? ' checked' : ''}" data-check="${t.id}" title="Complete"></div>
    <div class="task-body">
      <div class="task-title-row">
        <span class="task-title">${titleHtml}</span>
        ${t.starred ? '<span class="task-star">★</span>' : ''}
        ${t.repeat ? '<span class="task-badge" title="Repeats">🔁</span>' : ''}
      </div>
      ${preview ? `<div class="task-preview">${escapeHtml(preview).slice(0, 120)}</div>` : ''}
      <div class="task-meta">
        ${dueTxt ? `<span class="task-badge${dueCls}">📅 ${dueTxt}</span>` : ''}
        ${stCount ? `<span class="task-progress-mini">☑ ${stDone}/${stCount}<span class="mini-bar"><i style="width:${prog}%"></i></span></span>` : ''}
        ${t.tags.slice(0, 3).map((tg) => `<span class="task-tag"><span class="tdot" style="background:${tagColor(tg)}"></span>${escapeHtml(tg)}</span>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ----- bulk bar ----- */
function renderBulkBar() {
  const bar = $('bulkBar');
  if (ui.multi.size && (state.settings.view === 'list' || ui.search)) { bar.hidden = false; $('bulkCount').textContent = ui.multi.size; }
  else bar.hidden = true;
}

/* ------------------------------------------------------------------ *
 *  6. KANBAN VIEW
 * ------------------------------------------------------------------ */
function renderBoard() {
  const tasks = currentTasks();
  const byStatus = {}; STATUS_COLS.forEach((c) => byStatus[c.id] = []);
  tasks.forEach((t) => { (byStatus[t.completed ? 'done' : t.status] || byStatus.todo).push(t); });
  $('viewBoard').innerHTML = `<div class="board">${STATUS_COLS.map((col) => `
    <div class="board-col" data-col="${col.id}">
      <div class="board-col-head"><span class="dot" style="background:${col.color}"></span>${col.label}
        <span class="col-count">${byStatus[col.id].length}</span></div>
      <div class="board-col-body" data-colbody="${col.id}">
        ${byStatus[col.id].map((t) => boardCardHtml(t)).join('') || '<div style="font-size:12px;color:var(--text-3);text-align:center;padding:12px">Drop tasks here</div>'}
      </div>
    </div>`).join('')}</div>`;
}
function boardCardHtml(t) {
  const stCount = t.subtasks.length, stDone = t.subtasks.filter((s) => s.done).length;
  return `<div class="board-card${t.completed ? ' done' : ''} prio-${t.priority}" data-id="${t.id}" data-board-card draggable="true">
    <div class="bc-title">${escapeHtml(t.title || 'Untitled')}</div>
    <div class="bc-meta">
      ${t.priority !== 'none' ? `<span class="task-badge">${{ high: '🔴', medium: '🟠', low: '🔵' }[t.priority]}</span>` : ''}
      ${t.due ? `<span class="task-badge">📅 ${relativeDate(t.due)}</span>` : ''}
      ${stCount ? `<span class="task-badge">☑ ${stDone}/${stCount}</span>` : ''}
      ${t.tags.slice(0, 2).map((tg) => `<span class="task-tag">${escapeHtml(tg)}</span>`).join('')}
    </div></div>`;
}

/* ------------------------------------------------------------------ *
 *  7. CALENDAR VIEW
 * ------------------------------------------------------------------ */
function renderCalendar() {
  const ref = ui.cal;
  const year = ref.getFullYear(), month = ref.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const today = todayStr();

  const byDate = {};
  visibleBase().filter((t) => t.due && !t.archived).forEach((t) => { (byDate[t.due] = byDate[t.due] || []).push(t); });

  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let cells = '';
  const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startDay + 1;
    const cellDate = new Date(year, month, dayNum);
    const ds = ymd(cellDate);
    const other = dayNum < 1 || dayNum > daysInMonth;
    const evs = byDate[ds] || [];
    cells += `<div class="cal-cell${other ? ' other-month' : ''}${ds === today ? ' today' : ''}" data-cal-date="${ds}">
      <span class="cal-date">${cellDate.getDate()}</span>
      ${evs.slice(0, 3).map((t) => `<div class="cal-event${t.completed ? ' done' : ''}" data-id="${t.id}" draggable="true" style="border-left-color:${t.priority === 'high' ? 'var(--prio-high)' : 'var(--accent)'}">${escapeHtml(t.title)}</div>`).join('')}
      ${evs.length > 3 ? `<span class="cal-more">+${evs.length - 3} more</span>` : ''}
    </div>`;
  }
  $('viewCalendar').innerHTML = `<div class="cal">
    <div class="cal-head"><h2>${monthName}</h2>
      <div class="cal-nav">
        <button class="icon-btn" data-cal-nav="-1">‹</button>
        <button class="btn" data-cal-nav="0">Today</button>
        <button class="icon-btn" data-cal-nav="1">›</button>
      </div></div>
    <div class="cal-grid">${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div></div>`;
}

/* ------------------------------------------------------------------ *
 *  8. TIMELINE VIEW
 * ------------------------------------------------------------------ */
function renderTimeline() {
  const tasks = currentTasks().filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due));
  if (!tasks.length) { $('viewTimeline').innerHTML = emptyStateHtml(); return; }
  const byDate = {};
  tasks.forEach((t) => { (byDate[t.due] = byDate[t.due] || []).push(t); });
  const dates = Object.keys(byDate).sort();
  $('viewTimeline').innerHTML = `<div class="timeline-view">${dates.map((d, i) => `
    <div class="tl-row">
      <div class="tl-rail"><div class="tl-dot" style="${d < todayStr() ? 'background:var(--prio-high)' : d === todayStr() ? '' : ''}"></div>${i < dates.length - 1 ? '<div class="tl-line"></div>' : ''}</div>
      <div class="tl-content">
        <div class="tl-date">${relativeDate(d)} · ${parseDate(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        ${byDate[d].map((t) => `<div class="tl-card prio-${t.priority}" data-id="${t.id}">
          <div class="task-title-row"><span class="task-title">${escapeHtml(t.title)}</span>${t.completed ? '<span class="task-badge">✓</span>' : ''}</div>
          <div class="task-meta">${t.time ? `<span class="task-badge">🕒 ${fmtTime(t.time)}</span>` : ''}${t.tags.map((tg) => `<span class="task-tag">${escapeHtml(tg)}</span>`).join('')}</div>
        </div>`).join('')}
      </div>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ *
 *  9. DASHBOARD VIEW (Canvas charts)
 * ------------------------------------------------------------------ */
function renderDashboard() {
  const all = visibleBase();
  const total = all.filter((t) => !t.isNote).length;
  const done = all.filter((t) => t.completed).length;
  const pending = all.filter((t) => !t.completed && !t.isNote).length;
  const overdue = all.filter((t) => !t.completed && t.due && t.due < todayStr()).length;
  const rate = total ? Math.round(done / total * 100) : 0;
  const streak = computeStreak();
  const weekDone = doneInRange(7), monthDone = doneInRange(30);

  $('viewDashboard').innerHTML = `<div class="dash">
    <div class="stat-grid">
      ${statCard('🗂️', total, 'Total tasks')}
      ${statCard('⏳', pending, 'Pending')}
      ${statCard('✅', done, 'Completed')}
      ${statCard('⚠️', overdue, 'Overdue')}
      ${statCard('📈', rate + '%', 'Completion rate')}
      ${statCard('🔥', streak, 'Day streak')}
      ${statCard('📅', weekDone, 'Done this week')}
      ${statCard('🗓️', monthDone, 'Done this month')}
    </div>
    <div class="dash-charts">
      <div class="chart-card"><h3>Last 7 days</h3><canvas id="chartWeek" height="180"></canvas></div>
      <div class="chart-card"><h3>By priority</h3><canvas id="chartPrio" height="180"></canvas></div>
      <div class="chart-card"><h3>Completion ring</h3><canvas id="chartRing" height="180"></canvas></div>
      <div class="chart-card"><h3>Tasks by folder</h3><canvas id="chartFolder" height="180"></canvas></div>
    </div>
  </div>`;
  requestAnimationFrame(() => { drawWeekChart(); drawPrioChart(); drawRingChart(rate); drawFolderChart(); });
}
function statCard(ico, val, label) {
  return `<div class="stat-card"><span class="sc-ico">${ico}</span><div class="sc-val">${val}</div><div class="sc-label">${label}</div></div>`;
}
function doneInRange(days) {
  const cutoff = Date.now() - days * 864e5;
  return state.tasks.filter((t) => t.completed && t.updatedAt >= cutoff).length;
}
function computeStreak() {
  const days = new Set(state.tasks.filter((t) => t.completed).map((t) => ymd(new Date(t.updatedAt))));
  let streak = 0, d = new Date();
  // allow today to be empty without breaking
  if (!days.has(ymd(d))) d.setDate(d.getDate() - 1);
  while (days.has(ymd(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

const accentVar = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';
const textVar = () => getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#888';
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.height;
  cv.width = w * dpr; cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  return { ctx, w, h };
}
function drawWeekChart() {
  const cv = $('chartWeek'); if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const labels = [], data = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
    const ds = ymd(d);
    data.push(state.tasks.filter((t) => t.completed && ymd(new Date(t.updatedAt)) === ds).length);
  }
  const max = Math.max(1, ...data), pad = 24, bw = (w - pad * 2) / 7;
  const ac = accentVar();
  let frame = 0;
  (function anim() {
    frame = Math.min(1, frame + 0.08);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    data.forEach((v, i) => {
      const bh = (v / max) * (h - 50) * frame;
      const x = pad + i * bw + bw * 0.2, y = h - 26 - bh, bwid = bw * 0.6;
      const grad = ctx.createLinearGradient(0, y, 0, h - 26);
      grad.addColorStop(0, ac); grad.addColorStop(1, ac + '55');
      ctx.fillStyle = grad; roundRect(ctx, x, y, bwid, bh, 6); ctx.fill();
      ctx.fillStyle = textVar(); ctx.fillText(labels[i], x + bwid / 2, h - 8);
      if (v) { ctx.fillStyle = ac; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText(v, x + bwid / 2, y - 5); ctx.font = '11px system-ui, sans-serif'; }
    });
    if (frame < 1) requestAnimationFrame(anim);
  })();
}
function drawPrioChart() {
  const cv = $('chartPrio'); if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const open = visibleBase().filter((t) => !t.completed && !t.isNote);
  const segs = [
    { v: open.filter((t) => t.priority === 'high').length, c: '#ef4444', l: 'High' },
    { v: open.filter((t) => t.priority === 'medium').length, c: '#f59e0b', l: 'Medium' },
    { v: open.filter((t) => t.priority === 'low').length, c: '#3b82f6', l: 'Low' },
    { v: open.filter((t) => t.priority === 'none').length, c: '#94a3b8', l: 'None' },
  ];
  const total = segs.reduce((s, x) => s + x.v, 0) || 1;
  const cx = h / 2 + 4, cy = h / 2, r = h / 2 - 16;
  let frame = 0;
  (function anim() {
    frame = Math.min(1, frame + 0.06);
    ctx.clearRect(0, 0, w, h);
    let a = -Math.PI / 2;
    segs.forEach((s) => {
      const ang = (s.v / total) * Math.PI * 2 * frame;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a + ang); ctx.closePath();
      ctx.fillStyle = s.c; ctx.fill(); a += ang;
    });
    // donut hole
    ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // legend
    ctx.textAlign = 'left'; ctx.font = '12px system-ui, sans-serif';
    segs.forEach((s, i) => { const ly = 24 + i * 22, lx = h + 16; ctx.fillStyle = s.c; roundRect(ctx, lx, ly - 9, 10, 10, 3); ctx.fill(); ctx.fillStyle = textVar(); ctx.fillText(`${s.l} · ${s.v}`, lx + 18, ly); });
    if (frame < 1) requestAnimationFrame(anim);
  })();
}
function drawRingChart(rate) {
  const cv = $('chartRing'); if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const cx = w / 2, cy = h / 2, r = h / 2 - 20, ac = accentVar();
  let frame = 0;
  (function anim() {
    frame = Math.min(1, frame + 0.05);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = textVar() + '33'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (rate / 100) * Math.PI * 2 * frame); ctx.strokeStyle = ac; ctx.stroke();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text'); ctx.textAlign = 'center'; ctx.font = '700 28px system-ui, sans-serif';
    ctx.fillText(Math.round(rate * frame) + '%', cx, cy + 6);
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = textVar(); ctx.fillText('completed', cx, cy + 26);
    if (frame < 1) requestAnimationFrame(anim);
  })();
}
function drawFolderChart() {
  const cv = $('chartFolder'); if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const data = state.folders.filter((f) => !f.archived).map((f) => ({
    l: f.name, c: f.color, v: visibleBase().filter((t) => t.folderId === f.id && !t.completed).length,
  })).filter((d) => d.v > 0).slice(0, 6);
  if (!data.length) { ctx.fillStyle = textVar(); ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No folder data', w / 2, h / 2); return; }
  const max = Math.max(1, ...data.map((d) => d.v)), rowH = Math.min(34, (h - 16) / data.length);
  let frame = 0;
  (function anim() {
    frame = Math.min(1, frame + 0.07);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left';
    data.forEach((d, i) => {
      const y = 12 + i * rowH, barMax = w - 130;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-2');
      ctx.fillText(d.l.slice(0, 12), 4, y + rowH / 2 + 2);
      ctx.fillStyle = textVar() + '22'; roundRect(ctx, 96, y + 4, barMax, rowH - 12, 6); ctx.fill();
      ctx.fillStyle = d.c; roundRect(ctx, 96, y + 4, barMax * (d.v / max) * frame, rowH - 12, 6); ctx.fill();
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-2'); ctx.textAlign = 'right';
      ctx.fillText(d.v, w - 6, y + rowH / 2 + 2); ctx.textAlign = 'left';
    });
    if (frame < 1) requestAnimationFrame(anim);
  })();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); if (w < 0) { x += w; w = -w; }
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* ----- mini summary ----- */
function renderMiniSummary() {
  const all = visibleBase().filter((t) => !t.isNote);
  const todays = all.filter((t) => t.due === todayStr());
  const done = todays.filter((t) => t.completed).length;
  const pending = todays.filter((t) => !t.completed).length;
  const allDone = all.filter((t) => t.completed).length;
  const pct = todays.length ? Math.round(done / todays.length * 100) : 0;
  $('statDone').textContent = done;
  $('statPending').textContent = pending;
  $('miniRingLabel').textContent = pct + '%';
  $('miniRing').style.strokeDashoffset = 100 - pct;
}

/* ------------------------------------------------------------------ *
 *  10. DETAIL PANE
 * ------------------------------------------------------------------ */
let detailTask = null;
// Write any pending (debounced) title/notes edits to the open task NOW,
// so switching tasks or closing the pane never drops the last keystrokes.
function flushDetailEdits() {
  if (!detailTask || $('detailContent').hidden) return;
  const t = taskById(detailTask.id); if (!t) return;
  const title = $('detailTitle').value;
  const notes = sanitizeHtml($('editor').innerHTML);
  let changed = false;
  if (t.title !== title) { t.title = title; changed = true; }
  if (t.notes !== notes) { t.notes = notes; changed = true; }
  if (changed) { touch(t); syncDirty = true; save(); } // dirty NOW: pulls must back off immediately
}
function openTask(id) {
  flushDetailEdits();
  ui.selected = id; detailTask = taskById(id);
  document.getElementById('app').classList.add('show-detail');
  renderDetail();
  $$('.task-card.selected').forEach((c) => c.classList.remove('selected'));
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (card) card.classList.add('selected');
}
function closeDetail() {
  flushDetailEdits();
  ui.selected = null; detailTask = null;
  document.getElementById('app').classList.remove('show-detail');
  $('detailContent').hidden = true; $('detailEmpty').hidden = false;
  $$('.task-card.selected').forEach((c) => c.classList.remove('selected'));
}

function renderDetail() {
  const t = detailTask && taskById(detailTask.id);
  if (!t) { $('detailContent').hidden = true; $('detailEmpty').hidden = false; return; }
  detailTask = t;
  $('detailEmpty').hidden = true; $('detailContent').hidden = false;

  $('detailTitle').value = t.title;
  $('detailCheck').classList.toggle('checked', t.completed);
  $('detailStar').textContent = t.starred ? '★' : '☆';
  $('detailStar').classList.toggle('on', t.starred);
  $('detailPin').classList.toggle('on', t.pinned);

  $('metaPriority').value = t.priority;
  $('metaStatus').value = t.status;
  $('metaDate').value = t.due || '';
  $('metaTime').value = t.time || '';
  $('metaRepeat').value = t.repeat || '';

  // folder select — every task belongs to a folder, so no "No folder" option
  const liveFolders = state.folders.filter((f) => !f.archived);
  const orphaned = t.folderId && !liveFolders.some((f) => f.id === t.folderId);
  const archivedHome = orphaned ? folderById(t.folderId) : null;
  $('metaFolder').innerHTML =
    (liveFolders.length === 0 ? '<option value="" selected disabled>No folders yet</option>' : '') +
    (archivedHome ? `<option value="${archivedHome.id}" selected>${archivedHome.icon} ${escapeHtml(archivedHome.name)} (archived)</option>` : '') +
    ((!t.folderId && liveFolders.length) ? '<option value="" selected disabled>Choose folder…</option>' : '') +
    liveFolders.map((f) => `<option value="${f.id}"${t.folderId === f.id ? ' selected' : ''}>${f.icon} ${escapeHtml(f.name)}</option>`).join('');

  renderTagEditor(t);
  renderSubtasks(t);

  // notes editor (avoid clobbering while typing)
  const ed = $('editor');
  if (document.activeElement !== ed) ed.innerHTML = sanitizeHtml(t.notes || '');

  renderActivity(t);
  renderComments(t);

  $('detailFoot').innerHTML = `<span>Created ${new Date(t.createdAt).toLocaleString()}</span><span>Updated ${timeAgo(t.updatedAt)}</span><span>ID ${t.id.slice(0, 6)}</span>`;
}

function renderTagEditor(t) {
  const box = $('metaTags');
  box.querySelectorAll('.tag-chip').forEach((c) => c.remove());
  const input = $('tagInput');
  t.tags.forEach((tg) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `<span class="tdot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${tagColor(tg)}"></span>${escapeHtml(tg)} <button data-rmtag="${escapeHtml(tg)}">✕</button>`;
    box.insertBefore(chip, input);
  });
}
function renderSubtasks(t) {
  const done = t.subtasks.filter((s) => s.done).length;
  $('subtaskProgress').textContent = t.subtasks.length ? `${done}/${t.subtasks.length}` : '';
  $('subtaskFill').style.width = progressOf(t) + '%';
  $('subtaskList').innerHTML = t.subtasks.map((s) => `
    <li class="subtask-item${s.done ? ' done' : ''}" data-sid="${s.id}">
      <span class="st-grip" title="Drag to reorder">⋮⋮</span>
      <span class="st-check${s.done ? ' checked' : ''}" data-st-check="${s.id}"></span>
      <span class="st-text" contenteditable="true" data-st-text="${s.id}">${escapeHtml(s.text)}</span>
      <button class="st-del" data-st-del="${s.id}" title="Delete">✕</button>
    </li>`).join('');
}
function renderActivity(t) {
  const acts = t.activity || []; // full history; the list scrolls past its height cap
  $('activityTimeline').innerHTML = acts.length ? acts.map((a) => `
    <li class="tl-event"><span class="tl-bullet"></span><div><div class="tl-text">${escapeHtml(a.text)}</div><div class="tl-time">${fmtDateTime(a.ts)}</div></div></li>`).join('')
    : '<li style="color:var(--text-3);font-size:12.5px">No activity yet</li>';
}
function renderComments(t) {
  const cs = t.comments || [];
  const cl = $('commentList');
  cl.innerHTML = cs.length ? cs.map((c) => `
    <li class="comment"><span class="c-avatar">${(state.settings.name[0] || 'U').toUpperCase()}</span>
      <div class="c-bubble">${escapeHtml(c.text)}<div class="c-time">${fmtDateTime(c.ts)}</div></div></li>`).join('')
    : '<li style="color:var(--text-3);font-size:12.5px;padding:4px">No comments yet. Start the conversation.</li>';
  cl.scrollTop = cl.scrollHeight; // newest comment stays visible past the height cap
}

/* ------------------------------------------------------------------ *
 *  11. Natural-language quick add
 * ------------------------------------------------------------------ */
function parseQuickAdd(raw) {
  let text = ' ' + raw + ' ';
  const out = { tags: [], priority: 'none', star: false, due: '', time: '', folderName: '' };

  // priority  !high / !! / !1
  text = text.replace(/\s!(high|h|3|!!)\b/gi, () => { out.priority = 'high'; return ' '; });
  text = text.replace(/\s!(medium|med|m|2|!)\b/gi, () => { out.priority = out.priority === 'none' ? 'medium' : out.priority; return ' '; });
  text = text.replace(/\s!(low|l|1)\b/gi, () => { out.priority = out.priority === 'none' ? 'low' : out.priority; return ' '; });

  // star
  text = text.replace(/\s\*\B|\s\*\s/g, () => { out.star = true; return ' '; });
  text = text.replace(/\sstar\b/gi, () => { out.star = true; return ' '; });

  // tags  #tag
  text = text.replace(/\s#([\w-]+)/g, (_, tag) => { const tg = tag.toLowerCase(); if (!out.tags.includes(tg)) out.tags.push(tg); return ' '; });

  // folder  @Name
  text = text.replace(/\s@([\w-]+)/g, (_, name) => { out.folderName = name; return ' '; });

  // time  5pm / 5:30pm / 17:00 / at 5
  const tm = text.match(/\b(?:at\s)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) {
    let hr = +tm[1], mn = tm[2] ? +tm[2] : 0;
    const ap = (tm[3] || '').toLowerCase();
    if (ap === 'pm' && hr < 12) hr += 12; if (ap === 'am' && hr === 12) hr = 0;
    if (hr < 24) { out.time = pad(hr) + ':' + pad(mn); text = text.replace(tm[0], ' '); }
  }

  // dates
  const t0 = todayStr();
  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  if (/\btoday\b/i.test(text)) { out.due = t0; text = text.replace(/\btoday\b/i, ' '); }
  else if (/\btomorrow\b/i.test(text)) { out.due = addDays(t0, 1); text = text.replace(/\btomorrow\b/i, ' '); }
  else if (/\bnext week\b/i.test(text)) { out.due = addDays(t0, 7); text = text.replace(/\bnext week\b/i, ' '); }
  else {
    const inDays = text.match(/\bin (\d{1,3}) days?\b/i);
    if (inDays) { out.due = addDays(t0, +inDays[1]); text = text.replace(inDays[0], ' '); }
    else {
      for (const [name, dow] of Object.entries(dayMap)) {
        const re = new RegExp('\\b' + name + '\\b', 'i');
        if (re.test(text)) {
          const now = new Date(); let diff = (dow - now.getDay() + 7) % 7; if (diff === 0) diff = 7;
          out.due = addDays(t0, diff); text = text.replace(re, ' '); break;
        }
      }
    }
  }

  out.title = text.replace(/\s+/g, ' ').trim();
  return out;
}

function submitQuickAdd() {
  const input = $('quickAddInput');
  const raw = input.value.trim();
  if (!raw) return;
  const p = parseQuickAdd(raw);
  const props = { title: p.title || raw, priority: p.priority, tags: p.tags, starred: p.star, due: p.due, time: p.time };
  if (p.folderName) {
    const f = state.folders.find((x) => x.name.toLowerCase() === p.folderName.toLowerCase());
    if (f) props.folderId = f.id;
  }
  if (qaPrio !== 'none') props.priority = props.priority === 'none' ? qaPrio : props.priority;
  const t = addTask(props);
  input.value = '';
  qaPrio = 'none'; $('qaPriority').dataset.prio = 'none';
  // Show the new task's details on the right, but keep typing focus here so
  // consecutive quick-adds flow. Skip on narrow layouts where the detail
  // pane is a fullscreen overlay that would cover the quick-add bar.
  if (window.matchMedia('(min-width: 1001px)').matches) {
    openTask(t.id);
    document.querySelector(`.task-card[data-id="${t.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    input.focus();
  }
  toast('Task added', 'success');
}
let qaPrio = 'none';

/* ------------------------------------------------------------------ *
 *  12. Rich editor commands
 * ------------------------------------------------------------------ */
const INLINE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'];
function editorEl() { return $('editor'); }
function selectionInsideEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  let n = sel.getRangeAt(0).commonAncestorContainer;
  while (n) { if (n === editorEl()) return true; n = n.parentNode; }
  return false;
}
function execEditor(cmd, val) {
  const ed = editorEl();
  // UI-only commands: leave the selection and document untouched
  if (cmd === 'colorPicker') { const p = $('colorPop'); $('bgPop').hidden = true; p.hidden = !p.hidden; return; }
  if (cmd === 'bgPicker') { const p = $('bgPop'); $('colorPop').hidden = true; p.hidden = !p.hidden; return; }
  if (cmd === 'formatPainter') { painterActive ? cancelPainter() : armPainter(); return; }

  ed.focus();
  // If the selection isn't inside the editor (e.g. nothing was ever placed), put caret at the end.
  if (!selectionInsideEditor()) placeCaretEnd(ed);

  if (cmd === 'inlineCode') { toggleInlineCode(); }
  else if (cmd === 'codeBlock') { toggleBlock('pre'); }
  else if (cmd === 'checkList') { insertCheckList(); }
  else if (cmd === 'createLink') { insertLink(); }
  else if (cmd === 'formatBlock') { toggleBlock(val); }
  else if (cmd === 'foreColor') {
    // "Default" strips the inline color so text inherits the theme color and
    // adapts when the theme changes; a real color is applied normally.
    if (val === '__default') clearForeColor();
    else document.execCommand('foreColor', false, val);
    hideColorPops();
  }
  else if (cmd === 'hiliteColor') {
    if (val === '__none') clearBackColor();
    else if (!document.execCommand('hiliteColor', false, val)) document.execCommand('backColor', false, val);
    hideColorPops();
  }
  else { document.execCommand(cmd, false, val || null); }

  saveNotes();
  updateToolbarState();
}

/* ----- text color popover + format painter ----- */
let painterActive = false, painterFmt = null;
function hideColorPop() { const p = $('colorPop'); if (p) p.hidden = true; }
function hideColorPops() { hideColorPop(); const b = $('bgPop'); if (b) b.hidden = true; }
// Remove inline background highlight from the selection (sentinel technique,
// same as clearForeColor: execCommand splits ancestor styling correctly).
function clearBackColor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  if (!document.execCommand('hiliteColor', false, 'rgb(1,2,3)')) document.execCommand('backColor', false, 'rgb(1,2,3)');
  const norm = (s) => (s || '').replace(/\s/g, '').toLowerCase();
  editorEl().querySelectorAll('[style]').forEach((el) => {
    if (norm(el.style.backgroundColor) === 'rgb(1,2,3)') {
      el.style.removeProperty('background-color');
      if (!el.getAttribute('style')) el.removeAttribute('style');
      if (el.tagName === 'SPAN' && !el.attributes.length) {
        const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el);
      }
    }
  });
}
// Remove inline foreground color from the selection so text inherits the theme.
// Let execCommand normalize the selection into a sentinel-colored span (it
// handles splitting ancestor <font>/color elements correctly), then unwrap
// exactly those sentinel wrappers — leaving the text with no inline color.
function clearForeColor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const SENTINEL_HEX = '#010203', SENTINEL_RGB = 'rgb(1,2,3)';
  document.execCommand('foreColor', false, SENTINEL_HEX);
  const norm = (s) => (s || '').replace(/\s/g, '').toLowerCase();
  const ed = editorEl();
  ed.querySelectorAll('font[color]').forEach((el) => {
    if (norm(el.getAttribute('color')) === SENTINEL_HEX) {
      const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el);
    }
  });
  ed.querySelectorAll('[style]').forEach((el) => {
    if (norm(el.style.color) === SENTINEL_HEX || norm(el.style.color) === SENTINEL_RGB) {
      el.style.removeProperty('color'); if (!el.getAttribute('style')) el.removeAttribute('style');
    }
  });
}
function armPainter() {
  if (!selectionInsideEditor()) { toast('Click into formatted text first, then the painter', 'info'); return; }
  painterFmt = {
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    strikeThrough: document.queryCommandState('strikeThrough'),
    color: document.queryCommandValue('foreColor'),
    code: !!ancestorTag('CODE'),
  };
  painterActive = true;
  editorEl().classList.add('painting');
  updateToolbarState();
}
function cancelPainter() {
  painterActive = false;
  editorEl().classList.remove('painting');
  updateToolbarState();
}
function applyPainter() {
  const f = painterFmt;
  if (!f) { cancelPainter(); return; }
  ['bold', 'italic', 'underline', 'strikeThrough'].forEach((c) => {
    let cur = false; try { cur = document.queryCommandState(c); } catch (e) {}
    if (cur !== f[c]) document.execCommand(c, false, null);
  });
  if (f.color) document.execCommand('foreColor', false, f.color);
  if (!!ancestorTag('CODE') !== f.code) toggleInlineCode();
  cancelPainter();
  saveNotes();
}
function placeCaretEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function currentBlock() {
  let b = '';
  try { b = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (e) {}
  return b;
}
// Toggle a block format on/off (clicking H1 again returns to a paragraph).
function toggleBlock(tag) {
  const target = currentBlock() === tag ? 'p' : tag;
  // Angle-bracket form is the most cross-browser-safe for formatBlock.
  document.execCommand('formatBlock', false, '<' + target + '>');
}
function ancestorTag(tagName) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let n = sel.getRangeAt(0).startContainer;
  while (n && n !== editorEl()) { if (n.nodeType === 1 && n.tagName === tagName) return n; n = n.parentNode; }
  return null;
}
function toggleInlineCode() {
  const codeEl = ancestorTag('CODE');
  if (codeEl) { // unwrap
    const parent = codeEl.parentNode;
    while (codeEl.firstChild) parent.insertBefore(codeEl.firstChild, codeEl);
    parent.removeChild(codeEl);
    return;
  }
  wrapInline('code');
}
function wrapInline(tag) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return; // need a selection to wrap
  const range = sel.getRangeAt(0);
  const el = document.createElement(tag);
  try { range.surroundContents(el); }
  catch (e) { el.appendChild(range.extractContents()); range.insertNode(el); }
  // keep the newly wrapped text selected so the state reflects correctly
  const r = document.createRange(); r.selectNodeContents(el);
  sel.removeAllRanges(); sel.addRange(r);
}
function insertLink() {
  const sel = window.getSelection();
  const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const url = prompt('Link URL:', 'https://');
  if (!url) return;
  // Restore the selection prompt() may have dropped, then apply.
  if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
  const href = /^(https?:|mailto:|#|\/)/i.test(url) ? url : 'https://' + url;
  if (!saved || saved.collapsed) {
    document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>&nbsp;`);
  } else {
    document.execCommand('createLink', false, href);
  }
}
function insertCheckList() {
  const ul = document.createElement('ul');
  ul.setAttribute('data-type', 'check');
  const li = document.createElement('li'); li.textContent = 'To-do item';
  ul.appendChild(li);
  const sel = window.getSelection();
  if (sel.rangeCount && selectionInsideEditor()) {
    const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(ul);
    const nr = document.createRange(); nr.selectNodeContents(li);
    sel.removeAllRanges(); sel.addRange(nr);
  } else { editorEl().appendChild(ul); }
}
function updateToolbarState() {
  const painterBtn = document.querySelector('#editorToolbar button[data-cmd="formatPainter"]');
  if (!selectionInsideEditor()) {
    $$('#editorToolbar button').forEach((b) => b.classList.remove('active'));
    if (painterBtn) painterBtn.classList.toggle('active', painterActive);
    return;
  }
  const block = currentBlock();
  const inCode = !!ancestorTag('CODE');
  const inLink = !!ancestorTag('A');
  $$('#editorToolbar button').forEach((b) => {
    const c = b.dataset.cmd, v = (b.dataset.val || '').toLowerCase();
    let on = false;
    try {
      if (INLINE_CMDS.includes(c)) on = document.queryCommandState(c);
      else if (c === 'formatBlock') on = block === v;
      else if (c === 'codeBlock') on = block === 'pre';
      else if (c === 'inlineCode') on = inCode;
      else if (c === 'createLink') on = inLink;
      else if (c === 'formatPainter') on = painterActive;
    } catch (e) {}
    b.classList.toggle('active', on);
  });
}
const saveNotes = debounce(() => {
  if (!detailTask) return;
  const t = taskById(detailTask.id); if (!t) return;
  t.notes = sanitizeHtml($('editor').innerHTML); touch(t); save();
  // refresh card preview without full rerender thrash
  const card = document.querySelector(`.task-card[data-id="${t.id}"] .task-preview`);
}, 400);

/* ------------------------------------------------------------------ *
 *  13. Toasts
 * ------------------------------------------------------------------ */
let lastDeleted = null;
function toast(msg, type = 'info', action) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const ico = { success: '✅', error: '⚠️', info: '💡' }[type] || '💡';
  el.innerHTML = `<span class="toast-ico">${ico}</span><span>${escapeHtml(msg)}</span>`;
  if (action) {
    const btn = document.createElement('button'); btn.className = 'toast-action'; btn.textContent = action.label;
    btn.onclick = () => { action.fn(); dismiss(); };
    el.appendChild(btn);
  }
  $('toastStack').appendChild(el);
  const dismiss = () => { el.classList.add('removing'); setTimeout(() => el.remove(), 300); };
  setTimeout(dismiss, action ? 6000 : 2600);
}
function flashSaved() {
  const pill = $('autosavePill'); if (!pill) return;
  pill.textContent = 'Saving…'; pill.classList.add('saving');
  clearTimeout(pill._t); pill._t = setTimeout(() => { pill.textContent = 'Saved'; pill.classList.remove('saving'); }, 400);
}

/* ------------------------------------------------------------------ *
 *  14. Context menu
 * ------------------------------------------------------------------ */
function showContextMenu(x, y, items) {
  const menu = $('contextMenu');
  menu.innerHTML = items.map((it) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    if (it.header) return `<div class="ctx-sub">${escapeHtml(it.header)}</div>`;
    return `<div class="ctx-item${it.danger ? ' danger' : ''}" data-ctx="${it.id}"><span class="ctx-ico">${it.ico || ''}</span>${escapeHtml(it.label)}${it.kbd ? `<span class="ctx-kbd"><kbd>${it.kbd}</kbd></span>` : ''}</div>`;
  }).join('');
  menu.hidden = false;
  menu.scrollTop = 0;
  menu.style.left = '0px'; menu.style.top = '0px';
  // offsetWidth/Height give the true layout size, unaffected by the popIn scale animation.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  // Keep the whole menu on screen; max-height in CSS caps it to the viewport so this always fits.
  menu.style.left = clamp(x, 6, window.innerWidth - w - 6) + 'px';
  menu.style.top = clamp(y, 6, window.innerHeight - h - 6) + 'px';
  menu._items = items;
}
function hideContextMenu() { $('contextMenu').hidden = true; }

function taskContextItems(t) {
  return [
    { id: 'open', ico: '↗️', label: 'Open' },
    { id: 'complete', ico: '✓', label: t.completed ? 'Mark incomplete' : 'Complete', kbd: 'Space' },
    { id: 'star', ico: '⭐', label: t.starred ? 'Unstar' : 'Star' },
    { id: 'pin', ico: '📌', label: t.pinned ? 'Unpin' : 'Pin' },
    { id: 'duplicate', ico: '⧉', label: 'Duplicate', kbd: '⌘D' },
    { sep: true },
    { header: 'Priority' },
    { id: 'prio-high', ico: '🔴', label: 'High' },
    { id: 'prio-medium', ico: '🟠', label: 'Medium' },
    { id: 'prio-low', ico: '🔵', label: 'Low' },
    { id: 'prio-none', ico: '⚪', label: 'None' },
    { sep: true },
    { id: 'archive', ico: '📥', label: t.archived ? 'Unarchive' : 'Archive' },
    { id: t.trashed ? 'restore' : 'delete', ico: '🗑', label: t.trashed ? 'Restore' : 'Delete', danger: !t.trashed, kbd: 'Del' },
  ];
}
function runTaskCtx(action, t) {
  switch (action) {
    case 'open': openTask(t.id); break;
    case 'complete': toggleComplete(t.id); renderAll(); break;
    case 'star': pushHistory(); t.starred = !t.starred; touch(t); save(); renderAll(); break;
    case 'pin': pushHistory(); t.pinned = !t.pinned; touch(t); save(); renderAll(); break;
    case 'duplicate': duplicateTask(t.id); break;
    case 'archive': pushHistory(); t.archived = !t.archived; logActivity(t, t.archived ? 'Archived' : 'Unarchived'); touch(t); save(); renderAll(); toast(t.archived ? 'Archived' : 'Unarchived', 'info'); break;
    case 'delete': removeWithUndo(t.id); break;
    case 'restore': pushHistory(); t.trashed = false; touch(t); save(); renderAll(); toast('Restored', 'success'); break;
    case 'prio-high': case 'prio-medium': case 'prio-low': case 'prio-none':
      pushHistory(); t.priority = action.slice(5); touch(t); save(); renderAll(); break;
  }
}
function removeWithUndo(id) {
  const t = taskById(id); if (!t) return;
  const wasTrashed = t.trashed; // already in Trash → this delete is permanent
  const snap = JSON.parse(JSON.stringify(t));
  deleteTask(id);
  renderAll();
  toast(wasTrashed ? 'Task permanently deleted' : 'Task moved to Trash', 'info',
    { label: 'Undo', fn: () => { const tk = taskById(id); if (tk) { tk.trashed = false; } else { state.tasks.unshift(snap); } save(); renderAll(); } });
}

/* ------------------------------------------------------------------ *
 *  15. Command palette
 * ------------------------------------------------------------------ */
const paletteState = { active: 0, items: [] };
function openPalette() {
  $('paletteOverlay').hidden = false;
  $('paletteInput').value = ''; $('paletteInput').focus();
  buildPalette('');
}
function closePalette() { closeOverlay($('paletteOverlay')); }
function paletteCommands() {
  const cmds = [
    { ico: '➕', label: 'New task', sub: 'Create a task', kbd: '⌘N', run: () => { closePalette(); newTask(); } },
    { ico: '📝', label: 'New note', sub: 'Create a note', run: () => { closePalette(); const t = addTask({ isNote: true, title: 'New note' }); openTask(t.id); $('detailTitle').focus(); } },
    { ico: '🔍', label: 'Search tasks', sub: 'Focus the search bar', kbd: '⌘F', run: () => { closePalette(); $('searchInput').focus(); } },
    { ico: '🌗', label: 'Toggle theme', sub: 'Light / Dark', run: () => { closePalette(); cycleTheme(); } },
    { ico: '☀️', label: 'Light theme', run: () => { closePalette(); setTheme('light'); } },
    { ico: '🌙', label: 'Dark theme', run: () => { closePalette(); setTheme('dark'); } },
    { ico: '🖥️', label: 'System theme', run: () => { closePalette(); setTheme('system'); } },
    { ico: '⚙️', label: 'Open settings', run: () => { closePalette(); openModal('settingsOverlay'); } },
    { ico: '⌨️', label: 'Keyboard shortcuts', run: () => { closePalette(); openModal('shortcutsOverlay'); } },
    { ico: '📁', label: 'New folder', run: () => { closePalette(); createFolder(); } },
    { ico: '☰', label: 'List view', run: () => { closePalette(); setView('list'); } },
    { ico: '▤', label: 'Board view', run: () => { closePalette(); setView('board'); } },
    { ico: '▦', label: 'Calendar view', run: () => { closePalette(); setView('calendar'); } },
    { ico: '📊', label: 'Dashboard', run: () => { closePalette(); setView('dashboard'); } },
  ];
  // navigation to lists
  SMART_LISTS.forEach((l) => cmds.push({ ico: l.icon, label: 'Go to ' + l.label, sub: 'Smart list', run: () => { closePalette(); navigate(l.id); } }));
  state.folders.filter((f) => !f.archived).forEach((f) => cmds.push({ ico: f.icon, label: 'Open ' + f.name, sub: 'Folder', run: () => { closePalette(); navigate('folder:' + f.id); } }));
  return cmds;
}
function buildPalette(q) {
  const cmds = paletteCommands();
  let items;
  if (!q) items = cmds.slice(0, 9).map((c) => ({ ...c, kind: 'cmd' }));
  else {
    const scored = cmds.map((c) => ({ c, s: fuzzy(q, c.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => ({ ...x.c, kind: 'cmd' }));
    // task results
    const tres = state.tasks.filter((t) => !t.trashed).map((t) => ({ t, s: Math.max(fuzzy(q, t.title), stripHtml(t.notes).toLowerCase().includes(q.toLowerCase()) ? 1 : -1) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6)
      .map((x) => ({ ico: x.t.isNote ? '📝' : '✓', label: x.t.title || 'Untitled', sub: 'Task' + (x.t.due ? ' · ' + relativeDate(x.t.due) : ''), kind: 'task', run: () => { closePalette(); openTask(x.t.id); } }));
    items = [...scored, ...tres];
  }
  paletteState.items = items; paletteState.active = 0;
  renderPalette(q);
}
function renderPalette(q) {
  const items = paletteState.items;
  if (!items.length) { $('paletteList').innerHTML = '<li class="palette-section">No matches</li>'; return; }
  let lastKind = '';
  $('paletteList').innerHTML = items.map((it, i) => {
    let head = '';
    if (it.kind !== lastKind) { head = `<li class="palette-section">${it.kind === 'task' ? 'Tasks' : 'Commands'}</li>`; lastKind = it.kind; }
    return head + `<li class="palette-item${i === paletteState.active ? ' active' : ''}" data-pi="${i}">
      <span class="pi-ico">${it.ico}</span>
      <span><div class="pi-label">${q ? highlight(it.label, q) : escapeHtml(it.label)}</div>${it.sub ? `<div class="pi-sub">${escapeHtml(it.sub)}</div>` : ''}</span>
      ${it.kbd ? `<span class="pi-kbd"><kbd>${it.kbd}</kbd></span>` : ''}</li>`;
  }).join('');
}
function movePalette(d) {
  if (!paletteState.items.length) return;
  paletteState.active = (paletteState.active + d + paletteState.items.length) % paletteState.items.length;
  renderPalette($('paletteInput').value);
  const act = $('paletteList').querySelector('.palette-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}
function runPalette() { const it = paletteState.items[paletteState.active]; if (it) it.run(); }

/* ------------------------------------------------------------------ *
 *  16. Themes
 * ------------------------------------------------------------------ */
let systemMq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const s = state.settings.theme;
  const dark = s === 'dark' || (s === 'system' && systemMq.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === s));
}
function setTheme(t) { state.settings.theme = t; save(); applyTheme(); if (state.settings.view === 'dashboard') renderDashboard(); }
function cycleTheme() { setTheme(state.settings.theme === 'dark' ? 'light' : 'dark'); toast(state.settings.theme === 'dark' ? 'Dark theme' : 'Light theme', 'info'); }
function applyAccent() {
  const a = ACCENTS.find((x) => x.hex === state.settings.accent) || ACCENTS[0];
  const root = document.documentElement.style;
  root.setProperty('--accent', a.hex);
  root.setProperty('--accent-rgb', a.rgb);
  root.setProperty('--accent-soft', `rgba(${a.rgb}, 0.12)`);
  root.setProperty('--accent-glow', `rgba(${a.rgb}, 0.35)`);
  $$('#accentRow .accent-dot').forEach((d) => d.classList.toggle('active', d.dataset.accent === a.hex));
}
systemMq.addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });

/* ------------------------------------------------------------------ *
 *  17. Folders
 * ------------------------------------------------------------------ */
function createFolder(parentId = null) {
  const name = (prompt('Folder name:') || '').trim();
  if (!name) return;
  pushHistory();
  const f = {
    id: uid(), name: name.trim(), parentId,
    color: FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length],
    icon: FOLDER_ICONS[state.folders.length % FOLDER_ICONS.length],
    order: state.folders.length, archived: false,
  };
  state.folders.push(f); save(); renderSidebar();
  toast('Folder created', 'success');
}
const COLOR_NAMES = { '#6366f1': 'Indigo', '#8b5cf6': 'Violet', '#3b82f6': 'Blue', '#14b8a6': 'Teal', '#10b981': 'Emerald', '#f59e0b': 'Amber', '#f43f5e': 'Rose', '#ec4899': 'Pink' };
function folderContextItems(f) {
  return [
    { id: 'rename', ico: '✏️', label: 'Rename' },
    { id: 'subfolder', ico: '📁', label: 'Add subfolder' },
    { header: 'Color' },
    ...FOLDER_COLORS.map((c) => ({ id: 'color:' + c, ico: `<span style="color:${c}">●</span>`, label: COLOR_NAMES[c] || c })),
    { header: 'Icon' },
    { id: 'icon', ico: '🎨', label: 'Change icon' },
    { sep: true },
    { id: 'archive', ico: '📥', label: f.archived ? 'Unarchive' : 'Archive' },
    { id: 'delete', ico: '🗑', label: 'Delete folder', danger: true },
  ];
}
function runFolderCtx(action, f) {
  if (action === 'rename') { const n = (prompt('Rename folder:', f.name) || '').trim(); if (n) { pushHistory(); f.name = n; save(); renderSidebar(); } }
  else if (action === 'subfolder') createFolder(f.id);
  else if (action.startsWith('color:')) { pushHistory(); f.color = action.slice(6); save(); renderSidebar(); }
  else if (action === 'icon') { const i = (prompt('Folder emoji:', f.icon) || '').trim(); if (i) { pushHistory(); f.icon = i; save(); renderSidebar(); } }
  else if (action === 'archive') { pushHistory(); f.archived = !f.archived; save(); renderSidebar(); }
  else if (action === 'delete') {
    if (!confirm(`Delete folder “${f.name}”? Subfolders are deleted too; their tasks move to your default folder.`)) return;
    pushHistory();
    // collect the folder plus ALL descendants (any depth)
    const doomed = new Set([f.id]);
    let grew = true;
    while (grew) {
      grew = false;
      state.folders.forEach((x) => { if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) { doomed.add(x.id); grew = true; } });
    }
    if (doomed.has(state.settings.defaultFolderId)) state.settings.defaultFolderId = null;
    state.folders = state.folders.filter((x) => !doomed.has(x.id)); // remove first: fallback must pick a survivor
    const fallback = getDefaultFolderId();
    state.tasks.forEach((t) => { if (doomed.has(t.folderId)) t.folderId = fallback; });
    const cur = state.settings.current;
    if (cur.startsWith('folder:') && doomed.has(cur.slice(7))) navigate('all');
    save(); renderAll(); toast('Folder deleted', 'info');
  }
}

/* ------------------------------------------------------------------ *
 *  18. Navigation / view / filters / sort
 * ------------------------------------------------------------------ */
function navigate(id) {
  state.settings.current = id;
  ui.multi.clear();
  $('listScroll').scrollTop = 0;
  save(); renderAll();
}
function setView(v) { state.settings.view = v; save(); renderHeader(); renderView(); }
function newTask() {
  const t = addTask({});
  openTask(t.id);
  document.querySelector(`.task-card[data-id="${t.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('detailTitle').focus(); $('detailTitle').select();
}

/* ----- sort / filter popovers ----- */
function showSortPopover(anchor) {
  const s = state.settings;
  const opts = [['manual', 'Manual'], ['due', 'Due date'], ['priority', 'Priority'], ['created', 'Created'], ['updated', 'Updated'], ['alpha', 'Alphabetical']];
  const groups = [['none', 'None'], ['priority', 'Priority'], ['due', 'Due date'], ['folder', 'Folder'], ['status', 'Status']];
  $('popover').innerHTML = `
    <div class="pop-group"><div class="pop-title">Sort by</div>${opts.map(([k, l]) => `<div class="pop-item${s.sort === k ? ' active' : ''}" data-sort="${k}">${l}<span class="check">✓</span></div>`).join('')}</div>
    <div class="pop-group"><div class="pop-title">Direction</div>
      <div class="pop-item${s.sortDir === 'asc' ? ' active' : ''}" data-dir="asc">Ascending<span class="check">✓</span></div>
      <div class="pop-item${s.sortDir === 'desc' ? ' active' : ''}" data-dir="desc">Descending<span class="check">✓</span></div></div>
    <div class="pop-group"><div class="pop-title">Group by</div>${groups.map(([k, l]) => `<div class="pop-item${s.group === k ? ' active' : ''}" data-group="${k}">${l}<span class="check">✓</span></div>`).join('')}</div>`;
  positionPopover(anchor);
}
function showFilterPopover(anchor) {
  const f = state.settings.filters || {};
  $('popover').innerHTML = `
    <div class="pop-group"><div class="pop-title">Priority</div>
      ${['high', 'medium', 'low'].map((p) => `<div class="pop-item${f.priority === p ? ' active' : ''}" data-filter="priority:${p}">${{ high: '🔴 High', medium: '🟠 Medium', low: '🔵 Low' }[p]}<span class="check">✓</span></div>`).join('')}</div>
    <div class="pop-group"><div class="pop-title">Status</div>
      ${STATUS_COLS.map((c) => `<div class="pop-item${f.status === c.id ? ' active' : ''}" data-filter="status:${c.id}">${c.label}<span class="check">✓</span></div>`).join('')}</div>
    <div class="pop-group"><div class="pop-title">Other</div>
      <div class="pop-item${f.starred ? ' active' : ''}" data-filter="starred:1">⭐ Starred<span class="check">✓</span></div>
      <div class="pop-item${f.completion === 'open' ? ' active' : ''}" data-filter="completion:open">Open only<span class="check">✓</span></div>
      <div class="pop-item${f.completion === 'done' ? ' active' : ''}" data-filter="completion:done">Completed only<span class="check">✓</span></div>
      <div class="pop-item${f.date === 'has' ? ' active' : ''}" data-filter="date:has">Has due date<span class="check">✓</span></div></div>
    <div class="pop-group"><div class="pop-item" data-filter="clear" style="color:var(--prio-high)">Clear filters</div></div>`;
  positionPopover(anchor);
}
function positionPopover(anchor) {
  const pop = $('popover'); pop.hidden = false; pop.scrollTop = 0;
  pop.style.left = '0px'; pop.style.top = '0px';
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight; // true size, ignores entrance animation
  pop.style.left = clamp(r.right - pw, 8, window.innerWidth - pw - 8) + 'px';
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) {
    const above = r.top - 6 - ph;                  // try flipping above the anchor
    top = above >= 8 ? above : clamp(top, 8, window.innerHeight - ph - 8);
  }
  pop.style.top = top + 'px';
}
function hidePopover() { $('popover').hidden = true; }

/* ------------------------------------------------------------------ *
 *  19. Drag and drop
 * ------------------------------------------------------------------ */
let dragId = null, dragKind = null;
function setupDnD() {
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card, .board-card, .cal-event');
    if (!card) return;
    dragId = card.dataset.id;
    dragKind = card.classList.contains('board-card') ? 'board' : card.classList.contains('cal-event') ? 'cal' : 'list';
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
  });
  document.addEventListener('dragend', (e) => {
    $$('.dragging').forEach((c) => c.classList.remove('dragging'));
    $$('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    dragId = null; dragKind = null;
  });
  document.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const col = e.target.closest('[data-colbody]');
    const navF = e.target.closest('[data-folder-drop]');
    const calCell = e.target.closest('[data-cal-date]');
    const card = e.target.closest('.task-card');
    if (col || navF || calCell || card) { e.preventDefault(); }
    $$('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    if (col) col.closest('.board-col').classList.add('drop-target');
    else if (navF) navF.classList.add('drop-target');
    else if (calCell) calCell.classList.add('drop-target');
  });
  document.addEventListener('drop', (e) => {
    if (!dragId) return;
    const t = taskById(dragId); if (!t) return;
    const col = e.target.closest('[data-colbody]');
    const navF = e.target.closest('[data-folder-drop]');
    const calCell = e.target.closest('[data-cal-date]');
    const card = e.target.closest('.task-card');
    if (col) { // board move
      e.preventDefault(); pushHistory();
      const status = col.dataset.colbody;
      const wasCompleted = t.completed;
      t.status = status; t.completed = status === 'done';
      if (!wasCompleted && t.completed && t.repeat) spawnRepeat(t);
      logActivity(t, 'Moved to ' + (STATUS_COLS.find((c) => c.id === status) || {}).label); touch(t); save(); renderView();
    } else if (navF) { // folder assign
      e.preventDefault(); pushHistory();
      t.folderId = navF.dataset.folderDrop; touch(t); save(); renderAll(); toast('Moved to folder', 'success');
    } else if (calCell) { // reschedule
      e.preventDefault(); pushHistory();
      t.due = calCell.dataset.calDate; touch(t); save(); renderAll(); toast('Rescheduled to ' + relativeDate(t.due), 'success');
    } else if (card && dragKind === 'list' && state.settings.sort === 'manual') { // reorder
      e.preventDefault();
      const targetId = card.dataset.id; if (targetId === dragId) return;
      pushHistory();
      const list = currentTasks();
      const ids = list.map((x) => x.id);
      const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      ids.forEach((id, i) => { const tk = taskById(id); if (tk) tk.order = i; });
      save(); renderList();
    }
  });
}

/* ------------------------------------------------------------------ *
 *  21. Settings / data import-export
 * ------------------------------------------------------------------ */
function openModal(id) { $(id).hidden = false; }
function closeOverlay(el) { el.classList.add('closing'); setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 200); }
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `nimbus-backup-${todayStr()}.json`; a.click();
  URL.revokeObjectURL(url); toast('Data exported', 'success');
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { const data = JSON.parse(reader.result); if (!data.tasks) throw 0;
      pushHistory(); state = Object.assign(defaultState(), data); state.settings = Object.assign(defaultState().settings, data.settings);
      enforceFolderRule();
      save(); applyAll(); toast('Data imported', 'success');
    } catch (e) { toast('Invalid file', 'error'); }
  };
  reader.readAsText(file);
}
function resetData() {
  if (!confirm('Reset everything? This cannot be undone.')) return;
  localStorage.removeItem(STORAGE_KEY); state = defaultState(); seed();
  applyAll(); toast('Workspace reset', 'info');
}

/* ------------------------------------------------------------------ *
 *  22. Sidebar collapse / resize
 * ------------------------------------------------------------------ */
function applySidebar() {
  document.documentElement.style.setProperty('--sidebar-w', state.settings.sidebarWidth + 'px');
  document.documentElement.style.setProperty('--list-w', (state.settings.listWidth || 450) + 'px');
  document.getElementById('app').classList.toggle('sidebar-collapsed', state.settings.sidebarCollapsed);
}
// Largest the list pane may grow while leaving the detail pane at least 360px.
function maxListWidth() {
  const effSidebar = state.settings.sidebarCollapsed ? 0 : state.settings.sidebarWidth;
  return Math.max(360, window.innerWidth - effSidebar - 360);
}
function bindResizer(rez, getStart, applyWidth, resetW) {
  if (!rez) return;
  rez.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = getStart();
    rez.classList.add('dragging');
    document.getElementById('app').classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    const move = (ev) => applyWidth(startW + ev.clientX - startX);
    const up = () => {
      rez.classList.remove('dragging');
      document.getElementById('app').classList.remove('resizing');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      save();
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  if (resetW != null) rez.addEventListener('dblclick', () => { applyWidth(resetW); save(); });
}
function setupResize() {
  bindResizer($('sidebarResizer'),
    () => state.settings.sidebarWidth,
    (w) => { state.settings.sidebarWidth = clamp(w, 240, 460); applySidebar(); }, 300);
  bindResizer($('listResizer'),
    () => state.settings.listWidth || 450,
    (w) => { state.settings.listWidth = clamp(w, 340, maxListWidth()); applySidebar(); }, 450);
}

/* ------------------------------------------------------------------ *
 *  23. Ripple micro-interaction
 * ------------------------------------------------------------------ */
function ripple(e, el) {
  const r = el.getBoundingClientRect();
  const span = document.createElement('span');
  span.className = 'ripple';
  const size = Math.max(r.width, r.height);
  span.style.width = span.style.height = size + 'px';
  span.style.left = (e.clientX - r.left - size / 2) + 'px';
  span.style.top = (e.clientY - r.top - size / 2) + 'px';
  el.appendChild(span); setTimeout(() => span.remove(), 600);
}

/* ------------------------------------------------------------------ *
 *  24. Wire up events
 * ------------------------------------------------------------------ */
function wire() {
  /* sidebar navigation (event delegation) */
  $('sidebar').addEventListener('click', (e) => {
    const fMenu = e.target.closest('[data-folder-menu]');
    if (fMenu) { e.stopPropagation(); const f = folderById(fMenu.dataset.folderMenu); const r = fMenu.getBoundingClientRect(); showContextMenu(r.left, r.bottom, folderContextItems(f)); $('contextMenu')._folder = f; return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { navigate(nav.dataset.nav); return; }
    const tag = e.target.closest('[data-tag]');
    if (tag) {
      const target = 'tag:' + tag.dataset.tag;
      if (state.settings.current === target) {
        // re-click on the active tag: toggle off, return to the pre-tag list
        navigate(ui.preTagList || 'all');
      } else {
        if (!state.settings.current.startsWith('tag:')) ui.preTagList = state.settings.current;
        navigate(target);
      }
      return;
    }
  });
  $('sidebar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const nav = e.target.closest('[data-nav]'); if (nav) navigate(nav.dataset.nav); }
  });
  $('addFolderBtn').addEventListener('click', () => createFolder());
  $('collapseBtn').addEventListener('click', () => { state.settings.sidebarCollapsed = true; save(); applySidebar(); });
  $('showSidebarBtn').addEventListener('click', () => { state.settings.sidebarCollapsed = false; save(); applySidebar(); });

  /* quick add */
  $('qaSubmit').addEventListener('click', submitQuickAdd);
  $('quickAddInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuickAdd(); });
  $('qaPriority').addEventListener('click', () => {
    const order = ['none', 'low', 'medium', 'high'];
    qaPrio = order[(order.indexOf(qaPrio) + 1) % order.length];
    $('qaPriority').dataset.prio = qaPrio;
  });

  /* search */
  const onSearch = debounce(() => { ui.search = $('searchInput').value.trim(); renderHeader(); renderView(); }, 180);
  $('searchInput').addEventListener('input', onSearch);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // don't let the global Esc close the detail pane too
      ui.search = ''; $('searchInput').value = ''; $('searchInput').blur();
      renderHeader(); renderView();
    }
  });

  /* empty trash */
  $('emptyTrashBtn').addEventListener('click', () => {
    const n = state.tasks.filter((t) => t.trashed).length;
    if (!n) return;
    if (!confirm(`Permanently delete ${n} task${n > 1 ? 's' : ''} in Trash? (Ctrl+Z can undo)`)) return;
    pushHistory();
    state.tasks = state.tasks.filter((t) => !t.trashed);
    ui.multi.clear();
    if (detailTask && !taskById(detailTask.id)) closeDetail();
    save(); renderAll();
    toast(`Trash emptied — ${n} task${n > 1 ? 's' : ''} permanently deleted`, 'info');
  });

  /* view switch */
  $('viewSwitch').addEventListener('click', (e) => { const b = e.target.closest('.view-btn'); if (b) setView(b.dataset.view); });
  $('sortBtn').addEventListener('click', (e) => { hidePopover(); showSortPopover(e.currentTarget); });
  $('filterBtn').addEventListener('click', (e) => { hidePopover(); showFilterPopover(e.currentTarget); });

  /* popover actions */
  $('popover').addEventListener('click', (e) => {
    const it = e.target.closest('.pop-item'); if (!it) return;
    const s = state.settings;
    if (it.dataset.sort) s.sort = it.dataset.sort;
    else if (it.dataset.dir) s.sortDir = it.dataset.dir;
    else if (it.dataset.group) s.group = it.dataset.group;
    else if (it.dataset.filter) {
      const fv = it.dataset.filter;
      if (fv === 'clear') s.filters = {};
      else { const [k, v] = fv.split(':'); s.filters = s.filters || {}; s.filters[k] = s.filters[k] === (v === '1' ? true : v) ? undefined : (v === '1' ? true : v); }
    }
    save(); renderHeader(); renderView();
    if (it.dataset.sort || it.dataset.dir || it.dataset.group) showSortPopover($('sortBtn')); else showFilterPopover($('filterBtn'));
  });

  /* filter chips remove */
  $('filterChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmfilter]'); if (!b) return;
    if (b.dataset.rmfilter === '*') state.settings.filters = {};
    else state.settings.filters[b.dataset.rmfilter] = undefined;
    save(); renderHeader(); renderView();
  });

  /* bulk bar */
  $('bulkBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    const act = b.dataset.bulk;
    if (act === 'clear') { ui.multi.clear(); renderAll(); return; }
    pushHistory();
    ui.multi.forEach((id) => { const t = taskById(id); if (!t) return;
      if (act === 'complete') {
        const wasCompleted = t.completed;
        t.completed = true; t.status = 'done';
        if (!wasCompleted && t.repeat) spawnRepeat(t);
      }
      else if (act === 'star') t.starred = true;
      else if (act === 'archive') t.archived = true;
      else if (act === 'delete') t.trashed = true;
      touch(t);
    });
    // close the detail pane if the task it shows was just trashed
    if (detailTask) { const dt = taskById(detailTask.id); if (!dt || dt.trashed) closeDetail(); }
    const n = ui.multi.size; ui.multi.clear(); save(); renderAll();
    toast(`${n} task${n > 1 ? 's' : ''} updated`, 'success');
  });

  /* ---- list / views click (delegation) ---- */
  $('listScroll').addEventListener('click', (e) => {
    const groupHead = e.target.closest('[data-group]');
    if (groupHead) {
      const k = groupHead.dataset.group;
      ui.collapsedGroups.has(k) ? ui.collapsedGroups.delete(k) : ui.collapsedGroups.add(k);
      ui.search ? renderSearchResults() : renderList();
      return;
    }

    const check = e.target.closest('[data-check]');
    if (check) { e.stopPropagation(); animateComplete(check); toggleComplete(check.dataset.check); renderAll(); return; }

    const card = e.target.closest('.task-card, .board-card, .tl-card, .cal-event');
    if (card && card.dataset.id) {
      if (e.metaKey || e.ctrlKey) { toggleMulti(card.dataset.id); return; }
      if (e.shiftKey && ui.selected) { rangeSelect(card.dataset.id); return; }
      if (ui.search) {
        // Search result clicked: dismiss the search, jump to the task's
        // folder, then open its details and reveal its card there.
        const id = card.dataset.id;
        const t = taskById(id);
        ui.search = ''; $('searchInput').value = '';
        const home = t && folderById(t.folderId);
        navigate(home && !home.archived ? 'folder:' + home.id : 'all');
        openTask(id);
        document.querySelector(`.task-card[data-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      openTask(card.dataset.id); return;
    }
    // calendar nav
    const cnav = e.target.closest('[data-cal-nav]');
    if (cnav) { const d = +cnav.dataset.calNav; if (d === 0) ui.cal = new Date(); else ui.cal.setMonth(ui.cal.getMonth() + d); renderCalendar(); }
  });

  /* double-click to inline edit title */
  $('listScroll').addEventListener('dblclick', (e) => {
    const title = e.target.closest('.task-title');
    const card = e.target.closest('.task-card');
    if (title && card) { e.preventDefault(); inlineEditTitle(card.dataset.id, title); }
  });

  /* right-click context menu */
  document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.task-card, .board-card, .tl-card');
    const folderItem = e.target.closest('[data-folder-drop]');
    if (card && card.dataset.id) {
      e.preventDefault(); const t = taskById(card.dataset.id);
      showContextMenu(e.clientX, e.clientY, taskContextItems(t)); $('contextMenu')._task = t; $('contextMenu')._folder = null;
    } else if (folderItem) {
      e.preventDefault(); const f = folderById(folderItem.dataset.folderDrop);
      showContextMenu(e.clientX, e.clientY, folderContextItems(f)); $('contextMenu')._folder = f; $('contextMenu')._task = null;
    }
  });
  $('contextMenu').addEventListener('click', (e) => {
    const it = e.target.closest('[data-ctx]'); if (!it) return;
    const menu = $('contextMenu');
    if (menu._task) runTaskCtx(it.dataset.ctx, menu._task);
    else if (menu._folder) runFolderCtx(it.dataset.ctx, menu._folder);
    hideContextMenu();
  });

  /* global click to dismiss popups + ripple */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#contextMenu')) hideContextMenu();
    if (!e.target.closest('#popover') && !e.target.closest('#sortBtn') && !e.target.closest('#filterBtn')) hidePopover();
    if (!e.target.closest('.tb-color-wrap')) hideColorPops();
    const rip = e.target.closest('.icon-btn, .btn, .qa-submit, .view-btn, .comment-send');
    if (rip) ripple(e, rip);
  });

  /* ---- detail pane ---- */
  $('detailClose').addEventListener('click', closeDetail);
  $('detailTitle').addEventListener('input', debounce(() => { if (!detailTask) return; const t = taskById(detailTask.id); t.title = $('detailTitle').value; touch(t); save(); patchCardTitle(t); }, 200));
  $('detailCheck').addEventListener('click', (e) => { if (!detailTask) return; animateComplete(e.currentTarget); toggleComplete(detailTask.id); renderAll(); });
  $('detailStar').addEventListener('click', () => { if (!detailTask) return; const t = taskById(detailTask.id); pushHistory(); t.starred = !t.starred; touch(t); save(); renderAll(); });
  $('detailPin').addEventListener('click', () => { if (!detailTask) return; const t = taskById(detailTask.id); pushHistory(); t.pinned = !t.pinned; touch(t); save(); renderAll(); });
  $('detailMore').addEventListener('click', (e) => { if (!detailTask) return; e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showContextMenu(r.right, r.bottom + 4, taskContextItems(taskById(detailTask.id))); $('contextMenu')._task = taskById(detailTask.id); $('contextMenu')._folder = null; });

  const metaChange = (key, prop, fn) => $(key).addEventListener('change', () => {
    if (!detailTask) return; const t = taskById(detailTask.id); pushHistory();
    const wasCompleted = t.completed;
    t[prop] = fn ? fn($(key).value) : $(key).value; touch(t);
    if (prop === 'status') {
      t.completed = t.status === 'done';
      if (!wasCompleted && t.completed && t.repeat) spawnRepeat(t);
    }
    logActivity(t, 'Updated ' + prop); save(); renderAll();
  });
  metaChange('metaPriority', 'priority'); metaChange('metaStatus', 'status');
  metaChange('metaDate', 'due'); metaChange('metaTime', 'time');
  metaChange('metaRepeat', 'repeat');
  metaChange('metaFolder', 'folderId', (v) => v || null);

  /* tags */
  $('tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('tagInput').value.trim()) {
      const t = taskById(detailTask.id); const tag = $('tagInput').value.trim().toLowerCase().replace(/^#/, '');
      if (!t.tags.includes(tag)) { pushHistory(); t.tags.push(tag); touch(t); save(); renderTagEditor(t); renderSidebar(); }
      $('tagInput').value = '';
    } else if (e.key === 'Backspace' && !$('tagInput').value && detailTask) {
      const t = taskById(detailTask.id); if (t.tags.length) { pushHistory(); t.tags.pop(); touch(t); save(); renderTagEditor(t); renderSidebar(); }
    }
  });
  $('metaTags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmtag]'); if (!b || !detailTask) return;
    const t = taskById(detailTask.id); pushHistory(); t.tags = t.tags.filter((x) => x !== b.dataset.rmtag); touch(t); save(); renderTagEditor(t); renderSidebar();
  });

  /* subtasks */
  $('subtaskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('subtaskInput').value.trim() && detailTask) {
      const t = taskById(detailTask.id); pushHistory();
      t.subtasks.push({ id: uid(), text: $('subtaskInput').value.trim(), done: false });
      touch(t); save(); renderSubtasks(t); patchCardMeta(t); $('subtaskInput').value = '';
    }
  });
  $('subtaskList').addEventListener('click', (e) => {
    if (!detailTask) return; const t = taskById(detailTask.id);
    const chk = e.target.closest('[data-st-check]');
    const del = e.target.closest('[data-st-del]');
    if (chk) { const s = t.subtasks.find((x) => x.id === chk.dataset.stCheck); pushHistory(); s.done = !s.done; touch(t); save(); renderSubtasks(t); patchCardMeta(t); }
    else if (del) { pushHistory(); t.subtasks = t.subtasks.filter((x) => x.id !== del.dataset.stDel); touch(t); save(); renderSubtasks(t); patchCardMeta(t); }
  });
  $('subtaskList').addEventListener('input', debounce((e) => {
    const span = e.target.closest('[data-st-text]'); if (!span || !detailTask) return;
    const t = taskById(detailTask.id); const s = t.subtasks.find((x) => x.id === span.dataset.stText);
    if (s) { s.text = span.textContent; touch(t); save(); }
  }, 300));

  /* subtask drag-reorder — draggable only while gripping the ⋮⋮ handle so
     text selection/editing inside subtasks is never hijacked */
  const stList = $('subtaskList');
  let subDragId = null;
  stList.addEventListener('mousedown', (e) => {
    const grip = e.target.closest('.st-grip');
    if (grip) grip.closest('.subtask-item').draggable = true;
  });
  stList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.subtask-item');
    if (!li || !li.draggable) return;
    e.stopPropagation(); // keep the global task-card DnD out of this
    subDragId = li.dataset.sid;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'subtask:' + subDragId); } catch (_) {}
  });
  stList.addEventListener('dragover', (e) => {
    if (!subDragId) return;
    e.preventDefault(); e.stopPropagation();
    const over = e.target.closest('.subtask-item');
    const dragEl = stList.querySelector('.subtask-item.dragging');
    if (!over || !dragEl || over === dragEl) return;
    const r = over.getBoundingClientRect();
    stList.insertBefore(dragEl, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  stList.addEventListener('drop', (e) => { if (subDragId) { e.preventDefault(); e.stopPropagation(); } });
  stList.addEventListener('dragend', (e) => {
    const li = e.target.closest('.subtask-item');
    if (li) { li.draggable = false; li.classList.remove('dragging'); }
    if (!subDragId || !detailTask) { subDragId = null; return; }
    subDragId = null;
    const t = taskById(detailTask.id); if (!t) return;
    const domOrder = [...stList.querySelectorAll('.subtask-item')].map((el) => el.dataset.sid);
    if (domOrder.join() !== t.subtasks.map((s) => s.id).join()) {
      pushHistory();
      t.subtasks.sort((a, b) => domOrder.indexOf(a.id) - domOrder.indexOf(b.id));
      touch(t); save();
      renderSubtasks(t);
    }
  });

  /* editor */
  // Keep the editor's text selection alive when a toolbar button is pressed.
  $('editorToolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('editorToolbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) execEditor(b.dataset.cmd, b.dataset.val); });
  $('editor').addEventListener('input', () => { saveNotes(); });
  $('editor').addEventListener('keyup', updateToolbarState);
  $('editor').addEventListener('mouseup', () => {
    if (painterActive) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && selectionInsideEditor()) { applyPainter(); return; }
    }
    updateToolbarState();
  });
  $('editor').addEventListener('click', (e) => {
    const li = e.target.closest('ul[data-type="check"] > li');
    if (li && e.offsetX < 24) { li.classList.toggle('done'); saveNotes(); }
  });

  /* comments */
  const sendComment = () => {
    if (!detailTask || !$('commentInput').value.trim()) return;
    const t = taskById(detailTask.id); pushHistory();
    (t.comments = t.comments || []).push({ ts: Date.now(), text: $('commentInput').value.trim() });
    logActivity(t, 'Commented'); touch(t); save(); renderComments(t); $('commentInput').value = '';
  };
  $('commentSend').addEventListener('click', sendComment);
  $('commentInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });

  /* palette */
  $('paletteInput').addEventListener('input', () => buildPalette($('paletteInput').value.trim()));
  $('paletteInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
  });
  $('paletteList').addEventListener('click', (e) => { const it = e.target.closest('[data-pi]'); if (it) { paletteState.active = +it.dataset.pi; runPalette(); } });
  $('paletteOverlay').addEventListener('click', (e) => { if (e.target === $('paletteOverlay')) closePalette(); });

  /* modals */
  $('settingsBtn').addEventListener('click', () => openModal('settingsOverlay'));
  $('profileBtn').addEventListener('click', () => openModal('settingsOverlay'));
  $('themeQuick').addEventListener('click', cycleTheme);
  $('shortcutsBtn').addEventListener('click', () => { closeOverlay($('settingsOverlay')); setTimeout(() => openModal('shortcutsOverlay'), 180); });
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', (e) => closeOverlay(e.target.closest('.overlay'))));
  $$('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeOverlay(o); }));

  $('themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-set]'); if (b) setTheme(b.dataset.themeSet); });
  $('accentRow').addEventListener('click', (e) => { const d = e.target.closest('[data-accent]'); if (d) { state.settings.accent = d.dataset.accent; const a = ACCENTS.find((x) => x.hex === d.dataset.accent); state.settings.accentRgb = a.rgb; save(); applyAccent(); if (state.settings.view === 'dashboard') renderDashboard(); } });
  $('settingAppName').addEventListener('input', debounce(() => { state.settings.appName = $('settingAppName').value.trim(); save(); applyBranding(); }, 150));
  $('settingDefaultFolder').addEventListener('change', () => {
    state.settings.defaultFolderId = $('settingDefaultFolder').value || null;
    if (enforceFolderRule()) renderAll(); // adopt any stray folderless tasks immediately
    save();
    toast('Default folder updated', 'success');
  });
  $('settingName').addEventListener('input', debounce(() => { state.settings.name = $('settingName').value || 'You'; save(); renderSidebar(); renderComments(detailTask ? taskById(detailTask.id) : {}); }, 200));
  $('exportBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
  $('resetBtn').addEventListener('click', resetData);

  /* keyboard shortcuts */
  document.addEventListener('keydown', onKeydown);

  setupResize();
  setupDnD();
}

/* ----- inline title editor ----- */
function inlineEditTitle(id, span) {
  const t = taskById(id); if (!t) return;
  const input = document.createElement('input');
  input.className = 'task-title-edit'; input.value = t.title;
  span.replaceWith(input); input.focus(); input.select();
  let cancelled = false;
  const commit = () => {
    if (cancelled) return;
    if (input.value.trim() !== t.title) { pushHistory(); t.title = input.value.trim() || 'Untitled'; touch(t); save(); }
    renderAll();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep Escape/Space from triggering global shortcuts
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { cancelled = true; renderList(); }
  });
  input.addEventListener('blur', commit);
}

/* ----- targeted card patches (avoid full re-render) ----- */
function patchCardTitle(t) { const el = document.querySelector(`.task-card[data-id="${t.id}"] .task-title`); if (el) el.textContent = t.title || 'Untitled'; }
function patchCardMeta() { renderList(); }

/* ----- multi-selection ----- */
function toggleMulti(id) {
  ui.multi.has(id) ? ui.multi.delete(id) : ui.multi.add(id);
  document.querySelector(`.task-card[data-id="${id}"]`)?.classList.toggle('multi-selected');
  renderBulkBar();
}
function rangeSelect(id) {
  const ids = displayedTaskIds();
  const a = ids.indexOf(ui.selected), b = ids.indexOf(id);
  if (a < 0 || b < 0) { openTask(id); return; }
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
  for (let i = lo; i <= hi; i++) ui.multi.add(ids[i]);
  ui.search ? renderSearchResults() : renderList();
  renderBulkBar();
}

/* ----- completion animation ----- */
function animateComplete(el) {
  if (el.classList.contains('checked')) return;
  const burst = document.createElement('span'); burst.className = 'complete-burst';
  el.style.position = 'relative'; el.appendChild(burst);
  setTimeout(() => burst.remove(), 500);
}

/* ------------------------------------------------------------------ *
 *  25. Keyboard shortcuts
 * ------------------------------------------------------------------ */
function onKeydown(e) {
  const mod = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  // Ctrl+K — palette (always)
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('paletteOverlay').hidden ? openPalette() : closePalette(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newTask(); return; }
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { if (typing) return; e.preventDefault(); undo(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { if (typing) return; e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { if (typing) return; e.preventDefault(); if (ui.selected) duplicateTask(ui.selected); return; }

  if (e.key === 'Escape') {
    if (!$('colorPop').hidden || !$('bgPop').hidden) return hideColorPops();
    if (painterActive) return cancelPainter();
    if (!$('paletteOverlay').hidden) return closePalette();
    if (!$('settingsOverlay').hidden) return closeOverlay($('settingsOverlay'));
    if (!$('shortcutsOverlay').hidden) return closeOverlay($('shortcutsOverlay'));
    if (!$('contextMenu').hidden) return hideContextMenu();
    if (!$('popover').hidden) return hidePopover();
    if (ui.multi.size) { ui.multi.clear(); renderAll(); return; }
    if (ui.selected) return closeDetail();
    return;
  }

  if (typing) return;

  if (e.key === ' ' && ui.selected) { e.preventDefault(); toggleComplete(ui.selected); renderAll(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected) { e.preventDefault(); removeWithUndo(ui.selected); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter' && ui.selected) { $('detailTitle').focus(); }
}
function moveSelection(d) {
  const ids = displayedTaskIds(); // walk what the user sees, incl. grouped order
  if (!ids.length) return;
  let i = ids.indexOf(ui.selected);
  i = i < 0 ? 0 : clamp(i + d, 0, ids.length - 1);
  openTask(ids[i]);
  document.querySelector(`.task-card[data-id="${ids[i]}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ *
 *  26. Static UI population
 * ------------------------------------------------------------------ */
function buildStatics() {
  // accent dots
  $('accentRow').innerHTML = ACCENTS.map((a) => `<span class="accent-dot" data-accent="${a.hex}" style="background:${a.hex}" title="${a.name}"></span>`).join('');
  $('settingName').value = state.settings.name;
  $('settingAppName').value = state.settings.appName || '';
  // shortcuts
  const sc = [
    ['New Task', ['Ctrl', 'N']], ['Search', ['Ctrl', 'F']], ['Command Palette', ['Ctrl', 'K']],
    ['Duplicate', ['Ctrl', 'D']], ['Undo', ['Ctrl', 'Z']], ['Redo', ['Ctrl', 'Y']],
    ['Delete Task', ['Del']], ['Complete Task', ['Space']], ['Close / Cancel', ['Esc']],
    ['Navigate tasks', ['↑', '↓']], ['Edit title', ['Enter']], ['Multi-select', ['Ctrl', 'Click']],
  ];
  $('shortcutsGrid').innerHTML = sc.map(([name, keys]) => `<div class="sc-row"><span class="sc-name">${name}</span><span class="sc-keys">${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</span></div>`).join('');
}

/* ------------------------------------------------------------------ *
 *  27. Apply everything / init
 * ------------------------------------------------------------------ */
function applyBranding() {
  const name = (state.settings.appName || '').trim() || 'Nimbus';
  const bn = document.querySelector('.brand-name');
  if (bn) bn.textContent = name;
  document.title = name + ' · Tasks & Notes';
}
function applyAll() {
  // buildStatics first: applyAccent marks the active dot it creates
  applyTheme(); applySidebar(); applyBranding(); buildStatics(); applyAccent(); renderAll();
  $('settingName').value = state.settings.name;
}
function init() {
  load();
  remoteVersion = +(localStorage.getItem(VERSION_KEY) || 0);
  if (enforceFolderRule()) save(); // one-time migration of folderless tasks
  // A previous session ended with edits that never reached Neon — treat
  // them as pending so the boot sync pushes instead of adopting over them.
  syncDirty = localStorage.getItem(DIRTY_KEY) === '1';
  wire();
  applyAll();
  // cloud sync: adopt/migrate on boot, then poll while visible.
  // Hidden tabs skip polling entirely so Neon's compute can auto-suspend
  // (saves free-tier compute hours); we re-sync the moment the tab returns.
  const pollTick = () => { if (!document.hidden) syncFromRemote(); };
  syncFromRemote(true);
  setInterval(pollTick, 60000);
  document.addEventListener('visibilitychange', pollTick);
  window.addEventListener('focus', pollTick);
  window.addEventListener('online', () => { if (syncDirty) pushToRemote(); else pollTick(); });
  // Tab is closing: capture un-debounced keystrokes and write the cache
  // synchronously. The network push is best-effort and STRICTLY version-
  // checked: a page whose initial sync never settled, or whose base version
  // is stale, must never blind-write over the cloud. If the push loses,
  // DIRTY_KEY makes the next boot reconcile and re-push safely.
  window.addEventListener('pagehide', () => {
    flushDetailEdits();
    if (!savePending && !syncDirty) return;
    savePending = false; syncDirty = true;
    _cacheWrite();
    if (!syncReady || remoteVersion === 0) return; // never confirmed cloud state: cache only
    try {
      fetch(NEON_URL, {
        method: 'POST', keepalive: true,
        headers: { 'Neon-Connection-String': NEON_CONN },
        body: JSON.stringify({
          query: 'UPDATE workspace SET data=$1::jsonb, version=version+1, updated_at=now() WHERE id=$2 AND version=$3',
          params: [JSON.stringify(state), WORKSPACE_ID, remoteVersion],
        }),
      });
    } catch (e) {}
  });
  // re-render dashboard on resize for canvas crispness
  window.addEventListener('resize', debounce(() => { if (state.settings.view === 'dashboard') renderDashboard(); }, 250));
  // expose for debugging (getter: `state` is reassigned by import/reset)
  window.Nimbus = { get state() { return state; }, save, renderAll,
    _sync: { push: pushToRemote, pull: syncFromRemote, query: neonQuery, status: () => ({ remoteVersion, syncDirty, syncReady, savePending, inFlight: syncInFlight }), _setVer: (v) => { remoteVersion = v; } } };
  console.log('%cNimbus ready ☁️', 'color:#6366f1;font-weight:700;font-size:14px');
}

document.addEventListener('DOMContentLoaded', init);
})();
