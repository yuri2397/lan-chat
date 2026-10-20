# Design

Ce document explique les choix visuels de LAN Chat, pour que les prochaines évolutions restent cohérentes.

## Le sujet

Un outil ouvert toute la journée par une petite équipe, au bureau et sur mobile. Son travail : **lire vite, répondre vite, savoir ce qui attend une réponse.** Le design est donc calme par défaut et ne s'élève que pour ce qui concerne la personne (mention, message direct, appel).

## Principes

1. **Calme par défaut, visible quand ça te concerne.** Les canaux non lus passent en gras ; seuls les messages directs, les mentions et les fils ont une pastille. Le rouge (`--signal`) est réservé à ces signaux et aux actions destructrices.
2. **Le contenu avant le décor.** Pas de bulles ni de cartes autour des messages : un alignement net (avatar, nom, heure), des messages regroupés par auteur et par jour. Les cartes n'apparaissent que là où elles portent un sens (sondage, fichier, appel, fil dans la vue « Fils »).
3. **Une seule audace : la barre latérale.** Elle porte la couleur de l'espace de travail (« Forêt » par défaut, cinq autres au choix). L'élément actif est une pastille claire, très lisible, plutôt qu'un simple surlignage.
4. **Une police hyperlisible.** *Atkinson Hyperlegible Next*, dessinée par le Braille Institute pour distinguer chaque lettre (l / I / 1, O / 0), et sa version *Mono* pour le code : une seule famille, deux rôles. Hébergées sur place (sous-ensemble latin, ~52 Ko au total), sans dépendre d'un service externe.
5. **Léger.** Aucun framework ni compilation ; une feuille de style unique organisée par jetons ; icônes en sprite SVG dans la page.

## Jetons

Toutes les couleurs sont des variables CSS (`public/css/app.css`, section 2), redéfinies pour le thème sombre et pour chaque barre latérale.

| Rôle | Clair | Sombre | Usage |
|---|---|---|---|
| `--accent` | `#10704f` | `#3dbd8f` | actions principales, liens, focus, sélection |
| `--signal` | `#d33d2a` | `#f0614d` | pastilles de non-lus, ligne « Nouveaux », suppression |
| `--mention-*` | ambre doux | ambre doux | messages qui te mentionnent |
| `--side-*` | selon le thème | | barre latérale |
| neutres | gris légèrement verts | | texte, fonds, bordures |

Échelle de texte : 12,5 (méta) · 14,5 (barre latérale) · **15 (messages)** · 17 (titre de conversation) · 24-26 (titres de vues) · 32-48 (écran de connexion). Graisses : 400, 650-750, 800 pour les titres.

Rayons : 6, 9, 14 px (les enfants n'ont jamais un rayon plus grand que leur parent). Ombres à deux couches (lumière ambiante + directe).

## Comportements

- **Mouvement** : réservé à la cause et à l'effet (un message qui arrive monte de 6 px, un menu s'ouvre depuis son bouton). Tout est désactivé avec `prefers-reduced-motion`.
- **Accessibilité** : focus visible partout (`:focus-visible`), boutons icônes avec libellé, navigation au clavier dans les menus, le sélecteur ⌘K et les fenêtres (piège à focus), contraste AA, textes d'état qui ne reposent pas sur la seule couleur.
- **Mobile** : la barre latérale devient l'écran d'accueil, la conversation glisse par-dessus, les menus et fenêtres deviennent des feuilles en bas de l'écran, les cibles tactiles font au moins 44 px, les zones sûres (encoche) sont respectées.
- **Rédaction** : en français, à la deuxième personne, à la voix active. Chaque état vide explique ce qui se passe et ce qu'on peut faire.

## Références suivies

- [Frontend design skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design) (Anthropic) : partir du sujet, une seule audace, éviter les clichés « générés ».
- [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) (Vercel) : focus, cibles, état dans l'adresse, chargements, formulaires, ombres, contraste.
