'use strict';

/* -------------------------------------------------------------------------- */
/*  StudyLock — Admin Login                                                   */
/*  Only admins log in here. Students never see this page.                    */
/* -------------------------------------------------------------------------- */

const API = '/api';
const TOKEN_KEY = 'sl_admin_token';

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#loginForm'),
  username: $('#username'),
  password: $('#password'),
  loginBtn: $('#loginBtn'),
  errorBox: $('#errorBox'),
};

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.classList.remove('hidden');
}

function hideError() {
  els.errorBox.textContent = '';
  els.errorBox.classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/*                                  Submit                                    */
/* -------------------------------------------------------------------------- */

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const username = els.username.value.trim();
  const password = els.password.value;

  if (!username || !password) {
    showError('أدخل اسم المستخدم وكلمة المرور.');
    return;
  }

  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'جارٍ تسجيل الدخول...';

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError('اسم المستخدم أو كلمة المرور غير صحيحة.');
      return;
    }

    if (!data.token || data.user?.role !== 'admin') {
      showError('هذا الحساب لا يملك صلاحية الدخول إلى لوحة المسؤول.');
      return;
    }

    localStorage.setItem(TOKEN_KEY, data.token);
    location.replace('/dashboard');
  } catch {
    showError('تعذّر الاتصال بالسيرفر. حاول مرة أخرى.');
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = 'تسجيل الدخول';
  }
});

/* -------------------------------------------------------------------------- */
/*                          Redirect if already admin                         */
/* -------------------------------------------------------------------------- */

(async function checkExistingSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;

  try {
    const res = await fetch(`${API}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }

    const data = await res.json();
    if (data.user?.role === 'admin') {
      location.replace('/dashboard');
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore: stay on login page
  }
})();
