'use strict';

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

const defaultData = {
  users: {},
  sessions: {},
  unlockRequests: {},
};

let cache = null;

function ensureDir() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;

  ensureDir();

  if (!fs.existsSync(DB_FILE)) {
    cache = JSON.parse(JSON.stringify(defaultData));
    save();
    return cache;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    cache = {
      users: parsed.users || {},
      sessions: parsed.sessions || {},
      unlockRequests: parsed.unlockRequests || {},
    };
  } catch {
    cache = JSON.parse(JSON.stringify(defaultData));
  }
  return cache;
}

function save() {
  ensureDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

const db = {
  /* -------- users -------- */
  getUsers() {
    return Object.values(load().users);
  },
  getUser(id) {
    return load().users[id] || null;
  },
  setUser(user) {
    load().users[user.id] = user;
    save();
  },
  deleteUser(id) {
    const data = load();
    delete data.users[id];
    save();
  },
  findUserByUsername(username) {
    return Object.values(load().users).find(u => u.username === username) || null;
  },

  /* -------- sessions -------- */
  getSessions() {
    return Object.values(load().sessions);
  },
  getSession(id) {
    return load().sessions[id] || null;
  },
  setSession(session) {
    load().sessions[session.sessionId] = session;
    save();
  },
  deleteSession(id) {
    const data = load();
    delete data.sessions[id];
    save();
  },

  /* -------- unlockRequests -------- */
  getRequests() {
    return Object.values(load().unlockRequests);
  },
  getRequest(id) {
    return load().unlockRequests[id] || null;
  },
  setRequest(request) {
    load().unlockRequests[request.requestId] = request;
    save();
  },
  deleteRequest(id) {
    const data = load();
    delete data.unlockRequests[id];
    save();
  },
};

module.exports = db;