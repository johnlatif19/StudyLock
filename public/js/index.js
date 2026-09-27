'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./db');

const app = express();

/* -------------------------------------------------------------------------- */
/*                              Config & Guards                               */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET missing or too short (min 16 chars).');
  process.exit(1);
}
if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.error('[FATAL] ADMIN_USERNAME / ADMIN_PASSWORD_HASH missing.');
  process.exit(1);
}
if (!/^\$2[aby]\$\d{2}\$/.test(ADMIN_PASSWORD_HASH)) {
  console.error('[FATAL] ADMIN_PASSWORD_HASH is not a valid bcrypt hash.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                              Security Middleware                           */
/* -------------------------------------------------------------------------- */

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '64kb' }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* -------------------------------------------------------------------------- */
/*                               Static Files                                 */
/* -------------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
}));

/* -------------------------------------------------------------------------- */
/*                                Seed (once)                                 */
/* -------------------------------------------------------------------------- */

function seedDemoUsers() {
  if (db.getUsers().length > 0) return;

  const demo = [
    { name: 'Ahmed',   username: 'ahmed' },
    { name: 'Mohamed', username: 'mohamed' },
    { name: 'Ali',     username: 'ali' },
  ];

  for (const u of demo) {
    const id = 'u_' + crypto.randomBytes(6).toString('hex');
    db.setUser({
      id,
      name: u.name,
      username: u.username,
      role: 'student',
      status: 'free',
      createdAt: Date.now(),
    });
  }
}
seedDemoUsers();

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function signAdminToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
  };
}

function publicSession(s) {
  if (!s) return null;
  const endsAt = s.startedAt + s.duration * 1000;
  return {
    sessionId: s.sessionId,
    userId: s.userId,
    status: s.status,
    startedAt: s.startedAt,
    duration: s.duration,
    endsAt,
    remainingMs: Math.max(0, endsAt - Date.now()),
  };
}

function findActiveSessionForUser(userId) {
  for (const s of db.getSessions()) {
    if (s.userId !== userId) continue;
    if (s.status !== 'active' && s.status !== 'unlocked') continue;

    if (Date.now() >= s.startedAt + s.duration * 1000) {
      s.status = 'ended';
      db.setSession(s);

      const u = db.getUser(userId);
      if (u) {
        u.status = 'free';
        db.setUser(u);
      }
      continue;
    }
    return s;
  }
  return null;
}

function isValidUserId(id) {
  return typeof id === 'string' && /^u_[a-f0-9]{6,32}$/.test(id);
}

/* -------------------------------------------------------------------------- */
/*                                Middleware                                  */
/* -------------------------------------------------------------------------- */

function adminAuthRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function studentRequired(req, res, next) {
  const uid = req.headers['x-user-id'];
  if (!uid || !isValidUserId(uid)) {
    return res.status(401).json({ error: 'missing_user_id' });
  }
  const user = db.getUser(uid);
  if (!user) {
    return res.status(401).json({ error: 'unknown_user' });
  }
  req.student = user;
  next();
}

/* -------------------------------------------------------------------------- */
/*                                   USERS                                    */
/* -------------------------------------------------------------------------- */

app.post('/api/users/register', (req, res) => {
  const name = String(req.body?.name || 'Student').trim().slice(0, 60) || 'Student';

  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  const user = {
    id,
    name,
    username: null,
    role: 'student',
    status: 'free',
    createdAt: Date.now(),
  };
  db.setUser(user);
  res.status(201).json({ userId: id, user: publicUser(user) });
});

app.get('/api/users/me', studentRequired, (req, res) => {
  res.json({ user: publicUser(req.student) });
});

/* -------------------------------------------------------------------------- */
/*                                   AUTH                                     */
/* -------------------------------------------------------------------------- */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  if (username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const ok = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = signAdminToken({ id: 'admin', role: 'admin' });
  return res.json({
    token,
    user: { id: 'admin', role: 'admin' },
  });
});

app.get('/api/me', adminAuthRequired, (req, res) => {
  res.json({ user: { id: 'admin', role: 'admin' } });
});

/* -------------------------------------------------------------------------- */
/*                                  SESSION                                   */
/* -------------------------------------------------------------------------- */

