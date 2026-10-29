#!/usr/bin/env bash
# Sets up a self-hosted Tailscale control server (headscale) on this Linux machine, and joins this
# machine to it. Run as root:
#
#   sudo bash install.sh [--port N] [--no-udp] <domain> <certificate file> <private key file>
#
#   domain            resolves to this machine, or to a load balancer in front of it, e.g. hs.example.com
#   certificate file  PEM, with the intermediate certificates (nginx's ssl_certificate file)
#   private key file  PEM, not password protected (nginx's ssl_certificate_key file)
#   --port N          the port HTTPS listens on here (default 443). Behind a layer-4 (TCP) load
#                     balancer, its backend port: clients still use https://<domain> on 443
#   --no-udp          nothing forwards 3478/udp here (a load balancer without UDP): it is not
#                     published, and machines that cannot reach each other directly relay through
#                     this server over HTTPS instead
#
# Every machine that will join must reach <domain> on 443/tcp (and 3478/udp unless --no-udp). If
# something already listens on the HTTPS port (nginx, say), Caddy is left out and an nginx server
# block is written for you to include; the script does not touch your nginx configuration.
#
# Running it again is safe: the generated files are rewritten (the old ones kept as .bak), the
# database and keys in the Docker volume stay, and an existing user is reused.
set -euo pipefail

DIR=/opt/headscale
USER_NAME=herdr
NODE_NAME=herdr-server

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

PORT=443
UDP=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT=${2:-}; shift 2 ;;
    --port=*) PORT=${1#--port=}; shift ;;
    --no-udp) UDP=no; shift ;;
    -*) die "不认识的选项：$1" ;;
    *) break ;;
  esac
done
[ "$#" -eq 3 ] || die "用法：sudo bash $0 [--port 端口] [--no-udp] <域名> <证书文件> <私钥文件>"
DOMAIN=$1
CERT=$2
KEY=$3
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口不对：$PORT"
[ "$PORT" != 8080 ] || die "8080 留给 headscale 自己用，HTTPS 请换一个端口"
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0 ..."
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "域名不对：$DOMAIN"

# ---- 1. what this machine has --------------------------------------------------------------

say "检查环境"
for tool in docker openssl curl ss; do
  command -v "$tool" >/dev/null || die "缺少 $tool，请先安装"
done
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null; then COMPOSE=(docker-compose)
else die "缺少 Docker Compose（docker compose 插件或 docker-compose）"
fi
ok "Docker：$(docker --version | head -1)"

# the client is there; the daemon behind it must answer too, and starts most setups at boot
if ! docker info >/dev/null 2>&1; then
  warn "Docker 守护进程没有运行，尝试启动它"
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
  for _ in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker 守护进程起不来：先运行 systemctl status docker 看看原因"
fi
systemctl enable docker >/dev/null 2>&1 || true
ok "Docker 守护进程运行中"

# ---- 2. the certificate --------------------------------------------------------------------

