FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Europe/Berlin
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
COPY docker-entrypoint.sh /usr/local/bin/
ENV PUID=99 PGID=100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
