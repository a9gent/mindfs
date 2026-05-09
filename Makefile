.PHONY: help dev dev-backend dev-web build-web build build-android install uninstall build-all start start-server test dist-clean publish-release-notes release tag

GO ?= go
NPM ?= npm
WEB_DIR ?= web
ANDROID_DIR ?= android
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
		"  make build-android # build Android release APK into dist/" \
		"  make install      # install binary and built static assets into $(PREFIX)" \
		"  make uninstall    # remove installed binary and static assets from $(PREFIX)" \
		"  make build-all    # cross-compile for all platforms into dist/" \
		"  make dist-clean   # remove dist/ directory" \
		"  make start        # run mindfs on $(ADDR) with built static assets" \
		"  make start-server # backend entrypoint serving built static assets" \
		"  make test         # run Go tests" \
		"  make tag TAG=v1.2.3  # create and push a git tag" \
		"  make publish-release-notes TAG=v1.2.3  # commit and push release-notes.md if changed" \
		"  make release TAG=v1.2.3  # publish notes, build-all, then create GitHub release" \
		"  make release TAG=v1.2.3 RELEASE_ANDROID=1  # include Android APK"

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
RELEASE_NOTES_FILE ?= release-notes.md
RELEASE_NOTES_LATEST_FILE ?= $(DIST_DIR)/release-notes-$(TAG).md
ANDROID_RELEASE_APK ?= $(ANDROID_DIR)/app/build/outputs/apk/release/app-release.apk
ANDROID_DIST_APK ?= $(DIST_DIR)/mindfs_$(VERSION)_android.apk
RELEASE_ANDROID ?= 0
RELEASE_UPLOAD_JOBS ?= 4
RELEASE_ARTIFACTS := $(DIST_DIR)/mindfs_$(TAG)_*.tar.gz $(DIST_DIR)/mindfs_$(TAG)_*.zip
ifeq ($(RELEASE_ANDROID),1)
RELEASE_ARTIFACTS += $(DIST_DIR)/mindfs_$(TAG)_android.apk
endif

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

build-android:
	cd $(WEB_DIR) && $(NPM) run build:android
	cd $(ANDROID_DIR) && ./gradlew assembleRelease -PmindfsVersion="$(VERSION)"
	mkdir -p "$(DIST_DIR)"
	cp "$(ANDROID_RELEASE_APK)" "$(ANDROID_DIST_APK)"

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

# Usage: make publish-release-notes TAG=v1.2.3
publish-release-notes:
	@test -n "$(TAG)" || (echo "Usage: make publish-release-notes TAG=v1.2.3" >&2; exit 1)
	@test -f "$(RELEASE_NOTES_FILE)" || (echo "Error: release notes file not found: $(RELEASE_NOTES_FILE)" >&2; exit 1)
	@version="$$(sed -nE '1s/^#[[:space:]]+MindFS[[:space:]]+(v?[0-9]+(\.[0-9]+){1,3}[^[:space:]]*).*$$/\1/p' "$(RELEASE_NOTES_FILE)")"; \
		test "$$version" = "$(TAG)" || (echo "Error: $(RELEASE_NOTES_FILE) first line version '$$version' does not match TAG '$(TAG)'." >&2; exit 1)
	git add "$(RELEASE_NOTES_FILE)"
	@if git diff --cached --quiet -- "$(RELEASE_NOTES_FILE)"; then \
		echo "No release notes changes to commit."; \
	else \
		git commit -m "update release notes"; \
		git push origin main; \
	fi

# Usage: make release TAG=v1.2.3 [RELEASE_ANDROID=1]
# Builds desktop/server platforms and creates a GitHub release.
release:
	@command -v gh >/dev/null 2>&1 || (echo "Error: gh (GitHub CLI) is required. https://cli.github.com" >&2; exit 1)
	@test -n "$(TAG)" || (echo "Usage: make release TAG=v1.2.3 [RELEASE_ANDROID=1]" >&2; exit 1)
	@test -f "$(RELEASE_NOTES_FILE)" || (echo "Error: release notes file not found: $(RELEASE_NOTES_FILE)" >&2; exit 1)
	@version="$$(sed -nE '1s/^#[[:space:]]+MindFS[[:space:]]+(v?[0-9]+(\.[0-9]+){1,3}[^[:space:]]*).*$$/\1/p' "$(RELEASE_NOTES_FILE)")"; \
		test "$$version" = "$(TAG)" || (echo "Error: $(RELEASE_NOTES_FILE) first line version '$$version' does not match TAG '$(TAG)'." >&2; exit 1)
	$(MAKE) dist-clean
	mkdir -p "$(DIST_DIR)"
	@awk 'NR > 1 && /^# MindFS[[:space:]]+/ { exit } { print }' "$(RELEASE_NOTES_FILE)" > "$(RELEASE_NOTES_LATEST_FILE)"
	$(MAKE) build-all VERSION="$(TAG)"
	@if [ "$(RELEASE_ANDROID)" = "1" ]; then \
		$(MAKE) build-android VERSION="$(TAG)"; \
	else \
		echo "Skipping Android release. Use RELEASE_ANDROID=1 to include the APK."; \
	fi
	@echo "Creating draft GitHub release $(TAG)"
	gh release create $(TAG) \
		--draft \
		--title "$(TAG)" \
		--notes-file "$(RELEASE_NOTES_LATEST_FILE)"
	@echo "Uploading release artifacts with $(RELEASE_UPLOAD_JOBS) parallel jobs"
	@set -- $(RELEASE_ARTIFACTS); \
		for artifact do \
			test -f "$$artifact" || { echo "Error: release artifact not found: $$artifact" >&2; exit 1; }; \
		done; \
		printf '%s\n' "$$@" | xargs -n 1 -P "$(RELEASE_UPLOAD_JOBS)" gh release upload "$(TAG)"
	@echo "Publishing GitHub release $(TAG)"
	gh release edit "$(TAG)" --draft=false
	$(MAKE) publish-release-notes TAG="$(TAG)"
