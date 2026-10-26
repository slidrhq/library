#!/usr/bin/env bash
# Installs a local Slidr Library on this Linux machine (docs/SPEC.md §5.1, §5.5): the image of
# its release, in Docker, with its media in a folder of this machine's own disks.
#
#   sudo bash install.sh                 asks what it needs, and installs
#   sudo bash install.sh --yes …         asks nothing: the options answer, the rest is default
#   sudo bash install.sh --update        on a machine where it is installed: this version
#
# It writes nothing until its summary is accepted. Run again, it keeps the library's data, keys
# and media as they are, and updates it or changes how it is reached. `--help` lists the options.
set -euo pipefail

# Written by the release (.github/workflows/release.yml): its version, and its image by digest.
VERSION=""
IMAGE=""

ETC=/etc/slidr-library
COMMAND=/usr/local/bin/slidr-library
CONTAINER=slidr-library
USER_ID=10001
CENTRAL=https://media.slidr.studio/
DEFAULT_PORT=7543
DEFAULT_DATA=/var/lib/slidr-library
DEFAULT_MEDIA=/srv/slidr-media

usage() {
  cat <<EOF
Installs a local Slidr Library${VERSION:+ $VERSION} on this machine, in Docker.

  --media <dir>         the folder of this machine that is the library's media (asked)
  --owner <email>       the owner's address, who signs in first (asked)
  --reach <way>         local (this machine only, the default), https (with a certificate
                        here) or proxy (behind the organization's own HTTPS proxy)
  --url <address>       the address the library is reached at (https and proxy)
  --tls-cert <file>     the certificate and its key (https)
  --tls-key <file>
  --proxy <address>     the proxy's address, or "local" for a proxy of this machine (proxy)
  --bind <address>      the address the port is published on (default: 127.0.0.1 for local and
                        a local proxy, every address otherwise)
  --port <n>            the port of this machine (default $DEFAULT_PORT)
  --data <dir>          the library's data folder (default $DEFAULT_DATA)
  --seed[=<address>]    fill an empty media folder from a published library (default $CENTRAL)
  --no-seed             leave it empty
  --update              update an installed library to this version, asking nothing
  --image <reference>   another image than this release's (for its tests)
  --yes                 ask nothing: what is not given is the default
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
fail() {
  printf 'X %s\n' "$*" >&2
  exit 1
}

# ---- What it is told

MEDIA="" OWNER="" REACH="" URL="" TLS_CERT="" TLS_KEY="" PROXY="" BIND="" PORT="" DATA=""
SEED="" SEED_FROM="" YES=0 UPDATE=0
while (($# > 0)); do
  case "$1" in
    --media) MEDIA=${2:?--media names a folder}; shift ;;
    --owner) OWNER=${2:?--owner names an address}; shift ;;
    --reach) REACH=${2:?--reach is local, https or proxy}; shift ;;
    --url) URL=${2:?--url names an address}; shift ;;
    --tls-cert) TLS_CERT=${2:?--tls-cert names a file}; shift ;;
    --tls-key) TLS_KEY=${2:?--tls-key names a file}; shift ;;
    --proxy) PROXY=${2:?--proxy names an address}; shift ;;
    --bind) BIND=${2:?--bind names an address}; shift ;;
    --port) PORT=${2:?--port names a port}; shift ;;
    --data) DATA=${2:?--data names a folder}; shift ;;
    --seed) SEED=yes ;;
    --seed=*) SEED=yes SEED_FROM=${1#--seed=} ;;
    --no-seed) SEED=no ;;
    --update) UPDATE=1 ;;
    --image) IMAGE=${2:?--image names an image}; shift ;;
    --yes) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "What is $1?" ;;
  esac
  shift
done

# ---- Asking

# Whether someone is at the keyboard: a terminal, even when this script came through a pipe.
at_keyboard() { ((YES == 0)) && { : </dev/tty; } 2>/dev/null; }

# ask <variable> <question> [<default>]: what was given as an option stands.
ask() {
  local name=$1 question=$2 default=${3:-} answer=""
  [[ -n ${!name} ]] && return 0
  if at_keyboard; then
    printf '%s%s: ' "$question" "${default:+ [$default]}" >/dev/tty
    IFS= read -r answer </dev/tty || true
  fi
  printf -v "$name" '%s' "${answer:-$default}"
}

