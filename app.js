// ═══════════════════════════════════════════════════════════════════
//  JOURNAL PWA — app.js
//  Google Drive синхронизация через официальный REST API
// ═══════════════════════════════════════════════════════════════════

// ─── КОНФИГУРАЦИЯ ──────────────────────────────────────────────────
// 1. Зайди на https://console.cloud.google.com
// 2. Создай проект → APIs & Services → Credentials → OAuth 2.0 Client ID
// 3. Application type: Web application
// 4. Authorized JS origins: твой домен (например https://username.github.io)
// 5. Вставь Client ID сюда:
const GOOGLE_CLIENT_ID = '603408798808-9ifrcd40k8c7i9akck6jkdivmos41e9d.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'journal_data.json';
const APP_VERSION = '1.0.0';

// ─── ДАННЫЕ ────────────────────────────────────────────────────────
const MOODS = [
  { icon: '💀', label: 'Жесть' },
  { icon: '😤', label: 'Злой'  },
  { icon: '😐', label: 'Норм'  },
  { icon: '😏', label: 'Неплохо' },
  { icon: '🔥', label: 'Огонь' },
];
const CATEGORIES = ['Личное', 'Работа', 'Идеи', 'Цели', 'Другое'];

// ─── СОСТОЯНИЕ ─────────────────────────────────────────────────────
let state = {
  notes: [],
  activeNote: null,
  view: 'list',           // list | editor | settings
  search: '',
  filterCat: 'Все',
  sortBy: 'updated',      // updated | created | alpha
  driveStatus: 'disconnected', // disconnected | connected | syncing | error
  driveFileId: null,
  toastTimer: null,
  deleteTarget: null,
  statsOpen: false,
  accessToken: null,
};

// ─── UTILS ─────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── LOCAL STORAGE ─────────────────────────────────────────────────
function saveLocal() {
  localStorage.setItem('journal_notes_v2', JSON.stringify(state.notes));
  localStorage.setItem('journal_drive_file_id', state.driveFileId || '');
}

function loadLocal() {
  try {
    const raw = localStorage.getItem('journal_notes_v2');
    if (raw) state.notes = JSON.parse(raw);
    state.driveFileId = localStorage.getItem('journal_drive_file_id') || null;
  } catch (e) {
    console.warn('loadLocal error', e);
  }
}

// ═══ GOOGLE DRIVE API ══════════════════════════════════════════════

// Загружаем Google Identity Services
function loadGIS() {
  return new Promise((resolve) => {
    if (window.google?.accounts) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

// Получаем Access Token через popup
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { reject(resp.error); return; }
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

// Ищем файл в appDataFolder
async function findDriveFile(token) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

// Читаем файл
async function readDriveFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return await res.json();
}

// Создаём или обновляем файл
async function writeDriveFile(token, fileId, notes) {
  const content = JSON.stringify(notes);
  const blob = new Blob([content], { type: 'application/json' });

  if (!fileId) {
    // Создаём новый
    const meta = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
    const form = new FormData();
    form.append('metadata', new Blob([meta], { type: 'application/json' }));
    form.append('file', blob);
    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    const data = await res.json();
    return data.id;
  } else {
    // Обновляем существующий
    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: content }
    );
    return fileId;
  }
}

