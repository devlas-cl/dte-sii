// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * @devlas/dte-sii
 *
 * Facturación y boletas electrónicas para el SII de Chile.
 *
 * @version 2.5.2
 * @author Devlas SpA <hola@devlas.cl>
 * @license MIT
 */

// Módulos core
const Certificado = require('./Certificado');
const CAF = require('./CAF');
const DTE = require('./DTE');
const Signer = require('./Signer');
const { EnvioBOLETA, EnvioDTE } = require('./Envio');

// Servicios
const BoletaService = require('./BoletaService');
const EnviadorSII = require('./EnviadorSII');

// Gestión de Folios
const FolioService = require('./FolioService');
const FolioRegistry = require('./FolioRegistry');
const SiiSession = require('./SiiSession');
const CafSolicitor = require('./CafSolicitor');

// Libros y reportes
const ConsumoFolio = require('./ConsumoFolio');
const LibroCompraVenta = require('./LibroCompraVenta');
const LibroGuia = require('./LibroGuia');

// Helpers para certificación
const CertFolioHelper = require('./cert/CertFolioHelper');

const utils = require('./utils');

// Re-exports de utilidades para compatibilidad
const {
  // Sanitización
  sanitizeSiiText,
  truncateText,
  sanitizeGiroRecep,
  sanitizeRazonSocial,
  sanitizeNombreItem,
  sanitizeDescripcionItem,
  safeSegment,

  // RUT
  formatRut,
  cleanRut,
  splitRut,
  formatRutWithDots,
  formatRutSii,
  calcularDV,
  validarRut,
  validateAndFormatRut,

  // XML
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

  // Resolución SII
  normalizeFechaResolucion,
  createResolucion,
  createResolucionCertificacion,
  createResolucionProduccion,
  validarResolucion,

  // Cálculo
  TASA_IVA_DEFAULT,
  formatDecimal,
  calcularMontoItem,
  calcularTotalesDesdeItems,
  calcularTotalesDesdeDetalle,
  buildDetalle,
  buildDetalleGuia,
  buildDetalleCompra,
  buildDescuentoGlobal,

  // Referencia
  buildSetReferencia,
  buildDocReferencia,
  buildAnulacionReferencia,
  buildCorreccionTextoReferencia,
  buildCorreccionMontosReferencia,
  buildReferenciasNcNd,
  CODIGOS_REFERENCIA,

  // Emisor
  buildEmisor,
  buildEmisorBoleta,
  normalizeEmisor,
  validarEmisor,

  // Receptor
  RUT_CONSUMIDOR_FINAL,
  RECEPTOR_CONSUMIDOR_FINAL,
  buildReceptor,
  buildReceptorBoleta,
  buildReceptorConsumidorFinal,
  normalizeReceptor,
  validarReceptor,
  esConsumidorFinal,

  // Errores
  DteSiiError,
  ERROR_CODES,
  configError,
  certError,
  cafError,
  dteError,
  siiError,
  xmlError,
  wrapError,

  // Logger
  logger,
  LOG_LEVELS,
  configureLogger,
  silenceLogger,
  enableLogger,
  getLoggerConfig,
  createScopedLogger,

  // Configuración Global
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

  // Token Cache
  getCachedToken,
  setCachedToken,
  invalidateToken,
  invalidateAmbiente,
  invalidateEmisor,
  clearTokenCache,
  getTokenCacheStats,
  pruneExpiredTokens,

  // Endpoints SII (v2.5.0)
  HOSTS,
  SOAP_ENDPOINTS,
  REST_ENDPOINTS,
  CERT_ENDPOINTS,
  getHost,
  getSoapUrl,
  getRestUrl,
  getCertUrl,
  validateAmbiente,

  // Constantes DTE (v2.5.0)
  TIPOS_DTE,
  TIPOS_BOLETA,
  TIPOS_EXENTOS,
  NOMBRES_DTE,
  TASA_IVA,
  IDK_CERTIFICACION,
  esBoleta,
  esExento,
  esNota,
  getNombreDte,
  esTipoValido,

  // PFX Utils (v2.5.0)
  loadPfxFromBuffer,
  loadPfxFromFile,
  extractSubjectFields,
  extractRutFromCertificate,
  isCertificateExpired,
  getDaysUntilExpiry,
  createTlsOptions,
} = utils;

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // ─────────────────────────────────────────
  // Clases principales
  // ─────────────────────────────────────────
  Certificado,
  CAF,
  DTE,
  Signer,
  EnvioBOLETA,
  EnvioDTE,
  
  // ─────────────────────────────────────────
  // Servicios
  // ─────────────────────────────────────────
  BoletaService,
  EnviadorSII,
  
  // ─────────────────────────────────────────
  // Gestión de Folios
  // ─────────────────────────────────────────
  FolioService,
  FolioRegistry,
  SiiSession,
  CafSolicitor,
  
  // Funciones helper de folios (acceso directo)
  createCafFingerprint: FolioRegistry.createCafFingerprint,
  findLatestCaf: FolioRegistry.findLatestCaf,
  resolveCafPath: FolioRegistry.resolveCafPath,
  
  // ─────────────────────────────────────────
  // Libros y reportes
  // ─────────────────────────────────────────
  ConsumoFolio,
  LibroCompraVenta,
  LibroGuia,
  
  // ─────────────────────────────────────────
  // Helpers para certificación
  // ─────────────────────────────────────────
  CertFolioHelper,

  // ─────────────────────────────────────────
  // UTILIDADES (todo el namespace)
  // ─────────────────────────────────────────
  utils,

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
  // Endpoints SII (v2.5.0)
  // ─────────────────────────────────────────
  HOSTS,
  SOAP_ENDPOINTS,
  REST_ENDPOINTS,
  CERT_ENDPOINTS,
  getHost,
  getSoapUrl,
  getRestUrl,
  getCertUrl,
  validateAmbiente,

  // ─────────────────────────────────────────
  // Constantes DTE (v2.5.0)
  // ─────────────────────────────────────────
  TIPOS_DTE,
  TIPOS_BOLETA,
  TIPOS_EXENTOS,
  NOMBRES_DTE,
  TASA_IVA,
  IDK_CERTIFICACION,
  esBoleta,
  esExento,
  esNota,
  getNombreDte,
  esTipoValido,

  // ─────────────────────────────────────────
  // PFX Utils (v2.5.0)
  // ─────────────────────────────────────────
  loadPfxFromBuffer,
  loadPfxFromFile,
  extractSubjectFields,
  extractRutFromCertificate,
  isCertificateExpired,
  getDaysUntilExpiry,
  createTlsOptions,
};
