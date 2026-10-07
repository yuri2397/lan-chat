# 💬 LAN Chat

Petit chat façon Slack pour le bureau, **chiffré de bout en bout**. **Zéro dépendance** (Node ≥ 18).

## Démarrer sur le réseau du bureau

```bash
git clone https://github.com/yuri2397/lan-chat.git
cd lan-chat
node server.js          # ou PORT=4000 node server.js
```

Pas de `npm install` : il suffit d'avoir Node.js (https://nodejs.org) et `openssl` (déjà présent sur macOS et Linux).

Le terminal affiche :
- l'adresse à partager, ex. `https://192.168.1.15:3000` ;
- le **code d'accès** à donner aux collègues pour qu'ils créent leur compte.

Au premier accès, le navigateur prévient que le certificat est auto-signé : cliquer sur « Paramètres avancés » puis « Continuer vers le site ». C'est normal et à faire une seule fois. Le HTTPS est obligatoire : sans lui, le navigateur désactive les fonctions de chiffrement.

## Déployer sur Dokploy

Le chat tourne alors sur un vrai domaine avec un certificat Let's Encrypt (plus aucun avertissement).

**Option 1 — Application (recommandée)**
1. *Create Service → Application*, source GitHub `yuri2397/lan-chat`, branche `main`.
2. *Build Type* : **Dockerfile** (chemin `Dockerfile`).
3. *Environment* : `LANCHAT_CODE=un-code-a-partager` (sinon un code est généré et affiché dans les logs).
4. *Advanced → Volumes* : **volume** monté sur `/data` (indispensable : comptes, clés et messages y sont stockés).
5. *Domains* : ton domaine, *Container Port* `3000`, **HTTPS activé**, certificat *Let's Encrypt*.
6. *Deploy*.

**Option 2 — Docker Compose** : *Create Service → Compose*, même dépôt, fichier `docker-compose.yml`, puis domaine sur le service `lanchat`, port `3000`, HTTPS activé.

**En local avec Docker** :
```bash
docker build -t lanchat . && docker run -p 3000:3000 -v lanchat-data:/data lanchat
```
puis http://localhost:3000.

Sauvegarde : le volume `/data` contient tout. Le sauvegarder suffit (son contenu sensible est chiffré, sauf les métadonnées).

## Sécurité

- **Comptes** : pseudo + mot de passe personnel, création protégée par le code d'accès. Le mot de passe **ne quitte jamais le navigateur** : il est dérivé (PBKDF2, 310 000 itérations) en une clé d'authentification, seule envoyée au serveur, qui la re-hache (scrypt). Blocage progressif après 5 échecs.
- **Chiffrement de bout en bout** (WebCrypto, aucune bibliothèque) :
  - chaque compte a une paire de clés ECDH P-256 générée dans le navigateur ; la clé privée est stockée sur le serveur **chiffrée par le mot de passe** (pour se connecter depuis un autre poste) ;
  - **messages privés** : clé AES-256-GCM dérivée de ECDH entre les deux personnes ;
  - **canaux** : une clé AES-256-GCM aléatoire par canal, transmise automatiquement à chaque membre (chiffrée pour lui) par n'importe quel membre connecté ;
  - textes, noms et contenus des **fichiers** sont chiffrés avant l'envoi. Le serveur ne stocke et ne relaie que du chiffré.
- **Code de sécurité** : en haut de chaque conversation privée. S'il est identique chez les deux personnes, aucune clé n'a été substituée.
- Restent visibles pour le serveur : pseudos, noms des canaux, horaires, réactions emoji, taille des fichiers.
- En-têtes de sécurité (CSP, anti-iframe, no-referrer), données sensibles en `chmod 600`.

**Mot de passe oublié** : impossible à récupérer (c'est le principe). L'hébergeur peut supprimer le compte pour qu'il soit recréé :
```bash
node server.js reset-user Awa
```
La personne retrouve l'accès aux canaux (la clé lui est re-partagée), mais pas à ses anciens messages privés.

**Limites assumées** : le serveur distribue le code de l'application et l'annuaire des clés publiques. Un hébergeur malveillant pourrait donc modifier l'un ou l'autre ; le code de sécurité permet de détecter la seconde attaque. Pas de rotation de clé quand quelqu'un quitte un canal. Les messages d'avant l'activation du chiffrement restent en clair et sont marqués « non chiffré ».

## Fonctionnalités

**Discussions**
- Canaux (`#general`, `#code`, `#liens` + création libre) et messages directs
- **Fils de discussion** façon Slack : survoler un message → 💬 « Répondre dans un fil », panneau latéral, option « Aussi dans #canal », vue « Fils de discussion » qui regroupe tous les fils auxquels tu participes
- **Réactions emoji** (✅ 👀 🙌 en un clic, ou le sélecteur complet avec recherche en français)
- Modifier (`↑` dans une zone vide pour modifier ton dernier message) et supprimer ses messages
- « Awa est en train d'écrire… », ligne « Nouveaux » sur les messages non lus, pastille « ↓ nouveaux messages »

**Écrire**
- Blocs de code ```` ```js ```` avec coloration et bouton **Copier**, `code inline`, **gras**, _italique_, ~barré~, `> citation`, liens cliquables
- Autocomplétion : `@` pour mentionner (`@tous` pour tout le monde), `:feu` pour les emoji, `/` pour les commandes
- Commandes : `/shrug`, `/flip`, `/unflip`, `/lenny`, `/code`, et `/party` qui envoie des confettis à tout le monde 🎉
- Fichiers jusqu'à 500 Mo (chiffrés dans le navigateur) : bouton 📎, glisser-déposer, ou coller une capture d'écran — aperçu des images/vidéos

**Le reste**
- Présence en ligne, compteurs de non-lus, notifications du navigateur + son (coupable 🔕), recherche (faite dans le navigateur, sur les messages déchiffrés)
- `⌘K` / `Ctrl+K` pour sauter vers un canal ou une personne
- Thème clair / sombre / automatique, version mobile
