'use strict';

/* -------------------------------------------------------------------------- */
/*  StudyLock — Student UI                                                    */
/*  Identity: userId stored in localStorage (created on first launch with a   */
/*  user-provided name). Sent as X-User-Id on every request.                  */
/* -------------------------------------------------------------------------- */

const API = '/api';
const UID_KEY = 'sl_uid';
const SESSION_CACHE_KEY = 'sl_session_cache';

const $ = (sel) => document.querySelector(sel);

const els = {
  statusPill: $('#statusPill'),
  statusText: $('#statusText'),

  viewName: $('#viewName'),
  viewIdle: $('#viewIdle'),
  viewActive: $('#viewActive'),
  viewDone: $('#viewDone'),

  nameInput: $('#nameInput'),
  saveNameBtn: $('#saveNameBtn'),
  nameError: $('#nameError'),

  durationButtons: document.querySelectorAll('.duration-btn'),
  customDurationBox: $('#customDurationBox'),
  customMinutesInput: $('#customMinutesInput'),
  durationError: $('#durationError'),

  startBtn: $('#startBtn'),

  timer: $('#timer'),
  requestUnlockBtn: $('#requestUnlockBtn'),
  unlockedNotice: $('#unlockedNotice'),

  doneDuration: $('#doneDuration'),
  newSessionBtn: $('#newSessionBtn'),

  modalBackdrop: $('#modalBackdrop'),
  reasonInput: $('#reasonInput'),
  cancelRequestBtn: $('#cancelRequestBtn'),
  sendRequestBtn: $('#sendRequestBtn'),

  errorBox: $('#errorBox'),
  toast: $('#toast'),
};

let userId = null;
let currentSession = null;
let tickHandle = null;
let pollHandle = null;
let selectedDuration = 60; // دقائق — الافتراضي ساعة

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-User-Id': userId || '',
  };
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      ...apiHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data.error || 'request_failed'),
      { status: res.status }
    );
  }
  return data;
}

function fmtHMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

let toastTimer = null;
function showToast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

function showError(msg) {
  if (!msg) {
    els.errorBox.classList.add('hidden');
    els.errorBox.textContent = '';
    return;
  }
  els.errorBox.textContent = msg;
  els.errorBox.classList.remove('hidden');
}

function setStatus(on, label) {
  els.statusPill.classList.toggle('status-on', on);
  els.statusPill.classList.toggle('status-off', !on);
  els.statusText.textContent = label;
}

function showView(name) {
  els.viewName.classList.toggle('hidden', name !== 'name');
  els.viewIdle.classList.toggle('hidden', name !== 'idle');
  els.viewActive.classList.toggle('hidden', name !== 'active');
  els.viewDone.classList.toggle('hidden', name !== 'done');
}

function saveSessionCache(session) {
  if (session) {
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_CACHE_KEY);
  }
}

function loadSessionCache() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || 'null');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Identity bootstrap                              */
/* -------------------------------------------------------------------------- */

function readStoredIdentity() {
  const stored = localStorage.getItem(UID_KEY);
  if (stored) {
    userId = stored;
    return true;
  }
  return false;
}

