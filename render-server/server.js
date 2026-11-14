require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INITIAL_ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const INITIAL_ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin1234').trim();
const INITIAL_IT_PASSWORD = (process.env.IT_ADMIN_PASSWORD || 'admin1234').trim();
const DB_FILE = path.join(__dirname, 'data', 'smartboard_db.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHex] = storedHash.split(':');
  if (!salt || !originalHex) return false;
  try {
    const derived = crypto.scryptSync(String(password), salt, 64);
    const original = Buffer.from(originalHex, 'hex');
    if (derived.length !== original.length) return false;
    return crypto.timingSafeEqual(derived, original);
  } catch (_) {
    return false;
  }
}

function normalizeUsername(raw, fallback) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  return cleaned || fallback;
}

function loadDatabase() {
  const defaultSessionSecret = crypto.randomBytes(32).toString('hex');
  const defaultItAdmins = [
    {
      id: 8223415949,
      username: 'husniddin',
      name: 'Husniddin',
      passwordHash: hashPassword(INITIAL_IT_PASSWORD),
      addedAt: getFormattedTime()
    }
  ];

  const defaultData = {
    sessionSecret: defaultSessionSecret,
    superAdmin: {
      id: 1,
      username: INITIAL_ADMIN_USERNAME || 'admin',
      name: 'Bosh Admin',
      passwordHash: hashPassword(INITIAL_ADMIN_PASSWORD)
    },
    itAdmins: defaultItAdmins,
    teachers: [],
    rooms: [],
    logs: []
  };

  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(content);
      let migrated = false;

      if (Array.isArray(parsed.rooms)) {
        parsed.rooms = parsed.rooms.filter(
          (r) => r && r.id && !r.id.includes('Yangi') && r.name !== 'Yangi xona qo\'shish' && r.id.length >= 4
        );
      } else {
        parsed.rooms = [];
      }

      if (!parsed.sessionSecret) {
        parsed.sessionSecret = defaultSessionSecret;
        migrated = true;
      }

      if (!parsed.superAdmin || !parsed.superAdmin.passwordHash) {
        parsed.superAdmin = defaultData.superAdmin;
        migrated = true;
      }

      const mergedItAdmins = Array.isArray(parsed.itAdmins) ? [...parsed.itAdmins] : [];
      for (const admin of defaultItAdmins) {
        if (!mergedItAdmins.some((a) => Number(a.id) === Number(admin.id))) {
          mergedItAdmins.push(admin);
          migrated = true;
        }
      }
      parsed.itAdmins = mergedItAdmins.map((a, idx) => {
        const next = { ...a };
        if (!next.id) {
          next.id = Date.now() + idx;
          migrated = true;
        }
        if (!next.username) {
          next.username = normalizeUsername(next.name, `itadmin${next.id}`);
          migrated = true;
        }
        if (!next.passwordHash) {
          next.passwordHash = hashPassword(INITIAL_IT_PASSWORD);
          migrated = true;
        }
        return next;
      });

      parsed.teachers = (Array.isArray(parsed.teachers) ? parsed.teachers : []).map((t, idx) => {
        const next = { ...t };
        if (!next.id) {
          next.id = Date.now() + idx;
          migrated = true;
        }
        if (!next.username) {
          next.username = normalizeUsername(next.name, `teacher${next.id}`);
          migrated = true;
        }
        if (!next.passwordHash) {
          next.passwordHash = hashPassword('123456');
          migrated = true;
        }
        return next;
      });

      if (!Array.isArray(parsed.logs)) {
        parsed.logs = [];
      }

      const finalDb = { ...defaultData, ...parsed };
      if (migrated) saveDatabase(finalDb);
      return finalDb;
    }
  } catch (err) {
    console.error('Baza yuklashda xatolik:', err);
  }

  saveDatabase(defaultData);
  return defaultData;
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Baza saqlashda xatolik:', err);
  }
}

function getFormattedTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${time}/${date}`;
}

const db = loadDatabase();
const SESSION_SECRET = (process.env.SESSION_SECRET || db.sessionSecret).trim();

function logAccess(userId, userName, role, action) {
  const entry = {
    timestamp: getFormattedTime(),
    userId: Number(userId) || 0,
    userName: userName || 'Noma\'lum',
    role: role || 'Foydalanuvchi',
    action: action || ''
  };
  db.logs.unshift(entry);
  if (db.logs.length > 500) db.logs = db.logs.slice(0, 500);
  saveDatabase(db);
}

function createSessionToken(user) {
  const payloadObj = {
    id: user.id,
    role: user.role,
    username: user.username,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function resolveUserByRoleAndId(role, id) {
  const numId = Number(id);
  if (role === 'SUPER_ADMIN' && Number(db.superAdmin.id) === numId) {
    return { ...db.superAdmin, role: 'SUPER_ADMIN' };
  }
  if (role === 'IT_ADMIN') {
    const it = db.itAdmins.find((a) => Number(a.id) === numId);
    if (it) return { ...it, role: 'IT_ADMIN' };
  }
  if (role === 'TEACHER') {
    const t = db.teachers.find((tc) => Number(tc.id) === numId);
    if (t) return { ...t, role: 'TEACHER' };
  }
  return null;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return resolveUserByRoleAndId(payload.role, payload.id);
  } catch (_) {
    return null;
  }
}

function findUserByLogin(loginInput) {
  const clean = String(loginInput || '').trim().toLowerCase();
  if (!clean) return null;

  if (db.superAdmin.username.toLowerCase() === clean) {
    return { ...db.superAdmin, role: 'SUPER_ADMIN' };
  }
  const it = db.itAdmins.find(
    (a) => (a.username && a.username.toLowerCase() === clean) || String(a.id) === clean
  );
  if (it) return { ...it, role: 'IT_ADMIN' };

  const tc = db.teachers.find(
    (t) => (t.username && t.username.toLowerCase() === clean) || String(t.id) === clean
  );
  if (tc) return { ...tc, role: 'TEACHER' };

  return null;
}

function isUsernameTaken(username, excludeRole = null, excludeId = null) {
  const clean = username.toLowerCase();
  if (
    db.superAdmin.username.toLowerCase() === clean &&
    !(excludeRole === 'SUPER_ADMIN' && Number(db.superAdmin.id) === Number(excludeId))
  ) {
    return true;
  }
  if (
    db.itAdmins.some(
      (a) => a.username.toLowerCase() === clean && !(excludeRole === 'IT_ADMIN' && Number(a.id) === Number(excludeId))
    )
  ) {
    return true;
  }
  if (
    db.teachers.some(
      (t) => t.username.toLowerCase() === clean && !(excludeRole === 'TEACHER' && Number(t.id) === Number(excludeId))
    )
  ) {
    return true;
  }
  return false;
}

function generateNumericId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

// ==========================================
// DOSKALAR VA BUYRUQLAR XOTIRASI
// ==========================================
const connectedBoards = new Map();
const boardQueues = new Map();
const newlyDetectedHistory = new Map();

function resolveBoardKey(mac, boardId, hardwareId, ip) {
  const cleanMac = (mac || '').trim().toUpperCase();
  const cleanBoardId = (boardId || '').trim().toUpperCase();
  const cleanHwId = (hardwareId || '').trim().toUpperCase();

  if (cleanMac && cleanMac !== 'UNKNOWN' && cleanMac.length >= 10 && cleanMac !== '02:00:00:00:00:00') {
    return cleanMac;
  }
  if (cleanBoardId && cleanBoardId.startsWith('BOARD_')) {
    return cleanBoardId;
  }
  if (cleanHwId && cleanHwId !== 'UNKNOWN') {
    return cleanHwId;
  }
  return cleanBoardId || cleanHwId || `BOARD_IP_${(ip || 'LOCAL').replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function enqueueCommandForTarget(target, command) {
  const cleanTarget = String(target || '').trim().toUpperCase();
  if (!cleanTarget || cleanTarget === 'ALL') {
    return null;
  }

  const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const baseCmd = {
    id: cmdId,
    timestamp: Date.now(),
    ...command,
    targetRoomId: cleanTarget
  };

  const matchedBoardKeys = new Set();
  matchedBoardKeys.add(cleanTarget);

  const matchedRooms = db.rooms.filter((r) => {
    const rId = r.id.trim().toUpperCase();
    const rName = r.name.trim().toUpperCase();
    return (
      rId === cleanTarget ||
      rName === cleanTarget ||
      rId.replace(/:/g, '') === cleanTarget.replace(/:/g, '')
    );
  });

  for (const r of matchedRooms) {
    matchedBoardKeys.add(r.id.trim().toUpperCase());
  }

  for (const [key, b] of connectedBoards.entries()) {
    const bKey = key.toUpperCase();
    const bMac = (b.mac || '').toUpperCase();
    const bBoardId = (b.boardId || '').toUpperCase();
    const bRoomName = (b.roomName || '').trim().toUpperCase();

    const matchesThisBoard =
      bKey === cleanTarget ||
      bMac === cleanTarget ||
      bBoardId === cleanTarget ||
      (bRoomName && bRoomName === cleanTarget) ||
      (bMac && bMac.replace(/:/g, '') === cleanTarget.replace(/:/g, '')) ||
      matchedRooms.some((r) => r.id.toUpperCase() === bKey || (bRoomName && r.name.trim().toUpperCase() === bRoomName));

    if (matchesThisBoard) {
      matchedBoardKeys.add(bKey);
    }
  }

  for (const k of matchedBoardKeys) {
    if (!boardQueues.has(k)) boardQueues.set(k, []);
    boardQueues.get(k).push({ ...baseCmd, targetKey: k });
  }

  return baseCmd;
}

// ==========================================
// EXPRESS SERVER SOZLAMALARI
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/webapp', express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Tizimga qayta kiring (sessiya tugagan)' });
  }
  req.authUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role
  };
  next();
}

