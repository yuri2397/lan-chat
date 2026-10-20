// Partage d'écran — commun aux appels en tête-à-tête (call.js) et de groupe (huddle.js).
//
// Chaque connexion WebRTC réserve dès sa création une voie vidéo vide (transceiver « sendrecv »).
// Partager = y brancher la piste de l'écran avec replaceTrack() ; arrêter = la débrancher. Pas de
// renégociation, donc instantané. Qui partage est signalé à part (signal « screen » ou état de la salle).
//
// Ce module gère la capture, le débit, et le panneau qui affiche les écrans reçus.
import { esc, icon } from '../lib/dom.js';
import { nameOf } from '../core/state.js';

export const Screen = (() => {
  const supported = () => !!navigator.mediaDevices?.getDisplayMedia;

  async function capture() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail'; // texte et code nets plutôt que fluidité
    return track;
  }
  // Branche (ou débranche, avec null) une piste sur une voie vidéo et plafonne son débit.
  async function applyTo(sender, track, maxBitrate) {
    await sender.replaceTrack(track);
    if (!track || !maxBitrate) return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = maxBitrate;
      await sender.setParameters(params);
    } catch {}
  }

  // ---------- Panneau des écrans reçus ----------
  const sources = new Map(); // personne qui partage -> piste vidéo reçue
  let current = null, minimized = false;
  const view = document.createElement('div');
  view.id = 'screenView';
  view.hidden = true;
  view.innerHTML = `<div class="sv-head">
      <span class="sv-title"></span><span class="sv-tabs"></span>
      <button type="button" class="icon-btn" data-sv="full" title="Plein écran" aria-label="Plein écran">${icon('maximize')}</button>
      <button type="button" class="icon-btn" data-sv="min" title="Réduire / agrandir" aria-label="Réduire ou agrandir">${icon('minimize')}</button>
    </div>
    <video autoplay playsinline muted></video>`;
  document.body.appendChild(view);
  const video = view.querySelector('video');

  function show(user, track) {
    const isNew = !sources.has(user);
    sources.set(user, track);
    if (isNew || !current) { current = user; minimized = false; }
    render();
  }
  function hide(user) {
    if (!sources.delete(user)) return;
    if (current === user) current = [...sources.keys()].at(-1) || null;
    render();
  }
  function clear() { sources.clear(); current = null; render(); }

  function render() {
    if (!current) {
      view.hidden = true;
      video.srcObject = null;
      if (document.fullscreenElement === video) document.exitFullscreen().catch(() => {});
      return;
    }
    view.hidden = false;
    view.classList.toggle('minimized', minimized);
    const track = sources.get(current);
    if (video.srcObject?.getVideoTracks()[0] !== track) video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    view.querySelector('.sv-title').textContent = `Écran de ${nameOf(current)}`;
    view.querySelector('.sv-tabs').innerHTML = sources.size > 1
      ? [...sources.keys()].map(u => `<button class="sv-tab${u === current ? ' on' : ''}" data-sv-user="${esc(u)}">${esc(nameOf(u))}</button>`).join('')
      : '';
  }
  view.addEventListener('click', e => {
    const b = e.target.closest('[data-sv],[data-sv-user]');
    if (!b) { if (minimized) { minimized = false; render(); } return; }
    if (b.dataset.svUser) { current = b.dataset.svUser; return render(); }
    if (b.dataset.sv === 'min') { minimized = !minimized; return render(); }
    if (b.dataset.sv === 'full') video.requestFullscreen?.().catch(() => {});
  });

  return { supported, capture, applyTo, show, hide, clear };
})();
