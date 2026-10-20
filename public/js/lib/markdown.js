// Mise en forme des messages, façon Slack — sans bibliothèque.
//   ```bloc de code```  `code`  *gras* ou **gras**  _italique_  ~barré~  > citation
//   - liste  1. liste numérotée  [texte](https://lien)  liens nus  @mention  #canal
import { esc, icon } from './dom.js';

// Résolution des @mentions et #canaux, fournie par l'application (noms affichés, canaux existants)
let resolve = { user: () => null, me: '', channel: () => false };
export const setResolver = r => { resolve = r; };

const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def default del do elif else enum export extends false final finally fn for foreach from func function go if impl implements import in instanceof interface is let match module namespace new nil none not null or package private protected public pub return self static struct super switch this throw throws true try type typeof use var void while with yield echo require include select insert update delete where join on group by order limit values into create table drop alter set').split(' '));
export function highlight(code) {
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, com, str, num, fn, word] = m;
    if (com) out += `<span class="t-com">${esc(tok)}</span>`;
    else if (str) out += `<span class="t-str">${esc(tok)}</span>`;
    else if (num) out += `<span class="t-num">${tok}</span>`;
    else if (fn) out += KEYWORDS.has(fn.toLowerCase()) ? `<span class="t-kw">${esc(fn)}</span>` : `<span class="t-fn">${esc(fn)}</span>`;
    else out += KEYWORDS.has(word.toLowerCase()) ? `<span class="t-kw">${esc(word)}</span>` : esc(word);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

export function renderText(text) {
  const parts = String(text || '').split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      const nl = part.indexOf('\n');
      let lang = nl > 0 ? part.slice(0, nl).trim() : '';
      let code = part;
      if (/^[\w+#.-]{1,20}$/.test(lang)) code = part.slice(nl + 1); else lang = '';
      code = code.replace(/^\n/, '').replace(/\n$/, '');
      html += `<div class="codeblock"><div class="cb-bar"><span translate="no">${esc(lang || 'code')}</span><button class="cb-copy" type="button" data-act="copy-code">${icon('copy')}<span>Copier</span></button></div><pre><code translate="no">${highlight(code)}</code></pre></div>`;
    } else {
      const raw = i % 2 === 1 ? '```' + part : part; // bloc non fermé : texte brut
      html += renderBlocks(raw.replace(/^\n+|\n+$/g, ''));
    }
  });
  return html;
}

// Paragraphes, citations et listes
function renderBlocks(t) {
  if (!t) return '';
  const groups = [];
  for (const line of t.split('\n')) {
    let kind = 'p', content = line;
    if (/^>\s?/.test(line)) { kind = 'quote'; content = line.replace(/^>\s?/, ''); }
    else if (/^\s*[-*•]\s+/.test(line)) { kind = 'ul'; content = line.replace(/^\s*[-*•]\s+/, ''); }
    else if (/^\s*\d+[.)]\s+/.test(line)) { kind = 'ol'; content = line.replace(/^\s*\d+[.)]\s+/, ''); }
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.lines.push(content); else groups.push({ kind, lines: [content] });
  }
  return groups.map(g => {
    if (g.kind === 'quote') return `<blockquote>${inline(g.lines.join('\n'))}</blockquote>`;
    if (g.kind === 'ul' || g.kind === 'ol') return `<${g.kind}>${g.lines.map(l => `<li>${inline(l)}</li>`).join('')}</${g.kind}>`;
    return `<p>${inline(g.lines.join('\n'))}</p>`;
  }).join('');
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
function inline(t) {
  return t.split(/(`[^`\n]+`)/).map((seg, i) => {
    if (i % 2 === 1) return `<code class="inline" translate="no">${esc(seg.slice(1, -1))}</code>`;
    // Liens [texte](url) mis de côté avant l'échappement, pour ne pas être réinterprétés
    const links = [];
    seg = seg.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => `\u0000${links.push({ label, href }) - 1}\u0000`);
    let s = esc(seg)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?;:)])/g, '$1<b>$2</b>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1<i>$2</i>')
      .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s.,!?;:)])/g, '$1<s>$2</s>')
      .replace(URL_RE, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])@([\w.\-À-ÿ]+)/g, (m, sp, n) => {
        if (['tous', 'here', 'channel'].includes(n.toLowerCase())) return `${sp}<span class="mention all">@${n}</span>`;
        const label = resolve.user(n);
        if (!label) return m;
        return `${sp}<span class="mention${n === resolve.me ? ' me' : ''}" data-user="${esc(n)}" role="button" tabindex="0">@${esc(label)}</span>`;
      })
      .replace(/(^|[\s(])#([a-z0-9][a-z0-9\-_]{0,39})(?![\w-])/g, (m, sp, n) => resolve.channel(n)
        ? `${sp}<a class="chan-link" href="#/c/${n}">#${n}</a>` : m);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => {
      const l = links[k];
      return `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`;
    });
    return s;
  }).join('');
}

export const isEmojiOnly = t => {
  const s = (t || '').trim();
  return s.length > 0 && s.length <= 24 && !/[0-9#*]/.test(s) &&
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s);
};
// Texte brut d'un message, pour les aperçus (notifications, liste des fils, recherche)
export const plainPreview = (t, n = 140) => String(t || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_~`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
// Personnes mentionnées dans un texte (envoyées au serveur pour les notifications)
export function extractMentions(text, known) {
  const out = new Set();
  const plain = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  for (const [, n] of plain.matchAll(/(?:^|[\s(])@([\w.\-À-ÿ]+)/g)) {
    if (['tous', 'here', 'channel'].includes(n.toLowerCase())) out.add('here');
    else if (known(n)) out.add(n);
  }
  return [...out];
}
