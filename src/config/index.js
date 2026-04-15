// Get system username for macOS default PostgreSQL user
const os = require('os');
const defaultDbUser = os.userInfo().username;

const config = {
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'gesprojet',
    user: process.env.DB_USER || defaultDbUser,
    password: process.env.DB_PASSWORD || '',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
  jwt: {
    secret: process.env.JWT_SECRET || (() => {
      const crypto = require('crypto');
      const fallback = crypto.randomBytes(48).toString('hex');
      console.warn('⚠️  JWT_SECRET non défini — clé aléatoire générée (les sessions ne survivront pas au redémarrage)');
      return fallback;
    })(),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  server: {
    port: parseInt(process.env.PORT) || 3001,
    env: process.env.NODE_ENV || 'development',
  }
};

function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  const requiredDbVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  for (const varName of requiredDbVars) {
    if (!process.env[varName]) {
      errors.push(`Variable d'environnement manquante : ${varName}`);
    }
  }

  if (!process.env.PORT) {
    errors.push("Variable d'environnement manquante : PORT");
  }

  if (!process.env.JWT_SECRET) {
    errors.push("Variable d'environnement manquante : JWT_SECRET");
  } else if (process.env.JWT_SECRET === 'super-secret-key') {
    errors.push("JWT_SECRET utilise la valeur par défaut 'super-secret-key' — veuillez définir une clé sécurisée");
  } else if (process.env.JWT_SECRET.length < 32) {
    warnings.push("JWT_SECRET est trop court (minimum recommandé : 32 caractères)");
  }

  if (isProduction) {
    if (errors.length > 0) {
      console.error('\n❌ ERREUR DE CONFIGURATION — Impossible de démarrer en production :\n');
      errors.forEach(err => console.error(`   • ${err}`));
      if (warnings.length > 0) {
        console.warn('\n⚠️  Avertissements :');
        warnings.forEach(w => console.warn(`   • ${w}`));
      }
      console.error('');
      throw new Error(`Configuration invalide pour la production (${errors.length} erreur(s)). Vérifiez vos variables d'environnement.`);
    }
    if (warnings.length > 0) {
      console.warn('\n⚠️  Avertissements de configuration (production) :');
      warnings.forEach(w => console.warn(`   • ${w}`));
      console.warn('');
    }
  } else {
    const allMessages = [...errors, ...warnings];
    if (allMessages.length > 0) {
      console.warn('\n⚠️  Avertissements de configuration (développement) :');
      allMessages.forEach(msg => console.warn(`   • ${msg}`));
      console.warn('');
    }
  }
}

validateEnv();

module.exports = config;
