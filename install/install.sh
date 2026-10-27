#!/usr/bin/env bash
# Installs a local Slidr Library on this Linux machine (docs/SPEC.md §5.1, §5.5): the image of
# its release, in Docker, with its media in a folder of this machine's own disks.
#
#   sudo bash install.sh                 asks what it needs, and installs
#   sudo bash install.sh --yes …         asks nothing: the options answer, the rest is default
#   sudo bash install.sh --update        on a machine where it is installed: this version
#   sudo bash install.sh --image-file …  on a machine that does not reach ghcr.io: the image's file
#
# It writes nothing until its summary is accepted. Run again, it keeps the library's data, keys
# and media as they are, and updates it or changes how it is reached. `--help` lists the options.
set -euo pipefail

# Written by the release (.github/workflows/release.yml): its version, its image by digest, and
# the SHA-256 of the image's file for each architecture (--image-file).
VERSION=""
IMAGE=""
IMAGE_FILE_AMD64=""
IMAGE_FILE_ARM64=""

ETC=/etc/slidr-library
COMMAND=/usr/local/bin/slidr-library
CONTAINER=slidr-library
# The account of this machine the library runs as, made for it: its own, so that no other account
# shares the user id the library's folders and keys belong to.
ACCOUNT=slidr-library
USER_ID="" GROUP_ID=""
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
  --image-file <file>   this release's image from its file, for a machine that does not reach
                        ghcr.io (slidr-library-<version>-linux-<arch>.tar.gz of the release)
  --ca <file>           the certificates (PEM) of the organization's own authorities, which the
                        library trusts besides the public ones: its sign-in provider's, a seed's
  --no-ca               the public authorities alone again
  --image <reference>   another image than this release's: a mirror of it, or one for its tests
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
IMAGE_GIVEN=0 IMAGE_FILE="" CA="" NO_CA=0
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
    --image) IMAGE=${2:?--image names an image} IMAGE_GIVEN=1; shift ;;
    --image-file) IMAGE_FILE=${2:?--image-file names a file}; shift ;;
    --ca) CA=${2:?--ca names a file}; shift ;;
    --no-ca) NO_CA=1 ;;
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
  for tool in docker ss findmnt curl df realpath getent useradd; do
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
  [[ -n $IMAGE || -n $IMAGE_FILE ]] ||
    fail "This script is not of a release: name the image, --image <reference>."
}

# The image's file (--image-file): this release's for this machine's architecture, by the SHA-256
# the release wrote above. A script not of a release takes any file, for its tests.
check_image_file() {
  [[ -n $IMAGE_FILE ]] || return 0
  ((IMAGE_GIVEN == 0)) || fail "Name the image or its file, not both: --image or --image-file."
  [[ -f $IMAGE_FILE && -r $IMAGE_FILE ]] || fail "$IMAGE_FILE is not a file this machine can read."
  [[ -n $VERSION ]] || return 0
  local arch expected
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 expected=$IMAGE_FILE_AMD64 ;;
    *) arch=arm64 expected=$IMAGE_FILE_ARM64 ;;
  esac
  [[ -n $expected ]] || fail "Slidr Library $VERSION has no image file for linux/$arch."
  say "Checking $IMAGE_FILE…"
  [[ $(sha256sum "$IMAGE_FILE" | cut -d ' ' -f 1) == "$expected" ]] ||
    fail "$IMAGE_FILE is not the image of Slidr Library $VERSION for linux/$arch (slidr-library-$VERSION-linux-$arch.tar.gz of its release): nothing was written."
}

# The organization's own authorities (--ca): certificates in PEM, and no key.
check_ca() {
  [[ -n $CA ]] || return 0
  ((NO_CA == 0)) || fail "Name the authorities or none: --ca or --no-ca."
  [[ -f $CA && -r $CA ]] || fail "$CA is not a file this machine can read."
  grep -q -- '-----BEGIN CERTIFICATE-----' "$CA" || fail "$CA holds no certificate in PEM."
  if grep -q -- 'PRIVATE KEY-----' "$CA"; then
    fail "$CA holds a private key: the authorities' certificates alone."
  fi
  if command -v openssl >/dev/null && ! openssl x509 -noout -in "$CA" 2>/dev/null; then
    fail "$CA is not a certificate openssl can read."
  fi
}

# The authorities the library is to trust besides the public ones: those given, or those it keeps.
ca_file() {
  if [[ -n $CA ]]; then
    printf '%s' "$CA"
  elif ((NO_CA == 0)) && [[ -f $ETC/ca/ca.pem ]]; then
    printf '%s' "$ETC/ca/ca.pem"
  fi
}

