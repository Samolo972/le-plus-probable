'use strict';

const { GameError } = require('./room');
const { cleanCode, isToken } = require('./sanitize');

const BUCKET_SIZE = 20;
const BUCKET_REFILL_PER_S = 8;
const REACTION_GAP_MS = 250;

function rateLimiter() {
  let tokens = BUCKET_SIZE;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(BUCKET_SIZE, tokens + ((now - last) / 1000) * BUCKET_REFILL_PER_S);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function attachSockets(io, manager, db) {
  const socketsByToken = new Map(); // token → Set(socket.id), un joueur peut avoir deux onglets

  manager.broadcast = (room) => {
    for (const p of room.players.values()) {
      if (socketsByToken.has(p.token)) io.to(`p:${p.token}`).emit('state', room.view(p.token));
    }
    io.to(`tv:${room.code}`).emit('state', room.view(null));
  };

  io.on('connection', (socket) => {
    const allow = rateLimiter();
    let lastReaction = 0;

    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!allow()) return reply({ ok: false, error: 'Doucement, un clic à la fois.' });
        try {
          const data = payload && typeof payload === 'object' ? payload : {};
          reply({ ok: true, ...(handler(data) ?? {}) });
        } catch (err) {
          if (err instanceof GameError) return reply({ ok: false, error: err.message, code: err.code });
          console.error(`[${event}]`, err);
          reply({ ok: false, error: 'Oups, erreur du serveur.' });
        }
      });
    };

    function current() {
      const { code, token } = socket.data;
      const room = manager.get(code);
      if (!room || !room.players.has(token)) throw new GameError('nosession', 'Tu ne fais plus partie de cette partie.');
      return { room, token };
    }

    function unbind() {
      const { code, token } = socket.data;
      if (!token || manager.closed) return;
      socket.leave(`p:${token}`);
      socket.leave(`room:${code}`);
      const set = socketsByToken.get(token);
      set?.delete(socket.id);
      if (set && set.size === 0) {
        socketsByToken.delete(token);
        manager.get(code)?.setConnected(token, false);
      }
      socket.data.code = null;
      socket.data.token = null;
    }

    function bind(room, player) {
      if (socket.data.token && socket.data.token !== player.token) unbind();
      socket.data.code = room.code;
      socket.data.token = player.token;
      socket.join(`p:${player.token}`);
      socket.join(`room:${room.code}`);
      if (!socketsByToken.has(player.token)) socketsByToken.set(player.token, new Set());
      socketsByToken.get(player.token).add(socket.id);
      room.setConnected(player.token, true);
      socket.emit('state', room.view(player.token));
      return { code: room.code, token: player.token };
    }

    on('create', ({ name }) => {
      const room = manager.create();
      try {
        return bind(room, room.addPlayer(name));
      } catch (err) {
        manager.remove(room.code, 'abandoned');
        throw err;
      }
    });

    on('join', ({ code, name }) => {
      const room = manager.get(cleanCode(code));
      if (!room) throw new GameError('noroom', 'Aucune partie avec ce code.');
      return bind(room, room.addPlayer(name));
    });

    // Reprise après veille, coupure réseau ou redémarrage du serveur.
    on('resume', ({ code, token }) => {
      if (!isToken(token)) throw new GameError('gone', 'Session inconnue.');
      const session = db.getSession(token);
      const room = manager.get(cleanCode(code)) ?? manager.get(session?.game_code);
      const player = room?.players.get(token);
      if (!player) throw new GameError('gone', 'Cette partie est terminée.');
      return bind(room, player);
    });

    on('tv', ({ code }) => {
      const room = manager.get(cleanCode(code));
      if (!room) throw new GameError('noroom', 'Aucune partie avec ce code.');
      socket.join(`tv:${room.code}`);
      socket.join(`room:${room.code}`);
      socket.emit('state', room.view(null));
      return { code: room.code };
    });

    on('leave', () => {
      const { room, token } = current();
      unbind();
      room.removePlayer(token);
      if (room.players.size === 0) manager.remove(room.code, 'abandoned');
    });

    on('settings', (s) => {
      const { room, token } = current();
      room.updateSettings(token, s);
    });
    on('start', () => {
      const { room, token } = current();
      room.start(token);
    });
    on('q:add', ({ text }) => {
      const { room, token } = current();
      room.addQuestion(token, text);
    });
    on('q:remove', ({ index }) => {
      const { room, token } = current();
      room.removeQuestion(token, index);
    });
    on('ready', ({ ready }) => {
      const { room, token } = current();
      room.setReady(token, ready);
    });
    on('force', () => {
      const { room, token } = current();
      room.force(token);
    });
    on('vote', ({ pid }) => {
      const { room, token } = current();
      room.vote(token, String(pid ?? ''));
    });
    on('react', ({ kind }) => {
      const { room, token } = current();
      const now = Date.now();
      if (now - lastReaction < REACTION_GAP_MS) return;
      lastReaction = now;
      const ev = room.react(token, String(kind ?? ''));
      io.to(`room:${room.code}`).emit('reaction', ev);
    });
    on('next', () => {
      const { room, token } = current();
      room.next(token);
    });
    on('end', () => {
      const { room, token } = current();
      room.end(token);
    });
    on('replay', () => {
      const { room, token } = current();
      room.replay(token);
    });

    socket.on('disconnect', unbind);
  });
}

module.exports = { attachSockets };
