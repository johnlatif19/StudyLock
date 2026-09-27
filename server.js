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

const app = express();

/* -------------------------------------------------------------------------- */
/*                              Config & Guards                               */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET missing or too short (min 16 chars).');
  process.exit(1);
}
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('[FATAL] ADMIN_USERNAME / ADMIN_PASSWORD missing.');
  process.exit(1);
}

const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

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
/*                           In-Memory Data Store                             */
/* -------------------------------------------------------------------------- */
/*
 * Demo store. Replace with Firebase / Postgres / Mongo for production.
 */

const db = {
  users: new Map(),          // userId  -> user
  sessions: new Map(),       // sessionId -> session
  unlockRequests: new Map(), // requestId -> request
};

function seedDemoUsers() {
  const demo = [
    { name: 'Ahmed',   username: 'ahmed' },
    { name: 'Mohamed', username: 'mohamed' },
    { name: 'Ali',     username: 'ali' },
  ];
  for (const u of demo) {
    const id = 'u_' + crypto.randomBytes(6).toString('hex');
    db.users.set(id, {
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
  for (const s of db.sessions.values()) {
    if (s.userId !== userId) continue;
    if (s.status !== 'active' && s.status !== 'unlocked') continue;

    if (Date.now() >= s.startedAt + s.duration * 1000) {
      s.status = 'ended';
      const u = db.users.get(userId);
      if (u) u.status = 'free';
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

/**
 * Admin auth (JWT). Only for /api/admin/* and /api/me.
 */
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

/**
 * Student identity via X-User-Id header.
 * No password, no JWT — this is a lightweight identifier for the student UI.
 * Real authorization for the student's own session is enforced server-side
 * by matching userId against session.userId.
 */
function studentRequired(req, res, next) {
  const uid = req.headers['x-user-id'];
  if (!uid || !isValidUserId(uid)) {
    return res.status(401).json({ error: 'missing_user_id' });
  }
  const user = db.users.get(uid);
  if (!user) {
    return res.status(401).json({ error: 'unknown_user' });
  }
  req.student = user;
  next();
}

/* -------------------------------------------------------------------------- */
/*                                   USERS                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/users/register
 * Creates a student and returns their userId + user object.
 * Called by index.js on first load.
 */
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
  db.users.set(id, user);
  res.status(201).json({ userId: id, user: publicUser(user) });
});

/**
 * GET /api/users/me
 * Returns current student info from X-User-Id.
 */
app.get('/api/users/me', studentRequired, (req, res) => {
  res.json({ user: publicUser(req.student) });
});

/* -------------------------------------------------------------------------- */
/*                                   AUTH                                     */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/auth/login
 * Admin-only login. Returns JWT.
 */
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

/**
 * GET /api/me
 * Returns authenticated admin info.
 */
app.get('/api/me', adminAuthRequired, (req, res) => {
  res.json({ user: { id: 'admin', role: 'admin' } });
});

/* -------------------------------------------------------------------------- */
/*                                  SESSION                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/session/start
 * Starts a focus session for the current student.
 */
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

  db.sessions.set(sessionId, session);
  user.status = 'active';

  res.json({ session: publicSession(session) });
});

/**
 * GET /api/session
 * Returns the current active session for the student, or null.
 */
app.get('/api/session', studentRequired, (req, res) => {
  const session = findActiveSessionForUser(req.student.id);
  res.json({ session: publicSession(session) });
});

/**
 * POST /api/session/request-unlock
 * Creates an unlock request for the student's active session.
 */
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

  for (const r of db.unlockRequests.values()) {
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

  db.unlockRequests.set(requestId, request);
  res.json({ request });
});

/**
 * POST /api/session/end
 * Ends the student's active session voluntarily.
 */
app.post('/api/session/end', studentRequired, (req, res) => {
  const user = req.student;
  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'ended';
  }
  user.status = 'free';
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/*                                   ADMIN                                    */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/stats
 */
app.get('/api/admin/stats', adminAuthRequired, (_req, res) => {
  const users = [...db.users.values()];
  let active = 0;
  let unlocked = 0;

  for (const u of users) {
    const s = findActiveSessionForUser(u.id);
    if (!s) continue;
    if (s.status === 'active') active++;
    if (s.status === 'unlocked') unlocked++;
  }

  const pending = [...db.unlockRequests.values()]
    .filter(r => r.status === 'pending').length;

  res.json({
    users: users.length,
    activeSessions: active,
    unlockedSessions: unlocked,
    pendingRequests: pending,
  });
});

/**
 * GET /api/admin/users
 */
app.get('/api/admin/users', adminAuthRequired, (_req, res) => {
  const users = [...db.users.values()].map((u) => {
    const s = findActiveSessionForUser(u.id);
    return {
      ...publicUser(u),
      session: publicSession(s),
    };
  });
  res.json({ users });
});

/**
 * POST /api/admin/users
 * Creates a new student with a username.
 */
app.post('/api/admin/users', adminAuthRequired, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 40);

  if (!name || !username) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  for (const u of db.users.values()) {
    if (u.username === username) {
      return res.status(409).json({ error: 'username_taken' });
    }
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

  db.users.set(id, user);
  res.status(201).json({ user: publicUser(user) });
});

/**
 * POST /api/admin/users/:id/unlock
 * Force-unlocks a user's active session.
 */
app.post('/api/admin/users/:id/unlock', adminAuthRequired, (req, res) => {
  const user = db.users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'unlocked';
  }
  user.status = 'unlocked';

  for (const r of db.unlockRequests.values()) {
    if (r.userId === user.id && r.status === 'pending') {
      r.status = 'approved';
      r.resolvedAt = Date.now();
    }
  }

  res.json({ ok: true, user: publicUser(user) });
});

/**
 * POST /api/admin/users/:id/lock
 * Re-locks a user's session (or ends it), and rejects pending requests.
 */
app.post('/api/admin/users/:id/lock', adminAuthRequired, (req, res) => {
  const user = db.users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const session = findActiveSessionForUser(user.id);
  if (session) {
    session.status = 'active';
    user.status = 'active';
  } else {
    user.status = 'free';
  }

  for (const r of db.unlockRequests.values()) {
    if (r.userId === user.id && r.status === 'pending') {
      r.status = 'rejected';
      r.resolvedAt = Date.now();
    }
  }

  res.json({ ok: true, user: publicUser(user) });
});

/**
 * GET /api/admin/requests
 */
app.get('/api/admin/requests', adminAuthRequired, (_req, res) => {
  const requests = [...db.unlockRequests.values()]
    .sort((a, b) => b.createdAt - a.createdAt);
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
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

module.exports = app;
