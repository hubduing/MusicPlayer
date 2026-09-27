'use strict';
/**
 * Grooveshelf — локальный сервер оффлайн-плеера.
 * Ноль зависимостей: только стандартная библиотека Node.js.
 *
 *   node server/index.js [--port 7412] [--open] [--root "D:\Music"]
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const { Store } = require('./lib/store');
const { Library, idFor } = require('./lib/library');
const { sendJson, sendText, sendBuffer, streamFile, readBody } = require('./lib/http');
const { mimeFor, isAudio } = require('./lib/mime');
const { supportsWriting } = require('./lib/edit-tags');

const WEB_DIR = (() => {
  try {
    if (require('node:sea').isSea()) {
      const nextToExe = path.join(path.dirname(process.execPath), 'web');
      if (fs.existsSync(path.join(nextToExe, 'index.html'))) return nextToExe;
    }
  } catch { /* не SEA — обычный запуск */ }
  return path.join(__dirname, '..', 'web');
})();
const VERSION = '1.0.0';

// ------------------------------------------------------------------ аргументы

function parseArgs(argv) {
  const args = { port: Number(process.env.GROOVESHELF_PORT) || 7412, open: false, root: null, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]) || args.port;
    else if (arg === '--open' || arg === '-o') args.open = true;
    else if (arg === '--root' || arg === '-r') args.root = argv[++i];
    else if (arg === '--host') args.host = argv[++i];
    else if (/^\d+$/.test(arg)) args.port = Number(arg);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const store = new Store();
const library = new Library(store);

// ------------------------------------------------------------------ SSE

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

library.on('progress', (data) => broadcast('scan', data));
library.on('change', (data) => broadcast('change', data));
store.onDirty = () => broadcast('saved', { at: Date.now() });

// ------------------------------------------------------------------ утилиты

/** Тома Windows и стандартные папки — чтобы UI сразу знал, куда смотреть. */
async function roots() {
  const found = [];
  const push = (p, label, kind = 'drive') => {
    try {
      if (fs.existsSync(p)) found.push({ path: p, label: label || p, kind });
    } catch {
      /* ignore */
    }
  };
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const letter = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(letter)) found.push({ path: letter, label: letter.replace('\\', ''), kind: 'drive' });
    }
  } else {
    push('/', 'Корень', 'drive');
  }
  const home = os.homedir();
  for (const [dir, label] of [['Music', 'Музыка'], ['Downloads', 'Загрузки'], ['Desktop', 'Рабочий стол'], ['Documents', 'Документы']]) {
    push(path.join(home, dir), label, 'folder');
  }
  push(home, 'Домашняя папка', 'folder');
  return found;
}

