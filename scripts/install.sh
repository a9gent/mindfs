#!/usr/bin/env bash
# MindFS installer for macOS and Linux.
# Downloads the correct release from GitHub and installs it.
# Usage:  bash install.sh [--version VERSION] [--prefix PREFIX]
set -euo pipefail

REPO="a9gent/mindfs"
VERSION=""
PREFIX="${HOME}/.local"

# ── Parse arguments ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2";  shift 2 ;;
    --prefix)   PREFIX="$2";   shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Detect OS ──────────────────────────────────────────────────────────────
detect_os() {
  local raw; raw="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    darwin) echo "darwin" ;;
    linux)  echo "linux"  ;;
    *) echo "Unsupported OS: $raw" >&2; exit 1 ;;
  esac
}

# ── Detect architecture ────────────────────────────────────────────────────
detect_arch() {
  local raw; raw="$(uname -m)"
  case "$raw" in
    x86_64|amd64)  echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7*|armhf)  echo "arm"   ;;
    *) echo "Unsupported arch: $raw" >&2; exit 1 ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

extract_tag_name() {
  sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1
}

normalize_tag() {
  local value="${1:-}"
  value="${value#v}"
  printf 'v%s' "$value"
}

# ── Resolve version from GitHub API if not specified ───────────────────────
if [[ -z "$VERSION" ]]; then
  echo "Fetching latest release version..."
  if command -v curl &>/dev/null; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | extract_tag_name)"
  elif command -v wget &>/dev/null; then
    VERSION="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" \
      | extract_tag_name)"
  else
    echo "Error: curl or wget is required." >&2; exit 1
  fi
  if [[ -z "$VERSION" ]]; then
    echo "Error: could not determine latest version. Use --version to specify." >&2; exit 1
  fi
fi

VERSION="$(normalize_tag "$VERSION")"

echo "Installing mindfs ${VERSION} for ${OS}/${ARCH}"
echo "  Prefix: ${PREFIX}"

# ── Download ────────────────────────────────────────────────────────────────
FILENAME="mindfs_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILENAME}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "  Downloading ${URL}"
if command -v curl &>/dev/null; then
  curl -fsSL "$URL" -o "${TMPDIR}/${FILENAME}"
else
  wget -qO "${TMPDIR}/${FILENAME}" "$URL"
fi

# ── Extract ─────────────────────────────────────────────────────────────────
tar -xzf "${TMPDIR}/${FILENAME}" -C "$TMPDIR"
PKG_DIR="${TMPDIR}/mindfs_${VERSION}_${OS}_${ARCH}"

if [[ ! -d "$PKG_DIR" ]]; then
  echo "Error: unexpected archive structure (expected ${PKG_DIR})." >&2; exit 1
fi

# ── Install binary ──────────────────────────────────────────────────────────
mkdir -p "${PREFIX}/bin"
install -m 0755 "${PKG_DIR}/mindfs" "${PREFIX}/bin/mindfs"
echo "  Binary  -> ${PREFIX}/bin/mindfs"

# ── Install default agent config ────────────────────────────────────────────
if [[ -f "${PKG_DIR}/agents.json" ]]; then
  mkdir -p "${PREFIX}/share/mindfs"
  install -m 0644 "${PKG_DIR}/agents.json" "${PREFIX}/share/mindfs/agents.json"
  echo "  Agents  -> ${PREFIX}/share/mindfs/agents.json"
fi

# ── Install web assets (optional) ───────────────────────────────────────────
if [[ -d "${PKG_DIR}/web" ]]; then
  WEB_DEST="${PREFIX}/share/mindfs/web"
  mkdir -p "${PREFIX}/share/mindfs"
  rm -rf "$WEB_DEST"
  cp -r "${PKG_DIR}/web" "$WEB_DEST"
  echo "  Web     -> ${WEB_DEST}"
fi

# ── Ensure PATH contains the user bin directory ─────────────────────────────
ensure_path_entry() {
  local bin_dir="$1"
  case ":${PATH}:" in
    *":${bin_dir}:"*) return 0 ;;
  esac

  local shell_name rc_file line
  shell_name="$(basename "${SHELL:-}")"
  line="export PATH=\"${bin_dir}:\$PATH\""

  case "$shell_name" in
    zsh)
      rc_file="${HOME}/.zshrc"
      ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        rc_file="${HOME}/.bash_profile"
      else
        rc_file="${HOME}/.bashrc"
      fi
      ;;
    *)
      return 1
      ;;
  esac

  touch "$rc_file"
  if grep -Fqs "$line" "$rc_file"; then
    return 0
  fi

  {
    printf '\n'
    printf '%s\n' "$line"
  } >>"$rc_file"

  echo "  PATH    -> added ${bin_dir} to ${rc_file}"
  echo "            Reload your shell or run: source ${rc_file}"
  return 0
}

# ── Verify ──────────────────────────────────────────────────────────────────
echo
if ensure_path_entry "${PREFIX}/bin"; then
  :
else
  echo "PATH was not updated automatically for shell: $(basename "${SHELL:-unknown}")"
  echo "  Add this line to your shell profile:"
  echo "    export PATH=\"${PREFIX}/bin:\$PATH\""
fi

if command -v mindfs &>/dev/null; then
  echo "Done. mindfs is available at: $(command -v mindfs)"
else
  echo "Done. Open a new terminal or ensure ${PREFIX}/bin is in your PATH."
fi
