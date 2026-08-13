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
 * El envío al SII codifica el XML como ISO-8859-1 vía `Buffer.from(xml, 'latin1')`
 * (EnviadorSII.js), que trunca cada code point a su byte bajo (code & 0xFF) en vez de
 * transliterar. Cualquier caracter fuera del rango Latin-1 (ej. em dash — = U+2014)
 * se corrompe en un byte de control arbitrario (0x2014 & 0xFF = 0x14), lo que el SII
 * rechaza como "invalid character" a nivel de schema — un error genérico que no apunta
 * a la causa real. Por eso se reemplazan primero los casos comunes (guiones/puntos
 * suspensivos tipográficos) por su equivalente ASCII, y como red de seguridad se
 * elimina cualquier otro caracter fuera de Latin-1 antes de que llegue a esa conversión.
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
    .replace(/[—–]/g, '-')      // Guion largo/corto tipográfico -> guion ASCII
    .replace(/…/g, '...')       // Puntos suspensivos tipográficos -> ASCII
    .replace(/[^\x00-\xFF]/g, '') // Cualquier otro caracter fuera de Latin-1 (emojis, etc.)
    .trim();
}

/**
 * Sanitizar texto que va DENTRO del TED (timbre electrónico).
 *
 * Además de lo que hace `sanitizeSiiText`, pliega los acentuados de Latin-1 a ASCII
 * (á→a, ñ→n, Ü→U…).
 *
 * ⚠️ Esto NO es cosmético y no se puede omitir: **el lector de PDF417 del SII no
 * devuelve los bytes ≥ 128 tal como se codificaron**. Medido contra el portal de
 * Muestras Impresas el 11/08/2026 — el SII leyó del código de barras:
 *
 *     "Cajón AFECTO"    ->  "Cajnn AFECTO"
 *     "Pañuelo AFECTO"  ->  "Pauuelo AFECTO"
 *     "CIGUEÑALES"      ->  "CIGUEAALES"
 *
 * (el carácter acentuado se pierde y el siguiente se duplica). Como el TED viaja
 * firmado, el SII verifica la firma sobre lo que ÉL leyó, no sobre lo que se codificó:
 * cualquier documento con tilde o ñ en RSR o IT1 termina rechazado con
 * "Error Tecnico: TED - Firma invalida", y basta uno para tumbar la revisión completa.
 *
 * Se descartó que fuera un problema nuestro de codificación: se verificó que la firma
 * es válida sobre los bytes latin1, que el TED del envío y el del DTE son idénticos, y
 * que bwip-js codifica el byte correctamente — el barcode generado con `binarytext`
 * resultó idéntico al generado escapando el byte a mano (`^243` con `parse`).
 *
 * Solo aplica al TED. El DTE conserva el texto real con sus acentos: acá se pliega
 * únicamente lo que va al código de barras, y se hace ANTES de firmar para que la
 * firma cubra exactamente los bytes que el SII va a leer.
 *
 * @param {string} text - Texto a sanitizar (RSR o IT1 del TED)
 * @returns {string} - Texto sin caracteres fuera de ASCII
 */
function sanitizeTedText(text) {
  // ⚠️ El plegado va ANTES de `sanitizeSiiText`, no después.
  //
  // `sanitizeSiiText` descarta lo que no reconoce, así que si corre primero se lleva las
  // ligaduras (ﬁ, ﬀ, Œ…) y el mapeo de más abajo nunca llega a verlas: quedaba como código
  // muerto y esos caracteres desaparecían del timbre en vez de expandirse.
  return String(text ?? '')
    // Descompone en letra base + diacrítico y descarta el diacrítico.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Lo que NFD no separa (ligaduras y símbolos con forma propia).
    .replace(/[ﬀﬁﬂﬃﬄŒœ]/g, m => ({
      'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'Œ': 'OE', 'œ': 'oe',
    })[m])
    .replace(/Æ/g, 'AE').replace(/æ/g, 'ae')
    .replace(/Ø/g, 'O').replace(/ø/g, 'o')
    .replace(/Ð/g, 'D').replace(/ð/g, 'd')
    .replace(/Þ/g, 'TH').replace(/þ/g, 'th')
    .replace(/ß/g, 'ss')
    // Recién ahora las reglas del SII, sobre texto ya plegado a ASCII.
    .replace(/[^\x20-\x7E]/g, '')
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
  sanitizeTedText,
  truncateText,
  sanitizeGiroRecep,
  sanitizeRazonSocial,
  sanitizeNombreItem,
  sanitizeDescripcionItem,
  safeSegment,
};
