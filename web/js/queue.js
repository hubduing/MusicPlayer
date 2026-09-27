/* Панель очереди воспроизведения. */
import { $, el, fmtTime, plural } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, openMenu } from './ui.js';

export class QueueView {
  constructor(app) {
    this.app = app;
    this.node = $('#queue');
    this.list = $('#queue-list');
    this.now = $('#queue-now');
    this.count = $('#queue-count');

    $('#btn-queue-close').addEventListener('click', () => this.close());
    $('#btn-queue').addEventListener('click', () => this.toggle());
    $('#btn-queue-shuffle').addEventListener('click', () => {
      const player = this.app.player;
      player.setShuffle(!player.shuffle);
      this.app.syncTransport();
    });
    $('#btn-queue-clear').addEventListener('click', () => {
      this.app.player.clearQueue({ keepCurrent: true });
      toast({ title: 'Очередь сокращена до текущего трека', kind: 'ok', timeout: 2400 });
    });
    this.node.addEventListener('click', (event) => {
      const item = event.target.closest('.queue__item');
      if (!item) return;
      const index = Number(item.dataset.index);
      if (event.target.closest('[data-remove]')) {
        this.app.player.removeFromQueue(index);
        return;
      }
      this.app.player.playIndex(index);
    });
    this.node.addEventListener('contextmenu', (event) => {
      const item = event.target.closest('.queue__item');
      if (!item) return;
      event.preventDefault();
      const index = Number(item.dataset.index);
      const track = this.app.player.queue[index];
      if (!track) return;
      openMenu([
        { header: track.title },
        { label: 'Играть', icon: 'play', onClick: () => this.app.player.playIndex(index) },
        { label: 'Убрать из очереди', icon: 'trash', danger: true, onClick: () => this.app.player.removeFromQueue(index) },
        { label: 'Очистить очередь', icon: 'close', onClick: () => this.app.player.clearQueue({ keepCurrent: true }) }
      ], { x: event.clientX, y: event.clientY });
    });

    this._initDrag();
  }

  /** Перетаскивание строк для смены порядка. */
  _initDrag() {
    let dragIndex = null;
    this.list.addEventListener('dragstart', (event) => {
      const item = event.target.closest('.queue__item');
      if (!item) return;
      dragIndex = Number(item.dataset.index);
      item.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', String(dragIndex));
      } catch {
        /* ignore */
      }
    });
    this.list.addEventListener('dragover', (event) => {
      const item = event.target.closest('.queue__item');
      if (!item || dragIndex == null) return;
      event.preventDefault();
      const over = Number(item.dataset.index);
      this.list.querySelectorAll('.queue__item').forEach((n) => n.classList.remove('is-over'));
      if (over !== dragIndex) item.classList.add('is-over');
    });
    this.list.addEventListener('drop', (event) => {
      const item = event.target.closest('.queue__item');
      if (!item || dragIndex == null) return;
      event.preventDefault();
      const to = Number(item.dataset.index);
      this.app.player.moveInQueue(dragIndex, to);
      dragIndex = null;
    });
    this.list.addEventListener('dragend', () => {
      dragIndex = null;
      this.list.querySelectorAll('.queue__item').forEach((n) => n.classList.remove('is-dragging', 'is-over'));
    });
  }

  open() {
    this.node.hidden = false;
    requestAnimationFrame(() => this.node.classList.add('is-open'));
  }

  close() {
    this.node.classList.remove('is-open');
    this.app.saveSettings({ queueOpen: false });
    setTimeout(() => {
      if (!this.node.classList.contains('is-open')) this.node.hidden = true;
    }, 420);
  }

  toggle() {
    if (this.node.hidden || !this.node.classList.contains('is-open')) {
      this.open();
      this.app.saveSettings({ queueOpen: true });
    } else {
      this.close();
    }
  }

  render() {
    const player = this.app.player;
    const queue = player.queue;
    this.count.textContent = queue.length
      ? `${plural.track(queue.length)} · ${fmtTime(queue.reduce((s, t) => s + (t.duration || 0), 0))}`
      : 'Очередь пуста';

    this._renderNow();

    this.list.innerHTML = '';
    if (!queue.length) {
      this.list.append(el('div', { class: 'sidebar__empty', text: 'Очередь пуста. Дважды щёлкните трек в библиотеке или перетащите его сюда.' }));
      return;
    }

    const fragment = document.createDocumentFragment();
    queue.forEach((track, index) => {
      const item = el('div', {
        class: `queue__item${index === player.index ? ' is-current' : ''}`,
        'data-index': String(index),
        draggable: 'true'
      }, [
        el('span', { class: 'queue__idx', text: index === player.index && player.playing ? '▶' : String(index + 1) }),
        el('div', { class: 'queue__body' }, [
          el('span', { class: 'queue__title', text: track.title || track.name }),
          el('span', { class: 'queue__sub', text: [track.artist, track.album].filter(Boolean).join(' — ') || 'Без тегов' })
        ]),
        el('span', { class: 'queue__time', text: fmtTime(track.duration, { unknown: '' }) }),
        el('button', { class: 'iconbtn', html: icon('close'), title: 'Убрать', 'data-remove': '1' })
      ]);
      fragment.append(item);
    });
    this.list.append(fragment);
    const current = this.list.querySelector('.queue__item.is-current');
    if (current && this.node.classList.contains('is-open')) {
      const top = current.offsetTop - this.list.clientHeight / 2;
      this.list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  _renderNow() {
    const track = this.app.player.current;
    this.now.innerHTML = '';
    if (!track) {
      this.now.append(el('div', { class: 'sidebar__empty', text: 'Ничего не играет' }));
      return;
    }
    const img = el('img', { alt: '', src: `/art?id=${encodeURIComponent(track.id)}` });
    img.addEventListener('error', () => {
      img.remove();
    });
    this.now.append(el('div', { class: 'queue__nowcard' }, [
      el('div', { class: 'queue__nowart' }, [img]),
      el('div', { class: 'queue__nowmeta' }, [
        el('div', { class: 'queue__nowtitle', text: track.title || track.name }),
        el('div', { class: 'queue__nowsub', text: track.artist || 'Неизвестный исполнитель' }),
        el('div', { class: 'queue__nowalbum', text: [track.album, track.year].filter(Boolean).join(' · ') })
      ])
    ]));
    hydrateIcons(this.node);
  }
}