# Etapa 1: imagem base com Node.js e Chromium compatível com Puppeteer
FROM node:20-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Instala dependências necessárias para o Puppeteer funcionar
RUN apt-get update && apt-get install -y \
  chromium \
  libglib2.0-0 \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  fonts-liberation \
  xdg-utils \
  wget \
  ffmpeg \
  --no-install-recommends && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

# Cria diretório de trabalho
WORKDIR /app

# Copia todos os arquivos
COPY . .

# Instala dependências
RUN npm install

# Expõe a porta (caso você use algum servidor HTTP interno)
EXPOSE 3000

# Comando para iniciar o bot
CMD ["npx", "tsx", "src/index.ts"]
