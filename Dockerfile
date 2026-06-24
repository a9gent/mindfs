FROM archlinux:latest AS base

RUN pacman -Syu --noconfirm  \
  ca-certificates \
  git \
  go \
  nodejs \
  npm \
  && pacman -Scc --noconfirm 

FROM base AS web-builder

WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci \
  && npm cache clean --force \
  && rm -rf /root/.npm

COPY web/ ./
RUN npm run build \
  && npm cache clean --force \
  && rm -rf /root/.npm

FROM base AS go-builder

ARG VERSION=dev
ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cli/ ./cli/
COPY server/ ./server/

RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH:-amd64}" \
  go build -trimpath -ldflags "-s -w" \
  -o /out/mindfs ./cli/cmd \
  && go clean -modcache -cache

FROM base AS runtime

RUN mkdir -p /opt/mindfs/bin /opt/mindfs/share/mindfs /workspace

COPY --from=go-builder /out/mindfs /opt/mindfs/bin/mindfs
COPY --from=web-builder /src/web/dist /opt/mindfs/share/mindfs/web
COPY agents.json /opt/mindfs/share/mindfs/agents.json

WORKDIR /workspace

EXPOSE 7331

ENTRYPOINT ["/opt/mindfs/bin/mindfs"]
CMD ["--foreground", "-addr", "0.0.0.0:7331", "/workspace"]
