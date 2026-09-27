/* Запись тегов обратно в файл: проверяем полный цикл сохранения.
   Отдельно сверяем результат сторонним инструментом (ffprobe), потому что
   наш собственный парсер может разделять ту же ошибку, что и писатель. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const workDir = path.join(__dirname, '.work');
// Папку данных задаём ДО загрузки store.js — он читает её при импорте.
process.env.GROOVESHELF_DATA = path.join(workDir, 'data');

const { writeTags, supportsWriting } = require('../server/lib/edit-tags');
const { readTags } = require('../server/lib/tags');
const { Library } = require('../server/lib/library');
const { Store } = require('../server/lib/store');
const { createFixtures, FIXTURE_DIR, ffmpegAvailable } = require('./fixtures');

let problems = 0;
const check = (label, condition, detail = '') => {
  if (condition) return true;
  problems += 1;
  console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
};

/**
 * Запускает процесс и читает его вывод через файл, а не через канал:
 * в песочнице именованные каналы запрещены, а обычный файл — можно.
 */
function capture(cmd, args) {
  const outFile = path.join(os.tmpdir(), `gs-cap-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  let fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    const res = spawnSync(cmd, args, { stdio: ['ignore', fd, 'ignore'] });
    fs.closeSync(fd);
    fd = null;
    if (res.error || res.status !== 0) return null;
    return fs.readFileSync(outFile, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
}

const fixtureDir = FIXTURE_DIR;
if (!fs.existsSync(path.join(fixtureDir, 'Album One', '01 - Overture.mp3'))) {
  if (!ffmpegAvailable()) {
    console.error('Пропуск: ffmpeg не найден');
    process.exit(2);
  }
  createFixtures();
}

// Работаем на копии, чтобы не портить фикстуры для других тестов
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const file = path.join(workDir, 'sample.mp3');
fs.copyFileSync(path.join(fixtureDir, 'Album One', '01 - Overture.mp3'), file);

const ffprobe = (target) => {
  const raw = capture(process.env.FFPROBE || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format_tags', '-of', 'json', target
  ]);
  if (raw == null) return null;
  try {
    return JSON.parse(raw).format?.tags || {};
  } catch {
    return null;
  }
};

const duration = (target) => {
  const raw = capture(process.env.FFPROBE || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target
  ]);
  if (raw == null) return null;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : null;
};

console.log('Проверяю запись тегов в MP3\n');

check('supportsWriting(.mp3)', supportsWriting(file) === true);
check('supportsWriting(.flac) не поддерживается', supportsWriting('x.flac') === false);

const beforeDuration = duration(file);
const beforeSize = fs.statSync(file).size;

const fields = {
  title: 'Заголовок с юникодом — ёжик',
  artist: 'Исполнитель Ёж',
  album: 'Альбом «Тире» №2',
  albumArtist: 'Разные исполнители',
  year: 2024,
  trackNo: 7,
  discNo: 2,
  genre: 'Электроника',
  comment: 'Комментарий: café, №5, 100% тест',
  composer: 'К. М. Римский'
};

console.log('Пишу теги (первый проход)…');
const result = writeTags(file, fields, null);
check('файл записан', result.written === true, result.reason || '');
check('резервная копия .bak создана', !!result.backup && fs.existsSync(result.backup));

console.log('Читаю своим парсером…');
const mine = readTags(file);
for (const key of ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNo', 'discNo', 'genre', 'comment', 'composer']) {
  check(`свой парсер: ${key}`, String(mine[key]) === String(fields[key]), `получено ${JSON.stringify(mine[key])}`);
}

console.log('Читаю сторонним инструментом (ffprobe)…');
const probe = ffprobe(file);
if (probe) {
  const map = {
    title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist',
    year: 'date', trackNo: 'track', discNo: 'disc', genre: 'genre', comment: 'comment', composer: 'composer'
  };
  for (const [key, tag] of Object.entries(map)) {
    check(`ffprobe: ${tag}`, String(probe[tag] ?? '') === String(fields[key]), `получено ${JSON.stringify(probe[tag])}`);
  }
} else {
  console.log('   (ffprobe недоступен — проверка сторонним инструментом пропущена)');
}

console.log('Проверяю целостность аудио…');
const afterDuration = duration(file);
if (beforeDuration == null || afterDuration == null) {
  console.log('   (ffprobe недоступен — проверка длительности пропущена)');
} else {
  check('длительность не изменилась', Math.abs(afterDuration - beforeDuration) < 0.05, `${beforeDuration} → ${afterDuration}`);
}
check('файл вырос умеренно (только теги)', fs.statSync(file).size - beforeSize < 4096, `+${fs.statSync(file).size - beforeSize} байт`);
check('нет временных файлов', fs.readdirSync(workDir).filter((f) => f.includes('.tmp')).length === 0);

console.log('Перезаписываю те же поля трижды (проверка на утечку размера)…');
const sizeAfterFirst = fs.statSync(file).size;
for (let i = 0; i < 3; i += 1) writeTags(file, { ...fields, comment: `проход ${i}` }, null);
const sizeAfterThird = fs.statSync(file).size;
check('размер стабилен при перезаписи', Math.abs(sizeAfterThird - sizeAfterFirst) < 256, `${sizeAfterFirst} → ${sizeAfterThird}`);
const reread = readTags(file);
check('после перезаписи теги на месте', reread.title === fields.title && reread.year === 2024, `title=${reread.title}`);
const stableDuration = duration(file);
if (stableDuration != null && beforeDuration != null) {
  check('после перезаписи audio цел', Math.abs(stableDuration - beforeDuration) < 0.05, `${stableDuration}`);
}

console.log('Проверяю обложку (APIC) и её сохранение при правке текста…');
const coverSeed = path.join(fixtureDir, 'Album One', 'cover.jpg');
if (fs.existsSync(coverSeed)) {
  const coverBuf = fs.readFileSync(coverSeed);
  const withCover = writeTags(file, fields, { data: coverBuf, mime: 'image/jpeg' });
  check('обложка записана', withCover.written === true);
  const coverRead = readTags(file);
  check('обложка читается обратно', !!coverRead.cover && coverRead.cover.data.length > 500,
    coverRead.cover ? `${coverRead.cover.data.length}b` : 'нет');
  check('обложка не побилась', coverRead.cover && coverBuf.compare(coverRead.cover.data) === 0, 'байты не совпали');

  // Правка текста без передачи обложки не должна её потерять:
  // библиотека сама подставляет существующую обложку, проверяем этот путь.
  const store = new Store();
  const lib = new Library(store);
  const record = lib.indexFile(file, null);
  check('трек проиндексирован', !!record);
  const updated = lib.updateTrack(record.id, { genre: 'Новый жанр' }, { writeFile: true });
  check('правка через библиотеку записана', updated.ok && updated.file?.written === true, JSON.stringify(updated.file));
  const afterEdit = readTags(file);
  check('обложка сохранилась при правке текста', !!afterEdit.cover && afterEdit.cover.data.length > 500,
    afterEdit.cover ? `${afterEdit.cover.data.length}b` : 'обложка потеряна');
  check('текст обновился', afterEdit.genre === 'Новый жанр', `genre=${afterEdit.genre}`);
  check('остальные поля не потерялись', afterEdit.title === fields.title && afterEdit.year === 2024,
    `title=${afterEdit.title} year=${afterEdit.year}`);
}

console.log('Проверяю отказ для неподдерживаемого формата…');
const flacCopy = path.join(workDir, 'sample.flac');
fs.copyFileSync(path.join(fixtureDir, 'Album Two', '01 - Iron Waltz.flac'), flacCopy);
const flacResult = writeTags(flacCopy, { title: 'не должно записаться' }, null);
check('FLAC: запись отклонена с причиной', flacResult.written === false && !!flacResult.reason, flacResult.reason);
check('FLAC: файл не изменён', readTags(flacCopy).title === 'Iron Waltz');

console.log('Проверяю пустой и битый файл…');
const empty = path.join(workDir, 'empty.mp3');
fs.writeFileSync(empty, Buffer.alloc(0));
const emptyResult = writeTags(empty, { title: 'x' }, null);
check('пустой файл: отказ без падения', emptyResult.written === false, emptyResult.reason);

fs.rmSync(workDir, { recursive: true, force: true });

if (problems) {
  console.log(`\nПРОБЛЕМ: ${problems}`);
  process.exit(1);
}
console.log('\nЗапись тегов работает корректно.');