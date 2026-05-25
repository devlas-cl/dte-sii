// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * WsReclamo.js — Cliente SOAP para el WS de Aceptación/Reclamo de DTEs del SII
 *
 * Implementa el "WS Consulta y Registro de Aceptación/Reclamo a DTE recibido" v1.2
 * Fuente oficial: https://www.sii.cl/factura_electronica/factura_mercado/WSREGISTRORECLAMODTESERVICIO.pdf
 *
 * Métodos expuestos:
 *   listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio) → { codResp, descResp, eventos[] }
 *   consultarEstadoReceptor(rutEmisor, dvEmisor, tipoDoc, folio) → 'sin_accion'|'aceptada'|'tacita'|'reclamada'
 *   ingresarAceptacion(rutEmisor, dvEmisor, tipoDoc, folio, accion) → { codResp, descResp }
 *
 * Autenticación: TOKEN SII vía flujo seed/firma SOAP (mismo que EnviadorSII.getTokenSoap).
 */

const forge = require('node-forge');
const {
  SOAP_ENDPOINTS,
  WSRECLAMO_ENDPOINTS,
  validateAmbiente,
  createScopedLogger,
  getCachedToken,
  setCachedToken,
  extractTagContent,
  decodeXmlEntities,
  parseXmlNoNs,
  siiError,
  ERROR_CODES,
} = require('./utils');

const log = createScopedLogger('WsReclamo');

// ─── Acciones válidas para ingresarAceptacionReclamoDoc ───────────────────────
/** @typedef {'ACD'|'ERM'|'RCD'|'RFP'|'RFT'} AccionReclamo */

// ─── Mapeo codEvento → estado normalizado ────────────────────────────────────
// Mapeo de codEvento WSRECLAMO → estado receptor
// 'tacita' NO es un evento del WS — es una presunción legal cuando pasan 8 días
// sin eventos (codResp=16). Se calcula en capa de negocio, no aquí.
const ESTADO_POR_EVENTO = {
  ACD: 'aceptada',      // Acepta Contenido del Documento (explícito)
  ERM: 'acuse_recibo', // Otorga Recibo de Mercaderías/Servicios (explícito)
  RCD: 'reclamada',    // Reclamo al Contenido del Documento
  RFP: 'reclamada',    // Reclamo por Falta Parcial de Mercaderías
  RFT: 'reclamada',    // Reclamo por Falta Total de Mercaderías
  NCA: 'sin_accion',   // NC de anulación que referencia el doc (no registrable por WS)
  ENC: 'sin_accion',   // NC distinta de anulación que referencia el doc (no registrable)
};

class WsReclamo {
  /**
   * @param {Object} certificado  — instancia de Certificado con privateKey y cert
   * @param {string} ambiente     — 'certificacion' | 'produccion'
   * @param {Object} [options]
   * @param {boolean} [options.useTokenCache=true]
   */
  constructor(certificado, ambiente, options = {}) {
    if (!certificado) throw new Error('WsReclamo: certificado es obligatorio');
    this.certificado = certificado;
    this.ambiente = validateAmbiente(ambiente);
    this.useTokenCache = options.useTokenCache !== false;

    this.rutCert = certificado.rut || 'unknown';

    this._tokenSoap = null;

    // URLs
    this._seedUrl  = SOAP_ENDPOINTS[this.ambiente].seed;
    this._tokenUrl = SOAP_ENDPOINTS[this.ambiente].token;
    this._wsUrl    = WSRECLAMO_ENDPOINTS[this.ambiente].replace('?wsdl', '');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // AUTENTICACIÓN — mismo flujo que EnviadorSII.getTokenSoap
  // ══════════════════════════════════════════════════════════════════════════════

  /** Obtiene semilla del servicio SOAP del SII */
  async _getSemilla() {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getSeed/></soapenv:Body>
</soapenv:Envelope>`;

    const res = await fetch(this._seedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    });
    if (!res.ok) throw siiError(`Error semilla: ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);

    const xml = await res.text();
    const semilla = extractTagContent(decodeXmlEntities(xml), 'SEMILLA');
    if (!semilla) throw siiError('No se obtuvo semilla del SII', ERROR_CODES.SII_INVALID_RESPONSE);
    return semilla;
  }

