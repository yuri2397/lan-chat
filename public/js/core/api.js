// Appels au serveur. Toute réponse 401 (session expirée, compte désactivé) déclenche la déconnexion.
import { state } from './state.js';

let onExpired = () => {};
export const setExpiredHandler = fn => { onExpired = fn; };
const headers = extra => ({ 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...extra });

export async function api(path, opts = {}) {
  const init = { ...opts, headers: headers(opts.headers) };
  if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) onExpired('Ta session a expiré : reconnecte-toi.');
  if (!res.ok) { const e = new Error(data.error || `Erreur ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
export const post = (path, body) => api(path, { method: 'POST', body: body || {} });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const del = path => api(path, { method: 'DELETE' });

// Envoi d'un fichier déjà chiffré, avec progression (fetch ne la donne pas pour l'envoi)
export function upload(blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 300) reject(new Error(data.error || 'Échec de l’envoi')); else resolve(data);
    };
    xhr.onerror = () => reject(new Error('Connexion interrompue pendant l’envoi'));
    xhr.send(blob);
  });
}
// Requête qui doit partir même pendant la fermeture de l'onglet
export const beacon = (path, body) => fetch(path, { method: 'POST', keepalive: true, headers: headers(), body: JSON.stringify(body) }).catch(() => {});
