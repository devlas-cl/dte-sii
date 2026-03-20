// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Resolución SII
 * 
 * Funciones para manejo de resoluciones SII (certificación/producción)
 * 
 * @module dte-sii/utils/resolucion
 */

// ============================================
// RESOLUCIÓN SII
// ============================================

/**
 * Normaliza fecha de resolución a formato YYYY-MM-DD
 * 
 * @param {string} value - Fecha en formato DD-MM-YYYY o YYYY-MM-DD
 * @returns {string} - Fecha normalizada YYYY-MM-DD
 */
function normalizeFechaResolucion(value) {
  const raw = (value || '').trim();
  if (!raw) return raw;

  // Ya está en formato ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Formato DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    const [dd, mm, yyyy] = raw.split('-');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Formato DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [dd, mm, yyyy] = raw.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }

  return raw;
}

/**
 * Crea objeto de resolución SII
 * 
 * @param {string} fecha - Fecha de resolución (se normaliza automáticamente)
 * @param {number} [numero=0] - Número de resolución (0 para certificación)
 * @returns {{ fch_resol: string, nro_resol: number }}
 */
function createResolucion(fecha, numero = 0) {
  return {
    fch_resol: normalizeFechaResolucion(fecha),
    nro_resol: Number(numero) || 0,
  };
}

/**
 * Crear resolución para ambiente de certificación
 * La fecha debe ser la fecha de autorización en ambiente de certificación
 * 
 * @param {string} fecha - Fecha de autorización
 * @returns {{ fch_resol: string, nro_resol: number }}
 */
function createResolucionCertificacion(fecha) {
  return createResolucion(fecha, 0); // Número 0 para certificación
}

/**
 * Crear resolución para ambiente de producción
 * 
 * @param {string} fecha - Fecha de la resolución
 * @param {number} numero - Número de la resolución
 * @returns {{ fch_resol: string, nro_resol: number }}
 */
function createResolucionProduccion(fecha, numero) {
  if (!numero || numero <= 0) {
    throw new Error('Número de resolución requerido para producción');
  }
  return createResolucion(fecha, numero);
}

/**
 * Validar objeto de resolución
 * 
 * @param {Object} resolucion - Objeto de resolución
 * @param {boolean} [requireNumero=false] - Si se requiere número > 0
 * @returns {{ valid: boolean, error?: string }}
 */
function validarResolucion(resolucion, requireNumero = false) {
  if (!resolucion) {
    return { valid: false, error: 'Resolución no proporcionada' };
  }

  if (!resolucion.fch_resol) {
    return { valid: false, error: 'Fecha de resolución requerida' };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolucion.fch_resol)) {
    return { valid: false, error: 'Formato de fecha inválido (debe ser YYYY-MM-DD)' };
  }

  if (requireNumero && (!resolucion.nro_resol || resolucion.nro_resol <= 0)) {
    return { valid: false, error: 'Número de resolución requerido para producción' };
  }

  return { valid: true };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  normalizeFechaResolucion,
  createResolucion,
  createResolucionCertificacion,
  createResolucionProduccion,
  validarResolucion,
};
