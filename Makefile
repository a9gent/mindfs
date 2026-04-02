.PHONY: help dev dev-backend dev-web build-web build install uninstall build-all start start-server test dist-clean release tag

GO ?= go
NPM ?= npm
WEB_DIR ?= web
ADDR ?= :7331
ROOT ?= .
PREFIX ?= $(HOME)/.local

help:
	@printf "%s\n" \
		"Targets:" \
		"  make dev          # run mindfs on $(ADDR)" \
		"  make dev-backend  # backend only on $(ADDR)" \
		"  make dev-web      # Vite dev server only" \
		"  make build-web    # build web assets into web/dist" \
		"  make build        # build web assets and CLI binary" \
		"  make install      # install binary and built static assets into $(PREFIX)" \
		"  make uninstall    # remove installed binary and static assets from $(PREFIX)" \
		"  make build-all    # cross-compile for all platforms into dist/" \
		"  make dist-clean   # remove dist/ directory" \
		"  make start        # run mindfs on $(ADDR) with built static assets" \
		"  make start-server # backend entrypoint serving built static assets" \
		"  make test         # run Go tests" \
		"  make tag TAG=v1.2.3  # create and push a git tag" \
		"  make release TAG=v1.2.3  # build-all then create GitHub release using release-notes/TAG.md"

dev:
	$(GO) run ./cli/cmd -addr $(ADDR) $(ROOT)

dev-backend:
	$(GO) run ./server/cmd/mindfs-server -addr $(ADDR)

dev-web:
	cd $(WEB_DIR) && $(NPM) run dev

build-web:
	cd $(WEB_DIR) && $(NPM) run build

build: build-web
	$(GO) build -ldflags "-X main.version=$(VERSION)" -o mindfs ./cli/cmd

install: build
	install -d "$(PREFIX)/bin"
	install -d "$(PREFIX)/share/mindfs"
	install -m 0755 mindfs "$(PREFIX)/bin/mindfs"
	install -m 0644 agents.json "$(PREFIX)/share/mindfs/agents.json"
	rm -rf "$(PREFIX)/share/mindfs/web"
	cp -R "$(WEB_DIR)/dist" "$(PREFIX)/share/mindfs/web"

uninstall:
	rm -f "$(PREFIX)/bin/mindfs"
	rm -rf "$(PREFIX)/share/mindfs"

start:
	$(GO) run ./cli/cmd -addr $(ADDR) $(ROOT)

start-server:
	$(GO) run ./server/cmd/mindfs-server -addr $(ADDR)

test:
	$(GO) test ./...

# ── Cross-platform distribution ──────────────────────────────────────────
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
DIST_DIR ?= dist
RELEASE_NOTES_DIR ?= release-notes

# Targets: OS/ARCH pairs
PLATFORMS := \
	darwin/amd64 \
	darwin/arm64 \
	linux/amd64 \
	linux/arm64 \
	linux/arm \
	windows/amd64 \
	windows/arm64

build-all: build-web
	@bash scripts/build-all.sh "$(VERSION)" "$(DIST_DIR)"

dist-clean:
	rm -rf $(DIST_DIR)

# ── Release ──────────────────────────────────────────────────────────────
# Usage: make tag TAG=v1.2.3
tag:
	@test -n "$(TAG)" || (echo "Usage: make tag TAG=v1.2.3" >&2; exit 1)
	@echo "Tagging $(TAG)"
	git push origin main
	git tag $(TAG)
	git push origin $(TAG)

# Usage: make release TAG=v1.2.3
# Builds all platforms and creates a GitHub release with all artifacts.
# Requires $(RELEASE_NOTES_DIR)/$(TAG).md to exist.
release: dist-clean build-all
	@command -v gh >/dev/null 2>&1 || (echo "Error: gh (GitHub CLI) is required. https://cli.github.com" >&2; exit 1)
	@test -n "$(TAG)" || (echo "Usage: make release TAG=v1.2.3" >&2; exit 1)
	@test -f "$(RELEASE_NOTES_DIR)/$(TAG).md" || (echo "Error: release notes file not found: $(RELEASE_NOTES_DIR)/$(TAG).md" >&2; exit 1)
	@echo "Creating GitHub release $(TAG)"
	gh release create $(TAG) $(DIST_DIR)/*.tar.gz $(DIST_DIR)/*.zip \
		--title "$(TAG)" \
		--notes-file "$(RELEASE_NOTES_DIR)/$(TAG).md"