say "检查证书"
[ -f "$CERT" ] || die "找不到证书文件：$CERT"
[ -f "$KEY" ] || die "找不到私钥文件：$KEY"
openssl x509 -in "$CERT" -noout 2>/dev/null || die "$CERT 不是 PEM 格式的证书（文件开头应该是 -----BEGIN CERTIFICATE-----）"
openssl pkey -in "$KEY" -passin pass: -noout 2>/dev/null || die "$KEY 不是 PEM 私钥，或者有密码保护（需要不带密码的私钥）"
cert_pub=$(openssl x509 -in "$CERT" -noout -pubkey | openssl sha256)
key_pub=$(openssl pkey -in "$KEY" -passin pass: -pubout | openssl sha256)
[ "$cert_pub" = "$key_pub" ] || die "证书和私钥不是一对"
ok "证书和私钥是一对"
openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null || die "证书已经过期"
ok "证书有效期到：$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)"
# the names the certificate covers: its DNS alternative names, or its CN when it has none. Matched
# here rather than with openssl's -checkhost, which not every openssl has
names=$(openssl x509 -in "$CERT" -noout -text | { grep -A1 "Subject Alternative Name" || true; } | tail -n +2 | tr ',' '\n' | sed -n 's/^ *DNS://p')
[ -n "$names" ] || names=$(openssl x509 -in "$CERT" -noout -subject | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p')
covered=no
# a wildcard name is a name here, not a pattern to match files against
set -f
for name in $names; do
  if [ "$name" = "$DOMAIN" ] || { [ "${name#\*.}" != "$name" ] && [ "${DOMAIN#*.}" = "${name#\*.}" ]; }; then covered=yes; fi
done
set +f
[ "$covered" = yes ] || die "证书不包含域名 ${DOMAIN}（证书上的域名：$(echo $names | tr ' ' ',')）"
ok "证书包含域名 $DOMAIN"
chain=$(grep -c "BEGIN CERTIFICATE" "$CERT" || true)
if [ "$chain" -lt 2 ]; then
  warn "证书文件里只有站点证书，没有中间证书，部分客户端会校验失败。"
  warn "云厂商的 nginx 证书包里，通常 *_bundle.crt 或 *.pem 才是完整证书链，建议换成那个文件。"
else
  ok "证书链完整（$chain 张证书）"
fi

# ---- 3. who has port 443 -------------------------------------------------------------------

say "检查 $PORT 端口"
MODE=caddy
holder=$(ss -ltnpH "( sport = :$PORT )" 2>/dev/null | head -1 || true)
if [ -n "$holder" ] && ! docker ps --format '{{.Names}}' | grep -qx caddy; then
  MODE=nginx
  warn "$PORT 已被占用：$holder"
  warn "不装 Caddy，改由现有的 nginx 转发给 headscale。"
else
  ok "$PORT 空着（或已是之前装的 Caddy），用 Caddy 提供 HTTPS"
fi

# ---- 4. the files --------------------------------------------------------------------------

say "生成配置（$DIR）"
mkdir -p "$DIR/certs"
backup() { [ -f "$1" ] && cp "$1" "$1.bak.$(date +%Y%m%d%H%M%S)"; true; }
install -m 600 "$CERT" "$DIR/certs/fullchain.pem"
install -m 600 "$KEY" "$DIR/certs/privkey.pem"

backup "$DIR/config.yaml"
cat > "$DIR/config.yaml" <<EOF
server_url: https://$DOMAIN
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443

noise:
  private_key_path: /var/lib/headscale/noise_private.key

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

# only this server's own relay: none of Tailscale's, which sit abroad
derp:
  server:
    enabled: true
    region_id: 999
    region_code: headscale
    region_name: Headscale Embedded DERP
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
  urls: []
  paths: []
  auto_update_enabled: false

database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true

# machines reach each other as <name>.herdr.internal; each keeps its own DNS otherwise
dns:
  magic_dns: true
  base_domain: herdr.internal
  override_local_dns: false

log:
  level: info
EOF

backup "$DIR/docker-compose.yml"
# STUN, for machines to find a direct path to each other; left out where nothing forwards UDP here
if [ "$UDP" = yes ]; then UDP_PORTS='    ports:
      - "3478:3478/udp"'; else UDP_PORTS=""; fi
if [ "$MODE" = caddy ]; then
  cat > "$DIR/Caddyfile" <<EOF
{
    https_port $PORT
    auto_https disable_redirects
    # a load balancer's HTTPS health check comes by IP, with no server name: answer it with this certificate
    default_sni $DOMAIN
}

$DOMAIN {
    tls /certs/fullchain.pem /certs/privkey.pem
    reverse_proxy headscale:8080 {
        flush_interval -1
    }
}
EOF
  cat > "$DIR/docker-compose.yml" <<EOF
services:
  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "$PORT:$PORT"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/certs:ro
      - caddy-data:/data
      - caddy-config:/config

  headscale:
    image: headscale/headscale:latest
    container_name: headscale
    restart: unless-stopped
    command: serve
$UDP_PORTS
    expose:
      - "8080"
    volumes:
      - ./config.yaml:/etc/headscale/config.yaml:ro
      - headscale-data:/var/lib/headscale

volumes:
  caddy-data:
  caddy-config:
  headscale-data:
EOF
else
  cat > "$DIR/docker-compose.yml" <<EOF
services:
  headscale:
    image: headscale/headscale:latest
    container_name: headscale
    restart: unless-stopped
    command: serve
    ports:
      # nginx on this machine forwards to it; nothing else reaches 8080
      - "127.0.0.1:8080:8080"
$( [ "$UDP" = yes ] && echo '      - "3478:3478/udp"' )
    volumes:
      - ./config.yaml:/etc/headscale/config.yaml:ro
      - headscale-data:/var/lib/headscale

volumes:
  headscale-data:
EOF
  cat > "$DIR/nginx-headscale.conf" <<EOF
# headscale behind nginx. The map block belongs in the http { } section (once per nginx).
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen $PORT ssl;
    server_name $DOMAIN;
    ssl_certificate     $DIR/certs/fullchain.pem;
    ssl_certificate_key $DIR/certs/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$server_name;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect http:// https://;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
EOF
fi
ok "已生成 config.yaml、docker-compose.yml$([ "$MODE" = caddy ] && echo "、Caddyfile" || echo "、nginx-headscale.conf")"

# ---- 5. start ------------------------------------------------------------------------------

say "启动 headscale"
(cd "$DIR" && "${COMPOSE[@]}" up -d --remove-orphans)
hs() { docker exec headscale headscale "$@"; }
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  # in Caddy mode 8080 is not published: ask through the container network instead
  [ "$MODE" = caddy ] && hs users list >/dev/null 2>&1 && break
  sleep 1
done
if ! hs users list >/dev/null 2>&1; then
  docker logs headscale --tail 30 >&2 || true
  die "headscale 没有起来，上面是它的日志"
fi
ok "headscale 已运行（$(hs version 2>/dev/null | head -1)）"

if [ "$MODE" = nginx ]; then
  say "配置 nginx"
  echo "    请把 $DIR/nginx-headscale.conf 加进 nginx："
  echo "      - map 那一段放进 nginx.conf 的 http { } 里（已经有同名 map 就不用加）；"
  echo "      - server 那一段放进你的站点配置（或 include 这个文件）；"
  echo "      - 然后：nginx -t && nginx -s reload"
  read -r -p "    配置好之后按回车继续…" _
fi

say "检查本机 $PORT 端口上的 HTTPS"
if curl -fsS --resolve "$DOMAIN:$PORT:127.0.0.1" "https://$DOMAIN:$PORT/health" >/dev/null 2>&1; then
  ok "本机 https://$DOMAIN:$PORT/health 正常"
else
  die "本机 https://$DOMAIN:$PORT/health 访问不了：检查 $([ "$MODE" = caddy ] && echo "docker logs caddy" || echo "nginx 配置和 nginx -t")"
fi
say "检查 https://$DOMAIN（经过域名解析，客户端走的路）"
if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
  ok "https://$DOMAIN/health 正常"
else
  # from this machine its own public address often does not loop back (hairpin NAT): only a warning,
  # since the machines that join come from outside. This machine itself joins through 127.0.0.1 below
  warn "从这台服务器访问 https://$DOMAIN/health 不通。很多机房不允许服务器经自己的公网地址访问自己，这不影响别的机器加入。"
  warn "请在你自己的电脑上确认：curl https://$DOMAIN/health 应该返回 {\"status\":\"pass\"}"
  warn "如果你的电脑上也不通，检查域名解析$([ "$PORT" != 443 ] && echo "、负载均衡（VIP 443 → 本机 $PORT）")和防火墙。"
  HAIRPIN=no
fi

# ---- 6. a user, and a key to join with ----------------------------------------------------

say "创建用户和加入密钥"
hs users create "$USER_NAME" >/dev/null 2>&1 && ok "已创建用户 $USER_NAME" || ok "用户 $USER_NAME 已存在"
user_id=$(hs users list -o json 2>/dev/null | python3 -c '
import json, sys
name = sys.argv[1]
for u in json.load(sys.stdin) or []:
    if u.get("name") == name: print(u.get("id")); break
' "$USER_NAME" 2>/dev/null || true)
# newer headscale takes the user id, older the name
AUTHKEY=""
for who in $user_id "$USER_NAME"; do
  if out=$(hs preauthkeys create --user "$who" --reusable --expiration 24h 2>/dev/null); then
    AUTHKEY=$(printf '%s\n' "$out" | tail -1 | tr -d '[:space:]')
    break
  fi
done
[ -n "$AUTHKEY" ] || die "生成加入密钥失败：试试 docker exec headscale headscale preauthkeys create --help"
ok "加入密钥（24 小时内有效，可重复使用）：$AUTHKEY"

# ---- 7. this machine joins ----------------------------------------------------------------

say "本机加入网络"
if [ "${HAIRPIN:-yes}" = no ]; then
  # this machine cannot reach itself through its public address: let it find the domain here.
  # Only this machine's /etc/hosts; the certificate still matches, since the name is the same
  if ! grep -qE "^[[:space:]]*127\.0\.0\.1[[:space:]]+(.*[[:space:]])?${DOMAIN//./\\.}([[:space:]]|\$)" /etc/hosts; then
    cp /etc/hosts "/etc/hosts.bak.$(date +%Y%m%d%H%M%S)"
    printf '127.0.0.1 %s  # herdr headscale: this server reaches itself here\n' "$DOMAIN" >> /etc/hosts
    ok "已在本机 /etc/hosts 里把 $DOMAIN 指向 127.0.0.1（原文件已备份）"
  fi
  [ "$PORT" = 443 ] || die "本机访问不了自己的公网地址，又没有监听 443：本机加入需要 https://$DOMAIN 能在 443 上访问到。去掉 --port 重跑，或者让 $PORT 也在 443 上可用"
  curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1 || die "改了 /etc/hosts 后，本机还是访问不了 https://$DOMAIN/health"
  ok "本机经 127.0.0.1 访问 https://$DOMAIN 正常"
fi
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --login-server="https://$DOMAIN" --authkey="$AUTHKEY" --hostname="$NODE_NAME" --accept-dns=false
IP=""
for _ in $(seq 1 15); do IP=$(tailscale ip -4 2>/dev/null | head -1 || true); [ -n "$IP" ] && break; sleep 1; done
[ -n "$IP" ] || die "本机没能拿到 Tailscale 地址：看 tailscale status"
ok "本机已加入，Tailscale 地址：$IP"

# ---- 8. what next -------------------------------------------------------------------------

say "完成"
cat <<EOF
    管理中心：https://$DOMAIN
    本机（$NODE_NAME）：$IP$([ "$UDP" = no ] && printf '\n\n    没有 UDP 3478：机器之间打不通直连时，流量经这台服务器的 HTTPS 中继，能用，只是慢一些。')$([ "$PORT" != 443 ] && printf '\n    负载均衡的空闲超时请调长（至少几分钟，能设 1 小时最好），否则客户端会频繁掉线重连。')

    你的 Mac 加入网络（装 https://tailscale.com/download/mac 的独立安装版，先不要在界面里登录）：

      /Applications/Tailscale.app/Contents/MacOS/Tailscale up --login-server=https://$DOMAIN --authkey=$AUTHKEY --hostname=my-mac

    然后在 Mac 上 ping $IP 验证。ping 不通时，检查 Clash 的 TUN 模式：把 100.64.0.0/10 设为直连。

    以后要新的加入密钥：
      docker exec headscale headscale preauthkeys create --user ${user_id:-$USER_NAME} --reusable --expiration 24h
    查看已加入的机器：
      docker exec headscale headscale nodes list

    让 herdr-web-ui 只在网络里可见：在 \`herdr plugin config-dir devswha.herdr-web-ui\` 目录的 env 文件里写
      HOST=$IP
    再重启 herdr-web-ui，Mac 上用 http://$IP:7317 访问。
EOF
