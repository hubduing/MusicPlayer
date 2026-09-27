/* ============================================================================
   Редактор тегов, свойства трека, выбор плейлиста.
   ========================================================================= */
import { $, el, fmtSize, fmtTime, plural, artUrl, fallbackArt, escapeHtml, stripExt } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, openModal, confirmDialog } from './ui.js';
import { api } from './api.js';

// ------------------------------------------------------------------ теги

export function openTagEditor(app, track, { onSaved } = {}) {
  const draft = {
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    albumArtist: track.albumArtist || '',
    year: track.year ?? '',
    trackNo: track.trackNo ?? '',
    discNo: track.discNo ?? '',
    genre: track.genre || '',
    comment: track.comment || '',
    composer: track.composer || ''
  };
  let coverDraft = null; // { data: dataUrl }

  const input = (key, label, opts = {}) => {
    const field = el('div', { class: `fld${opts.span2 ? ' span2' : ''}` }, [
      el('label', { text: label, for: `fld-${key}` })
    ]);
    const node = el('input', {
      id: `fld-${key}`,
      type: opts.type || 'text',
      value: draft[key] === '' ? '' : String(draft[key]),
      placeholder: opts.placeholder || '',
      maxlength: opts.maxlength || '200',
      inputmode: opts.inputmode
    });
    node.addEventListener('input', () => {
      draft[key] = node.value;
      preview();
    });
    field.append(node);
    return field;
  };

  const artBox = el('div', { class: 'coverbox__art' });
  const artImg = el('img', { alt: '', src: artUrl(track) });
  artImg.addEventListener('error', () => {
    artImg.src = fallbackArt(track, 480);
  });
  artBox.append(artImg);

  const coverHint = el('div', { class: 'coverbox__hint', text: 'Перетащите картинку сюда или выберите файл' });

  const chooseBtn = el('button', { class: 'btn', html: `${icon('upload')}<span>Выбрать</span>` });
  const resetBtn = el('button', { class: 'btn', html: `${icon('refresh')}<span>Сброс</span>`, title: 'Вернуть исходную обложку' });

  chooseBtn.addEventListener('click', () => {
    const fileInput = $('#cover-input');
    fileInput.value = '';
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      if (file) readCover(file);
    };
    fileInput.click();
  });

  resetBtn.addEventListener('click', () => {
    coverDraft = null;
    delete draft.cover;
    artImg.src = artUrl(track);
    toast({ title: 'Обложка вернётся к исходной', kind: 'info', timeout: 2200 });
  });

  function readCover(file) {
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Это не картинка', kind: 'warn' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast({ title: 'Картинка больше 8 МБ', text: 'Выберите файл поменьше', kind: 'warn' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      coverDraft = { data: String(reader.result) };
      draft.cover = coverDraft;
      artImg.src = String(reader.result);
      toast({ title: 'Обложка готова к сохранению', kind: 'ok', timeout: 2000 });
    };
    reader.readAsDataURL(file);
  }

  ['dragenter', 'dragover'].forEach((type) => artBox.addEventListener(type, (event) => {
    event.preventDefault();
    artBox.parentElement.classList.add('is-drop');
  }));
  ['dragleave', 'drop'].forEach((type) => artBox.addEventListener(type, (event) => {
    event.preventDefault();
    artBox.parentElement.classList.remove('is-drop');
  }));
  artBox.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) readCover(file);
  });

  const previewRow = el('div', { class: 'editor-preview' });
  function preview() {
    previewRow.innerHTML = '';
    previewRow.append(
      el('span', { class: 'editor-preview__art' }),
      el('div', {}, [
        el('div', { class: 'editor-preview__title', text: draft.title || stripExt(track.name) }),
        el('div', { class: 'editor-preview__sub', text: [draft.artist || 'Неизвестный исполнитель', draft.album].filter(Boolean).join(' — ') })
      ])
    );
    const art = previewRow.querySelector('.editor-preview__art');
    const img = el('img', { alt: '', src: artImg.src });
    art.append(img);
  }

  const form = el('div', { class: 'formgrid' }, [
    input('title', 'Название', { span2: true }),
    input('artist', 'Исполнитель'),
    input('albumArtist', 'Исполнитель альбома'),
    input('album', 'Альбом'),
    input('genre', 'Жанр'),
    input('year', 'Год', { inputmode: 'numeric', maxlength: '4' }),
    input('trackNo', 'Номер трека', { inputmode: 'numeric', maxlength: '4' }),
    input('discNo', 'Номер диска', { inputmode: 'numeric', maxlength: '4' }),
    input('composer', 'Композитор'),
    el('div', { class: 'fld span2' }, [
      el('label', { text: 'Комментарий', for: 'fld-comment' }),
      (() => {
        const area = el('textarea', { id: 'fld-comment', maxlength: '500' });
        area.value = draft.comment;
        area.addEventListener('input', () => {
          draft.comment = area.value;
        });
        return area;
      })()
    ])
  ]);

  const hint = el('div', { class: 'fld__hint' });
  if (!track.canWriteTags && !/\.(mp3|mp2)$/i.test(track.path)) {
    hint.classList.add('is-warn');
    hint.textContent = `Теги ${track.ext.replace('.', '').toUpperCase()} сохранятся только в библиотеке плеера — запись в этот формат пока не поддерживается.`;
  } else {
    hint.textContent = 'Перед первой правкой рядом с файлом создаётся резервная копия .bak.';
  }

  const body = el('div', { class: 'editor' }, [
    el('div', { class: 'coverbox' }, [
      artBox,
      coverHint,
      el('div', { class: 'coverbox__actions' }, [chooseBtn, resetBtn]),
      el('div', { class: 'coverbox__note', text: 'Обложка сохраняется внутрь файла (ID3 APIC).' })
    ]),
    el('div', {}, [form, hint, el('div', { class: 'editor-divider' }), previewRow])
  ]);

  const cancel = el('button', { class: 'btn', text: 'Отмена' });
  const save = el('button', { class: 'btn btn--solid', html: `${icon('save')}<span>Сохранить</span>` });

  const dialog = openModal({
    title: 'Теги трека',
    subtitle: track.name,
    body,
    width: 'modal--wide',
    footer: [
      el('div', { class: 'spacer' }),
      cancel,
      save
    ],
    onMount: () => preview(),
    onClose: () => onSaved?.(false)
  });

  cancel.addEventListener('click', () => dialog.close());

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const payload = { ...draft, writeFile: true };
      for (const key of ['year', 'trackNo', 'discNo']) {
        payload[key] = payload[key] === '' ? null : Number(payload[key]);
      }
      const result = await api.updateTrack(track.id, payload);
      const written = result.file?.written;
      if (written) {
        toast({ title: 'Теги сохранены в файл', text: track.name, kind: 'ok' });
      } else {
        toast({
          title: 'Сохранено в библиотеке',
          text: result.file?.reason || 'Файл не изменён',
          kind: 'warn',
          timeout: 6000
        });
      }
      const idx = app.tracks.findIndex((t) => t.id === track.id);
      if (idx >= 0 && result.track) app.tracks[idx] = { ...app.tracks[idx], ...result.track };
      app.notifyLibraryChanged();
      dialog.close();
      onSaved?.(true);
    } catch (err) {
      toast({ title: 'Не удалось сохранить', text: err.message, kind: 'err', timeout: 6000 });
      save.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ свойства

export function openTrackInfo(app, track) {
  const rows = [
    ['Файл', track.name],
    ['Путь', track.path],
    ['Формат', `${track.ext.replace('.', '').toUpperCase()} · ${track.codec || '—'}`],
    ['Битрейт', track.bitrate ? `${track.bitrate} кбит/с` : '—'],
    ['Частота дискретизации', track.sampleRate ? `${track.sampleRate} Гц` : '—'],
    ['Разрядность', track.bitsPerSample ? `${track.bitsPerSample} бит` : '—'],
    ['Каналы', track.channels ? (track.channels === 1 ? 'моно' : track.channels === 2 ? 'стерео' : `${track.channels} канала`) : '—'],
    ['Длительность', fmtTime(track.duration)],
    ['Размер', fmtSize(track.size)],
    ['Без потерь', track.lossless ? 'да' : 'нет'],
    ['Источник', track.sourceName || '—'],
    ['Добавлен', track.addedAt ? new Date(track.addedAt).toLocaleString('ru-RU') : '—'],
    ['Идентификатор', track.id]
  ];

  const table = el('table', { class: 'meta-table' });
  for (const [label, value] of rows) {
    table.append(el('tr', {}, [
      el('td', { text: label }),
      el('td', { text: String(value), style: { wordBreak: 'break-all' } })
    ]));
  }

  const copyBtn = el('button', { class: 'btn', html: `${icon('copy')}<span>Скопировать путь</span>` });
  const revealBtn = el('button', { class: 'btn', html: `${icon('external')}<span>Показать в проводнике</span>` });
  const editBtn = el('button', { class: 'btn btn--solid', html: `${icon('tag')}<span>Теги</span>` });

  const dialog = openModal({
    title: 'Свойства трека',
    subtitle: `${track.artist ? `${track.artist} — ` : ''}${track.title}`,
    body: el('div', {}, [
      el('div', { class: 'info-head' }, [
        (() => {
          const img = el('img', { alt: '', src: artUrl(track) });
          img.addEventListener('error', () => {
            img.src = fallbackArt(track, 240);
          });
          return img;
        })(),
        el('div', {}, [
          el('div', { class: 'info-head__title', text: track.title || track.name }),
          el('div', { class: 'info-head__sub', text: [track.artist, track.album, track.year].filter(Boolean).join(' · ') || 'Без тегов' }),
          track.favorite ? el('span', { class: 'badge badge--accent', text: 'в избранном' }) : null
        ])
      ]),
      table
    ]),
    footer: [copyBtn, revealBtn, el('div', { class: 'spacer' }), editBtn],
    width: ''
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(track.path)
      .then(() => toast({ title: 'Путь скопирован', kind: 'ok', timeout: 2000 }))
      .catch(() => toast({ title: 'Буфер обмена недоступен', kind: 'warn' }));
  });
  revealBtn.addEventListener('click', () => {
    api.reveal(track.id).catch(() => toast({ title: 'Не удалось открыть проводник', kind: 'warn' }));
  });
  editBtn.addEventListener('click', () => {
    dialog.close();
    openTagEditor(app, track);
  });
}

// ------------------------------------------------------------------ плейлисты

export const PlaylistPicker = {
  open(app, tracks) {
    const list = el('div', { class: 'picker' });
    const nameInput = el('input', { type: 'text', placeholder: 'Название нового плейлиста', maxlength: '120' });
    const createBtn = el('button', { class: 'btn btn--solid', html: `${icon('plus')}<span>Создать</span>` });

    const dialog = openModal({
      title: 'В плейлист',
      subtitle: tracks.length === 1 ? tracks[0].title : `${plural.track(tracks.length)}`,
      width: 'modal--narrow',
      body: el('div', {}, [
        list,
        el('div', { class: 'picker__new' }, [nameInput, createBtn])
      ]),
      footer: [el('div', { class: 'spacer' }), (() => {
        const close = el('button', { class: 'btn', text: 'Готово' });
        close.addEventListener('click', () => dialog.close());
        return close;
      })()]
    });

    const render = () => {
      list.innerHTML = '';
      if (!app.playlists.length) {
        list.append(el('div', { class: 'sidebar__empty', text: 'Плейлистов пока нет — создайте первый ниже.' }));
      }
      for (const pl of app.playlists) {
        const row = el('button', { class: 'picker__row' }, [
          el('span', { class: 'picker__icon', html: icon('list-music') }),
          el('span', { class: 'picker__name', text: pl.name }),
          el('span', { class: 'picker__count mono', text: `${pl.count}` })
        ]);
        row.addEventListener('click', async () => {
          try {
            await api.updatePlaylist(pl.id, { add: tracks.map((t) => t.id) });
            await app.refreshPlaylists();
            toast({ title: 'Добавлено в плейлист', text: `${pl.name} · ${plural.track(tracks.length)}`, kind: 'ok' });
            dialog.close();
          } catch (err) {
            toast({ title: 'Не удалось добавить', text: err.message, kind: 'err' });
          }
        });
        list.append(row);
      }
    };
    render();

    const create = async () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      try {
        await api.createPlaylist(name, tracks.map((t) => t.id));
        await app.refreshPlaylists();
        toast({ title: 'Плейлист создан', text: `${name} · ${plural.track(tracks.length)}`, kind: 'ok' });
        dialog.close();
      } catch (err) {
        toast({ title: 'Не удалось создать', text: err.message, kind: 'err' });
      }
    };
    createBtn.addEventListener('click', create);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') create();
    });
  }
};

/** Диалог подтверждения удаления плейлиста. */
export async function confirmDeletePlaylist(app, playlist) {
  const ok = await confirmDialog({
    title: 'Удалить плейлист?',
    message: `«${playlist.name}» будет удалён. Сами файлы на диске останутся нетронутыми.`,
    confirmLabel: 'Удалить плейлист'
  });
  if (!ok) return false;
  try {
    await api.deletePlaylist(playlist.id);
    if (app.activePlaylistId === playlist.id) app.setView('tracks');
    await app.refreshPlaylists();
    toast({ title: 'Плейлист удалён', kind: 'ok' });
    return true;
  } catch (err) {
    toast({ title: 'Не удалось удалить', text: err.message, kind: 'err' });
    return false;
  }
}

export { escapeHtml, hydrateIcons };