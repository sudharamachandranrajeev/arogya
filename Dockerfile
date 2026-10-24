FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 AROGYA_DATA=/data/pg
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/data ./data
COPY --from=build /app/web/dist ./web/dist
VOLUME /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
