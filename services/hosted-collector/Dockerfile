FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/service/package.json apps/service/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY services/hosted-collector/src ./services/hosted-collector/src
RUN npm run build:hosted

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTED_DB=/data/hosted.sqlite HOSTED_BIND=0.0.0.0 HOSTED_PORT=8787
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build /src/dist/hosted.cjs ./
COPY --from=build /src/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /src/node_modules/bindings ./node_modules/bindings
COPY --from=build /src/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
USER node
EXPOSE 8787
ENTRYPOINT ["node", "/app/hosted.cjs"]
CMD ["serve"]
