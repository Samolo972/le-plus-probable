'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { openDb, DEFAULT_FILE } = require('./src/db');
const { RoomManager } = require('./src/rooms');
const { attachSockets } = require('./src/sockets');
const { cleanCode } = require('./src/sanitize');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

function createApp({ dbFile = process.env.DB_FILE || DEFAULT_FILE, publicUrl = process.env.PUBLIC_URL, timeScale } = {}) {
  const db = openDb(dbFile);
  const seeded = db.seedIfEmpty();
  if (seeded) console.log(`${seeded} questions importées depuis data/questions.json`);
  db.purgeOld();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Le QR code est généré ici : aucun service tiers ne voit le code de la salle.
  app.get('/api/qr/:code', async (req, res) => {
    const code = cleanCode(req.params.code);
    if (!code) return res.status(400).end();
    const base = publicUrl || `${req.protocol}://${req.get('host')}`;
    const svg = await QRCode.toString(`${base}/?code=${code}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1E1645', light: '#FFFFFF' }
    });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  });

  app.get('/tv/:code', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tv.html')));
  app.use(express.static(PUBLIC_DIR));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 10_000,
    pingInterval: 10_000,
    pingTimeout: 8_000
  });
  const manager = new RoomManager({ db, timeScale });
  const restored = manager.restoreAll();
  if (restored) console.log(`${restored} partie(s) en cours restaurée(s)`);
  attachSockets(io, manager, db);

  const timers = [
    setInterval(() => db.purgeOld(), PURGE_EVERY_MS),
    setInterval(() => manager.sweep(), SWEEP_EVERY_MS)
  ];

  function close() {
    // Pendant l'arrêt, les déconnexions ne doivent rien changer aux parties
    // (sinon une manche pourrait se clore toute seule avant la reprise).
    manager.closed = true;
    timers.forEach(clearInterval);
    manager.flushAll();
    for (const room of manager.rooms.values()) {
      clearTimeout(room.timer);
      clearTimeout(room.hostTimer);
    }
    io.close();
    server.close();
    db.close();
  }

  return { app, server, io, db, manager, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3002;
  const host = process.env.HOST || '127.0.0.1';
  const instance = createApp();
  instance.server.listen(port, host, () => console.log(`Le Plus Probable sur http://${host}:${port}`));

  // PM2 envoie SIGINT/SIGTERM : on enregistre les parties avant de quitter.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      instance.close();
      process.exit(0);
    });
  }
}

module.exports = { createApp };
