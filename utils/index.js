// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades Index
 * 
 * Re-exporta todas las utilidades desde un punto central
 * 
 * @module dte-sii/utils
 */

// Logger
const {
  logger,
  LOG_LEVELS,
  configureLogger,
  silenceLogger,
  enableLogger,
  getLoggerConfig,
  createScopedLogger,
} = require('./logger');

// Configuración global
const {
  getConfig,
  getConfigSection,
  configure,
  configureRetry,
  configureTokenCache,
  configureTimeout,
  resetConfig,
  configureForProduction,
  configureForDevelopment,
  calculateRetryDelay,
  isRetryableError,
  isRetryableStatus,
  withRetry,
  DEFAULT_CONFIG,
} = require('./config');

// Token Cache
const {
  getCachedToken,
  setCachedToken,
  invalidateToken,
  invalidateAmbiente,
  invalidateEmisor,
  clearTokenCache,
  getTokenCacheStats,
  pruneExpiredTokens,
} = require('./tokenCache');

// Sanitización
const {
  sanitizeSiiText,
  truncateText,
  sanitizeGiroRecep,
  sanitizeRazonSocial,
  sanitizeNombreItem,
  sanitizeDescripcionItem,
  safeSegment,
} = require('./sanitize');

// RUT
const {
  formatRut,
  cleanRut,
  splitRut,
  formatRutWithDots,
  formatRutSii,
  calcularDV,
  validarRut,
  validateAndFormatRut,
} = require('./rut');

// XML
const {
  formatBase64InXml,
  expandSelfClosingTags,
  normalizeArray,
  extractEnvioMetadata,
  saveEnvioArtifacts,
  // Nuevas funciones centralizadas
  parseXml,
  parseXmlNoNs,
  buildXml,
  decodeXmlEntities,
  extractTagContent,
  extractAttribute,
  defaultParser,
  noNsParser,
  defaultBuilder,
  prettyBuilder,
} = require('./xml');

// Resolución SII
const {
  normalizeFechaResolucion,
  createResolucion,
  createResolucionCertificacion,
  createResolucionProduccion,
  validarResolucion,
} = require('./resolucion');

// Cálculo
const {
  TASA_IVA_DEFAULT,
  formatDecimal,
  calcularMontoItem,
  calcularTotalesDesdeItems,
  calcularTotalesDesdeDetalle,
  buildDetalle,
  buildDetalleGuia,
  buildDetalleCompra,
  buildDescuentoGlobal,
} = require('./calculo');

// Referencia
const {
  buildSetReferencia,
  buildDocReferencia,
  buildAnulacionReferencia,
  buildCorreccionTextoReferencia,
  buildCorreccionMontosReferencia,
  buildReferenciasNcNd,
  CODIGOS_REFERENCIA,
} = require('./referencia');

// Emisor
const {
  buildEmisor,
  buildEmisorBoleta,
  normalizeEmisor,
  validarEmisor,
} = require('./emisor');

// Receptor
const {
  RUT_CONSUMIDOR_FINAL,
  RECEPTOR_CONSUMIDOR_FINAL,
  buildReceptor,
  buildReceptorBoleta,
  buildReceptorConsumidorFinal,
  normalizeReceptor,
  validarReceptor,
  esConsumidorFinal,
} = require('./receptor');

// Errores
const {
  DteSiiError,
  ERROR_CODES,
  configError,
  certError,
  cafError,
  dteError,
  siiError,
  xmlError,
  wrapError,
} = require('./error');

// Endpoints centralizados
const endpoints = require('./endpoints');

// Constantes DTE
const constants = require('./constants');

