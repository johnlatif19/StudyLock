'use strict';

/* -------------------------------------------------------------------------- */
/*  StudyLock — Admin Dashboard                                               */
/*  Uses JWT (Bearer) for every /api/admin/* call.                            */
/* -------------------------------------------------------------------------- */

const API = '/api';
const TOKEN_KEY = 'sl_admin_token';

const $ = (sel) => document.querySelector(sel);

const els = {
  logoutBtn: $('#logoutBtn'),

  statUsers: $('#statUsers'),
  statActive: $('#statActive'),
  statPending: $('#statPending'),
  statUnlocked: $('#statUnlocked'),

  tabs: document.querySelectorAll('.tab'),
  panelUsers: $('#panelUsers'),
  panelRequests: $('#panelRequests'),
  reqBadge: $('#reqBadge'),

  usersList: $('#usersList'),
  requestsList: $('#requestsList'),

  createUserForm: $('#createUserForm'),
  newName: $('#newName'),
  newUsername: $('#newUsername'),

  errorBox: $('#errorBox'),
  toast: $('#toast'),
};

let token = localStorage.getItem(TOKEN_KEY);
let pollHandle = null;
let lastPendingCount = 0;
let isFetching = false;

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(TOKEN_KEY);
    location.replace('/login');
    throw new Error('unauthorized');
  }

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
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

/* -------------------------------------------------------------------------- */
/*                              Render — Users                                */
/* -------------------------------------------------------------------------- */

function statusBadge(status) {
  if (status === 'active')   return '<span class="status-badge active">Focus</span>';
  if (status === 'unlocked') return '<span class="status-badge unlocked">Unlocked</span>';
  return '<span class="status-badge free">Free</span>';
}

