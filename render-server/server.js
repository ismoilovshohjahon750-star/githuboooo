require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const SUPER_ADMIN_ID = parseInt(process.env.SUPER_ADMIN_ID || '8453381252', 10);

const DB_FILE = path.join(__dirname, 'data', 'smartboard_db.json');
const ONLINE_TIMEOUT_MS = 15000;
const DIVIDER = '────────────────────';
const { ensureDeployReset } = require('./scripts/reset-data');

// Har yangi deployda eski ma'lumotlarni tegi bilan tozalash
ensureDeployReset();

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// ==========================================
// YORDAMCHI FUNKSIYALAR
// ==========================================
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeId(val) {
  return String(val || '').trim().toUpperCase();
}

function stripColons(val) {
  return normalizeId(val).replace(/:/g, '');
}

function isMeaningfulMac(mac) {
  const clean = normalizeId(mac);
  return (
    clean.length >= 10 &&
    clean !== 'UNKNOWN' &&
    clean !== 'N/A' &&
    clean !== '02:00:00:00:00:00'
  );
}

function looksLikeMacOrDeviceId(val) {
  const clean = normalizeId(val);
  const macRegex = /^([0-9A-F]{2}[:\-]){5}[0-9A-F]{2}$/;
  const boardRegex = /^BOARD_[A-Z0-9_-]{3,}$/;
  return macRegex.test(clean) || boardRegex.test(clean);
}

function isValidDeviceIdInput(val) {
  const clean = normalizeId(val);
  return clean.length >= 4 && clean.length <= 64 && /^[A-Z0-9_:-]+$/.test(clean);
}

function getFormattedTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${time}/${date}`;
}

function getRoleLabel(role) {
  if (role === 'SUPER_ADMIN') return 'Bosh Super Admin';
  if (role === 'IT_ADMIN') return 'IT Admin';
  if (role === 'TEACHER') return 'O\'qituvchi';
  return 'Foydalanuvchi';
}

// ==========================================
// MA'LUMOTLAR BAZASI
// ==========================================
function loadDatabase() {
  const defaultItAdmins = [
    { id: 8223415949, name: 'Husniddin', addedAt: getFormattedTime() }
  ];

  const defaultData = {
    superAdminId: SUPER_ADMIN_ID,
    itAdmins: defaultItAdmins,
    teachers: [],
    rooms: [],
    logs: []
  };

  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed.rooms)) {
        parsed.rooms = parsed.rooms.filter(
          (r) =>
            r &&
            r.id &&
            !String(r.id).includes('Yangi') &&
            r.name !== 'Yangi xona qo\'shish' &&
            String(r.id).trim().length >= 4
        );
      }

      const mergedItAdmins = Array.isArray(parsed.itAdmins) ? [...parsed.itAdmins] : [];
      for (const admin of defaultItAdmins) {
        if (!mergedItAdmins.some((a) => Number(a.id) === Number(admin.id))) {
          mergedItAdmins.push(admin);
        }
      }

      const finalData = {
        ...defaultData,
        ...parsed,
        itAdmins: mergedItAdmins,
        superAdminId: SUPER_ADMIN_ID
      };
      saveDatabase(finalData);
      return finalData;
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

const db = loadDatabase();

function logAccess(userId, userName, role, action) {
  const entry = {
    timestamp: getFormattedTime(),
    userId: Number(userId) || 0,
    userName: userName || 'Tizim',
    role: getRoleLabel(role) || role || 'Foydalanuvchi',
    action: action || ''
  };
  db.logs.unshift(entry);
  if (db.logs.length > 500) db.logs = db.logs.slice(0, 500);
  saveDatabase(db);
}

function checkUserRole(userId) {
  const numId = Number(userId);
  if (numId === SUPER_ADMIN_ID) {
    return { isAuthorized: true, role: 'SUPER_ADMIN', name: 'Bosh Admin' };
  }
  const it = db.itAdmins.find((a) => Number(a.id) === numId);
  if (it) return { isAuthorized: true, role: 'IT_ADMIN', name: it.name };
  const t = db.teachers.find((tc) => Number(tc.id) === numId);
  if (t) return { isAuthorized: true, role: 'TEACHER', name: t.name };
  return { isAuthorized: false, role: 'UNAUTHORIZED' };
}

// ==========================================
// DOSKALAR, NAVBATLAR VA SESSIYALAR XOTIRASI
// ==========================================
const connectedBoards = new Map();
const boardQueues = new Map();
const notifiedNewBoards = new Set();
const activeLessons = new Map(); // boardKeyOrRoomId -> { chatId, teacherName, roomTitle, startedAt }
const chatStates = new Map();    // chatId -> { step, payload, updatedAt }

function resolveBoardKey(mac, boardId, hardwareId, ip) {
  const cleanMac = normalizeId(mac);
  const cleanBoardId = normalizeId(boardId);
  const cleanHwId = normalizeId(hardwareId);

  if (isMeaningfulMac(cleanMac)) {
    return cleanMac;
  }
  if (cleanBoardId && cleanBoardId !== 'UNKNOWN' && cleanBoardId !== 'N/A') {
    return cleanBoardId;
  }
  if (cleanHwId && cleanHwId !== 'UNKNOWN' && cleanHwId !== 'N/A') {
    return cleanHwId;
  }
  return `BOARD_IP_${String(ip || 'LOCAL').replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function findRoomForDevice({ mac, boardId, hardwareId, boardKey, roomName }) {
  const candidates = [boardKey, mac, boardId, hardwareId]
    .map(normalizeId)
    .filter((v) => v && v !== 'UNKNOWN' && v !== 'N/A' && v !== '02:00:00:00:00:00');
  const candidateNoColons = candidates.map(stripColons);

  const byId = db.rooms.find((r) => {
    const rId = normalizeId(r.id);
    const rBound = normalizeId(r.boundBoardKey);
    const rIdNoColon = stripColons(rId);
    return (
      candidates.includes(rId) ||
      (rBound && candidates.includes(rBound)) ||
      (rIdNoColon.length >= 6 && candidateNoColons.includes(rIdNoColon))
    );
  });
  if (byId) return byId;

  const cleanRoomName = String(roomName || '').trim().toLowerCase();
  if (cleanRoomName && cleanRoomName !== 'noma\'lum xona' && cleanRoomName !== 'biriktirilmagan') {
    return db.rooms.find(
      (r) =>
        r.name &&
        r.name.trim().toLowerCase() === cleanRoomName &&
        (!r.boundBoardKey || candidates.includes(normalizeId(r.boundBoardKey)))
    ) || null;
  }
  return null;
}

function findConnectedBoardForRoom(room) {
  if (!room) return null;
  const rId = normalizeId(room.id);
  const rBound = normalizeId(room.boundBoardKey);
  const rIdNoColon = stripColons(rId);

  if (connectedBoards.has(rId)) {
    return { key: rId, board: connectedBoards.get(rId) };
  }
  if (rBound && connectedBoards.has(rBound)) {
    return { key: rBound, board: connectedBoards.get(rBound) };
  }

  for (const [key, b] of connectedBoards.entries()) {
    const ids = [key, b.roomId, b.mac, b.boardId, b.hardwareId].map(normalizeId);
    const idsNoColon = ids.map(stripColons);
    if (
      ids.includes(rId) ||
      (rBound && ids.includes(rBound)) ||
      (rIdNoColon.length >= 6 && idsNoColon.includes(rIdNoColon))
    ) {
      return { key, board: b };
    }
  }
  return null;
}

function isBoardOnline(board, now = Date.now()) {
  return Boolean(board && now - board.lastSeen < ONLINE_TIMEOUT_MS);
}

function getUnassignedBoards() {
  const list = [];
  for (const [key, b] of connectedBoards.entries()) {
    const matched = findRoomForDevice({
      mac: b.mac,
      boardId: b.boardId,
      hardwareId: b.hardwareId,
      boardKey: key,
      roomName: b.roomName
    });
    if (!matched) {
      list.push({ key, board: b });
    }
  }
  return list;
}

function upsertRoom(rawId, rawName, addedBy, boundBoardKey = null) {
  const cleanId = normalizeId(rawId);
  const cleanName = String(rawName || '').trim();
  const existingIdx = db.rooms.findIndex(
    (r) => normalizeId(r.id) === cleanId || (stripColons(r.id).length >= 6 && stripColons(r.id) === stripColons(cleanId))
  );

  const nowStr = getFormattedTime();
  if (existingIdx !== -1) {
    db.rooms[existingIdx].id = cleanId;
    db.rooms[existingIdx].name = cleanName;
    db.rooms[existingIdx].addedBy = addedBy;
    db.rooms[existingIdx].addedAt = nowStr;
    if (boundBoardKey) db.rooms[existingIdx].boundBoardKey = normalizeId(boundBoardKey);
  } else {
    const newRoom = {
      id: cleanId,
      name: cleanName,
      addedBy,
      addedAt: nowStr
    };
    if (boundBoardKey) newRoom.boundBoardKey = normalizeId(boundBoardKey);
    db.rooms.push(newRoom);
  }
  saveDatabase(db);

  // Ulangan doskalardagi keshni ham darhol yangilash
  for (const [key, b] of connectedBoards.entries()) {
    const ids = [key, b.mac, b.boardId, b.hardwareId, b.roomId].map(normalizeId);
    if (ids.includes(cleanId) || ids.map(stripColons).includes(stripColons(cleanId))) {
      b.roomId = cleanId;
      b.roomName = cleanName;
      b.isRegistered = true;
      notifiedNewBoards.delete(key);
    }
  }
  notifiedNewBoards.delete(cleanId);
}

function enqueueCommandForTarget(target, command) {
  const cleanTarget = normalizeId(target || 'ALL');
  const isAll = cleanTarget === 'ALL' || cleanTarget === '';

  const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const baseCmd = {
    id: cmdId,
    timestamp: Date.now(),
    ...command,
    targetRoomId: cleanTarget
  };

  if (isAll) {
    const allKeys = new Set();
    for (const key of connectedBoards.keys()) allKeys.add(key);
    for (const r of db.rooms) allKeys.add(normalizeId(r.id));

    for (const key of allKeys) {
      if (!boardQueues.has(key)) boardQueues.set(key, []);
      boardQueues.get(key).push({ ...baseCmd, targetKey: key });
    }
    return baseCmd;
  }

  const matchedBoardKeys = new Set([cleanTarget]);
  const cleanTargetNoColon = stripColons(cleanTarget);

  const matchedRooms = db.rooms.filter((r) => {
    const rId = normalizeId(r.id);
    const rName = normalizeId(r.name);
    return (
      rId === cleanTarget ||
      rName === cleanTarget ||
      (cleanTargetNoColon.length >= 6 && stripColons(rId) === cleanTargetNoColon)
    );
  });

  for (const r of matchedRooms) {
    matchedBoardKeys.add(normalizeId(r.id));
    if (r.boundBoardKey) matchedBoardKeys.add(normalizeId(r.boundBoardKey));
  }

  for (const [key, b] of connectedBoards.entries()) {
    const bKey = normalizeId(key);
    const bMac = normalizeId(b.mac);
    const bBoardId = normalizeId(b.boardId);
    const bHwId = normalizeId(b.hardwareId);
    const bRoomId = normalizeId(b.roomId);
    const bRoomName = normalizeId(b.roomName);

    const matchesThisBoard =
      bKey === cleanTarget ||
      bMac === cleanTarget ||
      bBoardId === cleanTarget ||
      bHwId === cleanTarget ||
      bRoomId === cleanTarget ||
      (bRoomName && bRoomName === cleanTarget) ||
      (cleanTargetNoColon.length >= 6 &&
        [bKey, bMac, bBoardId, bRoomId].map(stripColons).includes(cleanTargetNoColon)) ||
      matchedRooms.some(
        (r) =>
          normalizeId(r.id) === bKey ||
          normalizeId(r.id) === bRoomId ||
          (bRoomName && normalizeId(r.name) === bRoomName)
      );

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

function broadcastCommand(command) {
  return enqueueCommandForTarget('ALL', command);
}

function trackActiveLesson(target, chatId, teacherName, roomTitle) {
  const cleanTarget = normalizeId(target || 'ALL');
  const sessionInfo = {
    chatId,
    teacherName,
    roomTitle,
    startedAt: Date.now()
  };
  activeLessons.set(cleanTarget, sessionInfo);
  const room = db.rooms.find((r) => normalizeId(r.id) === cleanTarget);
  if (room) {
    const found = findConnectedBoardForRoom(room);
    if (found) activeLessons.set(normalizeId(found.key), sessionInfo);
  }
}

// ==========================================
// EXPRESS SERVER SOZLAMALARI
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

let bot = null;
let is401Reported = false;
let botUsername = '';

function notifyAdminsNewBoard(boardKey, ipAddress, details = {}, force = false) {
  if (!bot) return;
  if (!force && notifiedNewBoards.has(boardKey)) return;
  notifiedNewBoards.add(boardKey);

  const macDisplay = isMeaningfulMac(details.mac) ? details.mac : boardKey;
  const text =
    `<b>[Yangi Doska] Yangi interaktiv doska aniqlandi</b>\n` +
    `${DIVIDER}\n` +
    `Qurilma ID: <code>${escapeHtml(macDisplay)}</code>\n` +
    (details.boardId && details.boardId !== macDisplay && details.boardId !== 'N/A'
      ? `Doska kodi: <code>${escapeHtml(details.boardId)}</code>\n`
      : '') +
    (ipAddress ? `IP manzil: <code>${escapeHtml(ipAddress)}</code>\n` : '') +
    `Aniqlangan vaqt: <code>${getFormattedTime()}</code>\n\n` +
    `Ushbu doskaga xona nomini biriktirish uchun quyidagi tugmani bosing:`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: 'Xona nomini kiritish', callback_data: `cmd_setup_board:${macDisplay}` }],
      [{ text: 'Doskalar holatini ko\'rish', callback_data: 'show_board_list' }]
    ]
  };

  const adminIds = new Set([SUPER_ADMIN_ID, ...db.itAdmins.map((a) => Number(a.id))]);
  for (const adminId of adminIds) {
    bot.sendMessage(adminId, text, { parse_mode: 'HTML', reply_markup: replyMarkup }).catch(() => {});
  }
}

