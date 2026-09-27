'use strict';
const fs = require('node:fs');

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendBuffer(res, status, buf, type, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(buf);
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { invalid: true };
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return { invalid: true };
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Отдаёт файл потоком с поддержкой Range — обязательное условие для seek в <audio>.
 */
function streamFile(req, res, filePath, { mime, size, extraHeaders = {}, headOnly = false } = {}) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendText(res, 404, 'File not found');
  }
  const total = size == null ? stat.size : size;
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
    ...extraHeaders
  };

  const range = parseRange(req.headers.range, total);
  if (range && range.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  if (range && range.unsatisfiable) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': mime });
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const length = Math.max(0, end - start + 1);

  const headers = { ...baseHeaders, 'Content-Length': length };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(range ? 206 : 200, headers);
  if (headOnly || req.method === 'HEAD' || length === 0) return res.end();

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { sendJson, sendText, sendBuffer, streamFile, parseRange, readBody };