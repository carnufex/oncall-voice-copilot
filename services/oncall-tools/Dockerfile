# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# node:22-alpine ships user `node` as uid/gid 1000; matches the pod securityContext/fsGroup.
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
