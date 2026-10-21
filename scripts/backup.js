'use strict';

// Sauvegarde quotidienne de la base (lancée par cron). Utilise l'API de sauvegarde
// de SQLite : la copie est cohérente même si le jeu écrit pendant ce temps.
// Garde les 7 dernières copies dans backups/ (hors du dossier public, exclu de Git).

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DEFAULT_FILE } = require('../src/db');

const KEEP = 7;
const source = process.env.DB_FILE || DEFAULT_FILE;
const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

async function main() {
  if (!fs.existsSync(source)) throw new Error(`Base introuvable : ${source}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(dir, `plusprobable-${stamp}.db`);

  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^plusprobable-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) fs.unlinkSync(path.join(dir, f));

  console.log(`${new Date().toISOString()} sauvegarde ${path.basename(target)} (${old.length} ancienne(s) supprimée(s))`);
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} échec de la sauvegarde :`, err.message);
  process.exit(1);
});
