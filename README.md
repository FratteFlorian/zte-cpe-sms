# zte-cpe-sms — SMS toolkit for ZTE 5G CPEs

Unofficial SMS toolkit for ZTE 5G CPEs (MC889 / MC888, firmware `BD_ATMC889V1.0.0B19`
and similar). Talks to the router's internal JSON API directly — no browser, no web UI,
no SIM swapping.

It can

* **read** messages from the device,
* **send** messages,
* **delete** them from the device,
* keep a **local archive** (the web UI does read → archive → delete, so the SIM never fills up).

Everything is plain Node.js with zero dependencies (Node 18+).

```
zte-sms.js            CLI: read and send
webui/                small web UI + local archive (systemd service)
docs/PROTOCOL.md      the API details, including the traps
```

## Why

The web interface of these devices is fragile; on the unit this was built against it
truncates every response at 14 KB, which breaks the UI completely. The JSON API behind
it keeps working, so the toolkit bypasses the UI entirely.

## Protocol findings worth knowing

Full details in [docs/PROTOCOL.md](docs/PROTOCOL.md). The three things that cost the
most time and are not documented anywhere:

1. **`AD` must be recomputed after the key exchange.** The device rotates `RD` when you
   set the session key, so an `AD` computed at login time is stale. With a stale `AD`
   every write command answers `{"result":"failure"}` — even a perfectly valid one.
2. **`order_by` is mandatory** in `sms_data_total`. Without it the device always replies
   `{"messages":[]}`, no matter how many messages are stored.
3. **`data_per_page=10` hangs** (63 s timeout, reproducible). 8 or fewer reply in
   milliseconds; the client uses 5 per page.

## Quick start (CLI)

```bash
mkdir -p ~/.config/zte && chmod 700 ~/.config/zte
touch ~/.config/zte/password && chmod 600 ~/.config/zte/password
printf '%s' 'your-router-password' > ~/.config/zte/password

node zte-sms.js                            # read all messages
node zte-sms.js --send +436601234567 "Hi" # send
```

