// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Referencia
 * 
 * Funciones para construir referencias en DTEs (SET de pruebas, documentos, anulaciones)
 * 
 * @module dte-sii/utils/referencia
 */

// ============================================
// REFERENCIAS PARA CERTIFICACIÓN
// ============================================

/**
 * Construye referencia al SET de pruebas del SII
 * Requerida en todos los DTEs de certificación
 * 
 * @param {string} casoId - ID del caso (ej: "4668070-1")
 * @param {string} fecha - Fecha de emisión YYYY-MM-DD
 * @param {number} [nroLinRef=1] - Número de línea de referencia
 * @returns {Object} Objeto de referencia formateado
 */
function buildSetReferencia(casoId, fecha, nroLinRef = 1) {
  return {
    NroLinRef: nroLinRef,
    TpoDocRef: 'SET',
    FolioRef: 1,
    FchRef: fecha,
    RazonRef: `CASO ${casoId}`,
  };
}

// ============================================
// REFERENCIAS A DOCUMENTOS
// ============================================

/**
 * Construye referencia a documento previo (para NC/ND)
 * 
 * @param {Object} params - Parámetros de la referencia
 * @param {number} params.tipoDte - Tipo de documento referenciado
 * @param {number} params.folio - Folio del documento referenciado
 * @param {string} params.fecha - Fecha del documento YYYY-MM-DD
 * @param {number} params.codRef - Código de referencia (1=Anula, 2=Corrige texto, 3=Corrige montos)
 * @param {string} params.razonRef - Razón de la referencia
 * @param {number} [params.nroLinRef=1] - Número de línea
 * @returns {Object} Objeto de referencia
 */
function buildDocReferencia({ tipoDte, folio, fecha, codRef, razonRef, nroLinRef = 1 }) {
  return {
    NroLinRef: nroLinRef,
    TpoDocRef: tipoDte,
    FolioRef: folio,
    FchRef: fecha,
    CodRef: codRef,
    RazonRef: razonRef,
  };
}

/**
 * Construye referencia para anulación de documento
 * 
 * @param {Object} params - Parámetros
 * @param {number} params.tipoDte - Tipo de documento a anular
 * @param {number} params.folio - Folio del documento a anular
 * @param {string} params.fecha - Fecha del documento
 * @param {number} [params.nroLinRef=1] - Número de línea
 * @returns {Object} Referencia de anulación
 */
function buildAnulacionReferencia({ tipoDte, folio, fecha, nroLinRef = 1 }) {
  return buildDocReferencia({
    tipoDte,
    folio,
    fecha,
    codRef: 1, // 1 = Anula documento de referencia
    razonRef: 'ANULA DOCUMENTO',
    nroLinRef,
  });
}

/**
 * Construye referencia para corrección de texto
 * 
 * @param {Object} params - Parámetros
 * @param {number} params.tipoDte - Tipo de documento a corregir
 * @param {number} params.folio - Folio del documento
 * @param {string} params.fecha - Fecha del documento
 * @param {string} params.razonRef - Descripción de la corrección
 * @param {number} [params.nroLinRef=1] - Número de línea
 * @returns {Object} Referencia de corrección
 */
function buildCorreccionTextoReferencia({ tipoDte, folio, fecha, razonRef, nroLinRef = 1 }) {
  return buildDocReferencia({
    tipoDte,
    folio,
    fecha,
    codRef: 2, // 2 = Corrige texto del documento de referencia
    razonRef,
    nroLinRef,
  });
}

/**
 * Construye referencia para corrección de montos
 * 
 * @param {Object} params - Parámetros
 * @param {number} params.tipoDte - Tipo de documento a corregir
 * @param {number} params.folio - Folio del documento
 * @param {string} params.fecha - Fecha del documento
 * @param {string} params.razonRef - Descripción de la corrección
 * @param {number} [params.nroLinRef=1] - Número de línea
 * @returns {Object} Referencia de corrección de montos
 */
function buildCorreccionMontosReferencia({ tipoDte, folio, fecha, razonRef, nroLinRef = 1 }) {
  return buildDocReferencia({
    tipoDte,
    folio,
    fecha,
    codRef: 3, // 3 = Corrige montos
    razonRef,
    nroLinRef,
  });
}

// ============================================
// UTILIDADES
// ============================================

/**
 * Combina referencia SET con referencia a documento
 * Para NC/ND en certificación que necesitan ambas
 * 
 * @param {string} casoId - ID del caso de prueba
 * @param {string} fechaEmision - Fecha de emisión del nuevo documento
 * @param {Object} docRef - Referencia al documento (sin NroLinRef)
 * @returns {Array} Array con ambas referencias ordenadas
 */
function buildReferenciasNcNd(casoId, fechaEmision, docRef) {
  const setRef = buildSetReferencia(casoId, fechaEmision, 1);
  const documentoRef = { ...docRef, NroLinRef: 2 };
  return [setRef, documentoRef];
}

/**
 * Códigos de referencia SII
 */
const CODIGOS_REFERENCIA = {
  ANULA: 1,
  CORRIGE_TEXTO: 2,
  CORRIGE_MONTOS: 3,
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Referencias
  buildSetReferencia,
  buildDocReferencia,
  buildAnulacionReferencia,
  buildCorreccionTextoReferencia,
  buildCorreccionMontosReferencia,
  buildReferenciasNcNd,

  // Constantes
  CODIGOS_REFERENCIA,
};
