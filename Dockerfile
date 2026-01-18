# ================================================
# DOCKERFILE BACKEND - BIS-GESPROJET
# ================================================
FROM node:20-alpine

# Définir le répertoire de travail
WORKDIR /app

# Installer les dépendances système
RUN apk add --no-cache python3 make g++

# Copier les fichiers de dépendances
COPY package.json ./

# Installer les dépendances (utiliser npm install car pas de package-lock.json local)
# Le projet utilise npm workspaces, donc le lock file est à la racine
RUN npm install --omit=dev --legacy-peer-deps

# Copier le code source
COPY . .

# Créer le dossier uploads
RUN mkdir -p uploads logs

# Exposer le port
EXPOSE 3001

# Variables d'environnement par défaut
ENV NODE_ENV=production
ENV PORT=3001

# Commande de démarrage
CMD ["node", "src/index.js"]
