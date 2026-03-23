const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e9, // 1GB — P2P sinyal mesajları için (dosyanın kendisi geçmez)
});

app.use(express.json());

// ─── IN-MEMORY STORE ───────────────────────────────────────────────
// Kullanıcılar: { userId → { username, passwordHash, socketId, online } }
const users = new Map();
// Socket → userId
const socketToUser = new Map();
// Mesaj istekleri: { requestId → { from, to, status } }
const requests = new Map();
// Mesajlar: { roomId → [ { id, from, to, type, content, timestamp, readAt } ] }
const messages = new Map();
// Bildirimler (silinmez): { userId → [ { type, from, timestamp, roomId } ] }
const notifications = new Map();
// Silme zamanlayıcıları: { messageId → timeoutRef }
const deleteTimers = new Map();

// ─── YARDIMCI FONKSİYONLAR ─────────────────────────────────────────
function generateId(prefix = "") {
  return prefix + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function getRoomId(userA, userB) {
  return [userA, userB].sort().join(":");
}

function getUser(userId) {
  return users.get(userId);
}

function getUserByUsername(username) {
  for (const [id, user] of users) {
    if (user.username.toLowerCase() === username.toLowerCase()) {
      return { id, ...user };
    }
  }
  return null;
}

function getUserBySocketId(socketId) {
  const userId = socketToUser.get(socketId);
  return userId ? { id: userId, ...users.get(userId) } : null;
}

// Mesajı sil (her iki taraftan)
function deleteMessage(roomId, messageId) {
  const roomMessages = messages.get(roomId);
  if (!roomMessages) return;
  const idx = roomMessages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  roomMessages.splice(idx, 1);
  // Her iki tarafa sil sinyali gönder
  io.to(roomId).emit("message:deleted", { roomId, messageId });
  if (deleteTimers.has(messageId)) {
    clearTimeout(deleteTimers.get(messageId));
    deleteTimers.delete(messageId);
  }
}

// Odadaki tüm mesajları sil
function deleteAllMessages(roomId, userId) {
  const roomMessages = messages.get(roomId);
  if (!roomMessages) return;
  const toDelete = roomMessages.filter((m) => m.from === userId || m.to === userId);
  toDelete.forEach((m) => {
    deleteTimers.delete(m.id);
  });
  messages.set(roomId, []);
  io.to(roomId).emit("room:cleared", { roomId });
}

// Kullanıcının tüm odalarını temizle (çıkış yapınca)
function clearUserRooms(userId) {
  for (const [roomId] of messages) {
    if (roomId.includes(userId)) {
      // Okunmuş mesajları anında sil
      const roomMessages = messages.get(roomId) || [];
      const unread = roomMessages.filter((m) => m.to === userId && !m.readAt);
      const read = roomMessages.filter((m) => m.to !== userId || m.readAt);

      // Okunmuşları anında sil
      read.forEach((m) => {
        if (deleteTimers.has(m.id)) {
          clearTimeout(deleteTimers.get(m.id));
          deleteTimers.delete(m.id);
        }
      });

      // Okunmamışlara 24 saat timer koy
      unread.forEach((m) => {
        if (!deleteTimers.has(m.id)) {
          const timer = setTimeout(() => deleteMessage(roomId, m.id), 24 * 60 * 60 * 1000);
          deleteTimers.set(m.id, timer);
        }
      });

      messages.set(roomId, unread);
      io.to(roomId).emit("room:partial_clear", {
        roomId,
        remainingIds: unread.map((m) => m.id),
      });
    }
  }
}

// ─── REST API ──────────────────────────────────────────────────────

// Kayıt
app.post("/auth/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Eksik alan" });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Kullanıcı adı 3-20 karakter olmalı" });
  if (getUserByUsername(username))
    return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });

  const userId = generateId("U");
  const displayId = "#" + crypto.randomBytes(4).toString("hex").toUpperCase();
  users.set(userId, {
    username,
    displayId,
    passwordHash: hashPassword(password),
    socketId: null,
    online: false,
    createdAt: Date.now(),
  });
  notifications.set(userId, []);

  res.json({ userId, displayId, username });
});

// Giriş
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  const found = getUserByUsername(username);
  if (!found || found.passwordHash !== hashPassword(password))
    return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });

  res.json({ userId: found.id, displayId: found.displayId, username: found.username });
});

