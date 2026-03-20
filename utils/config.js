// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Configuración Global
 * 
 * Configuración centralizada para reintentos, timeouts, cache, etc.
 * 
 * @module dte-sii/utils/config
 */

// ============================================
// CONFIGURACIÓN DEFAULT
// ============================================

const DEFAULT_CONFIG = {
  // Reintentos de conexión SII
  retry: {
    maxRetries: 8,
    initialDelay: 2000,
    maxDelay: 15000,
    backoffMultiplier: 1.8,
    retryableStatusCodes: [500, 502, 503, 504, 429],
    retryableErrors: ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
  },

  // Cache de tokens SII
  tokenCache: {
    enabled: true,
    ttlMinutes: 55,
  },

  // Timeouts
  timeout: {
    soap: 30000,
    rest: 15000,
    upload: 60000,
  },

  // Debug
  debug: {
    saveArtifacts: true,
    logLevel: 'info',
  },
};

// ============================================
// ESTADO GLOBAL
// ============================================

let currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

// ============================================
// FUNCIONES DE CONFIGURACIÓN
// ============================================

/**
 * Obtener configuración actual completa
 * @returns {Object} Configuración actual
 */
function getConfig() {
  return JSON.parse(JSON.stringify(currentConfig));
}

/**
 * Obtener una sección específica de la configuración
 * @param {string} section - Nombre de la sección ('retry', 'tokenCache', 'timeout', 'debug')
 * @returns {Object} Sección de configuración
 */
function getConfigSection(section) {
  return currentConfig[section] ? { ...currentConfig[section] } : null;
}

/**
 * Configurar opciones (merge con existentes)
 * @param {Object} options - Opciones a configurar
 * @returns {Object} Configuración resultante
 */
function configure(options = {}) {
  // Merge profundo
  for (const section of Object.keys(options)) {
    if (currentConfig[section] && typeof options[section] === 'object') {
      currentConfig[section] = {
        ...currentConfig[section],
        ...options[section],
      };
    } else {
      currentConfig[section] = options[section];
    }
  }
  
  return getConfig();
}

/**
 * Configurar reintentos
 * @param {Object} retryOptions - Opciones de reintento
 */
function configureRetry(retryOptions = {}) {
  currentConfig.retry = {
    ...currentConfig.retry,
    ...retryOptions,
  };
  return currentConfig.retry;
}

/**
 * Configurar cache de tokens
 * @param {Object} cacheOptions - Opciones de cache
 */
function configureTokenCache(cacheOptions = {}) {
  currentConfig.tokenCache = {
    ...currentConfig.tokenCache,
    ...cacheOptions,
  };
  return currentConfig.tokenCache;
}

/**
 * Configurar timeouts
 * @param {Object} timeoutOptions - Opciones de timeout
 */
function configureTimeout(timeoutOptions = {}) {
  currentConfig.timeout = {
    ...currentConfig.timeout,
    ...timeoutOptions,
  };
  return currentConfig.timeout;
}

/**
 * Resetear a configuración default
 * @returns {Object} Configuración reseteada
 */
function resetConfig() {
  currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return getConfig();
}

/**
 * Configuración rápida para producción (menos logs, más reintentos)
 */
function configureForProduction() {
  return configure({
    retry: {
      maxRetries: 10,
      initialDelay: 2000,
    },
    debug: {
      saveArtifacts: false,
      logLevel: 'warn',
    },
  });
}

/**
 * Configuración rápida para desarrollo (más logs, menos reintentos)
 */
function configureForDevelopment() {
  return configure({
    retry: {
      maxRetries: 3,
      initialDelay: 500,
    },
    debug: {
      saveArtifacts: true,
      logLevel: 'debug',
    },
  });
}

// ============================================
// HELPERS DE RETRY
// ============================================

/**
 * Calcular delay para un intento específico (backoff exponencial)
 * @param {number} attempt - Número de intento (1-based)
 * @returns {number} Delay en ms
 */
function calculateRetryDelay(attempt) {
  const { initialDelay, maxDelay, backoffMultiplier } = currentConfig.retry;
  const delay = initialDelay * Math.pow(backoffMultiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Verificar si un error es retriable
 * @param {Error} error - Error a verificar
 * @returns {boolean} True si se puede reintentar
 */
function isRetryableError(error) {
  const { retryableErrors } = currentConfig.retry;
  const errorCode = error?.code || error?.cause?.code || '';
  return retryableErrors.some(code => 
    errorCode.includes(code) || error?.message?.includes(code)
  );
}

/**
 * Verificar si un status HTTP es retriable
 * @param {number} status - Status code HTTP
 * @returns {boolean} True si se puede reintentar
 */
function isRetryableStatus(status) {
  return currentConfig.retry.retryableStatusCodes.includes(status);
}

/**
 * Ejecutar función con reintentos
 * @param {Function} fn - Función async a ejecutar
 * @param {Object} options - Opciones
 * @param {string} [options.name] - Nombre para logs
 * @param {Function} [options.onRetry] - Callback en cada reintento
 * @returns {Promise} Resultado de la función
 */
async function withRetry(fn, options = {}) {
  const { name = 'operación', onRetry } = options;
  const { maxRetries } = currentConfig.retry;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      const canRetry = attempt < maxRetries && (
        isRetryableError(error) || 
        isRetryableStatus(error?.status)
      );
      
      if (!canRetry) {
        throw error;
      }
      
      const delay = calculateRetryDelay(attempt);
      
      if (onRetry) {
        onRetry(attempt, maxRetries, error, delay);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Configuración
  getConfig,
  getConfigSection,
  configure,
  configureRetry,
  configureTokenCache,
  configureTimeout,
  resetConfig,
  
  // Presets
  configureForProduction,
  configureForDevelopment,
  
  // Helpers
  calculateRetryDelay,
  isRetryableError,
  isRetryableStatus,
  withRetry,
  
  // Constantes
  DEFAULT_CONFIG,
};
