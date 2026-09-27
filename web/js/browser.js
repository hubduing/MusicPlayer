/* ============================================================================
   Обзор диска: выбор папки с музыкой или отдельных файлов.
   Работает без интернета и без нативных диалогов — просто читает диск.
   ========================================================================= */
import { $, el, fmtSize, plural } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, openModal } from './ui.js';
import { api } from './api.js';

export function openFolderBrowser(app) {
  let cwd = null;
  let listing = null;
  let selectedFiles = new Set();
  let busy = false;

  const quick = el('div', { class: 'browser__quick' });
  const crumbs = el('div', { class: 'browser__crumbs' }, [el('span', { text: 'Мой компьютер' })]);
  const pathInput = el('input', { type: 'text', placeholder: 'Вставьте путь, например D:\\Music', spellcheck: 'false' });
  const openBtn = el('button', { class: 'btn', html: `${icon('chevron-right')}<span>Перейти</span>` });
  const list = el('div', { class: 'browser__list' });
  const picked = el('div', { class: 'browser__picked' });

  const addFolderBtn = el('button', { class: 'btn btn--solid', html: `${icon('folder-plus')}<span>Добавить папку</span>` });
  const addFilesBtn = el('button', { class: 'btn', html: `${icon('file-plus')}<span>Добавить файлы</span>` });
  const nativeBtn = el('button', { class: 'btn btn--quiet', html: `${icon('sparkle')}<span>Системный диалог</span>` });

  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go(pathInput.value.trim());
  });
  openBtn.addEventListener('click', () => go(pathInput.value.trim()));

  function go(path) {
    if (!path) return;
    load(path.replace(/^"|"$/g, ''));
  }

  async function load(path) {
    if (busy) return;
    busy = true;
    list.innerHTML = '';
    list.append(el('div', { class: 'browser__loading' }, [el('span', { class: 'spinner' }), el('span', { text: 'Читаю папку…' })]));
    try {
      const data = await api.browse(path || null);
      listing = data;
      cwd = data.path || null;
      selectedFiles = new Set();
      renderQuick(data);
      renderCrumbs(data);
      renderList(data);
      pathInput.value = cwd || '';
      updateButtons();
    } catch (err) {
      listing = null;
      list.innerHTML = '';
      list.append(el('div', { class: 'browser__error' }, [
        el('span', { html: icon('alert') }),
        el('div', {}, [
          el('strong', { text: 'Не удалось открыть папку' }),
          el('div', { class: 'browser__error-text', text: err.message })
        ])
      ]));
      if (!path) renderQuick(null);
      updateButtons();
    } finally {
      busy = false;
    }
  }

  function renderQuick(data) {
    quick.innerHTML = '';
    const items = [];
    if (data?.roots) items.push(...data.roots.map((r) => ({ ...r, kind: r.kind || 'drive' })));
    if (data?.sources) items.push(...data.sources.map((s) => ({ ...s, kind: s.kind, existing: true })));
    if (!data?.roots) {
      // первичная загрузка не удалась — оставляем подсказку
      quick.append(el('span', { class: 'browser__hint', text: 'Введите путь вручную' }));
      return;
    }
    for (const item of items) {
      const chip = el('button', {
        class: `chip${item.existing ? ' is-on' : ''}`,
        html: `${icon(item.kind === 'file' ? 'file-audio' : item.kind === 'drive' ? 'drive' : 'folder')}<span>${item.label || item.path}</span>`
      });
      chip.title = item.path;
      chip.addEventListener('click', () => load(item.path));
      quick.append(chip);
    }
  }

  function renderCrumbs(data) {
    crumbs.innerHTML = '';
    const parts = [];
    if (data?.path) {
      const segments = data.path.split(/[\\/]/).filter(Boolean);
      let acc = '';
      for (const segment of segments) {
        acc = acc ? `${acc}\\${segment}` : (/^[A-Za-z]:$/.test(segment) ? `${segment}\\` : segment);
        parts.push({ label: segment, path: acc });
      }
    }
    const home = el('button', { class: 'crumb', html: icon('drive'), title: 'Мой компьютер' });
    home.addEventListener('click', () => load(null));
    crumbs.append(home);
    parts.forEach((part, i) => {
      crumbs.append(el('span', { class: 'crumb__sep', html: icon('chevron-right') }));
      const btn = el('button', { class: `crumb${i === parts.length - 1 ? ' is-last' : ''}`, text: part.label });
      btn.addEventListener('click', () => load(part.path));
      crumbs.append(btn);
    });
    if (!parts.length) crumbs.append(el('span', { class: 'crumb is-last', text: 'Выберите диск или папку' }));
  }

  function renderList(data) {
    list.innerHTML = '';
    if (!data?.path) {
      const roots = data?.roots || [];
      for (const root of roots) {
        list.append(row({ name: root.label, path: root.path, isDir: true, icon: root.kind === 'drive' ? 'drive' : 'folder' }));
      }
      if (!roots.length) list.append(el('div', { class: 'browser__hint', text: 'Диски не найдены — введите путь вручную.' }));
      return;
    }

    if (data.parent) {
      const up = row({ name: 'Наверх', path: data.parent, isDir: true, icon: 'chevron-up', isUp: true });
      list.append(up);
    }

    if (data.dirs.length) {
      list.append(el('div', { class: 'browser__sep', text: 'Папки' }));
      for (const dir of data.dirs) {
        list.append(row({
          name: dir.name,
          path: dir.path,
          isDir: true,
          icon: 'folder',
          meta: dir.audioCount ? `${dir.audioCount} аудио` : ''
        }));
      }
    }

    if (data.files.length) {
      list.append(el('div', { class: 'browser__sep', text: `Аудиофайлы · ${data.files.length}` }));
      for (const file of data.files) {
        list.append(row({ name: file.name, path: file.path, isDir: false, icon: 'file-audio', meta: fmtSize(file.size) }));
      }
    }

    if (!data.dirs.length && !data.files.length) {
      list.append(el('div', { class: 'browser__hint', text: 'В этой папке нет ни подпапок, ни аудиофайлов. Можно добавить её целиком — плеер поищет музыку внутри.' }));
    }
  }

  function row({ name, path, isDir, icon: iconName, meta = '', isUp = false }) {
    const node = el('button', {
      class: `browser__row${isDir ? '' : ' is-file'}${isUp ? ' is-up' : ''}`,
      title: path
    }, [
      el('span', { class: 'browser__row-icon', html: icon(iconName) }),
      el('span', { class: 'browser__name', text: name }),
      meta ? el('span', { class: 'browser__meta', text: meta }) : null,
      !isDir ? el('span', { class: 'browser__check', html: icon('check') }) : null
    ]);

    if (isDir) {
      node.addEventListener('click', () => load(path));
      if (!isUp) {
        node.addEventListener('dblclick', (event) => {
          event.preventDefault();
        });
      }
    } else {
      if (selectedFiles.has(path)) node.classList.add('is-selected');
      node.addEventListener('click', () => {
        if (selectedFiles.has(path)) selectedFiles.delete(path);
        else selectedFiles.add(path);
        node.classList.toggle('is-selected', selectedFiles.has(path));
        updateButtons();
      });
      node.addEventListener('dblclick', () => addFiles([path]));
    }
    return node;
  }

  function updateButtons() {
    const count = selectedFiles.size;
    addFilesBtn.disabled = count === 0;
    addFilesBtn.querySelector('span').textContent = count ? `Добавить файлы (${count})` : 'Добавить файлы';
    addFolderBtn.disabled = !cwd;
    picked.innerHTML = '';
    if (count) {
      picked.append(el('span', { text: `Выбрано: ${plural.track(count)}` }));
      const clear = el('button', { class: 'chip', text: 'Снять выделение' });
      clear.addEventListener('click', () => {
        selectedFiles = new Set();
        renderList(listing);
        updateButtons();
      });
      picked.append(clear);
    }
  }

  async function addFolder() {
    if (!cwd) return;
    const path = cwd;
    addFolderBtn.disabled = true;
    try {
      const result = await api.addSource([path], 'folder');
      const ok = result.results.filter((r) => r.ok).length;
      if (ok) {
        toast({ title: 'Папка подключена', text: path, kind: 'ok' });
        app.hintScanRunning();
        await app.refreshSources();
        dialog.close();
      } else {
        toast({ title: 'Не удалось подключить', text: result.results[0]?.error, kind: 'err' });
      }
    } catch (err) {
      toast({ title: 'Ошибка', text: err.message, kind: 'err' });
    } finally {
      addFolderBtn.disabled = false;
    }
  }

  async function addFiles(paths) {
    const list_ = paths || Array.from(selectedFiles);
    if (!list_.length) return;
    addFilesBtn.disabled = true;
    try {
      const result = await api.addSource(list_, 'file');
      const ok = result.results.filter((r) => r.ok).length;
      const failed = result.results.filter((r) => !r.ok);
      if (ok) {
        toast({ title: 'Файлы добавлены', text: plural.track(ok), kind: 'ok' });
        app.hintScanRunning();
        await app.refreshSources();
      }
      if (failed.length) {
        toast({ title: 'Часть файлов пропущена', text: failed[0].error, kind: 'warn' });
      }
      if (!failed.length) dialog.close();
    } catch (err) {
      toast({ title: 'Ошибка', text: err.message, kind: 'err' });
    } finally {
      addFilesBtn.disabled = false;
    }
  }

  async function nativePicker() {
    nativeBtn.disabled = true;
    try {
      const result = await api.pickFolder();
      if (result.path) {
        go(result.path);
      } else if (result.supported === false) {
        toast({ title: 'Системный диалог недоступен', text: 'Выберите папку в списке', kind: 'warn' });
      }
    } catch (err) {
      toast({ title: 'Системный диалог не открылся', text: err.message, kind: 'warn' });
    } finally {
      nativeBtn.disabled = false;
    }
  }

  addFolderBtn.addEventListener('click', addFolder);
  addFilesBtn.addEventListener('click', () => addFiles());
  nativeBtn.addEventListener('click', nativePicker);

  const dialog = openModal({
    title: 'Добавить музыку',
    subtitle: 'Выберите папку целиком или отдельные файлы',
    width: 'modal--wide',
    body: el('div', { class: 'browser' }, [
      quick,
      crumbs,
      el('div', { class: 'browser__path' }, [pathInput, openBtn, nativeBtn]),
      list,
      picked
    ]),
    footer: [
      el('div', { class: 'spacer' }),
      addFilesBtn,
      addFolderBtn
    ]
  });

  hydrateIcons(dialog.modal);
  load(null);
  return dialog;
}

