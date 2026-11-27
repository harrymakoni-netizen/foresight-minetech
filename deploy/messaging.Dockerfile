# Messaging service (scheduler, outbox, gateway heartbeat) and the mock gateway.
#   docker build -f deploy/messaging.Dockerfile -t foresight-messaging .
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib lib
COPY services/messaging services/messaging
COPY migrations migrations
COPY certificates certificates
ENV NODE_ENV=production MESSAGING_MODE=dry-run
USER node
CMD ["node", "--experimental-strip-types", "services/messaging/service.ts"]
