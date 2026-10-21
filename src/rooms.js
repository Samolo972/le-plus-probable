'use strict';

const { randomInt } = require('node:crypto');
const { Room } = require('./room');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O, trop proches de 1 et 0
const SAVE_DELAY_MS = 150;
const RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const IDLE_EMPTY_MS = 2 * 60 * 60 * 1000;
const IDLE_PODIUM_MS = 30 * 60 * 1000;

// Les parties vivent en mémoire ; un instantané part en base à chaque changement
// (regroupé sur 150 ms) pour pouvoir reprendre après un redémarrage du serveur.
class RoomManager {
  constructor({ db, timeScale = 1000 }) {
    this.db = db;
    this.timeScale = timeScale;
    this.rooms = new Map();
    this.saveTimers = new Map();
    this.broadcast = () => {};
    this.closed = false;
  }

  generateCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Plus de code de salle disponible');
  }

  create() {
    const room = new Room({ code: this.generateCode(), db: this.db, onChange: (r) => this.handleChange(r), timeScale: this.timeScale });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    return code ? this.rooms.get(code) ?? null : null;
  }

  handleChange(room) {
    if (this.closed || !this.rooms.has(room.code)) return;
    this.broadcast(room);
    if (!this.saveTimers.has(room.code)) {
      this.saveTimers.set(room.code, setTimeout(() => this.save(room), SAVE_DELAY_MS));
    }
  }

  save(room) {
    clearTimeout(this.saveTimers.get(room.code));
    this.saveTimers.delete(room.code);
    if (!this.rooms.has(room.code) || room.phase === 'podium') return;
    this.db.saveGameState(room.gameId, room.snapshot(), room.players.size, room.settings);
  }

  flushAll() {
    for (const room of this.rooms.values()) this.save(room);
  }

  remove(code, status) {
    const room = this.rooms.get(code);
    if (!room) return;
    clearTimeout(this.saveTimers.get(code));
    this.saveTimers.delete(code);
    room.dispose(status);
    this.rooms.delete(code);
  }

  restoreAll() {
    let restored = 0;
    for (const row of this.db.liveGames(RESTORE_MAX_AGE_MS)) {
      try {
        const state = JSON.parse(row.state);
        if (this.rooms.has(state.code)) continue;
        const room = Room.restore({ gameId: row.id, state, db: this.db, onChange: (r) => this.handleChange(r), timeScale: this.timeScale });
        this.rooms.set(room.code, room);
        restored++;
      } catch (err) {
        console.error(`Partie ${row.code} impossible à restaurer :`, err.message);
      }
    }
    return restored;
  }

  // Ménage des parties où plus personne n'est connecté.
  sweep(now = Date.now()) {
    for (const room of [...this.rooms.values()]) {
      if (room.connectedPlayers().length > 0) continue;
      const idle = now - room.lastActivity;
      if (idle > IDLE_EMPTY_MS || (room.phase === 'podium' && idle > IDLE_PODIUM_MS) || room.players.size === 0) {
        this.remove(room.code, 'abandoned');
      }
    }
  }
}

module.exports = { RoomManager };