function requireAdmin(req, res, next) {
  if (req.authUser.role !== 'SUPER_ADMIN' && req.authUser.role !== 'IT_ADMIN') {
    return res.status(403).json({ error: 'Bu amal faqat Super Admin va IT Adminlar uchun' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.authUser.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Bu amal faqat Bosh Admin (Super Admin) uchun' });
  }
  next();
}

// ==========================================
// AVTORIZATSIYA API
// ==========================================
app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Login va parolni kiriting' });
  }

  const user = findUserByLogin(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Login yoki parol noto\'g\'ri' });
  }

  const safeUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role
  };
  const token = createSessionToken(safeUser);
  logAccess(safeUser.id, safeUser.name, safeUser.role, 'Veb-saytga kirdi');
  res.json({ token, user: safeUser });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.authUser });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  if (!currentPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Joriy parol va kamida 4 belgili yangi parolni kiriting' });
  }

  const { role, id } = req.authUser;
  let targetRecord = null;
  if (role === 'SUPER_ADMIN') {
    targetRecord = db.superAdmin;
  } else if (role === 'IT_ADMIN') {
    targetRecord = db.itAdmins.find((a) => Number(a.id) === Number(id));
  } else if (role === 'TEACHER') {
    targetRecord = db.teachers.find((t) => Number(t.id) === Number(id));
  }

  if (!targetRecord || !verifyPassword(currentPassword, targetRecord.passwordHash)) {
    return res.status(400).json({ error: 'Joriy parol noto\'g\'ri' });
  }

  targetRecord.passwordHash = hashPassword(newPassword);
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, 'Parol yangilandi');
  res.json({ status: 'ok' });
});

