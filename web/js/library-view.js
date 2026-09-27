/* ============================================================================
   Представление библиотеки: таблица треков, альбомы, исполнители, избранное.
   ========================================================================= */
import {
  $, el, fmtTime, fmtLong, fmtSize, plural, matchesQuery, compareText,
  fallbackArt, artUrl, normalize, debounce
} from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, openMenu, openModal, confirmDialog } from './ui.js';
import { api } from './api.js';
import { PlaylistPicker, openTagEditor, openTrackInfo } from './editor.js';

const SORTS = {
  artist: (a, b) => compareText(a.albumArtist || a.artist, b.albumArtist || b.artist)
    || compareText(a.album, b.album)
    || (a.discNo || 0) - (b.discNo || 0)
    || (a.trackNo || 0) - (b.trackNo || 0)
    || compareText(a.title, b.title),
  album: (a, b) => compareText(a.album, b.album)
    || (a.discNo || 0) - (b.discNo || 0)
    || (a.trackNo || 0) - (b.trackNo || 0)
    || compareText(a.title, b.title),
  title: (a, b) => compareText(a.title, b.title),
  year: (a, b) => (b.year || 0) - (a.year || 0) || compareText(a.artist, b.artist) || compareText(a.album, b.album),
  duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  added: (a, b) => compareText(a.addedAt, b.addedAt),
  path: (a, b) => compareText(a.path, b.path)
};

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.view = 'tracks';
    this.search = '';
    this.sort = 'artist';
    this.order = 'asc';
    this.selection = new Set();
    this.lastClicked = null;
    this.renderToken = 0;
    this.albumFilter = null;
    this.artistFilter = null;
    this.sourceFilter = null;
    this._sourceFilterName = null;

    this.nodes = {
      body: $('#main-body'),
      tracks: $('#track-list'),
      tracksHead: $('#tracks-head'),
      cards: $('#card-list'),
      viewTracks: $('#view-tracks'),
      viewGrid: $('#view-grid'),
      title: $('#view-title'),
      eyebrow: $('#view-eyebrow'),
      meta: $('#view-meta')
    };

    this._bind();
  }

  _bind() {
    this.nodes.tracksHead.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-sort]');
      if (!btn) return;
      const key = btn.dataset.sort;
      if (this.sort === key) this.order = this.order === 'asc' ? 'desc' : 'asc';
      else {
        this.sort = key;
        this.order = 'asc';
      }
      this.app.saveSettings({ sort: this.sort, order: this.order });
      this.render();
    });

    this.nodes.tracks.addEventListener('click', (event) => this._onTrackClick(event));
    this.nodes.tracks.addEventListener('dblclick', (event) => this._onTrackDblClick(event));
    this.nodes.tracks.addEventListener('contextmenu', (event) => this._onTrackContext(event));
    this.nodes.cards.addEventListener('click', (event) => this._onCardClick(event));
    this.nodes.cards.addEventListener('contextmenu', (event) => this._onCardContext(event));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.selection.size) {
        this.selection.clear();
        this._paintSelection();
      }
    });
  }

  // ------------------------------------------------------------ фильтрация

  get trackList() {
    return this.app.tracks;
  }

  /** Треки текущего раздела с учётом поиска. */
  visibleTracks() {
    let list = this.trackList;
    if (this.app.activePlaylistId) {
      const order = this.app.activePlaylistTracks.map((t) => t.id);
      list = order.map((id) => list.find((t) => t.id === id)).filter(Boolean);
      return list;
    }
    if (this.sourceFilter) list = list.filter((t) => t.sourceId === this.sourceFilter);
    if (this.view === 'favorites') list = list.filter((t) => t.favorite);
    if (this.albumFilter) {
      list = list.filter((t) => `${normalize(t.albumArtist || t.artist)}::${normalize(t.album)}` === this.albumFilter);
    }
    if (this.artistFilter) {
      list = list.filter((t) => normalize(t.artist) === this.artistFilter);
    }
    if (this.search) list = list.filter((t) => matchesQuery(t, this.search));
    const sorted = [...list].sort(SORTS[this.sort] || SORTS.artist);
    return this.order === 'desc' ? sorted.reverse() : sorted;
  }

  /** Находимся «внутри» альбома или исполнителя — тогда таблица всегда по порядку. */
  get inGroup() {
    return !!this.albumFilter || !!this.artistFilter;
  }

  /** Подпись раздела, когда список ограничен источником. */
  get sourceFilterName() {
    return this._sourceFilterName || null;
  }

  set sourceFilterName(name) {
    this._sourceFilterName = name;
  }

  groups() {
    const map = new Map();
    for (const track of this.visibleTracks()) {
      const key = this.view === 'albums'
        ? `${normalize(track.albumArtist || track.artist)}::${normalize(track.album)}`
        : normalize(track.artist) || '—';
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: this.view === 'albums' ? (track.album || 'Без альбома') : (track.artist || 'Неизвестный исполнитель'),
          sub: this.view === 'albums' ? (track.albumArtist || track.artist || 'Неизвестный исполнитель') : '',
          year: track.year,
          tracks: []
        });
      }
      map.get(key).tracks.push(track);
    }
    const list = Array.from(map.values());
    for (const group of list) {
      group.duration = group.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
      group.tracks.sort((a, b) => (a.discNo || 0) - (b.discNo || 0) || (a.trackNo || 0) - (b.trackNo || 0) || compareText(a.title, b.title));
      const withCover = group.tracks.find((t) => t.hasCover) || group.tracks[0];
      group.coverTrack = withCover;
    }
    list.sort((a, b) => compareText(a.name, b.name));
    return list;
  }

  // ------------------------------------------------------------ рендер

  render() {
    const token = ++this.renderToken;
    this._renderHead();
    const grid = this.view === 'albums' || this.view === 'artists';
    this.nodes.viewTracks.hidden = grid;
    this.nodes.viewGrid.hidden = !grid;
    if (grid) this._renderCards(token);
    else this._renderTable(token);
    hydrateIcons(this.nodes.body);
  }

  _renderHead() {
    const { title, eyebrow, meta } = this.nodes;
    const tracks = this.visibleTracks();
    const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const totalSize = tracks.reduce((sum, t) => sum + (t.size || 0), 0);

    if (this.app.activePlaylistId) {
      const pl = this.app.playlists.find((p) => p.id === this.app.activePlaylistId);
      eyebrow.textContent = 'Плейлист';
      title.textContent = pl?.name || 'Плейлист';
      meta.textContent = `${plural.track(tracks.length)} · ${fmtLong(totalDuration)}${this.app.activePlaylistMissing ? ` · ${plural.track(this.app.activePlaylistMissing)} недоступно` : ''}`;
      return;
    }

    if (this.sourceFilter) {
      eyebrow.textContent = 'Источник';
      title.textContent = this._sourceFilterName || 'Источник';
      meta.textContent = `${plural.track(tracks.length)} · ${fmtLong(totalDuration)} · ${fmtSize(totalSize)}`;
      return;
    }

    if (this.inGroup) {
      const first = tracks[0];
      const isAlbum = !!this.albumFilter;
      eyebrow.textContent = isAlbum ? 'Альбом' : 'Исполнитель';
      title.textContent = isAlbum
        ? (first?.album || 'Без альбома')
        : (first?.artist || 'Неизвестный исполнитель');
      const bits = [];
      if (isAlbum && (first?.albumArtist || first?.artist)) bits.push(first.albumArtist || first.artist);
      if (first?.year) bits.push(String(first.year));
      bits.push(plural.track(tracks.length), fmtLong(totalDuration));
      if (tracks.some((t) => t.lossless)) bits.push('без потерь');
      meta.textContent = bits.join('  ·  ');
      return;
    }

    const labels = {
      tracks: ['Библиотека', 'Все треки'],
      albums: ['Коллекция', 'Альбомы'],
      artists: ['Коллекция', 'Исполнители'],
      favorites: ['Отборное', 'Избранное']
    };
    const subs = {
      tracks: () => {
        const ext = new Set(tracks.map((t) => t.ext.replace('.', '').toUpperCase()));
        const lossless = tracks.filter((t) => t.lossless).length;
        const parts = [plural.track(tracks.length), fmtLong(totalDuration), fmtSize(totalSize)];
        if (ext.size) parts.push(Array.from(ext).sort().join(' · '));
        if (lossless) parts.push(`${lossless} без потерь`);
        return parts.join('  ·  ');
      },
      albums: () => `${plural.album(this.groups().length)} · ${plural.track(tracks.length)} · ${fmtLong(totalDuration)}`,
      artists: () => `${plural.artist(this.groups().length)} · ${plural.track(tracks.length)} · ${fmtLong(totalDuration)}`,
      favorites: () => `${plural.track(tracks.length)} · ${fmtLong(totalDuration)}`
    };
    eyebrow.textContent = labels[this.view][0];
    title.textContent = labels[this.view][1];
    meta.textContent = subs[this.view]?.() || '';
  }

  _renderTable() {
    const head = this.nodes.tracksHead;
    const arrow = `<span data-icon style="margin-left:6px;opacity:.7">${icon(this.order === 'asc' ? 'arrow-up' : 'arrow-down')}</span>`;
    head.innerHTML = `
      <span></span>
      <span></span>
      <button data-sort="title">Название${this.sort === 'title' ? arrow : ''}</button>
      <button data-sort="artist">Исполнитель${this.sort === 'artist' ? arrow : ''}</button>
      <button data-sort="album" class="col-album">Альбом${this.sort === 'album' ? arrow : ''}</button>
      <button data-sort="year" class="col-year">Год${this.sort === 'year' ? arrow : ''}</button>
      <button data-sort="duration" style="text-align:right;display:block">Время${this.sort === 'duration' ? arrow : ''}</button>
      <span></span>`;

    const tracks = this.visibleTracks();
    const list = this.nodes.tracks;

    if (!tracks.length) {
      list.innerHTML = '';
      list.append(this._emptyState());
      return;
    }

    if (!this.albumFilter && !this.artistFilter && (this.view === 'tracks' || this.view === 'favorites') && this.sort === 'artist' && !this.search) {
      this._renderGroupedTable(tracks);
      return;
    }

    const fragment = document.createDocumentFragment();
    tracks.forEach((track, i) => fragment.append(this._row(track, i, Math.min(i, 14) * 18)));
    list.innerHTML = '';
    list.append(fragment);
    this._paintSelection();
  }

  /** Сгруппированный по исполнителям список с «шапками» — как в каталоге. */
  _renderGroupedTable(tracks) {
    const groups = new Map();
    for (const track of tracks) {
      const key = track.albumArtist || track.artist || '—';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    }
    const list = this.nodes.tracks;
    list.innerHTML = '';
    let index = 0;
    for (const [artist, items] of groups) {
      const header = el('div', { class: 'grouphead reveal' }, [
        el('span', { class: 'grouphead__name', text: artist }),
        el('span', { class: 'grouphead__meta', text: `${plural.track(items.length)} · ${fmtLong(items.reduce((s, t) => s + (t.duration || 0), 0))}` }),
        el('button', {
          class: 'grouphead__play btn btn--quiet',
          html: `${icon('play')}<span>Играть</span>`,
          onclick: (event) => {
            event.stopPropagation();
            this.app.player.playTracks(items, 0, { type: 'artist', name: artist, id: artist });
          }
        })
      ]);
      list.append(header);
      for (const track of items) {
        list.append(this._row(track, index, 0, { hideArtist: true }));
        index += 1;
      }
    }
    this._paintSelection();
  }

  _row(track, index, delay = 0, opts = {}) {
    const isCurrent = this.app.player.current?.id === track.id;
    const row = el('div', {
      class: `track${isCurrent ? ' is-current' : ''}${this.app.player.playing && isCurrent ? ' is-playing' : ''}`,
      role: 'listitem',
      'data-id': track.id,
      'data-index': String(index),
      tabindex: '0',
      style: delay ? { '--d': `${delay}ms` } : {}
    });

    const idx = el('div', { class: 'track__idx' }, [
      isCurrent && this.app.player.playing
        ? el('span', { class: 'eq', html: '<i></i><i></i><i></i><i></i>' })
        : el('span', { class: 'track__num', text: String(index + 1) }),
      el('span', { class: 'track__play', html: icon('play') })
    ]);

    const art = el('div', { class: 'track__art' });
    this._artInto(art, track);

    const subParts = [];
    if (!opts.hideArtist && track.artist) subParts.push(el('em', { text: track.artist }));
    if (!opts.hideArtist && !track.artist) subParts.push(el('em', { text: 'Неизвестный исполнитель' }));
    if (track.album) {
      if (subParts.length) subParts.push(el('i', { class: 'dot' }));
      subParts.push(el('em', { text: track.album }));
    }
    if (!track.playable) subParts.push(el('span', { class: 'badge badge--warn', text: 'нет кодека' }));

    const main = el('div', { class: 'track__main' }, [
      el('span', { class: 'track__title', text: track.title || track.name, title: track.name }),
      el('div', { class: 'track__sub' }, subParts)
    ]);

    const actions = el('div', { class: 'track__actions' }, [
      el('button', {
        class: `iconbtn track__fav${track.favorite ? ' is-on' : ''}`,
        html: icon('heart'),
        title: 'В избранное',
        'data-act': 'fav'
      }),
      el('button', { class: 'iconbtn', html: icon('plus'), title: 'В очередь', 'data-act': 'queue' }),
      el('button', { class: 'iconbtn', html: icon('menu'), title: 'Действия', 'data-act': 'menu' })
    ]);

    row.append(
      idx,
      art,
      main,
      el('div', { class: 'track__cell col-artist', text: opts.hideArtist ? '' : (track.artist || '—'), title: track.artist }),
      el('div', { class: 'track__cell col-album', text: track.album || '—', title: track.album }),
      el('div', { class: 'track__cell col-year mono', text: track.year ? String(track.year) : '—' }),
      el('div', { class: 'track__num-cell', text: fmtTime(track.duration) }),
      actions
    );

    if (track.lossless) {
      row.querySelector('.col-year')?.classList.add('has-badge');
    }
    return row;
  }

  _artInto(node, track) {
    // kind по умолчанию: сервер сам решает — встроенная обложка или из папки.
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
    img.src = artUrl(track);
    img.addEventListener('error', () => {
      img.remove();
      if (!$('.artfallback', node)) node.append(this._fallback(track));
    });
    img.addEventListener('load', () => {
      node.querySelector('.artfallback')?.remove();
    });
    node.append(this._fallback(track), img);
  }

  _fallback(track) {
    const { from, to } = artGradient(track);
    const span = el('span', { class: 'artfallback' });
    span.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    span.textContent = initialsOf(track);
    return span;
  }

  _renderCards(token) {
    const groups = this.groups();
    const host = this.nodes.cards;
    host.innerHTML = '';
    if (!groups.length) {
      host.append(this._emptyState());
      return;
    }
    const fragment = document.createDocumentFragment();
    groups.forEach((group, i) => {
      if (token !== this.renderToken) return;
      fragment.append(this._card(group, Math.min(i, 18) * 22));
    });
    host.append(fragment);
  }

  _card(group, delay) {
    const track = group.coverTrack;
    const round = this.view === 'artists';
    const card = el('div', {
      class: `card${round ? ' card--round' : ''}`,
      tabindex: '0',
      role: 'button',
      'data-key': group.key,
      style: delay ? { '--d': `${delay}ms` } : {},
      title: group.name
    });

    const art = el('div', { class: 'card__art' });
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', src: artUrl(track) });
    img.addEventListener('error', () => {
      img.src = fallbackArt(round ? { artist: group.name } : { album: group.name, artist: group.sub });
    });
    art.append(img, el('span', { class: 'card__play', html: icon('play') }));

    card.append(art, el('div', { class: 'card__title', text: group.name }));
    const sub = round
      ? `${plural.album(new Set(group.tracks.map((t) => t.album)).size)} · ${plural.track(group.tracks.length)}`
      : `${group.sub || 'Неизвестный исполнитель'} · ${group.year || '—'} · ${plural.track(group.tracks.length)}`;
    card.append(el('div', { class: 'card__sub', text: sub }));
    return card;
  }

  _emptyState() {
    const hasSources = this.app.sources.length > 0;
    const hasTracks = this.app.tracks.length > 0;
    let title = 'Библиотека пуста';
    let text = 'Подключите папку с музыкой или добавьте отдельные файлы — они останутся на диске, плеер только читает их.';
    let actions;

    if (this.search) {
      title = 'Ничего не найдено';
      text = `По запросу «${this.search}» в библиотеке нет совпадений. Попробуйте другое слово или очистите поиск.`;
    } else if (hasSources && !hasTracks) {
      title = 'В источниках нет музыки';
      text = 'Плеер не нашёл аудиофайлов в подключённых папках.';
    } else if (this.view === 'favorites') {
      title = 'Избранное пусто';
      text = 'Отмечайте треки сердечком — они соберутся здесь.';
    } else if (this.inGroup || this.sourceFilter) {
      title = 'В этом разделе пусто';
      text = 'Здесь пока нет треков.';
    }

    if (!this.search) {
      actions = el('div', { class: 'empty__actions' }, [
        !hasTracks ? el('button', {
          class: 'btn btn--solid',
          html: `${icon('folder-plus')}<span>Добавить папку</span>`,
          onclick: () => this.app.openFolderBrowser()
        }) : null,
        !hasTracks ? el('button', {
          class: 'btn',
          html: `${icon('file-plus')}<span>Добавить файлы</span>`,
          onclick: () => this.app.pickFiles()
        }) : null,
        hasSources ? el('button', {
          class: 'btn',
          html: `${icon('refresh')}<span>Пересканировать</span>`,
          onclick: () => this.app.scan()
        }) : null
      ]);
    }

    return el('div', { class: 'empty' }, [
      el('span', { class: 'empty__icon', html: icon(this.search ? 'search' : 'library') }),
      el('h3', { text: title }),
      el('p', { text }),
      actions
    ]);
  }

  // ------------------------------------------------------------ взаимодействие

  _trackFromEvent(event) {
    const row = event.target.closest('.track[data-id]');
    if (!row) return null;
    return this.app.tracks.find((t) => t.id === row.dataset.id) || null;
  }

  _onTrackClick(event) {
    const row = event.target.closest('.track[data-id]');
    if (!row) return;
    const track = this.app.tracks.find((t) => t.id === row.dataset.id);
    if (!track) return;

    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'fav') return this.app.toggleFavorite(track);
    if (act === 'queue') {
      this.app.player.addToQueue([track], { next: event.altKey });
      toast({ title: event.altKey ? 'Играет следующим' : 'Добавлено в очередь', text: track.title, kind: 'ok', timeout: 2200 });
      return;
    }
    if (act === 'menu') return this._openMenu(event, track);

    if (event.shiftKey && this.lastClicked) {
      const list = Array.from(this.nodes.tracks.querySelectorAll('.track[data-id]'));
      const ids = list.map((r) => r.dataset.id);
      const from = ids.indexOf(this.lastClicked);
      const to = ids.indexOf(track.id);
      const [a, b] = from < to ? [from, to] : [to, from];
      for (let i = a; i <= b; i += 1) this.selection.add(ids[i]);
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selection.has(track.id)) this.selection.delete(track.id);
      else this.selection.add(track.id);
      this.lastClicked = track.id;
    } else {
      if (event.target.closest('.track__play')) {
        this.app.player.playTracks(this.playContextList(), this._indexInContext(track), this.playContext());
        return;
      }
      this.selection.clear();
      this.selection.add(track.id);
      this.lastClicked = track.id;
    }
    this._paintSelection();
  }

  _onTrackDblClick(event) {
    const track = this._trackFromEvent(event);
    if (!track) return;
    if (event.target.closest('.track__actions')) return;
    const list = this.playContextList();
    this.app.player.playTracks(list, this._indexInContext(track), this.playContext());
  }

  _onTrackContext(event) {
    const track = this._trackFromEvent(event);
    if (!track) return;
    event.preventDefault();
    if (!this.selection.has(track.id)) {
      this.selection.clear();
      this.selection.add(track.id);
      this._paintSelection();
    }
    this._openMenu(event, track);
  }

  _onCardContext(event) {
    const card = event.target.closest('.card[data-key]');
    if (!card) return;
    const group = this.groups().find((g) => g.key === card.dataset.key);
    if (!group) return;
    event.preventDefault();
    openMenu([
      { header: group.name },
      { label: 'Играть всё', icon: 'play', onClick: () => this.app.player.playTracks(group.tracks, 0, this.playContext()) },
      { label: 'В очередь', icon: 'plus', onClick: () => this.app.player.addToQueue(group.tracks) },
      { label: 'Следующим', icon: 'chevron-right', onClick: () => this.app.player.addToQueue(group.tracks, { next: true }) },
      { separator: true },
      { label: 'В плейлист…', icon: 'list-music', onClick: () => PlaylistPicker.open(this.app, group.tracks) },
      { label: 'В избранное', icon: 'heart', onClick: () => group.tracks.forEach((t) => !t.favorite && this.app.toggleFavorite(t)) }
    ], { x: event.clientX, y: event.clientY });
  }

  _onCardClick(event) {
    const card = event.target.closest('.card[data-key]');
    if (!card) return;
    const group = this.groups().find((g) => g.key === card.dataset.key);
    if (!group) return;
    if (event.target.closest('.card__play')) {
      this.app.player.playTracks(group.tracks, 0, {
        type: this.view === 'albums' ? 'album' : 'artist',
        name: group.name,
        id: group.key
      });
      return;
    }
    // Клик по карточке — вход внутрь альбома или исполнителя
    if (this.view === 'albums') this.app.setView('tracks', { albumFilter: group.key });
    else this.app.setView('tracks', { artistFilter: group.key });
  }

  /** Список, в контексте которого запускается воспроизведение. */
  playContextList() {
    return this.visibleTracks();
  }

  _indexInContext(track) {
    return Math.max(0, this.playContextList().findIndex((t) => t.id === track.id));
  }

  playContext() {
    if (this.app.activePlaylistId) {
      const pl = this.app.playlists.find((p) => p.id === this.app.activePlaylistId);
      return { type: 'playlist', id: this.app.activePlaylistId, name: pl?.name || 'Плейлист' };
    }
    if (this.sourceFilter) {
      return { type: 'source', id: this.sourceFilter, name: this._sourceFilterName || 'Источник' };
    }
    if (this.inGroup) {
      const first = this.visibleTracks()[0];
      return this.albumFilter
        ? { type: 'album', id: this.albumFilter, name: first?.album || 'Альбом' }
        : { type: 'artist', id: this.artistFilter, name: first?.artist || 'Исполнитель' };
    }
    if (this.sourceFilter) {
      return { type: 'source', id: this.sourceFilter, name: this._sourceFilterName || 'Источник' };
    }
    const names = { tracks: 'Все треки', albums: 'Альбомы', artists: 'Исполнители', favorites: 'Избранное' };
    return { type: this.view, id: null, name: names[this.view] || 'Библиотека' };
  }

  _paintSelection() {
    const rows = this.nodes.tracks.querySelectorAll('.track[data-id]');
    rows.forEach((row) => row.classList.toggle('is-selected', this.selection.has(row.dataset.id)));
  }

  selectedTracks() {
    return this.app.tracks.filter((t) => this.selection.has(t.id));
  }

  _openMenu(event, track) {
    const selected = this.selection.size > 1 ? this.selectedTracks() : [track];
    const many = selected.length > 1;
    openMenu([
      { header: many ? `Выбрано: ${plural.track(selected.length)}` : track.title },
      { label: 'Играть', icon: 'play', onClick: () => this.app.player.playTracks(selected, 0, this.playContext()) },
      { label: 'Играть следующим', icon: 'chevron-right', onClick: () => this.app.player.addToQueue(selected, { next: true }) },
      { label: 'В очередь', icon: 'plus', onClick: () => this.app.player.addToQueue(selected) },
      { separator: true },
      { label: 'В плейлист…', icon: 'list-music', onClick: () => PlaylistPicker.open(this.app, selected) },
      {
        label: many ? 'Добавить в избранное' : (track.favorite ? 'Убрать из избранного' : 'В избранное'),
        icon: 'heart',
        onClick: () => {
          if (many) {
            for (const t of selected) if (!t.favorite) this.app.toggleFavorite(t);
          } else {
            this.app.toggleFavorite(track);
          }
        }
      },
      { separator: true },
      { label: 'Редактировать теги', icon: 'tag', onClick: () => openTagEditor(this.app, track) },
      { label: 'Свойства трека', icon: 'info', onClick: () => openTrackInfo(this.app, track) },
      { separator: true },
      { label: 'Показать в проводнике', icon: 'external', onClick: () => api.reveal(track.id).catch(() => toast({ title: 'Не удалось открыть проводник', kind: 'warn' })) },
      { label: 'Скопировать путь', icon: 'copy', onClick: () => navigator.clipboard?.writeText(track.path).then(() => toast({ title: 'Путь скопирован', kind: 'ok', timeout: 2000 })).catch(() => {}) },
      { label: 'Убрать из библиотеки', icon: 'trash', danger: true, onClick: () => this.app.removeTracks(selected) }
    ], { x: event.clientX, y: event.clientY });
  }

  /** Обновление одной строки без полного перерендера (переключение трека). */
  refreshPlaying({ previousId } = {}) {
    const current = this.app.player.current;
    const ids = new Set([current?.id, previousId].filter(Boolean));
    for (const id of ids) {
      const row = this.nodes.tracks.querySelector(`.track[data-id="${id}"]`);
      if (!row) continue;
      const isCurrent = current?.id === id;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && this.app.player.playing);
      const idx = row.querySelector('.track__idx');
      if (!idx) continue;
      if (isCurrent && this.app.player.playing) {
        if (!idx.querySelector('.eq')) {
          idx.querySelector('.track__num')?.remove();
          idx.insertAdjacentHTML('afterbegin', '<span class="eq"><i></i><i></i><i></i><i></i></span>');
          idx.querySelector('.track__play')?.remove();
        }
      } else if (idx.querySelector('.eq')) {
        idx.querySelector('.eq')?.remove();
        if (!idx.querySelector('.track__num')) {
          idx.insertAdjacentHTML('afterbegin', `<span class="track__num">${Number(row.dataset.index) + 1}</span>`);
        }
        if (!idx.querySelector('.track__play')) {
          idx.insertAdjacentHTML('beforeend', `<span class="track__play">${icon('play')}</span>`);
        }
      }
    }
    for (const row of this.nodes.tracks.querySelectorAll('.track.is-current')) {
      if (row.dataset.id !== current?.id) {
        row.classList.remove('is-current', 'is-playing');
      }
    }
  }
}

function artGradient(track) {
  let hash = 0;
  const str = String(track?.album || track?.artist || track?.title || '');
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 100000;
  const hue = (hash * 47) % 360;
  return {
    from: `hsl(${hue} 32% 34%)`,
    to: `hsl(${(hue + 40) % 360} 30% 18%)`
  };
}

function initialsOf(track) {
  const base = String(track?.artist || track?.album || track?.title || '♪').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const words = base.split(/\s+/).filter(Boolean);
  if (!words.length) return '♪';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}