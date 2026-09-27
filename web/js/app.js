/* ============================================================================
   Grooveshelf — точка входа интерфейса.
   ========================================================================= */
import { $, $$, el, fmtTime, fmtLong, fmtSize, plural, debounce, compareText, fallbackArt, artColor, initials, clamp, normalize } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, openModal, openMenu, confirmDialog, promptDialog, makeSlider, hasModal, closeTopModal, closeMenu } from './ui.js';
import { api, subscribe } from './api.js';
import { Player } from './player.js';
import { LibraryView } from './library-view.js';
import { QueueView } from './queue.js';
import { openFolderBrowser, openShortcuts } from './browser.js';
import { openTagEditor, openTrackInfo, confirmDeletePlaylist } from './editor.js';

const THEMES = ['ember', 'paper'];

class App {
  constructor() {
    this.tracks = [];
    this.sources = [];
    this.playlists = [];
    this.settings = {};
    this.stats = {};
    this.view = 'tracks';
    this.activePlaylistId = null;
    this.activePlaylistTracks = [];
    this.activePlaylistMissing = 0;
    this.scanning = false;

    this.player = new Player({ audio: $('#audio') || this._createAudio(), canvas: $('#viz') });
    this.queue = new QueueView(this);
    this.libraryView = new LibraryView(this);

    this._saveSoon = debounce(() => this._persistSettings(), 400);
    this._bindUi();
    this._bindPlayer();
    this._bindKeyboard();
    this._bindDragDrop();
    this._bindEvents();

    hydrateIcons();
  }

  _createAudio() {
    const audio = document.createElement('audio');
    audio.id = 'audio';
    audio.preload = 'auto';
    document.body.append(audio);
    return audio;
  }

  // ------------------------------------------------------------ загрузка

  async start() {
    try {
      const state = await api.state();
      this.settings = state.settings || {};
      this.sources = state.sources || [];
      this.stats = state.stats || {};
      this.dataDir = state.dataDir;
      this.platform = state.platform;
      this.applyTheme(this.settings.theme);
      await this.refreshTracks();
      await this.refreshPlaylists();
      this.renderSidebar();
      this._applySettings();
      this.libraryView.render();
      this.queue.render();
      this.syncTransport();
      this.updateStats();

      const restored = await this.player.restore(this.tracks, this.settings);
      if (restored) this.syncNowPlaying();

      if (!this.sources.length) {
        setTimeout(() => this.showWelcome(), 420);
      }
      if (this.scanning) this.showScanBar();
    } catch (err) {
      toast({ title: 'Не удалось связаться с сервером', text: err.message, kind: 'err', timeout: 9000 });
    }
  }

  _applySettings() {
    const s = this.settings;
    this.player.setVolume(Number.isFinite(s.volume) ? s.volume : 1);
    this.player.audio.muted = !!s.muted;
    this.player.setShuffle(!!s.shuffle);
    this.player.setRepeat(s.repeat || 'off');
    this.player.setNormalize(!!s.normalize);
    this.player.setVisualizer(s.showVisualizer !== false);
    this.player.setSeekStep(s.seekStep || 5);

    this.libraryView.sort = s.sort || 'artist';
    this.libraryView.order = s.order || 'asc';
    $('#sort').value = this.libraryView.sort;
    $('#btn-sort-dir').dataset.icon = this.libraryView.order === 'asc' ? 'arrow-up' : 'arrow-down';
    hydrateIcons($('#btn-sort-dir'));

    $('#volume-fill').style.width = `${(Number(s.volume ?? 1)) * 100}%`;
    $('#btn-viz').classList.toggle('is-on', this.player.showViz);
    $('#btn-mute').dataset.icon = this.player.audio.muted ? 'volume-mute' : 'volume';
    hydrateIcons($('#btn-mute'));

    if (s.queueOpen) this.queue.open();
    if (s.view && ['tracks', 'albums', 'artists', 'favorites'].includes(s.view)) {
      this.setView(s.view, { silent: true });
    }
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._saveSoon();
    return this.settings;
  }

  _persistSettings() {
    const payload = { ...this.settings };
    api.settings(payload).catch(() => {});
  }

  // ------------------------------------------------------------ данные

  async refreshTracks() {
    const data = await api.tracks();
    this.tracks = data.tracks || [];
    this.stats = data.stats || this.stats;
    this.updateStats();
    return this.tracks;
  }

  async refreshPlaylists() {
    const data = await api.playlists();
    this.playlists = data.playlists || [];
    this.renderSidebar();
    if (this.activePlaylistId) await this.loadPlaylist(this.activePlaylistId, { silent: true });
    return this.playlists;
  }

  async refreshSources() {
    const data = await api.sources();
    this.sources = data.sources || [];
    this.renderSidebar();
    return this.sources;
  }

