// Vues transverses, affichées à la place d'une conversation : fils, activité, plus tard, brouillons et envois
// programmés, recherche, annuaire des canaux.
import { $, esc, icon, h } from '../lib/dom.js';
import { fmtWhen, fmtFuture, fmtAgo, plural } from '../lib/format.js';
import { plainPreview } from '../lib/markdown.js';
import { state, bus, isDm, label, nameOf, channel, isMember, dmOther } from '../core/state.js';
import { api, post, del, patch } from '../core/api.js';
import { decryptAll, decryptMsg } from '../core/keys.js';
import { go, openConvo } from '../core/router.js';
import { renderMessage, whereOf } from '../ui/messages.js';
import { drafts } from '../ui/composer.js';
import { openThread } from '../ui/thread.js';
import { toast, menu } from '../ui/layer.js';
import { remindChoices, pickDateTime } from '../ui/actions.js';
import { createChannel } from '../ui/details.js';
import { searchBox } from './channel.js';

const box = $('#msgs');
const TITLES = {
  threads: ['thread', 'Fils de discussion', 'Les fils auxquels tu participes, du plus récent au plus ancien.'],
  activity: ['activity', 'Activité', 'Ce qui te concerne : mentions, réponses à tes fils, réactions à tes messages.'],
  later: ['bookmark', 'Plus tard', 'Les messages que tu as gardés de côté, avec leurs rappels.'],
  drafts: ['draft', 'Brouillons et envois', 'Tes messages commencés et ceux programmés pour plus tard.'],
  search: ['search', 'Recherche', ''],
  browse: ['hash', 'Canaux', 'Tous les canaux de l’espace de travail. Rejoins ceux qui t’intéressent.'],
};
let token = 0;
let redrawBrowse = null;
bus.on('channels', () => { if (state.route.view === 'browse' && $('.browse-list', box)) redrawBrowse?.(); });

