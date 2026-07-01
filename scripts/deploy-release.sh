#!/usr/bin/env bash
# Deploy a MindFS release archive on Linux with an optional systemd service.
#
# Examples:
#   curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/deploy-release.sh | bash
#   bash scripts/deploy-release.sh --archive dist/mindfs_v0.3.8_linux_amd64.tar.gz
#   bash scripts/deploy-release.sh --version v0.3.8 --repo shuguangnet/mindfs
#   bash scripts/deploy-release.sh --archive ./mindfs_v0.3.8_linux_amd64.tar.gz \
#     --install-dir /opt/mindfs --service-name mindfs-17331 --addr 127.0.0.1:17331 \
#     --agent-config /etc/mindfs/agents-empty.json --env OPENAI_API_KEY=xxx

set -euo pipefail

REPO="shuguangnet/mindfs"
VERSION=""
ARCHIVE=""
INSTALL_DIR="/opt/mindfs"
SERVICE_NAME="mindfs"
ADDR="127.0.0.1:7331"
ROOT_DIR=""
AGENT_CONFIG=""
ENV_FILE=""
DECLARE_ENV=()
NO_SERVICE=0
NO_RESTART=0
SERVICE_PATH='/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

usage() {
  cat <<'EOF'
Usage: deploy-release.sh [options]

Options:
  --archive PATH            Deploy from a local .tar.gz release archive.
  --version VERSION         Download and deploy this release version from GitHub.
  --repo OWNER/REPO         GitHub repo used with --version. Default: shuguangnet/mindfs
  --install-dir PATH        Install root. Default: /opt/mindfs
  --service-name NAME       systemd service name. Default: mindfs
  --addr HOST:PORT          MindFS listen address. Default: 127.0.0.1:7331
  --root DIR                Optional managed root directory passed to mindfs.
  --agent-config PATH       Optional agent config path passed to mindfs.
  --env-file PATH           systemd EnvironmentFile path. Default: <install-dir>/shared/mindfs.env
  --env KEY=VALUE           Append one environment variable to the service env file.
  --no-service              Only install files and update current symlink.
  --no-restart              Write/update the service unit but do not restart it.
  -h, --help                Show this help.

This script is intended for Linux hosts with systemd.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --addr)
      ADDR="$2"
      shift 2
      ;;
    --root)
      ROOT_DIR="$2"
      shift 2
      ;;
    --agent-config)
      AGENT_CONFIG="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --env)
      DECLARE_ENV+=("$2")
      shift 2
      ;;
    --no-service)
      NO_SERVICE=1
      shift
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$ARCHIVE" && -n "$VERSION" ]]; then
  echo "Error: use either --archive or --version, not both." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: deploy-release.sh currently supports Linux only." >&2
  exit 1
fi

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="${INSTALL_DIR}/shared/mindfs.env"
fi

normalize_tag() {
  local value="${1:-}"
  value="${value#v}"
  printf 'v%s\n' "$value"
}

detect_arch() {
  local raw
  raw="$(uname -m)"
  case "$raw" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7*|armhf) echo "arm" ;;
    *)
      echo "Unsupported arch: $raw" >&2
      exit 1
      ;;
  esac
}

download_file() {
  local url="$1"
  local dst="$2"
  if [[ "$dst" == "-" ]]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url"
    else
      wget -qO- "$url"
    fi
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dst"
  else
    wget -qO "$dst" "$url"
  fi
}

extract_version() {
  sed -nE '1s/^[[:space:]]*#[[:space:]]+MindFS[[:space:]]+(v?[0-9]+(\.[0-9]+){1,3}[^[:space:]]*).*$/\1/p'
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if [[ -n "$VERSION" ]]; then
  VERSION="$(normalize_tag "$VERSION")"
fi

if [[ -z "$ARCHIVE" && -z "$VERSION" ]]; then
  RELEASE_NOTES_URL="https://raw.githubusercontent.com/${REPO}/main/release-notes.md"
  echo "==> Resolving latest release from ${RELEASE_NOTES_URL}"
  VERSION="$(download_file "$RELEASE_NOTES_URL" - | extract_version)"
  if [[ -z "$VERSION" ]]; then
    echo "Error: could not determine latest release version from ${REPO}." >&2
    exit 1
  fi
  VERSION="$(normalize_tag "$VERSION")"
fi

if [[ -n "$VERSION" ]]; then
  ARCH="$(detect_arch)"
  FILE_NAME="mindfs_${VERSION}_linux_${ARCH}.tar.gz"
  ARCHIVE="${TMPDIR}/${FILE_NAME}"
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE_NAME}"
  echo "==> Downloading ${URL}"
  download_file "$URL" "$ARCHIVE"
fi

ARCHIVE="$(readlink -f "$ARCHIVE")"
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: archive not found: $ARCHIVE" >&2
  exit 1
fi

echo "==> Extracting ${ARCHIVE}"
tar -xzf "$ARCHIVE" -C "$TMPDIR"

PKG_DIR="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -type d -name 'mindfs_*_linux_*' | head -n 1)"
if [[ -z "$PKG_DIR" ]]; then
  echo "Error: unexpected archive structure." >&2
  exit 1
fi

RELEASE_NAME="$(basename "$PKG_DIR")"
RELEASE_DIR="${INSTALL_DIR}/releases/${RELEASE_NAME}"
CURRENT_LINK="${INSTALL_DIR}/current"
SHARED_DIR="${INSTALL_DIR}/shared"

echo "==> Installing release ${RELEASE_NAME}"
install -d "${INSTALL_DIR}/releases" "$SHARED_DIR"
rm -rf "$RELEASE_DIR"
cp -a "$PKG_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

echo "    current -> $RELEASE_DIR"

if [[ "$NO_SERVICE" -eq 1 ]]; then
  echo "==> Installed files only. Service setup skipped."
  exit 0
fi

install -d "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
for entry in "${DECLARE_ENV[@]}"; do
  key="${entry%%=*}"
  if [[ -z "$key" || "$entry" != *=* ]]; then
    echo "Error: invalid --env value: $entry" >&2
    exit 1
  fi
  if grep -qE "^${key}=" "$ENV_FILE"; then
    tmpfile="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" >"$tmpfile" || true
    mv "$tmpfile" "$ENV_FILE"
  fi
  printf '%s\n' "$entry" >>"$ENV_FILE"
done

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

exec_start=("${CURRENT_LINK}/mindfs" "--foreground" "-addr" "$ADDR")
if [[ -n "$AGENT_CONFIG" ]]; then
  exec_start+=("-agent-config" "$AGENT_CONFIG")
fi
if [[ -n "$ROOT_DIR" ]]; then
  exec_start+=("$ROOT_DIR")
fi

exec_line=""
for arg in "${exec_start[@]}"; do
  if [[ -n "$exec_line" ]]; then
    exec_line+=" "
  fi
  printf -v quoted '%q' "$arg"
  exec_line+="$quoted"
done

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=MindFS (${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
Environment=HOME=/root
Environment=PATH=${SERVICE_PATH}
EnvironmentFile=-${ENV_FILE}
ExecStart=${exec_line}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wrote ${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

if [[ "$NO_RESTART" -eq 1 ]]; then
  echo "==> Service unit updated. Restart skipped by --no-restart."
  exit 0
fi

systemctl restart "$SERVICE_NAME"
echo "==> Service restarted: ${SERVICE_NAME}"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'
