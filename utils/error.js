// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Clase de Error Personalizada
 * 
 * Errores tipados para mejor manejo y debugging
 * 
 * @module dte-sii/utils/error
 */

// ============================================
// CÓDIGOS DE ERROR
// ============================================

const ERROR_CODES = {
  // Configuración
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_MISSING: 'CONFIG_MISSING',

  // Certificado
  CERT_NOT_FOUND: 'CERT_NOT_FOUND',
  CERT_INVALID: 'CERT_INVALID',
  CERT_EXPIRED: 'CERT_EXPIRED',
  CERT_PASSWORD_WRONG: 'CERT_PASSWORD_WRONG',

  // CAF / Folios
  CAF_NOT_FOUND: 'CAF_NOT_FOUND',
  CAF_INVALID: 'CAF_INVALID',
  CAF_EXPIRED: 'CAF_EXPIRED',
  CAF_NO_FOLIOS: 'CAF_NO_FOLIOS',
  FOLIO_OUT_OF_RANGE: 'FOLIO_OUT_OF_RANGE',

  // DTE
  DTE_INVALID: 'DTE_INVALID',
  DTE_MISSING_FIELDS: 'DTE_MISSING_FIELDS',
  DTE_VALIDATION_FAILED: 'DTE_VALIDATION_FAILED',

  // Firma
  SIGN_FAILED: 'SIGN_FAILED',
  SIGN_VERIFY_FAILED: 'SIGN_VERIFY_FAILED',

  // SII
  SII_CONNECTION_FAILED: 'SII_CONNECTION_FAILED',
  SII_AUTH_FAILED: 'SII_AUTH_FAILED',
  SII_REJECTED: 'SII_REJECTED',
  SII_TIMEOUT: 'SII_TIMEOUT',
  SII_INVALID_RESPONSE: 'SII_INVALID_RESPONSE',

  // XML
  XML_PARSE_FAILED: 'XML_PARSE_FAILED',
  XML_BUILD_FAILED: 'XML_BUILD_FAILED',

  // General
  UNKNOWN: 'UNKNOWN',
};

// ============================================
// CLASE DteSiiError
// ============================================

/**
 * Error personalizado del paquete
 */
class DteSiiError extends Error {
  /**
   * @param {string} message - Mensaje de error
   * @param {string} [code] - Código de error (de ERROR_CODES)
   * @param {Object} [details] - Detalles adicionales
   */
  constructor(message, code = ERROR_CODES.UNKNOWN, details = {}) {
    super(message);
    this.name = 'DteSiiError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Mantener stack trace correcto
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DteSiiError);
    }
  }

  /**
   * Convierte el error a objeto plano (para logging/serialización)
   * @returns {Object}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  /**
   * Representación string del error
   * @returns {string}
   */
  toString() {
    return `[${this.code}] ${this.message}`;
  }

  /**
   * Verifica si es un error de SII
   * @returns {boolean}
   */
  isSiiError() {
    return this.code.startsWith('SII_');
  }

  /**
   * Verifica si es un error recuperable (se puede reintentar)
   * @returns {boolean}
   */
  isRetryable() {
    return [
      ERROR_CODES.SII_CONNECTION_FAILED,
      ERROR_CODES.SII_TIMEOUT,
    ].includes(this.code);
  }
}

// ============================================
// FUNCIONES HELPER
// ============================================

/**
 * Crea error de configuración
 * 
 * @param {string} message - Mensaje de error
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function configError(message, details = {}) {
  return new DteSiiError(message, ERROR_CODES.CONFIG_INVALID, details);
}

/**
 * Crea error de certificado
 * 
 * @param {string} message - Mensaje de error
 * @param {string} [code] - Código específico de certificado
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function certError(message, code = ERROR_CODES.CERT_INVALID, details = {}) {
  return new DteSiiError(message, code, details);
}

/**
 * Crea error de CAF/folios
 * 
 * @param {string} message - Mensaje de error
 * @param {string} [code] - Código específico de CAF
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function cafError(message, code = ERROR_CODES.CAF_INVALID, details = {}) {
  return new DteSiiError(message, code, details);
}

/**
 * Crea error de DTE
 * 
 * @param {string} message - Mensaje de error
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function dteError(message, details = {}) {
  return new DteSiiError(message, ERROR_CODES.DTE_INVALID, details);
}

/**
 * Crea error de SII
 * 
 * @param {string} message - Mensaje de error
 * @param {string} [code] - Código específico de SII
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function siiError(message, code = ERROR_CODES.SII_REJECTED, details = {}) {
  return new DteSiiError(message, code, details);
}

/**
 * Crea error de XML
 * 
 * @param {string} message - Mensaje de error
 * @param {Object} [details] - Detalles
 * @returns {DteSiiError}
 */
function xmlError(message, details = {}) {
  return new DteSiiError(message, ERROR_CODES.XML_PARSE_FAILED, details);
}

/**
 * Envuelve un error nativo en DteSiiError
 * 
 * @param {Error} error - Error original
 * @param {string} [code] - Código a asignar
 * @param {Object} [details] - Detalles adicionales
 * @returns {DteSiiError}
 */
function wrapError(error, code = ERROR_CODES.UNKNOWN, details = {}) {
  if (error instanceof DteSiiError) {
    return error;
  }

  return new DteSiiError(
    error.message || String(error),
    code,
    { ...details, originalError: error.name, stack: error.stack }
  );
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  DteSiiError,
  ERROR_CODES,

  // Helpers
  configError,
  certError,
  cafError,
  dteError,
  siiError,
  xmlError,
  wrapError,
};
