/* Проверка парсеров тегов на настоящих файлах из tests/.fixtures.
   Запуск: node tests/check-tags.js  (тестовые файлы создаются автоматически) */
const path = require('node:path');
const fs = require('node:fs');
const { readTags } = require('../server/lib/tags');
const { idFor } = require('../server/lib/library');
const { createFixtures, FIXTURE_DIR } = require('./fixtures');

let problems = 0;
const check = (label, actual, expected, tolerance = 0) => {
  let ok;
  if (typeof expected === 'number') ok = actual != null && Math.abs(actual - expected) <= tolerance;
  else ok = String(actual) === String(expected);
  if (!ok) {
    problems += 1;
    console.log(`   ✗ ${label}: получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
  }
  return ok;
};

let dir = FIXTURE_DIR;
if (!fs.existsSync(path.join(dir, 'Single Track.m4a'))) {
  console.log('Создаю тестовые файлы через ffmpeg…');
  try {
    dir = createFixtures();
  } catch (err) {
    console.error(err.code === 'NO_FFMPEG' ? `Пропуск: ${err.message}` : `Ошибка подготовки: ${err.message}`);
    process.exit(2);
  }
}

const files = [
  'Album One/01 - Overture.mp3',
  'Album One/02 - Nocturne.mp3',
  'Album Two/01 - Iron Waltz.flac',
  'Album Two/01 - Iron Waltz (tagged).mp3',
  'Album Two/02 - Copper Sky.wav',
  'Album Two/Bonus/03 - Bonus Reel.ogg',
  'Single Track.m4a'
];

console.log('Читаю теги всех форматов:\n');
for (const rel of files) {
  const meta = readTags(path.join(dir, rel));
  console.log(`${rel}`);
  console.log(`   title="${meta.title}" artist="${meta.artist}" album="${meta.album}" year=${meta.year} track=${meta.trackNo}`);
  console.log(`   codec=${meta.codec} dur=${meta.duration ? meta.duration.toFixed(2) : null}s rate=${meta.sampleRate} ch=${meta.channels} cover=${meta.cover ? `${meta.cover.mime} ${meta.cover.data.length}b` : 'нет'}`);
}

console.log('\n--- Контрольные проверки ---');
const overture = readTags(path.join(dir, files[0]));
check('mp3 title', overture.title, 'Overture');
check('mp3 artist', overture.artist, 'Ансамбль Тишины');
check('mp3 album', overture.album, 'Album One');
check('mp3 year', overture.year, 2019);
check('mp3 track', overture.trackNo, 1);
check('mp3 genre', overture.genre, 'Ambient');
check('mp3 duration', overture.duration, 6, 0.4);
check('mp3 codec', overture.codec, 'MP3');
check('mp3 bitrate', overture.bitrate, 192, 15);
check('mp3 lossless', overture.lossless, false);

const flac = readTags(path.join(dir, files[2]));
check('flac title', flac.title, 'Iron Waltz');
check('flac artist', flac.artist, 'Kettle & Smoke');
check('flac duration', flac.duration, 7, 0.4);
check('flac rate', flac.sampleRate, 44100);
check('flac lossless', flac.lossless, true);
check('flac bits', flac.bitsPerSample, 16);

const tagged = readTags(path.join(dir, files[3]));
check('tagged mp3 cover есть', !!tagged.cover, true);
check('tagged mp3 cover > 500 байт', tagged.cover ? tagged.cover.data.length > 500 : 0, true);
check('tagged mp3 title', tagged.title, 'Iron Waltz');
check('tagged mp3 year', tagged.year, 2021);

const wav = readTags(path.join(dir, files[4]));
check('wav title', wav.title, 'Copper Sky');
check('wav artist', wav.artist, 'Kettle & Smoke');
check('wav duration', wav.duration, 4, 0.3);
check('wav lossless', wav.lossless, true);

const ogg = readTags(path.join(dir, files[5]));
check('ogg title', ogg.title, 'Bonus Reel');
check('ogg artist', ogg.artist, 'Kettle & Smoke');
check('ogg track', ogg.trackNo, 3);
check('ogg duration', ogg.duration, 5, 0.5);
check('ogg codec', ogg.codec, 'Vorbis');

const m4a = readTags(path.join(dir, files[6]));
check('m4a title', m4a.title, 'Single Track');
check('m4a artist', m4a.artist, 'Марта');
check('m4a year', m4a.year, 2023);
check('m4a track', m4a.trackNo, 1);
check('m4a duration', m4a.duration, 8, 0.4);
check('m4a codec', m4a.codec, 'AAC');
check('m4a rate', m4a.sampleRate, 44100);

check('id стабилен между вызовами', idFor(path.join(dir, files[0])), idFor(path.join(dir, files[0])));

if (problems) {
  console.log(`\nПРОБЛЕМ: ${problems}`);
  process.exit(1);
}
console.log(`\nВсе проверки парсера прошли (${files.length} файлов).`);