# Says what is wrong with an answer: at the keyboard, the question is asked again.
again() {
  local name=$1
  shift
  warn "$*"
  at_keyboard || fail "$*"
  printf -v "$name" '%s' ""
}

# yes_no <question> <default y|n>
yes_no() {
  local answer=""
  if at_keyboard; then
    printf '%s [%s] ' "$1" "$([[ $2 == y ]] && echo 'Y/n' || echo 'y/N')" >/dev/tty
    IFS= read -r answer </dev/tty || true
  fi
  answer=${answer:-$2}
  [[ ${answer,,} == y* ]]
}

# ---- This machine

check_machine() {
  [[ $(uname -s) == Linux ]] || fail "A local library is installed on Linux only (this is $(uname -s))."
  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) fail "The image is made for x86-64 and ARM64, not $(uname -m)." ;;
  esac
  ((EUID == 0)) || fail "Run it as root: sudo bash $0"
  local tool
  for tool in docker ss findmnt curl df realpath; do
    command -v "$tool" >/dev/null || fail "This machine has no $tool: install it, then run this again."
  done
  local server
  server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    fail "Docker does not answer: install Docker Engine 24 or later (https://docs.docker.com/engine/install/), and start it."
  ((${server%%.*} >= 24)) || fail "Docker $server is too old: 24 or later."
  if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    fail "Docker runs rootless here, which this install does not take: a Docker run by root."
  fi
  local compose
  compose=$(docker compose version --short 2>/dev/null) ||
    fail "Docker has no compose plugin: install docker-compose-plugin."
  [[ ${compose#v} == 2.* || ${compose#v} == [3-9].* ]] || fail "docker compose $compose is too old: 2 or later."
  [[ -n $IMAGE ]] || fail "This script is not of a release: name the image, --image <reference>."
}

# ---- The answers of an installed library (library.env), kept as KEY='value'

load_answers() {
  local line key value
  while IFS= read -r line; do
    [[ $line =~ ^([A-Z_]+)=\'(.*)\'$ ]] || continue
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    case "$key" in
      MEDIA | OWNER | REACH | URL | PROXY | BIND | PORT | DATA)
        [[ -n ${!key} ]] || printf -v "$key" '%s' "$value"
        ;;
    esac
  done <"$ETC/library.env"
}

# ---- Checking the answers

# A path this script writes into compose.yaml as it is: plain characters only.
plain_path() { [[ $1 =~ ^/[A-Za-z0-9._/@+-]*$ && $1 != *..* ]]; }

# The nearest folder of a path that is there.
existing() {
  local at=$1
  while [[ ! -e $at ]]; do at=$(dirname "$at"); done
  printf '%s' "$at"
}

# Whether one folder is another, or holds it.
within() { [[ $1 == "$2" || $1 == "$2"/* ]]; }

check_media() {
  [[ -n $MEDIA ]] || at_keyboard || fail "Name the library's media folder: --media <dir>."
  while :; do
    ask MEDIA "Which folder of this machine is the library's media?" "$DEFAULT_MEDIA"
    if ! plain_path "$MEDIA"; then
      again MEDIA "The media folder is a full path of plain letters, digits and . _ - / (not $MEDIA)."
      continue
    fi
    MEDIA=$(realpath -m "$MEDIA")
    local type
    type=$(findmnt -no FSTYPE -T "$(existing "$MEDIA")" 2>/dev/null || true)
    case "$type" in
      nfs* | cifs | smb* | fuse | fuse.* | 9p | ceph | glusterfs | lustre | afs | davfs | virtiofs)
        again MEDIA "$MEDIA is on a network file system ($type): the media is a folder of this machine's own disks."
        continue
        ;;
    esac
    if [[ -e $MEDIA && ! -d $MEDIA ]]; then
      again MEDIA "$MEDIA is a file, not a folder."
      continue
    fi
    if [[ -d $MEDIA && ! -f $MEDIA/manifest.json ]] && [[ -n $(ls -A "$MEDIA") ]]; then
      local held
      held=$(ls -A "$MEDIA" | head -5 | tr '\n' ' ')
      if [[ -d $MEDIA/lost+found ]]; then
        again MEDIA "$MEDIA is a disk's own folder (it holds lost+found): use a folder inside it, such as $MEDIA/slidr-media."
      else
        again MEDIA "$MEDIA holds other things than a library ($held): the media folder is the library's alone. Name an empty folder."
      fi
      continue
    fi
    return 0
  done
}

check_owner() {
  [[ -n $OWNER ]] || at_keyboard || fail "Name the library's owner: --owner <email>."
  while :; do
    ask OWNER "The owner's email address, who signs in first"
    [[ $OWNER =~ ^[^[:space:]@\']+@[^[:space:]@\']+\.[^[:space:]@\']+$ ]] && return 0
    again OWNER "${OWNER:-Nothing} is not an email address."
  done
}

check_reach() {
  while :; do
    ask REACH "How is it reached: local (this machine only), https (with a certificate here), or proxy (behind your HTTPS proxy)?" local
    case "$REACH" in local | https | proxy) return 0 ;; esac
    again REACH "The way is local, https or proxy, not $REACH."
  done
}

check_port() {
  local own=${1:-}
  while :; do
    ask PORT "The port of this machine" "$DEFAULT_PORT"
    if [[ ! $PORT =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
      again PORT "$PORT is not a port."
      continue
    fi
    # The port the library runs on already is its own.
    if [[ $PORT != "$own" ]]; then
      if [[ -n $(ss -Hltn "sport = :$PORT" 2>/dev/null) ]] ||
        docker ps --format '{{.Ports}}' | grep -Eq "(:|^)$PORT->"; then
        again PORT "Port $PORT is taken on this machine: name another."
        continue
      fi
    fi
    return 0
  done
}

check_url() {
  local example=$1
  while :; do
    ask URL "The address it is reached at" "$example"
    if [[ $URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
      URL=${URL%/}
      return 0
    fi
    again URL "The address is https://, a name, and a port when it is not 443 (not $URL)."
  done
}

check_tls() {
  while :; do
    ask TLS_CERT "The certificate (PEM, its chain after it)"
    ask TLS_KEY "Its private key (PEM)"
    if [[ ! -r $TLS_CERT || ! -r $TLS_KEY ]]; then
      again TLS_CERT "The certificate and its key are files this machine can read."
      TLS_KEY=""
      continue
    fi
    if command -v openssl >/dev/null; then
      local cert key
      cert=$(openssl x509 -noout -pubkey -in "$TLS_CERT" 2>/dev/null | openssl sha256)
      key=$(openssl pkey -pubout -in "$TLS_KEY" 2>/dev/null | openssl sha256)
      if [[ -z $cert || $cert != "$key" ]]; then
        again TLS_CERT "$TLS_KEY is not the key of $TLS_CERT."
        TLS_KEY=""
        continue
      fi
    fi
    return 0
  done
}

check_proxy() {
  while :; do
    ask PROXY "The proxy's address (local: a proxy of this machine)" local
    [[ $PROXY == local || $PROXY =~ ^[0-9A-Fa-f.:/]+$ ]] && return 0
    again PROXY "The proxy is an address or a range, or local (not $PROXY)."
  done
}

check_data() {
  while :; do
    ask DATA "The library's data folder" "$DEFAULT_DATA"
    if ! plain_path "$DATA"; then
      again DATA "The data folder is a full path of plain letters, digits and . _ - / (not $DATA)."
      continue
    fi
    DATA=$(realpath -m "$DATA")
    local folder
    for folder in "$DATA" "$ETC"; do
      if within "$MEDIA" "$folder" || within "$folder" "$MEDIA"; then
        again DATA "The media folder is apart from the library's data and keys ($folder): neither in it, nor holding it."
        MEDIA="" && check_media
        continue 2
      fi
    done
    return 0
  done
}

# The size of a published library, from its manifest; nothing when it cannot be read.
library_size() {
  curl -fsSL --max-time 60 "${1%/}/manifest.json" 2>/dev/null |
    grep -o '"size": *[0-9]*' | awk '{ total += $2 } END { if (NR) print total }'
}

check_seed() {
  if [[ -f $MEDIA/manifest.json ]]; then
    SEED=no
    return 0
  fi
  if [[ -z $SEED ]]; then
    if yes_no "Fill the media from the central library, $CENTRAL?" y; then SEED=yes; else SEED=no; fi
  fi
  [[ $SEED == yes ]] || return 0
  SEED_FROM=${SEED_FROM:-$CENTRAL}
  [[ $SEED_FROM == */ ]] || SEED_FROM+=/
  local size free
  size=$(library_size "$SEED_FROM")
  [[ -n $size ]] || fail "$SEED_FROM does not answer with a library (manifest.json)."
  free=$(df -PB1 --output=avail "$(existing "$MEDIA")" | tail -1 | tr -d ' ')
  ((free > size + size / 10)) ||
    fail "The library is $((size / 1024 / 1024)) MiB, and the disk of $MEDIA has $((free / 1024 / 1024)) MiB free."
  SEED_SIZE=$size
}

# ---- Writing

SELINUX=""
selinux() {
  if command -v getenforce >/dev/null && [[ $(getenforce 2>/dev/null) == Enforcing ]]; then
    SELINUX=Z
  fi
}

write_answers() {
  install -d -m 0755 "$ETC"
  {
    printf '# The answers of the install of Slidr Library %s (install.sh), %s. Nothing secret.\n' \
      "${VERSION:-dev}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local key
    for key in VERSION IMAGE MEDIA OWNER REACH URL PROXY BIND PORT DATA; do
      printf "%s='%s'\n" "$key" "${!key}"
    done
  } >"$ETC/library.env"
}

write_compose() {
  local z=${SELINUX:+:$SELINUX} tls_z=${SELINUX:+,$SELINUX} trusted=""
  if [[ $REACH == proxy ]]; then
    trusted=$([[ $PROXY == local ]] && echo gateway || echo "$PROXY")
  fi
  cat >"$ETC/compose.yaml" <<EOF
# Slidr Library${VERSION:+ $VERSION}, as install.sh wrote it on $(date -u +%Y-%m-%d) (docs/SPEC.md §5.1).
# Run install.sh again to change it: slidr-library update, or sudo bash $ETC/install.sh.
name: slidr-library
services:
  library:
    image: "$IMAGE"
    pull_policy: missing
    container_name: $CONTAINER
    restart: unless-stopped
    user: "$USER_ID:$USER_ID"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "$BIND:$PORT:8080"
    environment:
      LIBRARY_URL: "$URL"
      LIBRARY_MEDIA_SHOWN: "$MEDIA"
      LIBRARY_TRUSTED_PROXY: "$trusted"
    volumes:
      - "$DATA:/library/data$z"
      - "$MEDIA:/library/media$z"
      - "$ETC/keys:/library/keys$z"
      - "$ETC/tls:/library/tls:ro$tls_z"
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"
EOF
}

write_folders() {
  install -d -m 0755 "$ETC"
  install -d -m 0700 -o "$USER_ID" -g "$USER_ID" "$ETC/keys" "$ETC/tls" "$DATA"
  install -d -m 0755 -o "$USER_ID" -g "$USER_ID" "$MEDIA"
  chown -R "$USER_ID:$USER_ID" "$DATA" "$MEDIA" "$ETC/keys"
  rm -f "$ETC/tls/cert.pem" "$ETC/tls/key.pem"
  if [[ $REACH == https ]]; then
    install -m 0644 -o "$USER_ID" -g "$USER_ID" "$TLS_CERT" "$ETC/tls/cert.pem"
    install -m 0600 -o "$USER_ID" -g "$USER_ID" "$TLS_KEY" "$ETC/tls/key.pem"
  fi
}

compose() { docker compose -f "$ETC/compose.yaml" "$@"; }

pull() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
}

healthy() {
  local status="" tries
  for tries in $(seq 120); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)
    [[ $status == healthy ]] && return 0
    ((tries % 10 == 0)) && say "  … ($status)"
    sleep 1
  done
  docker logs --tail 30 "$CONTAINER" >&2 || true
  fail "The library did not become healthy within two minutes ($status). Its log is above."
}

install_command() {
  docker run --rm --entrypoint cat "$IMAGE" /app/host/slidr-library >"$COMMAND.new"
  chmod 0755 "$COMMAND.new"
  mv -f "$COMMAND.new" "$COMMAND"
  # This script, beside its answers, for `slidr-library update` and for changing them.
  if [[ -f ${BASH_SOURCE[0]} && $(realpath "${BASH_SOURCE[0]}") != "$ETC/install.sh" ]]; then
    install -m 0755 "${BASH_SOURCE[0]}" "$ETC/install.sh"
  fi
}

# ---- Installing, and updating

summary() {
  say ""
  say "Slidr Library${VERSION:+ $VERSION}, as it will be installed:"
  say "  image:     $IMAGE"
  say "  address:   $URL  (port $PORT of this machine, on $BIND)"
  case "$REACH" in
    local) say "  reached:   from this machine only, over HTTP" ;;
    https) say "  reached:   over HTTPS, with $TLS_CERT" ;;
    proxy) say "  reached:   through the proxy $PROXY, which speaks HTTPS" ;;
  esac
  say "  owner:     $OWNER"
  say "  media:     $MEDIA$([[ $SEED == yes ]] && echo "  (filled from $SEED_FROM, $((SEED_SIZE / 1024 / 1024)) MiB)")"
  say "  data:      $DATA"
  say "  keys:      $ETC/keys"
  say "The folders will belong to the container's user ($USER_ID)."
  if [[ $REACH != local && $BIND != 127.0.0.1 ]]; then
    say "A port Docker publishes passes by ufw's and firewalld's rules: port $PORT is open on $BIND"
    say "whatever they say. Bind it where it should be reached (--bind), or close it outside Docker."
  fi
  say ""
}