function listDirs(target) {
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('$') || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      let audioCount = 0;
      try {
        audioCount = fs.readdirSync(full).filter((f) => isAudio(f)).length;
      } catch {
        audioCount = 0;
      }
      dirs.push({ name: entry.name, path: full, audioCount });
    } else if (entry.isFile() && isAudio(full)) {
      files.push({ name: entry.name, path: full, size: safeSize(full) });
    }
  }
  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  return { dirs, files };
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ API

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [head, ...rest] = parts;
  const q = url.searchParams;

  if (head === 'ping') return sendJson(res, 200, { ok: true, version: VERSION, platform: process.platform });

  if (head === 'state') {
    return sendJson(res, 200, {
      version: VERSION,
      settings: store.settings,
      stats: library.stats(),
      sources: library.sources,
      scanning: library.scanning,
      dataDir: store.dataDir,
      folderPicker: process.platform === 'win32',
      canWriteTags: true,
      platform: process.platform
    });
  }

  if (head === 'tracks') {
    if (req.method === 'GET' && rest.length === 1) {
      const track = library.serializeTrack(library.getTrack(rest[0]));
      if (!track) return sendJson(res, 404, { error: 'Трек не найден' });
      track.canWriteTags = supportsWriting(track.path);
      return sendJson(res, 200, { track });
    }
    if (req.method === 'PATCH' && rest.length === 1) {
      const body = await readBody(req);
      const result = library.updateTrack(rest[0], body, { writeFile: body.writeFile !== false });
      return sendJson(res, result.ok ? 200 : 404, result);
    }
    if (req.method === 'GET') {
      const ids = q.get('ids');
      const filter = q.get('filter');
      let items = library.allTracks().map((t) => library.serializeTrack(t));
      if (ids) {
        const wanted = new Set(ids.split(','));
        items = items.filter((t) => wanted.has(t.id));
      }
      if (filter === 'favorites') items = items.filter((t) => t.favorite);
      if (filter === 'lossless') items = items.filter((t) => t.lossless);
      if (filter === 'playable') items = items.filter((t) => t.playable);
      return sendJson(res, 200, { tracks: items, stats: library.stats() });
    }
  }

  if (head === 'upload' && req.method === 'POST') {
    // Файл, перетащенный прямо в окно браузера: сохраняем копию в фонотеку плеера.
    const rawName = q.get('name') || 'audio.mp3';
    const safe = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120) || 'audio.mp3';
    const dir = path.join(store.dataDir, 'dropped');
    await fsp.mkdir(dir, { recursive: true });
    let target = path.join(dir, safe);
    let counter = 1;
    const ext = path.extname(safe);
    const base = path.basename(safe, ext);
    while (fs.existsSync(target)) {
      target = path.join(dir, `${base} (${counter})${ext}`);
      counter += 1;
    }
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(target);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
    } catch (err) {
      return sendJson(res, 500, { error: `Не удалось сохранить файл: ${err.message}` });
    }
    if (!isAudio(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        /* ignore */
      }
      return sendJson(res, 400, { error: 'Это не аудиофайл' });
    }
    let source = library.sources.find((s) => path.resolve(s.path).toLowerCase() === dir.toLowerCase());
    if (!source) source = library.addSource(dir, 'folder').source;
    const record = library.indexFile(target, source.id);
    library._recount();
    library.store.touch();
    broadcast('change', { reason: 'upload', track: record?.id });
    return sendJson(res, 200, { ok: true, path: target, track: library.serializeTrack(record), source });
  }

  if (head === 'reveal' && req.method === 'POST') {
    const body = await readBody(req);
    // Только то, что пользователь сам подключил: трек из фонотеки или её источник.
    const track = body.id ? library.getTrack(body.id) : null;
    const target = track?.path
      || library.sources.find((s) => path.resolve(s.path).toLowerCase() === path.resolve(String(body.path || '')).toLowerCase())?.path;
    if (!target || !fs.existsSync(target)) return sendJson(res, 404, { error: 'Путь не найден' });
    const cmd = process.platform === 'win32'
      ? `explorer.exe /select,"${String(target).replace(/"/g, '')}"`
      : process.platform === 'darwin'
        ? `open -R "${target}"`
        : `xdg-open "${path.dirname(target)}"`;
    exec(cmd, () => {});
    return sendJson(res, 200, { ok: true });
  }

  if (head === 'tracks' && rest[0] === 'remove' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let removed = 0;
    for (const id of ids) {
      if (library.getTrack(id)) {
        delete store.db.tracks[id];
        library._removeFromPlaylists(id);
        removed += 1;
      }
    }
    library._recount();
    store.touch();
    broadcast('change', { reason: 'tracks-removed', count: removed });
    return sendJson(res, 200, { ok: true, removed, stats: library.stats() });
  }

  if (head === 'sources') {
    if (req.method === 'GET') return sendJson(res, 200, { sources: library.sources });
    if (req.method === 'POST') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const results = [];
      for (const p of paths) {
        if (!p) continue;
        // Папка, перетащенная из проводника, приходит как путь; иногда «путь\u0000путь».
        for (const single of String(p).split('\u0000')) {
          if (!single) continue;
          try {
            const { source, created } = library.addSource(single, body.type || 'auto');
            results.push({ ok: true, source, created });
          } catch (err) {
            results.push({ ok: false, path: single, error: err.message });
          }
        }
      }
      const ok = results.filter((r) => r.ok).length;
      if (!ok) return sendJson(res, 400, { error: results[0]?.error || 'Не удалось добавить источник', results });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ results, sources: library.sources, stats: library.stats() }));
      // индексируем в фоне, чтобы ответ вернулся мгновенно
      setImmediate(() => {
        library.scan({}).catch((err) => console.error('[scan]', err.message));
      });
      return undefined;
    }
    if (req.method === 'DELETE' && rest.length === 1) {
      const ok = library.removeSource(rest[0], q.get('keepTracks') !== '1');
      return sendJson(res, ok ? 200 : 404, { ok, stats: library.stats(), sources: library.sources });
    }
  }

  if (head === 'scan' && req.method === 'POST') {
    const body = await readBody(req);
    const summary = await library.scan({ onProgress: () => {} });
    if (body && body.prune) summary.pruned = true;
    return sendJson(res, 200, { ok: true, summary, stats: library.stats() });
  }

  if (head === 'favorites') {
    if (req.method === 'GET') return sendJson(res, 200, { tracks: library.favorites().map((t) => library.serializeTrack(t)) });
    if (req.method === 'POST' && rest.length === 1) {
      const favorite = library.toggleFavorite(rest[0]);
      return sendJson(res, 200, { ok: true, favorite });
    }
  }

  if (head === 'playlists') {
    if (req.method === 'GET' && !rest.length) return sendJson(res, 200, { playlists: library.playlists() });
    if (req.method === 'POST' && !rest.length) {
      const body = await readBody(req);
      const pl = library.createPlaylist(body.name);
      if (Array.isArray(body.trackIds) && body.trackIds.length) library.updatePlaylist(pl.id, { add: body.trackIds });
      return sendJson(res, 200, { playlist: library.playlist(pl.id) });
    }
    if (rest.length) {
      const id = rest[0];
      if (req.method === 'GET') {
        if (rest[1] === 'm3u') {
          const m3u = library.playlistM3U(id);
          if (!m3u) return sendJson(res, 404, { error: 'Плейлист не найден' });
          return sendBuffer(res, 200, Buffer.from(`\ufeff${m3u}`, 'utf8'), 'audio/x-mpegurl', {
            'Content-Disposition': `attachment; filename="${encodeURIComponent((library.playlist(id)?.name || 'playlist'))}.m3u8"`
          });
        }
        const pl = library.playlist(id);
        if (!pl) return sendJson(res, 404, { error: 'Плейлист не найден' });
        return sendJson(res, 200, { playlist: pl });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const pl = library.updatePlaylist(id, body);
        if (!pl) return sendJson(res, 404, { error: 'Плейлист не найден' });
        return sendJson(res, 200, { playlist: library.playlist(id), playlists: library.playlists() });
      }
      if (req.method === 'DELETE') {
        const ok = library.deletePlaylist(id);
        return sendJson(res, ok ? 200 : 404, { ok, playlists: library.playlists() });
      }
    }
  }

  if (head === 'settings') {
    if (req.method === 'GET') return sendJson(res, 200, { settings: store.settings });
    if (req.method === 'PATCH' || req.method === 'POST') {
      const body = await readBody(req);
      const settings = store.saveSettings(body || {});
      broadcast('settings', settings);
      return sendJson(res, 200, { settings });
    }
  }

  if (head === 'browse' && req.method === 'GET') {
    const target = q.get('path');
    if (!target) {
      const list = await roots();
      const sources = library.sources.map((s) => ({ path: s.path, label: s.name, kind: s.type }));
      return sendJson(res, 200, { path: null, parent: null, roots: list, sources, dirs: [], files: [] });
    }
    const resolved = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return sendJson(res, 404, { error: `Не удалось открыть: ${resolved}` });
    }
    if (!stat.isDirectory()) return sendJson(res, 400, { error: 'Это не папка' });
    try {
      const { dirs, files } = listDirs(resolved);
      const parent = path.dirname(resolved);
      return sendJson(res, 200, {
        path: resolved,
        name: path.basename(resolved) || resolved,
        parent: parent === resolved ? null : parent,
        dirs,
        files,
        alreadyAdded: library.sources.some((s) => path.resolve(s.path).toLowerCase() === resolved.toLowerCase())
      });
    } catch (err) {
      return sendJson(res, 403, { error: `Нет доступа к папке: ${err.message}` });
    }
  }

  if (head === 'folders' && req.method === 'POST') {
    // Нативный диалог выбора папки Windows (работает как запасной вариант рядом с drag & drop)
    if (process.platform !== 'win32') return sendJson(res, 200, { supported: false, path: null });
    const body = await readBody(req).catch(() => ({}));
    const title = body.title || 'Выберите папку с музыкой';
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${String(title).replace(/'/g, "''")}'`,
      '$d.ShowNewFolderButton = $false',
      '$f = New-Object System.Windows.Forms.Form',
      '$f.TopMost = $true',
      '$res = $d.ShowDialog($f)',
      'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { [Console]::Out.Write("") }'
    ].join('; ');
    return new Promise((resolve) => {
      exec(`powershell -NoProfile -STA -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 120000, windowsHide: false }, (err, stdout) => {
        const picked = (stdout || '').trim();
        sendJson(res, 200, { supported: true, path: err ? null : picked || null });
        resolve();
      });
    });
  }

  if (head === 'stats') return sendJson(res, 200, library.stats());

  if (head === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        clients.delete(res);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return undefined;
  }

  return sendJson(res, 404, { error: `Неизвестный маршрут: ${url.pathname}` });
}

