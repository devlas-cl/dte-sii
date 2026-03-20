// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Logger Configurable
 * 
 * Logger que puede silenciarse en producción o configurarse por nivel
 * 
 * @module dte-sii/utils/logger
 */

// ============================================
// NIVELES DE LOG
// ============================================

const LOG_LEVELS = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
  TRACE: 5,
};

// ============================================
// CONFIGURACIÓN GLOBAL
// ============================================

let globalConfig = {
  level: LOG_LEVELS.INFO,
  prefix: '[dte-sii]',
  timestamps: false,
  colors: true,
};

// ============================================
// FUNCIONES INTERNAS
// ============================================

function getTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, ...args) {
  const parts = [];
  
  if (globalConfig.timestamps) {
    parts.push(`[${getTimestamp()}]`);
  }
  
  if (globalConfig.prefix) {
    parts.push(globalConfig.prefix);
  }
  
  parts.push(`[${level}]`);
  
  return parts.join(' ');
}

// ============================================
// LOGGER PRINCIPAL
// ============================================

const logger = {
  /**
   * Log de error (siempre visible excepto SILENT)
   */
  error(...args) {
    if (globalConfig.level >= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR'), ...args);
    }
  },

  /**
   * Log de advertencia
   */
  warn(...args) {
    if (globalConfig.level >= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN'), ...args);
    }
  },

  /**
   * Log informativo (default)
   */
  info(...args) {
    if (globalConfig.level >= LOG_LEVELS.INFO) {
      console.log(formatMessage('INFO'), ...args);
    }
  },

  /**
   * Log de debug (solo en desarrollo)
   */
  debug(...args) {
    if (globalConfig.level >= LOG_LEVELS.DEBUG) {
      console.log(formatMessage('DEBUG'), ...args);
    }
  },

  /**
   * Log de trace (muy detallado)
   */
  trace(...args) {
    if (globalConfig.level >= LOG_LEVELS.TRACE) {
      console.log(formatMessage('TRACE'), ...args);
    }
  },

  /**
   * Log simple sin formato (para compatibilidad)
   * Respeta el nivel INFO
   */
  log(...args) {
    if (globalConfig.level >= LOG_LEVELS.INFO) {
      console.log(...args);
    }
  },
};

// ============================================
// CONFIGURACIÓN
// ============================================

/**
 * Configurar el logger
 * @param {Object} config - Configuración
 * @param {string|number} [config.level] - Nivel: 'silent', 'error', 'warn', 'info', 'debug', 'trace' o número
 * @param {string} [config.prefix] - Prefijo para mensajes
 * @param {boolean} [config.timestamps] - Incluir timestamps
 * @param {boolean} [config.colors] - Usar colores (reservado para futuro)
 */
function configureLogger(config = {}) {
  if (config.level !== undefined) {
    if (typeof config.level === 'string') {
      const levelName = config.level.toUpperCase();
      globalConfig.level = LOG_LEVELS[levelName] ?? LOG_LEVELS.INFO;
    } else if (typeof config.level === 'number') {
      globalConfig.level = config.level;
    }
  }
  
  if (config.prefix !== undefined) {
    globalConfig.prefix = config.prefix;
  }
  
  if (config.timestamps !== undefined) {
    globalConfig.timestamps = config.timestamps;
  }
  
  if (config.colors !== undefined) {
    globalConfig.colors = config.colors;
  }
  
  return { ...globalConfig };
}

/**
 * Silenciar completamente el logger
 */
function silenceLogger() {
  globalConfig.level = LOG_LEVELS.SILENT;
}

/**
 * Restaurar logger a nivel INFO
 */
function enableLogger() {
  globalConfig.level = LOG_LEVELS.INFO;
}

/**
 * Obtener configuración actual
 */
function getLoggerConfig() {
  return { ...globalConfig };
}

/**
 * Crear un logger con prefijo específico (scoped logger)
 * @param {string} scope - Nombre del scope (ej: 'CAF', 'DTE', 'EnviadorSII')
 * @returns {Object} Logger con scope
 */
function createScopedLogger(scope) {
  const scopePrefix = `[${scope}]`;
  
  return {
    error(...args) {
      if (globalConfig.level >= LOG_LEVELS.ERROR) {
        console.error(formatMessage('ERROR'), scopePrefix, ...args);
      }
    },
    warn(...args) {
      if (globalConfig.level >= LOG_LEVELS.WARN) {
        console.warn(formatMessage('WARN'), scopePrefix, ...args);
      }
    },
    info(...args) {
      if (globalConfig.level >= LOG_LEVELS.INFO) {
        console.log(formatMessage('INFO'), scopePrefix, ...args);
      }
    },
    debug(...args) {
      if (globalConfig.level >= LOG_LEVELS.DEBUG) {
        console.log(formatMessage('DEBUG'), scopePrefix, ...args);
      }
    },
    trace(...args) {
      if (globalConfig.level >= LOG_LEVELS.TRACE) {
        console.log(formatMessage('TRACE'), scopePrefix, ...args);
      }
    },
    log(...args) {
      if (globalConfig.level >= LOG_LEVELS.INFO) {
        console.log(scopePrefix, ...args);
      }
    },
  };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Logger principal
  logger,
  
  // Constantes
  LOG_LEVELS,
  
  // Configuración
  configureLogger,
  silenceLogger,
  enableLogger,
  getLoggerConfig,
  
  // Factory
  createScopedLogger,
};
