# Usamos Ubuntu 24.04 que tiene la versión moderna de GLIBC (2.39)
# Esto permite usar los binarios precompilados sin tener que compilar nada desde cero.
FROM ubuntu:24.04

# Evitar prompts interactivos durante la instalación
ENV DEBIAN_FRONTEND=noninteractive

# Instalar Node.js 20 y dependencias básicas
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json primero
COPY package*.json ./

# Instalación normal limpia, sin forzar compilaciones
RUN npm install

# Copiar el código
COPY . .

# Crear y dar permisos a carpetas
RUN mkdir -p data public/uploads && chmod -R 777 data public/uploads

EXPOSE 3000

CMD ["npm", "start"]
