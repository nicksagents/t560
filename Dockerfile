FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY bin ./bin
COPY src ./src

RUN chmod +x /app/bin/t560.mjs || true

ENV NODE_ENV=production
ENV HOME=/home/node
ENV T560_STATE_DIR=/home/node/.t560

# Run as non-root user (built into the base image).
USER node

CMD ["node","src/cli.js","gateway"]

