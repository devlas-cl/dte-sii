// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Emisor
 * 
 * Funciones para construir y validar datos de emisor en DTEs
 * 
 * @module dte-sii/utils/emisor
 */

const { sanitizeSiiText } = require('./sanitize');
const { formatRutSii, validarRut } = require('./rut');

// ============================================
// CONSTRUCCIÓN DE EMISOR
// ============================================

/**
 * Construye objeto de Emisor para DTE (no boleta)
 * 
 * @param {Object} config - Configuración del emisor
 * @param {string} config.rut - RUT del emisor
 * @param {string} config.razonSocial - Razón social
 * @param {string} config.giro - Giro comercial
 * @param {string} config.direccion - Dirección
 * @param {string} config.comuna - Comuna
 * @param {string} [config.ciudad] - Ciudad (default: comuna)
 * @param {string} [config.telefono] - Teléfono
 * @param {string} [config.correo] - Correo electrónico
 * @param {number|string} [config.acteco] - Código de actividad económica
 * @returns {Object} Emisor formateado para DTE
 */
function buildEmisor(config) {
  const {
    rut,
    razonSocial,
    giro,
    direccion,
    comuna,
    ciudad,
    telefono,
    correo,
    acteco,
  } = config;

  const emisor = {
    RUTEmisor: formatRutSii(rut),
    RznSoc: sanitizeSiiText(razonSocial),
    GiroEmis: sanitizeSiiText(giro),
  };

  if (acteco) emisor.Acteco = acteco;
  if (telefono) emisor.Telefono = telefono;
  if (correo) emisor.CorreoEmisor = correo;

  emisor.DirOrigen = sanitizeSiiText(direccion);
  emisor.CmnaOrigen = comuna;
  emisor.CiudadOrigen = ciudad || comuna || '';

  return emisor;
}

/**
 * Construye objeto de Emisor para Boleta
 * 
 * @param {Object} config - Configuración del emisor
 * @param {string} config.rut - RUT del emisor
 * @param {string} config.razonSocial - Razón social
 * @param {string} config.giro - Giro comercial
 * @param {string} config.direccion - Dirección
 * @param {string} config.comuna - Comuna
 * @param {string} [config.ciudad] - Ciudad
 * @returns {Object} Emisor formateado para Boleta
 */
function buildEmisorBoleta(config) {
  const { rut, razonSocial, giro, direccion, comuna, ciudad } = config;

  return {
    RUTEmisor: formatRutSii(rut),
    RznSocEmisor: sanitizeSiiText(razonSocial),
    GiroEmisor: sanitizeSiiText(giro),
    DirOrigen: sanitizeSiiText(direccion),
    CmnaOrigen: comuna,
    CiudadOrigen: ciudad || comuna || '',
  };
}

/**
 * Normaliza emisor desde diferentes formatos de entrada
 * Detecta si viene en formato boleta o DTE y normaliza
 * 
 * @param {Object} emisor - Emisor en cualquier formato
 * @param {boolean} [esBoleta=false] - Si es formato boleta
 * @returns {Object} Emisor normalizado
 */
function normalizeEmisor(emisor, esBoleta = false) {
  if (esBoleta) {
    return {
      RUTEmisor: emisor.RUTEmisor,
      RznSocEmisor: sanitizeSiiText(emisor.RznSocEmisor || emisor.RznSoc),
      GiroEmisor: sanitizeSiiText(emisor.GiroEmisor || emisor.GiroEmis),
      DirOrigen: sanitizeSiiText(emisor.DirOrigen),
      CmnaOrigen: emisor.CmnaOrigen,
      CiudadOrigen: emisor.CiudadOrigen || emisor.CmnaOrigen || '',
    };
  }

  const result = {
    RUTEmisor: emisor.RUTEmisor,
    RznSoc: sanitizeSiiText(emisor.RznSoc || emisor.RznSocEmisor),
    GiroEmis: sanitizeSiiText(emisor.GiroEmis || emisor.GiroEmisor),
  };

  if (emisor.Acteco) result.Acteco = emisor.Acteco;
  if (emisor.Telefono) result.Telefono = emisor.Telefono;
  if (emisor.CorreoEmisor) result.CorreoEmisor = emisor.CorreoEmisor;

  result.DirOrigen = sanitizeSiiText(emisor.DirOrigen);
  result.CmnaOrigen = emisor.CmnaOrigen;
  result.CiudadOrigen = emisor.CiudadOrigen || emisor.CmnaOrigen || '';

  return result;
}

/**
 * Valida datos de emisor
 * 
 * @param {Object} emisor - Datos del emisor
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validarEmisor(emisor) {
  const errors = [];

  if (!emisor) {
    return { valid: false, errors: ['Emisor no proporcionado'] };
  }

  if (!emisor.RUTEmisor) {
    errors.push('RUT de emisor requerido');
  } else if (!validarRut(emisor.RUTEmisor)) {
    errors.push('RUT de emisor inválido');
  }

  const razonSocial = emisor.RznSoc || emisor.RznSocEmisor;
  if (!razonSocial) {
    errors.push('Razón social requerida');
  }

  const giro = emisor.GiroEmis || emisor.GiroEmisor;
  if (!giro) {
    errors.push('Giro requerido');
  }

  if (!emisor.DirOrigen) {
    errors.push('Dirección de origen requerida');
  }

  if (!emisor.CmnaOrigen) {
    errors.push('Comuna de origen requerida');
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  buildEmisor,
  buildEmisorBoleta,
  normalizeEmisor,
  validarEmisor,
};