// ==========================================
// VEB BOSHQARUV PANELI API
// ==========================================
app.get('/api/state', requireAuth, (req, res) => {
  const now = Date.now();
  const boards = [];
  const unassignedBoards = [];

  for (const [key, b] of connectedBoards.entries()) {
    const isOnline = now - b.lastSeen < 15000;
    const item = { ...b, boardKey: key, isOnline };
    boards.push(item);
    const isReg = db.rooms.some((r) => r.id.toUpperCase() === key.toUpperCase());
    if (!isReg) {
      unassignedBoards.push({
        ...item,
        detectedAt: newlyDetectedHistory.get(key) || getFormattedTime()
      });
    }
  }

  const isAdmin = req.authUser.role === 'SUPER_ADMIN' || req.authUser.role === 'IT_ADMIN';
  const isSuperAdmin = req.authUser.role === 'SUPER_ADMIN';

  const safeTeachers = isAdmin
    ? db.teachers.map((t) => ({ id: t.id, username: t.username, name: t.name, addedAt: t.addedAt }))
    : [];
  const safeItAdmins = isSuperAdmin
    ? db.itAdmins.map((a) => ({ id: a.id, username: a.username, name: a.name, addedAt: a.addedAt }))
    : [];

  res.json({
    user: req.authUser,
    serverTime: getFormattedTime(),
    rooms: db.rooms,
    boards,
    unassignedBoards: isAdmin ? unassignedBoards : [],
    teachers: safeTeachers,
    itAdmins: safeItAdmins,
    logs: isAdmin ? db.logs.slice(0, 100) : []
  });
});

app.post('/api/boards/action', requireAuth, (req, res) => {
  const { action, targetRoomId, durationMinutes } = req.body || {};
  const target = String(targetRoomId || '').trim().toUpperCase();

  if (!target || target === 'ALL') {
    return res.status(400).json({ error: 'Iltimos, aniq bitta doskani tanlang' });
  }

  const room = db.rooms.find((r) => r.id.toUpperCase() === target);
  const roomTitle = room ? room.name : target;
  const { id: userId, name: displayName, role } = req.authUser;

  if (action === 'unlock') {
    const mins = Math.min(Math.max(parseInt(durationMinutes, 10) || 45, 5), 180);
    enqueueCommandForTarget(target, {
      type: 'UNLOCK',
      teacherName: displayName,
      durationMinutes: mins,
      targetRoomId: target
    });
    logAccess(userId, displayName, role, `Dars boshlandi: ${roomTitle} (${mins} daqiqa)`);
    return res.json({ status: 'ok', durationMinutes: mins });
  }

  if (action === 'lock') {
    enqueueCommandForTarget(target, { type: 'LOCK', targetRoomId: target });
    logAccess(userId, displayName, role, `Doska qulflandi: ${roomTitle}`);
    return res.json({ status: 'ok' });
  }

  if (action === 'extend') {
    enqueueCommandForTarget(target, { type: 'EXTEND', minutes: 10, targetRoomId: target });
    logAccess(userId, displayName, role, `+10 daqiqa qo'shildi: ${roomTitle}`);
    return res.json({ status: 'ok' });
  }

  return res.status(400).json({ error: 'Noto\'g\'ri amal' });
});

// Xonalar CRUD
app.post('/api/rooms', requireAuth, requireAdmin, (req, res) => {
  const roomId = String(req.body?.id || '').trim().toUpperCase();
  const roomName = String(req.body?.name || '').trim();
  if (!roomId || roomId.length < 4 || roomName.length < 2) {
    return res.status(400).json({ error: 'Qurilma ID (kamida 4 belgi) va xona nomi (kamida 2 belgi) kiritilishi kerak' });
  }

  const existing = db.rooms.find((r) => r.id.toUpperCase() === roomId);
  if (existing) {
    existing.name = roomName;
    existing.addedBy = req.authUser.name;
    existing.addedAt = getFormattedTime();
  } else {
    db.rooms.push({
      id: roomId,
      name: roomName,
      addedBy: req.authUser.name,
      addedAt: getFormattedTime()
    });
  }
  newlyDetectedHistory.delete(roomId);
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `Xona saqlandi: ${roomName} (${roomId})`);
  res.json({ status: 'ok' });
});

