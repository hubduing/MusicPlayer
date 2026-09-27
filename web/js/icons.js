/* Иконки: тонкие штриховые, 24×24, currentColor. */
const P = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>',
  'folder-plus': '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  'file-plus': '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M12 12.5v5M9.5 15h5"/>',
  folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'file-audio': '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><circle cx="10.5" cy="16" r="1.6"/><path d="M12.1 16v-4l3-1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  'list-music': '<path d="M4 6h11M4 11h11M4 16h7"/><circle cx="17.5" cy="15.5" r="2.5"/><path d="M20 15.5V7l2 1"/>',
  disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.4A4.1 4.1 0 0 1 12 7.8a4.1 4.1 0 0 1 7 2.8c0 5-7 9.4-7 9.4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8.5 5h3v14h-3zM12.5 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5.5v13L8.5 12z" fill="currentColor" stroke="none"/><path d="M6 5v14" stroke-width="2"/>',
  next: '<path d="M6 5.5v13L15.5 12z" fill="currentColor" stroke="none"/><path d="M18 5v14" stroke-width="2"/>',
  shuffle: '<path d="M17 4l3 3-3 3"/><path d="M20 7h-3.2c-2 0-3 1-4.2 3s-2.3 3-4.3 3H4"/><path d="M17 14l3 3-3 3"/><path d="M20 17h-3.2c-2 0-3-1-4.2-3"/><path d="M4 7h3.3c1.2 0 2 .3 2.8 1.2"/>',
  repeat: '<path d="M17 2.5l3 3-3 3"/><path d="M20 5.5h-9A5 5 0 0 0 6 10.5v1"/><path d="M7 21.5l-3-3 3-3"/><path d="M4 18.5h9a5 5 0 0 0 5-5v-1"/>',
  'repeat-one': '<path d="M17 2.5l3 3-3 3"/><path d="M20 5.5h-9A5 5 0 0 0 6 10.5v1"/><path d="M7 21.5l-3-3 3-3"/><path d="M4 18.5h9a5 5 0 0 0 5-5v-1"/><path d="M11.4 10.6l1.4-.9v4.6" stroke-width="1.6"/>',
  volume: '<path d="M4 9.5h3L11 6v12l-4-3.5H4z"/><path d="M14.5 9.2a4 4 0 0 1 0 5.6"/><path d="M17 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  'volume-mute': '<path d="M4 9.5h3L11 6v12l-4-3.5H4z"/><path d="M15.5 10l4 4M19.5 10l-4 4"/>',
  tag: '<path d="M11.6 3H20v8.4L11.4 20a2 2 0 0 1-2.8 0l-5-5a2 2 0 0 1 0-2.8z"/><circle cx="16.2" cy="6.8" r="1.3"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.8h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M18 13l-6 6-6-6"/>',
  wave: '<path d="M3 12h2l2-6 2.5 12L12 6l2.5 12L17 12h4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  edit: '<path d="M16.5 4.5l3 3L9 18H6v-3z"/><path d="M4 21h16"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M7 13h10"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8.5 4v5h6V4M8 20v-6h8v6"/>',
  alert: '<path d="M12 4l8.5 15h-17z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  'external': '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/>',
  scissors: '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M8.7 8.2L20 18M8.7 15.8L20 6"/>',
  library: '<path d="M4 5v14M9 5v14"/><path d="M14 5.6l4.6 1.2-3.2 12.2-4.6-1.2z"/>',
  sliders: '<path d="M5 8h9M17 8h2M5 16h3M11 16h8"/><circle cx="15.5" cy="8" r="2"/><circle cx="9.5" cy="16" r="2"/>',
  'chevron-right': '<path d="M9.5 5l7 7-7 7"/>',
  'chevron-left': '<path d="M14.5 5l-7 7 7 7"/>',
  'chevron-up': '<path d="M5 14.5l7-7 7 7"/>',
  drive: '<rect x="3" y="5" width="18" height="6" rx="1.6"/><rect x="3" y="13" width="18" height="6" rx="1.6"/><path d="M7 8h.01M7 16h.01"/>',
  upload: '<path d="M12 20V9"/><path d="M7.5 13.5L12 9l4.5 4.5"/><path d="M5 5h14"/>',
  layers: '<path d="M12 3l8 4.5-8 4.5-8-4.5z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5L12 21l8-4.5"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5"/><path d="M12 8.5V12l2.5 1.6"/>'
};

export function icon(name, extra = '') {
  const body = P[name] || P.info;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
}

export function svgEl(name, cls = '') {
  const span = document.createElement('span');
  span.className = cls;
  span.dataset.icon = name;
  span.innerHTML = icon(name);
  return span;
}

/** Проставляет SVG во все [data-icon] на странице (и внутри узла). */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.dataset.iconReady === node.dataset.icon) return;
    node.innerHTML = icon(node.dataset.icon);
    node.dataset.iconReady = node.dataset.icon;
  });
}