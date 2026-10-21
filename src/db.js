'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'plusprobable.db');
const QUESTIONS_JSON = path.join(__dirname, '..', 'data', 'questions.json');
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id      INTEGER PRIMARY KEY,
  text    TEXT NOT NULL UNIQUE,
  theme   TEXT NOT NULL,
  title   TEXT NOT NULL,
  hard    INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_questions_theme ON questions(theme, hard, active);

CREATE TABLE IF NOT EXISTS custom_questions (
  id          INTEGER PRIMARY KEY,
  text        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  INTEGER NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  player_count  INTEGER NOT NULL DEFAULT 0,
  settings      TEXT NOT NULL,
  hard          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'live',
  state         TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status, updated_at);

CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  question     TEXT NOT NULL,
  winner       TEXT,
  votes        INTEGER NOT NULL DEFAULT 0,
  total_votes  INTEGER NOT NULL DEFAULT 0,
  tally        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_game ON results(game_id);

CREATE TABLE IF NOT EXISTS player_titles (
  id          INTEGER PRIMARY KEY,
  pseudo      TEXT NOT NULL,
  pseudo_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  game_id     INTEGER REFERENCES games(id) ON DELETE SET NULL,
  won_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_titles_key ON player_titles(pseudo_key);

CREATE TABLE IF NOT EXISTS sessions (
  player_id   TEXT PRIMARY KEY,
  game_code   TEXT NOT NULL,
  game_id     INTEGER,
  pseudo      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen);
`;

function openDb(file = DEFAULT_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  db.exec(SCHEMA);

  // Requêtes préparées uniquement : aucune valeur n'est concaténée dans le SQL.
  const st = {
    countQuestions: db.prepare('SELECT COUNT(*) AS n FROM questions'),
    insertQuestion: db.prepare(
      'INSERT OR IGNORE INTO questions (text, theme, title, hard) VALUES (@text, @theme, @title, @hard)'
    ),
    questionsActive: db.prepare('SELECT id, text, theme, title, hard FROM questions WHERE active = 1'),
    questionTexts: db.prepare('SELECT id, text FROM questions WHERE active = 1'),
    disableQuestion: db.prepare('UPDATE questions SET active = 0 WHERE id = ?'),

    insertCustom: db.prepare('INSERT OR IGNORE INTO custom_questions (text, created_at) VALUES (?, ?)'),
    customId: db.prepare('SELECT id FROM custom_questions WHERE text = ?'),
    customRandom: db.prepare(
      'SELECT id, text FROM custom_questions WHERE active = 1 ORDER BY random() LIMIT ?'
    ),
    customUse: db.prepare('UPDATE custom_questions SET uses = uses + 1 WHERE id = ?'),

    insertGame: db.prepare(
      'INSERT INTO games (code, created_at, settings, hard, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    saveState: db.prepare(
      'UPDATE games SET state = ?, player_count = ?, settings = ?, hard = ?, updated_at = ? WHERE id = ?'
    ),
    finishGame: db.prepare(
      "UPDATE games SET status = ?, ended_at = ?, state = NULL, player_count = ?, updated_at = ? WHERE id = ? AND status = 'live'"
    ),
    liveGames: db.prepare("SELECT id, code, state FROM games WHERE status = 'live' AND state IS NOT NULL AND updated_at > ?"),
    abandonOld: db.prepare("UPDATE games SET status = 'abandoned', state = NULL WHERE status = 'live' AND updated_at <= ?"),

    insertResult: db.prepare(
      'INSERT INTO results (game_id, round, question, winner, votes, total_votes, tally, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),

    insertTitle: db.prepare(
      'INSERT INTO player_titles (pseudo, pseudo_key, title, game_id, won_at) VALUES (?, ?, ?, ?, ?)'
    ),
    countTitles: db.prepare('SELECT COUNT(*) AS n FROM player_titles WHERE pseudo_key = ?'),

    upsertSession: db.prepare(`
      INSERT INTO sessions (player_id, game_code, game_id, pseudo, created_at, last_seen)
      VALUES (@id, @code, @gameId, @pseudo, @now, @now)
      ON CONFLICT(player_id) DO UPDATE SET game_code = @code, game_id = @gameId, pseudo = @pseudo, last_seen = @now
    `),
    getSession: db.prepare('SELECT player_id, game_code, game_id, pseudo FROM sessions WHERE player_id = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE player_id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE player_id = ?'),

    purgeGames: db.prepare('DELETE FROM games WHERE created_at < ? AND status != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?')
  };

  const api = {
    raw: db,

    // Synchronise la banque avec le JSON : ajoute les nouvelles questions et désactive
    // celles qui n'y figurent plus. Une question désactivée à la main le reste.
    importQuestions(file = QUESTIONS_JSON) {
      const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Le JSON s'écrit avec une espace simple avant « ? », l'affichage veut une insécable.
      const text = (t) => t.trim().replace(/\s*\?$/, ' ?');
      let added = 0;
      let removed = 0;
      const run = db.transaction(() => {
        const keep = new Set();
        const insert = (q, theme, hard) => {
          keep.add(text(q.text));
          added += st.insertQuestion.run({ text: text(q.text), theme, title: q.title, hard }).changes;
        };
        for (const [theme, list] of Object.entries(bank.themes)) for (const q of list) insert(q, theme, 0);
        for (const q of bank.hard) insert(q, 'hard', 1);
        for (const q of st.questionTexts.all()) {
          if (!keep.has(q.text)) removed += st.disableQuestion.run(q.id).changes;
        }
      });
      run();
      return { added, removed };
    },

    // Import uniquement au premier lancement : ensuite la base fait foi.
    seedIfEmpty() {
      if (st.countQuestions.get().n === 0) return api.importQuestions().added;
      return 0;
    },

    activeQuestions() {
      return st.questionsActive.all();
    },

    saveCustomQuestion(text) {
      st.insertCustom.run(text, Date.now());
      return st.customId.get(text)?.id ?? null;
    },
    randomCustomQuestions(limit, excludeTexts = []) {
      const skip = new Set(excludeTexts.map((t) => t.toLowerCase()));
      return st.customRandom.all(limit + skip.size).filter((q) => !skip.has(q.text.toLowerCase())).slice(0, limit);
    },
    useCustomQuestion(id) {
      st.customUse.run(id);
    },

    createGame(code, settings) {
      const now = Date.now();
      return Number(st.insertGame.run(code, now, JSON.stringify(settings), settings.hard ? 1 : 0, 'live', now).lastInsertRowid);
    },
    saveGameState(gameId, state, playerCount, settings) {
      st.saveState.run(JSON.stringify(state), playerCount, JSON.stringify(settings), settings.hard ? 1 : 0, Date.now(), gameId);
    },
    finishGame(gameId, playerCount, status = 'finished') {
      const now = Date.now();
      st.finishGame.run(status, now, playerCount, now, gameId);
    },
    liveGames(maxAgeMs) {
      const now = Date.now();
      st.abandonOld.run(now - maxAgeMs);
      return st.liveGames.all(now - maxAgeMs);
    },

    saveResult(gameId, r) {
      st.insertResult.run(gameId, r.round, r.question, r.winner, r.votes, r.totalVotes, JSON.stringify(r.tally), Date.now());
    },

    addTitle(pseudo, key, title, gameId) {
      st.insertTitle.run(pseudo, key, title, gameId, Date.now());
    },
    titleCount(key) {
      return st.countTitles.get(key).n;
    },

    saveSession({ id, code, gameId, pseudo }) {
      st.upsertSession.run({ id, code, gameId, pseudo, now: Date.now() });
    },
    getSession(id) {
      return st.getSession.get(id) ?? null;
    },
    touchSession(id) {
      st.touchSession.run(Date.now(), id);
    },
    deleteSession(id) {
      st.deleteSession.run(id);
    },

    // Les résultats partent avec leur partie (ON DELETE CASCADE).
    purgeOld(now = Date.now()) {
      const limit = now - RETENTION_DAYS * DAY_MS;
      const games = st.purgeGames.run(limit, 'live').changes;
      const sessions = st.purgeSessions.run(limit).changes;
      return { games, sessions };
    },

    close() {
      db.close();
    }
  };
  return api;
}

module.exports = { openDb, DEFAULT_FILE, QUESTIONS_JSON, RETENTION_DAYS };