settle_reach() {
  case "$REACH" in
    local)
      URL="http://127.0.0.1:$PORT"
      BIND=${BIND:-127.0.0.1}
      ;;
    https)
      check_url "https://$(hostname -f 2>/dev/null || hostname):$PORT"
      check_tls
      BIND=${BIND:-0.0.0.0}
      ;;
    proxy)
      check_url "https://library.$(hostname -d 2>/dev/null || echo example.org)"
      check_proxy
      BIND=${BIND:-$([[ $PROXY == local ]] && echo 127.0.0.1 || echo 0.0.0.0)}
      ;;
  esac
}

finish() {
  say ""
  say "Slidr Library is running at $URL"
  say "Apps read its media at $URL/media/ (docs/media-library.md of Slidr, \"A library of your own\")."
  say ""
  docker exec "$CONTAINER" slidr-library login || true
  say ""
  say "On this machine: slidr-library status | logs | login | update | stop | start | uninstall"
}

fresh() {
  check_media
  check_owner
  check_reach
  check_port
  settle_reach
  check_data
  SEED_SIZE=0
  check_seed
  if [[ -f $DATA/host.json && ! -f $ETC/keys/master.key ]]; then
    fail "$DATA holds a library, but its master key is not in $ETC/keys: put master.key back there first."
  fi
  summary
  yes_no "Install it?" y || fail "Nothing was written."
  selinux
  write_folders
  write_answers
  write_compose
  say "Getting the image…"
  pull
  if [[ -f $DATA/host.json ]]; then
    say "The data folder holds a library: it is kept as it is."
  else
    say "Installing the library…"
    compose run --rm --no-deps library init --owner "$OWNER" --url "$URL"
  fi
  if [[ $SEED == yes ]]; then
    say "Filling the media from $SEED_FROM…"
    compose run --rm --no-deps library seed --from "$SEED_FROM"
  fi
  compose up -d
  say "Waiting for it to start…"
  healthy
  install_command
  finish
}

