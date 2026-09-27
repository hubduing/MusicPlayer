/* Примитивы интерфейса: тосты, модальные окна, контекстное меню, слайдеры. */
import { $, el, clamp } from './util.js';
import { icon, hydrateIcons } from './icons.js';

// ------------------------------------------------------------------ тосты

export function toast({ title, text, kind = 'info', timeout = 4200, icon: iconName } = {}) {
  const host = $('#toasts');
  const name = iconName || { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[kind] || 'info';
  const node = el('div', { class: `toast toast--${kind}` }, [
    el('span', { class: 'toast__icon', html: icon(name) }),
    el('div', { class: 'toast__body' }, [
      title ? el('div', { class: 'toast__title', text: title }) : null,
      text ? el('div', { class: 'toast__text', text }) : null
    ])
  ]);
  host.append(node);
  const kill = () => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 300);
  };
  node.addEventListener('click', kill);
  if (timeout) setTimeout(kill, timeout);
  return kill;
}

// ------------------------------------------------------------------ модальные окна

const modalStack = [];

export function openModal({ title, subtitle, body, footer, width = '', onClose, onMount, closeOnBackdrop = true, label }) {
  const root = $('#modal-root');
  const previouslyFocused = document.activeElement;

  const closeBtn = el('button', { class: 'iconbtn', html: icon('close'), title: 'Закрыть', 'aria-label': 'Закрыть' });
  const modal = el('div', { class: `modal ${width}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title || 'Диалог' }, [
    el('header', { class: 'modal__head' }, [
      el('div', {}, [
        title ? el('h2', { text: title }) : null,
        subtitle ? el('div', { class: 'modal__sub', text: subtitle }) : null
      ]),
      closeBtn
    ]),
    el('div', { class: 'modal__body' }, [body]),
    footer ? el('footer', { class: 'modal__foot' }, footer) : null
  ]);

  root.hidden = false;
  root.innerHTML = '';
  root.append(modal);
  hydrateIcons(modal);

  const entry = { modal, close };
  modalStack.push(entry);

  function close(result) {
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    if (!modalStack.length) {
      root.hidden = true;
      root.innerHTML = '';
    }
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    onClose?.(result);
  }

  closeBtn.addEventListener('click', () => close());
  if (closeOnBackdrop) {
    root.addEventListener('mousedown', (event) => {
      if (event.target === root) close();
    });
  }

  onMount?.(modal, close);

  const focusable = modal.querySelector('input, textarea, select, button:not(.iconbtn), [tabindex]');
  setTimeout(() => (focusable || modal).focus?.(), 30);

  return { close, modal, root };
}

export function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) top.close();
  return !!top;
}

export function hasModal() {
  return modalStack.length > 0;
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !modalStack.length) return;
  const modal = modalStack[modalStack.length - 1].modal;
  const nodes = Array.from(modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', trapFocus, true);

// ------------------------------------------------------------------ контекстное меню

let menuOpen = false;

export function openMenu(items, { x, y, anchor } = {}) {
  const menu = $('#ctxmenu');
  menu.innerHTML = '';
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.append(el('div', { class: 'menu__sep' }));
      continue;
    }
    if (item.header) {
      menu.append(el('div', { class: 'menu__label', text: item.header }));
      continue;
    }
    const btn = el('button', {
      class: `menu__item${item.danger ? ' is-danger' : ''}`,
      html: `${icon(item.icon || 'chevron-right')}<span>${item.label}</span>`
    }, []);
    btn.addEventListener('click', () => {
      closeMenu();
      item.onClick?.();
    });
    menu.append(btn);
  }
  menu.hidden = false;
  menuOpen = true;

  const rect = menu.getBoundingClientRect();
  let left = x ?? 0;
  let top = y ?? 0;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = a.right - rect.width;
    top = a.bottom + 6;
  }
  left = clamp(left, 8, window.innerWidth - rect.width - 8);
  top = clamp(top, 8, window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  hydrateIcons(menu);
  return menu;
}

export function closeMenu() {
  const menu = $('#ctxmenu');
  menu.hidden = true;
  menuOpen = false;
}

document.addEventListener('mousedown', (event) => {
  const menu = $('#ctxmenu');
  if (menuOpen && !menu.contains(event.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ------------------------------------------------------------------ слайдер

/** Перетаскиваемый слайдер: get() даёт 0..1, set(v) применяет. */
export function makeSlider(node, { get, set, step = 0.01 } = {}) {
  let dragging = false;

  const valueFromEvent = (event) => {
    const rect = node.getBoundingClientRect();
    const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
    return clamp(x / Math.max(1, rect.width), 0, 1);
  };

  const apply = (value) => {
    const quantized = step ? Math.round(value / step) * step : value;
    set(clamp(quantized, 0, 1));
  };

  node.addEventListener('pointerdown', (event) => {
    dragging = true;
    node.setPointerCapture?.(event.pointerId);
    node.classList.add('is-dragging');
    apply(valueFromEvent(event));
    event.preventDefault();
  });
  node.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    apply(valueFromEvent(event));
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('is-dragging');
    node.releasePointerCapture?.(event.pointerId);
  };
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);

  node.addEventListener('keydown', (event) => {
    const current = get();
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      set(clamp(current + step, 0, 1));
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      set(clamp(current - step, 0, 1));
      event.preventDefault();
    } else if (event.key === 'Home') {
      set(0);
    } else if (event.key === 'End') {
      set(1);
    }
  });

  return {
    sync: () => {
      const value = clamp(get(), 0, 1);
      node.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      return value;
    }
  };
}

// ------------------------------------------------------------------ мелочи

export function confirmDialog({ title, message, confirmLabel = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const cancel = el('button', { class: 'btn', text: 'Отмена' });
    const ok = el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--solid'}`, text: confirmLabel });
    const dialog = openModal({
      title,
      width: 'modal--narrow',
      body: el('p', { text: message, style: { color: 'var(--ink-2)', lineHeight: '1.6' } }),
      footer: [el('div', { class: 'spacer' }), cancel, ok],
      onClose: () => finish(false)
    });
    cancel.addEventListener('click', () => {
      finish(false);
      dialog.close();
    });
    ok.addEventListener('click', () => {
      finish(true);
      dialog.close();
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Создать' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const input = el('input', { type: 'text', value, placeholder, maxlength: '120' });
    const cancel = el('button', { class: 'btn', text: 'Отмена' });
    const ok = el('button', { class: 'btn btn--solid', text: confirmLabel });
    const dialog = openModal({
      title,
      width: 'modal--narrow',
      body: el('div', { class: 'fld' }, [el('label', { text: label }), input]),
      footer: [el('div', { class: 'spacer' }), cancel, ok],
      onClose: () => finish(null),
      onMount: () => setTimeout(() => input.select(), 40)
    });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      finish(v);
      dialog.close();
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    cancel.addEventListener('click', () => {
      finish(null);
      dialog.close();
    });
  });
}

/** Строка «клавиша — действие» для окна горячих клавиш. */
export function keyRow(keys, label) {
  return el('div', { class: 'keys__row' }, [
    el('kbd', { text: keys }),
    el('span', { text: label })
  ]);
}