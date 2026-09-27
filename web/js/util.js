/* Утилиты: DOM, форматирование, цвета обложек-заглушек, работа с файлами. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtTime(seconds, { unknown = '–:––' } = {}) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return unknown;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLong(seconds) {
  if (!seconds) return '0 мин';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function fmtSize(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function fmtCount(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const plural = {
  track: (n) => fmtCount(n, 'трек', 'трека', 'треков'),
  album: (n) => fmtCount(n, 'альбом', 'альбома', 'альбомов'),
  artist: (n) => fmtCount(n, 'исполнитель', 'исполнителя', 'исполнителей'),
  folder: (n) => fmtCount(n, 'источник', 'источника', 'источников')
};

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
export const normalize = norm;

/** Нечёткий поиск: все слова запроса должны найтись в любом поле. */
export function matchesQuery(track, query) {
  const q = norm(query);
  if (!q) return true;
  const haystack = norm([
    track.title, track.artist, track.album, track.albumArtist, track.genre,
    track.composer, track.year, track.name, track.path, track.sourceName
  ].join(' \u0001 '));
  return q.split(' ').every((word) => haystack.includes(word));
}

/** Пиксельная сортировка как в проводнике: «Трек 2» < «Трек 10». */
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
export const compareText = (a, b) => collator.compare(String(a || ''), String(b || ''));

/** Стабильный «тёплый» цвет обложки-заглушки по строке. */
export function artColor(seed = '') {
  let hash = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) % 100000;
  }
  const hue = (hash * 47) % 360;
  const sat = 34 + (hash % 26);
  const light = 26 + (hash % 18);
  return {
    from: `hsl(${hue} ${sat}% ${light + 12}%)`,
    to: `hsl(${(hue + 38) % 360} ${sat + 8}% ${Math.max(12, light - 8)}%)`
  };
}

export function initials(text, fallback = '♪') {
  const clean = String(text || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!clean) return fallback;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Обложка-заглушка: градиент + инициалы. */
export function fallbackArt(track, size = 300) {
  const { from, to } = artColor(track?.album || track?.artist || track?.title || track?.name || '');
  const text = initials(track?.artist || track?.album || track?.title || '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
    <circle cx="${size * 0.5}" cy="${size * 0.5}" r="${size * 0.3}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="${size * 0.012}"/>
    <circle cx="${size * 0.5}" cy="${size * 0.5}" r="${size * 0.18}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="${size * 0.01}"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
      font-family="Bahnschrift, Segoe UI, sans-serif" font-size="${size * 0.22}" letter-spacing="${size * 0.01}"
      fill="rgba(255,255,255,.9)">${escapeXml(text)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Обложка трека. Без параметра kind сервер сам отдаёт встроенную картинку,
 * а если её нет — ищет cover.jpg / folder.png рядом с файлом.
 */
export function artUrl(track, { folderOnly = false } = {}) {
  if (!track) return null;
  return `/art?id=${encodeURIComponent(track.id)}${folderOnly ? '&kind=folder' : ''}`;
}

export function hms(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function stripExt(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}