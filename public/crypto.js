// Chiffrement de bout en bout — WebCrypto natif, aucune dépendance.
//
// - Mot de passe -> PBKDF2-SHA256 (310 000 itérations) -> 512 bits :
//     * 256 premiers bits = clé d'authentification (seule envoyée au serveur, qui la re-hache avec scrypt)
//     * 256 derniers bits = clé AES qui chiffre la clé privée d'identité (ne quitte jamais le navigateur)
// - Identité : paire ECDH P-256. La clé publique est publiée, la clé privée est stockée chiffrée sur le serveur
//   (pour se connecter depuis un autre poste) et gardée localement en CryptoKey non exportable (IndexedDB).
// - Message privé : clé AES-GCM dérivée de ECDH(moi, l'autre) + HKDF.
// - Canal : clé AES-GCM aléatoire, distribuée à chaque membre chiffrée via ECDH(expéditeur, destinataire) + HKDF.
// - Chaque chiffrement AES-GCM utilise un IV aléatoire et le nom du canal comme données authentifiées (AAD),
//   pour qu'un message ne puisse pas être déplacé d'un canal à l'autre.
const E2E = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = window.crypto && crypto.subtle;
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

  const b64 = buf => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const randomB64 = n => b64(crypto.getRandomValues(new Uint8Array(n)));
  const aad = s => (s ? te.encode(s) : new Uint8Array(0));
  const available = () => !!(window.isSecureContext && subtle);

  async function deriveFromPassword(password, saltB64) {
    const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: unb64(saltB64), iterations: 310000, hash: 'SHA-256' }, base, 512));
    return {
      authKey: b64(bits.slice(0, 32)),
      encKey: await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']),
    };
  }

  async function encryptRaw(key, bytes, ad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ad) }, key, bytes);
    return { iv: b64(iv), ct };
  }
  async function decryptRaw(key, ivB64, ct, ad) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64), additionalData: aad(ad) }, key, ct));
  }
  async function encrypt(key, bytes, ad) {
    const { iv, ct } = await encryptRaw(key, bytes, ad);
    return { iv, ct: b64(ct) };
  }
  const decrypt = (key, e, ad) => decryptRaw(key, e.iv, unb64(e.ct), ad);
  const encryptPayload = (key, obj, ad) => encrypt(key, te.encode(JSON.stringify(obj)), ad);
  const decryptPayload = async (key, e, ad) => JSON.parse(td.decode(await decrypt(key, e, ad)));

  // ----- Identité -----
  async function createIdentity(encKey) {
    const kp = await subtle.generateKey(CURVE, true, ['deriveBits']);
    const pub = b64(await subtle.exportKey('raw', kp.publicKey));
    const pkcs8 = await subtle.exportKey('pkcs8', kp.privateKey);
    const encPriv = await encrypt(encKey, pkcs8, 'identity');
    const priv = await subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']); // version non exportable
    return { pub, encPriv, priv };
  }
  async function openIdentity(encKey, encPriv) {
    const pkcs8 = await decrypt(encKey, encPriv, 'identity');
    return subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
  }

  // ----- Clés partagées (ECDH + HKDF) -----
  const pubCache = new Map(), sharedCache = new Map();
  function importPub(pubB64) {
    if (!pubCache.has(pubB64)) pubCache.set(pubB64, subtle.importKey('raw', unb64(pubB64), CURVE, false, []));
    return pubCache.get(pubB64);
  }
  function sharedKey(priv, theirPubB64, info) {
    const k = theirPubB64 + '|' + info;
    if (!sharedCache.has(k)) {
      sharedCache.set(k, (async () => {
        const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(theirPubB64) }, priv, 256);
        const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
        return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) },
          hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      })());
      sharedCache.get(k).catch(() => sharedCache.delete(k));
    }
    return sharedCache.get(k);
  }
  const dmKey = (priv, theirPub, channel) => sharedKey(priv, theirPub, 'lanchat-dm|' + channel);

  // ----- Clés de canal -----
  async function importChannelKey(raw) {
    return { raw, key: await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }
  const newChannelKey = () => importChannelKey(crypto.getRandomValues(new Uint8Array(32)));
  async function wrapChannelKey(priv, raw, toPub, channel) {
    return encrypt(await sharedKey(priv, toPub, 'lanchat-wrap|' + channel), raw, channel);
  }
  async function unwrapChannelKey(priv, wrapped, fromPub, channel) {
    return importChannelKey(await decrypt(await sharedKey(priv, fromPub, 'lanchat-wrap|' + channel), wrapped, channel));
  }

  // ----- Fichiers -----
  async function encryptFile(key, buffer, channel) {
    const { iv, ct } = await encryptRaw(key, buffer, channel);
    return { iv, data: new Blob([ct]) };
  }
  const decryptFile = (key, iv, buffer, channel) => decryptRaw(key, iv, buffer, channel);

  // ----- Code de sécurité (à comparer de vive voix pour exclure une substitution de clé par le serveur) -----
  async function safetyNumber(pubA, pubB) {
    const [x, y] = [pubA, pubB].sort();
    const h = new Uint8Array(await subtle.digest('SHA-256', te.encode(x + '|' + y)));
    const groups = [];
    for (let i = 0; i < 6; i++) groups.push(String(((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 100000).padStart(5, '0'));
    return groups.join(' ');
  }

  // ----- Session locale (IndexedDB : la clé privée y est stockée en CryptoKey non exportable) -----
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('lanchat', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { open.result.close(); resolve(req && req.result); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const saveSession = s => idb('readwrite', st => st.put(s, 'session'));
  const loadSession = () => idb('readonly', st => st.get('session')).catch(() => null);
  const clearSession = () => idb('readwrite', st => st.delete('session')).catch(() => {});
  function reset() { pubCache.clear(); sharedCache.clear(); }

  return {
    available, randomB64, deriveFromPassword, createIdentity, openIdentity,
    dmKey, newChannelKey, wrapChannelKey, unwrapChannelKey,
    encryptPayload, decryptPayload, encryptFile, decryptFile, safetyNumber,
    saveSession, loadSession, clearSession, reset,
  };
})();
