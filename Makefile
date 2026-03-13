.PHONY: help dev dev-backend dev-web build-web build start start-server test

GO ?= go
NPM ?= npm
WEB_DIR ?= web
ADDR ?= :7331
ROOT ?= .

help:
	@printf "%s\n" \
		"Targets:" \
		"  make dev          # backend + Vite dev server (dual port)" \
		"  make dev-backend  # backend only on $(ADDR)" \
		"  make dev-web      # Vite dev server only" \
		"  make build-web    # build web assets into web/dist" \
		"  make build        # build web assets and backend binary" \
		"  make start        # single-port run with built web assets" \
		"  make start-server # single-port run via backend entrypoint" \
		"  make test         # run Go tests"

dev:
	$(GO) run ./cli/cmd -addr $(ADDR) $(ROOT)

dev-backend:
	$(GO) run ./server/cmd/mindfs-server -addr $(ADDR)

dev-web:
	cd $(WEB_DIR) && $(NPM) run dev

build-web:
	cd $(WEB_DIR) && $(NPM) run build

build: build-web
	$(GO) build -o mindfs ./cli/cmd

start:
	$(GO) run ./cli/cmd -web=false -addr $(ADDR) $(ROOT)

start-server:
	$(GO) run ./server/cmd/mindfs-server -addr $(ADDR)

test:
	$(GO) test ./...
