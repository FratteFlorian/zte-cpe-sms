# ZTE CPE internal SMS API

Everything below was verified against an **MC889** running
`BD_ATMC889V1.0.0B19` (web assets `WEB_H3AAUTMC889V1.0.0B16`), reached over plain HTTP
on the LAN side of the device.

Base paths:

```
GET  /goform/goform_get_cmd_process?cmd=<name>&multi_data=1&...
POST /goform/goform_set_cmd_process        (application/x-www-form-urlencoded)
```

Requests carry `Referer: http://<host>/index.html`. A single HTTP session cookie is
issued by the device and must be kept.

## 1. Login

```bash
GET /goform/goform_get_cmd_process?cmd=wa_inner_version,cr_version,RD,LD&multi_data=1
→ {"wa_inner_version":"BD_ATMC889V1.0.0B19","cr_version":"...","RD":"884E...","LD":"..."}

GET /goform/goform_set_cmd_process?isTest=false&goformId=LOGIN&password=<P>
→ {"result":"0"}

GET /goform/goform_get_cmd_process?cmd=loginfo&multi_data=1
→ {"loginfo":"ok"}
```

`<P>` is

```
P = SHA256_upper( SHA256_upper(password) + LD )
```

Note the **uppercase hex**: the web UI's JS uses a hash helper with `p=1` that emits
uppercase. Lowercase hashes are rejected.

## 2. Session key exchange

```bash
GET /goform/goform_get_cmd_process?cmd=web_crt_get
→ {"result":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}
```

Generate 32 random bytes (as hex text), encrypt them with RSA PKCS#1 v1.5, base64-encode
and post:

```bash
POST /goform/goform_set_cmd_process
isTest=false&goformId=web_http_enstr_set&web_enstr=<b64>&AD=<AD>
→ {"result":"success"}
```

with

```
AD = SHA256_upper( SHA256_upper(wa_inner_version + cr_version) + RD )
```

`AD` is the per-session authentication token attached to every mutating request.

## 3. The trap: `RD` rotates

**After a successful `web_http_enstr_set`, the device changes `RD`.** An `AD` computed
before (or from the salts read at login) is therefore invalid, and the device answers
`{"result":"failure"}` to every write command — indistinguishable from "wrong command".

Read the salts a second time after the key exchange and recompute `AD`:

```bash
GET /goform/goform_get_cmd_process?cmd=wa_inner_version,cr_version,RD,LD&multi_data=1
```

Verified: `RD` changed from `884E…` to `9524…` across the exchange. Sending only started
to return `success` once `AD` was recomputed afterwards.

## 4. Encrypted fields

Once the session key is set, sensitive fields are AES-256-GCM:

```
field = base64( iv(12) | tag(16) | ciphertext )
```

Decoding: split the first 28 bytes off, decrypt the rest with the session key and the
IV, verify the tag.

Message text after decryption is often **UCS-2 as hex** — four hex digits per code unit
(`"Test"` → `"0054006500730074"`). Decode only if the string is pure hex and a multiple
of 4; otherwise use it as-is.

## 5. Reading messages

```bash
GET /goform/goform_get_cmd_process
    cmd=sms_data_total
    page=0
    data_per_page=5
    mem_store=1
    tags=10
    order_by=order by id desc
→ {"messages":[{"id":"55","tag":"1","date":"26,10,28,14,51,56","number":"<enc>","content":"<enc>"}]}
```

* **`order_by` is required.** Omit it and the device answers `{"messages":[]}` even with
  dozens of stored messages.
* **`data_per_page` must stay ≤ 8.** `10` hangs the request (63 s, reproducible);
  8, 5, 3, 1 answer in 12–37 ms.
* `mem_store=1` (device memory) and `0` (SIM) both work; incoming messages appear in
  `1` on the observed firmware.
* `tags` acts as a bitmask/filter; `10` returned all messages on this firmware.
* `date` is `YY,MM,DD,HH,MM,SS` in device local time, no timezone field.
* `tag`: `1` inbound unread, `0` inbound read, `2` sent, `4` draft.

Counters such as `sms_capacity_info`, `sms_unread_count`, `sms_received_total` return
empty strings on this firmware — don't rely on them.

## 6. Sending

```bash
POST /goform/goform_set_cmd_process
isTest=false
goformId=SEND_SMS
notCallback=true
ID=-1
Number=<gcm(number)>
sms_time=YY;MM;DD;HH;MM;SS;+TZ
MessageBody=<gcm(ucs2hex(text))>
encode_type=GSM7_default
AD=<AD>
→ {"result":"success"}
```

Note the pairing: the body is UCS-2 hex **and** AES-GCM encrypted, while `encode_type`
still says `GSM7_default`. Any other combination was rejected on this firmware.

On success a `tag=2` entry *may* appear in the device storage — not reliable, so archive
outgoing messages yourself.

## 7. Deleting

```bash
POST /goform/goform_set_cmd_process
isTest=false&notCallback=true&goformId=DELETE_SMS&msg_id=<id>&AD=<AD>
→ {"result":"success"}
```

`msg_id` stays **plaintext** (only `Number`/`MessageBody` are encrypted when sending).
The message is gone on the next read.

## 8. Misc observations

* The web server of the tested unit truncates every file response at 14 006 bytes, which
  breaks the UI (`app.css`, `service.js`…). The JSON endpoints are unaffected.
* The HTTP server is touchy: use `Connection: close`, avoid concurrent requests, and
  don't kill requests mid-flight if you can avoid it — a half-closed request can wedge
  the device for a while.
* The LAN IP of the modem changes across reboots when it is DHCP client behind the home
  router; resolve it every start (hop 2 behind the router) instead of hardcoding it.
* `REBOOT_DEVICE` (`goformId=REBOOT_DEVICE`) restarts the firmware over the API. It does
  **not** replace a real power cycle.
