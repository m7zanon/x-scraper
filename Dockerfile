# Base Playwright com browsers e deps já inclusos
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package*.json ./

# Instalar dependências e browsers do Playwright
RUN npm install && npx playwright install --with-deps

COPY . .

# Pasta persistente p/ datasets do Crawlee
VOLUME ["/app/storage"]
ENV CRAWLEE_STORAGE_DIR=/app/storage

EXPOSE 3000
CMD ["node", "server.js"]