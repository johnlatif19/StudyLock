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

app.set('trust proxy', 1);

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
/*
 *  ملاحظة: على Vercel، الملفات الثابتة تُخدَم مباشرة من الـCDN عبر vercel.json
 *  (routes → public/**). هذا الجزء يعمل فقط عند التشغيل المحلي.
 */

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
}));

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
    username: u.username ?? null,
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

async function findActiveSessionForUser(userId) {
  const sessions = await db.getSessions();
  for (const s of sessions) {
    if (s.userId !== userId) continue;
    if (s.status !== 'active' && s.status !== 'unlocked') continue;

    if (Date.now() >= s.startedAt + s.duration * 1000) {
      s.status = 'ended';
      await db.setSession(s);

      const u = await db.getUser(userId);
      if (u) {
        u.status = 'free';
        await db.setUser(u);
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

async function studentRequired(req, res, next) {
  const uid = req.headers['x-user-id'];
  if (!uid || !isValidUserId(uid)) {
    return res.status(401).json({ error: 'missing_user_id' });
  }

  try {
    const user = await db.getUser(uid);
    if (!user) {
      return res.status(401).json({ error: 'unknown_user' });
    }
    req.student = user;
    next();
  } catch (err) {
    console.error('[studentRequired]', err);
    res.status(500).json({ error: 'server_error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                                   USERS                                    */
/* -------------------------------------------------------------------------- */

app.post('/api/users/register', async (req, res) => {
  try {
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

    await db.setUser(user);
    res.status(201).json({ userId: id, user: publicUser(user) });
  } catch (err) {
    console.error('[POST /api/users/register]', err);
    res.status(500).json({ error: 'server_error' });
  }
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

app.post('/api/session/start', studentRequired, async (req, res) => {
  try {
    const user = req.student;

    const existing = await findActiveSessionForUser(user.id);
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

    await db.setSession(session);

    user.status = 'active';
    await db.setUser(user);

    res.json({ session: publicSession(session) });
  } catch (err) {
    console.error('[POST /api/session/start]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/session', studentRequired, async (req, res) => {
  try {
    const session = await findActiveSessionForUser(req.student.id);
    res.json({ session: publicSession(session) });
  } catch (err) {
    console.error('[GET /api/session]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/session/request-unlock', studentRequired, async (req, res) => {
  try {
    const user = req.student;

    const session = await findActiveSessionForUser(user.id);
    if (!session) {
      return res.status(400).json({ error: 'no_active_session' });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) {
      return res.status(400).json({ error: 'missing_reason' });
    }

    const requests = await db.getRequests();
    const existing = requests.find((r) => r.userId === user.id && r.status === 'pending');
    if (existing) {
      return res.json({ request: existing });
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

    await db.setRequest(request);
    res.json({ request });
  } catch (err) {
    console.error('[POST /api/session/request-unlock]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/session/end', studentRequired, async (req, res) => {
  try {
    const user = req.student;
    const session = await findActiveSessionForUser(user.id);
    if (session) {
      session.status = 'ended';
      await db.setSession(session);
    }
    user.status = 'free';
    await db.setUser(user);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/session/end]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------------------------------------------------------- */
/*                                   ADMIN                                    */
/* -------------------------------------------------------------------------- */

app.get('/api/admin/stats', adminAuthRequired, async (_req, res) => {
  try {
    const users = await db.getUsers();
    let active = 0;
    let unlocked = 0;

    for (const u of users) {
      const s = await findActiveSessionForUser(u.id);
      if (!s) continue;
      if (s.status === 'active') active++;
      if (s.status === 'unlocked') unlocked++;
    }

    const requests = await db.getRequests();
    const pending = requests.filter((r) => r.status === 'pending').length;

    res.json({
      users: users.length,
      activeSessions: active,
      unlockedSessions: unlocked,
      pendingRequests: pending,
    });
  } catch (err) {
    console.error('[GET /api/admin/stats]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/users', adminAuthRequired, async (_req, res) => {
  try {
    const users = await db.getUsers();
    const out = [];

    for (const u of users) {
      const s = await findActiveSessionForUser(u.id);
      out.push({
        ...publicUser(u),
        session: publicSession(s),
      });
    }

    res.json({ users: out });
  } catch (err) {
    console.error('[GET /api/admin/users]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/users', adminAuthRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 40);

    if (!name || !username) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const existing = await db.findUserByUsername(username);
    if (existing) {
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

    await db.setUser(user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    console.error('[POST /api/admin/users]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/users/:id/unlock', adminAuthRequired, async (req, res) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });

    const session = await findActiveSessionForUser(user.id);
    if (session) {
      session.status = 'unlocked';
      await db.setSession(session);
    }

    user.status = 'unlocked';
    await db.setUser(user);

    const requests = await db.getRequests();
    for (const r of requests) {
      if (r.userId === user.id && r.status === 'pending') {
        r.status = 'approved';
        r.resolvedAt = Date.now();
        await db.setRequest(r);
      }
    }

    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('[POST /api/admin/users/:id/unlock]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/users/:id/lock', adminAuthRequired, async (req, res) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });

    const session = await findActiveSessionForUser(user.id);
    if (session) {
      session.status = 'active';
      await db.setSession(session);
      user.status = 'active';
    } else {
      user.status = 'free';
    }
    await db.setUser(user);

    const requests = await db.getRequests();
    for (const r of requests) {
      if (r.userId === user.id && r.status === 'pending') {
        r.status = 'rejected';
        r.resolvedAt = Date.now();
        await db.setRequest(r);
      }
    }

    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('[POST /api/admin/users/:id/lock]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/requests', adminAuthRequired, async (_req, res) => {
  try {
    const requests = await db.getRequests();
    requests.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ requests });
  } catch (err) {
    console.error('[GET /api/admin/requests]', err);
    res.status(500).json({ error: 'server_error' });
  }
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[StudyLock] listening on http://localhost:${PORT}`);
    console.log(`[StudyLock] storage: Firestore`);
  });
}

module.exports = app;
