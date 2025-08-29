# Base Playwright com browsers e deps já inclusos
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Pasta persistente p/ datasets do Crawlee
VOLUME ["/app/storage"]
ENV CRAWLEE_STORAGE_DIR=/app/storage

EXPOSE 3000
CMD ["node", "server.js"]