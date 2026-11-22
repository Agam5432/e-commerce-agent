# Production image for the Orbi backend.
#   docker build -t orbi-backend .
#   docker run --env-file .env -p 3000:3000 orbi-backend
# Settings come from the environment (see .env.example); the image never contains .env.
FROM node:22.11.0-alpine3.20

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_TMP_DIR=/tmp/orbi-uploads

WORKDIR /app

# dependencies first, so a code change does not reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY scripts ./scripts

# never run as root
USER node

EXPOSE 3000

# /healthz answers while the process is alive; the orchestrator restarts it otherwise
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
