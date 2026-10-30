# syntax=docker/dockerfile:1
#
# Eén image voor alles: de API, het gebouwde dashboard (op /) en de widget (op /widget.js).
# De widget en het dashboard worden tijdens de build gecompileerd; in productie draait alleen
# wat er dan in zit.

FROM node:24-alpine AS build
RUN npm install -g pnpm@9.12.0
WORKDIR /app

# Eerst alleen de manifesten, zodat een codewijziging de dependency-laag niet ongeldig maakt.
# pnpm-workspace.yaml moet mee: zonder dat bestand ziet pnpm geen workspaces en installeert hij
# alleen de root, waarna elke package zijn eigen node_modules mist.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/widget/package.json packages/widget/
RUN pnpm install --frozen-lockfile

COPY . .
# Typecheck en tests horen niet in de image-build: dat doet CI. Hier alleen bouwen wat geserveerd wordt.
RUN pnpm --filter @ai-lead/dashboard build \
 && pnpm --filter @ai-lead/widget build

FROM node:24-alpine
RUN npm install -g pnpm@9.12.0
WORKDIR /app

# 0.0.0.0 is binnen een container nodig; de poort wordt niet naar buiten gepubliceerd maar via
# de reverse proxy op de host bereikt (zie docker-compose.prod.yml).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

COPY --from=build /app /app

# Niet als root draaien. De bestanden zijn alleen-lezen nodig; node_modules staat er al.
USER node
EXPOSE 8787

# tsx draait de TypeScript rechtstreeks, net als lokaal. Een gecompileerde build (tsc → dist) is een
# optimalisatie voor later: die kost een extra buildstap en een tweede uitvoerpad om te onderhouden.
CMD ["pnpm", "--filter", "@ai-lead/api", "start"]