async function registerWithName(name) {
  const res = await fetch(`${API}/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    throw Object.assign(
      new Error('register_failed'),
      { status: res.status }
    );
  }

  const data = await res.json();
  userId = data.userId;
  localStorage.setItem(UID_KEY, userId);
}

/* -------------------------------------------------------------------------- */
/*                                  Render                                    */
/* -------------------------------------------------------------------------- */

function renderIdle() {
  currentSession = null;
  saveSessionCache(null);
  setStatus(false, 'Focus Mode OFF');
  els.unlockedNotice.classList.add('hidden');
  showView('idle');
  stopTicker();
}

function renderActive(session) {
  currentSession = session;
  saveSessionCache(session);

  setStatus(true, 'Focus Mode ON');
  els.unlockedNotice.classList.add('hidden');

  showView('active');
  startTicker();
}

function renderDone(durationMs) {
  currentSession = null;
  saveSessionCache(null);
  setStatus(false, 'Focus Mode OFF');
  els.doneDuration.textContent = fmtHMS(durationMs);
  showView('done');
  stopTicker();
}

/* -------------------------------------------------------------------------- */
/*                                  Ticker                                    */
/* -------------------------------------------------------------------------- */

function startTicker() {
  stopTicker();
  tick();
  tickHandle = setInterval(tick, 1000);
}

function stopTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

function tick() {
  if (!currentSession) return;

  const remaining = currentSession.endsAt - Date.now();
  if (remaining <= 0) {
    renderDone(currentSession.duration * 1000);
    return;
  }

  els.timer.textContent = fmtHMS(remaining);
}

/* -------------------------------------------------------------------------- */
/*                              Duration picker                               */
/* -------------------------------------------------------------------------- */

function selectDuration(btn) {
  els.durationButtons.forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  const isCustom = btn.dataset.custom === 'true';

  if (isCustom) {
    selectedDuration = 'custom';
    els.customDurationBox.classList.remove('hidden');
    setTimeout(() => els.customMinutesInput.focus(), 50);
  } else {
    selectedDuration = Number(btn.dataset.minutes) || 60;
    els.customDurationBox.classList.add('hidden');
    els.customMinutesInput.value = '';
  }

  els.durationError.classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/*                                Actions                                     */
/* -------------------------------------------------------------------------- */

async function loadInitialState() {
  try {
    const { session } = await api('/session');

    if (session) {
      renderActive(session);
      return;
    }

    const cached = loadSessionCache();
    if (cached && cached.endsAt && cached.endsAt <= Date.now()) {
      renderDone(cached.duration * 1000);
      return;
    }

    renderIdle();
  } catch (err) {
    if (err.status === 401) {
      localStorage.removeItem(UID_KEY);
      localStorage.removeItem(SESSION_CACHE_KEY);
      userId = null;
      showView('name');
      setTimeout(() => els.nameInput.focus(), 100);
      return;
    }

    const cached = loadSessionCache();
    if (cached && cached.endsAt > Date.now()) {
      renderActive(cached);
    } else {
      renderIdle();
    }
  }
}

async function startSession() {
  els.durationError.classList.add('hidden');
  showError('');

  let minutes = selectedDuration;

  if (minutes === 'custom') {
    const raw = Number(els.customMinutesInput.value);

    if (!Number.isFinite(raw) || raw < 5) {
      els.durationError.textContent = 'الحد الأدنى 5 دقائق.';
      els.durationError.classList.remove('hidden');
      els.customMinutesInput.focus();
      return;
    }

    if (raw > 480) {
      els.durationError.textContent = 'الحد الأقصى 8 ساعات.';
      els.durationError.classList.remove('hidden');
      els.customMinutesInput.focus();
      return;
    }

    minutes = Math.floor(raw);
  }

  const durationSeconds = minutes * 60;

  els.startBtn.disabled = true;

  try {
    const { session } = await api('/session/start', {
      method: 'POST',
      body: JSON.stringify({ duration: durationSeconds }),
    });

    renderActive(session);
    showToast('بدأت جلسة التركيز');
  } catch {
    showError('تعذّر بدء الجلسة. تحقق من الاتصال وأعد المحاولة.');
  } finally {
    els.startBtn.disabled = false;
  }
}

async function requestUnlock() {
  const reason = els.reasonInput.value.trim();
  if (!reason) {
    showToast('اكتب سبب الطلب أولًا');
    return;
  }

  els.sendRequestBtn.disabled = true;

  try {
    await api('/session/request-unlock', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });

    closeModal();
    els.reasonInput.value = '';
    showToast('تم إرسال الطلب. انتظر موافقة المسؤول.');
  } catch {
    showToast('تعذّر إرسال الطلب');
  } finally {
    els.sendRequestBtn.disabled = false;
  }
}

async function submitName() {
  const name = els.nameInput.value.trim();
  els.nameError.classList.add('hidden');

  if (!name) {
    els.nameError.textContent = 'الرجاء إدخال الاسم.';
    els.nameError.classList.remove('hidden');
    els.nameInput.focus();
    return;
  }

  if (name.length < 2) {
    els.nameError.textContent = 'الاسم قصير جدًا.';
    els.nameError.classList.remove('hidden');
    els.nameInput.focus();
    return;
  }

  els.saveNameBtn.disabled = true;

  try {
    await registerWithName(name);
    await loadInitialState();
    startPolling();
    showToast(`مرحبًا ${name}`);
  } catch {
    els.nameError.textContent = 'تعذّر حفظ الاسم. حاول مرة أخرى.';
    els.nameError.classList.remove('hidden');
  } finally {
    els.saveNameBtn.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Modal                                     */
/* -------------------------------------------------------------------------- */

function openModal() {
  els.modalBackdrop.classList.remove('hidden');
  setTimeout(() => els.reasonInput.focus(), 50);
}

function closeModal() {
  els.modalBackdrop.classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/*                        Polling (server-driven state)                       */
/* -------------------------------------------------------------------------- */

function startPolling() {
  stopPolling();

  pollHandle = setInterval(async () => {
    if (!currentSession) return;

    try {
      const { session } = await api('/session');

      if (!session) {
        showToast('تم إنهاء جلسة التركيز');
        renderIdle();
        return;
      }

      currentSession = session;
    } catch {
      // silent
    }
  }, 5000);
}

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

els.durationButtons.forEach((btn) => {
  btn.addEventListener('click', () => selectDuration(btn));
});

els.customMinutesInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.startBtn.click();
});

els.saveNameBtn.addEventListener('click', submitName);

els.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitName();
});

els.startBtn.addEventListener('click', startSession);

els.requestUnlockBtn.addEventListener('click', openModal);

els.cancelRequestBtn.addEventListener('click', () => {
  closeModal();
  els.reasonInput.value = '';
});

els.sendRequestBtn.addEventListener('click', requestUnlock);

els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

els.newSessionBtn.addEventListener('click', () => {
  renderIdle();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && userId) {
    loadInitialState();
  }
});

/* -------------------------------------------------------------------------- */
/*                                   Boot                                     */
/* -------------------------------------------------------------------------- */

(async function boot() {
  // اختر "ساعة" افتراضيًا
  const defaultBtn = document.querySelector('.duration-btn[data-minutes="60"]');
  if (defaultBtn) selectDuration(defaultBtn);

  const hasIdentity = readStoredIdentity();

  if (!hasIdentity) {
    setStatus(false, 'Focus Mode OFF');
    showView('name');
    setTimeout(() => els.nameInput.focus(), 100);
    return;
  }

  await loadInitialState();
  startPolling();
})();