app.put('/api/rooms/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = String(req.params.id || '').trim().toUpperCase();
  const roomName = String(req.body?.name || '').trim();
  if (roomName.length < 2) {
    return res.status(400).json({ error: 'Xona nomi kamida 2 belgidan iborat bo\'lishi kerak' });
  }
  const existing = db.rooms.find((r) => r.id.toUpperCase() === targetId);
  if (!existing) {
    return res.status(404).json({ error: 'Xona topilmadi' });
  }
  const oldName = existing.name;
  existing.name = roomName;
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `Xona tahrirlandi: ${oldName} -> ${roomName}`);
  res.json({ status: 'ok' });
});

app.delete('/api/rooms/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = String(req.params.id || '').trim().toUpperCase();
  const idx = db.rooms.findIndex((r) => r.id.toUpperCase() === targetId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Xona topilmadi' });
  }
  const removed = db.rooms.splice(idx, 1)[0];
  boardQueues.delete(targetId);
  newlyDetectedHistory.delete(targetId);
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `Xona o'chirildi: ${removed.name}`);
  res.json({ status: 'ok' });
});

app.delete('/api/rooms', requireAuth, requireAdmin, (req, res) => {
  const count = db.rooms.length;
  db.rooms = [];
  connectedBoards.clear();
  boardQueues.clear();
  newlyDetectedHistory.clear();
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `Barcha doskalar tizimdan butunlay o'chirildi (${count} ta)`);
  res.json({ status: 'ok', deletedCount: count });
});

// O'qituvchilar CRUD
app.post('/api/teachers', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = normalizeUsername(req.body?.username, '');
  const password = String(req.body?.password || '').trim();

  if (!name || !username || password.length < 4) {
    return res.status(400).json({ error: 'F.I.SH, login va kamida 4 belgili parol kiritilishi kerak' });
  }
  if (isUsernameTaken(username)) {
    return res.status(400).json({ error: 'Ushbu login allaqachon band' });
  }

  const newTeacher = {
    id: generateNumericId(),
    username,
    name,
    passwordHash: hashPassword(password),
    addedAt: getFormattedTime()
  };
  db.teachers.push(newTeacher);
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `O'qituvchi qo'shildi: ${name} (@${username})`);
  res.json({ status: 'ok' });
});

app.put('/api/teachers/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const teacher = db.teachers.find((t) => Number(t.id) === targetId);
  if (!teacher) {
    return res.status(404).json({ error: 'O\'qituvchi topilmadi' });
  }

  const name = String(req.body?.name || teacher.name).trim();
  const username = req.body?.username ? normalizeUsername(req.body.username, teacher.username) : teacher.username;
  const password = String(req.body?.password || '').trim();

  if (!name || !username) {
    return res.status(400).json({ error: 'F.I.SH va login bo\'sh bo\'lmasligi kerak' });
  }
  if (isUsernameTaken(username, 'TEACHER', targetId)) {
    return res.status(400).json({ error: 'Ushbu login allaqachon band' });
  }
  if (password && password.length < 4) {
    return res.status(400).json({ error: 'Yangi parol kamida 4 belgidan iborat bo\'lishi kerak' });
  }

  teacher.name = name;
  teacher.username = username;
  if (password) {
    teacher.passwordHash = hashPassword(password);
  }
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `O'qituvchi yangilandi: ${name}`);
  res.json({ status: 'ok' });
});

app.delete('/api/teachers/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const idx = db.teachers.findIndex((t) => Number(t.id) === targetId);
  if (idx === -1) {
    return res.status(404).json({ error: 'O\'qituvchi topilmadi' });
  }
  const removed = db.teachers.splice(idx, 1)[0];
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `O'qituvchi o'chirildi: ${removed.name}`);
  res.json({ status: 'ok' });
});

