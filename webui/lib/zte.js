'use strict';
//
// ZTE MC889 API client (read and send SMS).
//
// Protocol (verified on a device running BD_ATMC889V1.0.0B19):
//   1. login  : password = SHA256_upper( SHA256_upper(pw) + LD )
//   2. key ex : cmd=web_crt_get -> RSA public key, encrypt 32 random bytes with
//               it (PKCS#1 v1.5) and set them via goformId=web_http_enstr_set.
//               Answer {"result":"success"}.
//   3. IMPORTANT: the device rotates RD during the key exchange. AD has to be
//               recomputed afterwards, otherwise every write command fails:
//               AD = SHA256_upper( SHA256_upper(wa_inner_version + cr_version) + RD )
//   4. fields travel as base64( iv(12) | tag(16) | ct ), AES-256-GCM.
//   5. send: goformId=SEND_SMS, Number + MessageBody encrypted
//               (text pre-encoded as UCS-2 hex), encode_type=GSM7_default, ID=-1.
//
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

const TMO = 15000;
const UA = 'zte-sms-webui/1.0';

const sh = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();

// Without ZTE_HOST: the modem is hop 2 behind the home router (hop 1 = router).
function discoverHost() {
  try {
    const out = execFileSync('tracepath', ['-n', '-m', '4', '8.8.8.8'], {
      encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^\s*2:\s+(\d{1,3}(?:\.\d{1,3}){3})/m);
    if (m) return m[1];
  } catch { /* ignore */ }
  return null;
}

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
  } catch {
    return '';
  }
}

