'use strict';
/**
 * Генерация тестовой фонотеки через ffmpeg.
 * Нужна, чтобы тесты парсеров и браузерный прогон работали на настоящих
 * файлах с настоящими тегами, а не на заглушках.
 *
 * Если ffmpeg не найден — тесты, которым он нужен, сообщают об этом и
 * завершаются с кодом 2 (пропуск), а не падают с непонятной ошибкой.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function ffmpegAvailable() {
  const probe = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

function run(args) {
  // stdio: inherit — в песочнице запрещены именованные каналы, но прямой
  // вывод в консоль разрешён, поэтому вывод ffmpeg не перехватываем.
  const result = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg не смог создать файл (код ${result.status})`);
}

const TRACKS = [
  { rel: 'Album One/01 - Overture.mp3', title: 'Overture', artist: 'Ансамбль Тишины', album: 'Album One', track: 1, year: 2019, genre: 'Ambient', seconds: 6, freq: 275 },
  { rel: 'Album One/02 - Nocturne.mp3', title: 'Nocturne', artist: 'Ансамбль Тишины', album: 'Album One', track: 2, year: 2019, genre: 'Ambient', seconds: 9, freq: 330 },
  { rel: 'Album Two/01 - Iron Waltz.flac', title: 'Iron Waltz', artist: 'Kettle & Smoke', album: 'Album Two', track: 1, year: 2021, genre: 'Folk', seconds: 7, freq: 385 },
  { rel: 'Album Two/02 - Copper Sky.wav', title: 'Copper Sky', artist: 'Kettle & Smoke', album: 'Album Two', track: 2, year: 2021, genre: 'Folk', seconds: 4, freq: 440 },
  { rel: 'Album Two/Bonus/03 - Bonus Reel.ogg', title: 'Bonus Reel', artist: 'Kettle & Smoke', album: 'Album Two', track: 3, year: 2021, genre: 'Folk', seconds: 5, freq: 495 },
  { rel: 'Single Track.m4a', title: 'Single Track', artist: 'Марта', album: '', track: 1, year: 2023, genre: 'Electronic', seconds: 8, freq: 550 }
];

function codecArgs(ext) {
  switch (ext) {
    case '.flac': return ['-c:a', 'flac'];
    case '.ogg': return ['-c:a', 'libvorbis', '-q:a', '5'];
    case '.m4a': return ['-c:a', 'aac', '-b:a', '128k'];
    case '.wav': return ['-c:a', 'pcm_s16le'];
    default: return ['-c:a', 'libmp3lame', '-b:a', '192k'];
  }
}

/**
 * Создаёт дерево тестовой музыки.
 * @returns {string} путь к корню фонотеки
 */
function createFixtures(dir = path.join(__dirname, '.fixtures')) {
  if (!ffmpegAvailable()) {
    const err = new Error('ffmpeg не найден в PATH — тестовые файлы создать нечем');
    err.code = 'NO_FFMPEG';
    throw err;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'Пустая папка'), { recursive: true });

  for (const track of TRACKS) {
    const target = path.join(dir, track.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ext = path.extname(target).toLowerCase();
    const metadata = ['-metadata', `title=${track.title}`, '-metadata', `artist=${track.artist}`];
    if (track.album) metadata.push('-metadata', `album=${track.album}`);
    metadata.push('-metadata', `track=${track.track}`, '-metadata', `date=${track.year}`, '-metadata', `genre=${track.genre}`);
    run([
      '-f', 'lavfi', '-i', `sine=frequency=${track.freq}:duration=${track.seconds}`,
      ...codecArgs(ext), ...metadata, target
    ]);
  }

  // Обложка рядом с файлами (проверяем folder-cover)
  const cover = path.join(dir, 'Album One', 'cover.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=#c2410c:s=600x600', '-frames:v', '1', cover]);

  // Копия FLAC в MP3 с обложкой внутри файла (проверяем APIC)
  const tagged = path.join(dir, 'Album Two', '01 - Iron Waltz (tagged).mp3');
  run([
    '-i', path.join(dir, 'Album Two', '01 - Iron Waltz.flac'),
    '-i', cover,
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'mjpeg',
    '-id3v2_version', '3',
    '-metadata:s:v', 'title=Album cover',
    '-metadata', 'title=Iron Waltz', '-metadata', 'artist=Kettle & Smoke',
    '-metadata', 'album=Album Two', '-metadata', 'track=1',
    '-metadata', 'date=2021', '-metadata', 'genre=Folk',
    tagged
  ]);

  return dir;
}

function removeFixtures(dir = path.join(__dirname, '.fixtures')) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createFixtures, removeFixtures, ffmpegAvailable, TRACKS, FIXTURE_DIR: path.join(__dirname, '.fixtures') };