function renderUsers(users) {
  if (!users.length) {
    els.usersList.innerHTML =
      '<div class="empty">لا يوجد مستخدمون بعد.</div>';
    return;
  }

  els.usersList.innerHTML = users.map((u) => {
    const s = u.session;
    const sessionText = s ? fmtHMS(s.remainingMs) : '—';
    const startedText = s
      ? new Date(s.startedAt).toLocaleTimeString('ar-EG')
      : '';

    return `
      <div class="row" data-id="${u.id}">
        <div class="row-top">
          <div>
            <div class="row-name">${escapeHtml(u.name)}</div>
            <div class="row-meta">
              ${u.username ? '@' + escapeHtml(u.username) : 'بدون اسم مستخدم'}
              ${startedText ? ' · بدأت ' + startedText : ''}
            </div>
          </div>
          ${statusBadge(u.status)}
        </div>

        <div class="row-meta">
          الجلسة: <strong>${sessionText}</strong>
        </div>

        <div class="row-actions">
          <button class="btn btn-primary" data-act="unlock" data-id="${u.id}">
            فتح الوصول
          </button>
          <button class="btn btn-ghost" data-act="lock" data-id="${u.id}">
            قفل / إيقاف
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/* -------------------------------------------------------------------------- */
/*                            Render — Requests                               */
/* -------------------------------------------------------------------------- */

function requestStatusPill(status) {
  if (status === 'pending')  return '<span class="status-badge active">قيد الانتظار</span>';
  if (status === 'approved') return '<span class="status-badge free">مقبول</span>';
  return '<span class="status-badge unlocked">مرفوض</span>';
}

function renderRequests(requests) {
  if (!requests.length) {
    els.requestsList.innerHTML =
      '<div class="empty">لا توجد طلبات.</div>';
    updatePendingBadge(0);
    return;
  }

  els.requestsList.innerHTML = requests.map((r) => {
    const time = new Date(r.createdAt).toLocaleTimeString('ar-EG');

    const actions = r.status === 'pending'
      ? `<div class="row-actions">
           <button class="btn btn-primary" data-req="approve" data-id="${r.requestId}">
             فتح الوصول
           </button>
           <button class="btn btn-danger" data-req="reject" data-id="${r.requestId}">
             رفض
           </button>
         </div>`
      : '';

    return `
      <div class="row" data-request-id="${r.requestId}">
        <div class="row-top">
          <div class="row-name">${escapeHtml(r.userName || 'طالب')}</div>
          ${requestStatusPill(r.status)}
        </div>
        <div class="row-meta">${time}</div>
        <div class="req-reason">${escapeHtml(r.reason)}</div>
        ${actions}
      </div>
    `;
  }).join('');

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  updatePendingBadge(pendingCount);
}

function updatePendingBadge(count) {
  if (count > 0) {
    els.reqBadge.textContent = String(count);
    els.reqBadge.classList.remove('hidden');

    if (count > lastPendingCount) {
      showToast('طلب فتح جديد');
    }
  } else {
    els.reqBadge.classList.add('hidden');
  }

  lastPendingCount = count;
}

/* -------------------------------------------------------------------------- */
/*                                 Loaders                                    */
/* -------------------------------------------------------------------------- */

async function loadStats() {
  try {
    const s = await api('/admin/stats');
    els.statUsers.textContent = String(s.users ?? 0);
    els.statActive.textContent = String(s.activeSessions ?? 0);
    els.statPending.textContent = String(s.pendingRequests ?? 0);
    els.statUnlocked.textContent = String(s.unlockedSessions ?? 0);
  } catch {
    // Silent: transient
  }
}

async function loadUsers() {
  try {
    const { users } = await api('/admin/users');
    renderUsers(users);
  } catch {
    // Silent: transient
  }
}

async function loadRequests() {
  try {
    const { requests } = await api('/admin/requests');
    renderRequests(requests);
  } catch {
    // Silent: transient
  }
}

async function refreshAll() {
  if (isFetching) return;
  isFetching = true;

  try {
    await Promise.all([loadStats(), loadUsers(), loadRequests()]);
  } finally {
    isFetching = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Actions                                    */
/* -------------------------------------------------------------------------- */

async function unlockUser(id) {
  try {
    await api(`/admin/users/${encodeURIComponent(id)}/unlock`, { method: 'POST' });
    showToast('تم فتح الوصول');
    await refreshAll();
  } catch {
    showToast('تعذّر تنفيذ العملية');
  }
}

async function lockUser(id) {
  try {
    await api(`/admin/users/${encodeURIComponent(id)}/lock`, { method: 'POST' });
    showToast('تم القفل / الإيقاف');
    await refreshAll();
  } catch {
    showToast('تعذّر تنفيذ العملية');
  }
}

async function approveRequest(requestId) {
  try {
    const { requests } = await api('/admin/requests');
    const req = requests.find((r) => r.requestId === requestId);
    if (!req) return;

    await api(`/admin/users/${encodeURIComponent(req.userId)}/unlock`, {
      method: 'POST',
    });

    showToast('تم فتح الوصول');
    await refreshAll();
  } catch {
    showToast('تعذّر تنفيذ العملية');
  }
}

async function rejectRequest(requestId) {
  try {
    const { requests } = await api('/admin/requests');
    const req = requests.find((r) => r.requestId === requestId);
    if (!req) return;

    await api(`/admin/users/${encodeURIComponent(req.userId)}/lock`, {
      method: 'POST',
    });

    showToast('تم رفض الطلب');
    await refreshAll();
  } catch {
    showToast('تعذّر تنفيذ العملية');
  }
}

async function createUser(e) {
  e.preventDefault();
  showError('');

  const name = els.newName.value.trim();
  const username = els.newUsername.value.trim().toLowerCase();

  if (!name || !username) {
    showError('أدخل الاسم واسم المستخدم.');
    return;
  }

  try {
    await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ name, username }),
    });

    els.newName.value = '';
    els.newUsername.value = '';
    showToast('تمت إضافة المستخدم');
    await refreshAll();
  } catch (err) {
    if (err.status === 409) {
      showError('اسم المستخدم مستخدم مسبقًا.');
    } else {
      showError('تعذّر إنشاء المستخدم.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

els.usersList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;

  const { act, id } = btn.dataset;
  if (act === 'unlock') unlockUser(id);
  if (act === 'lock')   lockUser(id);
});

els.requestsList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-req]');
  if (!btn) return;

  const { req, id } = btn.dataset;
  if (req === 'approve') approveRequest(id);
  if (req === 'reject')  rejectRequest(id);
});

els.createUserForm.addEventListener('submit', createUser);

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    const target = tab.dataset.tab;
    els.panelUsers.classList.toggle('hidden', target !== 'users');
    els.panelRequests.classList.toggle('hidden', target !== 'requests');
  });
});

els.logoutBtn.addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  location.replace('/login');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshAll();
  }
});

/* -------------------------------------------------------------------------- */
/*                                  Polling                                   */
/* -------------------------------------------------------------------------- */

function startPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(refreshAll, 4000);
}

/* -------------------------------------------------------------------------- */
/*                                   Boot                                     */
/* -------------------------------------------------------------------------- */

(async function boot() {
  if (!token) {
    location.replace('/login');
    return;
  }

  // Verify the token belongs to an admin
  try {
    const res = await fetch(`${API}/me`, { headers: authHeaders() });
    if (!res.ok) {
      localStorage.removeItem(TOKEN_KEY);
      location.replace('/login');
      return;
    }

    const data = await res.json();
    if (data.user?.role !== 'admin') {
      localStorage.removeItem(TOKEN_KEY);
      location.replace('/login');
      return;
    }
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    location.replace('/login');
    return;
  }

  await refreshAll();
  startPolling();
})();
