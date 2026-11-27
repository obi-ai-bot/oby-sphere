# The Sphere relay: one small Node process, no dependencies.
#   docker build -t obysphere .
#   docker run -p 8080:8080 -v obysphere-data:/data -e SPHERE_ADMIN_KEY=… obysphere
# pinned to a digest (the multi-platform index); Dependabot proposes the next one
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# su-exec: start as root only to take ownership of the data volume (Railway and
# others mount volumes as root), then run the relay as the unprivileged `node` user.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json server.mjs rep.mjs API.md docker-entrypoint.sh ./
COPY public ./public
RUN chmod 755 docker-entrypoint.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SPHERE_DATA=/data \
    SPHERE_SEALED=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
