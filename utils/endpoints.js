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
 * Web Service SOAP oficial — Aceptación/Reclamo de DTE recibido
 * Fuente: "WS Consulta y Registro de Aceptación/Reclamo a DTE recibido" v1.2, 07/08/2017, SII
 *
 * Métodos disponibles:
 *   ingresarAceptacionReclamoDoc(rutEmisor, dvEmisor, tipoDoc, folio, accionDoc)
 *     accionDoc: ACD | ERM | RCD | RFP | RFT
 *   listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio)
 *   consultarDocDteCedible(rutEmisor, dvEmisor, tipoDoc, folio)
 *   consultarFechaRecepcionSii(rutEmisor, dvEmisor, tipoDoc, folio)
 *
 * Autenticación: token SII vía cookie `TOKEN=...` (mismo flujo seed/token de SOAP_ENDPOINTS,
 * NO usa cookies NETSCAPE_LIVEWIRE del portal). Ver SiiSession.js getToken().
 *
 * Respuestas:
 *   ingresarAceptacionReclamoDoc → { codResp: number, descResp: string }
 *   listarEventosHistDoc         → { codResp, descResp, listaEventosDoc: [{ codEvento, descEvento,
 *                                    rutResponsable, dvResponsable, fechaEvento }] }
 *                                    codEvento extra (solo en lista): NCA | ENC
 *   consultarDocDteCedible       → { codResp: number, descResp: string }
 *   consultarFechaRecepcionSii   → string VARCHAR(100), ej: '21-02-2017 19:02:03'
 */
const WSRECLAMO_ENDPOINTS = {
  certificacion: 'https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice?wsdl',
  produccion:    'https://ws1.sii.cl/WSREGISTRORECLAMODTE/registroreclamodteservice?wsdl',
};

/**
 * Acciones válidas para ingresarAceptacionReclamoDoc
 */
const WSRECLAMO_ACCIONES = {
  ACD: 'Acepta Contenido del Documento',
  ERM: 'Otorga Recibo de Mercaderías o Servicios',
  RCD: 'Reclamo al Contenido del Documento',
  RFP: 'Reclamo por Falta Parcial de Mercaderías',
  RFT: 'Reclamo por Falta Total de Mercaderías',
};

/**
 * Códigos de respuesta compartidos (ingresarAceptacionReclamoDoc + listarEventosHistDoc)
 * Fuente: WS v1.2, 07/08/2017, tablas de parámetros de salida
 */
const WSRECLAMO_CODIGOS = {
  0:  'Acción Completada OK',
  1:  'Rut Emisor Erróneo',
  2:  'Número de Folio Erróneo',
  3:  'Tipo de documento no corresponde (distinto de 33, 34, 43)',
  4:  'Acción inválida',
  5:  'DTE ya está reclamado por XXX (RFP, RFT o RCD)',
  6:  'No se puede acusar recibo de mercadería de DTE previamente reclamado por XXX (RFP, RFT, RCD)',
  7:  'Evento registrado previamente',
  8:  'Pasados 8 días después de la recepción no es posible registrar reclamos o eventos',
  9:  'No existen registros de acuerdo a los parámetros ingresados',
  10: 'Documento no emitido y/o recibido en el SII desde el 14 de enero de 2017 en adelante',
  11: 'No se puede reclamar DTE previamente aceptado',
  12: 'No se puede dar por aceptado DTE previamente rechazado por XXX (RFP, RFT, RCD)',
  13: 'No se puede reclamar DTE previamente registrado como acuso recibo mercadería',
  14: 'Acción autorizada sólo para empresa receptora o emisora',
  15: 'Listado de eventos del documento',
  16: 'Documento no presenta eventos de reclamos o acuse de recibo',
  17: 'Acción autorizada solo para empresa receptora',
  18: 'Documento no ha sido recibido',
  19: 'Reclamo de mercaderías ya realizado',
  '-1': 'Error Interno — Rut Receptor debe reintentar más tarde',
};

/**
 * Códigos de respuesta exclusivos de consultarDocDteCedible
 * Fuente: WS v1.2, tabla parámetros de salida consultarDocDteCedible
 */
const WSRECLAMO_CODIGOS_CEDIBLE = {
  1:  'Rut Emisor Erróneo',
  2:  'Número de Folio Erróneo',
  10: 'Documento no emitido y/o recibido en el SII desde el 14 de enero de 2017 en adelante',
  18: 'Documento no ha sido recibido',
  20: 'Tipo de documento no es cedible',
  21: 'DTE No cedible — referenciado por nota de crédito de anulación del emisor dentro de los primeros 8 días',
  22: 'No existe registro de reclamo o de recepción de mercadería o servicios',
  23: 'DTE Cedible, sin reclamos',
  24: 'DTE No Cedible — reclamado por el receptor',
  25: 'DTE Cedible — habiendo pasado 8 días se entiende dado acuse de recibo',
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
  WSRECLAMO_ENDPOINTS,
  WSRECLAMO_ACCIONES,
  WSRECLAMO_CODIGOS,
  WSRECLAMO_CODIGOS_CEDIBLE,
  
  // Funciones
  getHost,
  getSoapUrl,
  getRestUrl,
  getCertUrl,
  getCertPath,
  getAllUrls,
  validateAmbiente,
};
