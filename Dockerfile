FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm pack pnpm@12.18.0 --ignore-scripts --pack-destination /tmp \
 && echo "9d7882d5dc82147ecfc4e062aa34834e0ad0296710a1837a1115ae012127d36b7109e321ac1598a1dd0a65597681b1e99917e12ed0d749eae91187943363beb3  /tmp/pnpm-12.18.0.tgz" | sha512sum -c - \
 && npm install --global --ignore-scripts /tmp/pnpm-12.18.0.tgz \
 && rm /tmp/pnpm-12.18.0.tgz \
 && [ "$(pnpm --version)" = "12.18.0" ] \
 && pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json vite.config.ts vitest.config.ts ./
COPY Dockerfile compose.yaml compose.https.yaml ./
COPY src ./src
COPY tests ./tests
COPY docker ./docker
COPY migrations ./migrations
RUN pnpm test && pnpm run typecheck && pnpm run build
RUN pnpm prune --prod

FROM node:22.22.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker ./docker
COPY migrations ./migrations
USER 1000:1000
CMD ["node", "docker/start.mjs"]
