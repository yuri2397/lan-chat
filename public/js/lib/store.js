// localStorage, protégé (navigation privée, stockage bloqué) : seulement pour des préférences locales et les brouillons.
export const store = {
  get: k => { try { return localStorage.getItem('lanchat:' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('lanchat:' + k, v); } catch {} },
  del: k => { try { localStorage.removeItem('lanchat:' + k); } catch {} },
  json: (k, fallback) => { try { return JSON.parse(localStorage.getItem('lanchat:' + k)) ?? fallback; } catch { return fallback; } },
  setJson: (k, v) => { try { localStorage.setItem('lanchat:' + k, JSON.stringify(v)); } catch {} },
};
