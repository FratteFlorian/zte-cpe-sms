'use strict';
//
// Small HTTP server around lib/zte.js: shows the latest messages, sends new ones.
// No external dependencies (Node built-ins only), runs on Node 18+.
//
// Start:  node server.js          (config from /etc/zte-sms/config.json)
//
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ZteClient } = require('./lib/zte');
const { Store } = require('./lib/store');

const CFG_PATH = process.env.ZTE_CONFIG || '/etc/zte-sms/config.json';

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    console.error(`Config ${CFG_PATH} not readable (${e.message}) — using defaults`);
  }
  // The config file wins: a randomly set PORT in the environment (e.g. 0) must
  // not push the service onto an unknown port.
  const port = Number(cfg.port || process.env.ZTE_PORT || process.env.PORT || 8080) || 8080;
  return {
    port,
    bind: process.env.BIND || cfg.bind || '0.0.0.0',
    host: process.env.ZTE_HOST || cfg.host || null,
    passwordFile: process.env.ZTE_PW_FILE || cfg.passwordFile || '/etc/zte-sms/password',
    limit: Number(cfg.limit || 10),
    sessionTtl: Number(cfg.sessionTtl || 90000),
    storeFile: process.env.ZTE_STORE || cfg.storeFile || '/var/lib/zte-sms/messages.json',
    // Delete from the modem right after archiving (its storage fills up otherwise).
    purgeDevice: cfg.purgeDevice !== false,
    syncSeconds: Number(cfg.syncSeconds || 60),
  };
}

const cfg = loadConfig();
const store = new Store(cfg.storeFile);

function readPassword() {
  try {
    return fs.readFileSync(cfg.passwordFile, 'utf8').replace(/\r?\n$/, '');
  } catch (e) {
    throw new Error(`Password file ${cfg.passwordFile} not readable: ${e.message}`);
  }
}

// The modem is touchy: only ever one request at a time.
let client = null;
let chain = Promise.resolve();

function withClient(fn) {
  const run = chain.then(async () => {
    if (!client) client = new ZteClient({ host: cfg.host, password: readPassword(), sessionTtl: cfg.sessionTtl });
    try {
      return await fn(client);
    } catch (e) {
      // Drop the session so the next call negotiates a new one.
      if (client) client.key = null;
      throw e;
    }
  });
  chain = run.catch(() => {});
  return run;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return reject(new Error('invalid JSON'));
        }
      }
      return resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Fetch new messages from the modem, archive them locally, then empty the device.
// Falls back to the archive when the modem does not answer.
async function syncAndList(limit) {
  return withClient(async (c) => {
    // The device hands out only a few messages per request. After deleting, the
    // next ones move up, so a single run queries repeatedly.
    let added = 0;
    let failed = null;
    let onDevice = null; // null = unknown (modem not readable)
    for (let round = 0; round < 10; round++) {
      let dev = [];
      try {
        dev = await c.messages(50);
      } catch (e) {
        failed = e;
        onDevice = null;
        break;
      }
      if (!dev.length) {
        onDevice = 0;
        break;
      }
      onDevice = dev.length;
      added += store.merge(dev);
      if (!cfg.purgeDevice) break;

      let removed = 0;
      for (const m of dev) {
        try {
          await c.deleteMessage(m.id);
          removed++;
        } catch (e) {
          console.error(`sync: ${m.id} not deleted —`, e.message);
          failed = e;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      onDevice = dev.length - removed;
      // If deleting gets stuck, stop hammering — the rest waits for the next run.
      if (onDevice > 0) break;
    }
    if (failed && store.size === 0) throw failed;
    if (failed) console.error('sync: modem not fully readable —', failed.message);
    if (added) console.log(`sync: ${added} new, ${cfg.purgeDevice ? 'removed from modem' : 'left on modem'}`);
    return { messages: store.list(limit), local: store.size, device: onDevice };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p === '/favicon.ico') return serveStatic(res, 'favicon.svg');

    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        host: cfg.host || 'auto',
        passwordFile: fs.existsSync(cfg.passwordFile),
      });
    }

    if (req.method === 'GET' && p === '/api/messages') {
      const want = Math.min(Math.max(Number(url.searchParams.get('limit') || cfg.limit), 1), 50);
      const { messages, local, device } = await syncAndList(want);
      return sendJson(res, 200, {
        messages,
        local,
        device,
        purgeDevice: cfg.purgeDevice,
        firmware: client && client.firmware ? client.firmware : null,
        host: client && client.host ? client.host : null,
      });
    }

    if (req.method === 'POST' && p === '/api/send') {
      const body = await readBody(req);
      const number = String(body.number || '').trim();
      const text = String(body.text || '').trim();
      if (!number || !text) return sendJson(res, 400, { ok: false, error: 'number and text are required' });
      if (number.length > 32) return sendJson(res, 400, { ok: false, error: 'number too long' });
      if (text.length > 1600) return sendJson(res, 400, { ok: false, error: 'text too long (max. 1600 characters)' });
      await withClient((c) => c.send(number, text));
      // The modem does not reliably keep a copy of sent messages, so archive it
      // here right away.
      const entry = store.addOutgoing(number, text);
      return sendJson(res, 200, { ok: true, number, id: entry.id });
    }

    // Deletes from the local archive (nothing is left on the modem).
    if (req.method === 'POST' && p === '/api/delete') {
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' });
      const removed = store.remove(id);
      return sendJson(res, removed ? 200 : 404, { ok: removed, id });
    }

    return sendJson(res, 404, { ok: false, error: 'unknown path' });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error(new Date().toISOString(), req.method, p, '->', msg);
    return sendJson(res, 502, { ok: false, error: msg });
  }
});

server.listen(cfg.port, cfg.bind, () => {
  console.log(`SMS WebUI on http://${cfg.bind}:${cfg.port} (modem: ${cfg.host || 'auto-detect'})`);
  console.log(`archive: ${cfg.storeFile} · purge modem: ${cfg.purgeDevice ? 'yes' : 'no'} · sync every ${cfg.syncSeconds}s`);
});

// Poll even without an open page, so the modem stays empty.
const tick = () => syncAndList(1).catch((e) => console.error('auto-sync:', e.message));
setTimeout(tick, 5000);
setInterval(tick, Math.max(cfg.syncSeconds, 15) * 1000);