The modem address is resolved automatically — see [Modem address](#modem-address) below.

## Where the password goes

What is needed is the **web UI password of the router** — the one you would type into
its login page. Nothing else: no API token, no PIN of the SIM.

The password is stored as a **plain text file containing only the password** (a single
trailing newline is stripped, quotes are *not* stripped — do not add any).

| Component | Default path | How to change it |
|---|---|---|
| CLI (`zte-sms.js`) | `~/.config/zte/password` | `ZTE_PW_FILE=/path/file node zte-sms.js` or pass the path as the first argument: `node zte-sms.js /path/file` |
| Web UI / service | `/etc/zte-sms/password` | `"passwordFile": "/path/file"` in `/etc/zte-sms/config.json` |

Recommended permissions (the file holds a device password):

```bash
# CLI
mkdir -p ~/.config/zte && chmod 700 ~/.config/zte
touch ~/.config/zte/password && chmod 600 ~/.config/zte/password

# service (runs as root, reads the file on every sync)
mkdir -p /etc/zte-sms && chmod 700 /etc/zte-sms
touch /etc/zte-sms/password && chmod 600 /etc/zte-sms/password
```

The file is created empty and `chmod`-ed first, then filled — so the password is never
briefly world-readable. Plain `mkdir`/`touch`/`chmod` instead of `install` on purpose:
`install` is GNU coreutils and not available in every environment (Git Bash on Windows,
for example).

Notes:

* The file must exist and be readable by the user running the tool — otherwise the CLI
  exits with `Password file not found: …` and the service answers HTTP 502 with the reason.
  A path given on the command line is always used, even if it does not exist: a typo is
  reported together with the default path instead of silently falling back to it.
* It is read on every request (so you can rotate the password without restarting the
  service). Nothing is cached to disk and the password is never written to logs.
* Do not commit it: `password`, `*.password` and `pwd.txt` are in `.gitignore`.
* The password itself is never sent in clear text — the login sends
  `SHA256( SHA256(password) + LD )`, see [docs/PROTOCOL.md](docs/PROTOCOL.md).
* If you prefer not to keep a file at all, the CLI accepts the path via `ZTE_PW_FILE`;
  the service needs a file, since it has no interactive shell.

## Modem address

The CPE is not on your LAN. It sits **upstream** of the home router (the router's WAN
port is plugged into the modem), so a packet leaving your machine travels:

```
laptop → home router (hop 1) → modem (hop 2) → carrier (hop 3+)
```

The modem is the next device that routes the packet, so **hop 2 of a traceroute is the
modem's LAN address**. The toolkit calls

```bash
tracepath -n -m 4 8.8.8.8   # take the IP from the line " 2: …"
```

and uses the second hop. That also survives reboots, after which the modem usually gets
a different address from the router's DHCP pool.

**Requirements:** `tracepath` from iputils.

```bash
apt install iputils-tracepath     # Debian/Ubuntu
pacman -S iputils                 # Arch
dnf install iputils                # Fedora
```

**If the detection does not work for your setup**, set the address explicitly:

| Where | What |
|---|---|
| CLI | `ZTE_HOST=192.0.2.10 node zte-sms.js` |
| web UI | `"host": "192.0.2.10"` in `/etc/zte-sms/config.json` |

Then restart the service (`systemctl restart zte-sms`).

Why it can fail, and what to do:

* **No ICMP/UDP answer from hop 2.** Some carriers filter the probe; the hop shows `?`.
  Try a different target, e.g. `tracepath -n -m 4 1.1.1.1`, or set the address manually.
* **More than one hop in between** (modem in bridge mode, extra switches, VLANs).
  Then hop 2 is not the modem — set the address manually.
* **Finding it by hand:** open your router's admin UI and look at its WAN/DHCP client
  list; the modem is the upstream device. Alternatively plug a laptop directly into the
  modem for one session and check its default gateway.
* **The address changes on every modem reboot**, so prefer auto-detection over a
  hardcoded value. If you must pin it, reserve it in the router's DHCP table.

## Web UI

Runs on any small Linux host as a systemd service. Full step-by-step install (password
file, `config.json`, systemd unit, troubleshooting) in [webui/README.md](webui/README.md).
In short, on the host that should serve it:

```bash
mkdir -p /opt/zte-sms && cp -r webui/. /opt/zte-sms/    # from the repository root

# 1. router password, one line, mode 600
mkdir -p /etc/zte-sms && chmod 700 /etc/zte-sms
touch /etc/zte-sms/password && chmod 600 /etc/zte-sms/password
printf '%s' 'your-router-password' > /etc/zte-sms/password

# 2. optional settings, defaults are fine — see webui/README.md for every key
touch /etc/zte-sms/config.json && chmod 600 /etc/zte-sms/config.json

# 3. systemd unit — copy the block from webui/README.md
#    (/etc/systemd/system/zte-sms.service, ExecStart=/usr/bin/node /opt/zte-sms/server.js)
systemctl daemon-reload && systemctl enable --now zte-sms
curl -s 'http://localhost:8080/api/messages?limit=1'    # http://<host-ip>:8080
```

The UI lists the last 10 messages, sends new ones, shows counters for the local archive
and the messages still on the device, and polls every 60 s in the background.

**No authentication.** It is meant for a trusted LAN. Do not expose it to the internet
without putting a reverse proxy with auth in front of it.

## Tested on

| Model | Firmware | API | Notes |
|---|---|---|---|
| MC889 (outdoor CPE) | `BD_ATMC889V1.0.0B19` / `WEB_H3AAUTMC889V1.0.0B16` | `goform_get_cmd_process` / `goform_set_cmd_process` | read, send, delete, archive verified |

Other models of the same family (MC888, MC7010, MC8020) use the same command names, but
the quirks above are firmware-specific — expect differences. Reports welcome.

## Credits

The AES-GCM envelope and the "send with encrypted fields, `encode_type=GSM7_default`"
approach were cross-checked against [Kajkac/ZTE-MC-Home-assistant-repo](https://github.com/Kajkac/ZTE-MC-Home-assistant-repo).
The `AD` rotation, the `order_by` requirement and the page-size limit came out of
reverse-engineering the device's own API responses.

## Disclaimer

Unofficial project, not affiliated with ZTE or any carrier. Interoperability work on a
device you own. Use at your own risk: these are undocumented internal endpoints, and a
firmware update can change or remove them at any time. No warranty.

## License

MIT — see [LICENSE](LICENSE).
