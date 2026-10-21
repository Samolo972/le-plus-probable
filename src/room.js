'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { cleanName, nameKey, cleanQuestion } = require('./sanitize');
const { THEMES, buildDeck, bankPool } = require('./questions');
const { REACTION_KEYS, computePodium } = require('./stats');

const PLAYER_COLORS = [
  '#FFD23F', '#FF7A59', '#5EE6C5', '#8FB8FF', '#F2A7E8',
  '#B9F18C', '#FFB86B', '#C9A7FF', '#7FE0FF', '#FF9EC4'
];
const MAX_PLAYERS = 20;
const MIN_PLAYERS = 2;
const MAX_CUSTOM = 2;
const HOST_GRACE_MS = 30_000;
const COUNTS = [5, 10, 15, 20];
const TIMERS = [10, 20, 30, 0]; // 0 = illimité

const DEFAULT_SETTINGS = {
  count: 10,
  timer: 20,
  themes: ['Vie perso', 'Absurde', 'Food'],
  anon: true,
  self: false,
  reveal: false,
  custom: true,
  sound: true,
  vibe: true,
  hard: false
};

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const emptyReactions = () => Object.fromEntries(REACTION_KEYS.map((k) => [k, 0]));
const publicId = () => randomBytes(6).toString('hex');
const initialOf = (name) => Array.from(name)[0].toLocaleUpperCase('fr');

// Une partie en mémoire. Toutes les règles du jeu vivent ici ; la couche Socket.io
// ne fait que traduire les événements et diffuser view() après chaque changement.
//
// Vote anonyme : on ne garde que les totaux par joueur et la liste de ceux qui ont
// déjà voté (pour empêcher le double vote). Le lien votant → cible n'existe jamais.
class Room {
  constructor({ code, db, onChange = () => {}, timeScale = 1000 }) {
    this.code = code;
    this.db = db;
    this.onChange = onChange;
    this.timeScale = timeScale;
    this.players = new Map(); // token secret → joueur
    this.hostPid = null;
    this.settings = { ...DEFAULT_SETTINGS, themes: [...DEFAULT_SETTINGS.themes] };
    this.gameId = db.createGame(code, this.settings);
    this.lastActivity = Date.now();
    this.timer = null;
    this.hostTimer = null;
    this.resetGame();
  }