export async function openView(r) {
  const [ic, title] = TITLES[r.view];
  $('#top').innerHTML = `<button type="button" class="icon-btn top-back" data-top="back" aria-label="Retour">${icon('back')}</button>
    <div class="top-title"><span class="top-name">${icon(ic)}<span>${esc(title)}</span></span></div><span class="top-spacer"></span>${searchBox(r.view === 'search' ? r.q : '')}`;
  $('#banners').innerHTML = '';
  const my = ++token;
  if (r.view !== 'search' || !box.querySelector('.view-head')) box.innerHTML = '';
  box.scrollTop = 0;
  try { await RENDER[r.view](r, () => my === token); }
  catch (e) { if (my === token) box.innerHTML = empty('info', 'Impossible d’afficher cette page', esc(e.message)); }
}
const head = (view, extra = '') => `<div class="view-head"><h1>${esc(TITLES[view][1])}</h1>${TITLES[view][2] ? `<p>${TITLES[view][2]}</p>` : ''}${extra}</div>`;
const empty = (ic, title, text, action = '') => `<div class="empty"><div class="empty-ic">${icon(ic)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
// Carte : en-tête (où, quand) + message en lecture seule ; cliquer ouvre le message à sa place
function card(m, { headHtml, unread = false, actions = '' } = {}) {
  const el = h(`<div class="item${unread ? ' unread' : ''}" tabindex="0"><div class="item-head">${headHtml || `<b>${esc(whereOf(m))}</b><span class="spacer"></span><span>${esc(fmtWhen(m.ts))}</span>`}</div></div>`);
  el.appendChild(renderMessage(m, null, { card: true, inThread: true }));
  if (actions) el.insertAdjacentHTML('beforeend', `<div class="item-actions">${actions}</div>`);
  const open = () => m.parent && !m.broadcast ? (openConvo(m.channel), openThread(m.parent, m.id)) : openConvo(m.channel, m.id);
  el.addEventListener('click', e => { if (!e.target.closest('button,a,.react,[data-user]')) open(); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) open(); });
  el._open = open;
  return el;
}

// Historique récent déchiffré (la recherche et l'activité se font dans le navigateur)
let allCache = null;
bus.on('messages-changed', () => { allCache = null; });
async function allMessages() {
  if (!allCache || Date.now() - allCache.ts > 30000) {
    const { messages } = await api('/api/all');
    allCache = { ts: Date.now(), messages: await decryptAll(messages) };
  }
  return allCache.messages;
}

const RENDER = {
  // ---------- Fils ----------
  async threads(r, alive) {
    const { threads } = await api('/api/threads');
    await decryptAll(threads.flatMap(t => [t.parent, ...t.latest]));
    if (!alive()) return;
    box.innerHTML = head('threads');
    if (!threads.length) { box.insertAdjacentHTML('beforeend', empty('thread', 'Aucun fil pour l’instant', 'Survole un message et choisis « Répondre dans un fil » : la conversation continue à côté, sans encombrer le canal.')); return; }
    for (const { parent, latest } of threads) {
      const unread = state.threadUnread.has(parent.id);
      const c = h(`<div class="th-card"><div class="th-card-head"><b>${esc(label(parent.channel))}</b><span class="spacer"></span>${unread ? '<span class="new">Nouvelles réponses</span> · ' : ''}<span>${plural(parent.thread.count, 'réponse', 'réponses')}</span></div></div>`);
      c.appendChild(renderMessage(parent, null, { inThread: true, isParent: true }));
      const hidden = parent.thread.count - latest.length;
      if (hidden > 0) c.appendChild(h(`<div class="th-more"><button type="button" class="link-btn">Voir ${plural(hidden, 'réponse de plus', 'réponses de plus')}</button></div>`));
      let prev = null;
      for (const m of latest) { c.appendChild(renderMessage(m, prev, { inThread: true })); prev = m; }
      c.appendChild(h(`<div class="th-foot"><button type="button" class="btn sm">${icon('thread', 'sm')}Répondre…</button></div>`));
      c.querySelectorAll('.th-more button, .th-foot button').forEach(b => { b.onclick = () => openThread(parent.id); });
      box.appendChild(c);
    }
  },

  // ---------- Activité ----------
  async activity(r, alive) {
    const all = await allMessages();
    if (!alive()) return;
    const me = state.me;
    const byId = new Map(all.map(m => [m.id, m]));
    const items = [];
    for (const m of all) {
      if (m.user === me) {
        for (const [e, users] of Object.entries(m.reactions || {})) {
          const others = users.filter(u => u !== me);
          if (others.length) items.push({ kind: 'reaction', m, ts: m.ts, who: others, emoji: e });
        }
        continue;
      }
      if (!isDm(m.channel) && ((m.mentions || []).includes(me) || (m.mentions || []).includes('here'))) items.push({ kind: 'mention', m, ts: m.ts });
      else if (m.parent && byId.get(m.parent) && (byId.get(m.parent).user === me || all.some(x => x.parent === m.parent && x.user === me && x.id < m.id))) items.push({ kind: 'reply', m, ts: m.ts });
    }
    items.sort((a, b) => b.ts - a.ts);
    const filter = r.q || 'all';
    const counts = { all: items.length, mention: 0, reply: 0, reaction: 0 };
    items.forEach(i => counts[i.kind]++);
    const chips = [['all', 'Tout'], ['mention', 'Mentions'], ['reply', 'Réponses'], ['reaction', 'Réactions']];
    box.innerHTML = head('activity') + `<div class="filters">${chips.map(([k, l]) => `<button type="button" class="chip${filter === k ? ' on' : ''}" data-f="${k}">${l}${counts[k] ? ` <small>${counts[k]}</small>` : ''}</button>`).join('')}</div>`;
    box.querySelector('.filters').onclick = e => { const b = e.target.closest('[data-f]'); if (b) go({ view: 'activity', q: b.dataset.f === 'all' ? '' : b.dataset.f }, { replace: true }); };
    const list = items.filter(i => filter === 'all' || i.kind === filter).slice(0, 80);
    if (!list.length) { box.insertAdjacentHTML('beforeend', empty('activity', 'Rien de neuf', 'Quand quelqu’un te mentionne, répond à un de tes fils ou réagit à ton message, ça s’affiche ici.')); return; }
    const wrap = h('<div class="card-list"></div>');
    for (const it of list) {
      const read = state.reads[it.m.parent && !it.m.broadcast ? 't:' + it.m.parent : it.m.channel] || 0;
      const what = it.kind === 'mention' ? `${icon('at')}<b>Mention</b> dans ${esc(whereOf(it.m))}`
        : it.kind === 'reply' ? `${icon('thread')}<b>Réponse</b> ${esc(whereOf(it.m))}`
        : `<span>${it.emoji}</span><b>${esc(it.who.map(nameOf).slice(0, 3).join(', '))}${it.who.length > 3 ? ` et ${it.who.length - 3} autre(s)` : ''}</b> ${it.who.length > 1 ? 'ont' : 'a'} réagi · ${esc(label(it.m.channel))}`;
      wrap.appendChild(card(it.m, { headHtml: `${what}<span class="spacer"></span><span>${esc(fmtAgo(it.ts))}</span>`, unread: it.kind !== 'reaction' && it.m.id > read }));
    }
    box.appendChild(wrap);
  },

  // ---------- Plus tard ----------
  async later(r, alive) {
    const { items } = await api('/api/saved');
    await decryptAll(items.map(i => i.message));
    if (!alive()) return;
    const tab = r.q === 'done' ? 'done' : 'open';
    const list = items.filter(i => (tab === 'done') === i.done);
    box.innerHTML = head('later') + `<div class="filters"><button type="button" class="chip${tab === 'open' ? ' on' : ''}" data-f="open">En cours <small>${items.filter(i => !i.done).length}</small></button><button type="button" class="chip${tab === 'done' ? ' on' : ''}" data-f="done">Terminés</button></div>`;
    box.querySelector('.filters').onclick = e => { const b = e.target.closest('[data-f]'); if (b) go({ view: 'later', q: b.dataset.f === 'open' ? '' : 'done' }, { replace: true }); };
    if (!list.length) {
      box.insertAdjacentHTML('beforeend', tab === 'done' ? empty('check-circle', 'Rien de terminé', 'Les messages marqués « Terminé » se rangent ici.')
        : empty('bookmark', 'Rien de côté', 'Survole un message et clique sur le signet pour le garder ici. Avec « Me le rappeler », tu reçois un rappel au bon moment.'));
      return;
    }
    const wrap = h('<div class="card-list"></div>');
    for (const it of list) {
      const due = it.remindAt && !it.done;
      const late = due && it.remindAt < Date.now();
      const el = card(it.message, {
        headHtml: `<b>${esc(whereOf(it.message))}</b><span class="spacer"></span>${due ? `<span style="color:${late ? 'var(--signal)' : 'var(--accent-text)'};font-weight:650">${icon('alarm')} ${late ? 'Rappel passé' : 'Rappel ' + esc(fmtFuture(it.remindAt))}</span>` : `<span>Gardé ${esc(fmtAgo(it.ts))}</span>`}`,
        actions: `<button type="button" class="btn sm" data-l="done">${icon('check', 'sm')}${it.done ? 'Remettre en cours' : 'Terminé'}</button>
          ${it.done ? '' : `<button type="button" class="btn sm" data-l="remind">${icon('alarm', 'sm')}${it.remindAt ? 'Changer le rappel' : 'Me le rappeler'}</button>`}
          <button type="button" class="btn sm ghost" data-l="remove">${icon('trash', 'sm')}Retirer</button>`,
      });
      el.querySelector('.item-actions').addEventListener('click', e => {
        const b = e.target.closest('[data-l]');
        if (!b) return;
        e.stopPropagation();
        const save = body => post(`/api/messages/${it.id}/save`, body).catch(err => toast(err.message));
        if (b.dataset.l === 'done') save({ on: true, done: !it.done, remindAt: it.remindAt });
        if (b.dataset.l === 'remove') save({ on: false });
        if (b.dataset.l === 'remind') menu(b, [...remindChoices().map(ch => ({ label: ch.label, hint: ch.hint, run: () => save({ on: true, remindAt: ch.run() }) })),
          '-', { label: 'Choisir une date…', icon: 'clock', run: async () => { const ts = await pickDateTime({ title: 'Me le rappeler', ok: 'Programmer le rappel' }); if (ts) save({ on: true, remindAt: ts }); } },
          ...(it.remindAt ? [{ label: 'Supprimer le rappel', icon: 'x', run: () => save({ on: true, remindAt: null }) }] : [])]);
      });
      wrap.appendChild(el);
    }
    box.appendChild(wrap);
  },

  // ---------- Brouillons et envois programmés ----------
  async drafts(r, alive) {
    const { items } = await api('/api/scheduled');
    for (const s of items) { s.user = state.me; s.ts = s.at; await decryptMsg(s); }
    if (!alive()) return;
    const all = drafts.all();
    const dlist = Object.entries(all).map(([key, d]) => { const [ch, parent] = key.split('|'); return { key, ch, parent: Number(parent), ...d }; })
      .filter(d => isDm(d.ch) ? d.ch.slice(1).split('|').includes(state.me) : channel(d.ch)).sort((a, b) => b.ts - a.ts);
    box.innerHTML = head('drafts');
    if (!dlist.length && !items.length) { box.insertAdjacentHTML('beforeend', empty('draft', 'Aucun brouillon', 'Un message commencé et pas envoyé est gardé ici, conversation par conversation. Pour programmer un envoi, utilise la flèche à côté du bouton Envoyer.')); return; }
    const wrap = h('<div class="card-list"></div>');
    if (items.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="mi-label" style="padding:14px 26px 4px">Programmés · ${items.length}</div>`);
      for (const s of items) {
        const el = h(`<div class="item"><div class="item-head">${icon('clock')}<b>${esc(label(s.channel))}${s.parent ? ' · dans un fil' : ''}</b><span class="spacer"></span><span style="color:var(--accent-text);font-weight:650">Envoi ${esc(fmtFuture(s.at))}</span></div>
          <div class="body">${s.locked ? '<p class="locked">Message chiffré</p>' : `<p>${esc(plainPreview(s.text, 400) || (s.poll ? 'Sondage : ' + s.poll.question : ''))}</p>`}</div>
          <div class="item-actions"><button type="button" class="btn sm primary" data-s="now">${icon('send', 'sm')}Envoyer maintenant</button><button type="button" class="btn sm" data-s="when">${icon('clock', 'sm')}Changer l’heure</button><button type="button" class="btn sm ghost" data-s="cancel">${icon('trash', 'sm')}Annuler l’envoi</button></div></div>`);
        el.addEventListener('click', async e => {
          const b = e.target.closest('[data-s]');
          if (!b) return;
          try {
            if (b.dataset.s === 'now') { await post(`/api/scheduled/${s.id}/send`); toast('Message envoyé'); }
            if (b.dataset.s === 'cancel') {
              await del(`/api/scheduled/${s.id}`);
              if (!s.locked) drafts.set(`${s.channel}|${s.parent || 0}`, s.text || '');
              toast('Envoi annulé, le texte est revenu dans tes brouillons');
            }
            if (b.dataset.s === 'when') { const at = await pickDateTime({ title: 'Changer l’heure d’envoi', ok: 'Programmer', initial: s.at }); if (at) await patch(`/api/scheduled/${s.id}`, { at }); }
            openView(state.route);
          } catch (err) { toast(err.message); }
        });
        wrap.appendChild(el);
      }
    }
    if (dlist.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="mi-label" style="padding:14px 26px 4px">Brouillons · ${dlist.length}</div>`);
      for (const d of dlist) {
        const el = h(`<div class="item" tabindex="0"><div class="item-head">${icon('draft')}<b>${esc(label(d.ch))}${d.parent ? ' · dans un fil' : ''}</b><span class="spacer"></span><span>${esc(fmtAgo(d.ts))}</span></div>
          <div class="body"><p>${esc(plainPreview(d.text, 400))}</p></div>
          <div class="item-actions"><button type="button" class="btn sm" data-d="open">${icon('edit', 'sm')}Reprendre</button><button type="button" class="btn sm ghost" data-d="del">${icon('trash', 'sm')}Supprimer</button></div></div>`);
        el.addEventListener('click', e => {
          const b = e.target.closest('[data-d]');
          if (b?.dataset.d === 'del') { drafts.set(d.key, ''); el.remove(); return; }
          if (b || !e.target.closest('button')) { openConvo(d.ch); if (d.parent) openThread(d.parent); }
        });
        wrap.appendChild(el);
      }
    }
    box.appendChild(wrap);
  },

  // ---------- Recherche ----------
  async search(r, alive) {
    const q = (r.q || '').trim();
    if (!box.querySelector('.view-head')) box.innerHTML = head('search');
    const all = await allMessages();
    if (!alive()) return;
    // Filtres : de:@awa (ou from:), dans:#general (ou in:), avec:fichier|lien|image (ou has:file|link|image)
    let terms = q, from = null, inCh = null, has = null;
    terms = terms.replace(/(?:^|\s)(?:de|from):@?([\w.\-À-ÿ]+)/gi, (_, n) => { from = n; return ' '; });
    terms = terms.replace(/(?:^|\s)(?:dans|in):#?([\w\-@|.]+)/gi, (_, n) => { inCh = n; return ' '; });
    terms = terms.replace(/(?:^|\s)(?:avec|has):(\w+)/gi, (_, n) => { has = n.toLowerCase(); return ' '; });
    const words = terms.toLowerCase().split(/\s+/).filter(Boolean);
    const results = all.filter(m => {
      if (m.call) return false;
      if (from && m.user.toLowerCase() !== from.toLowerCase() && nameOf(m.user).toLowerCase() !== from.toLowerCase()) return false;
      if (inCh && m.channel !== inCh && !(isDm(m.channel) && dmOther(m.channel).toLowerCase() === inCh.toLowerCase())) return false;
      if (has && !(['fichier', 'file'].includes(has) ? m.file : ['lien', 'link'].includes(has) ? /https?:\/\//.test(m.text || '') : ['image', 'img'].includes(has) ? /\.(png|jpe?g|gif|webp)$/i.test(m.file?.name || '') : true)) return false;
      const hay = `${m.text || ''} ${m.file?.name || ''} ${m.poll?.question || ''} ${(m.poll?.options || []).join(' ')} ${m.shared?.text || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    }).reverse().slice(0, 80);
    const headEl = box.querySelector('.view-head');
    headEl.innerHTML = `<h1>${results.length ? plural(results.length, 'résultat', 'résultats') : 'Aucun résultat'}</h1><p>pour « ${esc(q)} »</p>`;
    box.querySelectorAll(':scope > :not(.view-head)').forEach(el => el.remove());
    box.insertAdjacentHTML('beforeend', `<p class="search-tip">Affine avec <code>de:@pseudo</code>, <code>dans:#canal</code> ou <code>avec:fichier</code>, <code>avec:lien</code>, <code>avec:image</code>. La recherche se fait dans ton navigateur, sur tes messages déchiffrés.</p>`);
    if (!results.length) { box.insertAdjacentHTML('beforeend', empty('search', 'Rien trouvé', 'Essaie avec moins de mots, ou retire un filtre.')); return; }
    const wrap = h('<div class="card-list"></div>');
    for (const m of results) wrap.appendChild(card(m));
    box.appendChild(wrap);
    if (words.length) highlight(wrap, words);
  },

  // ---------- Annuaire des canaux ----------
  async browse() {
    const draw = (filter = '') => {
      const list = [...state.channels.values()].filter(c => c.name.includes(filter.toLowerCase()) || (c.topic || '').toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name));
      $('.browse-list', box).innerHTML = list.map(c => `<div class="browse-row" data-ch="${esc(c.name)}">
          <div class="row-text"><b>${icon(c.private ? 'lock' : 'hash')}${esc(c.name)}${c.archived ? ' <span class="tag">archivé</span>' : ''}</b>
          <small>${isMember(c.name) ? `<span class="joined">${icon('check', 'xs')}Membre</span> · ` : ''}${plural(c.members.length, 'membre', 'membres')}${c.topic ? ' · ' + esc(c.topic) : c.description ? ' · ' + esc(c.description) : ''}</small></div>
          ${c.archived ? '' : isMember(c.name) ? (c.name === 'general' ? '' : '<button type="button" class="btn sm" data-b="leave">Quitter</button>') : '<button type="button" class="btn sm primary" data-b="join">Rejoindre</button>'}</div>`).join('')
        || '<div class="pane-empty">Aucun canal ne correspond.</div>';
    };
    box.innerHTML = head('browse', `<div style="display:flex;gap:8px;margin-top:14px"><input class="input" data-filter placeholder="Rechercher un canal…" style="max-width:360px" aria-label="Filtrer les canaux"><button type="button" class="btn primary" data-b="create">${icon('plus', 'sm')}Créer un canal</button></div>`) + '<div class="browse-list"></div>';
    draw();
    $('[data-filter]', box).addEventListener('input', e => draw(e.target.value.trim()));
    box.onclick = async e => {
      if (state.route.view !== 'browse') return;
      const b = e.target.closest('[data-b]'), row = e.target.closest('.browse-row');
      if (b?.dataset.b === 'create') return createChannel();
      if (!row) return;
      const ch = row.dataset.ch;
      if (b?.dataset.b === 'join') { try { await post(`/api/channels/${encodeURIComponent(ch)}/join`); toast(`Tu as rejoint #${ch}`); } catch (err) { toast(err.message); } return; }
      if (b?.dataset.b === 'leave') return bus.emit('leave-channel', ch);
      openConvo(ch);
    };
    redrawBrowse = () => draw($('[data-filter]', box)?.value.trim() || '');
  },
};

// Surligne les mots cherchés dans le texte des résultats (sans toucher au HTML)
function highlight(root, words) {
  const src = `(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
  const re = new RegExp(src, 'gi'), test = new RegExp(src, 'i');
  for (const body of root.querySelectorAll('.body')) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (test.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const span = document.createElement('span');
      span.innerHTML = esc(n.nodeValue).replace(re, '<mark>$1</mark>');
      n.replaceWith(...span.childNodes);
    }
  }
}
