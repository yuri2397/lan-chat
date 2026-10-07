// Catalogue d'emoji : "emoji|mot-clé,mot-clé" (mots-clés en français + quelques équivalents anglais pour :shortcodes:)
const EMOJI_CATS = [
  ['Smileys', `😀|sourire,grin 😃|content,smiley 😄|rire,smile 😁|dents,grin 😆|mdr,laugh 😅|sueur,sweat 😂|lol,joy 🤣|ptdr,rofl
    🙂|ok,slight 🙃|ironie,upside 😉|clin,wink 😊|timide,blush 😇|ange,innocent 🥰|amour,love 😍|coeur,heart_eyes 🤩|wow,star_struck
    😘|bisou,kiss 😋|miam,yum 😛|langue,tongue 😜|fou,crazy 🤪|zinzin,zany 🤑|argent,money 🤗|calin,hug 🤭|oups,giggle
    🤫|chut,shh 🤔|reflechir,think 🤐|silence,zip 🤨|doute,hmm 😐|neutre,neutral 😑|bof,expressionless 😶|sans_voix 😏|malin,smirk
    😒|blase,unamused 🙄|yeux_ciel,eyeroll 😬|gene,grimace 😌|soulage,relieved 😔|triste,pensive 😪|fatigue,sleepy 😴|dodo,sleep
    😷|malade,mask 🤒|fievre,sick 🤯|boom,mindblown 🥳|fete,partying 😎|cool,sunglasses 🤓|nerd,geek 🧐|monocle,inspect
    😕|confus,confused 😟|inquiet,worried 😮|oh,surprise 😲|choc,astonished 🥺|stp,please 😢|pleure,cry 😭|sanglot,sob
    😱|peur,scream 😤|grr,triumph 😡|colere,rage 🤬|insulte,cursing 💀|mort,skull 💩|caca,poop 🤡|clown 👻|fantome,ghost
    👽|alien 🤖|robot,bot 🫠|fondre,melting 🫡|salut_militaire,salute`],
  ['Gestes', `👍|+1,ok,pouce,like,thumbsup 👎|-1,non,dislike 👌|parfait,ok_hand ✌️|paix,victoire,peace 🤞|croise,doigts,fingers_crossed
    🤝|accord,deal,handshake 👏|bravo,clap 🙌|youpi,hourra,raised_hands 🙏|merci,svp,pray 💪|force,muscle 👀|yeux,regarde,eyes
    👋|salut,coucou,wave ✋|stop,main,hand 🤙|appelle,call_me 👉|droite,right 👈|gauche,left 👆|haut,up ☝️|un,point
    👇|bas,down 🤷|sais_pas,shrug 🤦|facepalm,consterne 🙋|moi,question,raising_hand 🧠|cerveau,brain 🫶|coeur_mains,heart_hands`],
  ['Symboles', `❤️|coeur,heart,rouge 🧡|orange 💛|jaune,yellow 💚|vert,green 💙|bleu,blue 💜|violet,purple 🖤|noir,black 💔|brise,broken
    💯|cent,100 🔥|feu,fire,top ✨|brille,sparkles ⭐|etoile,star ⚡|eclair,rapide,zap 💥|boom,collision 🎉|tada,fete,party
    🎊|confetti 🎁|cadeau,gift 🏆|trophee,win,trophy 🥇|or,premier,gold 🚀|fusee,ship,rocket ✅|valide,check,done ✔️|coche
    ❌|non,erreur,x ⚠️|attention,warning ❓|question ❗|important,exclamation 💡|idee,idea 📌|epingle,pin 📎|trombone,paperclip
    🔗|lien,link 📝|note,memo 📅|date,calendrier,calendar ⏰|reveil,alarm ⏳|attente,sablier,hourglass 🆗|ok_bouton 🆘|sos 🚨|alerte,alert`],
  ['Bureau & dev', `💻|ordi,laptop 🖥️|ecran,desktop ⌨️|clavier,keyboard 🖱️|souris,mouse 🐛|bug 🔧|fix,cle,wrench 🛠️|outils,tools
    ⚙️|config,engrenage,gear 🧪|test 📦|paquet,package,colis 🔒|securite,lock 🔑|cle,key 🗑️|poubelle,trash 📊|stats,chart
    📈|hausse,up 📉|baisse,down 🧹|nettoyage,cleanup 🚧|travaux,wip 🧵|fil,thread 🐳|docker,baleine 🐘|php,elephant 🐍|python,serpent
    ☁️|cloud,nuage 🌐|web,internet 📱|mobile,phone 🗂️|dossier,folder 📁|fichier,file 🧾|facture,receipt 💰|budget,cash 📣|annonce,announce`],
  ['Nourriture & loisirs', `☕|cafe,coffee 🍵|the,tea 🧃|jus,juice 🍺|biere,beer 🥐|croissant 🍕|pizza 🍔|burger 🍟|frites,fries
    🍗|poulet,chicken 🍚|riz,rice 🥭|mangue,mango 🍉|pasteque,watermelon 🍰|gateau,cake 🍫|chocolat ⚽|foot,soccer 🏀|basket
    🎮|jeu,game 🎵|musique,music 🎬|film,movie 🏖️|plage,vacances,beach ✈️|avion,voyage,plane 🌞|soleil,sun 🌧️|pluie,rain 🌙|nuit,moon`],
];
const EMOJIS = [];
for (const [cat, list] of EMOJI_CATS) {
  for (const entry of list.trim().split(/\s+/)) {
    const [ch, kws] = entry.split('|');
    EMOJIS.push({ ch, cat, kw: (kws || '').split(',').filter(Boolean) });
  }
}