// ─── Подключиться к Google Drive ───────────────────────────────────
async function connectDrive() {
  if (GOOGLE_CLIENT_ID === 'ВСТАВЬ_СВОЙ_CLIENT_ID_СЮДА') {
    showToast('Вставь Client ID в app.js!', 'err');
    return;
  }
  try {
    setDriveStatus('syncing');
    await loadGIS();
    const token = await getAccessToken();
    state.accessToken = token;

    // Ищем файл
    let fileId = state.driveFileId || await findDriveFile(token);

    if (fileId) {
      // Загружаем с Drive (мёрж с локальными)
      const driveNotes = await readDriveFile(token, fileId);
      if (Array.isArray(driveNotes)) {
        const ids = new Set(state.notes.map(n => n.id));
        const merged = [...state.notes, ...driveNotes.filter(n => !ids.has(n.id))];
        // Обновляем те что новее на Drive
        const driveMap = Object.fromEntries(driveNotes.map(n => [n.id, n]));
        state.notes = merged.map(n => {
          const d = driveMap[n.id];
          if (d && new Date(d.updatedAt) > new Date(n.updatedAt)) return d;
          return n;
        });
      }
      state.driveFileId = fileId;
    }

    // Сохраняем на Drive
    const newFileId = await writeDriveFile(token, state.driveFileId, state.notes);
    state.driveFileId = newFileId;

    saveLocal();
    setDriveStatus('connected');
    renderList();
    showToast('Google Drive подключён ✓', 'ok');
  } catch (e) {
    console.error('Drive connect error:', e);
    setDriveStatus('error');
    showToast('Ошибка подключения Drive', 'err');
  }
}

// ─── Синхронизировать (сохранить на Drive) ─────────────────────────
async function syncToDrive() {
  if (!state.accessToken || !state.driveFileId) return;
  try {
    setDriveStatus('syncing');
    await writeDriveFile(state.accessToken, state.driveFileId, state.notes);
    setDriveStatus('connected');
  } catch (e) {
    setDriveStatus('error');
    showToast('Ошибка синхронизации', 'err');
  }
}

function setDriveStatus(status) {
  state.driveStatus = status;
  const badge = document.getElementById('drive-badge');
  if (!badge) return;
  badge.className = 'drive-badge ' + status;
  const labels = {
    disconnected: '☁ Drive',
    connected:    '✓ Drive',
    syncing:      '↻ Sync...',
    error:        '✗ Drive',
  };
  badge.textContent = labels[status] || '☁ Drive';
}

// ═══ CRUD ══════════════════════════════════════════════════════════

function createNote() {
  state.activeNote = {
    id: uid(),
    title: '',
    content: '',
    mood: null,
    category: 'Личное',
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setView('editor');
}

function saveNote() {
  if (!state.activeNote) return;
  const note = { ...state.activeNote, updatedAt: new Date().toISOString() };
  const idx = state.notes.findIndex(n => n.id === note.id);
  if (idx >= 0) state.notes[idx] = note;
  else state.notes.unshift(note);
  state.activeNote = note;
  saveLocal();
  syncToDrive();
}

function deleteNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  if (state.activeNote?.id === id) { state.activeNote = null; setView('list'); }
  saveLocal();
  syncToDrive();
  closeConfirm();
  showToast('Запись удалена', 'warn');
  renderList();
}

function togglePin(id) {
  state.notes = state.notes.map(n => n.id === id ? { ...n, pinned: !n.pinned } : n);
  saveLocal();
  syncToDrive();
  renderList();
}

// ═══ FILTERING ══════════════════════════════════════════════════════

