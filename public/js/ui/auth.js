// Connexion et création de compte. Le mot de passe ne quitte jamais le navigateur (voir lib/e2e.js).
import { $, esc, icon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { E2E } from '../lib/e2e.js';
import { busy } from './layer.js';

const NAME_RE = /^[\w.\-À-ÿ]{2,32}$/;
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erreur ' + r.status);
  return d;
}

// Affiche l'écran ; résout avec la session { name, token, priv, pub } une fois connecté
export function showAuth({ flash = '' } = {}) {
  return new Promise(async resolve => {
    const account = store.get('account'), legacy = store.get('user');
    let mode = account || !legacy ? 'login' : 'register'; // ancien utilisateur sans compte : on lui propose d'en créer un
    let workspace = 'LAN Chat';
    try { workspace = (await fetch('/api/prelogin?name=').then(r => r.json())).workspace || workspace; } catch {}
    const el = $('#auth');
    el.innerHTML = `<section class="auth-brand" aria-hidden="false">
        <div class="auth-logo"><img src="/icon.svg" alt="">${esc(workspace)}</div>
        <div class="auth-pitch"><h1>Le chat de l’équipe, rien que pour vous.</h1>
          <p>Canaux, messages directs, fils, appels et partage d’écran, sur votre propre serveur.</p>
          <div class="auth-convo" aria-hidden="true"><div><i></i><span></span></div><div><i></i><span></span></div><div><i></i><span></span></div><div><i></i><span><b></b><b></b><b></b></span></div></div></div>
        <ul class="auth-points">
          <li>${icon('lock')}<span><b>Chiffré de bout en bout.</b> Tes messages et fichiers sont chiffrés dans ton navigateur : le serveur ne peut pas les lire.</span></li>
          <li>${icon('shield')}<span><b>Chez vous.</b> Les données restent sur le serveur de l’équipe, sur votre réseau.</span></li>
        </ul>
      </section>
      <section class="auth-form-wrap"><form class="auth-form" novalidate>
        <h2 data-title></h2><p data-sub></p>
        <div class="seg" role="tablist"><button type="button" data-mode="login">Se connecter</button><button type="button" data-mode="register">Créer un compte</button></div>
        <label class="field"><span>Pseudo</span><div class="input-prefix"><b>@</b><input name="username" maxlength="32" placeholder="awa.ndiaye" autocomplete="username" autocapitalize="none" spellcheck="false" required></div></label>
        <label class="field reg"><span>Nom complet <small>(facultatif)</small></span><input name="displayName" maxlength="60" placeholder="Awa Ndiaye" autocomplete="name"></label>
        <label class="field"><span>Mot de passe</span><input name="password" type="password" autocomplete="current-password" required></label>
        <label class="field reg"><span>Confirme le mot de passe</span><input name="password2" type="password" autocomplete="new-password"></label>
        <label class="field reg"><span>Code d’accès de l’équipe</span><input name="code" autocomplete="off" spellcheck="false" placeholder="abcd-efgh"><small>Demande-le à la personne qui administre le chat.</small></label>
        <p class="auth-note reg">Ton mot de passe protège aussi ta clé de chiffrement : <b>s’il est perdu, tes anciens messages privés le sont aussi.</b> Personne ne peut le récupérer, pas même l’administrateur.</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary" type="submit"></button>
        <p class="auth-foot">${icon('lock')}<span>La connexion vérifie ton mot de passe sans jamais l’envoyer : il sert seulement à déverrouiller tes clés, ici.</span></p>
      </form></section>`;
    el.hidden = false;
    const form = $('form', el), err = $('.form-error', el), btn = $('button[type=submit]', el);
    const f = n => form.elements[n];
    const setError = t => { err.textContent = t; err.hidden = !t; };
    const setMode = m => {
      mode = m;
      el.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-selected', b.dataset.mode === m); });
      el.querySelectorAll('.reg').forEach(x => { x.hidden = m !== 'register'; });
      f('password').autocomplete = m === 'register' ? 'new-password' : 'current-password';
      $('[data-title]', el).textContent = m === 'register' ? 'Créer ton compte' : 'Bon retour !';
      $('[data-sub]', el).textContent = m === 'register' ? `Rejoins ${workspace}.` : `Connecte-toi à ${workspace}.`;
      btn.textContent = m === 'register' ? 'Créer mon compte' : 'Se connecter';
      setError('');
    };
    el.querySelector('.seg').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
    f('username').value = account || legacy || '';
    setMode(mode);
    setError(flash);
    (f('username').value ? f('password') : f('username')).focus();

    form.onsubmit = e => {
      e.preventDefault();
      const name = f('username').value.trim(), pw = f('password').value;
      if (!NAME_RE.test(name)) { setError('Pseudo : 2 à 32 caractères (lettres, chiffres, . - _), sans espace.'); return f('username').focus(); }
      if (!pw) { setError('Saisis ton mot de passe.'); return f('password').focus(); }
      if (mode === 'register') {
        if (pw.length < 8) { setError('Le mot de passe doit faire au moins 8 caractères.'); return f('password').focus(); }
        if (pw !== f('password2').value) { setError('Les deux mots de passe ne correspondent pas.'); return f('password2').focus(); }
        if (!f('code').value.trim()) { setError('Saisis le code d’accès de l’équipe.'); return f('code').focus(); }
      }
      setError('');
      busy(btn, async () => {
        const label = btn.textContent;
        btn.lastChild.textContent = mode === 'register' ? 'Création de tes clés…' : 'Vérification…';
        try {
          const pre = await fetch('/api/prelogin?' + new URLSearchParams({ name })).then(r => r.json());
          let session;
          if (mode === 'register') {
            if (pre.exists) throw new Error('Ce pseudo est déjà pris.');
            const kdfSalt = E2E.randomB64(16);
            const { authKey, encKey } = await E2E.deriveFromPassword(pw, kdfSalt);
            const id = await E2E.createIdentity(encKey);
            const r = await postJson('/api/register', { name, displayName: f('displayName').value, code: f('code').value.trim(), kdfSalt, authKey, pub: id.pub, encPriv: id.encPriv });
            session = { name, token: r.token, priv: id.priv, pub: id.pub };
          } else {
            if (!pre.exists) throw new Error('Pseudo ou mot de passe incorrect');
            const { authKey, encKey } = await E2E.deriveFromPassword(pw, pre.kdfSalt);
            const r = await postJson('/api/login', { name, authKey });
            session = { name, token: r.token, priv: await E2E.openIdentity(encKey, r.encPriv), pub: r.pub };
          }
          try { await E2E.saveSession(session); } catch {} // navigation privée : il faudra se reconnecter au rechargement
          store.set('account', name);
          el.hidden = true; el.innerHTML = '';
          resolve(session);
        } catch (er) { setError(er.message || 'Échec de la connexion'); btn.lastChild.textContent = label; }
      });
    };
  });
}

// WebCrypto n'existe qu'en HTTPS (ou sur localhost) : sans lui, pas de chiffrement possible
export function showInsecure() {
  const el = $('#auth');
  el.innerHTML = `<section class="auth-brand"><div class="auth-logo"><img src="/icon.svg" alt="">LAN Chat</div><div class="auth-pitch"><h1>Une connexion sécurisée est nécessaire.</h1></div><span></span></section>
    <section class="auth-form-wrap"><div class="auth-form"><h2>Passe en HTTPS</h2>
      <p>Le chiffrement de bout en bout ne fonctionne qu’en HTTPS. Ouvre la version sécurisée du chat ; si le navigateur affiche un avertissement de certificat, choisis « Paramètres avancés » puis « Continuer vers le site ».</p>
      <a class="btn primary" style="width:100%;margin-top:18px" href="https://${esc(location.host + location.pathname)}">Ouvrir la version sécurisée</a></div></section>`;
  el.hidden = false;
}
