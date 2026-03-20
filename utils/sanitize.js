// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Sanitización
 * 
 * Funciones para sanitizar y formatear texto para DTEs del SII
 * 
 * @module dte-sii/utils/sanitize
 */

// ============================================
// SANITIZACIÓN DE TEXTO
// ============================================

/**
 * Sanitizar texto para DTE SII
 * Elimina caracteres que causan problemas de firma XML
 * 
 * @param {string} text - Texto a sanitizar
 * @returns {string} - Texto sanitizado
 */
function sanitizeSiiText(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/[''´`]/g, '')     // Eliminar apóstrofes
    .replace(/[""]/g, '')       // Eliminar comillas tipográficas
    .replace(/"/g, '')          // Eliminar comillas dobles ASCII
    .trim();
}

/**
 * Truncar texto a longitud máxima (preservando palabras completas si es posible)
 * 
 * @param {string} text - Texto a truncar
 * @param {number} maxLen - Longitud máxima
 * @param {boolean} [preserveWords=false] - Si preservar palabras completas
 * @returns {string}
 */
function truncateText(text, maxLen, preserveWords = false) {
  const sanitized = sanitizeSiiText(text);
  if (sanitized.length <= maxLen) return sanitized;

  if (preserveWords) {
    const truncated = sanitized.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.7) {
      return truncated.substring(0, lastSpace).trim();
    }
  }

  return sanitized.substring(0, maxLen);
}

/**
 * Sanitizar giro para receptor (máximo 40 caracteres)
 * 
 * @param {string} giro - Giro del receptor
 * @returns {string}
 */
function sanitizeGiroRecep(giro) {
  return truncateText(giro, 40);
}

/**
 * Sanitizar razón social (máximo 100 caracteres)
 * 
 * @param {string} razonSocial - Razón social
 * @returns {string}
 */
function sanitizeRazonSocial(razonSocial) {
  return truncateText(razonSocial, 100);
}

/**
 * Sanitizar nombre de ítem (máximo 80 caracteres)
 * 
 * @param {string} nombre - Nombre del ítem
 * @returns {string}
 */
function sanitizeNombreItem(nombre) {
  return truncateText(nombre, 80);
}

/**
 * Sanitizar descripción de ítem (máximo 1000 caracteres)
 * 
 * @param {string} descripcion - Descripción del ítem
 * @returns {string}
 */
function sanitizeDescripcionItem(descripcion) {
  return truncateText(descripcion, 1000);
}

/**
 * Crear segmento seguro para nombres de archivo/directorio
 * 
 * @param {*} value - Valor a convertir
 * @param {string} [fallback='sin-valor'] - Valor por defecto
 * @returns {string}
 */
function safeSegment(value, fallback = 'sin-valor') {
  const raw = value === undefined || value === null ? '' : String(value);
  const cleaned = raw
    .replace(/\./g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  sanitizeSiiText,
  truncateText,
  sanitizeGiroRecep,
  sanitizeRazonSocial,
  sanitizeNombreItem,
  sanitizeDescripcionItem,
  safeSegment,
};