function getFiltered() {
  return state.notes
    .filter(n => state.filterCat === 'Все' || n.category === state.filterCat)
    .filter(n => {
      if (!state.search.trim()) return true;
      const q = state.search.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (state.sortBy === 'alpha') return a.title.localeCompare(b.title);
      if (state.sortBy === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
}

// ═══ RENDER ════════════════════════════════════════════════════════

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view)?.classList.add('active');
  document.getElementById('fab')?.classList.toggle('hidden', view !== 'list');

  if (view === 'editor') renderEditor();
  if (view === 'list')   renderList();
  if (view === 'settings') renderSettings();
}

function renderList() {
  const list = document.getElementById('notes-list');
  const filtered = getFiltered();

  // Count
  document.getElementById('sort-count').textContent = `${filtered.length} / ${state.notes.length}`;

  // Filter chips
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', c.dataset.cat === state.filterCat);
  });

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === state.sortBy);
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📓</div>
        <div class="empty-title">ПУСТО</div>
        <div class="empty-sub">${state.notes.length > 0 ? 'Ничего не найдено' : 'Нажми + чтобы создать первую запись'}</div>
      </div>`;
    return;
  }

  list.innerHTML = filtered.map(note => `
    <div class="note-card ${note.pinned ? 'pinned' : ''}" data-id="${note.id}">
      <div class="card-top">
        <div class="card-title">
          ${note.pinned ? '<span class="pin-icon">📌</span>' : ''}
          <span class="${!note.title ? 'card-title-empty' : ''}">${escHtml(note.title || 'Без названия')}</span>
        </div>
        <div class="card-actions">
          <button class="card-action pin-toggle" data-id="${note.id}" title="${note.pinned ? 'Открепить' : 'Закрепить'}">
            ${note.pinned ? '📌' : '📍'}
          </button>
          <button class="card-action danger delete-btn" data-id="${note.id}" title="Удалить">🗑️</button>
        </div>
      </div>
      ${note.content ? `<div class="card-preview">${escHtml(note.content)}</div>` : ''}
      <div class="card-meta">
        <span class="card-date">${formatDate(note.updatedAt)}</span>
        <span class="card-cat">${note.category}</span>
        ${note.mood ? `<span class="card-mood">${note.mood}</span>` : ''}
      </div>
    </div>
  `).join('');

  // Click events
  list.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions')) return;
      const id = card.dataset.id;
      state.activeNote = state.notes.find(n => n.id === id) || null;
      setView('editor');
    });
  });
  list.querySelectorAll('.pin-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); togglePin(btn.dataset.id); });
  });
  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openConfirm(btn.dataset.id); });
  });
}

function renderEditor() {
  const note = state.activeNote;
  if (!note) return;

  document.getElementById('editor-title').value = note.title || '';
  document.getElementById('editor-content').value = note.content || '';
  document.getElementById('editor-category').value = note.category || 'Личное';
  updateWordCount();

  // Moods
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mood === note.mood);
  });
}

function updateWordCount() {
  const content = document.getElementById('editor-content')?.value || '';
  const el = document.getElementById('word-count');
  if (el) el.textContent = `${content.length} симв. · ${wordCount(content)} слов`;
}

function renderSettings() {
  // nothing dynamic for now
}

// ─── Stats ──────────────────────────────────────────────────────────
function openStats() {
  const total     = state.notes.length;
  const thisWeek  = state.notes.filter(n => new Date(n.updatedAt) > new Date(Date.now() - 7*86400000)).length;
  const pinned    = state.notes.filter(n => n.pinned).length;
  const avgLen    = total ? Math.round(state.notes.reduce((a,n) => a + n.content.length, 0) / total) : 0;

  document.getElementById('stat-total').textContent   = total;
  document.getElementById('stat-week').textContent    = thisWeek;
  document.getElementById('stat-pinned').textContent  = pinned;
  document.getElementById('stat-avg').textContent     = avgLen;

  const catList = document.getElementById('stats-cats');
  catList.innerHTML = CATEGORIES.map(c => {
    const count = state.notes.filter(n => n.category === c).length;
    return `<div class="cat-row"><span>${c}</span><span class="cat-count">${count}</span></div>`;
  }).join('');

  document.getElementById('stats-overlay').classList.remove('hidden');
}

// ─── Confirm ────────────────────────────────────────────────────────
function openConfirm(id) {
  state.deleteTarget = id;
  document.getElementById('confirm-overlay').classList.remove('hidden');
}
function closeConfirm() {
  state.deleteTarget = null;
  document.getElementById('confirm-overlay').classList.add('hidden');
}

// ─── Toast ──────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  if (state.toastTimer) clearTimeout(state.toastTimer);
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  state.toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ─── Export / Import ────────────────────────────────────────────────
function exportJSON() {
  const blob = new Blob([JSON.stringify(state.notes, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `journal_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Экспорт готов ✓', 'ok');
}