// ------------------------------------------------------------------ media / art

function handleMedia(req, res, url) {
  // Раздаём ТОЛЬКО треки из подключённой фонотеки: иначе любой процесс на машине
  // мог бы прочитать через localhost произвольный файл (например приватный ключ).
  const id = url.searchParams.get('id');
  const p = url.searchParams.get('p');
  let track = null;
  if (id) track = library.getTrack(id);
  else if (p) track = library.trackByPath(path.resolve(p));

  if (!track) {
    return sendJson(res, 403, { error: 'Файл не входит в подключённую фонотеку' });
  }
  if (!fs.existsSync(track.path)) {
    delete store.db.tracks[track.id];
    store.touch();
    return sendJson(res, 404, { error: 'Файл больше не существует' });
  }
  return streamFile(req, res, track.path, {
    mime: mimeFor(track.path),
    extraHeaders: { 'Content-Disposition': 'inline' }
  });
}

function handleArt(req, res, url, kind) {
  const id = url.searchParams.get('id');
  const track = id ? library.getTrack(id) : null;
  if (!track) return sendText(res, 404, 'Обложка не найдена');

  if (kind === 'folder') {
    const file = library.folderCover(id);
    if (!file) return sendText(res, 404, 'Нет обложки в папке');
    return streamFile(req, res, file, { mime: mimeFor(file), extraHeaders: { 'Cache-Control': 'public, max-age=86400' } });
  }
  const embedded = library.embeddedCover(id);
  if (embedded) {
    return sendBuffer(res, 200, embedded.data, embedded.mime || 'image/jpeg', { 'Cache-Control': 'public, max-age=3600' });
  }
  const file = library.folderCover(id);
  if (file) return streamFile(req, res, file, { mime: mimeFor(file), extraHeaders: { 'Cache-Control': 'public, max-age=86400' } });
  return sendText(res, 404, 'Нет обложки');
}