  /** Firma la semilla y obtiene el TOKEN SOAP */
  async _fetchTokenSoap() {
    const semilla = await this._getSemilla();
    const xmlFirmado = this._firmarSemilla(semilla);

    const escaped = xmlFirmado
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getToken>
      <pszXml>${escaped}</pszXml>
    </getToken>
  </soapenv:Body>
</soapenv:Envelope>`;

    const res = await fetch(this._tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    });
    if (!res.ok) throw siiError(`Error token: ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);

    const xml = await res.text();
    const decoded = xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const token = extractTagContent(decoded, 'TOKEN');
    if (!token) throw siiError('No se obtuvo TOKEN del SII', ERROR_CODES.SII_AUTH_FAILED);

    return token;
  }

  /** Obtiene o reutiliza el token SOAP (con cache opcional) */
  async _ensureToken() {
    if (this.useTokenCache) {
      const cached = getCachedToken(this.ambiente, 'soap', this.rutCert);
      if (cached) {
        this._tokenSoap = cached;
        return cached;
      }
    }

    const token = await this._fetchTokenSoap();
    this._tokenSoap = token;

    if (this.useTokenCache) {
      setCachedToken(this.ambiente, 'soap', this.rutCert, token);
    }
    return token;
  }

  /** Invalida el token cacheado para forzar renovación */
  invalidarToken() {
    this._tokenSoap = null;
    // invalidateToken no está disponible en utils — limpiamos el caché con un token vacío
    // o simplemente seteamos nulo; el cache expira por TTL
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FIRMA DE SEMILLA — idéntico a EnviadorSII._crearXMLSemilla
  // ══════════════════════════════════════════════════════════════════════════════

  _firmarSemilla(semilla) {
    const xmlContent = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

    const md = forge.md.sha1.create();
    md.update(xmlContent, 'utf8');
    const digestValue = forge.util.encode64(md.digest().bytes());

    const signedInfoParaFirmar = [
      '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>',
      '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>',
      '<Reference URI=""><Transforms>',
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>',
      '</Transforms>',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>',
      `<DigestValue>${digestValue}</DigestValue>`,
      '</Reference></SignedInfo>',
    ].join('');

    const mdSign = forge.md.sha1.create();
    mdSign.update(signedInfoParaFirmar, 'utf8');
    const signature = this.certificado.privateKey.sign(mdSign);
    const signatureValue = this._wordwrap(forge.util.encode64(signature), 64);

    const modulus  = this._wordwrap(this.certificado.getModulus(), 64);
    const exponent = this.certificado.getExponent();
    const cert     = this._wordwrap(this.certificado.getCertificateBase64(), 64);

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<getToken><item><Semilla>${semilla}</Semilla></item>`,
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
      '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>',
      '<Reference URI=""><Transforms>',
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>',
      '</Transforms>',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>',
      `<DigestValue>${digestValue}</DigestValue>`,
      '</Reference></SignedInfo>',
      `<SignatureValue>${signatureValue}</SignatureValue>`,
      '<KeyInfo><KeyValue><RSAKeyValue>',
      `<Modulus>${modulus}</Modulus>`,
      `<Exponent>${exponent}</Exponent>`,
      '</RSAKeyValue></KeyValue>',
      `<X509Data><X509Certificate>${cert}</X509Certificate></X509Data>`,
      '</KeyInfo></Signature></getToken>',
    ].join('');
  }

  _wordwrap(str, width) {
    const lines = [];
    for (let i = 0; i < str.length; i += width) {
      lines.push(str.substring(i, i + width));
    }
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // LLAMADAS SOAP AL WSRECLAMO
  // ══════════════════════════════════════════════════════════════════════════════

  // Namespace oficial del servicio (fuente: WSDL producción/certificación)
  static NS = 'http://ws.registroreclamodte.diii.sdi.sii.cl';

  /**
   * Realiza una llamada SOAP al WSRECLAMO con autenticación via TOKEN cookie.
   * Namespace verificado desde: https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice?wsdl
   * @private
   */
  async _llamar(metodo, params, reintentar = true) {
    const token = await this._ensureToken();
    const ns = WsReclamo.NS;

    const innerXml = Object.entries(params)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('');

    // El body usa el prefijo ws: con el namespace del servicio
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <ws:${metodo}>${innerXml}</ws:${metodo}>
  </soapenv:Body>
</soapenv:Envelope>`;

    const res = await fetch(this._wsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
        Cookie: `TOKEN=${token}`,
      },
      body: envelope,
    });

    // Si el SII devuelve 403/401, el token puede haber expirado — reintentar una vez
    if ((res.status === 401 || res.status === 403) && reintentar) {
      log.log(`[WsReclamo] Token expirado (${res.status}), renovando...`);
      this._tokenSoap = null;
      return this._llamar(metodo, params, false);
    }

    if (!res.ok) {
      throw siiError(`WSRECLAMO ${metodo}: HTTP ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);
    }

    const xml = await res.text();
    return xml;
  }

  /**
   * Lista todos los eventos históricos de aceptación/reclamo para un DTE.
   *
   * @param {string} rutEmisor   — RUT sin DV ni puntos, ej: '76354771'
   * @param {string} dvEmisor    — DV del RUT, ej: 'K'
   * @param {number} tipoDoc     — Tipo de DTE, ej: 33 (factura afecta)
   * @param {number} folio       — Número de folio
   * @returns {Promise<{codResp: number, descResp: string, eventos: Array<{codEvento: string, descEvento: string, rutResponsable: string, dvResponsable: string, fechaEvento: string}>}>}
   */
  async listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio) {
    log.log(`[WsReclamo] listarEventosHistDoc RUT=${rutEmisor}-${dvEmisor} tipo=${tipoDoc} folio=${folio}`);

    const xml = await this._llamar('listarEventosHistDoc', {
      rutEmisor,
      dvEmisor,
      tipoDoc,
      folio,
    });

    return this._parsearRespuestaEventos(xml);
  }

  /**
   * Consulta el estado resumido del receptor para un DTE emitido.
   * Devuelve el estado derivado del evento más reciente.
   *
   * Códigos relevantes de listarEventosHistDoc (doc SII v1.2):
   *   15 = Listado de eventos del documento (hay eventos)
   *   16 = Documento no presenta eventos de reclamos o acuse de recibo
   *   18 = Documento no ha sido recibido por el receptor
   *
   * @returns {Promise<'sin_accion'|'aceptada'|'tacita'|'reclamada'>}
   */
  async consultarEstadoReceptor(rutEmisor, dvEmisor, tipoDoc, folio) {
    const { codResp, eventos } = await this.listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio);

    // 16 = sin eventos de reclamo/acuse | 18 = no recibido aún
    if (codResp === 16 || codResp === 18) {
      return 'sin_accion';
    }

    // 15 = hay eventos — tomar el más reciente
    if (codResp === 15 && eventos && eventos.length > 0) {
      const ultimo = eventos[eventos.length - 1];
      return ESTADO_POR_EVENTO[ultimo.codEvento] ?? 'sin_accion';
    }

    return 'sin_accion';
  }

  /**
   * Ingresa una acción de aceptación o reclamo sobre un DTE recibido.
   * Uso típico: el receptor registra su decisión.
   *
   * @param {string} rutEmisor
   * @param {string} dvEmisor
   * @param {number} tipoDoc
   * @param {number} folio
   * @param {AccionReclamo} accionDoc  — 'ACD'|'ERM'|'RCD'|'RFP'|'RFT'
   * @returns {Promise<{codResp: number, descResp: string}>}
   */
  async ingresarAceptacion(rutEmisor, dvEmisor, tipoDoc, folio, accionDoc) {
    const ACCIONES_VALIDAS = ['ACD', 'ERM', 'RCD', 'RFP', 'RFT'];
    if (!ACCIONES_VALIDAS.includes(accionDoc)) {
      throw new Error(`WsReclamo: accionDoc inválida '${accionDoc}'. Debe ser una de: ${ACCIONES_VALIDAS.join(', ')}`);
    }

    log.log(`[WsReclamo] ingresarAceptacion RUT=${rutEmisor}-${dvEmisor} tipo=${tipoDoc} folio=${folio} accion=${accionDoc}`);

    const xml = await this._llamar('ingresarAceptacionReclamoDoc', {
      rutEmisor,
      dvEmisor,
      tipoDoc,
      folio,
      accionDoc,
    });

    return this._parsearRespuestaSimple(xml);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PARSERS XML
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Parsea respuesta de listarEventosHistDoc.
   *
   * Estructura real (verificada en doc SII v1.2 y SoapUI screenshot):
   * <return>
   *   <codResp>15</codResp>
   *   <descResp>Listado de eventos del documento</descResp>
   *   <listaEventosDoc>
   *     <codEvento>ACD</codEvento>
   *     <descEvento>Acepta Contenido del Documento</descEvento>
   *     <rutResponsable>45000055</rutResponsable>
   *     <dvResponsable>8</dvResponsable>
   *     <fechaEvento>29-12-2016 12:05:36</fechaEvento>
   *   </listaEventosDoc>
   * </return>
   */
  _parsearRespuestaEventos(xml) {
    // Decode HTML entities del wrapper SOAP
    const decoded = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extraer el bloque <return>...</return>
    const returnMatch = decoded.match(/<return>([\s\S]*?)<\/return>/i);
    const bloque = returnMatch ? returnMatch[1] : decoded;

    const codResp  = parseInt(extractTagContent(bloque, 'codResp') ?? '16', 10);
    const descResp = extractTagContent(bloque, 'descResp') ?? '';

    // Extraer cada <listaEventosDoc>...</listaEventosDoc>
    const eventos = [];
    const itemRegex = /<listaEventosDoc>([\s\S]*?)<\/listaEventosDoc>/gi;
    let match;
    while ((match = itemRegex.exec(bloque)) !== null) {
      const item = match[1];
      eventos.push({
        codEvento:       extractTagContent(item, 'codEvento')      ?? '',
        descEvento:      extractTagContent(item, 'descEvento')     ?? '',
        rutResponsable:  extractTagContent(item, 'rutResponsable') ?? '',
        dvResponsable:   extractTagContent(item, 'dvResponsable')  ?? '',
        fechaEvento:     extractTagContent(item, 'fechaEvento')    ?? '',
      });
    }

    return { codResp, descResp, eventos };
  }

  /**
   * Parsea respuesta de ingresarAceptacionReclamoDoc y consultarDocDteCedible.
   *
   * Estructura:
   * <return>
   *   <codResp>0</codResp>
   *   <descResp>Acción completada OK</descResp>
   * </return>
   *
   * codResp 0 = OK (ingresarAceptacion)
   */
  _parsearRespuestaSimple(xml) {
    const decoded = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    const returnMatch = decoded.match(/<return>([\s\S]*?)<\/return>/i);
    const bloque = returnMatch ? returnMatch[1] : decoded;

    const codResp  = parseInt(extractTagContent(bloque, 'codResp') ?? '-1', 10);
    const descResp = extractTagContent(bloque, 'descResp') ?? '';
    return { codResp, descResp };
  }
}

module.exports = WsReclamo;