# ---- The answers of an installed library (library.env), kept as KEY='value'

# The image the library was installed with.
INSTALLED_IMAGE=""

load_answers() {
  local line key value
  while IFS= read -r line; do
    [[ $line =~ ^([A-Z_]+)=\'(.*)\'$ ]] || continue
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    case "$key" in
      MEDIA | OWNER | REACH | URL | PROXY | BIND | PORT | DATA)
        [[ -n ${!key} ]] || printf -v "$key" '%s' "$value"
        ;;
      IMAGE) INSTALLED_IMAGE=$value ;;
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
    if [[ -f $MEDIA/manifest.json ]] &&
      ! { grep -q '"published"' "$MEDIA/manifest.json" && grep -q '"files"' "$MEDIA/manifest.json"; }; then
      again MEDIA "$MEDIA/manifest.json is not a library's manifest: the media folder is the library's alone."
      continue
    fi
    if [[ -d $MEDIA && ! -f $MEDIA/manifest.json ]] &&
      [[ -n $(find "$MEDIA" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
      local held
      held=$(find "$MEDIA" -mindepth 1 -maxdepth 1 -printf '%f ' | head -c 120 || true)
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
    if [[ -d $DATA && ! -f $DATA/host.json ]] &&
      [[ -n $(find "$DATA" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
      again DATA "$DATA holds other things than a library's data: name an empty folder, or a library's."
      continue
    fi
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

# The size of a published library, from its manifest; nothing when it cannot be read. A server of
# the organization's may be trusted by its own authorities alone, which curl is given then.
library_size() {
  local manifest="" ca
  ca=$(ca_file)
  manifest=$(curl -fsSL --max-time 60 "${1%/}/manifest.json" 2>/dev/null) ||
    if [[ -n $ca ]]; then
      manifest=$(curl -fsSL --max-time 60 --cacert "$ca" "${1%/}/manifest.json" 2>/dev/null) || true
    fi
  { grep -o '"size": *[0-9]*' <<<"$manifest" || true; } |
    awk '{ total += $2 } END { if (NR) print total }'
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
  free=$(df -B1 --output=avail "$(existing "$MEDIA")" | tail -1 | tr -d ' ')
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
  # Node trusts the organization's authorities besides its own list (write_ca).
  local ca=""
  if [[ -f $ETC/ca/ca.pem ]]; then ca=$'\n      NODE_EXTRA_CA_CERTS: "/library/ca/ca.pem"'; fi
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
    user: "$USER_ID:$GROUP_ID"
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
      LIBRARY_TRUSTED_PROXY: "$trusted"$ca
    volumes:
      - "$DATA:/library/data$z"
      - "$MEDIA:/library/media$z"
      - "$ETC/keys:/library/keys$z"
      - "$ETC/tls:/library/tls:ro$tls_z"
      - "$ETC/ca:/library/ca:ro$tls_z"
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"
EOF
}

# The library's account: made, a system account with no login, when it is not there yet.
account() {
  if ! getent passwd "$ACCOUNT" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent       --shell /usr/sbin/nologin "$ACCOUNT"
  fi
  USER_ID=$(id -u "$ACCOUNT")
  GROUP_ID=$(id -g "$ACCOUNT")
}

# The library's folders, its account's.
own_folders() {
  chown -R "$USER_ID:$GROUP_ID" "$DATA" "$MEDIA" "$ETC/keys" "$ETC/tls"
}

write_folders() {
  account
  install -d -m 0755 "$ETC"
  install -d -m 0700 -o "$USER_ID" -g "$GROUP_ID" "$ETC/keys" "$ETC/tls" "$DATA"
  install -d -m 0755 -o "$USER_ID" -g "$GROUP_ID" "$MEDIA"
  chown -R "$USER_ID:$GROUP_ID" "$DATA" "$MEDIA" "$ETC/keys"
  rm -f "$ETC/tls/cert.pem" "$ETC/tls/key.pem"
  if [[ $REACH == https ]]; then
    install -m 0644 -o "$USER_ID" -g "$GROUP_ID" "$TLS_CERT" "$ETC/tls/cert.pem"
    install -m 0600 -o "$USER_ID" -g "$GROUP_ID" "$TLS_KEY" "$ETC/tls/key.pem"
  fi
}

# The organization's authorities (--ca), which the container reads at its start; kept until
# --no-ca. A change of them alone starts the container again (CA_CHANGED).
CA_CHANGED=0
write_ca() {
  install -d -m 0755 "$ETC/ca"
  if [[ -n $CA ]] && ! cmp -s "$CA" "$ETC/ca/ca.pem"; then
    install -m 0644 "$CA" "$ETC/ca/ca.pem"
    CA_CHANGED=1
  elif ((NO_CA)) && [[ -f $ETC/ca/ca.pem ]]; then
    rm -f "$ETC/ca/ca.pem"
    CA_CHANGED=1
  fi
}

compose() { docker compose -f "$ETC/compose.yaml" "$@"; }

pull() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 && return 0
  # This release's image, loaded from its file when the library was installed (--image-file):
  # Docker knows it by its tag, not by the digest it is pulled by.
  if [[ -n $INSTALLED_IMAGE && $INSTALLED_IMAGE == "${IMAGE%@*}" ]] &&
    docker image inspect "$INSTALLED_IMAGE" >/dev/null 2>&1; then
    IMAGE=$INSTALLED_IMAGE
    return 0
  fi
  docker pull "$IMAGE" ||
    fail "Docker could not pull $IMAGE: nothing was written. A machine that does not reach ghcr.io is given the image's file of the release, --image-file slidr-library-<version>-linux-<arch>.tar.gz."
}

# The image's file, loaded into Docker: the image it holds, by its name, is the one installed.
load_image() {
  local loaded
  loaded=$(docker load --quiet --input "$IMAGE_FILE") || fail "Docker could not load $IMAGE_FILE."
  IMAGE=$(sed -n 's/^Loaded image: //p' <<<"$loaded")
  [[ -n $IMAGE && $IMAGE != *$'\n'* ]] || fail "$IMAGE_FILE holds no one image by its name: $loaded"
}

# The image, before anything of the install is written: from its file, or pulled when Docker
# does not have it.
get_image() {
  if [[ -n $IMAGE_FILE ]]; then
    say "Loading the image from $IMAGE_FILE…"
    load_image
  else
    say "Getting the image…"
    pull
  fi
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
  if [[ -n $IMAGE_FILE ]]; then
    say "  image:     from $IMAGE_FILE$([[ -n $VERSION ]] && echo ", the release's (checked)")"
  else
    say "  image:     $IMAGE"
  fi
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
  local ca
  ca=$(ca_file)
  if [[ -n $ca ]]; then say "  trusts:    the authorities of $ca, besides the public ones"; fi
  if getent passwd "$ACCOUNT" >/dev/null; then
    say "The folders will belong to $ACCOUNT, the library's account of this machine."
  else
    say "The folders will belong to $ACCOUNT, an account of this machine made for the library."
  fi
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

# The address the port is published on: an IPv4 address, and this machine's own over plain HTTP.
check_bind() {
  [[ $BIND =~ ^([0-9]{1,3}.){3}[0-9]{1,3}$ ]] || fail "--bind is an IPv4 address, not $BIND."
  if [[ $REACH == local && $BIND != 127.* ]]; then
    fail "Over plain HTTP the library is this machine's alone: reach it by https or a proxy to bind $BIND."
  fi
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
  check_bind
  check_data
  SEED_SIZE=0
  check_seed
  if [[ -f $DATA/host.json && ! -f $ETC/keys/master.key ]]; then
    fail "$DATA holds a library, but its master key is not in $ETC/keys: put master.key back there first."
  fi
  summary
  yes_no "Install it?" y || fail "Nothing was written."
  get_image
  selinux
  write_folders
  write_ca
  write_answers
  write_compose
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
    check_bind
  fi
  get_image
  account
  own_folders
  write_ca
  write_answers
  selinux
  write_compose
  if [[ $choice == reach ]]; then write_folders; fi
  if ((CA_CHANGED)); then
    compose up -d --force-recreate
  else
    compose up -d
  fi
  say "Waiting for it to start…"
  healthy
  install_command
  say "Slidr Library${VERSION:+ $VERSION} is running at $URL."
  if ((CA_CHANGED)); then
    if [[ -f $ETC/ca/ca.pem ]]; then
      say "It trusts the authorities of $ETC/ca/ca.pem, besides the public ones."
    else
      say "It trusts the public authorities alone."
    fi
  fi
}

check_machine
check_image_file
check_ca
if [[ -f $ETC/library.env && -f $ETC/compose.yaml ]]; then
  again_here
else
  ((UPDATE == 0)) || fail "No library is installed here to update: run it without --update."
  fresh
fi
