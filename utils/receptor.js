// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Receptor
 * 
 * Funciones para construir y validar datos de receptor en DTEs
 * 
 * @module dte-sii/utils/receptor
 */

const { sanitizeSiiText, sanitizeGiroRecep } = require('./sanitize');
const { formatRutSii, validarRut } = require('./rut');

// ============================================
// CONSTANTES
// ============================================

/** RUT para consumidor final */
const RUT_CONSUMIDOR_FINAL = '66666666-6';

/** Receptor por defecto para consumidor final */
const RECEPTOR_CONSUMIDOR_FINAL = {
  RUTRecep: RUT_CONSUMIDOR_FINAL,
  RznSocRecep: 'Consumidor Final',
  DirRecep: 'Sin Direccion',
  CmnaRecep: 'Santiago',
};

// ============================================
// CONSTRUCCIÓN DE RECEPTOR
// ============================================

/**
 * Construye objeto de Receptor para DTE
 * 
 * @param {Object} config - Configuración del receptor
 * @param {string} config.rut - RUT del receptor
 * @param {string} config.razonSocial - Razón social
 * @param {string} [config.giro] - Giro (máximo 40 caracteres)
 * @param {string} config.direccion - Dirección
 * @param {string} config.comuna - Comuna
 * @param {string} [config.ciudad] - Ciudad
 * @param {string} [config.correo] - Correo electrónico
 * @returns {Object} Receptor formateado para DTE
 */
function buildReceptor(config) {
  const {
    rut,
    razonSocial,
    giro,
    direccion,
    comuna,
    ciudad,
    correo,
  } = config;

  const receptor = {
    RUTRecep: formatRutSii(rut),
    RznSocRecep: sanitizeSiiText(razonSocial),
  };

  if (giro) {
    receptor.GiroRecep = sanitizeGiroRecep(giro);
  }

  receptor.DirRecep = sanitizeSiiText(direccion);
  receptor.CmnaRecep = comuna;

  if (ciudad) {
    receptor.CiudadRecep = ciudad;
  }

  if (correo) {
    receptor.CorreoRecep = correo;
  }

  return receptor;
}

/**
 * Construye receptor para Boleta (campos mínimos)
 * 
 * @param {Object} [config] - Configuración del receptor (opcional para boleta)
 * @returns {Object} Receptor formateado para Boleta
 */
function buildReceptorBoleta(config = {}) {
  const { rut, razonSocial, direccion, comuna } = config;

  return {
    RUTRecep: rut ? formatRutSii(rut) : '',
    RznSocRecep: sanitizeSiiText(razonSocial || ''),
    DirRecep: sanitizeSiiText(direccion || ''),
    CmnaRecep: comuna || '',
  };
}

/**
 * Crea receptor para consumidor final (RUT 66666666-6)
 * 
 * @param {Object} [overrides] - Campos a sobrescribir
 * @returns {Object} Receptor de consumidor final
 */
function buildReceptorConsumidorFinal(overrides = {}) {
  return {
    ...RECEPTOR_CONSUMIDOR_FINAL,
    ...overrides,
    RUTRecep: RUT_CONSUMIDOR_FINAL, // Siempre mantener este RUT
  };
}

/**
 * Normaliza receptor desde diferentes formatos de entrada
 * 
 * @param {Object} receptor - Receptor en cualquier formato
 * @param {boolean} [esBoleta=false] - Si es formato boleta
 * @returns {Object} Receptor normalizado
 */
function normalizeReceptor(receptor, esBoleta = false) {
  if (!receptor) {
    return esBoleta ? buildReceptorBoleta() : RECEPTOR_CONSUMIDOR_FINAL;
  }

  if (esBoleta) {
    return {
      RUTRecep: receptor.RUTRecep || '',
      RznSocRecep: sanitizeSiiText(receptor.RznSocRecep || ''),
      DirRecep: sanitizeSiiText(receptor.DirRecep || ''),
      CmnaRecep: receptor.CmnaRecep || '',
    };
  }

  const giroRecep = receptor.GiroRecep
    ? sanitizeGiroRecep(receptor.GiroRecep)
    : undefined;

  return {
    RUTRecep: receptor.RUTRecep,
    RznSocRecep: sanitizeSiiText(receptor.RznSocRecep),
    ...(giroRecep ? { GiroRecep: giroRecep } : {}),
    DirRecep: sanitizeSiiText(receptor.DirRecep),
    CmnaRecep: receptor.CmnaRecep,
    ...(receptor.CiudadRecep ? { CiudadRecep: receptor.CiudadRecep } : {}),
  };
}

/**
 * Valida datos de receptor
 * 
 * @param {Object} receptor - Datos del receptor
 * @param {Object} [options] - Opciones de validación
 * @param {boolean} [options.requireGiro=false] - Si el giro es requerido
 * @param {boolean} [options.allowConsumidorFinal=true] - Si se permite RUT 66666666-6
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validarReceptor(receptor, options = {}) {
  const { requireGiro = false, allowConsumidorFinal = true } = options;
  const errors = [];

  if (!receptor) {
    return { valid: false, errors: ['Receptor no proporcionado'] };
  }

  if (!receptor.RUTRecep) {
    errors.push('RUT de receptor requerido');
  } else if (receptor.RUTRecep !== RUT_CONSUMIDOR_FINAL && !validarRut(receptor.RUTRecep)) {
    errors.push('RUT de receptor inválido');
  } else if (receptor.RUTRecep === RUT_CONSUMIDOR_FINAL && !allowConsumidorFinal) {
    errors.push('RUT de consumidor final no permitido para este tipo de documento');
  }

  if (!receptor.RznSocRecep) {
    errors.push('Razón social de receptor requerida');
  }

  if (requireGiro && !receptor.GiroRecep) {
    errors.push('Giro de receptor requerido');
  }

  if (!receptor.DirRecep) {
    errors.push('Dirección de receptor requerida');
  }

  if (!receptor.CmnaRecep) {
    errors.push('Comuna de receptor requerida');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verifica si un receptor es consumidor final
 * 
 * @param {Object} receptor - Datos del receptor
 * @returns {boolean}
 */
function esConsumidorFinal(receptor) {
  return receptor?.RUTRecep === RUT_CONSUMIDOR_FINAL;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Constantes
  RUT_CONSUMIDOR_FINAL,
  RECEPTOR_CONSUMIDOR_FINAL,

  // Construcción
  buildReceptor,
  buildReceptorBoleta,
  buildReceptorConsumidorFinal,
  normalizeReceptor,

  // Validación
  validarReceptor,
  esConsumidorFinal,
};
