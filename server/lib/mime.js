'use strict';
const path = require('node:path');

const MIME = {
  '.mp3': 'audio/mpeg',
  '.mp2': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.lrc': 'text/plain; charset=utf-8'
};

/** Аудио, которое браузер гарантированно умеет декодировать. */
const PLAYABLE_EXT = new Set([
  '.mp3', '.flac', '.wav', '.wave', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.aac', '.webm', '.weba'
]);

/** Всё, что мы считаем аудиофайлом при сканировании. */
const AUDIO_EXT = new Set([
  ...PLAYABLE_EXT, '.mp2', '.mpga', '.m4b', '.wma', '.aif', '.aiff', '.ape', '.wv'
]);

const LOSSLESS_EXT = new Set(['.flac', '.wav', '.wave', '.aif', '.aiff', '.ape', '.wv']);

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isAudio(filePath) {
  return AUDIO_EXT.has(path.extname(filePath).toLowerCase());
}

function isPlayable(filePath) {
  return PLAYABLE_EXT.has(path.extname(filePath).toLowerCase());
}

function isLossless(filePath) {
  return LOSSLESS_EXT.has(path.extname(filePath).toLowerCase());
}

function extOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

module.exports = { MIME, AUDIO_EXT, PLAYABLE_EXT, LOSSLESS_EXT, mimeFor, isAudio, isPlayable, isLossless, extOf };