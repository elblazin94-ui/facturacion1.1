# Usamos una imagen de Node.js estable sobre Debian Bookworm
FROM node:20-bookworm

# Actualizamos e instalamos las herramientas necesarias para compilar módulos nativos (g++, make, python)
# Esto soluciona el conflicto de GLIBC al compilar sqlite3 directamente en el entorno de Railway
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    pkg-config \
    libvips-dev \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Definimos el directorio de trabajo
WORKDIR /app

# Copiamos primero los archivos de dependencias para aprovechar la caché de Docker
COPY package*.json ./

# Forzamos la compilación de sqlite3 desde el código fuente para asegurar compatibilidad con la GLIBC local
RUN npm install --build-from-source sqlite3

# Instalamos el resto de las dependencias
RUN npm install

# Copiamos el resto del código de la aplicación
COPY . .

# Creamos la carpeta de datos por si acaso y damos permisos
RUN mkdir -p data public/uploads && chmod -R 777 data public/uploads

# Exponemos el puerto que usará Railway (inyectado vía variable de entorno)
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
