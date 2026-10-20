# LAN Chat

Le chat de l'équipe, façon Slack, sur votre propre serveur : canaux publics et privés, messages directs, fils, appels et partage d'écran. **Chiffré de bout en bout**, léger (aucun framework, aucune compilation, une seule dépendance facultative), base **PostgreSQL** ou **SQLite** sans rien installer.

![Aperçu](docs/apercu.png)

## Démarrer sur le réseau du bureau

```bash
git clone https://github.com/yuri2397/lan-chat.git
cd lan-chat
node server.js          # ou PORT=4000 node server.js
```

Il suffit de Node.js **22.13 ou plus récent** (https://nodejs.org) et d'`openssl` (déjà présent sur macOS et Linux). Pas de `npm install` dans ce mode : les données vont dans une base SQLite, `data/lanchat.db`.

Le terminal affiche :
- l'adresse à partager, ex. `https://192.168.1.15:3000` ;
- le **code d'accès** à donner aux collègues pour qu'ils créent leur compte (aussi visible, et renouvelable, dans *Administration*).

La première personne à créer son compte devient **propriétaire** de l'espace de travail.

Au premier accès, le navigateur prévient que le certificat est auto-signé : cliquer sur « Paramètres avancés » puis « Continuer vers le site ». C'est normal et à faire une seule fois. Le HTTPS est obligatoire : sans lui, le navigateur désactive les fonctions de chiffrement.

Pour utiliser PostgreSQL à la place : `npm install`, puis `DATABASE_URL=postgres://utilisateur:motdepasse@hote:5432/base node server.js`.

## Base de données

| | PostgreSQL | SQLite (repli) |
|---|---|---|
| Quand | `DATABASE_URL` définie | `DATABASE_URL` absente |
| Où | le serveur Postgres | `data/lanchat.db` |
| Pour | la production (Dokploy) | le mode bureau, un essai rapide |

Les tables sont créées et **mises à jour automatiquement** au démarrage (migrations numérotées dans `server/db.js`, version notée dans `config.schemaVersion`). Passer d'une ancienne version à celle-ci ne perd rien : tout le monde devient membre des canaux existants, tout est marqué comme lu, le premier compte créé devient propriétaire. Les fichiers envoyés restent sur disque dans `data/uploads/` (chiffrés).

## Déployer sur Dokploy

Le chat tourne alors sur un vrai domaine avec un certificat Let's Encrypt (plus aucun avertissement).

**Option 1 — Compose, tout-en-un (recommandée)** : l'application et sa base PostgreSQL ensemble.
1. *Create Service → Compose*, source GitHub `yuri2397/lan-chat`, branche `main`, fichier `docker-compose.yml`.
2. *Environment* :
   - `POSTGRES_PASSWORD=` un mot de passe long et aléatoire (obligatoire) ;
   - `LANCHAT_CODE=` le code à donner aux collègues (sinon il est généré et affiché dans les logs).
3. *Domains* : service `lanchat`, *Container Port* `3000`, **HTTPS activé**, certificat *Let's Encrypt*.
4. *Deploy*.

**Option 2 — Application + base Dokploy**
1. *Create Service → Database → PostgreSQL* (Dokploy génère le mot de passe) et noter son **Internal Connection URL**.
2. *Create Service → Application*, dépôt `yuri2397/lan-chat`, *Build Type* **Dockerfile**.
3. *Environment* : `DATABASE_URL=` l'URL interne de l'étape 1, et `LANCHAT_CODE=…`.
4. *Advanced → Volumes* : volume monté sur `/data` (fichiers envoyés).
5. *Domains* : port `3000`, HTTPS activé. Puis *Deploy*.

**Déploiement automatique** : la production (https://chat.digita.sn) est redéployée à chaque push sur `main`, via un webhook GitHub qui appelle l'URL de déploiement du service dans Dokploy (onglet *Deployments* → *Webhook URL*). Les tests (`npm test`) tournent sur GitHub Actions à chaque push : attendre qu'ils soient verts avant de fusionner sur `main`.

**Sauvegardes** : la base Postgres (sauvegardes planifiables dans Dokploy) **et** le volume des fichiers (`lanchat-files` ou `/data`). Les contenus sensibles y sont chiffrés ; seules les métadonnées sont en clair.

**En local avec Docker** :
```bash
POSTGRES_PASSWORD=change-moi docker compose up --build
```
(ajouter `ports: ["3000:3000"]` au service `lanchat` pour y accéder sur http://localhost:3000).

## Appels audio

Bouton téléphone en haut d'une conversation privée : appel en tête-à-tête, sonnerie, couper le micro, raccrocher ; la trace (« Appel audio · 3 min », « Appel manqué ») reste dans la conversation.

**Appels de groupe** : bouton casque en haut d'un canal. Le premier démarre l'appel, les autres voient « Appel en cours · Rejoindre » (bandeau, barre latérale, notification) et entrent ou sortent librement, sans sonnerie. Jusqu'à 8 personnes : chaque participant est relié directement à chacun des autres (maillage WebRTC), le serveur ne fait que tenir la liste et relayer les signaux, chiffrés avec la clé du canal.

**Partage d'écran** (appels en tête-à-tête et de groupe, depuis un ordinateur) : bouton écran dans la barre d'appel. Les autres le voient dans un panneau (plein écran, réduction en vignette, choix si plusieurs personnes partagent) ; quelqu'un qui rejoint un appel de groupe en cours de partage le voit tout de suite. Chaque connexion réserve dès le départ une voie vidéo : partager ou arrêter est instantané, sans renégociation. Le débit est plafonné (1,2 à 1,5 Mbit/s, 600 kbit/s à partir de 4 personnes, car le partageur envoie l'écran à chacun). Sur mobile, on peut voir un écran partagé, pas partager le sien.

- Le son va directement d'un navigateur à l'autre (WebRTC), chiffré (DTLS-SRTP). Le serveur ne fait que la mise en relation, et les descriptions de session qu'il relaie sont chiffrées avec la clé de la conversation : il ne peut pas s'intercaler.
- Par défaut, un serveur STUN public aide les navigateurs à se trouver (`LANCHAT_STUN`, vide pour le désactiver). Ça suffit au bureau et sur la plupart des box/4G.
- Réseaux très fermés : relais **TURN** (coturn). Le serveur remet à chaque client des identifiants temporaires (12 h) signés par un secret partagé avec coturn (`LANCHAT_TURN_URLS`, `LANCHAT_TURN_SECRET`).

**Activer le relais TURN sur Dokploy** (service coturn déjà prévu dans `docker-compose.yml`, profil `turn`) :
1. Pare-feu du VPS (UFW ; en réseau « host », c'est lui qui filtre) :
   ```bash
   sudo ufw allow 3478/udp comment coturn && sudo ufw allow 3478/tcp comment coturn && sudo ufw allow 49160:49200/udp comment coturn-relay
   ```
2. Dokploy → service → *Environment* : `COMPOSE_PROFILES=turn` et `TURN_SECRET=` un secret long (`openssl rand -hex 32`). `TURN_HOST` vaut `chat.digita.sn` par défaut.
3. Redéployer. coturn n'accepte que des identifiants valides et refuse de relayer vers les réseaux privés du serveur.

## Sécurité

- **Comptes** : pseudo + mot de passe personnel, création protégée par le code d'accès. Le mot de passe **ne quitte jamais le navigateur** : il est dérivé (PBKDF2, 310 000 itérations) en une clé d'authentification, seule envoyée au serveur, qui la re-hache (scrypt). Blocage progressif après 5 échecs.
- **Chiffrement de bout en bout** (WebCrypto, aucune bibliothèque) :
  - chaque compte a une paire de clés ECDH P-256 générée dans le navigateur ; la clé privée est stockée sur le serveur **chiffrée par le mot de passe** (pour se connecter depuis un autre poste) ;
  - **messages privés** : clé AES-256-GCM dérivée de ECDH entre les deux personnes ;
  - **canaux** : une clé AES-256-GCM aléatoire par canal, transmise automatiquement (chiffrée pour chacun) par n'importe quel membre connecté : à tous les comptes pour un canal public, aux seuls membres pour un canal privé (le serveur refuse de la remettre à quelqu'un d'autre) ;
  - textes, noms et contenus des **fichiers** sont chiffrés avant l'envoi. Le serveur ne stocke et ne relaie que du chiffré.
- **Code de sécurité** : au début de chaque conversation privée et sur le profil de la personne. S'il est identique chez les deux personnes, aucune clé n'a été substituée.
- Restent visibles pour le serveur : pseudos et profils (nom, fonction, photo, statut), noms, sujets et membres des canaux, horaires, réactions emoji et votes des sondages, **personnes mentionnées** (pour les compteurs de mentions et les notifications), messages épinglés ou enregistrés, taille des fichiers. Les envois programmés sont chiffrés avant d'être confiés au serveur.
- En-têtes de sécurité (CSP, anti-iframe, no-referrer). Le mot de passe de la base n'apparaît jamais dans les logs.

**Mot de passe oublié** : impossible à récupérer (c'est le principe). L'hébergeur peut supprimer le compte pour qu'il soit recréé :
```bash
node server.js reset-user Awa          # avec DATABASE_URL=… si la base est PostgreSQL
node server.js make-admin Awa          # donner le rôle d'administrateur
```
Sur Dokploy : onglet *Terminal* du conteneur `lanchat`, puis la même commande.
La personne retrouve l'accès aux canaux (la clé lui est re-partagée), mais pas à ses anciens messages privés.

**Limites assumées** : le serveur distribue le code de l'application et l'annuaire des clés publiques. Un hébergeur malveillant pourrait donc modifier l'un ou l'autre ; le code de sécurité permet de détecter la seconde attaque. Pas de rotation de clé quand quelqu'un quitte un canal privé : il ne reçoit plus rien, mais garde la clé déjà reçue. Les messages d'avant l'activation du chiffrement restent en clair et sont marqués « non chiffré ».

## Fonctionnalités

**Conversations**
- Canaux **publics** (tout le monde peut les lire et les rejoindre) et **privés** (sur invitation), avec sujet, description, membres, archivage ; annuaire des canaux
- Messages directs, et un espace perso pour ses propres notes
- **Fils** de discussion dans un panneau latéral, option « Aussi dans #canal », vue « Fils » avec pastille de nouvelles réponses
- **Réactions**, **sondages** (`/poll "Question" "Choix 1" "Choix 2"`), **messages transférés** vers une autre conversation
- **Épingles** par conversation, **Plus tard** (messages gardés de côté, avec rappel : dans 20 min, demain 9 h, une date au choix)
- **Envois programmés** (flèche à côté du bouton Envoyer) et **brouillons** gardés conversation par conversation
- Non-lus et mentions **synchronisés entre appareils** ; ligne « Nouveaux », « Marquer comme non lu », « Tout marquer comme lu » (Échap)
- **Activité** : mentions, réponses à tes fils, réactions à tes messages
- Recherche dans le navigateur (sur les messages déchiffrés), avec filtres `de:@pseudo`, `dans:#canal`, `avec:fichier|lien|image`
- Liens profonds vers un message (« Copier le lien »), boutons Précédent / Suivant du navigateur

**Écrire**
- Mise en forme façon Slack : `*gras*`, `_italique_`, `~barré~`, `` `code` ``, blocs ```` ``` ```` avec coloration et bouton Copier, `> citation`, listes, `[texte](lien)`
- Autocomplétion : `@` personnes (et `@tous`), `#` canaux, `:` emoji, `/` commandes
- Fichiers jusqu'à 500 Mo chiffrés dans le navigateur (bouton +, glisser-déposer, coller une capture), aperçu des images et vidéos, messages vocaux

**Personnes**
- Profil (nom complet, fonction, photo), **statut** avec échéance (« En réunion · 1 h »), absent, **pause des notifications**
- Préférences par conversation : favori, sourdine, fermer
- Rôles propriétaire / admin / membre ; les admins désactivent un compte, renouvellent le code d'accès, renomment l'espace de travail et peuvent supprimer un message (modération)

**Appels** : audio en tête-à-tête, appels de groupe jusqu'à 8, partage d'écran (voir plus haut)

**Confort**
- `⌘K` / `Ctrl+K` pour aller partout, `Alt+↑/↓` (et `Alt+Maj+↑/↓` pour les non-lus) pour changer de conversation, `⌘/` / `Ctrl+/` pour la liste des raccourcis
- Notifications du système et sons, niveau réglable (tout, ce qui me concerne, rien)
- Thème clair / sombre / automatique, six couleurs de barre latérale, densité confortable ou compacte, version mobile complète

## Architecture

```
server.js            point d'entrée (et commandes reset-user, make-admin)
server/
  config.js          réglages (variables d'environnement)
  db.js              PostgreSQL / SQLite, schéma, migrations
  model.js           état en mémoire et règles d'accès (qui voit quoi)
  realtime.js        flux temps réel (Server-Sent Events)
  http.js            routeur, JSON, fichiers statiques compressés et versionnés
  routes/            auth, workspace (profils, lus, admin), channels, messages, files, calls
public/
  index.html         coquille de l'application, icônes
  css/app.css        toute la feuille de style (jetons, thèmes, composants)
  fonts/             Atkinson Hyperlegible Next & Mono (OFL), hébergées sur place
  js/main.js         point d'entrée du navigateur
  js/lib/            outils sans état : DOM, formats, Markdown, chiffrement, sons, emoji
  js/core/           état et bus d'événements, API, clés de chiffrement, temps réel, navigation
  js/ui/             composants : barre latérale, messages, saisie, panneau, menus, profils, réglages…
  js/views/          conversation affichée, vues transverses (fils, activité, plus tard, recherche…)
  js/rtc/            appels audio, appels de groupe, partage d'écran (WebRTC)
test/api.test.js     tests de l'API (node:test)
```

Tout l'état vit en mémoire côté serveur (rapide pour une petite équipe) et chaque changement est écrit aussitôt dans la base. Le navigateur charge des **modules natifs**, sans compilation : le serveur ajoute à `index.html` une *import map* qui donne à chaque module son empreinte, puis sert modules, styles et polices compressés (brotli) avec un cache permanent. Un rechargement ne télécharge que `index.html`.

Le design est décrit dans [docs/DESIGN.md](docs/DESIGN.md).

## Développement

```bash
node server.js                       # démarrer (SQLite dans data/)
LANCHAT_HTTP=1 PORT=3000 node server.js   # en HTTP : http://localhost:3000 reste un contexte sécurisé
npm test                             # tests de l'API, sur un serveur jetable
```

Aucune étape de compilation : modifier un fichier de `public/` et recharger la page suffit.
