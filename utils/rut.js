// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de RUT
 * 
 * Funciones para manipulación y validación de RUT chileno
 * 
 * @module dte-sii/utils/rut
 */

// ============================================
// FORMATEO
// ============================================

/**
 * Formatear RUT chileno (quitar puntos, mayúsculas)
 * 
 * @param {string} rut - RUT a formatear (ej: "12.345.678-K")
 * @returns {string} - RUT formateado (ej: "12345678-K")
 */
function formatRut(rut) {
  if (!rut) return '';
  return rut.replace(/\./g, '').toUpperCase();
}

/**
 * Limpiar RUT (solo números y K)
 * 
 * @param {string} rut - RUT con cualquier formato
 * @returns {string} - RUT limpio (ej: "12345678K")
 */
function cleanRut(rut) {
  if (!rut) return '';
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
}

/**
 * Separar RUT en número y dígito verificador
 * 
 * @param {string} rut - RUT en cualquier formato
 * @returns {{ numero: string, dv: string }}
 */
function splitRut(rut) {
  const cleaned = cleanRut(rut);
  if (cleaned.length < 2) {
    return { numero: cleaned, dv: '' };
  }
  return {
    numero: cleaned.slice(0, -1),
    dv: cleaned.slice(-1),
  };
}

/**
 * Formatear RUT con puntos y guión
 * 
 * @param {string} rut - RUT sin formato
 * @returns {string} - RUT formateado (ej: "12.345.678-K")
 */
function formatRutWithDots(rut) {
  const { numero, dv } = splitRut(rut);
  if (!numero) return '';

  // Agregar puntos cada 3 dígitos desde la derecha
  const formatted = numero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formatted}-${dv}`;
}

/**
 * Formatear RUT para uso en SII (solo con guión)
 * 
 * @param {string} rut - RUT en cualquier formato
 * @returns {string} - RUT formateado (ej: "12345678-K")
 */
function formatRutSii(rut) {
  const { numero, dv } = splitRut(rut);
  if (!numero) return '';
  return `${numero}-${dv}`;
}

// ============================================
// VALIDACIÓN
// ============================================

/**
 * Calcular dígito verificador de RUT
 * 
 * @param {string|number} rutSinDV - RUT sin dígito verificador
 * @returns {string} - Dígito verificador (0-9 o K)
 */
function calcularDV(rutSinDV) {
  const rut = parseInt(String(rutSinDV).replace(/\D/g, ''), 10);
  if (isNaN(rut) || rut <= 0) return '';

  let suma = 0;
  let multiplicador = 2;
  const rutStr = rut.toString();

  for (let i = rutStr.length - 1; i >= 0; i--) {
    suma += parseInt(rutStr[i]) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }

  const resto = suma % 11;
  const dv = 11 - resto;

  if (dv === 11) return '0';
  if (dv === 10) return 'K';
  return dv.toString();
}

/**
 * Validar RUT chileno
 * 
 * @param {string} rut - RUT a validar
 * @returns {boolean} - true si el RUT es válido
 */
function validarRut(rut) {
  const { numero, dv } = splitRut(rut);
  if (!numero || numero.length < 7 || numero.length > 8) return false;
  if (!dv) return false;

  const dvCalculado = calcularDV(numero);
  return dvCalculado === dv.toUpperCase();
}

/**
 * Validar RUT y retornar formateado si es válido
 * 
 * @param {string} rut - RUT a validar
 * @returns {{ valid: boolean, rut: string|null, error?: string }}
 */
function validateAndFormatRut(rut) {
  if (!rut || typeof rut !== 'string') {
    return { valid: false, rut: null, error: 'RUT no proporcionado' };
  }

  const { numero, dv } = splitRut(rut);

  if (!numero || numero.length < 7) {
    return { valid: false, rut: null, error: 'RUT muy corto' };
  }

  if (numero.length > 8) {
    return { valid: false, rut: null, error: 'RUT muy largo' };
  }

  const dvCalculado = calcularDV(numero);
  if (dvCalculado !== dv.toUpperCase()) {
    return { valid: false, rut: null, error: 'Dígito verificador inválido' };
  }

  return { valid: true, rut: formatRutSii(rut) };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  formatRut,
  cleanRut,
  splitRut,
  formatRutWithDots,
  formatRutSii,
  calcularDV,
  validarRut,
  validateAndFormatRut,
};