function fmtDate(d) {
  if (!d) return '';
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

class ZteClient {
  constructor({ host, password, sessionTtl = 90000 } = {}) {
    this.host = host || null;
    this.password = password;
    this.sessionTtl = sessionTtl;
    this.key = null;
    this.ad = null;
    this.at = 0;
    this.cookie = '';
    this.base = null;
  }

  get baseUrl() {
    if (!this.base) {
      const host = this.host || (this.host = discoverHost());
      if (!host) throw new Error('cannot determine modem address — set ZTE_HOST');
      this.base = 'http://' + host;
    }
    return this.base;
  }

  async raw(path, method, body, headers) {
    const url = new URL(path.startsWith('http') ? path : this.baseUrl + path);
    const h = {
      Referer: this.baseUrl + '/index.html',
      'User-Agent': UA,
      Accept: '*/*',
      Connection: 'close',
      ...headers,
    };
    if (this.cookie) h.Cookie = this.cookie;
    if (body) {
      h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const sc = res.headers['set-cookie'];
            if (sc && sc.length) {
              const kv = String(sc[0]).split(';')[0];
              if (kv.includes('=')) this.cookie = kv;
            }
            resolve(data);
          });
          res.on('error', reject);
        }
      );
      req.setTimeout(TMO, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async call(path, { method = 'GET', body = null, tries = 4 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const text = await this.raw(path, method, body);
        if (!text) throw new Error('empty response');
        return JSON.parse(text);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw new Error(`request failed: ${last && last.message}`);
  }

  cmd(name, extra = {}) {
    const parts = [`cmd=${name}`];
    for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${encodeURIComponent(v)}`);
    return this.call('/goform/goform_get_cmd_process?' + parts.join('&'));
  }

  adFrom(s) {
    return sh(sh((s.wa_inner_version || '') + (s.cr_version || '')) + (s.RD || ''));
  }

  async connect() {
    if (!this.password) throw new Error('no modem password configured');
    const salts = await this.cmd('wa_inner_version,cr_version,RD,LD', { multi_data: '1' });
    const login = await this.call(
      '/goform/goform_set_cmd_process?' +
        new URLSearchParams({
          isTest: 'false',
          goformId: 'LOGIN',
          password: sh(sh(this.password) + (salts.LD || '')),
        }).toString(),
      { tries: 2 }
    );
    if (String(login.result) !== '0') throw new Error(`login rejected (result=${login.result})`);
    const who = await this.cmd('loginfo', { multi_data: '1' });
    if (who.loginfo !== 'ok') throw new Error('session not established');

    const crt = await this.cmd('web_crt_get');
    const crtRaw = crt.result || crt.crt;
    if (!crtRaw || String(crtRaw).length < 100) throw new Error('no certificate from device');
    const m = String(crtRaw).match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
    const label = m ? m[1] : 'PUBLIC KEY';
    const body = (m ? m[2] : String(crtRaw)).replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
    const pem = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;

    const keyHex = crypto.randomBytes(32).toString('hex');
    const enc = crypto
      .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(keyHex, 'utf8'))
      .toString('base64');
    const setKey = await this.call('/goform/goform_set_cmd_process', {
      method: 'POST',
      body: new URLSearchParams({
        isTest: 'false',
        goformId: 'web_http_enstr_set',
        web_enstr: enc,
        AD: this.adFrom(salts),
      }).toString(),
      tries: 2,
    });
    if (String(setKey.result) !== 'success') throw new Error('key exchange failed');

    // RD rotates -> fetch AD again (otherwise SEND_SMS fails with "failure").
    const after = await this.cmd('wa_inner_version,cr_version,RD,LD', { multi_data: '1' });
    this.key = Buffer.from(keyHex, 'hex');
    this.ad = this.adFrom(after);
    this.at = Date.now();
    this.firmware = after.wa_inner_version || '';
    return true;
  }

  async session() {
    if (this.key && Date.now() - this.at < this.sessionTtl) return;
    await this.connect();
  }

  async withSession(fn) {
    await this.session();
    try {
      return await fn();
    } catch (e) {
      this.key = null;
      await this.connect();
      return fn();
    }
  }

  async messages(limit = 10) {
    return this.withSession(async () => {
      const out = [];
      const seen = new Set();
      for (let page = 0; page < 5 && out.length < limit; page++) {
        // Two quirks of this device, both measured on the hardware:
        //  - order_by is REQUIRED: without it the answer is always {"messages":[]}
        //  - data_per_page=10 hangs the request (63 s timeout),
        //    8 or fewer answer in 12-37 ms -> at most 5 per page.
        const d = await this.cmd('sms_data_total', {
          page: String(page),
          data_per_page: String(Math.min(limit, 5)),
          mem_store: '1',
          tags: '10',
          order_by: 'order by id desc',
        });
        const batch = d.messages || [];
        if (!batch.length) break;
        let fresh = 0;
        for (const msg of batch) {
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          out.push({
            id: String(msg.id),
            tag: String(msg.tag),
            date: fmtDate(msg.date),
            number: decryptField(msg.number, this.key),
            text: decryptField(msg.content, this.key),
          });
          fresh++;
        }
        if (fresh === 0) break;
      }
      out.sort((a, b) => Number(b.id) - Number(a.id));
      return out.slice(0, limit);
    });
  }

  async send(number, text) {
    if (!number || !text) throw new Error('number and text are required');
    return this.withSession(async () => {
      const payload = {
        isTest: 'false',
        goformId: 'SEND_SMS',
        notCallback: 'true',
        ID: '-1',
        Number: gcm(this.key, number),
        sms_time: smsTime(),
        MessageBody: gcm(this.key, ucs2hex(text)),
        encode_type: 'GSM7_default',
        AD: this.ad,
      };
      const res = await this.call('/goform/goform_set_cmd_process', {
        method: 'POST',
        body: new URLSearchParams(payload).toString(),
        tries: 2,
      });
      if (String(res.result) !== 'success') throw new Error(`Modem: ${JSON.stringify(res)}`);
      return true;
    });
  }

  // Deleting needs no GCM: msg_id stays plaintext, but AD must be fresh.
  async deleteMessage(id) {
    if (!/^\d+$/.test(String(id))) throw new Error('invalid message id');
    return this.withSession(async () => {
      const res = await this.call('/goform/goform_set_cmd_process', {
        method: 'POST',
        body: new URLSearchParams({
          isTest: 'false',
          goformId: 'DELETE_SMS',
          msg_id: String(id),
          notCallback: 'true',
          AD: this.ad,
        }).toString(),
        tries: 2,
      });
      if (String(res.result) !== 'success') throw new Error(`Modem: ${JSON.stringify(res)}`);
      return true;
    });
  }
}

module.exports = { ZteClient, decryptField, ucs2hex, gcm, discoverHost };