/** Окно «Горячие клавиши». */
export function openShortcuts() {
  const rows = [
    ['Пробел', 'Играть / пауза'],
    ['← →', 'Перемотка на 5 секунд'],
    ['Shift + ← →', 'Перемотка на 30 секунд'],
    ['↑ ↓', 'Громкость'],
    ['N / P', 'Следующий / предыдущий трек'],
    ['S', 'Перемешать'],
    ['R', 'Режим повтора'],
    ['M', 'Выключить звук'],
    ['F', 'В избранное'],
    ['E', 'Редактировать теги'],
    ['Q', 'Очередь воспроизведения'],
    ['/', 'Поиск по библиотеке'],
    ['Ctrl + A', 'Выделить все треки'],
    ['Ctrl + F', 'Поиск'],
    ['F5', 'Пересканировать библиотеку'],
    ['Ctrl + O', 'Добавить папку'],
    ['Esc', 'Снять выделение / закрыть окно'],
    ['?', 'Эта справка']
  ];
  const grid = el('div', { class: 'keys' });
  for (const [keys, label] of rows) {
    grid.append(el('div', { class: 'keys__row' }, [el('kbd', { text: keys }), el('span', { text: label })]));
  }
  openModal({
    title: 'Горячие клавиши',
    subtitle: 'Работают, когда фокус не в поле ввода',
    body: grid,
    width: 'modal--narrow'
  });
}