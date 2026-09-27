'use strict';
/**
 * Минималистичный, но честный парсер аудиотегов без внешних зависимостей.
 * Поддержка: ID3v1/ID3v2.2/2.3/2.4 (MP3), FLAC (Vorbis Comment + PICTURE),
 * Ogg Vorbis / Opus, MP4/M4A (ilst), WAV (fmt + LIST/INFO + id3 ).
 */
const fs = require('node:fs');
const path = require('node:path');
const { extOf } = require('./mime');

class Reader {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }

  read(offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const start = Math.max(0, Math.min(offset, this.size));
    const len = Math.max(0, Math.min(length, this.size - start));
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- утилиты

function decodeText(buf, encoding = 0) {
  if (!buf || !buf.length) return '';
  let b = buf;
  try {
    if (encoding === 1) {
      // UTF-16 с BOM
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        const swapped = Buffer.from(b.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le');
      }
      return b.toString('utf16le');
    }
    if (encoding === 2) {
      const swapped = Buffer.from(b);
      if (swapped.length % 2) return swapped.toString('utf16le');
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    if (encoding === 3) return b.toString('utf8');
    return b.toString('latin1');
  } catch {
    return '';
  }
}

function clean(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\u0000+$/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

function splitValues(value, encoding) {
  const parts = String(value).split(encoding === 0 ? /\u0000|\s*\/\s*/ : /\u0000/);
  return parts.map(clean).filter(Boolean);
}

function syncsafe(buf) {
  return ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f);
}

function deunsync(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 1) {
    out.push(buf[i]);
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i += 1;
  }
  return Buffer.from(out);
}

function toInt(value) {
  const m = /-?\d+/.exec(String(value || ''));
  return m ? Number(m[0]) : null;
}

function emptyMeta() {
  return {
    title: '', artist: '', album: '', albumArtist: '', year: null, trackNo: null, discNo: null,
    genre: '', comment: '', composer: '', duration: null, bitrate: null, sampleRate: null,
    channels: null, bitsPerSample: null, codec: '', lossless: false, cover: null
  };
}

// ---------------------------------------------------------------- ID3v2 / MP3

const MP3_BITRATES = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** Ищет первый кадр MPEG и разбирает его заголовок. */
function parseMpegFrame(reader, from, to) {
  const size = Math.min(to, reader.size);
  const chunk = reader.read(from, Math.min(size - from, 512 * 1024));
  for (let i = 0; i + 4 <= chunk.length; i += 1) {
    if (chunk[i] !== 0xff || (chunk[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = chunk[i + 1];
    const b2 = chunk[i + 2];
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const rateIdx = (b2 >> 2) & 0x03;
    if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const key = `${version === 1 ? 1 : 2}-${layer}`;
    const bitrate = (MP3_BITRATES[key] || [])[bitrateIdx] || 0;
    const sampleRate = (SAMPLE_RATES[version === 2.5 ? 25 : version] || [])[rateIdx] || 0;
    if (!bitrate || !sampleRate) continue;
    const padding = (b2 >> 1) & 0x01;
    const channelMode = (chunk[i + 3] >> 6) & 0x03;
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding;
    return { offset: from + i, version, layer, bitrate, sampleRate, channelMode, frameLength, samplesPerFrame, channels: channelMode === 3 ? 1 : 2 };
  }
  return null;
}

/** Xing/Info/VBRI → точная длительность VBR-файлов. */
function mp3VbrInfo(reader, frame) {
  const sideInfo = frame.version === 1 ? (frame.channels === 1 ? 17 : 32) : (frame.channels === 1 ? 9 : 17);
  const candidates = [frame.offset + 4 + sideInfo, frame.offset + 4 + sideInfo + 2, frame.offset + 36];
  for (const pos of candidates) {
    const tag = reader.read(pos, 16);
    if (tag.length < 12) continue;
    const id = tag.subarray(0, 4).toString('latin1');
    if (id === 'Xing' || id === 'Info') {
      const flags = tag.readUInt32BE(4);
      let off = 8;
      let frames = null;
      let bytes = null;
      if (flags & 0x01) {
        frames = tag.readUInt32BE(off);
        off += 4;
      }
      if (flags & 0x02) {
        bytes = tag.readUInt32BE(off);
        off += 4;
      }
      if (frames) return { frames, bytes };
    }
    if (id === 'VBRI') {
      const bytes = tag.readUInt32BE(10);
      const frames = tag.readUInt32BE(14);
      if (frames) return { frames, bytes };
    }
  }
  return null;
}

function parseId3v2(reader) {
  const header = reader.read(0, 10);
  if (header.length < 10 || header.subarray(0, 3).toString('latin1') !== 'ID3') return null;
  const major = header[3];
  const flags = header[5];
  const size = syncsafe(header.subarray(6, 10));
  let body = reader.read(10, size);
  if (!body.length) return null;
  if (flags & 0x80) body = deunsync(body);

  const meta = {};
  const cover = { data: null, mime: null, type: 3 };
  const idMap = {
    TT2: 'title', TIT2: 'title', TP1: 'artist', TPE1: 'artist', TAL: 'album', TALB: 'album',
    TPE2: 'albumArtist', TP2: 'albumArtist', TRK: 'trackNo', TRCK: 'trackNo', TPA: 'discNo',
    TPOS: 'discNo', TYE: 'year', TDRC: 'year', TDA: 'year', TYER: 'year', TORY: 'year',
    TCO: 'genre', TCON: 'genre',
    COM: 'comment', COMM: 'comment', TCM: 'composer', TCOM: 'composer', TLE: 'duration', TLEN: 'duration'
  };

  let pos = 0;
  if (flags & 0x40) {
    // extended header
    if (major === 3) pos += 4 + (body.length >= 4 ? body.readUInt32BE(0) : 0);
    else if (major === 4) pos += syncsafe(body.subarray(0, 4));
  }
  const idLen = major === 2 ? 3 : 4;
  const sizeLen = major === 2 ? 3 : 4;
  const headerLen = idLen + sizeLen + (major === 2 ? 0 : 2);

  while (pos + headerLen <= body.length) {
    const id = body.subarray(pos, pos + idLen).toString('latin1');
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let frameSize;
    if (major === 2) frameSize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    else if (major === 4) frameSize = syncsafe(body.subarray(pos + 4, pos + 8));
    else frameSize = body.readUInt32BE(pos + 4);
    const frameFlags = major === 2 ? 0 : body.readUInt16BE(pos + 8);
    const dataStart = pos + headerLen;
    if (frameSize <= 0 || dataStart + frameSize > body.length) break;
    let data = body.subarray(dataStart, dataStart + frameSize);
    if (major === 4 && frameFlags & 0x0002) data = deunsync(data);
    if (major === 4 && frameFlags & 0x0001 && data.length >= 4) {
      const dl = syncsafe(data.subarray(0, 4));
      data = data.subarray(4 + dl);
    }

    const key = idMap[id];
    if (key) {
      if (id === 'COM' || id === 'COMM') {
        // encoding(1) + язык(3) + описание (завершается нулём) + текст
        const enc = data[0];
        let p = 4;
        if (enc === 1 || enc === 2) {
          while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          const end = data.indexOf(0, p);
          p = end < 0 ? p : end + 1;
        }
        const value = clean(decodeText(data.subarray(p), enc));
        if (value && !meta.comment) meta.comment = value;
      } else {
        const enc = data[0];
        const value = decodeText(data.subarray(1), enc);
        const list = splitValues(value, enc);
        const single = list.length ? list.join(', ') : clean(value);
        if (key === 'trackNo' || key === 'discNo') {
          const num = toInt(single);
          if (num != null) meta[key] = num;
        } else if (key === 'year') {
          meta.year = toInt(single) ?? meta.year ?? null;
        } else if (key === 'duration') {
          const ms = toInt(single);
          if (ms) meta.duration = ms / 1000;
        } else if (single && !meta[key]) {
          meta[key] = single;
        }
      }
    } else if (id === 'APIC' || id === 'PIC') {
      const enc = data[0];
      let p = 1;
      let mime = 'image/jpeg';
      if (id === 'PIC') {
        mime = `image/${data.subarray(1, 4).toString('latin1').toLowerCase()}`;
        p = 4;
      } else {
        const end = data.indexOf(0, p);
        if (end < 0) {
          p = data.length;
        } else {
          mime = data.subarray(p, end).toString('latin1') || mime;
          p = end + 1;
        }
      }
      const picType = data[p] || 3;
      p += 1;
      // описание, завершающееся нулём в текущей кодировке
      if (enc === 1 || enc === 2) {
        while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        const end = data.indexOf(0, p);
        p = end < 0 ? p : end + 1;
      }
      const img = data.subarray(p);
      if (img.length > 200 && (!cover.data || picType === 3)) {
        cover.data = img;
        cover.mime = mime.includes('/') ? mime : 'image/jpeg';
        cover.type = picType;
      }
    }
    pos = dataStart + frameSize;
  }

  return { meta, cover: cover.data ? cover : null, tagEnd: 10 + size };
}

function parseId3v1(reader) {
  if (reader.size < 128) return null;
  const buf = reader.read(reader.size - 128, 128);
  if (buf.subarray(0, 3).toString('latin1') !== 'TAG') return null;
  const str = (from, len) => clean(buf.subarray(from, from + len).toString('latin1'));
  const meta = {
    title: str(3, 30),
    artist: str(33, 30),
    album: str(63, 30),
    year: toInt(str(93, 4)),
    comment: str(97, 30),
    genre: '',
    trackNo: null
  };
  if (buf[125] === 0 && buf[126] !== 0) meta.trackNo = buf[126];
  return meta;
}

function parseMp3(reader) {
  const meta = emptyMeta();
  meta.codec = 'MP3';
  meta.lossless = false;
  let tagEnd = 0;
  const id3 = parseId3v2(reader);
  if (id3) {
    tagEnd = id3.tagEnd;
    Object.assign(meta, Object.fromEntries(Object.entries(id3.meta).filter(([, v]) => v !== '' && v != null)));
    if (id3.cover) meta.cover = id3.cover;
  }
  const v1 = parseId3v1(reader);
  if (v1) {
    for (const [k, v] of Object.entries(v1)) {
      if ((meta[k] === '' || meta[k] == null) && v !== '' && v != null) meta[k] = v;
    }
  }

  const frame = parseMpegFrame(reader, tagEnd, reader.size);
  if (frame) {
    meta.sampleRate = frame.sampleRate;
    meta.channels = frame.channels;
    meta.bitrate = frame.bitrate;
    if (meta.duration == null) {
      const vbr = mp3VbrInfo(reader, frame);
      if (vbr && vbr.frames) {
        meta.duration = (vbr.frames * frame.samplesPerFrame) / frame.sampleRate;
        const bytes = vbr.bytes || reader.size - frame.offset;
        meta.bitrate = Math.round((bytes * 8) / meta.duration / 1000);
      } else {
        const audioBytes = Math.max(0, reader.size - frame.offset);
        meta.duration = (audioBytes * 8) / (frame.bitrate * 1000);
      }
    }
  }
  if (!meta.title) meta.title = path.basename(reader.file || '', path.extname(reader.file || ''));
  return meta;
}

// ---------------------------------------------------------------- FLAC

function parseFlac(reader) {
  const meta = emptyMeta();
  meta.codec = 'FLAC';
  meta.lossless = true;
  const magic = reader.read(0, 4);
  if (magic.toString('latin1') !== 'fLaC') return meta;
  let pos = 4;
  const vendorless = { comments: {} };
  while (pos + 4 <= reader.size) {
    const head = reader.read(pos, 4);
    if (head.length < 4) break;
    const last = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const len = (head[1] << 16) | (head[2] << 8) | head[3];
    const dataStart = pos + 4;
    if (type === 0 && len >= 34) {
      const si = reader.read(dataStart, 34);
      const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      const channels = ((si[12] >> 1) & 0x07) + 1;
      const bits = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
      const totalHi = si[13] & 0x0f;
      const totalLo = si.readUInt32BE(14);
      const total = totalHi * 4294967296 + totalLo;
      meta.sampleRate = sampleRate || null;
      meta.channels = channels;
      meta.bitsPerSample = bits;
      if (sampleRate && total) meta.duration = total / sampleRate;
    } else if (type === 4) {
      const vc = parseVorbisComment(reader, dataStart, len);
      Object.assign(vendorless.comments, vc);
    } else if (type === 6) {
      const pic = reader.read(dataStart, len);
      let p = 4;
      const mimeLen = pic.readUInt32BE(p);
      p += 4;
      const mime = pic.subarray(p, p + mimeLen).toString('latin1');
      p += mimeLen;
      const descLen = pic.readUInt32BE(p);
      p += 4 + descLen;
      p += 16; // width/height/depth/colors
      const dataLen = pic.readUInt32BE(p);
      p += 4;
      const img = pic.subarray(p, p + dataLen);
      const type_ = pic.readUInt32BE(0);
      if (img.length > 200 && (!meta.cover || type_ === 3)) {
        meta.cover = { data: Buffer.from(img), mime: mime || 'image/jpeg', type: type_ };
      }
    }
    pos = dataStart + len;
    if (last) break;
  }
  applyVorbis(meta, vendorless.comments);
  return meta;
}

function parseVorbisComment(reader, offset, length) {
  const buf = reader.read(offset, length);
  const out = {};
  if (buf.length < 8) return out;
  let p = 0;
  const vendorLen = buf.readUInt32LE(p);
  p += 4 + vendorLen;
  if (p + 4 > buf.length) return out;
  const count = buf.readUInt32LE(p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= buf.length; i += 1) {
    const len = buf.readUInt32LE(p);
    p += 4;
    if (len <= 0 || p + len > buf.length) break;
    const entry = buf.subarray(p, p + len).toString('utf8');
    p += len;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = clean(entry.slice(eq + 1));
    if (!value) continue;
    if (out[key]) out[key] = `${out[key]}, ${value}`;
    else out[key] = value;
  }
  return out;
}

function applyVorbis(meta, c) {
  if (!c) return;
  if (c.TITLE) meta.title = c.TITLE;
  if (c.ARTIST) meta.artist = c.ARTIST;
  if (c.ALBUM) meta.album = c.ALBUM;
  if (c.ALBUMARTIST || c.ALBUM_ARTIST) meta.albumArtist = c.ALBUMARTIST || c.ALBUM_ARTIST;
  if (c.DATE || c.YEAR) meta.year = toInt(c.DATE || c.YEAR);
  if (c.TRACKNUMBER) meta.trackNo = toInt(c.TRACKNUMBER);
  if (c.DISCNUMBER) meta.discNo = toInt(c.DISCNUMBER);
  if (c.GENRE) meta.genre = c.GENRE;
  if (c.COMMENT || c.DESCRIPTION) meta.comment = c.COMMENT || c.DESCRIPTION;
  if (c.COMPOSER) meta.composer = c.COMPOSER;
}

// ---------------------------------------------------------------- OGG

function parseOgg(reader) {
  const meta = emptyMeta();
  const head = reader.read(0, 64);
  if (head.subarray(0, 4).toString('latin1') !== 'OggS') return meta;

  // Идентификационный пакет
  let p = 27 + head[26];
  const first = reader.read(p, 64);
  const isOpus = first.subarray(0, 8).toString('latin1') === 'OpusHead';
  const isVorbis = first[1] === 0x76 && first.subarray(1, 7).toString('latin1') === 'vorbis';
  meta.codec = isOpus ? 'Opus' : isVorbis ? 'Vorbis' : 'Ogg';
  let preskip = 0;
  let nominal = 0;
  let granuleScale = 1;

  if (isOpus) {
    meta.channels = first[9] || null;
    preskip = first.readUInt16LE(10);
    meta.sampleRate = 48000;
    granuleScale = 48000;
  } else if (isVorbis) {
    const version = first.readUInt32LE(7);
    meta.channels = first[11] || null;
    meta.sampleRate = first.readUInt32LE(12) || null;
    nominal = first.readInt32LE(20) || 0;
    granuleScale = meta.sampleRate || 44100;
    void version;
  } else {
    return meta;
  }

  // Ищем страницу с комментариями: обычно вторая
  const scan = reader.read(0, Math.min(reader.size, 512 * 1024));
  const marker = isOpus ? 'OpusTags' : '\u0003vorbis';
  let idx = scan.indexOf(Buffer.from(marker, 'latin1'));
  let commentOffset = -1;
  if (idx >= 0) {
    // начало сегмента: идём назад до 'OggS'
    let pageStart = scan.lastIndexOf(Buffer.from('OggS', 'latin1'), idx);
    if (pageStart >= 0) {
      const segCount = scan[pageStart + 26];
      const tableEnd = pageStart + 27 + segCount;
      const payloadStart = tableEnd;
      const headerBytes = (isOpus ? 8 : 7);
      commentOffset = payloadStart + headerBytes;
    }
  }
  if (commentOffset > 0) {
    const comments = parseVorbisComment(reader, commentOffset, Math.min(reader.size - commentOffset, 256 * 1024));
    applyVorbis(meta, comments);
  }

  // Длительность: granule последней страницы
  const tailSize = Math.min(reader.size, 128 * 1024);
  const tail = reader.read(reader.size - tailSize, tailSize);
  let lastPage = -1;
  for (let i = tail.length - 27; i >= 0; i -= 1) {
    if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
      lastPage = i;
      break;
    }
  }
  if (lastPage >= 0) {
    const granule = Number(tail.readBigUInt64LE(lastPage + 6));
    if (granule > 0) {
      const samples = isOpus ? granule - preskip : granule;
      if (granuleScale) meta.duration = samples / granuleScale;
    }
  }
  if (meta.duration == null && nominal > 0) meta.duration = (reader.size * 8) / nominal;
  return meta;
}

// ---------------------------------------------------------------- MP4 / M4A

function readBoxHeader(reader, offset) {
  const head = reader.read(offset, 16);
  if (head.length < 8) return null;
  let size = head.readUInt32BE(0);
  const type = head.subarray(4, 8).toString('latin1');
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = Number(head.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = reader.size - offset;
  }
  if (size < headerSize) return null;
  return { size, type, headerSize, dataStart: offset + headerSize, end: offset + size };
}

function findBox(reader, start, end, type, depth = 0) {
  let offset = start;
  let guard = 0;
  while (offset + 8 <= end && guard < 512) {
    guard += 1;
    const box = readBoxHeader(reader, offset);
    if (!box || box.end > end + 1) return null;
    if (box.type === type) return box;
    // 'meta' — FullBox: его дети начинаются через 4 байта версии и флагов
    const childStart = box.type === 'meta' ? box.dataStart + 4 : box.dataStart;
    if (depth < 8 && CONTAINER_BOXES.has(box.type)) {
      const found = findBox(reader, childStart, Math.min(box.end, end), type, depth + 1);
      if (found) return found;
    }
    offset = box.end;
    if (box.size <= 0) break;
  }
  return null;
}

const CONTAINER_BOXES = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'meta', 'ilst', 'edts', 'dinf']);

function parseMp4(reader) {
  const meta = emptyMeta();
  meta.codec = 'AAC';
  meta.lossless = false;

  const moov = findBox(reader, 0, reader.size, 'moov');
  if (moov) {
    const mvhd = findBox(reader, moov.dataStart, moov.end, 'mvhd');
    if (mvhd) {
      const buf = reader.read(mvhd.dataStart, Math.min(32, mvhd.end - mvhd.dataStart));
      const version = buf[0];
      if (version === 1 && buf.length >= 32) {
        const timescale = buf.readUInt32BE(20);
        const duration = Number(buf.readBigUInt64BE(24));
        if (timescale) meta.duration = duration / timescale;
      } else if (buf.length >= 20) {
        const timescale = buf.readUInt32BE(12);
        const duration = buf.readUInt32BE(16);
        if (timescale) meta.duration = duration / timescale;
      }
    }
    const stsd = findBox(reader, moov.dataStart, moov.end, 'stsd');
    if (stsd) {
      // stsd: версия+флаги (4) → entryCount (4) → первый SampleEntry
      // SampleEntry: size(4) type(4) reserved(6) dataRefIndex(2) → далее поля кодека
      const sample = stsd.dataStart + 8;
      const head = reader.read(sample, 8);
      const entryType = head.length >= 8 ? head.subarray(4, 8).toString('latin1') : '';
      const codec = entryType.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (/ALAC/.test(entryType)) {
        meta.codec = 'ALAC';
        meta.lossless = true;
      } else if (/AC-3/.test(entryType)) meta.codec = 'AC-3';
      else if (/EC-3/.test(entryType)) meta.codec = 'E-AC-3';
      else if (/Opus/i.test(entryType)) meta.codec = 'Opus';
      else if (/FLAC/i.test(entryType)) {
        meta.codec = 'FLAC';
        meta.lossless = true;
      } else if (/^mp4a$/i.test(entryType)) meta.codec = 'AAC';
      else if (codec) meta.codec = codec;

      const aac = reader.read(sample + 8 + 16, 12);
      if (aac.length >= 12) {
        const channels = aac.readUInt16BE(0);
        const bits = aac.readUInt16BE(2);
        const rate = aac.readUInt32BE(8) / 65536;
        if (channels && channels < 32) meta.channels = channels;
        if (bits && bits < 64) meta.bitsPerSample = bits;
        if (rate && rate < 400000) meta.sampleRate = Math.round(rate);
      }
    }

    const ilst = findBox(reader, moov.dataStart, moov.end, 'ilst');
    if (ilst) {
      const names = {
        '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album', aART: 'albumArtist',
        '\u00a9day': 'year', '\u00a9gen': 'genre', gnre: 'genre', '\u00a9cmt': 'comment',
        '\u00a9wrt': 'composer', trkn: 'trackNo', disk: 'discNo'
      };
      let offset = ilst.dataStart;
      while (offset + 8 <= ilst.end) {
        const item = readBoxHeader(reader, offset);
        if (!item || item.size <= 0) break;
        const name = item.type;
        if (name === 'covr') {
          const databox = readBoxHeader(reader, item.dataStart);
          if (databox && databox.type === 'data') {
            const payload = reader.read(databox.dataStart + 8, databox.end - databox.dataStart - 8);
            const dtype = reader.read(databox.dataStart, 8)[3];
            if (payload.length > 200 && !meta.cover) {
              meta.cover = { data: payload, mime: dtype === 14 ? 'image/png' : 'image/jpeg', type: 3 };
            }
          }
        } else if (names[name]) {
          const databox = readBoxHeader(reader, item.dataStart);
          if (databox && databox.type === 'data') {
            const head = reader.read(databox.dataStart, 8);
            const dtype = head[3];
            const payload = reader.read(databox.dataStart + 8, databox.end - databox.dataStart - 8);
            const key = names[name];
            if (key === 'trackNo' || key === 'discNo') {
              const n = payload.length >= 4 ? payload.readUInt16BE(2) : null;
              if (n) meta[key] = n;
            } else if (key === 'genre' && dtype === 0 && payload.length >= 2) {
              const g = payload.readUInt16BE(0);
              meta.genre = MP4_GENRES[g - 1] || `#${g}`;
            } else {
              const value = clean(decodeText(payload, dtype === 2 ? 1 : 3));
              if (key === 'year') meta.year = toInt(value) ?? meta.year;
              else if (value && !meta[key]) meta[key] = value;
            }
          }
        }
        offset = item.end;
      }
    }
  }
  if (meta.duration && meta.duration > 0) {
    meta.bitrate = Math.round((reader.size * 8) / meta.duration / 1000);
  }
  return meta;
}

const MP4_GENRES = ('Blues,Classic Rock,Country,Dance,Disco,Funk,Grunge,Hip-Hop,Jazz,Metal,New Age,Oldies,Other,Pop,R&B,Rap,Reggae,Rock,Techno,Industrial,Alternative,Ska,Death Metal,Pranks,Soundtrack,Euro-Techno,Ambient,Trip-Hop,Vocal,Jazz+Funk,Fusion,Trance,Classical,Instrumental,Acid,House,Game,Radio Noise,Alt. Rock,Bass,Claim,Soul,Punk,G-Funk,Drum & Bass,Club-House,Techno-Industrial,Electronic,Pop-Folk,Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta Rap,Top 40,Christian Rap,Pop/Funk,Jungle,Industrial,Hardcore,Hard Rock,Gospel,Noise,AlternRock,Bass,Soul,Punk Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave,Techno-Industrial,Electronic,Pop-Folk,Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta Rap,Top 40,Christian Rap,Pop/Funk,Jungle,Industrial,Hardcore,Hard Rock,Gospel,Noise,AlternRock,Bass,Soul,Punk,Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave').split(',');

// ---------------------------------------------------------------- WAV

function parseWav(reader) {
  const meta = emptyMeta();
  meta.codec = 'PCM';
  meta.lossless = true;
  const header = reader.read(0, 12);
  if (header.subarray(0, 4).toString('latin1') !== 'RIFF') return meta;
  let offset = 12;
  const info = {};
  while (offset + 8 <= reader.size) {
    const head = reader.read(offset, 8);
    if (head.length < 8) break;
    const id = head.subarray(0, 4).toString('latin1');
    const size = head.readUInt32LE(4);
    const dataStart = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      const fmt = reader.read(dataStart, Math.min(size, 40));
      const format = fmt.readUInt16LE(0);
      meta.channels = fmt.readUInt16LE(2);
      meta.sampleRate = fmt.readUInt32LE(4);
      const byteRate = fmt.readUInt32LE(8);
      meta.bitsPerSample = fmt.readUInt16LE(14);
      const bitrate = byteRate * 8 / 1000;
      meta.codec = format === 3 ? 'PCM float' : format === 1 ? 'PCM' : `WAV/${format}`;
      meta.bitrate = Math.round(bitrate) || null;
      const data = findChunk(reader, 'data');
      if (data && byteRate) meta.duration = data.size / byteRate;
    } else if (id === 'LIST') {
      const list = reader.read(dataStart, Math.min(size, 256 * 1024));
      if (list.subarray(0, 4).toString('latin1') === 'INFO') {
        let p = 4;
        while (p + 8 <= list.length) {
          const cid = list.subarray(p, p + 4).toString('latin1');
          const csize = list.readUInt32LE(p + 4);
          if (p + 8 + csize > list.length) break;
          info[cid] = clean(list.subarray(p + 8, p + 8 + csize).toString('latin1'));
          p += 8 + csize + (csize % 2);
        }
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const sub = { file: reader.file, size: reader.size, read: (o, l) => reader.read(dataStart + o, l) };
      const fake = Object.create(Reader.prototype);
      Object.assign(fake, sub);
      const id3 = parseId3v2In(fake);
      if (id3) Object.assign(info, id3);
    }
    if (size <= 0) break;
    offset = dataStart + size + (size % 2);
  }
  if (info.INAM) meta.title = info.INAM;
  if (info.IART) meta.artist = info.IART;
  if (info.IPRD) meta.album = info.IPRD;
  if (info.ICRD) meta.year = toInt(info.ICRD);
  if (info.IGNR) meta.genre = info.IGNR;
  if (info.ICMT) meta.comment = info.ICMT;
  return meta;
}

// Разбор ID3v2 из уже открытого "сырого" потока (для chunk id3 внутри WAV)
function parseId3v2In(readerLike) {
  const header = readerLike.read(0, 10);
  if (header.length < 10 || header.subarray(0, 3).toString('latin1') !== 'ID3') return null;
  const size = syncsafe(header.subarray(6, 10));
  return { __size: size };
}

function findChunk(reader, id) {
  let offset = 12;
  while (offset + 8 <= reader.size) {
    const head = reader.read(offset, 8);
    if (head.length < 8) return null;
    const cid = head.subarray(0, 4).toString('latin1');
    const size = head.readUInt32LE(4);
    if (cid === id) return { offset: offset + 8, size };
    if (size <= 0) return null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

// ---------------------------------------------------------------- вход

const READERS = {
  '.mp3': parseMp3,
  '.mp2': parseMp3,
  '.mpga': parseMp3,
  '.flac': parseFlac,
  '.ogg': parseOgg,
  '.oga': parseOgg,
  '.opus': parseOgg,
  '.m4a': parseMp4,
  '.m4b': parseMp4,
  '.mp4': parseMp4,
  '.aac': parseMp4,
  '.wav': parseWav,
  '.wave': parseWav
};

/**
 * Читает теги файла. Никогда не бросает: при любой проблеме возвращает
 * метаданные, выведенные из имени файла.
 */
function readTags(filePath) {
  const ext = extOf(filePath);
  const fallback = emptyMeta();
  fallback.title = path.basename(filePath, path.extname(filePath));
  const reader = new Reader(filePath);
  reader.file = filePath;
  try {
    const parser = READERS[ext];
    if (!parser) {
      fallback.codec = ext.replace('.', '').toUpperCase();
      return fallback;
    }
    const meta = parser(reader);
    meta.filePath = filePath;
    if (!meta.title) meta.title = fallback.title;
    return meta;
  } catch {
    return fallback;
  } finally {
    reader.close();
  }
}

module.exports = { readTags, Reader, decodeText, clean, syncsafe, emptyMeta };