  resetGame() {
    this.phase = 'lobby';
    this.deck = [];
    this.deckPos = 0;
    this.round = null;
    this.results = null;
    this.history = [];
    this.podium = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.questions = [];
      p.titles = [];
      p.voteTime = { sum: 0, count: 0 };
    }
  }

  // ---------- joueurs ----------

  addPlayer(rawName, token = randomUUID()) {
    const name = cleanName(rawName);
    if (!name) throw new GameError('name', 'Choisis un pseudo.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('full', 'La partie est complète (20 joueurs).');
    const key = nameKey(name);
    if ([...this.players.values()].some((p) => p.key === key)) throw new GameError('taken', 'Ce pseudo est déjà pris dans cette partie.');

    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
    const player = {
      token,
      pid: publicId(),
      name,
      key,
      initial: initialOf(name),
      color,
      connected: true,
      ready: false,
      questions: [],
      titles: [],
      voteTime: { sum: 0, count: 0 },
      palmares: this.db.titleCount(key),
      joinedAt: Date.now()
    };
    this.players.set(token, player);
    if (!this.hostPid) this.hostPid = player.pid;
    this.db.saveSession({ id: token, code: this.code, gameId: this.gameId, pseudo: name });
    this.changed();
    return player;
  }

  removePlayer(token) {
    const p = this.players.get(token);
    if (!p) return;
    this.players.delete(token);
    this.db.deleteSession(token);
    if (p.pid === this.hostPid) this.pickNewHost();
    this.afterPresenceChange();
    this.changed();
  }

  setConnected(token, connected) {
    const p = this.players.get(token);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    if (connected) this.db.touchSession(token);
    this.watchHost();
    this.afterPresenceChange();
    this.changed();
  }

  // L'hôte injoignable trop longtemps passe la main, pour ne pas bloquer la partie.
  watchHost() {
    if (!this.players.size) return;
    const host = this.byPid(this.hostPid);
    if (host && host.connected) {
      clearTimeout(this.hostTimer);
      this.hostTimer = null;
    } else if (!this.hostTimer) {
      this.hostTimer = setTimeout(() => this.handOverHost(), HOST_GRACE_MS);
      this.hostTimer.unref?.();
    }
  }

  handOverHost() {
    this.hostTimer = null;
    const host = this.byPid(this.hostPid);
    if (host && host.connected) return;
    if (this.connectedPlayers().length > 0) {
      this.pickNewHost();
      this.changed();
    } else {
      this.watchHost();
    }
  }

  pickNewHost() {
    const candidates = [...this.players.values()].sort((a, b) => b.connected - a.connected || a.joinedAt - b.joinedAt);
    this.hostPid = candidates[0]?.pid ?? null;
  }

  afterPresenceChange() {
    if (this.phase === 'vote') this.closeIfEveryoneVoted();
    if (this.phase === 'questions') this.startIfEveryoneReady();
  }

  byPid(pid) {
    for (const p of this.players.values()) if (p.pid === pid) return p;
    return null;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  isHost(token) {
    return this.players.get(token)?.pid === this.hostPid;
  }

  requirePlayer(token) {
    const p = this.players.get(token);
    if (!p) throw new GameError('unknown', 'Tu ne fais plus partie de cette partie.');
    this.lastActivity = Date.now();
    return p;
  }

  requireHost(token) {
    const p = this.requirePlayer(token);
    if (p.pid !== this.hostPid) throw new GameError('host', 'Seul l’hôte peut faire ça.');
    return p;
  }

  requirePhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('phase', 'Ce n’est pas le moment.');
  }

  // ---------- paramètres ----------

  updateSettings(token, input = {}) {
    this.requireHost(token);
    this.requirePhase('lobby');
    const s = { ...this.settings };
    if (COUNTS.includes(input.count)) s.count = input.count;
    if (TIMERS.includes(input.timer)) s.timer = input.timer;
    if (Array.isArray(input.themes)) {
      const themes = THEMES.filter((t) => input.themes.includes(t));
      if (!themes.length) throw new GameError('themes', 'Choisis au moins un thème.');
      s.themes = themes;
    }
    for (const k of ['anon', 'self', 'reveal', 'custom', 'sound', 'vibe', 'hard']) {
      if (typeof input[k] === 'boolean') s[k] = input[k];
    }
    // Révéler les votes contredirait l'anonymat : l'anonymat l'emporte.
    if (s.anon) s.reveal = false;
    this.settings = s;
    this.changed();
  }

  // ---------- déroulé ----------

  start(token) {
    this.requireHost(token);
    this.requirePhase('lobby');
    if (this.players.size < MIN_PLAYERS) throw new GameError('few', 'Il faut au moins 2 joueurs pour lancer la partie.');
    if (this.settings.custom) {
      this.phase = 'questions';
      for (const p of this.players.values()) p.ready = false;
      this.changed();
    } else {
      this.beginRounds();
    }
  }

  addQuestion(token, raw) {
    const p = this.requirePlayer(token);
    this.requirePhase('questions');
    if (p.questions.length >= MAX_CUSTOM) throw new GameError('max', 'Maximum 2 questions par joueur.');
    const text = cleanQuestion(raw);
    if (!text) throw new GameError('question', 'Ta question doit faire entre 5 et 120 caractères.');
    if (p.questions.some((q) => q.toLowerCase() === text.toLowerCase())) throw new GameError('dup', 'Tu as déjà proposé cette question.');
    p.questions.push(text);
    this.changed();
  }

  removeQuestion(token, index) {
    const p = this.requirePlayer(token);
    this.requirePhase('questions');
    if (Number.isInteger(index) && index >= 0 && index < p.questions.length) p.questions.splice(index, 1);
    this.changed();
  }

  setReady(token, ready) {
    const p = this.requirePlayer(token);
    this.requirePhase('questions');
    p.ready = Boolean(ready);
    if (!this.startIfEveryoneReady()) this.changed();
  }

  startIfEveryoneReady() {
    const online = this.connectedPlayers();
    if (this.phase === 'questions' && online.length > 0 && online.every((p) => p.ready)) {
      this.beginRounds();
      return true;
    }
    return false;
  }

  // Bouton de l'hôte : lancer sans attendre les retardataires, ou révéler le vote tout de suite.
  force(token) {
    this.requireHost(token);
    this.requirePhase('questions', 'vote');
    if (this.phase === 'questions') this.beginRounds();
    else this.closeRound();
  }

  beginRounds() {
    const playerQuestions = [...this.players.values()].map((p) => p.questions);
    this.deck = buildDeck(this.db, this.settings, playerQuestions);
    this.deckPos = 0;
    this.db.saveGameState(this.gameId, this.snapshot(), this.players.size, this.settings);
    this.startRound();
  }

  drawQuestion() {
    if (this.deckPos >= this.deck.length) {
      // Mode Hard sans limite : la pioche est épuisée, on la remélange.
      this.deck = bankPool(this.db, this.settings);
      this.deckPos = 0;
    }
    const q = this.deck[this.deckPos++];
    if (q.customId) this.db.useCustomQuestion(q.customId);
    return q;
  }

  totalRounds() {
    return this.settings.hard ? null : this.deck.length;
  }

  startRound() {
    const q = this.drawQuestion();
    const now = Date.now();
    this.round = {
      n: (this.round?.n ?? 0) + 1,
      q,
      startedAt: now,
      deadline: this.settings.timer ? now + this.settings.timer * this.timeScale : null,
      voters: [], // pids de ceux qui ont voté, sans leur choix
      tally: {}, // pid cible → nombre de votes
      pairs: this.settings.anon ? null : {}, // votant → cible, seulement hors vote anonyme
      reactions: emptyReactions()
    };
    this.results = null;
    this.phase = 'vote';
    this.armTimer();
    this.changed();
  }

  armTimer() {
    clearTimeout(this.timer);
    if (this.phase === 'vote' && this.round.deadline) {
      this.timer = setTimeout(() => this.closeRound(), Math.max(0, this.round.deadline - Date.now()));
    }
  }

  canVoteFor(voter, target) {
    return target && (this.settings.self || target.pid !== voter.pid);
  }

  vote(token, targetPid) {
    const voter = this.requirePlayer(token);
    this.requirePhase('vote');
    if (this.round.voters.includes(voter.pid)) throw new GameError('voted', 'Tu as déjà voté.');
    const target = this.byPid(targetPid);
    if (!this.canVoteFor(voter, target)) throw new GameError('target', 'Vote impossible pour ce joueur.');

    const r = this.round;
    r.voters.push(voter.pid);
    r.tally[target.pid] = (r.tally[target.pid] ?? 0) + 1;
    if (r.pairs) r.pairs[voter.pid] = target.pid;
    voter.voteTime.sum += Date.now() - r.startedAt;
    voter.voteTime.count += 1;
    if (!this.closeIfEveryoneVoted()) this.changed();
  }

  closeIfEveryoneVoted() {
    const online = this.connectedPlayers();
    if (this.phase === 'vote' && online.length > 0 && online.every((p) => this.round.voters.includes(p.pid))) {
      this.closeRound();
      return true;
    }
    return false;
  }

  closeRound() {
    if (this.phase !== 'vote') return;
    clearTimeout(this.timer);
    const r = this.round;
    const rows = [...this.players.values()]
      .map((p) => ({ pid: p.pid, name: p.name, initial: p.initial, color: p.color, votes: r.tally[p.pid] ?? 0 }))
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'fr'));
    const total = r.voters.length;
    const best = rows[0]?.votes ?? 0;
    const winners = best > 0 ? rows.filter((row) => row.votes === best) : [];

    let pairs = null;
    if (r.pairs) {
      pairs = Object.entries(r.pairs)
        .map(([voterPid, targetPid]) => ({ voter: this.byPid(voterPid), target: this.byPid(targetPid) }))
        .filter((x) => x.voter && x.target)
        .map(({ voter, target }) => ({
          voter: { name: voter.name, color: voter.color },
          target: { name: target.name, color: target.color }
        }));
    }

    for (const w of winners) {
      const p = this.byPid(w.pid);
      p.titles.push({ title: r.q.title, votes: w.votes });
      this.db.addTitle(p.name, p.key, r.q.title, this.gameId);
      p.palmares += 1;
    }

    this.db.saveResult(this.gameId, {
      round: r.n,
      question: r.q.text,
      winner: winners.map((w) => w.name).join(' & ') || null,
      votes: best,
      totalVotes: total,
      tally: Object.fromEntries(rows.map((row) => [row.name, row.votes]))
    });

    this.results = { winners: winners.map((w) => w.pid), rows, total, best, pairs, shownAt: Date.now() };
    this.history.push({ n: r.n, text: r.q.text, rows, total, reactions: r.reactions, pairs });
    this.phase = 'results';
    this.changed();
  }

  react(token, kind) {
    const p = this.requirePlayer(token);
    this.requirePhase('results');
    if (!REACTION_KEYS.includes(kind)) throw new GameError('reaction', 'Réaction inconnue.');
    this.round.reactions[kind] += 1;
    this.changed();
    return { kind, name: p.name, color: p.color, count: this.round.reactions[kind] };
  }

  next(token) {
    this.requireHost(token);
    this.requirePhase('results');
    const total = this.totalRounds();
    if (total !== null && this.round.n >= total) this.finish();
    else this.startRound();
  }

  // Terminer à tout moment ; une manche en cours de vote n'est pas comptée.
  end(token) {
    this.requireHost(token);
    this.requirePhase('questions', 'vote', 'results');
    clearTimeout(this.timer);
    this.finish();
  }

  finish() {
    clearTimeout(this.timer);
    this.podium = computePodium({ history: this.history, players: [...this.players.values()], settings: this.settings });
    this.phase = 'podium';
    this.db.finishGame(this.gameId, this.players.size);
    this.changed();
  }

  // Rejouer avec les mêmes joueurs : nouvelle partie en base, même code, mêmes réglages.
  replay(token) {
    this.requireHost(token);
    this.requirePhase('podium');
    for (const [t, p] of this.players) if (!p.connected) this.players.delete(t);
    this.gameId = this.db.createGame(this.code, this.settings);
    for (const p of this.players.values()) this.db.saveSession({ id: p.token, code: this.code, gameId: this.gameId, pseudo: p.name });
    this.resetGame();
    this.changed();
  }

  // Partie abandonnée (plus personne depuis longtemps) ou arrêt.
  dispose(status = 'abandoned') {
    clearTimeout(this.timer);
    clearTimeout(this.hostTimer);
    if (this.phase !== 'podium') this.db.finishGame(this.gameId, this.players.size, status);
  }

  changed() {
    this.lastActivity = Date.now();
    this.onChange(this);
  }

  // ---------- vues ----------

  // Ce que voit un joueur (token) ou l'écran TV (token null). Jamais de token secret
  // dans la vue, et jamais le choix d'un votant en mode anonyme.
  view(token = null) {
    const me = token ? this.players.get(token) : null;
    const r = this.round;
    const players = [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        initial: p.initial,
        color: p.color,
        connected: p.connected,
        host: p.pid === this.hostPid,
        ready: p.ready,
        qCount: p.questions.length,
        palmares: p.palmares
      }));

    const view = {
      code: this.code,
      phase: this.phase,
      serverNow: Date.now(),
      settings: this.settings,
      players,
      round: null,
      results: null,
      podium: this.phase === 'podium' ? this.podium : null
    };

    if (r && (this.phase === 'vote' || this.phase === 'results')) {
      view.round = {
        n: r.n,
        total: this.totalRounds(),
        text: r.q.text,
        custom: r.q.custom,
        title: r.q.title,
        deadline: r.deadline,
        timer: this.settings.timer,
        voted: r.voters,
        reactions: r.reactions
      };
    }

    if (this.phase === 'results') {
      const res = this.results;
      const votersOf = {};
      if (res.pairs && r.pairs) {
        for (const [voterPid, targetPid] of Object.entries(r.pairs)) {
          const v = this.byPid(voterPid);
          if (v) (votersOf[targetPid] ??= []).push({ name: v.name, initial: v.initial, color: v.color });
        }
      }
      view.results = {
        winners: res.winners,
        rows: res.rows.map((row) => ({ ...row, voters: res.pairs ? votersOf[row.pid] ?? [] : null })),
        total: res.total,
        best: res.best,
        shownAt: res.shownAt,
        last: this.totalRounds() !== null && r.n >= this.totalRounds()
      };
    }

    if (me) {
      view.me = {
        pid: me.pid,
        host: me.pid === this.hostPid,
        ready: me.ready,
        questions: me.questions,
        voted: Boolean(r && this.phase === 'vote' && r.voters.includes(me.pid)),
        myVote: r && r.pairs && this.phase !== 'podium' ? r.pairs[me.pid] ?? null : null
      };
    }
    return view;
  }

  // ---------- persistance (survie à un redémarrage) ----------

  snapshot() {
    return {
      code: this.code,
      hostPid: this.hostPid,
      settings: this.settings,
      phase: this.phase,
      deck: this.deck,
      deckPos: this.deckPos,
      round: this.round,
      results: this.results,
      history: this.history,
      podium: this.podium,
      players: [...this.players.values()].map((p) => ({ ...p, connected: false }))
    };
  }

  static restore({ gameId, state, db, onChange, timeScale }) {
    const room = Object.create(Room.prototype);
    Object.assign(room, {
      code: state.code,
      db,
      onChange: onChange ?? (() => {}),
      timeScale: timeScale ?? 1000,
      gameId,
      hostPid: state.hostPid,
      settings: state.settings,
      phase: state.phase,
      deck: state.deck,
      deckPos: state.deckPos,
      round: state.round,
      results: state.results,
      history: state.history,
      podium: state.podium,
      players: new Map(state.players.map((p) => [p.token, p])),
      lastActivity: Date.now(),
      timer: null,
      hostTimer: null
    });
    // Après un redémarrage, tout le monde revient « en veille » le temps de se reconnecter.
    // Un vote dont le temps est écoulé pendant la coupure se clôt tout de suite.
    room.armTimer();
    return room;
  }
}

module.exports = { Room, GameError, DEFAULT_SETTINGS, PLAYER_COLORS, MAX_PLAYERS, COUNTS, TIMERS };
