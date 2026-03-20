// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * endpoints.js - URLs centralizadas del SII
 * 
 * Centraliza todas las URLs de los servicios del SII para evitar
 * duplicación y facilitar el mantenimiento.
 * 
 * @module utils/endpoints
 */

/**
 * Hosts base por ambiente
 */
const HOSTS = {
  certificacion: 'maullin.sii.cl',
  produccion: 'palena.sii.cl',
};

/**
 * Hosts para API REST de Boletas
 */
const REST_HOSTS = {
  certificacion: {
    api: 'apicert.sii.cl',
    envio: 'pangal.sii.cl',
  },
  produccion: {
    api: 'api.sii.cl',
    envio: 'rahue.sii.cl',
  },
};

/**
 * Endpoints SOAP para DTEUpload
 */
const SOAP_ENDPOINTS = {
  certificacion: {
    seed: 'https://maullin.sii.cl/DTEWS/CrSeed.jws',
    token: 'https://maullin.sii.cl/DTEWS/GetTokenFromSeed.jws',
    upload: 'https://maullin.sii.cl/cgi_dte/UPL/DTEUpload',
    estado: 'https://maullin.sii.cl/DTEWS/QueryEstUp.jws',
    estadoDte: 'https://maullin.sii.cl/DTEWS/QueryEstDte.jws',
  },
  produccion: {
    seed: 'https://palena.sii.cl/DTEWS/CrSeed.jws',
    token: 'https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws',
    upload: 'https://palena.sii.cl/cgi_dte/UPL/DTEUpload',
    estado: 'https://palena.sii.cl/DTEWS/QueryEstUp.jws',
    estadoDte: 'https://palena.sii.cl/DTEWS/QueryEstDte.jws',
  },
};

/**
 * Endpoints REST para Boletas Electrónicas
 */
const REST_ENDPOINTS = {
  certificacion: {
    semilla: 'https://apicert.sii.cl/recursos/v1/boleta.electronica.semilla',
    token: 'https://apicert.sii.cl/recursos/v1/boleta.electronica.token',
    envio: 'https://pangal.sii.cl/recursos/v1/boleta.electronica.envio',
    estado: 'https://apicert.sii.cl/recursos/v1/boleta.electronica.envio/',
  },
  produccion: {
    semilla: 'https://api.sii.cl/recursos/v1/boleta.electronica.semilla',
    token: 'https://api.sii.cl/recursos/v1/boleta.electronica.token',
    envio: 'https://rahue.sii.cl/recursos/v1/boleta.electronica.envio',
    estado: 'https://api.sii.cl/recursos/v1/boleta.electronica.envio/',
  },
};

/**
 * Endpoints de Certificación (portal pe_*)
 */
const CERT_ENDPOINTS = {
  // Generación de sets
  generar: '/cvc_cgi/dte/pe_generar',
  generar1: '/cvc_cgi/dte/pe_generar1',
  
  // Avance de certificación
  avance1: '/cvc_cgi/dte/pe_avance1',
  avance2: '/cvc_cgi/dte/pe_avance2',
  avance5: '/cvc_cgi/dte/pe_avance5',
  avance7: '/cvc_cgi/dte/pe_avance7',
  
  // CAF
  solicitarFolios: '/cvc_cgi/dte/of_solicita_folios',
  estadoFolios: '/cgi_dte/UPL/DTEauth?2',
  anularFolios: '/cvc_cgi/dte/of_anular_caf',
  
  // Boletas Electrónicas
  validarBoletaEnvio: '/cgi_dte/UPL/DTEauth?3',
  
  // Autenticación
  ingresoRut: '/cvc_cgi/dte/pe_ingrut',
  enrolaUsuarios: '/cvc_cgi/dte/eu_enrola_usuarios',
  construccionDte: '/cvc_cgi/dte/pe_construccion_dte',
};

/**
 * Obtener host base para un ambiente
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @returns {string} Host base (ej: 'maullin.sii.cl')
 */
function getHost(ambiente) {
  const amb = String(ambiente).toLowerCase();
  if (!HOSTS[amb]) {
    throw new Error(`Ambiente inválido: ${ambiente}`);
  }
  return HOSTS[amb];
}

/**
 * Obtener URL completa para endpoint SOAP
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} endpoint - Nombre del endpoint (seed, token, upload, estado)
 * @returns {string} URL completa
 */
function getSoapUrl(ambiente, endpoint) {
  const amb = String(ambiente).toLowerCase();
  const urls = SOAP_ENDPOINTS[amb];
  if (!urls) {
    throw new Error(`Ambiente inválido: ${ambiente}`);
  }
  if (!urls[endpoint]) {
    throw new Error(`Endpoint SOAP inválido: ${endpoint}`);
  }
  return urls[endpoint];
}

/**
 * Obtener URL completa para endpoint REST (Boletas)
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} endpoint - Nombre del endpoint (semilla, token, envio, estado)
 * @returns {string} URL completa
 */
function getRestUrl(ambiente, endpoint) {
  const amb = String(ambiente).toLowerCase();
  const urls = REST_ENDPOINTS[amb];
  if (!urls) {
    throw new Error(`Ambiente inválido: ${ambiente}`);
  }
  if (!urls[endpoint]) {
    throw new Error(`Endpoint REST inválido: ${endpoint}`);
  }
  return urls[endpoint];
}

/**
 * Obtener URL completa para endpoint de certificación
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} endpoint - Nombre del endpoint (generar, avance1, etc)
 * @returns {string} URL completa
 */
function getCertUrl(ambiente, endpoint) {
  const host = getHost(ambiente);
  const path = CERT_ENDPOINTS[endpoint];
  if (!path) {
    throw new Error(`Endpoint de certificación inválido: ${endpoint}`);
  }
  return `https://${host}${path}`;
}

/**
 * Obtener path relativo de certificación
 * @param {string} endpoint - Nombre del endpoint
 * @returns {string} Path relativo
 */
function getCertPath(endpoint) {
  const path = CERT_ENDPOINTS[endpoint];
  if (!path) {
    throw new Error(`Endpoint de certificación inválido: ${endpoint}`);
  }
  return path;
}

/**
 * Obtener todas las URLs para un ambiente
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @returns {Object} Objeto con todas las URLs
 */
function getAllUrls(ambiente) {
  const amb = String(ambiente).toLowerCase();
  return {
    host: HOSTS[amb],
    soap: SOAP_ENDPOINTS[amb],
    rest: REST_ENDPOINTS[amb],
    cert: Object.entries(CERT_ENDPOINTS).reduce((acc, [key, path]) => {
      acc[key] = `https://${HOSTS[amb]}${path}`;
      return acc;
    }, {}),
  };
}

/**
 * Validar ambiente
 * @param {string} ambiente - Ambiente a validar
 * @returns {string} Ambiente normalizado ('certificacion' o 'produccion')
 * @throws {Error} Si el ambiente es inválido
 */
function validateAmbiente(ambiente) {
  const amb = String(ambiente).toLowerCase();
  if (!['certificacion', 'produccion'].includes(amb)) {
    throw new Error(`Ambiente inválido: "${ambiente}", debe ser 'certificacion' o 'produccion'`);
  }
  return amb;
}

module.exports = {
  // Constantes
  HOSTS,
  REST_HOSTS,
  SOAP_ENDPOINTS,
  REST_ENDPOINTS,
  CERT_ENDPOINTS,
  
  // Funciones
  getHost,
  getSoapUrl,
  getRestUrl,
  getCertUrl,
  getCertPath,
  getAllUrls,
  validateAmbiente,
};
