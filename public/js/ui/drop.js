// Glisser-déposer des fichiers sur une zone (conversation ou fil). L'écran « Déposer » est recréé au besoin,
// car le contenu du panneau change à chaque ouverture.
export function setupDrop(area, getComposer, enabled, text = 'Déposer dans le fil') {
  if (area._drop) return;
  area._drop = true;
  let depth = 0;
  const overlay = () => area.querySelector(':scope > .drop') || area.appendChild(Object.assign(document.createElement('div'), { className: 'drop', innerHTML: `<div><span>${text}</span></div>` }));
  area.addEventListener('dragenter', e => { if (enabled() && e.dataTransfer.types.includes('Files')) { depth++; overlay().classList.add('on'); } });
  area.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay().classList.remove('on'); } });
  area.addEventListener('dragover', e => e.preventDefault());
  area.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; overlay().classList.remove('on');
    const c = getComposer();
    if (enabled() && c) [...e.dataTransfer.files].forEach(f => c.upload(f));
  });
}