app.get('/', (req, res) => {
  const now = Date.now();
  let onlineBoardsCount = 0;
  for (const b of connectedBoards.values()) {
    if (isBoardOnline(b, now)) onlineBoardsCount++;
  }
  res.json({
    status: 'online',
    service: 'SmartBoard 86 Locker - Render Central Server',
    time: getFormattedTime(),
    botConnected: Boolean(bot && !is401Reported),
    botUsername: botUsername || '',
    activeBoardsCount: connectedBoards.size,
    onlineBoardsCount,
    roomsCount: db.rooms.length
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/board/list', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [key, b] of connectedBoards.entries()) {
    list.push({
      key,
      ...b,
      isOnline: isBoardOnline(b, now)
    });
  }
  res.json({ boards: list, rooms: db.rooms });
});

// APK har 1.5 soniyada polling yuboradi
app.post('/api/board/poll', (req, res) => {
  const { mac, boardId, hardwareId, roomName, isLocked, secondsRemaining, teacherName, appVersion } = req.body || {};
  if (!mac && !boardId && !hardwareId) {
    return res.status(400).json({ error: 'Qurilma identifikatori talab qilinadi' });
  }

  const clientMac = normalizeId(mac);
  const clientBoardId = normalizeId(boardId);
  const clientHwId = normalizeId(hardwareId);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '';

  const boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp);
  const existingRoom = findRoomForDevice({
    mac: clientMac,
    boardId: clientBoardId,
    hardwareId: clientHwId,
    boardKey,
    roomName
  });

  const boardInfo = {
    mac: clientMac || 'N/A',
    boardId: clientBoardId || 'N/A',
    hardwareId: clientHwId || 'N/A',
    roomId: existingRoom ? existingRoom.id : boardKey,
    roomName: existingRoom ? existingRoom.name : (roomName || 'Biriktirilmagan'),
    isLocked: !!isLocked,
    secondsRemaining: Number(secondsRemaining) || 0,
    teacherName: teacherName || '',
    appVersion: appVersion || '1.0',
    lastSeen: Date.now(),
    ip: clientIp,
    isRegistered: !!existingRoom
  };

  connectedBoards.set(boardKey, boardInfo);

  if (!existingRoom) {
    notifyAdminsNewBoard(boardKey, clientIp, {
      mac: clientMac,
      boardId: clientBoardId,
      hardwareId: clientHwId
    });
  }

  const possibleKeys = [boardKey, clientMac, clientBoardId, clientHwId, existingRoom ? normalizeId(existingRoom.id) : '']
    .map(normalizeId)
    .filter(Boolean);

  let targetCmd = null;
  for (const k of possibleKeys) {
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
    registeredRoomId: existingRoom ? existingRoom.id : null,
    registeredRoomName: existingRoom ? existingRoom.name : null,
    command: targetCmd
  });
});

// Doska ekranidagi "Botga so'rov yuborish" tugmasi bosilganda
app.post('/api/board/request-registration', (req, res) => {
  const { mac, boardId, hardwareId } = req.body || {};
  if (!mac && !boardId && !hardwareId) {
    return res.status(400).json({ error: 'Qurilma identifikatori talab qilinadi' });
  }

  const clientMac = normalizeId(mac);
  const clientBoardId = normalizeId(boardId);
  const clientHwId = normalizeId(hardwareId);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '';
  const boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp);

  if (!connectedBoards.has(boardKey)) {
    connectedBoards.set(boardKey, {
      mac: clientMac || 'N/A',
      boardId: clientBoardId || 'N/A',
      hardwareId: clientHwId || 'N/A',
      roomId: boardKey,
      roomName: 'Biriktirilmagan',
      isLocked: true,
      secondsRemaining: 0,
      teacherName: '',
      appVersion: '1.0',
      lastSeen: Date.now(),
      ip: clientIp,
      isRegistered: false
    });
  }

  notifyAdminsNewBoard(
    boardKey,
    clientIp,
    { mac: clientMac, boardId: clientBoardId, hardwareId: clientHwId },
    true
  );

  res.json({ status: 'notified', boardKey });
});