function importJSON(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (Array.isArray(data)) {
        const ids = new Set(state.notes.map(n => n.id));
        const merged = [...state.notes, ...data.filter(n => !ids.has(n.id))];
        state.notes = merged;
        saveLocal();
        syncToDrive();
        renderList();
        showToast(`Импортировано: ${data.length} записей`, 'ok');
      }
    } catch { showToast('Ошибка файла', 'err'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ─── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══ EVENTS ════════════════════════════════════════════════════════

function bindEvents() {
  // FAB
  document.getElementById('fab').addEventListener('click', createNote);

  // Header buttons
  document.getElementById('btn-stats').addEventListener('click', openStats);
  document.getElementById('btn-settings').addEventListener('click', () => {
    setView(state.view === 'settings' ? 'list' : 'settings');
    document.getElementById('btn-settings').classList.toggle('active', state.view === 'settings');
  });

  // Drive badge
  document.getElementById('drive-badge').addEventListener('click', () => {
    if (state.driveStatus === 'disconnected' || state.driveStatus === 'error') connectDrive();
    else if (state.driveStatus === 'connected') { syncToDrive(); showToast('Синхронизация...', 'warn'); }
  });

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList();
  });

  // Filter chips
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => { state.filterCat = c.dataset.cat; renderList(); });
  });

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(b => {
    b.addEventListener('click', () => { state.sortBy = b.dataset.sort; renderList(); });
  });

  // ── Editor ──
  document.getElementById('back-btn').addEventListener('click', () => {
    saveNote();
    showToast('Сохранено ✓', 'ok');
    setView('list');
  });

  document.getElementById('editor-title').addEventListener('input', (e) => {
    if (state.activeNote) state.activeNote.title = e.target.value;
  });

  document.getElementById('editor-content').addEventListener('input', (e) => {
    if (state.activeNote) state.activeNote.content = e.target.value;
    updateWordCount();
  });

  document.getElementById('editor-category').addEventListener('change', (e) => {
    if (state.activeNote) state.activeNote.category = e.target.value;
  });

  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.activeNote) return;
      const m = btn.dataset.mood;
      state.activeNote.mood = state.activeNote.mood === m ? null : m;
      document.querySelectorAll('.mood-btn').forEach(b => b.classList.toggle('active', b.dataset.mood === state.activeNote.mood));
    });
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    saveNote();
    showToast('Сохранено ✓', 'ok');
    setView('list');
  });

  // ── Settings ──
  document.getElementById('btn-export').addEventListener('click', exportJSON);
  document.getElementById('btn-import-trigger').addEventListener('click', () => document.getElementById('import-input').click());
  document.getElementById('import-input').addEventListener('change', importJSON);
  document.getElementById('btn-connect-drive').addEventListener('click', connectDrive);
  document.getElementById('btn-sync-now').addEventListener('click', () => {
    if (state.driveStatus === 'connected') syncToDrive().then(() => showToast('Синхронизировано ✓', 'ok'));
    else connectDrive();
  });
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (confirm('Удалить ВСЕ заметки? Это нельзя отменить.')) {
      state.notes = [];
      saveLocal();
      syncToDrive();
      renderList();
      showToast('Всё удалено', 'warn');
    }
  });

  // ── Stats overlay ──
  document.getElementById('stats-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('stats-overlay').classList.add('hidden');
  });
  document.getElementById('btn-close-stats').addEventListener('click', () => {
    document.getElementById('stats-overlay').classList.add('hidden');
  });

  // ── Confirm ──
  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('btn-confirm-delete').addEventListener('click', () => {
    if (state.deleteTarget) deleteNote(state.deleteTarget);
  });
}

// ═══ INIT ══════════════════════════════════════════════════════════
async function init() {
  loadLocal();
  bindEvents();

  // Скрываем лоадер
  setTimeout(() => {
    const loader = document.getElementById('loader');
    if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.remove(), 300); }
  }, 800);

  setView('list');
  setDriveStatus(state.driveFileId ? 'connected' : 'disconnected');
}

document.addEventListener('DOMContentLoaded', init);
