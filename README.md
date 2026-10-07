# 💬 LAN Chat

Petit chat façon Slack pour le réseau local du bureau. **Zéro dépendance** (Node ≥ 18), rien ne sort du réseau.

## Démarrer

```bash
git clone https://github.com/yuri2397/lan-chat.git
cd lan-chat
node server.js          # ou PORT=4000 node server.js
```

Pas de `npm install` : il suffit d'avoir Node.js installé (https://nodejs.org).

Le terminal affiche l'adresse à partager, ex. `http://192.168.1.15:3000`. Les collègues l'ouvrent dans leur navigateur, choisissent un pseudo, c'est tout.

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
- Fichiers jusqu'à 500 Mo : bouton 📎, glisser-déposer, ou coller (Cmd+V une capture d'écran) — aperçu des images/vidéos

**Le reste**
- Présence en ligne, compteurs de non-lus, notifications du navigateur + son (coupable 🔕), recherche
- `⌘K` / `Ctrl+K` pour sauter vers un canal ou une personne
- Thème clair / sombre / automatique, version mobile
- Historique conservé dans `data/` (journal JSONL + fichiers dans `data/uploads/`)

## Limites (assumées)

- Pas de mot de passe : le pseudo suffit, n'importe qui sur le réseau peut lire les canaux. À utiliser sur un réseau de confiance uniquement.
- Une machine fait office de serveur : si elle s'éteint, le chat s'arrête (l'historique reste dans `data/`).
- macOS peut demander d'autoriser les connexions entrantes pour `node` au premier lancement : accepter.