# On a machine where it is installed: this version, or another way of reaching it.
again_here() {
  load_answers
  local choice=update
  if ((UPDATE == 0)) && at_keyboard; then
    say "Slidr Library is installed here ($ETC), at $URL."
    say "  1) update it to ${VERSION:-this version} (the default)"
    say "  2) change how it is reached, or its port"
    say "  3) leave it as it is"
    local answer=""
    printf 'Which? [1] ' >/dev/tty
    IFS= read -r answer </dev/tty || true
    case "${answer:-1}" in
      1) choice=update ;;
      2) choice=reach ;;
      *) say "Nothing was changed." && exit 0 ;;
    esac
  fi
  if [[ $choice == reach ]]; then
    local own=$PORT
    REACH="" URL="" BIND="" PORT=""
    check_reach
    check_port "$own"
    settle_reach
  fi
  write_answers
  selinux
  write_compose
  if [[ $choice == reach ]]; then write_folders; fi
  say "Getting the image…"
  pull
  compose up -d
  say "Waiting for it to start…"
  healthy
  install_command
  say "Slidr Library${VERSION:+ $VERSION} is running at $URL."
}

check_machine
if [[ -f $ETC/library.env && -f $ETC/compose.yaml ]]; then
  again_here
else
  ((UPDATE == 0)) || fail "No library is installed here to update: run it without --update."
  fresh
fi
