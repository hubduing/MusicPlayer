'use strict';
/**
 * Запись тегов обратно в файл. Сейчас поддержан MP3 (ID3v2.3 + ID3v1),
 * потому что это самый частый формат домашней фонотеки, а встроенный
 * редактор тегов — одна из главных возможностей плеера.
 *
 * Перед первой правкой рядом с файлом создаётся резервная копия .bak.
 * Запись атомарная: сначала временный файл, потом подмена.
 */
const fs = require('node:fs');
const path = require('node:path');
const { extOf } = require('./mime');

const TEXT_FRAMES = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  albumArtist: 'TPE2',
  year: 'TDRC',
  trackNo: 'TRCK',
  discNo: 'TPOS',
  genre: 'TCON',
  composer: 'TCOM'
};

function syncsafe32(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function utf16(text) {
  // ID3v2.3 кодирует текст как UTF-16 с BOM. BOM 0xFF 0xFE = little-endian,
  // поэтому байты берём как есть (Buffer 'utf16le' уже даёт нужный порядок).
  const body = Buffer.from(String(text), 'utf16le');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body, Buffer.from([0x00, 0x00])]);
}

function textFrame(id, text, encoding = 1) {
  if (text === '' || text == null) return Buffer.alloc(0);
  const payload = encoding === 1
    ? Buffer.concat([Buffer.from([1]), utf16(text)])
    : Buffer.concat([Buffer.from([0]), Buffer.from(String(text), 'latin1'), Buffer.from([0])]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function commentFrame(text) {
  if (!text) return Buffer.alloc(0);
  // Комментарий: encoding(1) + язык(3) + пустое описание (00 00) + текст
  const payload = Buffer.concat([
    Buffer.from([1]),
    Buffer.from('eng', 'latin1'),
    Buffer.from([0x00, 0x00]),
    utf16(text)
  ]);
  const header = Buffer.alloc(10);
  header.write('COMM', 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function pictureFrame(cover) {
  if (!cover || !cover.data) return Buffer.alloc(0);
  const mime = Buffer.from(cover.mime || 'image/jpeg', 'latin1');
  const payload = Buffer.concat([
    Buffer.from([0]),
    mime,
    Buffer.from([0]),
    Buffer.from([3]),
    Buffer.from([0]),
    cover.data
  ]);
  const header = Buffer.alloc(10);
  header.write('APIC', 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function buildId3v2(fields, cover) {
  const frames = [];
  for (const [key, frameId] of Object.entries(TEXT_FRAMES)) {
    let value = fields[key];
    if (value == null || value === '') continue;
    if (key === 'trackNo' || key === 'discNo') {
      const num = Number(value);
      if (!num) continue;
      value = String(num);
    }
    frames.push(textFrame(frameId, value));
  }
  if (fields.comment) frames.push(commentFrame(fields.comment));
  if (cover && cover.data) frames.push(pictureFrame(cover));
  const body = Buffer.concat(frames.filter((f) => f.length));
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3; // v2.3
  header[4] = 0;
  header[5] = 0;
  syncsafe32(body.length).copy(header, 6);
  return Buffer.concat([header, body]);
}

function buildId3v1(fields) {
  const buf = Buffer.alloc(128);
  buf.write('TAG', 0, 'latin1');
  const put = (offset, length, value) => {
    if (!value) return;
    Buffer.from(String(value), 'latin1').subarray(0, length).copy(buf, offset);
  };
  put(3, 30, fields.title);
  put(33, 30, fields.artist);
  put(63, 30, fields.album);
  put(93, 4, fields.year ? String(fields.year) : '');
  put(97, 28, fields.comment);
  buf[125] = 0;
  const track = Number(fields.trackNo) || 0;
  buf[126] = track > 0 && track < 256 ? track : 0;
  buf[127] = 255; // genre: unknown
  return buf;
}

function existingId3v2Size(buf) {
  if (buf.length < 10) return 0;
  if (buf.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function hasId3v1(buf) {
  return buf.length > 128 && buf.subarray(buf.length - 128, buf.length - 125).toString('latin1') === 'TAG';
}

/**
 * Дописывает/перезаписывает теги.
 * @returns {{written:boolean, reason?:string, backup?:string}}
 */
function writeTags(filePath, fields = {}, cover = null) {
  const ext = extOf(filePath);
  if (ext !== '.mp3' && ext !== '.mp2') {
    return { written: false, reason: `Запись тегов для ${ext || 'этого формата'} пока не поддерживается — изменения сохранены только в библиотеке плеера` };
  }
  let original;
  try {
    original = fs.readFileSync(filePath);
  } catch (err) {
    return { written: false, reason: `Не удалось прочитать файл: ${err.message}` };
  }
  if (!original.length) return { written: false, reason: 'Файл пуст' };

  const skip = existingId3v2Size(original);
  const end = hasId3v1(original) ? original.length - 128 : original.length;
  const audio = original.subarray(skip, Math.max(skip, end));

  // сохраняем те поля, которые не пришли в патче
  const merged = { ...(fields.__existing || {}), ...fields };
  delete merged.__existing;

  const id3 = buildId3v2(merged, cover);
  const id3v1 = buildId3v1(merged);
  const output = Buffer.concat([id3, audio, id3v1]);

  const backup = `${filePath}.bak`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(filePath, backup);
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, output);
    fs.renameSync(tmp, filePath);
    return { written: true, backup };
  } catch (err) {
    return { written: false, reason: `Не удалось записать файл: ${err.message}` };
  }
}

function supportsWriting(filePath) {
  const ext = extOf(filePath);
  return ext === '.mp3' || ext === '.mp2';
}

module.exports = { writeTags, supportsWriting };