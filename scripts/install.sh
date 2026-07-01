#!/usr/bin/env bash
# MindFS installer for macOS and Linux.
# Downloads the correct release from GitHub and installs it.
# Usage:  bash install.sh [--version VERSION] [--prefix PREFIX] [--uninstall] [--purge]
set -euo pipefail

REPO="shuguangnet/mindfs"
RELEASE_NOTES_URL="https://raw.githubusercontent.com/${REPO}/main/release-notes.md"
VERSION=""
PREFIX="${HOME}/.local"
UNINSTALL=0
PURGE=0

# ── Parse arguments ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2";  shift 2 ;;
    --prefix)   PREFIX="$2";   shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$PURGE" -eq 1 && "$UNINSTALL" -ne 1 ]]; then
  echo "Error: --purge can only be used with --uninstall." >&2
  exit 1
fi

config_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' "${HOME}/Library/Application Support/mindfs" ;;
    *) printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/mindfs" ;;
  esac
}

state_dir() {
  printf '%s\n' "${HOME}/.local/share/mindfs"
}

remove_path_entry() {
  local bin_dir="$1"
  local shell_name rc_file line tmp
  shell_name="$(basename "${SHELL:-}")"
  line="export PATH=\"${bin_dir}:\$PATH\""

  case "$shell_name" in
    zsh) rc_file="${HOME}/.zshrc" ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        rc_file="${HOME}/.bash_profile"
      else
        rc_file="${HOME}/.bashrc"
      fi
      ;;
    *) return 0 ;;
  esac

  if [[ ! -f "$rc_file" ]] || ! grep -Fqs "$line" "$rc_file"; then
    return 0
  fi
  tmp="$(mktemp)"
  grep -Fvx "$line" "$rc_file" >"$tmp" || true
  cat "$tmp" >"$rc_file"
  rm -f "$tmp"
  echo "  PATH    -> removed ${bin_dir} from ${rc_file}"
}

uninstall_mindfs() {
  local bin_path="${PREFIX}/bin/mindfs"
  local share_dir="${PREFIX}/share/mindfs"

  echo "Uninstalling mindfs"
  echo "  Prefix: ${PREFIX}"
  rm -f "$bin_path"
  echo "  Removed binary: ${bin_path}"
  rm -rf "$share_dir"
  echo "  Removed shared files: ${share_dir}"
  rmdir "${PREFIX}/bin" "${PREFIX}/share" "$PREFIX" 2>/dev/null || true
  remove_path_entry "${PREFIX}/bin"

  if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$(config_dir)" "$(state_dir)"
    echo "  Removed user config: $(config_dir)"
    echo "  Removed user state:  $(state_dir)"
    echo "  Project .mindfs directories were not removed."
  else
    echo "  User config and project .mindfs data were kept."
    echo "  Re-run with --uninstall --purge to remove user-level MindFS config and logs."
  fi
  echo "Done."
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_mindfs
  exit 0
fi

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

normalize_tag() {
  local value="${1:-}"
  value="${value#v}"
  printf 'v%s' "$value"
}

extract_version() {
  sed -nE '1s/^[[:space:]]*#[[:space:]]+MindFS[[:space:]]+(v?[0-9]+(\.[0-9]+){1,3}[^[:space:]]*).*$/\1/p'
}

# ── Resolve version from raw metadata if not specified ─────────────────────
if [[ -z "$VERSION" ]]; then
  echo "Fetching latest release version..."
  if command -v curl &>/dev/null; then
    VERSION="$(curl -fsSL "$RELEASE_NOTES_URL" | extract_version)"
  elif command -v wget &>/dev/null; then
    VERSION="$(wget -qO- "$RELEASE_NOTES_URL" | extract_version)"
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

download_file() {
  local url="$1"
  local dst="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$dst"
  else
    wget -qO "$dst" "$url"
  fi
}

echo "  Downloading ${URL}"
download_file "$URL" "${TMPDIR}/${FILENAME}"

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
