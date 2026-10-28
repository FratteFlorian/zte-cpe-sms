# ZTE SMS WebUI

> ## ⚠️ No authentication — LAN only, never on the internet
>
> There is **no login**. Every request that reaches the server is accepted, so anyone on
> your network can read your SMS and send messages in your name. Do not port-forward this
> service, do not put it on a reverse proxy without its own authentication, do not expose
> it through a tunnel — use a VPN for remote access. Binding to `127.0.0.1` behind a
> properly authenticated proxy is the only safe way to make it reachable from outside.

Small web UI for ZTE 5G CPEs: shows the last 10 SMS and sends new ones. Every message is
**archived locally and then deleted from the modem**, so the SIM storage never fills up.

It runs as a systemd service on any small Linux host — one core, 512 MB RAM and a few MB
of disk are plenty — or in Docker ([see below](#docker-instead-of-systemd)). No npm
dependencies, Node built-ins only (tested with Node 18).

```
http://<host-ip>:8080
```

## Layout

| File | Purpose |
|---|---|
| `server.js` | HTTP server, sync with the modem, `/api/messages`, `/api/send`, `/api/delete` |
| `lib/zte.js` | modem client: login, RSA/AES key exchange, read, send, delete |
| `lib/store.js` | local archive (JSON, max. 500 entries) |
| `public/index.html` | UI (message list + send form, refresh every 30 s) |
| `Dockerfile`, `docker-compose.yml` | container setup, see [Docker](#docker-instead-of-systemd) |

After installation, on the host:

| Path | Contents |
|---|---|
| `/opt/zte-sms/` | this code |
| `/etc/zte-sms/config.json` | settings, see [step 3](#3-configjson) (600) |
| `/etc/zte-sms/password` | router password, one line (600) |
| `/var/lib/zte-sms/messages.json` | SMS archive, created by `StateDirectory=zte-sms` |
| `/etc/systemd/system/zte-sms.service` | service, `Restart=always` |

## Install on a Linux host

The commands below assume Debian/Ubuntu and root; paths are the same on any systemd
distribution.

**Prerequisites**

* **Node.js 18 or newer** — `node -v`. Debian 12 ships 18; on older releases install it
  from NodeSource or a backport.
* **`tracepath`** (iputils) — used to find the modem's address.
  `apt install iputils-tracepath`. Skip it if you set `"host"` explicitly.

### 1. Copy the code

From the repository root:

```bash
mkdir -p /opt/zte-sms
cp -r webui/. /opt/zte-sms/
chown -R root:root /opt/zte-sms
```

You end up with `/opt/zte-sms/server.js`, `/opt/zte-sms/lib/` and
`/opt/zte-sms/public/`.

### 2. Password file

The service needs the **router's web UI password** as a plain text file containing only
the password. One trailing newline is stripped, quotes are *not* stripped.

```bash
mkdir -p /etc/zte-sms && chmod 700 /etc/zte-sms
touch /etc/zte-sms/password && chmod 600 /etc/zte-sms/password
printf '%s' 'your-router-password' > /etc/zte-sms/password
```

The file is created empty and `chmod`-ed first, then filled — so the password is never
briefly readable by others. Plain `mkdir`/`touch`/`chmod` instead of `install`, because
`install` is GNU coreutils and not available everywhere (Git Bash on Windows, for
example).

* The file is read on every sync, not just at startup — rotating the password does not
  need a restart.
* If it is missing or unreadable, the API answers HTTP 502 with the reason
  (`Password file … not readable`) and the log shows the same text.
* Different location? Set `"passwordFile": "/path/file"` in the config below.
* Keep it out of the repository — `password`, `*.password` and `pwd.txt` are in
  `.gitignore`.

### 3. config.json

The service reads `/etc/zte-sms/config.json` on startup. The file is **optional** — without
it every default below applies — but you want it at least once to set `host` or to turn
off deleting from the modem.

```bash
touch /etc/zte-sms/config.json && chmod 600 /etc/zte-sms/config.json
cat > /etc/zte-sms/config.json <<'EOF'
{
  "port": 8080,
  "bind": "0.0.0.0",
  "host": null,
  "passwordFile": "/etc/zte-sms/password",
  "storeFile": "/var/lib/zte-sms/messages.json",
  "purgeDevice": true,
  "limit": 10,
  "syncSeconds": 60,
  "sessionTtl": 90000
}
EOF
```

| Key | Default | Meaning |
|---|---|---|
| `port` | `8080` | HTTP port |
| `bind` | `"0.0.0.0"` | listen address; use `"127.0.0.1"` behind a reverse proxy |
| `host` | `null` | modem address; `null` = auto-detect (hop 2, see [main README](../README.md#modem-address)) |
| `passwordFile` | `"/etc/zte-sms/password"` | router password, one line |
| `storeFile` | `"/var/lib/zte-sms/messages.json"` | local archive |
| `purgeDevice` | `true` | delete from the modem after archiving |
| `limit` | `10` | how many messages the UI shows |
| `syncSeconds` | `60` | background sync interval |
| `sessionTtl` | `90000` | reuse the modem session for this long (ms) before logging in again |

Environment variables that also work: `ZTE_CONFIG` (path to a different config file),
`ZTE_HOST`, `ZTE_PW_FILE`, `ZTE_STORE`, `ZTE_PORT`, `BIND`. A value in `config.json` wins
over `PORT`, so a stray `PORT=0` in the environment cannot move the service to an unknown
port.

`host: null` means the modem address is detected at startup (hop 2 behind the home
router; see `discoverHost()` in `lib/zte.js` and the "Modem address" section in the main
README for edge cases). After a power cycle of the modem this works again — as long as
the service restarts (`systemctl restart zte-sms`), because the detected address is cached
in the client.

### 4. systemd unit

```bash
cat > /etc/systemd/system/zte-sms.service <<'EOF'
[Unit]
Description=ZTE CPE SMS web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/zte-sms
ExecStart=/usr/bin/node /opt/zte-sms/server.js
Environment=ZTE_CONFIG=/etc/zte-sms/config.json
StateDirectory=zte-sms
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
```

* `ExecStart` must point at your node binary — check with `command -v node`. With nvm or
  a NodeSource package the path can be `/usr/local/bin/node`.
* `StateDirectory=zte-sms` creates `/var/lib/zte-sms` (mode 700, correct owner) and keeps
  it writable despite `ProtectSystem=strict` — that is where the archive lives.
* The service runs as root by default. To run it unprivileged, add `User=zte` (and
  `Group=zte`) and `chown` the password file and the state directory accordingly; both
  are then owned by that user.
* `ProtectHome=yes` means a password file inside `/root` or `/home` is not readable by the
  service — keep it in `/etc/zte-sms`.

Then enable and start:

```bash
systemctl daemon-reload
systemctl enable --now zte-sms
systemctl status zte-sms --no-pager
journalctl -u zte-sms -n 20 --no-pager
```

Expected log lines on a healthy start:

```
SMS WebUI on http://0.0.0.0:8080 (modem: auto-detect)
archive: /var/lib/zte-sms/messages.json · purge modem: yes · sync every 60s
```

### 5. Check it

```bash
curl -s 'http://localhost:8080/api/messages?limit=1'
```

This also triggers one sync with the modem, so the first answer already shows the archive
size (`local`) and what is still on the device (`device`). Then open
`http://<host-ip>:8080` in a browser.

If it does not work:

| Symptom | Cause |
|---|---|
| HTTP 502, `Password file … not readable` | password file missing, or unreadable for the service user (see `ProtectHome` above) |
| log `modem: auto-detect`, requests fail | `tracepath` missing, or hop 2 is not the modem — set `"host"` |
| `device` is `null` in the API answer | modem did not answer; check the address and that the device is reachable |
| page loads, list stays empty | archive empty and modem has no messages |

## Docker (instead of systemd)

`Dockerfile` and `docker-compose.yml` are included; the image is `node:22-alpine` plus
`iputils` (for `tracepath`), no npm install step.

The container needs the same two files as the native install — create them first, with the
steps above (**2** and **3**), while ignoring the parts about `/opt/zte-sms`:

```bash
mkdir -p /etc/zte-sms && chmod 700 /etc/zte-sms
touch /etc/zte-sms/password && chmod 600 /etc/zte-sms/password
printf '%s' 'your-router-password' > /etc/zte-sms/password
```

Then, from `webui/`:

```bash
docker compose up -d --build
docker compose logs -f          # "SMS WebUI on http://0.0.0.0:8080 (modem: auto-detect)"
curl -s 'http://localhost:8080/api/messages?limit=1'
```

| Detail | Why |
|---|---|
| `network_mode: host` | The modem is found via hop 2 of a traceroute. In a bridge network hop 2 is the Docker gateway instead — measured: hop 1 `172.17.0.1`, hop 2 `192.168.68.1` (the home router), so every request goes to the wrong device. With the host network namespace the view is identical to a native install. |
| `/etc/zte-sms` mounted read-only | The container may read the password but never change it. |
| Named volume `zte-sms-data` on `/var/lib/zte-sms` | Holds the archive, which is the only copy. `docker compose down -v` would delete it. |
| Healthcheck from the image | Fetches the static page only (never the modem) and reads `port` from `config.json`, so it stays correct if you change the port. |

**No host networking available** (Docker Desktop on macOS/Windows, rootless setups, a
modem behind an extra hop): drop `network_mode: host`, publish the port instead
(`ports: ["8080:8080"]`) and set the address explicitly:

```yaml
    environment:
      ZTE_HOST: 192.0.2.10
```

Other notes:

* The container runs as root so it can read the 600 password file. For an unprivileged
  run add `user: "1000:1000"` and `chown` the password file and the volume to that user.
* Updating: `git pull && docker compose up -d --build`.
* `docker compose config` prints the merged file if something looks off; `docker inspect
  zte-sms --format '{{.State.Health.Status}}'` shows the health state.

## Archive and modem storage

On every request (page open) and additionally every 60 s in the background:

1. read new messages from the modem
2. store them locally in `/var/lib/zte-sms/messages.json` (idempotent on `id` + date)
3. delete them from the modem afterwards

The device returns only a few messages per request — `data_per_page=10` hangs, so the
client asks for 5. After deleting, the next ones move up, which is why a single sync run
queries up to 10 times in a row. An existing backlog is therefore collected completely on
the first start.

Sent messages are **archived at send time** (ID `s<timestamp>`), because the device does
not reliably keep its own copy; if it does, the duplicate is skipped via a signature built
from number/text/minute. Every sent message is guaranteed to be in the list.

The UI shows two counters: "N local" (archive) and "N on modem" (what is still on the
device — 0 in normal operation; when it turns amber, deleting is stuck).

Two device quirks the code accounts for:

- `order_by` in the `sms_data_total` query is **mandatory**: without it the device always
  replies `{"messages":[]}`, no matter how many messages are stored.
- `data_per_page=10` **hangs** (63 s timeout, reproducible). 8 and fewer answer in
  12–37 ms, so the client reads at most 5 per page.

The archive is the only copy — if the host dies, the messages are gone. Back up
`/var/lib/zte-sms/messages.json` (or snapshot the whole host) if that matters. Deleting
from the device can be switched off with `"purgeDevice": false`.

## API

```bash
curl http://<host-ip>:8080/api/messages?limit=10
curl -X POST http://<host-ip>:8080/api/send \
     -H 'Content-Type: application/json' \
     -d '{"number":"+436601234567","text":"Hello"}'
curl -X POST http://<host-ip>:8080/api/delete \
     -H 'Content-Type: application/json' -d '{"id":"42"}'   # from the archive
```

`/api/messages` returns
`{messages:[{id,tag,date,number,text,archived}],local,device,purgeDevice,host,firmware}`
where `local` is the archive size and `device` is what is still on the modem (`null` if
the device does not answer). `tag` is `"0"`/`"1"` inbound, `"2"` sent, `"4"` draft (the
device uses 0 for read and 1 for unread inbound messages). The call also triggers a sync
with the modem.

`/api/delete` removes an entry from the **archive** (nothing is left on the modem).
Errors come back as HTTP 502 with `{ok:false,error:"…"}`.

Deleting on the device itself uses `goformId=DELETE_SMS&msg_id=<id>` — the ID stays
plaintext (only `Number`/`MessageBody` are AES-encrypted when sending), but `AD` still has
to be fresh.

## Deploying changes

```bash
rsync -a --delete webui/ <user>@<host>:/opt/zte-sms/
ssh <user>@<host> 'systemctl restart zte-sms && systemctl status zte-sms --no-pager'
```

Use a dedicated, passphrase-less SSH key for deployment — a passphrase-protected key does
not work in scripts without an agent. `--delete` also removes files you deleted locally,
which is what you want for `/opt/zte-sms`.

## Operations

```bash
journalctl -u zte-sms -f          # live log
systemctl restart zte-sms         # after config or code changes
systemctl status zte-sms          # is it running?
```

Sizing: 1 core, 512 MB RAM, 4 GB disk. Give the host a fixed address (DHCP reservation or
static) so the URL stays valid.

## Protocol note

The modem rotates `RD` during the key exchange. `AD` must be recomputed **after** that,
otherwise every write command is answered with `{"result":"failure"}` — regardless of
whether the command is correct. Details in the header of `lib/zte.js` and in
[docs/PROTOCOL.md](../docs/PROTOCOL.md).