  async loadPlaylist(id, { silent = false } = {}) {
    if (!id) {
      this.activePlaylistId = null;
      this.activePlaylistTracks = [];
      this.activePlaylistMissing = 0;
      if (!silent) this.libraryView.render();
      return;
    }
    const data = await api.playlist(id);
    this.activePlaylistId = id;
    this.activePlaylistTracks = data.playlist?.tracks || [];
    const ids = new Set(this.tracks.map((t) => t.id));
    this.activePlaylistMissing = this.activePlaylistTracks.filter((t) => !ids.has(t.id)).length;
    if (!silent) this.libraryView.render();
    this.renderSidebar();
  }

  notifyLibraryChanged() {
    this.libraryView.render();
    this.syncNowPlaying();
  }

  async toggleFavorite(track) {
    try {
      const result = await api.toggleFavorite(track.id);
      const found = this.tracks.find((t) => t.id === track.id);
      if (found) found.favorite = result.favorite;
      this.updateStats();
      this.renderSidebar();
      this.libraryView.render();
      if (this.player.current?.id === track.id) this.syncNowPlaying();
      return result.favorite;
    } catch (err) {
      toast({ title: 'Не удалось изменить избранное', text: err.message, kind: 'err' });
      return false;
    }
  }

  async removeTracks(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const ok = await confirmDialog({
      title: 'Убрать из библиотеки?',
      message: `${plural.track(list.length)} исчезнут из плейлиста плеера. Сами файлы на диске не удаляются.`,
      confirmLabel: 'Убрать'
    });
    if (!ok) return;
    try {
      await api.removeTracks(list.map((t) => t.id));
      this.libraryView.selection.clear();
      await this.refreshTracks();
      this.notifyLibraryChanged();
      toast({ title: 'Убрано из библиотеки', text: plural.track(list.length), kind: 'ok' });
    } catch (err) {
      toast({ title: 'Не удалось убрать', text: err.message, kind: 'err' });
    }
  }

  updateStats() {
    const s = this.stats || {};
    $('#count-tracks').textContent = s.tracks ?? this.tracks.length;
    $('#count-albums').textContent = s.albums ?? '';
    $('#count-artists').textContent = s.artists ?? '';
    $('#count-favorites').textContent = s.favorites ?? '';
    $('#stats').innerHTML = `
      <div><div class="stat__value">${fmtLong(s.duration || 0)}</div><div class="stat__label">Звучания</div></div>
      <div><div class="stat__value">${fmtSize(s.size || 0)}</div><div class="stat__label">На диске</div></div>
      <div><div class="stat__value">${s.folders ?? this.sources.length}</div><div class="stat__label">Источников</div></div>
      <div><div class="stat__value">${s.playlists ?? this.playlists.length}</div><div class="stat__label">Плейлистов</div></div>`;
  }

  // ------------------------------------------------------------ сайдбар

  renderSidebar() {
    this._renderSources();
    this._renderPlaylists();
    this.updateStats();
    this._paintNav();
  }