// ------------------------------------------------------------------ статика

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) return sendText(res, 403, 'Forbidden');
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return sendText(res, 403, 'Forbidden');
    const ext = path.extname(filePath).toLowerCase();
    return streamFile(req, res, filePath, {
      mime: STATIC_TYPES[ext] || mimeFor(filePath),
      extraHeaders: { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60' }
    });
  } catch {
    // SPA-фолбэк только для навигации: отсутствующий файл с расширением — это 404,
    // иначе сломанный скрипт молча получил бы HTML с кодом 200.
    if (path.extname(rel)) return sendText(res, 404, 'Not found');
    try {
      const index = path.join(WEB_DIR, 'index.html');
      return streamFile(req, res, index, { mime: 'text/html; charset=utf-8', extraHeaders: { 'Cache-Control': 'no-cache' } });
    } catch {
      return sendText(res, 404, 'Not found');
    }
  }
}

// ------------------------------------------------------------------ сервер

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET,POST,PATCH,DELETE,OPTIONS' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/media') return handleMedia(req, res, url);
    if (url.pathname === '/art') return handleArt(req, res, url, url.searchParams.get('kind') || 'auto');
    return await handleStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.destroy();
    console.error('[server]', req.method, url.pathname, err.message);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function listen(port, host, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      console.log(`  порт ${port} занят, пробую ${port + 1}…`);
      listen(port + 1, host, attempt + 1);
    } else {
      console.error('Не удалось запустить сервер:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, host, async () => {
    const actual = server.address().port;
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`;
    const line = '─'.repeat(52);
    console.log(`\n  ${line}`);
    console.log('   GROOVESHELF  ·  оффлайн-плеер');
    console.log(`  ${line}`);
    console.log(`   Адрес:        ${url}`);
    console.log(`   Библиотека:   ${store.dbFile}`);
    console.log(`   Источников:   ${library.sources.length}`);
    console.log(`   Треков:       ${library.stats().tracks}`);
    console.log(`  ${line}\n`);
    if (args.root) {
      try {
        library.addSource(args.root);
        console.log(`   Источник из --root: ${args.root}`);
      } catch (err) {
        console.error(`   --root: ${err.message}`);
      }
    }
    if (library.sources.length) {
      library.scan({}).then((summary) => {
        if (summary && !summary.busy) console.log(`   Сканирование: +${summary.added} новых, ~${summary.updated} обновлено, -${summary.removed} удалено (${summary.total} в базе)`);
      }).catch((err) => console.error('[scan]', err.message));
    } else {
      console.log('   Библиотека пуста — добавьте папку в интерфейсе.\n');
    }
    if (args.open) openBrowser(url);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

process.on('SIGINT', () => {
  console.log('\n  Останавливаюсь…');
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

if (require.main === module || process.pkg || (() => { try { return require('node:sea').isSea(); } catch { return false; } })()) listen(args.port, args.host);

module.exports = { server, library, store, broadcast };