// IT Adminlar CRUD (Faqat Bosh Admin uchun)
app.post('/api/it-admins', requireAuth, requireSuperAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = normalizeUsername(req.body?.username, '');
  const password = String(req.body?.password || '').trim();

  if (!name || !username || password.length < 4) {
    return res.status(400).json({ error: 'F.I.SH, login va kamida 4 belgili parol kiritilishi kerak' });
  }
  if (isUsernameTaken(username)) {
    return res.status(400).json({ error: 'Ushbu login allaqachon band' });
  }

  db.itAdmins.push({
    id: generateNumericId(),
    username,
    name,
    passwordHash: hashPassword(password),
    addedAt: getFormattedTime()
  });
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `IT Admin qo'shildi: ${name} (@${username})`);
  res.json({ status: 'ok' });
});

app.put('/api/it-admins/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const admin = db.itAdmins.find((a) => Number(a.id) === targetId);
  if (!admin) {
    return res.status(404).json({ error: 'IT Admin topilmadi' });
  }

  const name = String(req.body?.name || admin.name).trim();
  const username = req.body?.username ? normalizeUsername(req.body.username, admin.username) : admin.username;
  const password = String(req.body?.password || '').trim();

  if (!name || !username) {
    return res.status(400).json({ error: 'F.I.SH va login bo\'sh bo\'lmasligi kerak' });
  }
  if (isUsernameTaken(username, 'IT_ADMIN', targetId)) {
    return res.status(400).json({ error: 'Ushbu login allaqachon band' });
  }
  if (password && password.length < 4) {
    return res.status(400).json({ error: 'Yangi parol kamida 4 belgidan iborat bo\'lishi kerak' });
  }

  admin.name = name;
  admin.username = username;
  if (password) {
    admin.passwordHash = hashPassword(password);
  }
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `IT Admin yangilandi: ${name}`);
  res.json({ status: 'ok' });
});

app.delete('/api/it-admins/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const idx = db.itAdmins.findIndex((a) => Number(a.id) === targetId);
  if (idx === -1) {
    return res.status(404).json({ error: 'IT Admin topilmadi' });
  }
  const removed = db.itAdmins.splice(idx, 1)[0];
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, `IT Admin o'chirildi: ${removed.name}`);
  res.json({ status: 'ok' });
});

app.delete('/api/logs', requireAuth, requireSuperAdmin, (req, res) => {
  db.logs = [];
  saveDatabase(db);
  logAccess(req.authUser.id, req.authUser.name, req.authUser.role, 'Jurnal tozalandi');
  res.json({ status: 'ok' });
});

// ==========================================
// DOSKA APK UCHUN API ENDPOINTLARI
// ==========================================
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'SmartBoard 86 Locker - Web Control Platform',
    time: getFormattedTime(),
    activeBoardsCount: connectedBoards.size,
    roomsCount: db.rooms.length
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/board/list', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [, b] of connectedBoards.entries()) {
    const isOnline = now - b.lastSeen < 15000;
    list.push({ ...b, isOnline });
  }
  res.json({ boards: list, rooms: db.rooms });
});