app.post('/api/session/start', studentRequired, (req, res) => {
  const user = req.student;

  const existing = findActiveSessionForUser(user.id);
  if (existing) {
    return res.json({ session: publicSession(existing) });
  }

  const rawDuration = Number(req.body?.duration) || 7200;
  const duration = Math.max(60, Math.min(rawDuration, 8 * 3600));

  const sessionId = 's_' + crypto.randomBytes(8).toString('hex');
  const session = {
    sessionId,
    userId: user.id,
    status: 'active',
    startedAt: Date.now(),
    duration,
  };

  db.setSession(session);

  user.status = 'active';
  db.setUser(user);

  res.json({ session: publicSession(session) });
});

app.get('/api/session', studentRequired, (req, res) => {
  const session = findActiveSessionForUser(req.student.id);
  res.json({ session: publicSession(session) });
});

app.post('/api/session/request-unlock', studentRequired, (req, res) => {
  const user = req.student;

  const session = findActiveSessionForUser(user.id);
  if (!session) {
    return res.status(400).json({ error: 'no_active_session' });
  }

  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) {
    return res.status(400).json({ error: 'missing_reason' });
  }

  for (const r of db.getRequests()) {
    if (r.userId === user.id && r.status === 'pending') {
      return res.json({ request: r });
    }
  }

  const requestId = 'r_' + crypto.randomBytes(8).toString('hex');
  const request = {
    requestId,
    userId: user.id,
    userName: user.name,
    sessionId: session.sessionId,
    reason,
    status: 'pending',
    createdAt: Date.now(),
  };

  db.setRequest(request);
  res.json({ request });
});

app.post('/api/session/end', studentRequired, (req, res) => {
  const user = req.student;
  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'ended';
    db.setSession(session);
  }
  user.status = 'free';
  db.setUser(user);
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/*                                   ADMIN                                    */
/* -------------------------------------------------------------------------- */

app.get('/api/admin/stats', adminAuthRequired, (_req, res) => {
  const users = db.getUsers();
  let active = 0;
  let unlocked = 0;

  for (const u of users) {
    const s = findActiveSessionForUser(u.id);
    if (!s) continue;
    if (s.status === 'active') active++;
    if (s.status === 'unlocked') unlocked++;
  }

  const pending = db.getRequests().filter(r => r.status === 'pending').length;

  res.json({
    users: users.length,
    activeSessions: active,
    unlockedSessions: unlocked,
    pendingRequests: pending,
  });
});

app.get('/api/admin/users', adminAuthRequired, (_req, res) => {
  const users = db.getUsers().map((u) => {
    const s = findActiveSessionForUser(u.id);
    return {
      ...publicUser(u),
      session: publicSession(s),
    };
  });
  res.json({ users });
});

app.post('/api/admin/users', adminAuthRequired, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 40);

  if (!name || !username) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: 'username_taken' });
  }

  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  const user = {
    id,
    name,
    username,
    role: 'student',
    status: 'free',
    createdAt: Date.now(),
  };

  db.setUser(user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/admin/users/:id/unlock', adminAuthRequired, (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'unlocked';
    db.setSession(session);
  }

  user.status = 'unlocked';
  db.setUser(user);

  for (const r of db.getRequests()) {
    if (r.userId === user.id && r.status === 'pending') {
      r.status = 'approved';
      r.resolvedAt = Date.now();
      db.setRequest(r);
    }
  }

  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/admin/users/:id/lock', adminAuthRequired, (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'active';
    db.setSession(session);
    user.status = 'active';
  } else {
    user.status = 'free';
  }
  db.setUser(user);

  for (const r of db.getRequests()) {
    if (r.userId === user.id && r.status === 'pending') {
      r.status = 'rejected';
      r.resolvedAt = Date.now();
      db.setRequest(r);
    }
  }

  res.json({ ok: true, user: publicUser(user) });
});

app.get('/api/admin/requests', adminAuthRequired, (_req, res) => {
  const requests = db.getRequests().sort((a, b) => b.createdAt - a.createdAt);
  res.json({ requests });
});

/* -------------------------------------------------------------------------- */
/*                              Fallback & Boot                               */
/* -------------------------------------------------------------------------- */

app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* -------------------------------------------------------------------------- */
/*                                   Server                                   */
/* -------------------------------------------------------------------------- */

const server = app.listen(PORT, () => {
  console.log(`[StudyLock] listening on http://localhost:${PORT}`);
  console.log(`[StudyLock] db file: ${process.env.DB_FILE || path.join(__dirname, 'data', 'db.json')}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

module.exports = app;