  _renderSources() {
    const list = $('#source-list');
    list.innerHTML = '';
    if (!this.sources.length) {
      list.append(el('li', { class: 'sidebar__empty', text: 'Пока ничего не подключено. Добавьте папку с музыкой — файлы останутся на месте.' }));
      return;
    }
    for (const source of this.sources) {
      const node = el('li', {
        class: 'src',
        'data-id': source.id,
        title: source.path
      }, [
        el('span', { class: `src__icon${source.type === 'file' ? ' is-file' : ''}`, html: icon(source.type === 'file' ? 'file-audio' : 'folder') }),
        el('div', { class: 'src__body' }, [
          el('span', { class: 'src__name', text: source.name }),
          el('span', { class: 'src__meta', text: source.trackCount ? `${plural.track(source.trackCount)} · ${source.path}` : source.path })
        ]),
        el('span', { class: 'src__act' }, [
          el('button', { class: 'iconbtn', html: icon('menu'), title: 'Действия', 'data-act': 'menu' })
        ])
      ]);

      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-act]')) return;
        this.filterBySource(source);
      });
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this._sourceMenu(event, source);
      });
      node.querySelector('[data-act]').addEventListener('click', (event) => {
        event.stopPropagation();
        this._sourceMenu(event, source);
      });
      list.append(node);
    }
  }

  _sourceMenu(event, source) {
    openMenu([
      { header: source.name },
      { label: 'Показать треки', icon: 'list-music', onClick: () => this.filterBySource(source) },
      { label: 'Пересканировать', icon: 'refresh', onClick: () => this.scan() },
      { label: 'Открыть в проводнике', icon: 'external', onClick: () => api.revealSource(source.path).catch(() => toast({ title: 'Не удалось открыть проводник', kind: 'warn' })) },
      { separator: true },
      { label: 'Скопировать путь', icon: 'copy', onClick: () => navigator.clipboard?.writeText(source.path).then(() => toast({ title: 'Путь скопирован', kind: 'ok', timeout: 1800 })).catch(() => {}) },
      {
        label: 'Отключить источник',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Отключить источник?',
            message: `«${source.name}» перестанет быть частью фонотеки. Файлы на диске останутся нетронутыми.`,
            confirmLabel: 'Отключить'
          });
          if (!ok) return;
          try {
            await api.removeSource(source.id);
            await this.refreshSources();
            await this.refreshTracks();
            this.notifyLibraryChanged();
            toast({ title: 'Источник отключён', text: source.name, kind: 'ok' });
          } catch (err) {
            toast({ title: 'Не удалось отключить', text: err.message, kind: 'err' });
          }
        }
      }
    ], { x: event.clientX, y: event.clientY });
  }

  filterBySource(source) {
    this.activePlaylistId = null;
    this.libraryView.albumFilter = null;
    this.libraryView.artistFilter = null;
    this.libraryView.view = 'tracks';
    this.libraryView.sourceFilter = source.id;
    this.view = 'tracks';
    this.activePlaylistId = null;
    this.libraryView.sourceFilterName = source.name;
    this.libraryView.render();
    this._paintNav();
    this.saveSettings({ view: 'tracks' });
    this._paintSourceActive(source.id);
  }

  _paintSourceActive(id) {
    $$('#source-list .src').forEach((node) => node.classList.toggle('is-active', node.dataset.id === id));
  }

  _renderPlaylists() {
    const list = $('#playlist-list');
    list.innerHTML = '';
    if (!this.playlists.length) {
      list.append(el('li', { class: 'sidebar__empty', text: 'Плейлистов пока нет. Выделите треки и нажмите «В плейлист».' }));
      return;
    }
    for (const pl of this.playlists) {
      const node = el('li', {
        class: `pl${this.activePlaylistId === pl.id ? ' is-active' : ''}`,
        'data-id': pl.id,
        title: pl.name
      }, [
        el('span', { class: 'pl__icon', html: icon('list-music') }),
        el('div', { class: 'pl__body' }, [
          el('span', { class: 'pl__name', text: pl.name }),
          el('span', { class: 'pl__meta', text: `${plural.track(pl.count)} · ${fmtLong(pl.duration)}` })
        ]),
        el('span', { class: 'src__act' }, [
          el('button', { class: 'iconbtn', html: icon('menu'), 'data-act': 'menu' })
        ])
      ]);
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-act]')) return;
        this.openPlaylist(pl.id);
      });
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this._playlistMenu(event, pl);
      });
      node.querySelector('[data-act]').addEventListener('click', (event) => {
        event.stopPropagation();
        this._playlistMenu(event, pl);
      });
      list.append(node);
    }
  }

  _playlistMenu(event, pl) {
    openMenu([
      { header: pl.name },
      { label: 'Открыть', icon: 'list-music', onClick: () => this.openPlaylist(pl.id) },
      { label: 'Играть', icon: 'play', onClick: async () => { await this.openPlaylist(pl.id); this.playAll(); } },
      { label: 'Играть вперемешку', icon: 'shuffle', onClick: async () => { await this.openPlaylist(pl.id); this.playAll({ shuffle: true }); } },
      { separator: true },
      { label: 'Переименовать', icon: 'edit', onClick: async () => {
        const name = await promptDialog({ title: 'Переименовать плейлист', label: 'Название', value: pl.name, confirmLabel: 'Сохранить' });
        if (!name) return;
        await api.updatePlaylist(pl.id, { name });
        await this.refreshPlaylists();
      } },
      { label: 'Скачать .m3u8', icon: 'download', onClick: () => window.open(`/api/playlists/${pl.id}/m3u`, '_blank') },
      { separator: true },
      { label: 'Удалить плейлист', icon: 'trash', danger: true, onClick: () => confirmDeletePlaylist(this, pl) }
    ], { x: event.clientX, y: event.clientY });
  }

  openPlaylist(id) {
    this.libraryView.albumFilter = null;
    this.libraryView.artistFilter = null;
    this.libraryView.sourceFilter = null;
    this.libraryView.view = 'tracks';
    this.view = 'tracks';
    this.loadPlaylist(id);
    this._paintNav();
  }

  _paintNav() {
    $$('.nav__item').forEach((btn) => {
      const active = !this.activePlaylistId && btn.dataset.view === this.libraryView.view && !this.libraryView.inGroup && !this.libraryView.sourceFilter;
      btn.classList.toggle('is-active', active);
    });
    this._paintSourceActive(this.libraryView.sourceFilter);
  }

  setView(view, { albumFilter = null, artistFilter = null, silent = false } = {}) {
    this.view = view;
    this.activePlaylistId = null;
    this.activePlaylistTracks = [];
    this.libraryView.view = view;
    this.libraryView.albumFilter = albumFilter;
    this.libraryView.artistFilter = artistFilter;
    this.libraryView.sourceFilter = null;
    this.libraryView.selection.clear();
    this.libraryView.render();
    this._paintNav();
    if (!silent) this.saveSettings({ view });
  }

  // ------------------------------------------------------------ действия

  async scan() {
    if (this.scanning) {
      toast({ title: 'Сканирование уже идёт', kind: 'warn', timeout: 2200 });
      return;
    }
    this.scanning = true;
    this.showScanBar();
    try {
      const result = await api.scan();
      const s = result.summary || {};
      await this.refreshSources();
      await this.refreshTracks();
      this.notifyLibraryChanged();
      toast({
        title: 'Сканирование завершено',
        text: `Найдено ${s.found ?? 0}, новых ${s.added ?? 0}, обновлено ${s.updated ?? 0}, убрано ${s.removed ?? 0}`,
        kind: 'ok',
        timeout: 5200
      });
    } catch (err) {
      toast({ title: 'Сканирование не удалось', text: err.message, kind: 'err' });
    } finally {
      this.scanning = false;
      this.hideScanBar();
    }
  }

  showScanBar() {
    if ($('.scanbar')) return;
    const bar = el('div', { class: 'scanbar' }, [el('i')]);
    document.body.append(bar);
  }

  hideScanBar() {
    $('.scanbar')?.remove();
  }

  hintScanRunning() {
    this.scanning = true;
    this.showScanBar();
  }

  openFolderBrowser() {
    openFolderBrowser(this);
  }

  pickFiles() {
    const input = $('#file-input');
    input.value = '';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const paths = files.map((f) => f.path).filter(Boolean);
      if (paths.length) {
        await api.addSource(paths, 'file');
        this.hintScanRunning();
        await this.refreshSources();
        toast({ title: 'Файлы добавлены', text: plural.track(paths.length), kind: 'ok' });
      } else {
        await this.uploadFiles(files, '');
      }
    };
    input.click();
  }

  /** Файлы из браузера сохраняются в папку фонотеки плеера (dropped/). */
  async uploadFiles(files, relPath = '') {
    if (!files.length) return;
    const stop = toast({ title: 'Копирую файлы…', text: `${files.length}`, kind: 'info', timeout: 0 });
    let done = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await api.upload(file, relPath);
        done += 1;
      } catch {
        failed += 1;
      }
      if (done % 5 === 0) {
        stop();
        toast({ title: 'Копирую файлы…', text: `${done} из ${files.length}`, kind: 'info', timeout: 0 });
      }
    }
    stop();
    this.hintScanRunning();
    await this.refreshSources();
    await this.refreshTracks();
    this.notifyLibraryChanged();
    toast({
      title: 'Готово',
      text: `Скопировано ${plural.track(done)}${failed ? `, пропущено ${failed}` : ''}`,
      kind: failed ? 'warn' : 'ok'
    });
  }

  playAll({ shuffle = false, list = null } = {}) {
    const tracks = list || this.libraryView.visibleTracks();
    if (!tracks.length) {
      toast({ title: 'Нечего играть', text: 'В текущем разделе нет треков', kind: 'warn' });
      return;
    }
    if (shuffle) {
      this.player.setShuffle(true);
      this.syncTransport();
    }
    const context = this.libraryView.playContext();
    const startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    this.player.playTracks(tracks, startIndex, context);
  }

  async createPlaylist() {
    const name = await promptDialog({ title: 'Новый плейлист', label: 'Название плейлиста', placeholder: 'Например: Дорога' });
    if (!name) return;
    await api.createPlaylist(name, []);
    await this.refreshPlaylists();
    toast({ title: 'Плейлист создан', text: name, kind: 'ok' });
  }

  showWelcome() {
    const dialog = openModal({
      title: 'Добро пожаловать в Grooveshelf',
      subtitle: 'Оффлайн-плеер для вашей фонотеки',
      width: '',
      body: el('div', { class: 'welcome' }, [
        el('p', { class: 'welcome__lead', text: 'Плеер работает прямо с вашими файлами: ничего не загружается в интернет, музыка не копируется и не переименовывается.' }),
        el('div', { class: 'welcome__grid' }, [
          el('div', { class: 'welcome__card' }, [
            el('span', { class: 'welcome__icon', html: icon('folder-plus') }),
            el('strong', { text: 'Папки' }),
            el('p', { text: 'Подключите папку целиком — плеер найдёт в ней все аудиофайлы, включая вложенные папки.' })
          ]),
          el('div', { class: 'welcome__card' }, [
            el('span', { class: 'welcome__icon', html: icon('file-audio') }),
            el('strong', { text: 'Отдельные файлы' }),
            el('p', { text: 'Добавьте конкретные треки, если не хотите подключать всю папку.' })
          ]),
          el('div', { class: 'welcome__card' }, [
            el('span', { class: 'welcome__icon', html: icon('tag') }),
            el('strong', { text: 'Теги и обложки' }),
            el('p', { text: 'Плеер читает ID3, FLAC, OGG и M4A. Теги можно править прямо в плеере.' })
          ]),
          el('div', { class: 'welcome__card' }, [
            el('span', { class: 'welcome__icon', html: icon('keyboard') }),
            el('strong', { text: 'Клавиатура' }),
            el('p', { text: 'Пробел — пауза, стрелки — перемотка и громкость, «?» — все горячие клавиши.' })
          ])
        ])
      ]),
      footer: [
        el('div', { class: 'spacer' }),
        (() => {
          const later = el('button', { class: 'btn', text: 'Позже' });
          later.addEventListener('click', () => dialog.close());
          return later;
        })(),
        (() => {
          const go = el('button', { class: 'btn btn--solid', html: `${icon('folder-plus')}<span>Выбрать папку</span>` });
          go.addEventListener('click', () => {
            dialog.close();
            this.openFolderBrowser();
          });
          return go;
        })()
      ]
    });
  }

  // ------------------------------------------------------------ привязки

  _bindUi() {
    $('#btn-sidebar')?.addEventListener('click', () => $('#shell').classList.toggle('sidebar-open'));

    $('#search').addEventListener('input', debounce((event) => {
      this.libraryView.search = event.target.value.trim();
      $('#search-form').classList.toggle('has-value', !!this.libraryView.search);
      this.libraryView.render();
    }, 160));
    $('#search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.target.value = '';
        this.libraryView.search = '';
        $('#search-form').classList.remove('has-value');
        this.libraryView.render();
        event.target.blur();
      }
    });
    $('#search-form').addEventListener('submit', (event) => event.preventDefault());
    $('#search-clear').addEventListener('click', () => {
      $('#search').value = '';
      this.libraryView.search = '';
      $('#search-form').classList.remove('has-value');
      this.libraryView.render();
      $('#search').focus();
    });

    $$('.nav__item').forEach((btn) => {
      btn.addEventListener('click', () => this.setView(btn.dataset.view));
    });

    $('#sort').addEventListener('change', (event) => {
      this.libraryView.sort = event.target.value;
      this.saveSettings({ sort: this.libraryView.sort });
      this.libraryView.render();
    });
    $('#btn-sort-dir').addEventListener('click', () => {
      this.libraryView.order = this.libraryView.order === 'asc' ? 'desc' : 'asc';
      $('#btn-sort-dir').dataset.icon = this.libraryView.order === 'asc' ? 'arrow-up' : 'arrow-down';
      hydrateIcons($('#btn-sort-dir'));
      this.saveSettings({ order: this.libraryView.order });
      this.libraryView.render();
    });

    $('#btn-add-folder').addEventListener('click', () => this.openFolderBrowser());
    $('#btn-add-files').addEventListener('click', () => this.pickFiles());
    $('#btn-add-source').addEventListener('click', () => this.openFolderBrowser());
    $('#btn-new-playlist').addEventListener('click', () => this.createPlaylist());
    $('#btn-scan').addEventListener('click', () => this.scan());
    $('#btn-play-all').addEventListener('click', () => this.playAll());
    $('#btn-shuffle-all').addEventListener('click', () => this.playAll({ shuffle: true }));

    $('#btn-theme').addEventListener('click', () => {
      const next = THEMES[(THEMES.indexOf(this.settings.theme) + 1) % THEMES.length];
      this.applyTheme(next);
      this.saveSettings({ theme: next });
    });

    $('#btn-menu').addEventListener('click', (event) => {
      openMenu([
        { header: 'Действия' },
        { label: 'Добавить папку с музыкой', icon: 'folder-plus', onClick: () => this.openFolderBrowser() },
        { label: 'Добавить отдельные файлы', icon: 'file-plus', onClick: () => this.pickFiles() },
        { label: 'Пересканировать библиотеку', icon: 'refresh', onClick: () => this.scan() },
        { separator: true },
        { label: 'Горячие клавиши', icon: 'keyboard', onClick: () => openShortcuts() },
        { label: 'Сменить тему', icon: 'sun', onClick: () => {
          const next = THEMES[(THEMES.indexOf(this.settings.theme) + 1) % THEMES.length];
          this.applyTheme(next);
          this.saveSettings({ theme: next });
        } },
        { separator: true },
        { label: 'Экспорт библиотеки', icon: 'download', onClick: () => this.exportLibrary() },
        { label: 'Где хранится библиотека', icon: 'info', onClick: () => toast({ title: 'Папка данных', text: this.dataDir, kind: 'info', timeout: 7000 }) }
      ], { anchor: event.currentTarget });
    });
  }

  applyTheme(theme) {
    const name = THEMES.includes(theme) ? theme : 'ember';
    document.documentElement.dataset.theme = name;
    const btn = $('#btn-theme');
    btn.dataset.icon = name === 'ember' ? 'sun' : 'moon';
    btn.title = name === 'ember' ? 'Светлая тема' : 'Тёмная тема';
    hydrateIcons(btn);
  }

  exportLibrary() {
    const rows = this.tracks.map((t, i) => ({
      '#': i + 1,
      Название: t.title,
      Исполнитель: t.artist,
      Альбом: t.album,
      Год: t.year,
      Жанр: t.genre,
      Длительность: fmtTime(t.duration),
      Формат: t.ext.replace('.', '').toUpperCase(),
      Битрейт: t.bitrate,
      Размер: t.size,
      Путь: t.path
    }));
    const header = Object.keys(rows[0] || { '—': '' });
    const csv = [
      header.join(';'),
      ...rows.map((row) => header.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(';'))
    ].join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `grooveshelf-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast({ title: 'Библиотека выгружена', text: `${plural.track(rows.length)} в CSV`, kind: 'ok' });
  }

  // ------------------------------------------------------------ плеер

  _bindPlayer() {
    const player = this.player;

    player.on('state', () => this.syncTransport());
    player.on('queue', () => {
      this.queue.render();
      this.syncNowPlaying();
    });
    player.on('track', () => {
      this.syncNowPlaying();
      this.libraryView.refreshPlaying();
      document.title = player.current ? `${player.current.title} — Grooveshelf` : 'Grooveshelf — оффлайн-плеер';
    });
    player.on('time', ({ time, duration }) => this.syncTime(time, duration));
    player.on('buffered', ({ buffered }) => this.syncBuffer(buffered));
    player.on('waiting', (waiting) => {
      $('.now__art').classList.toggle('is-loading', !!waiting);
    });
    player.on('error', ({ track }) => {
      toast({ title: 'Файл не воспроизводится', text: `${track.title} — пропускаю`, kind: 'warn', timeout: 4000 });
    });
    player.on('unsupported', (track) => {
      toast({
        title: 'Формат не поддерживается браузером',
        text: `${track.ext.replace('.', '').toUpperCase()} — ${track.name}`,
        kind: 'warn',
        timeout: 6000
      });
    });
    player.on('blocked', () => {
      toast({ title: 'Браузер ждёт нажатия', text: 'Нажмите «Играть», чтобы разрешить звук', kind: 'info' });
    });

    $('#btn-play').addEventListener('click', () => player.toggle());
    $('#btn-next').addEventListener('click', () => player.next(false));
    $('#btn-prev').addEventListener('click', () => player.prev());
    $('#btn-shuffle').addEventListener('click', () => {
      player.setShuffle(!player.shuffle);
      this.saveSettings({ shuffle: player.shuffle });
      toast({ title: player.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', kind: 'info', timeout: 1800 });
    });
    $('#btn-repeat').addEventListener('click', () => {
      player.cycleRepeat();
      this.saveSettings({ repeat: player.repeat });
      const names = { off: 'Повтор выключен', all: 'Повтор всей очереди', one: 'Повтор одного трека' };
      toast({ title: names[player.repeat], kind: 'info', timeout: 1800 });
    });
    $('#btn-fav').addEventListener('click', () => {
      const track = player.current;
      if (track) this.toggleFavorite(track);
    });
    $('#btn-edit').addEventListener('click', () => {
      const track = player.current;
      if (!track) return toast({ title: 'Ничего не играет', kind: 'warn', timeout: 2000 });
      openTagEditor(this, track);
    });
    $('#btn-mute').addEventListener('click', () => {
      player.toggleMute();
      this.saveSettings({ muted: player.audio.muted });
      $('#btn-mute').dataset.icon = player.audio.muted ? 'volume-mute' : 'volume';
      hydrateIcons($('#btn-mute'));
    });
    $('#btn-viz').addEventListener('click', () => {
      player.setVisualizer(!player.showViz);
      $('#btn-viz').classList.toggle('is-on', player.showViz);
      this.saveSettings({ showVisualizer: player.showViz });
    });
    $('#np-art').addEventListener('click', () => this.queue.toggle());
    $('#np-title').addEventListener('click', () => {
      if (player.current) openTrackInfo(this, player.current);
    });
    $('#np-artist').addEventListener('click', () => {
      const track = player.current;
      if (!track) return;
      if (track.artist) {
        this.setView('tracks', { artistFilter: normalize(track.artist) });
      }
    });

    // Прогресс
    const progress = $('#progress');
    const fill = $('#progress-fill');
    const progressSlider = makeSlider(progress, {
      step: 0,
      get: () => (player.duration ? player.currentTime / player.duration : 0),
      set: (ratio) => {
        const duration = player.duration || player.current?.duration || 0;
        if (!duration) return;
        fill.style.width = `${ratio * 100}%`;
        $('#time-cur').textContent = fmtTime(ratio * duration);
      }
    });
    progressSlider.sync();
    progress.addEventListener('pointerdown', () => progress.classList.add('is-dragging'));
    progress.addEventListener('pointerup', () => {
      progress.classList.remove('is-dragging');
      const duration = player.duration || player.current?.duration || 0;
      if (duration) player.seekRatio(clamp(parseFloat(fill.style.width || '0') / 100, 0, 1));
    });

    // Громкость
    const volume = $('#volume');
    const volumeFill = $('#volume-fill');
    makeSlider(volume, {
      step: 0.02,
      get: () => player.audio.volume,
      set: (value) => {
        player.setVolume(value);
        volumeFill.style.width = `${value * 100}%`;
        $('#btn-mute').dataset.icon = value === 0 ? 'volume-mute' : 'volume';
        hydrateIcons($('#btn-mute'));
        this.saveSettings({ volume: value });
      }
    });
  }

  syncTransport() {
    const player = this.player;
    const playBtn = $('#btn-play');
    playBtn.dataset.icon = player.playing ? 'pause' : 'play';
    hydrateIcons(playBtn);
    $('.player')?.classList.toggle('is-playing', player.playing);

    const shuffleBtn = $('#btn-shuffle');
    shuffleBtn.classList.toggle('is-on', player.shuffle);
    const repeatBtn = $('#btn-repeat');
    repeatBtn.dataset.icon = player.repeat === 'one' ? 'repeat-one' : 'repeat';
    repeatBtn.classList.toggle('is-on', player.repeat !== 'off');
    repeatBtn.title = { off: 'Повтор выключен', all: 'Повтор всей очереди', one: 'Повтор одного трека' }[player.repeat];
    hydrateIcons(repeatBtn);

    const track = player.current;
    if (track) {
      $('#btn-fav').classList.toggle('is-on', !!track.favorite);
      $('#np-badge').hidden = false;
      const quality = track.lossless
        ? `${track.ext.replace('.', '').toUpperCase()} · без потерь`
        : (track.bitrate ? `${track.bitrate} кбит/с` : track.ext.replace('.', '').toUpperCase());
      $('#np-badge').textContent = quality;
      $('#np-badge').className = `now__badge badge ${track.lossless ? 'badge--lossless' : ''}`;
      const duration = player.duration || track.duration || 0;
      $('#time-total').textContent = fmtTime(duration, { unknown: '0:00' });
    }

    this.libraryView.refreshPlaying();
  }

  syncNowPlaying() {
    const track = this.player.current;
    const art = $('#np-art-img');
    const fallback = $('#np-art-fallback');
    if (!track) {
      art.hidden = true;
      fallback.style.background = '';
      fallback.textContent = '';
      $('#np-title').textContent = 'Ничего не играет';
      $('#np-artist').textContent = 'Добавьте музыку, чтобы начать';
      $('#np-badge').hidden = true;
      $('#btn-fav').classList.remove('is-on');
      document.title = 'Grooveshelf — оффлайн-плеер';
      return;
    }
    $('#np-title').textContent = track.title || track.name;
    $('#np-artist').textContent = [track.artist || 'Неизвестный исполнитель', track.album].filter(Boolean).join(' — ');
    $('#btn-fav').classList.toggle('is-on', !!track.favorite);
    document.title = `${track.title || track.name} — Grooveshelf`;

    fallback.style.background = '';
    fallback.textContent = '';
    art.hidden = false;
    art.onerror = () => {
      art.hidden = true;
      fallback.textContent = initials(track.artist || track.album || track.title || '♪');
      const { from, to } = artColor(track.album || track.artist || track.title || '');
      fallback.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    };
    art.onload = () => {
      art.hidden = false;
    };
    art.src = `/art?id=${encodeURIComponent(track.id)}`;

    this.queue.render();
    this.syncTransport();
  }

  syncTime(time, duration) {
    const ratio = duration ? clamp(time / duration, 0, 1) : 0;
    $('#progress-fill').style.width = `${ratio * 100}%`;
    $('#time-cur').textContent = fmtTime(time, { unknown: '0:00' });
    $('#time-total').textContent = fmtTime(duration || this.player.current?.duration || 0, { unknown: '0:00' });
  }

  syncBuffer(buffered) {
    void buffered;
  }

  // ------------------------------------------------------------ клавиатура

  _bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

      if (event.key === 'Escape') {
        closeMenu();
        if (hasModal()) {
          closeTopModal();
          return;
        }
        if (typing) {
          target.blur();
          return;
        }
        if (this.libraryView.selection.size) {
          this.libraryView.selection.clear();
          this.libraryView._paintSelection();
        }
        return;
      }

      if (typing) return;

      const player = this.player;
      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        $('#search').focus();
        $('#search').select();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        this.libraryView.selection = new Set(this.libraryView.visibleTracks().map((t) => t.id));
        this.libraryView._paintSelection();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.openFolderBrowser();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        this.queue.toggle();
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          player.toggle();
          break;
        case 'ArrowRight':
          event.preventDefault();
          player.seekBy(ctrl ? 60 : event.shiftKey ? 30 : player.seekStep);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          player.seekBy(-(ctrl ? 60 : event.shiftKey ? 30 : player.seekStep));
          break;
        case 'ArrowUp':
          event.preventDefault();
          player.setVolume(player.audio.volume + 0.05);
          $('#volume-fill').style.width = `${player.audio.volume * 100}%`;
          this.saveSettings({ volume: player.audio.volume });
          break;
        case 'ArrowDown':
          event.preventDefault();
          player.setVolume(player.audio.volume - 0.05);
          $('#volume-fill').style.width = `${player.audio.volume * 100}%`;
          this.saveSettings({ volume: player.audio.volume });
          break;
        case 'F5':
          event.preventDefault();
          this.scan();
          break;
        case '?':
          event.preventDefault();
          openShortcuts();
          break;
        case '/':
          event.preventDefault();
          $('#search').focus();
          break;
        default:
          break;
      }

      const key = event.key.toLowerCase();
      if (key === 'n') player.next(false);
      else if (key === 'p') player.prev();
      else if (key === 's') {
        player.setShuffle(!player.shuffle);
        this.saveSettings({ shuffle: player.shuffle });
      } else if (key === 'r') {
        player.cycleRepeat();
        this.saveSettings({ repeat: player.repeat });
      } else if (key === 'm') {
        player.toggleMute();
        this.saveSettings({ muted: player.audio.muted });
        $('#btn-mute').dataset.icon = player.audio.muted ? 'volume-mute' : 'volume';
        hydrateIcons($('#btn-mute'));
      } else if (key === 'f') {
        if (player.current) this.toggleFavorite(player.current);
      } else if (key === 'e') {
        if (player.current) openTagEditor(this, player.current);
      } else if (key === 'q') {
        this.queue.toggle();
      } else if (key === 'enter') {
        const selected = this.libraryView.selectedTracks();
        if (selected.length) player.playTracks(selected, 0, this.libraryView.playContext());
      }
    });
  }

  // ------------------------------------------------------------ перетаскивание

  _bindDragDrop() {
    const veil = $('#dropveil');
    let depth = 0;

    const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

    window.addEventListener('dragenter', (event) => {
      if (!isFileDrag(event)) return;
      depth += 1;
      veil.hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) veil.hidden = true;
    });
    window.addEventListener('drop', async (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth = 0;
      veil.hidden = true;
      const collected = await collectDropped(event.dataTransfer);
      if (collected.paths.length) {
        try {
          const result = await api.addSource(collected.paths, 'auto');
          const ok = result.results.filter((r) => r.ok).length;
          const failed = result.results.filter((r) => !r.ok);
          toast({ title: 'Добавлено в фонотеку', text: plural.folder(ok), kind: 'ok' });
          if (failed.length) toast({ title: 'Пропущено', text: failed[0].error, kind: 'warn', timeout: 5000 });
          this.hintScanRunning();
          await this.refreshSources();
        } catch (err) {
          toast({ title: 'Не удалось добавить', text: err.message, kind: 'err' });
        }
      }
      if (collected.files.length) {
        const audio = collected.files.filter((f) => /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wma|aiff?|mp4|webm)$/i.test(f.name));
        const skipped = collected.files.length - audio.length;
        if (skipped) toast({ title: `Пропущено ${skipped} файлов`, text: 'Поддерживаются только аудиоформаты', kind: 'warn' });
        if (audio.length) await this.uploadFiles(audio, collected.relPath);
      }
      if (!collected.paths.length && !collected.files.length) {
        toast({ title: 'Ничего не добавлено', text: 'Перетащите папку с музыкой или аудиофайлы', kind: 'warn' });
      }
    });
  }

  // ------------------------------------------------------------ события сервера

  _bindEvents() {
    subscribe({
      scan: (data) => {
        if (!data) return;
        this.scanning = true;
        this.showScanBar();
        const label = data.phase === 'collect' ? 'Читаю папки' : 'Разбираю теги';
        if (data.total) {
          const pct = Math.round((data.done / data.total) * 100);
          document.title = `${label} ${pct}% — Grooveshelf`;
        }
      },
      change: async (data) => {
        if (!data) return;
        if (data.reason === 'scan') {
          this.scanning = false;
          this.hideScanBar();
          await this.refreshSources();
          await this.refreshTracks();
          this.notifyLibraryChanged();
          await this.refreshPlaylists();
        } else if (data.reason === 'track-updated') {
          const track = this.tracks.find((t) => t.id === data.id);
          if (track) {
            const fresh = await api.track(data.id);
            Object.assign(track, fresh.track);
            this.notifyLibraryChanged();
          }
        }
      },
      settings: (settings) => {
        if (settings) this.settings = { ...this.settings, ...settings };
      }
    });

    window.addEventListener('beforeunload', () => {
      this.player._savePosition(false);
      this._persistSettings();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.player._savePosition(false);
        this._persistSettings();
      }
    });
  }
}

/** Собирает пути и файлы из перетаскивания, включая папки. */
async function collectDropped(dataTransfer) {
  const out = { paths: [], files: [], relPath: '' };
  const items = Array.from(dataTransfer.items || []);
  const entries = items.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)).filter(Boolean);

  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, out);
    return out;
  }

  for (const file of Array.from(dataTransfer.files || [])) {
    if (file.path) out.paths.push(file.path);
    else out.files.push(file);
  }
  return out;
}

function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        if (file.path) out.paths.push(file.path);
        else {
          file.relPath = entry.fullPath || '';
          out.files.push(file);
        }
        resolve();
      }, () => resolve());
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          for (const child of batch) await walkEntry(child, out);
          readBatch();
        }, () => resolve());
      };
      readBatch();
      return;
    }
    resolve();
  });
}

const app = new App();
window.__app = app;
app.start();