app.post('/api/board/poll', (req, res) => {
  const { mac, boardId, hardwareId, roomName, isLocked, secondsRemaining, teacherName, appVersion } = req.body || {};
  if (!mac && !boardId && !hardwareId) {
    return res.status(400).json({ error: 'Qurilma identifikatori talab qilinadi' });
  }

  const clientMac = (mac || '').trim().toUpperCase();
  const clientBoardId = (boardId || '').trim().toUpperCase();
  const clientHwId = (hardwareId || '').trim().toUpperCase();
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '';

  const boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp);

  const existingRoom = db.rooms.find((r) => {
    const rId = r.id.trim().toUpperCase();
    const rIdNoColon = rId.replace(/:/g, '');
    const macNoColon = clientMac.replace(/:/g, '');
    return (
      rId === boardKey ||
      (clientMac && rId === clientMac) ||
      (clientBoardId && rId === clientBoardId) ||
      (clientHwId && rId === clientHwId) ||
      (macNoColon && rIdNoColon === macNoColon) ||
      (r.name && roomName && r.name.trim().toLowerCase() === roomName.trim().toLowerCase())
    );
  });

  const boardInfo = {
    mac: clientMac || 'N/A',
    boardId: clientBoardId || 'N/A',
    hardwareId: clientHwId || 'N/A',
    roomId: existingRoom ? existingRoom.id : boardKey,
    roomName: existingRoom ? existingRoom.name : (roomName || 'Noma\'lum xona'),
    isLocked: !!isLocked,
    secondsRemaining: Number(secondsRemaining) || 0,
    teacherName: teacherName || '',
    appVersion: appVersion || '1.0',
    lastSeen: Date.now(),
    ip: clientIp,
    isRegistered: !!existingRoom
  };

  connectedBoards.set(boardKey, boardInfo);

  if (!existingRoom && !newlyDetectedHistory.has(boardKey)) {
    newlyDetectedHistory.set(boardKey, getFormattedTime());
  }

  const myPossibleKeys = [boardKey];
  if (clientMac) myPossibleKeys.push(clientMac);
  if (clientBoardId) myPossibleKeys.push(clientBoardId);
  if (existingRoom) myPossibleKeys.push(existingRoom.id.toUpperCase());

  let targetCmd = null;
  for (const k of myPossibleKeys) {
    const q = boardQueues.get(k);
    if (q && q.length > 0) {
      targetCmd = q.shift();
      if (q.length === 0) boardQueues.delete(k);
      break;
    }
  }

  res.json({
    status: 'ok',
    serverTime: getFormattedTime(),
    isRegistered: !!existingRoom,
    registeredRoomName: existingRoom ? existingRoom.name : null,
    command: targetCmd
  });
});

app.post('/api/board/ack', (req, res) => {
  const { commandId } = req.body || {};
  res.json({ status: 'acknowledged', commandId });
});

app.post('/api/board/unlock', (req, res) => {
  const { targetRoomId, teacherName, durationMinutes } = req.body || {};
  const target = String(targetRoomId || '').trim().toUpperCase();
  if (!target || target === 'ALL') {
    return res.status(400).json({ error: 'Aniq targetRoomId ko\'rsatilishi shart' });
  }
  const duration = Number(durationMinutes) || 45;
  const teacher = teacherName || 'Mas\'ul O\'qituvchi';

  enqueueCommandForTarget(target, {
    type: 'UNLOCK',
    teacherName: teacher,
    durationMinutes: duration,
    targetRoomId: target
  });

  logAccess(0, teacher, 'API', `Doska ochildi: ${target} (${duration} daqiqa)`);
  res.json({ status: 'enqueued', targetRoomId: target, durationMinutes: duration });
});

app.post('/api/board/lock', (req, res) => {
  const { targetRoomId, reason } = req.body || {};
  const target = String(targetRoomId || '').trim().toUpperCase();
  if (!target || target === 'ALL') {
    return res.status(400).json({ error: 'Aniq targetRoomId ko\'rsatilishi shart' });
  }

  enqueueCommandForTarget(target, {
    type: 'LOCK',
    targetRoomId: target,
    reason: reason || 'Admin tomonidan qulflandi'
  });

  logAccess(0, 'Admin', 'API', `Doska qulflandi: ${target}`);
  res.json({ status: 'enqueued', targetRoomId: target });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('=========================================');
  console.log('SmartBoard 86 Veb Boshqaruv Platformasi ishga tushdi');
  console.log(`Port: ${PORT}`);
  console.log(`Baza fayli: ${DB_FILE}`);
  console.log('=========================================');
});
