FROM --platform=$BUILDPLATFORM node:24.19-slim AS check
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
RUN npm ci
COPY core ./core
COPY src ./src
COPY tools ./tools
COPY openapi.yaml ./
RUN npm test && npx tsc --noEmit \
	&& rm -rf core/*.test.ts src/*.test.ts src/testing.ts vitest.config.ts tools \
	&& mkdir -p /data
RUN npm prune --omit=dev \
	&& find node_modules -type d -name prebuilds -exec sh -c \
	'for d in "$1"/*; do case "$(basename "$d")" in linux-*) ;; *) rm -rf "$d";; esac; done' _ {} \; \
	&& find node_modules -name "*.bare" -delete

FROM node:24.19-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=check /app/node_modules ./node_modules
COPY --from=check /app/core ./core
COPY --from=check /app/src ./src
COPY --from=check /app/openapi.yaml ./
COPY --from=check /data /data
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /app /data
ENV LEDGER=/data/ledger.db
EXPOSE 3000/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.ts"]
