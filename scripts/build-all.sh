#!/usr/bin/env bash
# Cross-compile mindfs for all target platforms.
# Usage: bash scripts/build-all.sh [VERSION] [DIST_DIR]
set -euo pipefail

VERSION="${1:-dev}"
DIST_DIR="${2:-dist}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

PLATFORMS=(
  "darwin/amd64"
  "darwin/arm64"
  "linux/amd64"
  "linux/arm64"
  "linux/arm"
  "windows/amd64"
  "windows/arm64"
)

echo "==> Building mindfs ${VERSION}"
echo "    Output: ${DIST_DIR}/"
echo

for PLATFORM in "${PLATFORMS[@]}"; do
  GOOS="${PLATFORM%%/*}"
  GOARCH="${PLATFORM##*/}"

  BIN_NAME="mindfs"
  [[ "$GOOS" == "windows" ]] && BIN_NAME="mindfs.exe"

  OUT_DIR="${DIST_DIR}/mindfs_${VERSION}_${GOOS}_${GOARCH}"
  mkdir -p "${ROOT}/${OUT_DIR}"

  TARGET="${OUT_DIR}/${BIN_NAME}"
  printf "  %-20s -> %s\n" "${GOOS}/${GOARCH}" "${TARGET}"

  GOARM=""
  if [[ "$GOARCH" == "arm" ]]; then
    GOARM=7
  fi

  CGO_ENABLED=0 \
    GOOS="$GOOS" \
    GOARCH="$GOARCH" \
    GOARM="$GOARM" \
    go build \
      -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o "${ROOT}/${TARGET}" \
      ./cli/cmd

  # Bundle web assets (already built) and install scripts
  if [[ -d "${ROOT}/web/dist" ]]; then
    cp -r "${ROOT}/web/dist" "${ROOT}/${OUT_DIR}/web"
  fi
  if [[ -f "${ROOT}/agents.json" ]]; then
    cp "${ROOT}/agents.json" "${ROOT}/${OUT_DIR}/agents.json"
  fi
done

# Produce archives
cd "${ROOT}/${DIST_DIR}"
for DIR in mindfs_*/; do
  DIR="${DIR%/}"
  GOOS="$(echo "$DIR" | cut -d_ -f3)"
  if [[ "$GOOS" == "windows" ]]; then
    zip -qr "${DIR}.zip" "$DIR"
    echo "  Archived: ${DIST_DIR}/${DIR}.zip"
  else
    tar czf "${DIR}.tar.gz" "$DIR"
    echo "  Archived: ${DIST_DIR}/${DIR}.tar.gz"
  fi
done

echo
echo "==> Done. Artifacts in ${DIST_DIR}/"
