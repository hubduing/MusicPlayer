'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Папка данных: по умолчанию `data/` рядом с приложением, чтобы проигрыватель
 * оставался переносимым — фондотека ездит вместе с папкой проекта.
 * Переопределяется переменной GROOVESHELF_DATA; если рядом с проектом писать
 * нельзя (программа на Program Files), уходим в домашний каталог.
 */
const APP_DIR = path.join(__dirname, '..', '..', 'data');

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const DATA_DIR = process.env.GROOVESHELF_DATA
  ? path.resolve(process.env.GROOVESHELF_DATA)
  : canWrite(path.dirname(APP_DIR)) || fs.existsSync(APP_DIR)
    ? APP_DIR
    : path.join(os.homedir(), '.grooveshelf');

const DB_FILE = path.join(DATA_DIR, 'library.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  theme: 'ember',
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: 'off',
  sort: 'artist',
  order: 'asc',
  view: 'tracks',
  queueOpen: false,
  seekStep: 5,
  normalize: false,
  showVisualizer: true,
  lastPlayedId: null,
  lastPlayedPosition: 0
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    ensureDir();
    const db = readJson(DB_FILE, null);
    this.db = {
      version: 1,
      sources: [],
      tracks: {},
      playlists: [],
      favorites: [],
      updatedAt: new Date().toISOString(),
      ...(db || {})
    };
    if (!Array.isArray(this.db.sources)) this.db.sources = [];
    if (!this.db.tracks || typeof this.db.tracks !== 'object') this.db.tracks = {};
    if (!Array.isArray(this.db.playlists)) this.db.playlists = [];
    if (!Array.isArray(this.db.favorites)) this.db.favorites = [];
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
    this._pending = null;
    this.onDirty = null;
  }

  /** Запись откладывается, чтобы сканирование сотен файлов не тормозило на диске. */
  touch() {
    this.db.updatedAt = new Date().toISOString();
    if (this._pending) return;
    this._pending = setTimeout(() => {
      this._pending = null;
      this.flush();
    }, 800);
    if (this._pending.unref) this._pending.unref();
  }

  flush() {
    if (this._pending) {
      clearTimeout(this._pending);
      this._pending = null;
    }
    try {
      writeJsonAtomic(DB_FILE, this.db);
    } catch (err) {
      console.error('[store] не удалось сохранить библиотеку:', err.message);
    }
    if (this.onDirty) this.onDirty();
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      writeJsonAtomic(SETTINGS_FILE, this.settings);
    } catch (err) {
      console.error('[store] не удалось сохранить настройки:', err.message);
    }
    return this.settings;
  }

  get dataDir() {
    return DATA_DIR;
  }

  get dbFile() {
    return DB_FILE;
  }
}

module.exports = { Store, DATA_DIR, DB_FILE, SETTINGS_FILE, DEFAULT_SETTINGS };