#!/usr/bin/env node
//
// Usage:
//   node zte-sms.js                          # read messages
//   node zte-sms.js --send +43... "Text"     # send a message
//   node zte-sms.js /path/password …         # alternative password file
//
// Modem address: $ZTE_HOST, otherwise detected automatically (hop 2 behind the
// home router = the modem's LAN address).
// Password: $ZTE_PW_FILE, otherwise ~/.config/zte/password.
//
// ZTE MC889 (5G outdoor CPE) via the internal API, no web UI involved.
// Tested against BD_ATMC889V1.0.0B19 / WEB_H3AAUTMC889V1.0.0B16.
//
// Protocol (all verified on the device):
//
//   1. login  : password = SHA256_upper( SHA256_upper(pw) + LD )
//               (the UI's js/util.js passes p=1 -> SHA256 returns UPPERCASE)
//
//   2. key ex : GET cmd=web_crt_get -> RSA public key
//               client creates 32 bytes (hex), encrypts them with
//               RSA-PKCS1v1.5 and POSTs goformId=web_http_enstr_set&web_enstr=...
//               -> answer {"result":"success"}
//
//   3. WATCH OUT: the device rotates RD during the key exchange. AD therefore
//      has to be recomputed AFTER step 2, otherwise every write command is
//      rejected with {"result":"failure"}:
//          AD = SHA256_upper( SHA256_upper(wa_inner_version + cr_version) + RD )
//
//   4. payload: message fields are base64( iv(12) | tag(16) | ct ),
//               AES-256-GCM under the session key.
//               When sending, Number AND MessageBody are encrypted this way,
//               with the text pre-encoded as UCS-2 hex.
//
//   5. send   : POST goformId=SEND_SMS with
//               Number=<encrypted>, MessageBody=<encrypted>,
//               sms_time=YY;MM;DD;HH;MM;SS;+TZ, ID=-1, encode_type=GSM7_default,
//               notCallback=true, isTest=false, AD=<recomputed>
//               -> {"result":"success"} and a tag=2 entry in storage
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The modem sits on the WAN side of the home router. A packet to the internet
// travels laptop -> router (hop 1) -> modem (hop 2), so hop 2 is the modem's
// LAN address. It changes after a power cycle, hence it is resolved live.
function discoverHost() {
  if (process.env.ZTE_HOST) return process.env.ZTE_HOST;
  try {
    const out = execFileSync('tracepath', ['-n', '-m', '4', '8.8.8.8'], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^\s*2:\s+(\d{1,3}(?:\.\d{1,3}){3})/m);
    if (m) return m[1];
  } catch {
    /* tracepath missing or no answer */
  }
  return null;
}

const HOST = discoverHost();
if (!HOST) {
  console.error('Modem address not found.');
  console.error('Set ZTE_HOST=<ip>, or install iputils (tracepath) for auto-detection.');
  process.exit(2);
}
const BASE = 'http://' + HOST;
const DEFAULT_PW = path.join(os.homedir(), '.config', 'zte', 'password');
const REF = BASE + '/index.html';
const TMO = 15000;

let COOKIE = '';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

// Node's fetch/undici hangs against this device's GoAhead server, so use the
// plain http module with Connection: close.
const httpMod = require('http');

const sh = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();

