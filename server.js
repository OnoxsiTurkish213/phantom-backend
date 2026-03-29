const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] },
});

app.use(express.json());

// ── Firebase ──────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT eksik!');
}
const db = () => admin.firestore();

// ── Online kullanıcılar (sadece memory) ───────────────────────
const onlineUsers  = new Map(); // userId → socketId
const socketToUser = new Map(); // socketId → userId

// ── Yardımcılar ───────────────────────────────────────────────
const genId    = (p = '') => p + crypto.randomBytes(4).toString('hex').toUpperCase();
const hashPass = (p)      => crypto.createHash('sha256').update(p + 'phantom_salt_2024').digest('hex');
const roomId   = (a, b)   => [a, b].sort().join(':');

// ── REST: Kayıt ───────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)        return res.status(400).json({ error: 'Eksik alan' });
    if (username.length < 3 || username.length > 15)
      return res.status(400).json({ error: 'Kullanici adi 3-15 karakter olmali' });
    if (password.length < 6)           return res.status(400).json({ error: 'Sifre en az 6 karakter olmali' });

    const ex = await db().collection('users').where('username', '==', username.toLowerCase()).get();
    if (!ex.empty) return res.status(409).json({ error: 'Bu kullanici adi alinmis' });

    const userId    = genId('U');
    const displayId = '#' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await db().collection('users').doc(userId).set({
      userId, username: username.toLowerCase(), displayName: username,
      displayId, passwordHash: hashPass(password), createdAt: Date.now(),
    });
    res.json({ userId, displayId, username: username.toLowerCase() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Giriş ───────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const snap = await db().collection('users').where('username', '==', username?.toLowerCase()).get();
    if (snap.empty || snap.docs[0].data().passwordHash !== hashPass(password))
      return res.status(401).json({ error: 'Kullanici adi veya sifre yanlis' });
    const u = snap.docs[0].data();
    res.json({ userId: u.userId, displayId: u.displayId, username: u.username });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Kullanıcı ara ───────────────────────────────────────
app.get('/users/search', async (req, res) => {
  try {
    const { displayId } = req.query;
    const snap = await db().collection('users').where('displayId', '==', displayId?.toUpperCase()).get();
    if (snap.empty) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    const u = snap.docs[0].data();
    res.json({ userId: u.userId, displayId: u.displayId, username: u.username, online: onlineUsers.has(u.userId) });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Arkadaş listesi ─────────────────────────────────────
app.get('/friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await db().collection('requests').where('status', '==', 'accepted').get();
    const friends = [];
    for (const doc of snap.docs) {
      const r = doc.data();
      if (r.from !== userId && r.to !== userId) continue;
      const friendId = r.from === userId ? r.to : r.from;
      const uSnap = await db().collection('users').doc(friendId).get();
      if (!uSnap.exists) continue;
      const u = uSnap.data();
      friends.push({ userId: u.userId, username: u.username, displayId: u.displayId, roomId: roomId(userId, friendId), online: onlineUsers.has(friendId) });
    }
    res.json(friends);
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Arkadaşı sil ────────────────────────────────────────
app.delete('/friends/:userId/:friendId', async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    // İsteği bul ve sil
    const snap = await db().collection('requests').where('status', '==', 'accepted').get();
    const batch = db().batch();
    for (const doc of snap.docs) {
      const r = doc.data();
      if ((r.from === userId && r.to === friendId) || (r.from === friendId && r.to === userId)) {
        batch.delete(doc.ref);
      }
    }
    // Ortak mesajları sil
    const rId = roomId(userId, friendId);
    const msgs = await db().collection('messages').where('roomId', '==', rId).get();
    msgs.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();

    // Karşı tarafa bildir
    const friendSocketId = onlineUsers.get(friendId);
    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:removed', { byUserId: userId, roomId: rId });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Şifre değiştir ──────────────────────────────────────
app.post('/auth/change-password', async (req, res) => {
  try {
    const { userId, oldPassword, newPassword } = req.body;
    if (!userId || !oldPassword || !newPassword) return res.status(400).json({ error: 'Eksik alan' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Sifre en az 6 karakter olmali' });
    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    if (snap.data().passwordHash !== hashPass(oldPassword)) return res.status(401).json({ error: 'Mevcut sifre yanlis' });
    await db().collection('users').doc(userId).update({ passwordHash: hashPass(newPassword) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Kullanıcı adı değiştir ──────────────────────────────
app.post('/auth/change-username', async (req, res) => {
  try {
    const { userId, newUsername } = req.body;
    if (!userId || !newUsername) return res.status(400).json({ error: 'Eksik alan' });
    if (newUsername.length < 3 || newUsername.length > 15) return res.status(400).json({ error: 'Kullanici adi 3-15 karakter olmali' });
    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    const u = snap.data();
    if (u.lastUsernameChange && Date.now() - u.lastUsernameChange < 7 * 24 * 60 * 60 * 1000) {
      const d = Math.ceil(7 - (Date.now() - u.lastUsernameChange) / 86400000);
      return res.status(400).json({ error: `${d} gun sonra degistirebilirsin` });
    }
    const ex = await db().collection('users').where('username', '==', newUsername.toLowerCase()).get();
    if (!ex.empty) return res.status(409).json({ error: 'Bu kullanici adi alinmis' });
    await db().collection('users').doc(userId).update({ username: newUsername.toLowerCase(), displayName: newUsername, lastUsernameChange: Date.now() });
    res.json({ success: true, username: newUsername.toLowerCase() });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── REST: Hesap sil ───────────────────────────────────────────
app.delete('/auth/delete-account', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const snap = await db().collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    if (snap.data().passwordHash !== hashPass(password)) return res.status(401).json({ error: 'Sifre yanlis' });
    const batch = db().batch();
    batch.delete(db().collection('users').doc(userId));
    for (const col of ['messages', 'requests', 'notifications']) {
      const q1 = await db().collection(col).where('from', '==', userId).get();
      const q2 = await db().collection(col).where('to',   '==', userId).get();
      [...q1.docs, ...q2.docs].forEach(d => batch.delete(d.ref));
    }
    await batch.commit();
    const sid = onlineUsers.get(userId);
    if (sid) io.sockets.sockets.get(sid)?.disconnect();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('user:connect', async ({ userId }) => {
    try {
      const uSnap = await db().collection('users').doc(userId).get();
      if (!uSnap.exists) return socket.emit('error', { message: 'Kullanici bulunamadi' });
      const u = uSnap.data();

      onlineUsers.set(userId, socket.id);
      socketToUser.set(socket.id, userId);

      // Tüm kabul edilmiş arkadaş odalarına katıl
      // BU KRİTİK — kullanıcı her zaman odada olmalı ki mesaj alsın
      const reqSnap = await db().collection('requests').where('status', '==', 'accepted').get();
      for (const doc of reqSnap.docs) {
        const r = doc.data();
        if (r.from === userId || r.to === userId) {
          const rId = roomId(r.from, r.to);
          socket.join(rId);
        }
      }

      socket.emit('user:connected', { userId, displayId: u.displayId, username: u.username });
      io.emit('user:online', { userId, displayId: u.displayId });
    } catch (e) { console.error('user:connect error:', e); }
  });

  socket.on('request:send', async ({ fromUserId, toDisplayId }) => {
    try {
      const snap = await db().collection('users').where('displayId', '==', toDisplayId?.toUpperCase()).get();
      if (snap.empty) return socket.emit('error', { message: 'Kullanici bulunamadi' });
      const toUser = snap.docs[0].data();
      if (fromUserId === toUser.userId) return socket.emit('error', { message: 'Kendine istek gonderemezsin' });

      // Zaten arkadaş veya istek var mı?
      const existing = await db().collection('requests')
        .where('from', 'in', [fromUserId, toUser.userId]).get();
      for (const doc of existing.docs) {
        const r = doc.data();
        const pair = (r.from === fromUserId && r.to === toUser.userId) || (r.from === toUser.userId && r.to === fromUserId);
        if (pair) {
          if (r.status === 'accepted') return socket.emit('request:error', { message: 'Zaten arkadassiniz' });
          if (r.status === 'pending')  return socket.emit('request:error', { message: 'Istek zaten gonderildi' });
        }
      }

      const requestId = genId('R');
      const fromSnap = await db().collection('users').doc(fromUserId).get();
      const fromUser = fromSnap.data();

      await db().collection('requests').doc(requestId).set({
        requestId, from: fromUserId, to: toUser.userId, status: 'pending', createdAt: Date.now(),
      });

      socket.emit('request:sent', { requestId, toDisplayId: toUser.displayId });

      const toSocketId = onlineUsers.get(toUser.userId);
      if (toSocketId) {
        io.to(toSocketId).emit('request:received', {
          requestId,
          from: { userId: fromUserId, displayId: fromUser.displayId, username: fromUser.username },
        });
      }
    } catch (e) { console.error('request:send error:', e); }
  });

  socket.on('request:respond', async ({ requestId, accept }) => {
    try {
      const rSnap = await db().collection('requests').doc(requestId).get();
      if (!rSnap.exists) return;
      const req = rSnap.data();
      await db().collection('requests').doc(requestId).update({ status: accept ? 'accepted' : 'rejected' });

      const [fromSnap, toSnap] = await Promise.all([
        db().collection('users').doc(req.from).get(),
        db().collection('users').doc(req.to).get(),
      ]);
      const fromUser = fromSnap.data();
      const toUser   = toSnap.data();

      if (accept) {
        const rId = roomId(req.from, req.to);

        // Her iki kullanıcıyı odaya al
        const fromSocketId = onlineUsers.get(req.from);
        if (fromSocketId) io.sockets.sockets.get(fromSocketId)?.join(rId);
        socket.join(rId);

        io.to(rId).emit('request:accepted', {
          requestId, roomId: rId,
          users: [
            { userId: req.from, displayId: fromUser.displayId, username: fromUser.username },
            { userId: req.to,   displayId: toUser.displayId,   username: toUser.username },
          ],
        });
      } else {
        const fromSocketId = onlineUsers.get(req.from);
        if (fromSocketId) io.to(fromSocketId).emit('request:rejected', { requestId });
      }
    } catch (e) { console.error('request:respond error:', e); }
  });

  socket.on('message:send', async ({ roomId: rId, fromUserId, toUserId, type, content }) => {
    try {
      const messageId = genId('M');
      const message = {
        id: messageId, roomId: rId,
        from: fromUserId, to: toUserId,
        type, content,
        timestamp: Date.now(),
        readAt: null, status: 'sent',
        deleteAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      await db().collection('messages').doc(messageId).set(message);

      // Odadaki herkese gönder
      io.to(rId).emit('message:received', message);

      // Eğer karşı taraf odada değilse direkt socket'e gönder
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) {
        const toSocket = io.sockets.sockets.get(toSocketId);
        if (toSocket && !toSocket.rooms.has(rId)) {
          toSocket.join(rId);
          toSocket.emit('message:received', message);
        }
      }
    } catch (e) { console.error('message:send error:', e); }
  });

  socket.on('message:read', async ({ roomId: rId, messageId, readerUserId }) => {
    try {
      const mSnap = await db().collection('messages').doc(messageId).get();
      if (!mSnap.exists || mSnap.data().readAt) return;
      const readAt = Date.now();
      await db().collection('messages').doc(messageId).update({
        readAt, status: 'read',
        deleteAt: readAt + 60 * 60 * 1000, // okunduktan 1 saat sonra sil
      });
      io.to(rId).emit('message:read_receipt', { messageId, readAt });
    } catch (e) { console.error('message:read error:', e); }
  });

  // SS bildirimi — kullanıcı ne zaman isterse gönderebilir
  socket.on('screenshot:taken', async ({ roomId: rId, fromUserId }) => {
    try {
      const uSnap = await db().collection('users').doc(fromUserId).get();
      const u = uSnap.data();
      // Karşı tarafa bildir
      socket.to(rId).emit('screenshot:alert', { from: u?.displayId, timestamp: Date.now() });
      // Bildirimi kaydet (kalıcı)
      await db().collection('notifications').add({
        type: 'screenshot', fromDisplayId: u?.displayId, roomId: rId, timestamp: Date.now(),
      });
    } catch (e) { console.error('screenshot error:', e); }
  });

  // P2P
  socket.on('p2p:offer', ({ toUserId, offer, transferId, meta }) => {
    const sid = onlineUsers.get(toUserId);
    if (!sid) return socket.emit('p2p:error', { transferId, message: 'Karsi taraf cevrimdisi' });
    io.to(sid).emit('p2p:offer', { fromSocketId: socket.id, offer, transferId, meta });
  });
  socket.on('p2p:answer', ({ toSocketId, answer, transferId }) => io.to(toSocketId).emit('p2p:answer', { answer, transferId }));
  socket.on('p2p:ice',    ({ toSocketId, candidate })          => io.to(toSocketId).emit('p2p:ice',    { candidate }));

  socket.on('disconnect', () => {
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
    const snap = await db().collection('messages').where('deleteAt', '<=', Date.now()).get();
    if (snap.empty) return;
    const batch = db().batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`${snap.size} mesaj silindi`);
  } catch (e) { console.error('cleanup error:', e); }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Phantom v3 backend → port ${PORT}`));
