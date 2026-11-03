FROM node:24.18.1-bookworm-slim
WORKDIR /app
COPY agent/package*.json ./
RUN npm ci --omit=dev
COPY agent/src ./src
USER node
ENV AGENT_HOST=0.0.0.0 AGENT_PORT=8787
CMD ["node", "src/server.mjs"]