// PFX Loader
const pfx = require('./pfx');

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // ─────────────────────────────────────────
  // Sanitización
  // ─────────────────────────────────────────
  sanitizeSiiText,
  truncateText,
  sanitizeGiroRecep,
  sanitizeRazonSocial,
  sanitizeNombreItem,
  sanitizeDescripcionItem,
  safeSegment,

  // ─────────────────────────────────────────
  // RUT
  // ─────────────────────────────────────────
  formatRut,
  cleanRut,
  splitRut,
  formatRutWithDots,
  formatRutSii,
  calcularDV,
  validarRut,
  validateAndFormatRut,

  // ─────────────────────────────────────────
  // XML
  // ─────────────────────────────────────────
  formatBase64InXml,
  expandSelfClosingTags,
  normalizeArray,
  extractEnvioMetadata,
  saveEnvioArtifacts,
  parseXml,
  parseXmlNoNs,
  buildXml,
  decodeXmlEntities,
  extractTagContent,
  extractAttribute,
  defaultParser,
  noNsParser,
  defaultBuilder,
  prettyBuilder,

  // ─────────────────────────────────────────
  // Resolución SII
  // ─────────────────────────────────────────
  normalizeFechaResolucion,
  createResolucion,
  createResolucionCertificacion,
  createResolucionProduccion,
  validarResolucion,

  // ─────────────────────────────────────────
  // Cálculo
  // ─────────────────────────────────────────
  TASA_IVA_DEFAULT,
  formatDecimal,
  calcularMontoItem,
  calcularTotalesDesdeItems,
  calcularTotalesDesdeDetalle,
  buildDetalle,
  buildDetalleGuia,  buildDetalleCompra,  buildDescuentoGlobal,

  // ─────────────────────────────────────────
  // Referencia
  // ─────────────────────────────────────────
  buildSetReferencia,
  buildDocReferencia,
  buildAnulacionReferencia,
  buildCorreccionTextoReferencia,
  buildCorreccionMontosReferencia,
  buildReferenciasNcNd,
  CODIGOS_REFERENCIA,

  // ─────────────────────────────────────────
  // Emisor
  // ─────────────────────────────────────────
  buildEmisor,
  buildEmisorBoleta,
  normalizeEmisor,
  validarEmisor,

  // ─────────────────────────────────────────
  // Receptor
  // ─────────────────────────────────────────
  RUT_CONSUMIDOR_FINAL,
  RECEPTOR_CONSUMIDOR_FINAL,
  buildReceptor,
  buildReceptorBoleta,
  buildReceptorConsumidorFinal,
  normalizeReceptor,
  validarReceptor,
  esConsumidorFinal,

  // ─────────────────────────────────────────
  // Errores
  // ─────────────────────────────────────────
  DteSiiError,
  ERROR_CODES,
  configError,
  certError,
  cafError,
  dteError,
  siiError,
  xmlError,
  wrapError,

  // ─────────────────────────────────────────
  // Logger
  // ─────────────────────────────────────────
  logger,
  LOG_LEVELS,
  configureLogger,
  silenceLogger,
  enableLogger,
  getLoggerConfig,
  createScopedLogger,

  // ─────────────────────────────────────────
  // Configuración Global
  // ─────────────────────────────────────────
  getConfig,
  getConfigSection,
  configure,
  configureRetry,
  configureTokenCache,
  configureTimeout,
  resetConfig,
  configureForProduction,
  configureForDevelopment,
  calculateRetryDelay,
  isRetryableError,
  isRetryableStatus,
  withRetry,
  DEFAULT_CONFIG,

  // ─────────────────────────────────────────
  // Token Cache
  // ─────────────────────────────────────────
  getCachedToken,
  setCachedToken,
  invalidateToken,
  invalidateAmbiente,
  invalidateEmisor,
  clearTokenCache,
  getTokenCacheStats,
  pruneExpiredTokens,

  // ─────────────────────────────────────────
  // Endpoints (URLs centralizadas)
  // ─────────────────────────────────────────
  endpoints,
  ...endpoints,

  // ─────────────────────────────────────────
  // Constantes DTE
  // ─────────────────────────────────────────
  constants,
  ...constants,

  // ─────────────────────────────────────────
  // PFX Loader
  // ─────────────────────────────────────────
  pfx,
  ...pfx,
};
