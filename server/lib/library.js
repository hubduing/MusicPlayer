'use strict';
/**
 * Библиотека: источники (папки и отдельные файлы), сканирование, поиск,
 * избранное и плейлисты. Всё живёт в памяти после загрузки — мгновенный поиск.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isAudio, isPlayable, isLossless, extOf, mimeFor } = require('./mime');
const { readTags } = require('./tags');

const SKIP_DIRS = new Set([
  'node_modules', '$recycle.bin', 'system volume information', 'recycler',
  '.git', '.svn', '.hg', 'windows', 'program files', 'program files (x86)',
  'programdata', 'appdata', 'application data', 'temp', 'tmp', '$windows.~bt'
]);

function idFor(filePath) {
  return crypto.createHash('sha1').update(String(filePath).toLowerCase()).digest('hex').slice(0, 16);
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

class Library extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.scanning = false;
    this._lastScan = null;
    this.patch();
  }

  /** Приводим сохранённые треки к актуальной форме и строим индексы. */
  patch() {
    const tracks = this.store.db.tracks;
    let changed = false;
    for (const [key, track] of Object.entries(tracks)) {
      if (!track.id) {
        track.id = idFor(track.path);
        changed = true;
      }
      if (!track.meta) {
        track.meta = { title: path.basename(track.path, path.extname(track.path)) };
        changed = true;
      }
      if (track.id !== key) {
        tracks[track.id] = track;
        if (key !== track.id) delete tracks[key];
        changed = true;
      }
    }
    this.store.db.favorites = this.store.db.favorites.filter((id) => !!tracks[id]);
    if (changed) this.store.touch();
  }

  get sources() {
    return this.store.db.sources;
  }

  sourceFor(filePath) {
    let best = null;
    for (const source of this.sources) {
      if (source.type === 'file') {
        if (samePath(source.path, filePath)) return source;
        continue;
      }
      const rel = path.relative(source.path, filePath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (!best || source.path.length > best.path.length) best = source;
      }
    }
    return best;
  }

  addSource(rawPath, type = 'auto') {
    const resolved = path.resolve(String(rawPath || '').trim().replace(/^"|"$/g, ''));
    if (!resolved) throw new Error('Пустой путь');
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Путь недоступен: ${resolved}`);
    }
    const kind = type === 'auto' ? (stat.isDirectory() ? 'folder' : 'file') : type;
    if (kind === 'file' && !stat.isFile()) throw new Error('Это не файл');
    if (kind === 'file' && !isAudio(resolved)) throw new Error(`Не похоже на аудиофайл: ${path.extname(resolved) || 'без расширения'}`);
    if (kind === 'folder' && !stat.isDirectory()) throw new Error('Это не папка');

    const existing = this.sources.find((s) => samePath(s.path, resolved));
    if (existing) return { source: existing, created: false };

    const source = {
      id: crypto.randomUUID().slice(0, 8),
      path: resolved,
      name: path.basename(resolved) || resolved,
      type: kind,
      addedAt: new Date().toISOString(),
      trackCount: 0
    };
    this.sources.push(source);
    this.store.touch();
    this.emit('change', { reason: 'source-added', source });
    return { source, created: true };
  }

  removeSource(id, removeTracks = true) {
    const idx = this.sources.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    const [source] = this.sources.splice(idx, 1);
    if (removeTracks) {
      for (const [trackId, track] of Object.entries(this.store.db.tracks)) {
        if (track.sourceId === id || (source.type === 'file' && samePath(track.path, source.path))) {
          delete this.store.db.tracks[trackId];
          this._removeFromPlaylists(trackId);
        }
      }
    } else {
      for (const track of Object.values(this.store.db.tracks)) {
        if (track.sourceId === id) track.sourceId = null;
      }
    }
    this._recount();
    this.store.touch();
    this.emit('change', { reason: 'source-removed', source });
    return true;
  }

  _removeFromPlaylists(trackId) {
    for (const pl of this.store.db.playlists) {
      pl.trackIds = pl.trackIds.filter((t) => t !== trackId);
    }
    this.store.db.favorites = this.store.db.favorites.filter((t) => t !== trackId);
  }

  _recount() {
    for (const source of this.sources) {
      source.trackCount = Object.values(this.store.db.tracks).filter((t) => t.sourceId === source.id).length;
    }
  }

  // ------------------------------------------------------------ сканирование

  *walk(dir, depth = 0, visited = new Set()) {
    if (depth > 24) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.')) continue;
        let real;
        try {
          real = fs.realpathSync(full);
        } catch {
          real = full;
        }
        if (visited.has(real)) continue;
        visited.add(real);
        yield* this.walk(full, depth + 1, visited);
      } else if (entry.isFile() && isAudio(full)) {
        yield full;
      }
    }
  }

  /** Полное сканирование всех источников с отчётом о прогрессе. */
  async scan({ onProgress } = {}) {
    if (this.scanning) return { busy: true };
    this.scanning = true;
    const started = Date.now();
    const files = [];
    const seen = new Set();

    try {
      for (const source of this.sources) {
        const found = [];
        if (source.type === 'file') {
          if (fs.existsSync(source.path) && isAudio(source.path)) found.push(source.path);
        } else {
          for (const file of this.walk(source.path)) found.push(file);
        }
        for (const file of found) {
          const key = file.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          files.push({ file, sourceId: source.id });
        }
      }

      const total = files.length;
      let done = 0;
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const parsed = [];

      for (const { file, sourceId } of files) {
        done += 1;
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const id = idFor(file);
        const existing = this.store.db.tracks[id];
        if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs && existing.meta) {
          if (existing.sourceId !== sourceId) existing.sourceId = sourceId;
          skipped += 1;
        } else {
          parsed.push({ file, stat, id, sourceId, isNew: !existing });
        }
        if (done % 25 === 0 || done === total) {
          const payload = { phase: 'collect', done, total };
          if (onProgress) onProgress(payload);
          this.emit('progress', payload);
        }
      }

      const parseTotal = parsed.length;
      for (let i = 0; i < parsed.length; i += 1) {
        const item = parsed[i];
        let meta = null;
        try {
          meta = readTags(item.file);
        } catch {
          meta = null;
        }
        const record = {
          id: item.id,
          path: item.file,
          name: path.basename(item.file),
          ext: extOf(item.file),
          size: item.stat.size,
          mtimeMs: item.stat.mtimeMs,
          sourceId: item.sourceId,
          addedAt: this.store.db.tracks[item.id]?.addedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          playable: isPlayable(item.file),
          lossless: meta?.lossless || isLossless(item.file),
          hasCover: !!meta?.cover,
          meta: meta ? stripCover(meta) : { title: path.basename(item.file, path.extname(item.file)) }
        };
        this.store.db.tracks[item.id] = record;
        if (item.isNew) added += 1;
        else updated += 1;

        const payload = { phase: 'parse', done: i + 1, total: parseTotal, file: item.file };
        if (onProgress) onProgress(payload);
        if (i % 5 === 0 || i + 1 === parseTotal) this.emit('progress', payload);
        if (i % 200 === 0) this.store.touch();
      }

      // удаляем записи, которых больше нет на диске
      let removed = 0;
      for (const [id, track] of Object.entries(this.store.db.tracks)) {
        if (track.sourceId && !this.sources.some((s) => s.id === track.sourceId)) continue;
        if (!fs.existsSync(track.path)) {
          delete this.store.db.tracks[id];
          this._removeFromPlaylists(id);
          removed += 1;
        }
      }

      this._recount();
      this.store.touch();
      const summary = {
        total: Object.keys(this.store.db.tracks).length,
        found: total,
        added,
        updated,
        removed,
        skipped,
        durationMs: Date.now() - started
      };
      this._lastScan = summary;
      this.emit('change', { reason: 'scan', summary });
      return summary;
    } finally {
      this.scanning = false;
    }
  }

  /** Индексирует один файл, не запуская полное сканирование (drag & drop). */
  indexFile(file, sourceId = null) {
    if (!isAudio(file)) return null;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const id = idFor(file);
    const meta = readTags(file);
    const record = {
      id,
      path: file,
      name: path.basename(file),
      ext: extOf(file),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sourceId,
      addedAt: this.store.db.tracks[id]?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      playable: isPlayable(file),
      lossless: meta?.lossless || isLossless(file),
      hasCover: !!meta?.cover,
      meta: stripCover(meta)
    };
    this.store.db.tracks[id] = record;
    this.store.touch();
    return record;
  }

  // ------------------------------------------------------------ запросы

  allTracks() {
    return Object.values(this.store.db.tracks);
  }

  getTrack(id) {
    return this.store.db.tracks[id] || null;
  }

  trackByPath(filePath) {
    return this.store.db.tracks[idFor(filePath)] || null;
  }

  isFavorite(id) {
    return this.store.db.favorites.includes(id);
  }

  toggleFavorite(id) {
    const list = this.store.db.favorites;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    this.store.touch();
    return idx < 0;
  }

  favorites() {
    return this.store.db.favorites.map((id) => this.getTrack(id)).filter(Boolean);
  }

  stats() {
    const tracks = this.allTracks();
    const albums = new Set();
    const artists = new Set();
    let duration = 0;
    let size = 0;
    for (const t of tracks) {
      const m = t.meta || {};
      if (m.album) albums.add(`${(m.albumArtist || m.artist || '—').toLowerCase()}::${m.album.toLowerCase()}`);
      if (m.artist) artists.add(m.artist.toLowerCase());
      duration += Number(m.duration) || 0;
      size += t.size || 0;
    }
    return {
      tracks: tracks.length,
      albums: albums.size,
      artists: artists.size,
      folders: this.sources.length,
      duration,
      size,
      favorites: this.store.db.favorites.length,
      playlists: this.store.db.playlists.length,
      lastScan: this._lastScan
    };
  }

  /** Плоский список с обложкой как URL — то, что реально нужно интерфейсу. */
  serializeTrack(track) {
    if (!track) return null;
    const m = track.meta || {};
    return {
      id: track.id,
      path: track.path,
      name: track.name,
      ext: track.ext,
      size: track.size,
      mtimeMs: track.mtimeMs,
      sourceId: track.sourceId,
      sourceName: this.sources.find((s) => s.id === track.sourceId)?.name || null,
      playable: track.playable !== false,
      lossless: !!track.lossless,
      hasCover: !!track.hasCover,
      favorite: this.isFavorite(track.id),
      title: m.title || path.basename(track.name, track.ext),
      artist: m.artist || '',
      album: m.album || '',
      albumArtist: m.albumArtist || m.artist || '',
      year: m.year ?? null,
      trackNo: m.trackNo ?? null,
      discNo: m.discNo ?? null,
      genre: m.genre || '',
      comment: m.comment || '',
      composer: m.composer || '',
      duration: Number(m.duration) || null,
      bitrate: m.bitrate ?? null,
      sampleRate: m.sampleRate ?? null,
      channels: m.channels ?? null,
      bitsPerSample: m.bitsPerSample ?? null,
      codec: m.codec || track.ext.replace('.', '').toUpperCase()
    };
  }

  /** Обновление тегов: в памяти, и — где умеем — в самом файле. */
  updateTrack(id, patch, { writeFile = true } = {}) {
    const track = this.getTrack(id);
    if (!track) return { ok: false, error: 'Трек не найден' };
    const allowed = ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNo', 'discNo', 'genre', 'comment', 'composer'];
    const clean = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    const merged = { ...track.meta, ...clean };
    let fileResult = { written: false, reason: 'не запрошено' };
    if (writeFile) {
      const { writeTags } = require('./edit-tags');
      // Обложку сохраняем: перезапись ID3 не должна её потерять.
      let cover = normalizeCover(patch.cover);
      if (!cover) {
        const existing = this.embeddedCover(id);
        if (existing) cover = { data: existing.data, mime: existing.mime };
      }
      fileResult = writeTags(track.path, merged, cover);
      if (fileResult.written && patch.cover) this._coverCache?.delete(id);
      if (fileResult.written) {
        try {
          const stat = fs.statSync(track.path);
          track.size = stat.size;
          track.mtimeMs = stat.mtimeMs;
        } catch {
          /* ignore */
        }
        if (patch.cover) track.hasCover = true;
      }
    }
    track.meta = merged;
    track.meta.lastWrite = fileResult.written ? fileResult.backup || true : track.meta.lastWrite;
    if (track.meta.year != null) track.meta.year = Number(track.meta.year) || null;
    if (track.meta.trackNo != null) track.meta.trackNo = Number(track.meta.trackNo) || null;
    if (track.meta.discNo != null) track.meta.discNo = Number(track.meta.discNo) || null;
    track.updatedAt = new Date().toISOString();
    this.store.touch();
    this.emit('change', { reason: 'track-updated', id });
    return { ok: true, track: this.serializeTrack(track), file: fileResult };
  }

  setCover(id, buffer, mime) {
    const track = this.getTrack(id);
    if (!track) return { ok: false, error: 'Трек не найден' };
    const { writeTags } = require('./edit-tags');
    const result = writeTags(track.path, { ...track.meta }, { data: buffer, mime });
    if (result.written) {
      track.hasCover = true;
      try {
        const stat = fs.statSync(track.path);
        track.size = stat.size;
        track.mtimeMs = stat.mtimeMs;
      } catch {
        /* ignore */
      }
      this.store.touch();
    }
    this._coverCache?.delete(id);
    return result;
  }

  /** Встроенная обложка, извлечённая прямо из аудиофайла. */
  embeddedCover(id) {
    this._coverCache = this._coverCache || new Map();
    if (this._coverCache.has(id)) return this._coverCache.get(id);
    const track = this.getTrack(id);
    if (!track) return null;
    let cover = null;
    try {
      const meta = readTags(track.path);
      if (meta.cover) cover = meta.cover;
    } catch {
      cover = null;
    }
    const value = cover ? { data: cover.data, mime: cover.mime } : null;
    this._coverCache.set(id, value);
    if (this._coverCache.size > 120) {
      this._coverCache.delete(this._coverCache.keys().next().value);
    }
    return value;
  }

  /** Обложка из папки с музыкой (cover.jpg / folder.png / front.*). */
  folderCover(id) {
    const track = this.getTrack(id);
    if (!track) return null;
    const dir = path.dirname(track.path);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const priority = ['cover', 'folder', 'front', 'album', 'artwork', 'albumart'];
    const images = entries.filter((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f));
    for (const wanted of priority) {
      const hit = images.find((f) => path.basename(f, path.extname(f)).toLowerCase() === wanted);
      if (hit) return path.join(dir, hit);
    }
    const any = images.find((f) => !/^(back|inside|cd|disc|booklet)/i.test(f)) || images[0];
    return any ? path.join(dir, any) : null;
  }

  // ------------------------------------------------------------ плейлисты

  playlists() {
    return this.store.db.playlists.map((pl) => ({
      id: pl.id,
      name: pl.name,
      count: pl.trackIds.length,
      duration: pl.trackIds.reduce((sum, id) => sum + (Number(this.getTrack(id)?.meta?.duration) || 0), 0),
      createdAt: pl.createdAt,
      updatedAt: pl.updatedAt
    }));
  }

  playlist(id) {
    const pl = this.store.db.playlists.find((p) => p.id === id);
    if (!pl) return null;
    return {
      id: pl.id,
      name: pl.name,
      createdAt: pl.createdAt,
      updatedAt: pl.updatedAt,
      tracks: pl.trackIds.map((tid) => this.serializeTrack(this.getTrack(tid))).filter(Boolean)
    };
  }

  createPlaylist(name) {
    const pl = {
      id: crypto.randomUUID().slice(0, 8),
      name: String(name || 'Новый плейлист').trim() || 'Новый плейлист',
      trackIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.store.db.playlists.push(pl);
    this.store.touch();
    this.emit('change', { reason: 'playlist-created', id: pl.id });
    return pl;
  }

  updatePlaylist(id, { name, add, remove, move, set }) {
    const pl = this.store.db.playlists.find((p) => p.id === id);
    if (!pl) return null;
    if (typeof name === 'string' && name.trim()) pl.name = name.trim();
    if (Array.isArray(set)) pl.trackIds = set.filter((t) => !!this.getTrack(t));
    if (Array.isArray(add)) {
      const existing = new Set(pl.trackIds);
      for (const trackId of add) {
        if (existing.has(trackId)) continue;
        if (!this.getTrack(trackId)) continue;
        pl.trackIds.push(trackId);
        existing.add(trackId);
      }
    }
    if (Array.isArray(remove)) {
      const drop = new Set(remove);
      pl.trackIds = pl.trackIds.filter((t) => !drop.has(t));
    }
    if (move && typeof move.from === 'number' && typeof move.to === 'number') {
      const [item] = pl.trackIds.splice(move.from, 1);
      if (item) pl.trackIds.splice(Math.max(0, Math.min(move.to, pl.trackIds.length)), 0, item);
    }
    pl.updatedAt = new Date().toISOString();
    this.store.touch();
    this.emit('change', { reason: 'playlist-updated', id });
    return pl;
  }

  deletePlaylist(id) {
    const idx = this.store.db.playlists.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.store.db.playlists.splice(idx, 1);
    this.store.touch();
    this.emit('change', { reason: 'playlist-deleted', id });
    return true;
  }

  playlistM3U(id) {
    const pl = this.playlist(id);
    if (!pl) return null;
    const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`];
    for (const track of pl.tracks) {
      const seconds = Math.round(track.duration || 0);
      lines.push(`#EXTINF:${seconds},${track.artist ? `${track.artist} - ` : ''}${track.title}`);
      lines.push(track.path);
    }
    return lines.join('\r\n');
  }
}

function normalizeCover(cover) {
  if (!cover) return null;
  if (Buffer.isBuffer(cover)) return { data: cover, mime: 'image/jpeg' };
  if (cover.data && Buffer.isBuffer(cover.data)) return { data: cover.data, mime: cover.mime || 'image/jpeg' };
  if (cover.data && typeof cover.data === 'string') {
    const base64 = cover.data.replace(/^data:[^;]+;base64,/, '');
    return { data: Buffer.from(base64, 'base64'), mime: cover.mime || /^data:([^;]+)/.exec(cover.data)?.[1] || 'image/jpeg' };
  }
  return null;
}

function stripCover(meta) {
  if (!meta) return meta;
  const { cover, filePath, ...rest } = meta;
  void cover;
  void filePath;
  return rest;
}

module.exports = { Library, idFor, samePath };