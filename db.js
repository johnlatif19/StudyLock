'use strict';

/* -------------------------------------------------------------------------- */
/*  Firestore adapter                                                         */
/*  Uses Firebase Admin SDK. Requires FIREBASE_SERVICE_ACCOUNT in env.        */
/* -------------------------------------------------------------------------- */

const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('[FATAL] FIREBASE_SERVICE_ACCOUNT is missing.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch {
  console.error('[FATAL] FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const fs = admin.firestore();
fs.settings({ ignoreUndefinedProperties: true });

const COL = {
  users: fs.collection('users'),
  sessions: fs.collection('sessions'),
  unlockRequests: fs.collection('unlockRequests'),
};

const db = {
  /* -------- users -------- */

  async getUsers() {
    const snap = await COL.users.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async getUser(id) {
    const doc = await COL.users.doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },

  async setUser(user) {
    const { id, ...data } = user;
    await COL.users.doc(id).set(data, { merge: true });
  },

  async deleteUser(id) {
    await COL.users.doc(id).delete();
  },

  async findUserByUsername(username) {
    const snap = await COL.users.where('username', '==', username).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  },

  /* -------- sessions -------- */

  async getSessions() {
    const snap = await COL.sessions.get();
    return snap.docs.map((d) => ({ sessionId: d.id, ...d.data() }));
  },

  async getSession(id) {
    const doc = await COL.sessions.doc(id).get();
    return doc.exists ? { sessionId: doc.id, ...doc.data() } : null;
  },

  async setSession(session) {
    const { sessionId, ...data } = session;
    await COL.sessions.doc(sessionId).set(data, { merge: true });
  },

  async deleteSession(id) {
    await COL.sessions.doc(id).delete();
  },

  /* -------- unlock requests -------- */

  async getRequests() {
    const snap = await COL.unlockRequests.get();
    return snap.docs.map((d) => ({ requestId: d.id, ...d.data() }));
  },

  async getRequest(id) {
    const doc = await COL.unlockRequests.doc(id).get();
    return doc.exists ? { requestId: doc.id, ...doc.data() } : null;
  },

  async setRequest(request) {
    const { requestId, ...data } = request;
    await COL.unlockRequests.doc(requestId).set(data, { merge: true });
  },

  async deleteRequest(id) {
    await COL.unlockRequests.doc(id).delete();
  },
};

module.exports = db;
