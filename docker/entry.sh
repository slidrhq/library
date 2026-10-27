#!/bin/bash
# The image's entry (docs/SPEC.md §5.4), under tini:
#
#   serve        the library: its server on Node inside, Nginx at the door; the container ends
#                when either of them ends, and Docker starts it again (the default)
#   init …       installs the library: its data in /library/data, its media folder
#                /library/media, its master key in /library/keys; with --owner and --url
#   <command> …  any other command of the library's CLI: login, seed, sign-in, owner, status,
#                vault rotate (slidr-library)
#
# The folders of /library/ are folders of the machine, mounted there (the install script's
# compose.yaml). LIBRARY_URL is the address the library is reached at; LIBRARY_TRUSTED_PROXY, the
# address of the organization's proxy, when the library is behind one (`gateway`: a proxy of the
# machine itself, which reaches the container through Docker's bridge).
set -euo pipefail

BUNDLE=/app/dist/node/library.mjs
NGINX=/tmp/nginx

# The container's gateway, by its default route: the machine itself, as the container sees it.
gateway() {
  local destination via
  while read -r _ destination via _; do
    if [[ $destination == 00000000 ]]; then
      # Written backwards, in hex: 0100A8C0 is 192.168.0.1.
      printf '%d.%d.%d.%d' "0x${via:6:2}" "0x${via:4:2}" "0x${via:2:2}" "0x${via:0:2}"
      return
    fi
  done </proc/net/route
}

# What of Nginx's configuration depends on the install: its TLS, and the organization's proxy.
nginx_conf() {
  mkdir -p "$NGINX"/{client,proxy,fastcgi,uwsgi,scgi}
  if [[ -f /library/tls/cert.pem && -f /library/tls/key.pem ]]; then
    cat >"$NGINX/listen.conf" <<'EOF'
listen 8080 ssl;
http2 on;
ssl_certificate /library/tls/cert.pem;
ssl_certificate_key /library/tls/key.pem;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_session_cache shared:tls:10m;
set $slidr_proto https;
set $slidr_forwarded_host "";
EOF
  else
    cat >"$NGINX/listen.conf" <<'EOF'
listen 8080;
set $slidr_proto http;
set $slidr_forwarded_host "";
EOF
  fi
  : >"$NGINX/proxy.conf"
  : >"$NGINX/http.conf"
  local trusted=${LIBRARY_TRUSTED_PROXY:-}
  # A proxy of the machine itself reaches the container through Docker's bridge, its gateway.
  if [[ $trusted == gateway ]]; then trusted=$(gateway); fi
  if [[ -n $trusted ]]; then
    # An address or a range, and nothing else, goes into the configuration.
    if [[ ! $trusted =~ ^[0-9A-Fa-f.:/]+$ ]]; then
      echo "LIBRARY_TRUSTED_PROXY is an address or a range: '$trusted' is neither." >&2
      exit 2
    fi
    # Behind the organization's proxy, which speaks HTTPS, the library answers the proxy alone,
    # and the container itself (its health): who it forwards, and the scheme and the name it was
    # reached by, are taken from it. The connection's own address decides, not the forwarded one.
    cat >"$NGINX/http.conf" <<EOF
geo \$realip_remote_addr \$slidr_from_proxy {
    default 0;
    127.0.0.1 1;
    $trusted 1;
}
EOF
    cat >"$NGINX/proxy.conf" <<EOF
set_real_ip_from $trusted;
real_ip_header X-Forwarded-For;
if (\$slidr_from_proxy = 0) {
    return 403;
}
set \$slidr_proto https;
set \$slidr_forwarded_host \$http_x_forwarded_host;
EOF
  fi
}

# Whether the library's server answers, inside the container.
answers() {
  node -e "fetch('http://127.0.0.1:5176/api/me').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

serve() {
  nginx_conf
  local url=()
  if [[ -n "${LIBRARY_URL:-}" ]]; then url=(--url "$LIBRARY_URL"); fi
  node --enable-source-maps "$BUNDLE" start --port 5176 --behind-proxy "${url[@]}" &
  local server=$!
  echo "$server" >/tmp/slidr-node.pid
  local tries=0
  until answers; do
    if ! kill -0 "$server" 2>/dev/null; then
      wait "$server" || exit $?
      exit 1
    fi
    tries=$((tries + 1))
    if ((tries > 60)); then
      echo "The library's server did not answer within 30 seconds." >&2
      kill -TERM "$server"
      exit 1
    fi
    sleep 0.5
  done
  nginx -e stderr -c /etc/nginx/slidr/nginx.conf -g 'daemon off;' &
  local door=$!
  echo "$door" >/tmp/slidr-nginx.pid
  trap 'kill -TERM "$server" "$door" 2>/dev/null || true' TERM INT
  local code=0
  wait -n "$server" "$door" || code=$?
  kill -TERM "$server" "$door" 2>/dev/null || true
  wait || true
  exit "$code"
}

command=${1:-serve}
if (($# > 0)); then shift; fi
case "$command" in
  serve) serve ;;
  init)
    exec node --enable-source-maps "$BUNDLE" init --data /library/data --media /library/media \
      --master-key-file /library/keys/master.key "$@"
    ;;
  *) exec node --enable-source-maps "$BUNDLE" "$command" "$@" ;;
esac