// ID ile kullanıcı ara
app.get("/users/search", (req, res) => {
  const { displayId } = req.query;
  if (!displayId) return res.status(400).json({ error: "displayId gerekli" });
  for (const [id, user] of users) {
    if (user.displayId.toLowerCase() === displayId.toLowerCase()) {
      return res.json({
        userId: id,
        displayId: user.displayId,
        username: user.username,
        online: user.online,
      });
    }
  }
  res.status(404).json({ error: "Kullanıcı bulunamadı" });
});

// ─── SOCKET.IO ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Bağlantı:", socket.id);

  // ── KULLANICI BAĞLANTI ──
  socket.on("user:connect", ({ userId }) => {
    const user = getUser(userId);
    if (!user) return socket.emit("error", { message: "Kullanıcı bulunamadı" });

    user.socketId = socket.id;
    user.online = true;
    socketToUser.set(socket.id, userId);

    // Tüm aktif odalarına katıl
    for (const [roomId] of messages) {
      if (roomId.includes(userId)) socket.join(roomId);
    }

    socket.emit("user:connected", {
      userId,
      displayId: user.displayId,
      username: user.username,
    });

    // Online durumunu arkadaşlara bildir
    io.emit("user:online", { userId, displayId: user.displayId });
    console.log(`${user.username} (${user.displayId}) online`);
  });

  // ── MESAJ İSTEĞİ GÖNDER ──
  socket.on("request:send", ({ fromUserId, toDisplayId }) => {
    let toUser = null;
    let toUserId = null;
    for (const [id, u] of users) {
      if (u.displayId === toDisplayId) { toUser = u; toUserId = id; break; }
    }
    if (!toUser) return socket.emit("error", { message: "Kullanıcı bulunamadı" });
    if (fromUserId === toUserId) return socket.emit("error", { message: "Kendine istek gönderemezsin" });

    const requestId = generateId("R");
    requests.set(requestId, { from: fromUserId, to: toUserId, status: "pending", createdAt: Date.now() });

    socket.emit("request:sent", { requestId, toDisplayId: toUser.displayId });

    // Karşı taraf online ise bildir
    if (toUser.online && toUser.socketId) {
      const fromUser = getUser(fromUserId);
      io.to(toUser.socketId).emit("request:received", {
        requestId,
        from: { userId: fromUserId, displayId: fromUser.displayId, username: fromUser.username },
      });
    }
  });

  // ── MESAJ İSTEĞİ YANIT ──
  socket.on("request:respond", ({ requestId, accept }) => {
    const req = requests.get(requestId);
    if (!req) return socket.emit("error", { message: "İstek bulunamadı" });

    req.status = accept ? "accepted" : "rejected";
    const fromUser = getUser(req.from);
    const toUser = getUser(req.to);

    if (accept) {
      const roomId = getRoomId(req.from, req.to);
      if (!messages.has(roomId)) messages.set(roomId, []);

      // Her ikisini odaya ekle
      if (fromUser?.socketId) io.sockets.sockets.get(fromUser.socketId)?.join(roomId);
      if (toUser?.socketId) socket.join(roomId);

      io.to(roomId).emit("request:accepted", {
        requestId,
        roomId,
        users: [
          { userId: req.from, displayId: fromUser.displayId, username: fromUser.username },
          { userId: req.to, displayId: toUser.displayId, username: toUser.username },
        ],
      });
    } else {
      if (fromUser?.socketId) {
        io.to(fromUser.socketId).emit("request:rejected", { requestId });
      }
    }
  });

  // ── MESAJ GÖNDER ──
  socket.on("message:send", ({ roomId, fromUserId, toUserId, type, content }) => {
    // type: "text" | "image" | "image_timed" | "video" | "file"
    const roomMessages = messages.get(roomId);
    if (!roomMessages) return socket.emit("error", { message: "Geçersiz oda" });

    const messageId = generateId("M");
    const message = {
      id: messageId,
      from: fromUserId,
      to: toUserId,
      type,
      content, // text için string, dosya için { name, size, mimeType } + P2P handle ayrı
      timestamp: Date.now(),
      readAt: null,
      timedSeconds: type === "image_timed" ? (content.seconds || 10) : null,
    };

    roomMessages.push(message);
    io.to(roomId).emit("message:received", message);
  });

  // ── MESAJ OKUNDU ──
  socket.on("message:read", ({ roomId, messageId, readerUserId }) => {
    const roomMessages = messages.get(roomId);
    if (!roomMessages) return;

    const msg = roomMessages.find((m) => m.id === messageId);
    if (!msg || msg.readAt) return;

    msg.readAt = Date.now();
    io.to(roomId).emit("message:read_receipt", { messageId, readAt: msg.readAt });

    // Okuduktan 1 saat sonra sil
    const timer = setTimeout(() => deleteMessage(roomId, messageId), 60 * 60 * 1000);
    deleteTimers.set(messageId, timer);

    // Süreli fotoğraf: okunca süre kadar bekle sonra sil
    if (msg.type === "image_timed" && msg.timedSeconds) {
      clearTimeout(deleteTimers.get(messageId));
      const timedTimer = setTimeout(() => deleteMessage(roomId, messageId), msg.timedSeconds * 1000);
      deleteTimers.set(messageId, timedTimer);
    }
  });

  // ── P2P SİNYAL (WebRTC dosya transferi) ──
  // Sunucu sadece sinyal taşır, dosyanın kendisi geçmez
  socket.on("p2p:offer", ({ toUserId, offer, transferId, meta }) => {
    const toUser = getUser(toUserId);
    if (!toUser?.socketId) return socket.emit("p2p:error", { transferId, message: "Karşı taraf çevrimdışı" });
    io.to(toUser.socketId).emit("p2p:offer", { fromSocketId: socket.id, offer, transferId, meta });
  });

  socket.on("p2p:answer", ({ toSocketId, answer, transferId }) => {
    io.to(toSocketId).emit("p2p:answer", { answer, transferId });
  });

  socket.on("p2p:ice", ({ toSocketId, candidate }) => {
    io.to(toSocketId).emit("p2p:ice", { candidate });
  });

  socket.on("p2p:complete", ({ roomId, toUserId, meta, fromUserId }) => {
    // Transfer tamamlandı — mesaj kaydı oluştur
    const roomMessages = messages.get(roomId);
    if (!roomMessages) return;
    const messageId = generateId("M");
    const message = {
      id: messageId,
      from: fromUserId,
      to: toUserId,
      type: meta.type, // "file" | "video"
      content: { name: meta.name, size: meta.size, mimeType: meta.mimeType, p2p: true },
      timestamp: Date.now(),
      readAt: null,
    };
    roomMessages.push(message);
    io.to(roomId).emit("message:received", message);
  });

  // ── EKRAN GÖRÜNTÜSÜ BİLDİRİMİ ──
  socket.on("screenshot:taken", ({ roomId, fromUserId }) => {
    const fromUser = getUser(fromUserId);

    // Bildirim kaydet (silinmez)
    for (const [uid] of users) {
      if (roomId.includes(uid) && uid !== fromUserId) {
        const notifs = notifications.get(uid) || [];
        notifs.push({
          type: "screenshot",
          from: fromUser?.displayId,
          roomId,
          timestamp: Date.now(),
        });
        notifications.set(uid, notifs);
      }
    }

    // Odaya bildir
    socket.to(roomId).emit("screenshot:alert", {
      roomId,
      from: fromUser?.displayId,
      timestamp: Date.now(),
    });
  });

  // ── BİLDİRİMLERİ GETİR ──
  socket.on("notifications:get", ({ userId }) => {
    const notifs = notifications.get(userId) || [];
    socket.emit("notifications:list", notifs);
  });

  // ── BAĞLANTI KES ──
  socket.on("disconnect", () => {
    const user = getUserBySocketId(socket.id);
    if (!user) return;

    user.online = false;
    user.socketId = null;
    socketToUser.delete(socket.id);

    // Mesajları temizle
    clearUserRooms(user.id);

    // Offline durumunu bildir
    io.emit("user:offline", { userId: user.id, displayId: user.displayId });
    console.log(`${user.username} (${user.displayId}) offline — mesajlar temizlendi`);
  });
});

// ─── SUNUCU BAŞLAT ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Phantom backend çalışıyor → port ${PORT}`);
});
