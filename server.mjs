/**
 * 生产运行时静态服务器（零第三方依赖，仅需 Node 内置模块）。
 * 不依赖 vite/esbuild，容器启动即监听，避免预览工具链带来的启动不确定性。
 */
import http from 'node:http';
import { stat } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT ?? 4173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(res, filePath, statusCode = 200) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(statusCode, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
  });
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal Server Error');
    })
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 防目录穿越：解析结果必须仍在 dist 内
  let requested;
  try {
    requested = path.normalize(path.join(DIST_DIR, decodeURIComponent(pathname)));
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (requested !== DIST_DIR && !requested.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(requested);
    if (info.isFile()) {
      sendFile(res, requested);
      return;
    }
  } catch {
    // 落到 SPA 回退
  }

  // 非资源路径统一回退 index.html（单页应用）
  sendFile(res, path.join(DIST_DIR, 'index.html'));
});

server.listen(PORT, HOST, () => {
  // 容器日志中可见的确切就绪标志
  console.log(`[web] subtitle-rhythm-gate listening on http://${HOST}:${PORT}`);
});

const shutdown = (signal) => {
  console.log(`[web] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
