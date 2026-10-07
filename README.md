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

- Canaux (`#general`, `#code`, `#liens` + création libre) et messages directs
- Blocs de code ```` ```js ```` avec coloration et bouton **Copier**, `code inline`, **gras**, liens cliquables, `@mentions` (`@tous` pour tout le monde)
- Fichiers jusqu'à 500 Mo : bouton 📎, glisser-déposer, ou coller (Cmd+V une capture d'écran) — aperçu des images/vidéos
- Présence en ligne, compteurs de non-lus, notifications du navigateur, recherche, suppression de ses messages
- Historique conservé dans `data/` (messages en JSONL + fichiers dans `data/uploads/`)

## Limites (assumées)

- Pas de mot de passe : le pseudo suffit, n'importe qui sur le réseau peut lire les canaux. À utiliser sur un réseau de confiance uniquement.
- Une machine fait office de serveur : si elle s'éteint, le chat s'arrête (l'historique reste dans `data/`).
- macOS peut demander d'autoriser les connexions entrantes pour `node` au premier lancement : accepter.
