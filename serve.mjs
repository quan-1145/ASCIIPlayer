#!/usr/bin/env node
/**
 * serve.mjs — 零依赖静态服务器（必须用它打开本页面）
 *
 * 为什么需要它：
 *   · file:// 下浏览器会拦截 ES 模块加载，并禁止 canvas 读取视频像素
 *   · 视频需要 HTTP Range 请求才能拖动进度条（本服务器支持 206 分片响应）
 *
 * 用法：
 *   node serve.mjs                  # http://localhost:8080
 *   node serve.mjs --port 9000
 *   node serve.mjs --port 0         # 随机端口，启动后打印 DSH_SERVER_PORT=xxxx
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 8080));
const HOST = arg('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const p = normalize(join(root, decoded));
  if (p !== root && !p.startsWith(root + sep)) return null; // 目录穿越保护
  return p;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const len = Number(b);
    if (!len) return null;
    return { start: Math.max(0, size - len), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (Number.isNaN(start) || start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
      return;
    }
    let path = safeJoin(ROOT, req.url === '/' ? '/index.html' : req.url);
    if (!path) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let stat;
    try {
      stat = await fs.stat(path);
      if (stat.isDirectory()) {
        path = join(path, 'index.html');
        stat = await fs.stat(path);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }

    const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
    if (range && range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    if (range) {
      const len = range.end - range.start + 1;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = String(len);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      createReadStream(path, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`DSH_SERVER_PORT=${port}`);
  console.log(`ASCII ART VIDEO PLAYER → http://${HOST}:${port}/`);
  console.log(`静态根目录: ${ROOT}`);
});

export { server };
