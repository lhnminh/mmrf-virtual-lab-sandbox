FROM node:24.18.1-bookworm-slim
WORKDIR /app
COPY agent/package*.json ./
RUN npm ci --omit=dev
COPY agent/src ./src
USER node
ENV AGENT_HOST=0.0.0.0 AGENT_PORT=8787
# Register the AWS tracer provider before the ESM server loads Strands.
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "src/server.mjs"]
