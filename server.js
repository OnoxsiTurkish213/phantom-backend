const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.json());

// ── Firebase başlat ────────────────────────────────────────────
// Firebase Console'dan aldığın service account JSON'ını buraya yapıştır
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT env değişkeni eksik!');
}

const db = () => admin.firestore();

// ── In-memory: sadece aktif socket bağlantıları ────────────────
// userId → socketId (sadece online olanlar)
const onlineUsers = new Map();
const socketToUser = new Map();

// ── Yardımcı ──────────────────────────────────────────────────
function generateId(prefix = '') {
  return prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'phantom_salt_2024').digest('hex');
}

function getRoomId(a, b) {
  return [a, b].sort().join(':');
}

// ── REST API ──────────────────────────────────────────────────

// Kayıt
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Eksik alan' });
    if (username.length < 3 || username.length > 20)
      return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });

    // Kullanıcı adı müsait mi?
    const existing = await db().collection('users')
      .where('username', '==', username.toLowerCase())
      .get();

    if (!existing.empty) {
      return res.status(409).json({ error: 'Bu kullanıcı adı alınmış' });
    }

    const userId    = generateId('U');
    const displayId = '#' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db().collection('users').doc(userId).set({
      userId,
      username: username.toLowerCase(),
      displayName: username,
      displayId,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
    });

    res.json({ userId, displayId, username: username.toLowerCase() });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Giriş
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Eksik alan' });

    const snap = await db().collection('users')
      .where('username', '==', username.toLowerCase())
      .get();

    if (snap.empty) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }

    const user = snap.docs[0].data();
    if (user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }

    res.json({
      userId: user.userId,
      displayId: user.displayId,
      username: user.username,
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kullanıcı ara (#ID ile)
app.get('/users/search', async (req, res) => {
  try {
    const { displayId } = req.query;
    if (!displayId) return res.status(400).json({ error: 'displayId gerekli' });

    const snap = await db().collection('users')
      .where('displayId', '==', displayId.toUpperCase())
      .get();

    if (snap.empty) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    const user = snap.docs[0].data();
    res.json({
      userId:    user.userId,
      displayId: user.displayId,
      username:  user.username,
      online:    onlineUsers.has(user.userId),
    });
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Arkadaş listesi (kabul edilmiş istekler)
app.get('/friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await db().collection('requests')
      .where('status', '==', 'accepted')
      .get();

    const friends = [];
    for (const doc of snap.docs) {
      const r = doc.data();
      if (r.from === userId || r.to === userId) {
        const friendId = r.from === userId ? r.to : r.from;
        const uSnap = await db().collection('users').doc(friendId).get();
        if (uSnap.exists) {
          const u = uSnap.data();
          friends.push({
            userId:    u.userId,
            username:  u.username,
            displayId: u.displayId,
            roomId:    getRoomId(userId, friendId),
            online:    onlineUsers.has(friendId),
          });
        }
      }
    }
    res.json(friends);
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Bağlan
  socket.on('user:connect', async ({ userId }) => {
    try {
      const uSnap = await db().collection('users').doc(userId).get();
      if (!uSnap.exists) return socket.emit('error', { message: 'Kullanıcı bulunamadı' });

      const user = uSnap.data();
      onlineUsers.set(userId, socket.id);
      socketToUser.set(socket.id, userId);

      // Aktif oda bağlantıları
      const reqSnap = await db().collection('requests')
        .where('status', '==', 'accepted')
        .get();

      for (const doc of reqSnap.docs) {
        const r = doc.data();
        if (r.from === userId || r.to === userId) {
          socket.join(getRoomId(r.from, r.to));
        }
      }

      socket.emit('user:connected', {
        userId, displayId: user.displayId, username: user.username,
      });

      io.emit('user:online', { userId, displayId: user.displayId });
    } catch (e) {
      console.error('user:connect error:', e);
    }
  });

  // İstek gönder
  socket.on('request:send', async ({ fromUserId, toDisplayId }) => {
    try {
      // Hedef kullanıcıyı bul
      const snap = await db().collection('users')
        .where('displayId', '==', toDisplayId.toUpperCase())
        .get();
      if (snap.empty) return socket.emit('error', { message: 'Kullanıcı bulunamadı' });

      const toUser   = snap.docs[0].data();
      const toUserId = toUser.userId;

      if (fromUserId === toUserId) return socket.emit('error', { message: 'Kendine istek gönderemezsin' });

      // Zaten istek var mı veya arkadaş mı?
      const existing = await db().collection('requests')
        .where('from', 'in', [fromUserId, toUserId])
        .get();

      for (const doc of existing.docs) {
        const r = doc.data();
        const pair = (r.from === fromUserId && r.to === toUserId) ||
                     (r.from === toUserId   && r.to === fromUserId);
        if (pair) {
          if (r.status === 'accepted') {
            return socket.emit('error', { message: 'Zaten arkadaşsınız' });
          }
          if (r.status === 'pending') {
            return socket.emit('error', { message: 'İstek zaten gönderildi' });
          }
        }
      }

      const requestId = generateId('R');
      const fromSnap  = await db().collection('users').doc(fromUserId).get();
      const fromUser  = fromSnap.data();

      await db().collection('requests').doc(requestId).set({
        requestId,
        from: fromUserId,
        to:   toUserId,
        status: 'pending',
        createdAt: Date.now(),
      });

      socket.emit('request:sent', { requestId, toDisplayId: toUser.displayId });

      // Karşı taraf online ise bildir
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) {
        io.to(toSocketId).emit('request:received', {
          requestId,
          from: {
            userId:    fromUserId,
            displayId: fromUser.displayId,
            username:  fromUser.username,
          },
        });
      }
    } catch (e) {
      console.error('request:send error:', e);
    }
  });

  // İsteği yanıtla
  socket.on('request:respond', async ({ requestId, accept }) => {
    try {
      const rSnap = await db().collection('requests').doc(requestId).get();
      if (!rSnap.exists) return socket.emit('error', { message: 'İstek bulunamadı' });

      const req = rSnap.data();
      const status = accept ? 'accepted' : 'rejected';

      await db().collection('requests').doc(requestId).update({ status });

      const fromSnap = await db().collection('users').doc(req.from).get();
      const toSnap   = await db().collection('users').doc(req.to).get();
      const fromUser = fromSnap.data();
      const toUser   = toSnap.data();

      if (accept) {
        const roomId = getRoomId(req.from, req.to);

        // Her ikisini odaya al
        const fromSocketId = onlineUsers.get(req.from);
        if (fromSocketId) io.sockets.sockets.get(fromSocketId)?.join(roomId);
        socket.join(roomId);

        const payload = {
          requestId, roomId,
          users: [
            { userId: req.from, displayId: fromUser.displayId, username: fromUser.username },
            { userId: req.to,   displayId: toUser.displayId,   username: toUser.username },
          ],
        };

        io.to(roomId).emit('request:accepted', payload);
      } else {
        const fromSocketId = onlineUsers.get(req.from);
        if (fromSocketId) io.to(fromSocketId).emit('request:rejected', { requestId });
      }
    } catch (e) {
      console.error('request:respond error:', e);
    }
  });

  // Mesaj gönder
  socket.on('message:send', async ({ roomId, fromUserId, toUserId, type, content }) => {
    try {
      const messageId = generateId('M');
      const message = {
        id: messageId,
        roomId,
        from: fromUserId,
        to:   toUserId,
        type,
        content,
        timestamp: Date.now(),
        readAt: null,
        status: 'sent',
      };

      // Firestore'a kaydet (geçici — silme mantığı aşağıda)
      await db().collection('messages').doc(messageId).set(message);

      // Odaya ilet
      io.to(roomId).emit('message:received', message);

      // 24 saat sonra silinmek üzere işaretle
      await db().collection('messages').doc(messageId).update({
        deleteAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    } catch (e) {
      console.error('message:send error:', e);
    }
  });

  // Okundu
  socket.on('message:read', async ({ roomId, messageId, readerUserId }) => {
    try {
      const mSnap = await db().collection('messages').doc(messageId).get();
      if (!mSnap.exists || mSnap.data().readAt) return;

      const readAt = Date.now();
      // Okuduktan 1 saat sonra sil
      await db().collection('messages').doc(messageId).update({
        readAt,
        status: 'read',
        deleteAt: readAt + 60 * 60 * 1000,
      });

      io.to(roomId).emit('message:read_receipt', { messageId, readAt });
    } catch (e) {
      console.error('message:read error:', e);
    }
  });

  // Ekran görüntüsü bildirimi
  socket.on('screenshot:taken', async ({ roomId, fromUserId }) => {
    try {
      const uSnap = await db().collection('users').doc(fromUserId).get();
      const user  = uSnap.data();

      // Bildirim kaydet (silinmez)
      await db().collection('notifications').add({
        type: 'screenshot',
        fromDisplayId: user?.displayId,
        roomId,
        timestamp: Date.now(),
      });

      socket.to(roomId).emit('screenshot:alert', {
        from: user?.displayId,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('screenshot error:', e);
    }
  });

  // P2P sinyaller
  socket.on('p2p:offer',    ({ toUserId, offer, transferId, meta }) => {
    const toSocketId = onlineUsers.get(toUserId);
    if (!toSocketId) return socket.emit('p2p:error', { transferId, message: 'Karşı taraf çevrimdışı' });
    io.to(toSocketId).emit('p2p:offer', { fromSocketId: socket.id, offer, transferId, meta });
  });

  socket.on('p2p:answer',   ({ toSocketId, answer, transferId }) => {
    io.to(toSocketId).emit('p2p:answer', { answer, transferId });
  });

  socket.on('p2p:ice',      ({ toSocketId, candidate }) => {
    io.to(toSocketId).emit('p2p:ice', { candidate });
  });

  socket.on('p2p:complete', async ({ roomId, toUserId, meta, fromUserId }) => {
    try {
      const messageId = generateId('M');
      const message = {
        id: messageId, roomId,
        from: fromUserId, to: toUserId,
        type: meta.type,
        content: { name: meta.name, size: meta.size, mimeType: meta.mimeType, p2p: true },
        timestamp: Date.now(),
        readAt: null,
        deleteAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      await db().collection('messages').doc(messageId).set(message);
      io.to(roomId).emit('message:received', message);
    } catch (e) {
      console.error('p2p:complete error:', e);
    }
  });

  // Bağlantı kesildi
  socket.on('disconnect', async () => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;

    onlineUsers.delete(userId);
    socketToUser.delete(socket.id);

    io.emit('user:offline', { userId });
  });
});

// ── Mesaj temizleme (her 10 dk) ───────────────────────────────
setInterval(async () => {
  try {
    const now  = Date.now();
    const snap = await db().collection('messages')
      .where('deleteAt', '<=', now)
      .get();

    const batch = db().batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    if (!snap.empty) await batch.commit();
    if (snap.size > 0) console.log(`${snap.size} mesaj silindi`);
  } catch (e) {
    console.error('cleanup error:', e);
  }
}, 10 * 60 * 1000);


// ── Ekstra Endpoint'ler (Hesap Ayarları) ───────────────────────

// Şifre değiştir
app.post('/auth/change-password', async (req, res) => {
  try {
    const { userId, oldPassword, newPassword } = req.body;
    if (!userId || !oldPassword || !newPassword)
      return res.status(400).json({ error: 'Eksik alan' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Yeni sifre en az 6 karakter olmali' });

    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });

    const user = snap.data();
    if (user.passwordHash !== hashPassword(oldPassword))
      return res.status(401).json({ error: 'Mevcut sifre yanlis' });

    await db().collection('users').doc(userId).update({
      passwordHash: hashPassword(newPassword),
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

// Kullanıcı adı değiştir (7 günde bir)
app.post('/auth/change-username', async (req, res) => {
  try {
    const { userId, newUsername } = req.body;
    if (!userId || !newUsername)
      return res.status(400).json({ error: 'Eksik alan' });
    if (newUsername.length < 3 || newUsername.length > 20)
      return res.status(400).json({ error: 'Kullanici adi 3-20 karakter olmali' });

    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });

    const user = snap.data();

    // 7 gün kontrolü
    if (user.lastUsernameChange) {
      const diff = Date.now() - user.lastUsernameChange;
      const days = diff / (1000 * 60 * 60 * 24);
      if (days < 7) {
        const remaining = Math.ceil(7 - days);
        return res.status(400).json({ error: `Kullanici adini ${remaining} gun sonra degistirebilirsin` });
      }
    }

    // Alınmış mı?
    const existing = await db().collection('users')
      .where('username', '==', newUsername.toLowerCase())
      .get();
    if (!existing.empty) return res.status(409).json({ error: 'Bu kullanici adi alinmis' });

    await db().collection('users').doc(userId).update({
      username:           newUsername.toLowerCase(),
      displayName:        newUsername,
      lastUsernameChange: Date.now(),
    });

    res.json({ success: true, username: newUsername.toLowerCase() });
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

// Hesap sil
app.delete('/auth/delete-account', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password)
      return res.status(400).json({ error: 'Eksik alan' });

    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });

    const user = snap.data();
    if (user.passwordHash !== hashPassword(password))
      return res.status(401).json({ error: 'Sifre yanlis' });

    const batch = db().batch();

    // Kullanıcıyı sil
    batch.delete(db().collection('users').doc(userId));

    // Mesajlarını sil
    const msgs = await db().collection('messages')
      .where('from', '==', userId).get();
    msgs.docs.forEach(d => batch.delete(d.ref));

    const msgsTo = await db().collection('messages')
      .where('to', '==', userId).get();
    msgsTo.docs.forEach(d => batch.delete(d.ref));

    // İsteklerini sil
    const reqs = await db().collection('requests')
      .where('from', '==', userId).get();
    reqs.docs.forEach(d => batch.delete(d.ref));

    const reqsTo = await db().collection('requests')
      .where('to', '==', userId).get();
    reqsTo.docs.forEach(d => batch.delete(d.ref));

    await batch.commit();

    // Socket'i kapat
    const socketId = onlineUsers.get(userId);
    if (socketId) {
      io.sockets.sockets.get(socketId)?.disconnect();
      onlineUsers.delete(userId);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('delete-account error:', e);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Phantom backend çalışıyor → port ${PORT}`));
