/* Тонкая обёртка над HTTP API сервера. */

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const error = new Error(data?.error || `Ошибка запроса (${res.status})`);
    error.payload = data;
    error.status = res.status;
    throw error;
  }
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),
  tracks: () => request('GET', '/api/tracks'),
  track: (id) => request('GET', `/api/tracks/${encodeURIComponent(id)}`),
  updateTrack: (id, patch) => request('PATCH', `/api/tracks/${encodeURIComponent(id)}`, patch),

  sources: () => request('GET', '/api/sources'),
  addSource: (paths, type = 'auto') => request('POST', '/api/sources', { paths, type }),
  removeSource: (id, keepTracks = false) => request('DELETE', `/api/sources/${encodeURIComponent(id)}${keepTracks ? '?keepTracks=1' : ''}`),
  scan: () => request('POST', '/api/scan', {}),

  browse: (path) => request('GET', `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  pickFolder: () => request('POST', '/api/folders', {}),

  favorites: () => request('GET', '/api/favorites'),
  toggleFavorite: (id) => request('POST', `/api/favorites/${encodeURIComponent(id)}`),

  playlists: () => request('GET', '/api/playlists'),
  playlist: (id) => request('GET', `/api/playlists/${encodeURIComponent(id)}`),
  createPlaylist: (name, trackIds) => request('POST', '/api/playlists', { name, trackIds }),
  updatePlaylist: (id, patch) => request('PATCH', `/api/playlists/${encodeURIComponent(id)}`, patch),
  deletePlaylist: (id) => request('DELETE', `/api/playlists/${encodeURIComponent(id)}`),

  settings: (patch) => request('PATCH', '/api/settings', patch),
  /** Показать в проводнике: трек фонотеки по id или подключённую папку по пути. */
  reveal: (id) => request('POST', '/api/reveal', { id }),
  revealSource: (path) => request('POST', '/api/reveal', { path }),
  removeTracks: (ids) => request('POST', '/api/tracks/remove', { ids }),

  /** Загрузка файла, перетащенного в окно браузера. */
  async upload(file, relPath = '') {
    const url = `/api/upload?name=${encodeURIComponent(file.name)}&rel=${encodeURIComponent(relPath)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Не удалось загрузить ${file.name}`);
    return data;
  }
};

/** Подписка на события сервера (Server-Sent Events). */
export function subscribe(handlers = {}) {
  let source = null;
  const connect = () => {
    source = new EventSource('/api/events');
    const bind = (name) => source.addEventListener(name, (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        data = null;
      }
      handlers[name]?.(data);
    });
    ['scan', 'change', 'saved', 'settings'].forEach(bind);
    source.addEventListener('error', () => {
      // EventSource переподключится сам; здесь только сигнал интерфейсу.
      handlers.disconnected?.();
    });
    source.addEventListener('open', () => handlers.connected?.());
  };
  connect();
  return {
    close: () => source?.close()
  };
}

/** Ссылка на поток аудиофайла (сервер умеет Range → seek работает). */
export function mediaUrl(track) {
  // По идентификатору фонотеки, а не по пути: сервер отдаёт только то, что
  // действительно подключено, и не становится читателем произвольных файлов.
  return `/media?id=${encodeURIComponent(track.id)}`;
}