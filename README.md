# Le Plus Probable

« Qui de vous est le plus susceptible de… ? » — jeu multijoueur à jouer entre collègues depuis le téléphone,
avec un mode grand écran pour la télé ou le projecteur.

Node.js + Express + Socket.io, front en HTML/CSS/JS sans framework, SQLite (better-sqlite3).

## Lancer en local

```bash
npm install
npm start            # http://127.0.0.1:3002
npm test             # tests de la logique + partie multijoueur simulée
```

Pour jouer avec de vrais téléphones sur le même wifi : `HOST=0.0.0.0 npm start`, puis ouvrir
`http://<ip-du-pc>:3002` sur les téléphones (le pare-feu Windows peut demander une autorisation).

Variables d'environnement : `PORT` (3002), `HOST` (127.0.0.1), `PUBLIC_URL` (adresse mise dans le QR code),
`DB_FILE` (data/plusprobable.db), `BACKUP_DIR` (backups/).

## Organisation

| Fichier | Rôle |
|---|---|
| `server.js` | Express (pages, QR code, en-têtes de sécurité) + Socket.io |
| `src/room.js` | Règles d'une partie : salle d'attente, questions des joueurs, vote, résultats, podium |
| `src/rooms.js` | Parties en mémoire, instantané en base pour survivre à un redémarrage |
| `src/sockets.js` | Événements temps réel, limitation de débit, reconnexion |
| `src/questions.js` | Tirage des questions (thèmes, mode Hard, questions des joueurs) |
| `src/stats.js` | Podium et stats rigolotes |
| `src/db.js` | Schéma SQLite et requêtes préparées |
| `data/questions.json` | Banque de questions (importée au premier lancement) |
| `public/` | Application téléphone (`index.html`) et grand écran (`tv.html`, route `/tv/:code`) |

## Questions

`data/questions.json` n'est lu qu'au premier lancement (base vide). Ensuite la base fait foi :
- ajouter des questions : les écrire dans le JSON puis `npm run import-questions` (les doublons sont ignorés) ;
- retirer une question : `UPDATE questions SET active = 0 WHERE id = …` (idem dans `custom_questions`
  pour une question proposée par un joueur).

## Données et confidentialité

- Vote anonyme : seuls les totaux par joueur existent, en mémoire comme en base. Le lien votant → cible
  n'est jamais créé. L'option « Révéler les votes » est alors désactivée.
- Les parties et sessions de plus de 30 jours sont purgées automatiquement (au démarrage puis toutes les 6 h).
- Le palmarès (`player_titles`) et les questions des joueurs sont conservés.
- `data/*.db` et `backups/` sont exclus de Git.

## Production

Une seule instance (les parties vivent en mémoire), derrière un reverse proxy qui transmet les
WebSockets sur `/socket.io/`. `npm run backup` fait une copie cohérente de la base et garde les 7 dernières.