function raw(path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(path.startsWith('http') ? path : BASE + path);
    const h = { Referer: REF, 'User-Agent': UA, Accept: '*/*', Connection: 'close', ...headers };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = httpMod.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        res.on('error', reject);
      }
    );
    req.setTimeout(TMO, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function http(path, { method = 'GET', body = null, tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = {};
      if (COOKIE) headers.Cookie = COOKIE;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const r = await raw(path, method, body, headers);
      const sc = r.headers['set-cookie'];
      if (sc && sc.length) {
        const kv = String(sc[0]).split(';')[0];
        if (kv.includes('=')) COOKIE = kv;
      }
      if (!r.body) throw new Error('empty body');
      return JSON.parse(r.body);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw new Error(`request failed (${path}): ${last}`);
}

const cmd = (name, extra = {}) => {
  // Keep commas raw: this httpd is picky about %2C
  const parts = [`cmd=${name}`];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${encodeURIComponent(v)}`);
  return http('/goform/goform_get_cmd_process?' + parts.join('&'));
};

const adFrom = (s) => sh(sh((s.wa_inner_version || '') + (s.cr_version || '')) + (s.RD || ''));

function pemFromCert(s) {
  const m = String(s).match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const label = m ? m[1] : 'PUBLIC KEY';
  const body = (m ? m[2] : String(s)).replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// UCS-2 hex, like the UI's encodeMessage(): four hex digits per character.
function ucs2hex(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xffff) out.push(cp.toString(16).toUpperCase().padStart(4, '0'));
    else {
      const v = cp - 0x10000;
      out.push((0xd800 | (v >> 10)).toString(16).toUpperCase().padStart(4, '0'));
      out.push((0xdc00 | (v & 0x3ff)).toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  return out.join('');
}

function gcm(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

// After decryption the text is usually hex-encoded UCS-2.
function decodeText(s) {
  const t = String(s).trim();
  if (t && t.length % 4 === 0 && /^[0-9A-Fa-f]+$/.test(t)) {
    const b = Buffer.from(t, 'hex');
    b.swap16();
    const u = b.toString('utf16le').replace(/\u0000/g, '');
    if (u.trim()) return u.trim();
  }
  return t;
}

function decryptField(value, key) {
  if (!value || typeof value !== 'string') return '';
  const hex = Buffer.from(value, 'base64').toString('hex');
  if (hex.length <= 56) return '';
  const iv = Buffer.from(hex.slice(0, 24), 'hex');
  const tag = Buffer.from(hex.slice(24, 56), 'hex');
  const ct = Buffer.from(hex.slice(56), 'hex');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return decodeText(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch (e) {
    return `[decrypt failed: ${e.message}]`;
  }
}

function fmtDate(d) {
  if (!d) return '?';
  const p = String(d).split(',');
  if (p.length < 6) return String(d);
  const [yy, mo, dd, hh, mi, ss] = p;
  const year = String(yy).length === 2 ? 2000 + Number(yy) : Number(yy);
  return `${year}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

function smsTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset() / 60;
  return `${String(d.getFullYear()).slice(-2)};${p(d.getMonth() + 1)};${p(d.getDate())};` +
         `${p(d.getHours())};${p(d.getMinutes())};${p(d.getSeconds())};${tz >= 0 ? '+' : ''}${tz}`;
}

async function connect(password) {
  const salts = await cmd('wa_inner_version,cr_version,RD,LD', { multi_data: '1' });
  const ld = salts.LD || '';
  console.log('firmware      :', salts.wa_inner_version || '?');

  const login = await http(
    '/goform/goform_set_cmd_process?' +
      new URLSearchParams({ isTest: 'false', goformId: 'LOGIN', password: sh(sh(password) + ld) }).toString(),
    { tries: 2 }
  );
  if (String(login.result) !== '0') throw new Error(`login rejected: result=${login.result}`);
  const who = await cmd('loginfo', { multi_data: '1' });
  console.log('login         :', who.loginfo === 'ok' ? 'ok' : JSON.stringify(who));
  if (who.loginfo !== 'ok') throw new Error('session not established');

  const crt = await cmd('web_crt_get');
  const crtRaw = crt.result || crt.crt;
  if (!crtRaw || String(crtRaw).length < 100) throw new Error('no certificate');
  const keyHex = crypto.randomBytes(32).toString('hex');
  const encKey = crypto
    .publicEncrypt({ key: pemFromCert(crtRaw), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(keyHex, 'utf8'))
    .toString('base64');
  const setKey = await http('/goform/goform_set_cmd_process', {
    method: 'POST',
    body: new URLSearchParams({
      isTest: 'false',
      goformId: 'web_http_enstr_set',
      web_enstr: encKey,
      AD: adFrom(salts),
    }).toString(),
    tries: 2,
  });
  if (String(setKey.result) !== 'success') throw new Error(`key exchange failed: ${JSON.stringify(setKey)}`);
  console.log('session key   : negotiated (AES-256-GCM)');

  // RD rotates during the key exchange -> fetch AD again, otherwise every
  // write command fails with {"result":"failure"}.
  const salts2 = await cmd('wa_inner_version,cr_version,RD,LD', { multi_data: '1' });
  return { key: Buffer.from(keyHex, 'hex'), ad: adFrom(salts2) };
}

async function readMessages(key) {
  const seenIds = new Set();
  const msgs = [];
  for (let page = 0; page < 200; page++) {
    const d = await cmd('sms_data_total', {
      page: String(page),
      data_per_page: '5',           // 10 hangs the request, 8 or fewer are fine
      mem_store: '1',
      tags: '10',
      order_by: 'order by id desc',
    });
    const batch = d.messages || [];
    if (!batch.length) break;
    let fresh = 0;
    for (const m of batch) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      msgs.push(m);
      fresh++;
    }
    if (fresh === 0) break;
  }
  msgs.sort((a, b) => Number(b.id) - Number(a.id));
  for (const m of msgs) {
    const num = decryptField(m.number, key) || '[?]';
    const body = decryptField(m.content, key);
    const tag = String(m.tag);
    const marker = tag === '2' ? ' (sent)' : tag === '4' ? ' (draft)' : '';
    console.log(`[${fmtDate(m.date)}] ${num}${marker}`);
    console.log('  ' + body.replace(/\n/g, '\n  '));
    console.log();
  }
}

async function sendMessage(key, ad, number, text) {
  const payload = {
    isTest: 'false',
    goformId: 'SEND_SMS',
    notCallback: 'true',
    ID: '-1',
    Number: gcm(key, number),
    sms_time: smsTime(),
    MessageBody: gcm(key, ucs2hex(text)),
    encode_type: 'GSM7_default',
    AD: ad,
  };
  const res = await http('/goform/goform_set_cmd_process', {
    method: 'POST',
    body: new URLSearchParams(payload).toString(),
    tries: 2,
  });
  return res;
}

(async () => {
  let args = process.argv.slice(2);

  // Optional password file as the first argument (default path otherwise).
  // A non-existing path is accepted too: otherwise a typo would silently fall
  // back to the default path.
  let pwFile = null;
  if (args[0] && !args[0].startsWith('-')) {
    pwFile = args[0];
    args = args.slice(1);
  }
  pwFile = pwFile || process.env.ZTE_PW_FILE || DEFAULT_PW;
  if (!fs.existsSync(pwFile)) {
    console.error(`Password file not found: ${pwFile}`);
    if (pwFile !== DEFAULT_PW) {
      // The path came from outside (argument or $ZTE_PW_FILE) — so check whether
      // it was meant at all instead of creating it blindly.
      console.error(`Expected default: ${DEFAULT_PW}`);
      console.error('Check the path, or create the file at that location on purpose:');
    }
    const dir = path.dirname(pwFile);
    console.error(`  mkdir -p "${dir}" && chmod 700 "${dir}"`);
    console.error(`  touch "${pwFile}" && chmod 600 "${pwFile}"`);
    console.error(`  printf '%s' 'your-router-password' > "${pwFile}"`);
    process.exit(2);
  }
  const pw = fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '');
  console.log('modem         :', HOST);

  const sendIdx = args.findIndex((a) => a === '--send' || a === '-s');
  const doSend = sendIdx >= 0;
  const to = doSend ? args[sendIdx + 1] : null;
  const text = doSend ? args[sendIdx + 2] : null;
  if (doSend && (!to || !text)) {
    console.error('usage: --send <number> "<text>"');
    process.exit(2);
  }

  const { key, ad } = await connect(pw);

  if (doSend) {
    const res = await sendMessage(key, ad, to, text);
    console.log('send          :', JSON.stringify(res));
    if (String(res.result) !== 'success') process.exit(1);
    console.log('\nOK — message handed to', to + '.');
    return;
  }

  console.log('-'.repeat(70));
  await readMessages(key);
})();
