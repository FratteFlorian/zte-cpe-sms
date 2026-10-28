# Build context is the repository root:
#   docker build -t zte-cpe-sms .
#   docker compose up -d --build
#
# Small runtime image: the server has no npm dependencies, Node built-ins only.
FROM node:22-alpine

# tracepath (iputils) is used to find the modem address (hop 2 of a traceroute).
# Without it, set ZTE_HOST / "host" in the config instead.
RUN apk add --no-cache iputils

WORKDIR /app

# Only the web UI goes into the image — the CLI (zte-sms.js) stays outside.
COPY webui/server.js ./
COPY webui/lib ./lib
COPY webui/public ./public

# The archive is written here; mount a volume over it.
RUN mkdir -p /var/lib/zte-sms

ENV ZTE_CONFIG=/etc/zte-sms/config.json

EXPOSE 8080

# Only fetches the static page, so it never touches the modem. The port is read
# from the config file — a hardcoded 8080 would report unhealthy for a service
# running on any other port.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(process.env.ZTE_CONFIG||"/etc/zte-sms/config.json","utf8"))}catch{};const port=c.port||process.env.ZTE_PORT||8080;fetch("http://127.0.0.1:"+port+"/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["node", "server.js"]