// Doska ekranining o'zidan xona nomi kiritilganda serverga saqlash
app.post('/api/board/register', (req, res) => {
  const { mac, boardId, hardwareId, roomName } = req.body || {};
  const cleanRoomName = String(roomName || '').trim();
  if (cleanRoomName.length < 2) {
    return res.status(400).json({ error: 'Xona nomi kamida 2 ta belgidan iborat bo\'lishi kerak' });
  }

  const clientMac = normalizeId(mac);
  const clientBoardId = normalizeId(boardId);
  const clientHwId = normalizeId(hardwareId);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '';
  const boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp);
  const targetId = isMeaningfulMac(clientMac) ? clientMac : (clientBoardId || boardKey);

  upsertRoom(targetId, cleanRoomName, 'Doska ekrani', boardKey);
  logAccess(0, 'Doska ekrani', 'SYSTEM', `Doska ekrandan ro'yxatdan o'tdi: ${cleanRoomName} (${targetId})`);

  if (bot) {
    const adminIds = new Set([SUPER_ADMIN_ID, ...db.itAdmins.map((a) => Number(a.id))]);
    const msg =
      `<b>[Yangi Xona] Doska ekrandan ro'yxatdan o'tkazildi</b>\n` +
      `${DIVIDER}\n` +
      `Xona nomi: <b>${escapeHtml(cleanRoomName)}</b>\n` +
      `Qurilma ID: <code>${escapeHtml(targetId)}</code>\n` +
      `Vaqt: <code>${getFormattedTime()}</code>`;
    for (const adminId of adminIds) {
      bot.sendMessage(adminId, msg, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  res.json({ status: 'registered', id: targetId, roomName: cleanRoomName });
});

// 45 daqiqalik dars vaqti tugaganda doska serverga xabar beradi
app.post('/api/board/lesson-expired', (req, res) => {
  const { mac, boardId, hardwareId, roomName, teacherName } = req.body || {};
  const clientMac = normalizeId(mac);
  const clientBoardId = normalizeId(boardId);
  const clientHwId = normalizeId(hardwareId);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '';
  const boardKey = resolveBoardKey(clientMac, clientBoardId, clientHwId, clientIp);
  const existingRoom = findRoomForDevice({
    mac: clientMac,
    boardId: clientBoardId,
    hardwareId: clientHwId,
    boardKey,
    roomName
  });

  const displayRoom = existingRoom ? existingRoom.name : (roomName || boardKey);
  const lookupKeys = [boardKey, existingRoom ? normalizeId(existingRoom.id) : '', clientMac, clientBoardId, 'ALL']
    .filter(Boolean);

  let sessionInfo = null;
  let matchedKey = null;
  for (const k of lookupKeys) {
    if (activeLessons.has(k)) {
      sessionInfo = activeLessons.get(k);
      matchedKey = k;
      break;
    }
  }
  if (matchedKey) activeLessons.delete(matchedKey);

  const teacher = (sessionInfo && sessionInfo.teacherName) || teacherName || 'O\'qituvchi';
  logAccess(0, teacher, 'SYSTEM', `Dars vaqti tugadi (Avtomatik qulflandi): ${displayRoom}`);

  if (bot && sessionInfo && sessionInfo.chatId) {
    const expiredText =
      `<b>[Tugadi] Dars vaqti yakunlandi</b>\n` +
      `${DIVIDER}\n` +
      `Xona: <b>${escapeHtml(displayRoom)}</b>\n` +
      `O'qituvchi: <b>${escapeHtml(teacher)}</b>\n` +
      `Vaqt: <code>${getFormattedTime()}</code>\n\n` +
      `Doska avtomatik ravishda qulflandi va kutish rejimiga o'tkazildi.`;
    bot.sendMessage(sessionInfo.chatId, expiredText, { parse_mode: 'HTML' }).catch(() => {});
  }

  res.json({ status: 'ok' });
});

app.post('/api/board/ack', (req, res) => {
  const { commandId } = req.body || {};
  res.json({ status: 'acknowledged', commandId });
});

app.post('/api/board/unlock', (req, res) => {
  const { targetRoomId, teacherName, durationMinutes } = req.body || {};
  const target = targetRoomId || 'ALL';
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
  const target = targetRoomId || 'ALL';

  enqueueCommandForTarget(target, {
    type: 'LOCK',
    targetRoomId: target,
    reason: reason || 'Admin tomonidan qulflandi'
  });

  logAccess(0, 'Admin', 'API', `Doska qulflandi: ${target}`);
  res.json({ status: 'enqueued', targetRoomId: target });
});

// ==========================================
// TELEGRAM BOT SOZLAMALARI VA BOSH QARORGOH
// ==========================================
if (BOT_TOKEN && BOT_TOKEN.includes(':') && !BOT_TOKEN.startsWith('YOUR_')) {
  try {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('Telegram Bot muvaffaqiyatli ishga tushirildi (Polling).');
    bot
      .getMe()
      .then((me) => {
        botUsername = me && me.username ? me.username : '';
        if (botUsername) console.log(`Bot foydalanuvchi nomi: @${botUsername}`);
      })
      .catch(() => {});

    bot
      .setMyCommands([
        { command: 'start', description: 'Boshqaruv markazini ochish' },
        { command: 'status', description: 'Doskalar ro\'yxati va holati' },
        { command: 'unlock', description: 'Darsni boshlash (Doskani ochish)' },
        { command: 'lock', description: 'Doskani qulflash' },
        { command: 'extend', description: 'Dars vaqtiga +10 daqiqa qo\'shish' },
        { command: 'rooms', description: 'Xonalar ro\'yxati (Admin)' },
        { command: 'add_room', description: 'Yangi xona qo\'shish (Admin)' },
        { command: 'teachers', description: 'O\'qituvchilar ro\'yxati (Admin)' },
        { command: 'admins', description: 'IT Adminlar boshqaruvi (Super Admin)' },
        { command: 'logs', description: 'Kirish jurnali (Admin)' },
        { command: 'cancel', description: 'Joriy amalni bekor qilish' }
      ])
      .catch(() => {});
  } catch (e) {
    console.error('Telegram botni ishga tushirishda xatolik:', e.message);
  }
} else {
  console.log('-------------------------------------------------------------');
  console.log('TELEGRAM_BOT_TOKEN kiritilmagan.');
  console.log('Render.com -> Environment bo\'limida Telegram bot tokeningizni kiriting.');
  console.log('-------------------------------------------------------------');
}

if (bot) {
  bot.on('polling_error', (error) => {
    if (
      error.code === 'ETELEGRAM' &&
      (error.message.includes('401') || (error.response && error.response.statusCode === 401))
    ) {
      if (!is401Reported) {
        console.error('-------------------------------------------------------------');
        console.error('XATOLIK: Telegram Bot Token noto\'g\'ri yoki bekor qilingan (401 Unauthorized)!');
        console.error('Render.com -> Environment bo\'limida TELEGRAM_BOT_TOKEN ga yangi tokenni kiriting.');
        console.error('-------------------------------------------------------------');
        is401Reported = true;
      }
      bot.stopPolling().catch(() => {});
      return;
    }
    console.error('Telegram Polling Error:', error.code, error.message);
  });

  const MENU_BUTTONS = new Set([
    'Darsni boshlash',
    'Darsni boshlash (Ochish)',
    'Doskani qulflash',
    'Doskani qulflash (Bloklash)',
    '+10 daqiqa qo\'shish',
    'Doskalar holati',
    'Doskalar ro\'yxati va holati',
    'Xonalar ro\'yxati',
    'Yangi xona qo\'shish',
    'O\'qituvchilar',
    'Kirish jurnali',
    'IT Adminlar'
  ]);

  function buildMainKeyboard(role) {
    const keyboard = [
      [{ text: 'Darsni boshlash' }, { text: 'Doskani qulflash' }],
      [{ text: '+10 daqiqa qo\'shish' }, { text: 'Doskalar holati' }]
    ];

    if (role === 'SUPER_ADMIN' || role === 'IT_ADMIN') {
      keyboard.push([{ text: 'Xonalar ro\'yxati' }, { text: 'Yangi xona qo\'shish' }]);
      keyboard.push([{ text: 'O\'qituvchilar' }, { text: 'Kirish jurnali' }]);
    }

    if (role === 'SUPER_ADMIN') {
      keyboard.push([{ text: 'IT Adminlar' }]);
    }

    return {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    };
  }

  function getBoardStatusTag(board, now = Date.now()) {
    if (!isBoardOnline(board, now)) return '[Oflayn]';
    if (board.isLocked) return '[Onlayn | Qulfda]';
    const mins = Math.max(1, Math.ceil((Number(board.secondsRemaining) || 0) / 60));
    return `[Onlayn | Darsda: ${mins} daq]`;
  }

  async function sendOrEdit(chatId, text, replyMarkup = null, messageId = null) {
    const opts = { parse_mode: 'HTML' };
    if (replyMarkup) opts.reply_markup = replyMarkup;

    if (messageId) {
      try {
        return await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          ...opts
        });
      } catch (_) {}
    }
    return bot.sendMessage(chatId, text, opts);
  }

  async function renderBoardList(chatId, messageId = null, role = 'TEACHER') {
    const now = Date.now();
    const unassigned = getUnassignedBoards();
    let listText = `<b>SmartBoard 86 — Boshqaruv Markazi</b>\n${DIVIDER}\n`;

    if (db.rooms.length === 0 && unassigned.length === 0) {
      listText +=
        `<i>Hozircha tizimda birorta doska ro'yxatdan o'tmagan.</i>\n\n` +
        `Yangi doskani ishga tushirganingizda, bot sizga avtomatik tarzda xona nomini kiritish tugmasini yuboradi.`;
    } else {
      if (db.rooms.length > 0) {
        listText += `<b>Xonalar (${db.rooms.length} ta):</b>\n\n`;
        db.rooms.forEach((r, idx) => {
          const found = findConnectedBoardForRoom(r);
          const statusTag = getBoardStatusTag(found ? found.board : null, now);
          listText += `${idx + 1}. <b>${escapeHtml(r.name)}</b> — ${statusTag}\n`;
        });
      }
      if (unassigned.length > 0) {
        listText += `\n<b>Biriktirilmagan yangi doskalar (${unassigned.length} ta):</b>\n`;
        unassigned.forEach(({ key, board }, idx) => {
          const stateStr = isBoardOnline(board, now) ? '[Onlayn]' : '[Oflayn]';
          listText += `${idx + 1}. <code>${escapeHtml(key)}</code> — ${stateStr}\n`;
        });
      }
      listText += `\nKerakli doskani tanlang:`;
    }

    const inline_keyboard = [];
    if (db.rooms.length > 1 || connectedBoards.size > 1) {
      inline_keyboard.push([{ text: 'Barcha doskalar (HAMMASI)', callback_data: 'select_board:ALL' }]);
    }

    for (const room of db.rooms) {
      const found = findConnectedBoardForRoom(room);
      const statusTag = getBoardStatusTag(found ? found.board : null, now);
      inline_keyboard.push([
        {
          text: `${room.name} ${statusTag}`,
          callback_data: `select_board:${room.id}`
        }
      ]);
    }

    if (role === 'SUPER_ADMIN' || role === 'IT_ADMIN') {
      for (const { key } of unassigned) {
        inline_keyboard.push([
          { text: `Yangi doska: ${key} [Nom berish]`, callback_data: `cmd_setup_board:${key}` }
        ]);
      }
    }

    inline_keyboard.push([{ text: 'Ro\'yxatni yangilash', callback_data: 'show_board_list' }]);
    return sendOrEdit(chatId, listText, { inline_keyboard }, messageId);
  }

  async function renderBoardDetails(chatId, targetRoomId, messageId = null) {
    const now = Date.now();
    const isAll = targetRoomId === 'ALL';

    if (isAll) {
      let onlineCount = 0;
      for (const b of connectedBoards.values()) {
        if (isBoardOnline(b, now)) onlineCount++;
      }
      const text =
        `<b>Barcha Interaktiv Doskalar Boshqaruvi</b>\n` +
        `${DIVIDER}\n` +
        `Ro'yxatdagi xonalar: <b>${db.rooms.length} ta</b>\n` +
        `Onlayn doskalar: <b>${onlineCount} / ${connectedBoards.size} ta</b>\n\n` +
        `Amalni tanlang:`;

      const inline_keyboard = [
        [
          { text: 'Barchasini ochish (45 min)', callback_data: 'action_unlock:ALL' },
          { text: 'Barchasini qulflash', callback_data: 'action_lock:ALL' }
        ],
        [{ text: 'Barchasiga +10 daqiqa', callback_data: 'action_extend:ALL' }],
        [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
      ];
      return sendOrEdit(chatId, text, { inline_keyboard }, messageId);
    }

    const room = db.rooms.find((r) => normalizeId(r.id) === normalizeId(targetRoomId));
    const found = room
      ? findConnectedBoardForRoom(room)
      : connectedBoards.has(normalizeId(targetRoomId))
        ? { key: normalizeId(targetRoomId), board: connectedBoards.get(normalizeId(targetRoomId)) }
        : null;
    const b = found ? found.board : null;
    const online = isBoardOnline(b, now);

    const roomTitle = room ? room.name : (b && b.roomName !== 'Biriktirilmagan' ? b.roomName : targetRoomId);
    const statusStr = online
      ? b.isLocked
        ? '[Qulfda] Kutish rejimida'
        : `[Darsda] ${Math.max(1, Math.ceil((Number(b.secondsRemaining) || 0) / 60))} daqiqa qoldi\nO'qituvchi: <b>${escapeHtml(b.teacherName || 'Noma\'lum')}</b>`
      : '[Oflayn] Tarmoqqa ulanmagan';

    const text =
      `<b>Doska: ${escapeHtml(roomTitle)}</b>\n` +
      `${DIVIDER}\n` +
      `Qurilma ID: <code>${escapeHtml(targetRoomId)}</code>\n` +
      `Aloqa holati: <b>${online ? 'Onlayn (Faol)' : 'Oflayn'}</b>\n` +
      `Ekran holati: <b>${statusStr}</b>\n` +
      (b && b.ip ? `IP manzil: <code>${escapeHtml(b.ip)}</code>\n` : '') +
      `\nAmalni tanlang:`;

    const inline_keyboard = [
      [
        { text: 'Darsni boshlash (45 min)', callback_data: `action_unlock:${targetRoomId}` },
        { text: 'Doskani qulflash', callback_data: `action_lock:${targetRoomId}` }
      ],
      [{ text: '+10 daqiqa qo\'shish', callback_data: `action_extend:${targetRoomId}` }],
      [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
    ];
    return sendOrEdit(chatId, text, { inline_keyboard }, messageId);
  }

  function buildRoomSelectionKeyboard(actionPrefix, includeAll = false) {
    const inline_keyboard = [];
    const now = Date.now();

    if (includeAll && (db.rooms.length > 1 || connectedBoards.size > 1)) {
      inline_keyboard.push([{ text: 'Barcha doskalar (HAMMASI)', callback_data: `${actionPrefix}:ALL` }]);
    }

    const renderedIds = new Set();
    for (const room of db.rooms) {
      const rId = normalizeId(room.id);
      renderedIds.add(rId);
      const found = findConnectedBoardForRoom(room);
      if (found) renderedIds.add(normalizeId(found.key));
      const statusTag = getBoardStatusTag(found ? found.board : null, now);
      inline_keyboard.push([
        { text: `${room.name} ${statusTag}`, callback_data: `${actionPrefix}:${room.id}` }
      ]);
    }

    for (const [key, b] of connectedBoards.entries()) {
      const upperKey = normalizeId(key);
      if (!renderedIds.has(upperKey)) {
        renderedIds.add(upperKey);
        const statusTag = getBoardStatusTag(b, now);
        inline_keyboard.push([
          { text: `${b.roomName !== 'Biriktirilmagan' ? b.roomName : key} ${statusTag}`, callback_data: `${actionPrefix}:${key}` }
        ]);
      }
    }

    inline_keyboard.push([{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]);
    return { inline_keyboard };
  }

  async function renderRoomsManagement(chatId, messageId = null) {
    const now = Date.now();
    let msgText = `<b>Ro'yxatdagi xonalar (${db.rooms.length} ta)</b>\n${DIVIDER}\n\n`;
    const inline_keyboard = [];

    if (db.rooms.length === 0) {
      msgText += `<i>Hozircha birorta xona saqlanmagan.</i>\n\n`;
    } else {
      db.rooms.forEach((r, idx) => {
        const found = findConnectedBoardForRoom(r);
        const statusTag = getBoardStatusTag(found ? found.board : null, now);
        msgText +=
          `${idx + 1}. <b>${escapeHtml(r.name)}</b> ${statusTag}\n` +
          `   ID: <code>${escapeHtml(r.id)}</code>\n` +
          `   Qo'shgan: ${escapeHtml(r.addedBy || 'Admin')} (${escapeHtml(r.addedAt || '-')})\n\n`;
        inline_keyboard.push([
          { text: `Boshqarish: ${r.name}`, callback_data: `select_board:${r.id}` },
          { text: `O'chirish`, callback_data: `del_room:${r.id}` }
        ]);
      });
    }

    msgText += `Qo'lda qo'shish formati:\n<code>/add_room &lt;ID&gt; &lt;Xona nomi&gt;</code>`;
    inline_keyboard.push([{ text: '+ Yangi xona qo\'shish', callback_data: 'start_manual_room_add' }]);
    inline_keyboard.push([{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]);

    return sendOrEdit(chatId, msgText, { inline_keyboard }, messageId);
  }

  async function renderTeachersManagement(chatId, messageId = null) {
    let msgText = `<b>Ruxsat etilgan o'qituvchilar (${db.teachers.length} ta)</b>\n${DIVIDER}\n\n`;
    const inline_keyboard = [];

    if (db.teachers.length === 0) {
      msgText += `<i>Hozircha o'qituvchilar qo'shilmagan.</i>\n\n`;
    } else {
      db.teachers.forEach((t, idx) => {
        msgText +=
          `${idx + 1}. <b>${escapeHtml(t.name)}</b>\n` +
          `   Telegram ID: <code>${t.id}</code>\n\n`;
        inline_keyboard.push([
          { text: `O'chirish: ${t.name} (${t.id})`, callback_data: `del_teacher:${t.id}` }
        ]);
      });
    }

    msgText += `Buyruq orqali qo'shish:\n<code>/add_teacher &lt;Telegram_ID&gt; &lt;F.I.SH&gt;</code>`;
    inline_keyboard.push([{ text: '+ Yangi o\'qituvchi qo\'shish', callback_data: 'start_add_teacher' }]);
    inline_keyboard.push([{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]);

    return sendOrEdit(chatId, msgText, { inline_keyboard }, messageId);
  }

  async function renderAdminsManagement(chatId, messageId = null) {
    let msgText =
      `<b>Tizim Administratorlari</b>\n${DIVIDER}\n\n` +
      `<b>Bosh Super Admin:</b> <code>${SUPER_ADMIN_ID}</code>\n\n` +
      `<b>Tayinlangan IT Adminlar (${db.itAdmins.length} ta):</b>\n\n`;
    const inline_keyboard = [];

    if (db.itAdmins.length === 0) {
      msgText += `<i>Qo'shimcha IT Adminlar yo'q.</i>\n\n`;
    } else {
      db.itAdmins.forEach((a, idx) => {
        msgText +=
          `${idx + 1}. <b>${escapeHtml(a.name)}</b>\n` +
          `   Telegram ID: <code>${a.id}</code>\n` +
          `   Tayinlangan: <code>${escapeHtml(a.addedAt || '-')}</code>\n\n`;
        inline_keyboard.push([
          { text: `O'chirish: ${a.name} (${a.id})`, callback_data: `del_admin:${a.id}` }
        ]);
      });
    }

    msgText += `Buyruq orqali qo'shish:\n<code>/add_admin &lt;Telegram_ID&gt; &lt;Ism&gt;</code>`;
    inline_keyboard.push([{ text: '+ Yangi IT Admin qo\'shish', callback_data: 'start_add_admin' }]);
    inline_keyboard.push([{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]);

    return sendOrEdit(chatId, msgText, { inline_keyboard }, messageId);
  }

  async function saveRoomAndNotify(chatId, userId, displayName, role, targetId, roomName) {
    upsertRoom(targetId, roomName, displayName);
    logAccess(userId, displayName, role, `Yangi xona saqlandi: ${roomName} (${targetId})`);

    await bot.sendMessage(
      chatId,
      `<b>Yangi xona muvaffaqiyatli saqlandi</b>\n` +
        `${DIVIDER}\n` +
        `Xona nomi: <b>${escapeHtml(roomName)}</b>\n` +
        `Qurilma ID: <code>${escapeHtml(targetId)}</code>\n` +
        `Mas'ul: <b>${escapeHtml(displayName)}</b>\n` +
        `Vaqt: <code>${getFormattedTime()}</code>\n\n` +
        `<i>Doska tizimga muvaffaqiyatli biriktirildi.</i>`,
      { parse_mode: 'HTML', reply_markup: buildMainKeyboard(role) }
    );

    return renderBoardList(chatId, null, role);
  }

  // ==========================================
  // XABARLAR TINGLOVCHISI
  // ==========================================
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();
    if (!text) return;

    const userName =
      [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') ||
      (msg.from.username ? `@${msg.from.username}` : `Foydalanuvchi (${userId})`);

    const { isAuthorized, role, name: customName } = checkUserRole(userId);
    const displayName = customName || userName;

    if (!isAuthorized) {
      return bot.sendMessage(
        chatId,
        `Sizda ushbu tizimdan foydalanish ruxsati yo'q.\n\n` +
          `Sizning Telegram ID: <code>${userId}</code>\n\n` +
          `Ruxsat olish uchun maktab IT administratoriga murojaat qiling.`,
        { parse_mode: 'HTML' }
      );
    }

    const isCancel = text === '/cancel' || text.toLowerCase() === 'bekor qilish';
    const isMenuOrSlash = text.startsWith('/') || MENU_BUTTONS.has(text);

    if (isCancel) {
      if (chatStates.has(chatId)) {
        chatStates.delete(chatId);
        return bot.sendMessage(chatId, 'Joriy amal bekor qilindi.', {
          reply_markup: buildMainKeyboard(role)
        });
      }
      return bot.sendMessage(chatId, 'Boshqaruv paneli faol.', {
        reply_markup: buildMainKeyboard(role)
      });
    }

    // Agar foydalanuvchi menyu tugmasini yoki /buyruqni bossa, eski kiritish holati tozalanadi
    if (isMenuOrSlash && chatStates.has(chatId)) {
      chatStates.delete(chatId);
    }

    // ------------------------------------------
    // KO'P BOSQICHLI KIRITISH HOLATI (STATE MACHINE)
    // ------------------------------------------
    if (chatStates.has(chatId) && !isMenuOrSlash) {
      const state = chatStates.get(chatId);

      // 1-bosqich: Qurilma ID (MAC) qabul qilish -> 2-bosqichga o'tish
      if (state.step === 'AWAITING_MANUAL_MAC') {
        if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
          chatStates.delete(chatId);
          return bot.sendMessage(chatId, 'Bu amal faqat Adminlar uchun.');
        }
        const candidateId = normalizeId(text);
        if (!isValidDeviceIdInput(candidateId)) {
          return bot.sendMessage(
            chatId,
            `Qurilma ID formati noto'g'ri.\n\n` +
              `Faqat harflar, raqamlar, <code>:</code>, <code>-</code> va <code>_</code> ishlatilishi mumkin.\n` +
              `Misol: <code>AA:BB:CC:DD:EE:FF</code> yoki <code>BOARD_123ABC</code>\n\n` +
              `Qaytadan kiriting yoki <code>/cancel</code> yuboring:`,
            { parse_mode: 'HTML' }
          );
        }

        chatStates.set(chatId, {
          step: 'AWAITING_ROOM_NAME',
          payload: { targetId: candidateId },
          updatedAt: Date.now()
        });

        return bot.sendMessage(
          chatId,
          `<b>2-qadam: Xona nomini kiriting</b>\n` +
            `${DIVIDER}\n` +
            `Qurilma ID qabul qilindi: <code>${escapeHtml(candidateId)}</code>\n\n` +
            `Endi ushbu doska o'rnatilgan <b>xona nomini</b> yozib yuboring:\n` +
            `<i>(Masalan: 101-Fizika xonasi)</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: 'Bekor qilish', callback_data: 'cmd_cancel' }]]
            }
          }
        );
      }

      // 2-bosqich: Xona nomini qabul qilish -> Bazaga saqlash
      if (state.step === 'AWAITING_ROOM_NAME') {
        if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
          chatStates.delete(chatId);
          return bot.sendMessage(chatId, 'Bu amal faqat Adminlar uchun.');
        }
        const targetId = state.payload.targetId;
        const roomName = text.trim();

        if (roomName.length < 2) {
          return bot.sendMessage(
            chatId,
            `Xona nomi juda qisqa. Iltimos, to'liqroq yozing (masalan: <code>101-Fizika</code>) yoki <code>/cancel</code> bosing:`,
            { parse_mode: 'HTML' }
          );
        }

        if (looksLikeMacOrDeviceId(roomName)) {
          return bot.sendMessage(
            chatId,
            `Siz xona nomi o'rniga Qurilma ID (<code>${escapeHtml(roomName)}</code>) kiritdingiz.\n\n` +
              `Iltimos, hozir <code>${escapeHtml(targetId)}</code> uchun <b>xona nomini</b> yozib yuboring (masalan: <b>101-Fizika</b>):`,
            { parse_mode: 'HTML' }
          );
        }

        chatStates.delete(chatId);
        return saveRoomAndNotify(chatId, userId, displayName, role, targetId, roomName);
      }

      // O'qituvchi qo'shish (interaktiv)
      if (state.step === 'AWAITING_TEACHER_INPUT') {
        if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
          chatStates.delete(chatId);
          return bot.sendMessage(chatId, 'Bu amal faqat Adminlar uchun.');
        }
        const parts = text.split(/\s+/);
        const targetId = parseInt(parts[0], 10);
        const teacherName = parts.slice(1).join(' ').trim();
        if (!targetId || targetId <= 0 || !teacherName) {
          return bot.sendMessage(
            chatId,
            `Format noto'g'ri. Quyidagicha yuboring:\n<code>123456789 Ali Valiyev</code>\n\nYoki bekor qilish: <code>/cancel</code>`,
            { parse_mode: 'HTML' }
          );
        }

        chatStates.delete(chatId);
        const existing = db.teachers.find((t) => Number(t.id) === targetId);
        if (existing) {
          existing.name = teacherName;
        } else {
          db.teachers.push({ id: targetId, name: teacherName, addedAt: getFormattedTime() });
        }
        saveDatabase(db);
        logAccess(userId, displayName, role, `O'qituvchi qo'shildi: ${teacherName} (${targetId})`);

        await bot.sendMessage(
          chatId,
          `<b>O'qituvchi muvaffaqiyatli saqlandi</b>\n${DIVIDER}\nIsm: <b>${escapeHtml(teacherName)}</b>\nTelegram ID: <code>${targetId}</code>`,
          { parse_mode: 'HTML', reply_markup: buildMainKeyboard(role) }
        );
        return renderTeachersManagement(chatId);
      }

      // IT Admin qo'shish (interaktiv)
      if (state.step === 'AWAITING_ADMIN_INPUT') {
        if (role !== 'SUPER_ADMIN') {
          chatStates.delete(chatId);
          return bot.sendMessage(chatId, 'Bu amal faqat Bosh Super Admin uchun.');
        }
        const parts = text.split(/\s+/);
        const targetId = parseInt(parts[0], 10);
        const adminName = parts.slice(1).join(' ').trim();
        if (!targetId || targetId <= 0 || !adminName) {
          return bot.sendMessage(
            chatId,
            `Format noto'g'ri. Quyidagicha yuboring:\n<code>8223415949 Husniddin</code>\n\nYoki bekor qilish: <code>/cancel</code>`,
            { parse_mode: 'HTML' }
          );
        }

        chatStates.delete(chatId);
        const existing = db.itAdmins.find((a) => Number(a.id) === targetId);
        if (existing) {
          existing.name = adminName;
        } else {
          db.itAdmins.push({ id: targetId, name: adminName, addedAt: getFormattedTime() });
        }
        saveDatabase(db);
        logAccess(userId, displayName, role, `IT Admin tayinlandi: ${adminName} (${targetId})`);

        await bot.sendMessage(
          chatId,
          `<b>IT Admin muvaffaqiyatli tayinlandi</b>\n${DIVIDER}\nIsm: <b>${escapeHtml(adminName)}</b>\nTelegram ID: <code>${targetId}</code>`,
          { parse_mode: 'HTML', reply_markup: buildMainKeyboard(role) }
        );
        return renderAdminsManagement(chatId);
      }
    }

    // ------------------------------------------
    // ASOSIY BUYRUQLAR VA TUGMALAR
    // ------------------------------------------

    // 1. /start yoki /help
    if (text === '/start' || text === '/help') {
      const now = Date.now();
      let onlineCount = 0;
      for (const b of connectedBoards.values()) {
        if (isBoardOnline(b, now)) onlineCount++;
      }

      const msgText =
        `<b>SmartBoard 86 — Boshqaruv Markazi</b>\n` +
        `${DIVIDER}\n` +
        `Foydalanuvchi: <b>${escapeHtml(displayName)}</b>\n` +
        `Maqomingiz: <b>${getRoleLabel(role)}</b>\n` +
        `Onlayn doskalar: <b>${onlineCount} / ${connectedBoards.size} ta</b>\n` +
        `Ro'yxatdagi xonalar: <b>${db.rooms.length} ta</b>\n` +
        `Server holati: <b>Render Server Faol</b>`;

      await bot.sendMessage(chatId, msgText, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(role)
      });

      return renderBoardList(chatId, null, role);
    }

    // 2. Darsni boshlash (Ochish)
    if (
      text === 'Darsni boshlash' ||
      text === 'Darsni boshlash (Ochish)' ||
      text.toLowerCase().includes('darsni boshlash') ||
      text.toLowerCase().includes('dars boshlash') ||
      text.startsWith('/unlock') ||
      text.toLowerCase() === 'ochish'
    ) {
      const explicitArg = text.startsWith('/unlock') ? text.replace('/unlock', '').trim() : '';
      if (explicitArg) {
        const matched = db.rooms.find(
          (r) =>
            normalizeId(r.id) === normalizeId(explicitArg) ||
            r.name.toLowerCase().includes(explicitArg.toLowerCase())
        );
        if (matched) {
          enqueueCommandForTarget(matched.id, {
            type: 'UNLOCK',
            teacherName: displayName,
            durationMinutes: 45,
            targetRoomId: matched.id
          });
          trackActiveLesson(matched.id, chatId, displayName, matched.name);
          logAccess(userId, displayName, role, `Dars boshlandi: ${matched.name} (45 daqiqa)`);
          return bot.sendMessage(
            chatId,
            `<b>Interaktiv Doska ochildi</b>\n${DIVIDER}\nXona: <b>${escapeHtml(matched.name)}</b>\nO'qituvchi: <b>${escapeHtml(displayName)}</b>\nDars vaqti: <b>45 daqiqa</b>\nVaqt: <code>${getFormattedTime()}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Doskani qulflash', callback_data: `action_lock:${matched.id}` },
                    { text: '+10 daqiqa', callback_data: `action_extend:${matched.id}` }
                  ],
                  [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
                ]
              }
            }
          );
        }
      }

      if (db.rooms.length === 0 && connectedBoards.size === 0) {
        return bot.sendMessage(
          chatId,
          `<b>Hozircha ulangan doska mavjud emas</b>\n${DIVIDER}\n` +
            `Serverga hali birorta SmartBoard ilovasi ulanmagan yoki xona biriktirilmagan.\n` +
            `Doskani yoqib internetga ulang va qayta urinib ko'ring.`,
          { parse_mode: 'HTML' }
        );
      }

      if (db.rooms.length === 1 && connectedBoards.size <= 1) {
        const singleRoom = db.rooms[0];
        enqueueCommandForTarget(singleRoom.id, {
          type: 'UNLOCK',
          teacherName: displayName,
          durationMinutes: 45,
          targetRoomId: singleRoom.id
        });
        trackActiveLesson(singleRoom.id, chatId, displayName, singleRoom.name);
        logAccess(userId, displayName, role, `Dars boshlandi: ${singleRoom.name} (45 daqiqa)`);
        return bot.sendMessage(
          chatId,
          `<b>Interaktiv Doska ochildi</b>\n${DIVIDER}\n` +
            `Xona: <b>${escapeHtml(singleRoom.name)}</b>\n` +
            `O'qituvchi: <b>${escapeHtml(displayName)}</b>\n` +
            `Dars vaqti: <b>45 daqiqa</b>\n` +
            `Vaqt: <code>${getFormattedTime()}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Doskani qulflash', callback_data: `action_lock:${singleRoom.id}` },
                  { text: '+10 daqiqa', callback_data: `action_extend:${singleRoom.id}` }
                ],
                [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
              ]
            }
          }
        );
      }

      return bot.sendMessage(
        chatId,
        `<b>Qaysi xonadagi doskani ochmoqchisiz?</b>\n\nIltimos, dars o'tadigan xonangizni tanlang:`,
        {
          parse_mode: 'HTML',
          reply_markup: buildRoomSelectionKeyboard('unlock_room', false)
        }
      );
    }

    // 3. Doskani qulflash
    if (
      text === 'Doskani qulflash' ||
      text === 'Doskani qulflash (Bloklash)' ||
      text.toLowerCase().includes('qulflash') ||
      text.startsWith('/lock') ||
      text.toLowerCase() === 'qulf'
    ) {
      if (db.rooms.length === 0 && connectedBoards.size === 0) {
        return bot.sendMessage(chatId, 'Hozircha serverga ulangan doska mavjud emas.');
      }

      if (db.rooms.length === 1 && connectedBoards.size <= 1) {
        const singleRoom = db.rooms[0];
        enqueueCommandForTarget(singleRoom.id, { type: 'LOCK', targetRoomId: singleRoom.id });
        logAccess(userId, displayName, role, `Doska qulflandi: ${singleRoom.name}`);
        return bot.sendMessage(
          chatId,
          `<b>Doska qulflandi</b>\n${DIVIDER}\nXona: <b>${escapeHtml(singleRoom.name)}</b>\nMas'ul: <b>${escapeHtml(displayName)}</b>\nVaqt: <code>${getFormattedTime()}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Darsni boshlash (45 min)', callback_data: `action_unlock:${singleRoom.id}` }],
                [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
              ]
            }
          }
        );
      }

      return bot.sendMessage(
        chatId,
        `<b>Qaysi xonadagi doskani qulflamoqchisiz?</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildRoomSelectionKeyboard('lock_room', true)
        }
      );
    }

    // 4. +10 daqiqa qo'shish
    if (text === '+10 daqiqa qo\'shish' || text === '/extend' || text.includes('10 daqiqa')) {
      if (db.rooms.length === 0 && connectedBoards.size === 0) {
        return bot.sendMessage(chatId, 'Hozircha serverga ulangan doska mavjud emas.');
      }

      if (db.rooms.length === 1 && connectedBoards.size <= 1) {
        const singleRoom = db.rooms[0];
        enqueueCommandForTarget(singleRoom.id, { type: 'EXTEND', minutes: 10, targetRoomId: singleRoom.id });
        logAccess(userId, displayName, role, `+10 daqiqa qo'shildi: ${singleRoom.name}`);
        return bot.sendMessage(
          chatId,
          `<b>Dars vaqti 10 daqiqaga uzaytirildi</b>\n${DIVIDER}\nXona: <b>${escapeHtml(singleRoom.name)}</b>\nVaqt: <code>${getFormattedTime()}</code>`,
          { parse_mode: 'HTML' }
        );
      }

      return bot.sendMessage(
        chatId,
        `<b>Qaysi xonadagi darsga +10 daqiqa qo'shmoqchisiz?</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildRoomSelectionKeyboard('action_extend', true)
        }
      );
    }

    // 5. Doskalar holati
    if (text === 'Doskalar holati' || text === 'Doskalar ro\'yxati va holati' || text === '/status') {
      return renderBoardList(chatId, null, role);
    }

    // 6. Xonalar ro'yxati
    if (text === 'Xonalar ro\'yxati' || text === '/rooms') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      return renderRoomsManagement(chatId);
    }

    // 7. Yangi xona qo'shish tugmasi
    if (text === 'Yangi xona qo\'shish') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }

      const unassigned = getUnassignedBoards();
      const inline_keyboard = unassigned.map(({ key }) => [
        { text: `${key} ga xona nomi berish`, callback_data: `cmd_setup_board:${key}` }
      ]);
      inline_keyboard.push([{ text: 'Qo\'lda ID / MAC kiritish', callback_data: 'start_manual_room_add' }]);
      inline_keyboard.push([{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]);

      const body =
        unassigned.length > 0
          ? `<b>Aniqlangan yangi doskalar (${unassigned.length} ta)</b>\n${DIVIDER}\nQuyidagi doskalar tarmoqqa ulangan, ammo xona biriktirilmagan. Tanlang yoki qo'lda kiriting:`
          : `<b>Yangi xona (doska) qo'shish</b>\n${DIVIDER}\n` +
            `1. Yangi doskada SmartBoard ilovasini ishga tushiring — bot avtomatik xabar yuboradi.\n` +
            `2. Yoki quyidagi <b>"Qo'lda ID / MAC kiritish"</b> tugmasini bosib doskani 2 qadamda qo'shing.\n\n` +
            `<i>Tezkor buyruq formati:</i>\n<code>/add_room &lt;MAC_MANZIL&gt; &lt;XONA_NOMI&gt;</code>`;

      return bot.sendMessage(chatId, body, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      });
    }

    // 7.1 Qo'lda buyruq orqali xona qo'shish
    if (text.startsWith('/add_room')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const rawArgs = text.replace('/add_room', '').trim();
      if (!rawArgs) {
        chatStates.set(chatId, {
          step: 'AWAITING_MANUAL_MAC',
          payload: {},
          updatedAt: Date.now()
        });
        return bot.sendMessage(
          chatId,
          `<b>1-qadam: Qurilma ID (MAC) manzilini kiriting</b>\n${DIVIDER}\n` +
            `Doska ekranidagi Qurilma ID yoki MAC manzilni yozib yuboring:\n` +
            `<i>(Masalan: 00:1A:2B:3C:4D:5E yoki BOARD_A1B2C3)</i>\n\n` +
            `Bekor qilish: <code>/cancel</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const parts = rawArgs.split(/\s+/);
      const roomId = normalizeId(parts[0]);
      const roomName = parts.slice(1).join(' ').trim();

      if (!roomId || !isValidDeviceIdInput(roomId)) {
        return bot.sendMessage(
          chatId,
          `<b>Xona qo'shish formati:</b>\n\n<code>/add_room &lt;QURILMA_MAC_ID&gt; &lt;XONA_NOMI&gt;</code>\n\nMisol:\n<code>/add_room 00:1A:2B:3C:4D:5E 101-Fizika xonasi</code>`,
          { parse_mode: 'HTML' }
        );
      }

      if (!roomName) {
        chatStates.set(chatId, {
          step: 'AWAITING_ROOM_NAME',
          payload: { targetId: roomId },
          updatedAt: Date.now()
        });
        return bot.sendMessage(
          chatId,
          `<b>2-qadam: Xona nomini kiriting</b>\n${DIVIDER}\nQurilma ID: <code>${escapeHtml(roomId)}</code>\n\nEndi xona nomini yozib yuboring (masalan: <b>101-Fizika</b>):`,
          { parse_mode: 'HTML' }
        );
      }

      return saveRoomAndNotify(chatId, userId, displayName, role, roomId, roomName);
    }

    // 8. Xonani o'chirish
    if (text.startsWith('/del_room')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const targetId = normalizeId(text.replace('/del_room', ''));
      if (!targetId) {
        return bot.sendMessage(chatId, 'Format: <code>/del_room &lt;QURILMA_ID&gt;</code>', { parse_mode: 'HTML' });
      }
      const index = db.rooms.findIndex((r) => normalizeId(r.id) === targetId);
      if (index !== -1) {
        const removed = db.rooms.splice(index, 1)[0];
        saveDatabase(db);
        enqueueCommandForTarget(removed.id, { type: 'UNREGISTER', targetRoomId: removed.id });
        logAccess(userId, displayName, role, `Xona o'chirildi: ${removed.name} (${removed.id})`);
        return bot.sendMessage(
          chatId,
          `Xona (<b>${escapeHtml(removed.name)}</b> — <code>${escapeHtml(removed.id)}</code>) ro'yxatdan o'chirildi.`,
          { parse_mode: 'HTML' }
        );
      }
      return bot.sendMessage(chatId, `Xona topilmadi: <code>${escapeHtml(targetId)}</code>`, { parse_mode: 'HTML' });
    }

    // 9. O'qituvchilar ro'yxati
    if (text === 'O\'qituvchilar' || text === '/teachers') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      return renderTeachersManagement(chatId);
    }

    // 10. O'qituvchi qo'shish
    if (text.startsWith('/add_teacher')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const parts = text.replace('/add_teacher', '').trim().split(/\s+/);
      const targetId = parseInt(parts[0], 10);
      const teacherName = parts.slice(1).join(' ').trim();

      if (!targetId || targetId <= 0 || !teacherName) {
        return bot.sendMessage(
          chatId,
          `Format: <code>/add_teacher &lt;Telegram_ID&gt; &lt;F.I.SH&gt;</code>\nMisol:\n<code>/add_teacher 12345678 Ali Valiyev</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const existing = db.teachers.find((t) => Number(t.id) === targetId);
      if (existing) {
        existing.name = teacherName;
      } else {
        db.teachers.push({ id: targetId, name: teacherName, addedAt: getFormattedTime() });
      }
      saveDatabase(db);
      logAccess(userId, displayName, role, `O'qituvchi qo'shildi: ${teacherName} (${targetId})`);
      return bot.sendMessage(
        chatId,
        `O'qituvchi (<b>${escapeHtml(teacherName)}</b> — <code>${targetId}</code>) muvaffaqiyatli saqlandi.`,
        { parse_mode: 'HTML' }
      );
    }

    // 11. O'qituvchini o'chirish
    if (text.startsWith('/del_teacher')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const targetId = parseInt(text.replace('/del_teacher', '').trim(), 10);
      const index = db.teachers.findIndex((t) => Number(t.id) === targetId);
      if (index !== -1) {
        const removed = db.teachers.splice(index, 1)[0];
        saveDatabase(db);
        logAccess(userId, displayName, role, `O'qituvchi o'chirildi: ${removed.name} (${targetId})`);
        return bot.sendMessage(chatId, `O'qituvchi (<b>${escapeHtml(removed.name)}</b>) o'chirildi.`, { parse_mode: 'HTML' });
      }
      return bot.sendMessage(chatId, 'O\'qituvchi topilmadi.');
    }

    // 12. IT Adminlar boshqaruvi (Super Admin uchun)
    if (text === 'IT Adminlar' || text === '/admins') {
      if (role !== 'SUPER_ADMIN') {
        return bot.sendMessage(chatId, `Bu bo'lim faqat Bosh Super Admin (ID: ${SUPER_ADMIN_ID}) uchun.`);
      }
      return renderAdminsManagement(chatId);
    }

    if (text.startsWith('/add_admin')) {
      if (role !== 'SUPER_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Bosh Super Admin uchun.');
      }
      const parts = text.replace('/add_admin', '').trim().split(/\s+/);
      const targetId = parseInt(parts[0], 10);
      const adminName = parts.slice(1).join(' ').trim();

      if (!targetId || targetId <= 0 || !adminName) {
        return bot.sendMessage(
          chatId,
          `Format: <code>/add_admin &lt;Telegram_ID&gt; &lt;Ism&gt;</code>\nMisol:\n<code>/add_admin 8223415949 Husniddin</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const existing = db.itAdmins.find((a) => Number(a.id) === targetId);
      if (existing) {
        existing.name = adminName;
      } else {
        db.itAdmins.push({ id: targetId, name: adminName, addedAt: getFormattedTime() });
      }
      saveDatabase(db);
      logAccess(userId, displayName, role, `IT Admin tayinlandi: ${adminName} (${targetId})`);
      return bot.sendMessage(
        chatId,
        `IT Admin (<b>${escapeHtml(adminName)}</b> — <code>${targetId}</code>) muvaffaqiyatli tayinlandi.`,
        { parse_mode: 'HTML' }
      );
    }

    if (text.startsWith('/del_admin')) {
      if (role !== 'SUPER_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Bosh Super Admin uchun.');
      }
      const targetId = parseInt(text.replace('/del_admin', '').trim(), 10);
      const index = db.itAdmins.findIndex((a) => Number(a.id) === targetId);
      if (index !== -1) {
        const removed = db.itAdmins.splice(index, 1)[0];
        saveDatabase(db);
        logAccess(userId, displayName, role, `IT Admin o'chirildi: ${removed.name} (${targetId})`);
        return bot.sendMessage(chatId, `IT Admin (<b>${escapeHtml(removed.name)}</b>) o'chirildi.`, { parse_mode: 'HTML' });
      }
      return bot.sendMessage(chatId, 'IT Admin topilmadi.');
    }

    // 13. Kirish jurnali
    if (text === 'Kirish jurnali' || text === '/logs') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const logs = db.logs.slice(0, 15);
      if (logs.length === 0) {
        return bot.sendMessage(chatId, 'Hozircha kirish jurnali bo\'sh.');
      }
      let logMsg = `<b>Tizimga kirish jurnali (Oxirgi 15 ta)</b>\n${DIVIDER}\n\n`;
      logs.forEach((l, idx) => {
        logMsg +=
          `${idx + 1}. [<code>${escapeHtml(l.timestamp)}</code>] <b>${escapeHtml(l.userName)}</b>\n` +
          `   Amal: <i>${escapeHtml(l.action)}</i>\n\n`;
      });
      return bot.sendMessage(chatId, logMsg, { parse_mode: 'HTML' });
    }

    // Noma'lum matn bo'lsa, asosiy menyuni ko'rsatish
    return bot.sendMessage(
      chatId,
      `Buyruq tushunilmadi. Quyidagi tugmalardan foydalaning yoki <code>/start</code> bosing:`,
      { parse_mode: 'HTML', reply_markup: buildMainKeyboard(role) }
    );
  });

  // ==========================================
  // INLINE TUGMALAR (CALLBACK QUERY) TINGLOVCHISI
  // ==========================================
  bot.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat ? query.message.chat.id : query.from.id;
    const messageId = query.message ? query.message.message_id : null;
    const userId = query.from.id;
    const data = query.data || '';

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (_) {}

    const { isAuthorized, role, name: customName } = checkUserRole(userId);
    const userName =
      [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || `Foydalanuvchi (${userId})`;
    const displayName = customName || userName;

    if (!isAuthorized) {
      return bot.sendMessage(chatId, 'Sizda ushbu tizimdan foydalanish ruxsati yo\'q.');
    }

    // 1. Doskalar ro'yxatiga qaytish / Bekor qilish
    if (data === 'show_board_list' || data === 'cmd_cancel') {
      chatStates.delete(chatId);
      return renderBoardList(chatId, messageId, role);
    }

    // 2. Doskani tanlash va boshqaruv kartasi
    if (data.startsWith('select_board:')) {
      const targetRoomId = normalizeId(data.replace('select_board:', ''));
      return renderBoardDetails(chatId, targetRoomId, messageId);
    }

    // 3. Doskani ochish
    if (data.startsWith('action_unlock:') || data.startsWith('unlock_room:')) {
      const targetRoomId = normalizeId(data.replace('action_unlock:', '').replace('unlock_room:', ''));
      const isAll = targetRoomId === 'ALL';
      const room = db.rooms.find((r) => normalizeId(r.id) === targetRoomId);
      const roomTitle = isAll ? 'Barcha doskalar' : (room ? room.name : targetRoomId);

      if (isAll) {
        broadcastCommand({
          type: 'UNLOCK',
          teacherName: displayName,
          durationMinutes: 45
        });
      } else {
        enqueueCommandForTarget(targetRoomId, {
          type: 'UNLOCK',
          teacherName: displayName,
          durationMinutes: 45,
          targetRoomId
        });
      }

      trackActiveLesson(targetRoomId, chatId, displayName, roomTitle);
      logAccess(userId, displayName, role, `Dars boshlandi (Ochildi): ${roomTitle} (45 daqiqa)`);

      const confirmText =
        `<b>Interaktiv Doska ochildi</b>\n` +
        `${DIVIDER}\n` +
        `Xona: <b>${escapeHtml(roomTitle)}</b>\n` +
        `O'qituvchi: <b>${escapeHtml(displayName)}</b>\n` +
        `Dars vaqti: <b>45 daqiqa</b>\n` +
        `Vaqt: <code>${getFormattedTime()}</code>\n\n` +
        `<i>Boshqarish uchun tugmalardan foydalaning:</i>`;

      const inline_keyboard = [
        [
          { text: 'Doskani qulflash', callback_data: `action_lock:${targetRoomId}` },
          { text: '+10 daqiqa', callback_data: `action_extend:${targetRoomId}` }
        ],
        [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
      ];
      return sendOrEdit(chatId, confirmText, { inline_keyboard }, messageId);
    }

    // 4. Doskani qulflash
    if (data.startsWith('action_lock:') || data.startsWith('lock_room:')) {
      const targetRoomId = normalizeId(data.replace('action_lock:', '').replace('lock_room:', ''));
      const isAll = targetRoomId === 'ALL';
      const room = db.rooms.find((r) => normalizeId(r.id) === targetRoomId);
      const roomTitle = isAll ? 'Barcha doskalar' : (room ? room.name : targetRoomId);

      if (isAll) {
        broadcastCommand({ type: 'LOCK' });
      } else {
        enqueueCommandForTarget(targetRoomId, { type: 'LOCK', targetRoomId });
      }

      activeLessons.delete(targetRoomId);
      logAccess(userId, displayName, role, `Doska qulflandi: ${roomTitle}`);

      const confirmText =
        `<b>Doska qulflandi</b>\n` +
        `${DIVIDER}\n` +
        `Xona: <b>${escapeHtml(roomTitle)}</b>\n` +
        `Mas'ul: <b>${escapeHtml(displayName)}</b>\n` +
        `Vaqt: <code>${getFormattedTime()}</code>\n\n` +
        `<i>Qayta ochish yoki ro'yxatga qaytish:</i>`;

      const inline_keyboard = [
        [{ text: 'Darsni boshlash (45 min)', callback_data: `action_unlock:${targetRoomId}` }],
        [{ text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }]
      ];
      return sendOrEdit(chatId, confirmText, { inline_keyboard }, messageId);
    }

    // 5. Vaqt uzaytirish
    if (data.startsWith('action_extend:')) {
      const targetRoomId = normalizeId(data.replace('action_extend:', ''));
      const isAll = targetRoomId === 'ALL';
      const room = db.rooms.find((r) => normalizeId(r.id) === targetRoomId);
      const roomTitle = isAll ? 'Barcha doskalar' : (room ? room.name : targetRoomId);

      if (isAll) {
        broadcastCommand({ type: 'EXTEND', minutes: 10 });
      } else {
        enqueueCommandForTarget(targetRoomId, { type: 'EXTEND', minutes: 10, targetRoomId });
      }

      logAccess(userId, displayName, role, `+10 daqiqa qo'shildi: ${roomTitle}`);

      const confirmText =
        `<b>Dars vaqti 10 daqiqaga uzaytirildi</b>\n` +
        `${DIVIDER}\n` +
        `Xona: <b>${escapeHtml(roomTitle)}</b>\n` +
        `Mas'ul: <b>${escapeHtml(displayName)}</b>\n` +
        `Vaqt: <code>${getFormattedTime()}</code>`;

      const inline_keyboard = [
        [
          { text: 'Doskani qulflash', callback_data: `action_lock:${targetRoomId}` },
          { text: 'Doskalar ro\'yxatiga qaytish', callback_data: 'show_board_list' }
        ]
      ];
      return sendOrEdit(chatId, confirmText, { inline_keyboard }, messageId);
    }

    // 6. Yangi doskaga xona nomi kiritish (Avtomatik aniqlangan doskadan)
    if (data.startsWith('cmd_setup_board:')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const targetId = normalizeId(data.replace('cmd_setup_board:', ''));
      chatStates.set(chatId, {
        step: 'AWAITING_ROOM_NAME',
        payload: { targetId },
        updatedAt: Date.now()
      });

      return bot.sendMessage(
        chatId,
        `<b>Doskani xonaga biriktirish</b>\n` +
          `${DIVIDER}\n` +
          `Qurilma ID: <code>${escapeHtml(targetId)}</code>\n\n` +
          `Iltimos, ushbu doska o'rnatilgan <b>xona nomini</b> yozib yuboring:\n` +
          `<i>(Masalan: 101-Fizika yoki 204-Informatika)</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Bekor qilish', callback_data: 'cmd_cancel' }]]
          }
        }
      );
    }

    // 7. Qo'lda 2 bosqichli xona qo'shish (1. ID -> 2. Xona nomi)
    if (data === 'start_manual_room_add') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      chatStates.set(chatId, {
        step: 'AWAITING_MANUAL_MAC',
        payload: {},
        updatedAt: Date.now()
      });

      return bot.sendMessage(
        chatId,
        `<b>1-qadam: Qurilma ID (MAC) manzilini kiriting</b>\n` +
          `${DIVIDER}\n` +
          `Yangi xona uchun doskaning MAC manzilini yoki Qurilma ID sini yozib yuboring:\n` +
          `<i>(Masalan: 00:1A:2B:3C:4D:5E yoki BOARD_123ABC)</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Bekor qilish', callback_data: 'cmd_cancel' }]]
          }
        }
      );
    }

    // 8. Xonani inline tugma orqali o'chirish
    if (data.startsWith('del_room:')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const targetId = normalizeId(data.replace('del_room:', ''));
      const index = db.rooms.findIndex((r) => normalizeId(r.id) === targetId);
      if (index !== -1) {
        const removed = db.rooms.splice(index, 1)[0];
        saveDatabase(db);
        enqueueCommandForTarget(removed.id, { type: 'UNREGISTER', targetRoomId: removed.id });
        logAccess(userId, displayName, role, `Xona o'chirildi: ${removed.name} (${removed.id})`);
      }
      return renderRoomsManagement(chatId, messageId);
    }

    // 9. O'qituvchi qo'shish / o'chirish inline oqimi
    if (data === 'start_add_teacher') {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      chatStates.set(chatId, {
        step: 'AWAITING_TEACHER_INPUT',
        payload: {},
        updatedAt: Date.now()
      });
      return bot.sendMessage(
        chatId,
        `<b>Yangi o'qituvchi qo'shish</b>\n${DIVIDER}\n` +
          `O'qituvchining Telegram ID raqami va F.I.SH ni bitta xabarda yuboring:\n` +
          `<i>Misol:</i> <code>123456789 Ali Valiyev</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Bekor qilish', callback_data: 'cmd_cancel' }]]
          }
        }
      );
    }

    if (data.startsWith('del_teacher:')) {
      if (role !== 'SUPER_ADMIN' && role !== 'IT_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Super Admin va IT Adminlar uchun.');
      }
      const targetId = parseInt(data.replace('del_teacher:', '').trim(), 10);
      const index = db.teachers.findIndex((t) => Number(t.id) === targetId);
      if (index !== -1) {
        const removed = db.teachers.splice(index, 1)[0];
        saveDatabase(db);
        logAccess(userId, displayName, role, `O'qituvchi o'chirildi: ${removed.name} (${targetId})`);
      }
      return renderTeachersManagement(chatId, messageId);
    }

    // 10. IT Admin qo'shish / o'chirish inline oqimi (Super Admin)
    if (data === 'start_add_admin') {
      if (role !== 'SUPER_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Bosh Super Admin uchun.');
      }
      chatStates.set(chatId, {
        step: 'AWAITING_ADMIN_INPUT',
        payload: {},
        updatedAt: Date.now()
      });
      return bot.sendMessage(
        chatId,
        `<b>Yangi IT Admin tayinlash</b>\n${DIVIDER}\n` +
          `IT Admin Telegram ID raqami va ismini bitta xabarda yuboring:\n` +
          `<i>Misol:</i> <code>8223415949 Husniddin</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Bekor qilish', callback_data: 'cmd_cancel' }]]
          }
        }
      );
    }

    if (data.startsWith('del_admin:')) {
      if (role !== 'SUPER_ADMIN') {
        return bot.sendMessage(chatId, 'Bu amal faqat Bosh Super Admin uchun.');
      }
      const targetId = parseInt(data.replace('del_admin:', '').trim(), 10);
      const index = db.itAdmins.findIndex((a) => Number(a.id) === targetId);
      if (index !== -1) {
        const removed = db.itAdmins.splice(index, 1)[0];
        saveDatabase(db);
        logAccess(userId, displayName, role, `IT Admin o'chirildi: ${removed.name} (${targetId})`);
      }
      return renderAdminsManagement(chatId, messageId);
    }
  });
}

// ==========================================
// SERVERNI ISHGA TUSHIRISH
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('=========================================');
  console.log('SmartBoard Render Server ishga tushdi!');
  console.log(`Port: ${PORT}`);
  console.log(`Super Admin ID: ${SUPER_ADMIN_ID}`);
  console.log(`Baza fayli: ${DB_FILE}`);
  console.log('=========================================');
});
