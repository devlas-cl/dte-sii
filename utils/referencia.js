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
function buildSetReferencia(casoId, fecha, { folio, nroLinRef = 1 } = {}) {
  // FolioRef debe ser el folio del DTE que lleva la referencia, no una constante.
  // Se recibe en un objeto y no como tercer posicional a propósito: la firma
  // anterior era (casoId, fecha, nroLinRef), así que cualquier llamada antigua
  // llega acá con folio === undefined y falla ruidosamente en vez de emitir un
  // FolioRef equivocado pero plausible.
  if (!Number.isInteger(folio) || folio <= 0) {
    throw new Error('buildSetReferencia: se requiere { folio } con el folio propio del DTE que lleva la referencia');
  }
  return {
    NroLinRef: nroLinRef,
    TpoDocRef: 'SET',
    FolioRef: folio,
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
function buildReferenciasNcNd(casoId, fechaEmision, docRef, { folio } = {}) {
  const setRef = buildSetReferencia(casoId, fechaEmision, { folio, nroLinRef: 1 });
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

/**
 * Compone la razón que se envía en una referencia de corrección.
 *
 * El SII exige que una corrección de texto (CodRef=2) lleve los literales
 * "Dice:" y "debe decir:" en la RazonRef; su ausencia es causa de rechazo. La
 * razón del set asignado describe el caso ("CORRIGE GIRO DEL RECEPTOR") y no
 * tiene esa forma, así que la razón cruda se conserva como evidencia del caso
 * y la que se envía se compone acá desde el receptor del documento.
 *
 * Las anulaciones (CodRef=1) y las correcciones de monto (CodRef=3) no llevan
 * esos literales: se devuelven tal cual.
 *
 * @param {Object} params
 * @param {number} params.codRef - Código de referencia del SII
 * @param {string} params.razonRef - Razón cruda del set asignado
 * @param {Object} [params.receptor] - Receptor del documento
 * @returns {string} Razón a enviar
 */
function buildRazonCorreccion({ codRef, razonRef, receptor }) {
  if (Number(codRef) !== CODIGOS_REFERENCIA.CORRIGE_TEXTO) return razonRef;
  const razon = String(razonRef || '');
  if (/dice:/i.test(razon) && /debe decir:/i.test(razon)) return razonRef;
  const giro = String(receptor?.giro || '').trim();
  if (!giro) {
    throw new Error('buildRazonCorreccion: una corrección de texto (CodRef=2) requiere el giro del receptor para componer "Dice: … y debe decir: …"');
  }
  return `Dice: ${giro} y debe decir: ${giro} CORREGIDO`;
}

module.exports = {
  // Referencias
  buildSetReferencia,
  buildDocReferencia,
  buildAnulacionReferencia,
  buildCorreccionTextoReferencia,
  buildCorreccionMontosReferencia,
  buildReferenciasNcNd,
  buildRazonCorreccion,

  // Constantes
  CODIGOS_REFERENCIA,
};
