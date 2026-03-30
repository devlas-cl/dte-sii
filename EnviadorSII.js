// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * EnviadorSII.js
 * 
 * Comunicación con los servicios web del SII para:
 * - Autenticación (semilla/token)
 * - Envío de boletas (API REST)
 * - Envío de DTEs (SOAP/DTEUpload)
 * - Envío de RCOF (SOAP/DTEUpload)
 * - Envío de Libros (SOAP/DTEUpload)
 * - Consulta de estado de envíos
 */

const https = require('https');
const forge = require('node-forge');
const FormData = require('form-data');
const { 
  saveEnvioArtifacts,
  siiError,
  ERROR_CODES,
  createScopedLogger,
  getConfigSection,
  withRetry,
  isRetryableError,
  isRetryableStatus,
  getCachedToken,
  setCachedToken,
  invalidateToken,
  // Nuevas utilidades centralizadas
  parseXml,
  parseXmlNoNs,
  decodeXmlEntities,
  extractTagContent,
  SOAP_ENDPOINTS,
  REST_ENDPOINTS,
  validateAmbiente,
} = require('./utils');

const log = createScopedLogger('EnviadorSII');

class EnviadorSII {
  /**
   * @param {Object} certificado - Instancia de Certificado (OBLIGATORIO)
   * @param {string} ambiente - 'certificacion' o 'produccion' (OBLIGATORIO)
   * @param {Object} [options] - Opciones adicionales
   * @param {boolean} [options.useTokenCache=true] - Usar cache de tokens
   */
  constructor(certificado, ambiente, options = {}) {
    // Validar parámetros obligatorios (multi-tenant: nunca usar defaults)
    if (!certificado) {
      throw siiError('EnviadorSII: certificado es obligatorio', ERROR_CODES.CONFIG_MISSING);
    }
    if (!ambiente) {
      throw siiError('EnviadorSII: ambiente es obligatorio', ERROR_CODES.CONFIG_MISSING);
    }
    
    // Usar validador centralizado
    this.ambiente = validateAmbiente(ambiente);
    this.certificado = certificado;
    this.token = null;         // Token REST (boletas)
    this.tokenSoap = null;     // Token SOAP (DTEUpload)
    
    // Opciones
    this.useTokenCache = options.useTokenCache !== false;
    
    // RUT del certificado para cache
    this.rutCert = certificado.rut || 'unknown';
    
    // URLs centralizadas desde utils/endpoints.js
    this.urls = {
      certificacion: {
        ...REST_ENDPOINTS.certificacion,
        rcof: SOAP_ENDPOINTS.certificacion.upload,
        semillaSoap: SOAP_ENDPOINTS.certificacion.seed,
        tokenSoap: SOAP_ENDPOINTS.certificacion.token,
      },
      produccion: {
        ...REST_ENDPOINTS.produccion,
        rcof: SOAP_ENDPOINTS.produccion.upload,
        semillaSoap: SOAP_ENDPOINTS.produccion.seed,
        tokenSoap: SOAP_ENDPOINTS.produccion.token,
      },
    };
  }

  // ============================================
  // AUTENTICACIÓN REST (Boletas)
  // ============================================

  /**
   * Obtener semilla de autenticación del SII (API REST)
   */
  async getSemilla() {
    const url = this.urls[this.ambiente].semilla;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/xml',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Error obteniendo semilla: ${response.status}`);
    }
    
    const xml = await response.text();
    // Usar parser centralizado
    const data = parseXml(xml);
    
    // Estructura con namespaces SII
    const respuesta = data['SII:RESPUESTA'];
    if (respuesta?.['SII:RESP_BODY']?.SEMILLA) {
      return respuesta['SII:RESP_BODY'].SEMILLA.toString();
    }
    
    if (data.SII?.RESP_BODY?.SEMILLA) {
      return data.SII.RESP_BODY.SEMILLA.toString();
    }
    
    if (data.RESPUESTA?.RESP_BODY?.SEMILLA) {
      return data.RESPUESTA.RESP_BODY.SEMILLA.toString();
    }
    
    if (data.getToken?.item?.Semilla) {
      return data.getToken.item.Semilla.toString();
    }
    
    log.debug(' Estructura XML parseada:', JSON.stringify(data, null, 2));
    throw new Error('No se pudo obtener semilla del SII');
  }

  /**
   * Firmar semilla y obtener token (API REST)
   */
  async getToken() {
    const semilla = await this.getSemilla();
    const xmlSemilla = this._crearXMLSemilla(semilla);
    
    const url = this.urls[this.ambiente].token;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'Accept': 'application/xml',
      },
      body: xmlSemilla,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error obteniendo token: ${response.status} - ${errorText}`);
    }
    
    const xml = await response.text();
    // Usar parser centralizado con namespaces removidos
    const data = parseXmlNoNs(xml);
    
    const respuesta = data.RESPUESTA || data['SII:RESPUESTA'];
    if (respuesta) {
      const respBody = respuesta.RESP_BODY || respuesta['SII:RESP_BODY'];
      if (respBody && respBody.TOKEN) {
        this.token = respBody.TOKEN;
        return this.token;
      }
    }
    
    throw new Error('No se pudo obtener token del SII');
  }

  // ============================================
  // AUTENTICACIÓN SOAP (DTEUpload)
  // ============================================

  /**
   * Obtener semilla del servicio SOAP para DTEUpload
   * Usa configuración centralizada para reintentos
   */
  async getSemillaSoap() {
    const url = this.urls[this.ambiente].semillaSoap;
    const retryConfig = getConfigSection('retry');
    const maxRetries = retryConfig?.maxRetries || 6;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getSeed/>
  </soapenv:Body>
</soapenv:Envelope>`;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          log.log(` [...] Reintento semilla SOAP ${attempt}/${maxRetries}...`);
          await wait(attempt * 1000);
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': '',
          },
          body: soapEnvelope,
        });

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < maxRetries) {
            log.log(` [!] Error semilla SOAP (${response.status}), reintentando...`);
            continue;
          }
          throw siiError(`Error obteniendo semilla SOAP: ${response.status}`, ERROR_CODES.SII_CONNECTION_FAILED);
        }

        const xml = await response.text();
        // Usar utilidad centralizada para decodificar entidades
        const decodedXml = decodeXmlEntities(xml);

        // Usar utilidad centralizada para extraer contenido de etiqueta
        const semilla = extractTagContent(decodedXml, 'SEMILLA');
        if (semilla) {
          return semilla;
        }

        const estado = extractTagContent(decodedXml, 'ESTADO');
        if (estado && estado !== '00') {
          throw siiError(`Error del SII al obtener semilla: Estado ${estado}`, ERROR_CODES.SII_INVALID_RESPONSE);
        }

        throw siiError('No se pudo extraer semilla de la respuesta SOAP', ERROR_CODES.SII_INVALID_RESPONSE);
      } catch (error) {
        if (isRetryableError(error) && attempt < maxRetries) {
          log.log(` [!] Error de conexión semilla SOAP (${error.cause?.code || 'socket'}), reintentando...`);
          continue;
        }
        throw error;
      }
    }

    throw siiError('Semilla SOAP falló después de múltiples reintentos', ERROR_CODES.SII_TIMEOUT);
  }

  /**
   * Obtener token del servicio SOAP para DTEUpload
   * Usa cache de tokens para evitar solicitudes innecesarias
   */
  async getTokenSoap() {
    // Verificar cache primero
    if (this.useTokenCache) {
      const cached = getCachedToken(this.ambiente, 'soap', this.rutCert);
      if (cached) {
        log.log(' [OK] Token SOAP desde cache');
        this.tokenSoap = cached;
        return cached;
      }
    }

    const retryConfig = getConfigSection('retry');
    const maxRetries = retryConfig?.maxRetries || 6;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const url = this.urls[this.ambiente].tokenSoap;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          log.log(` [...] Reintento token SOAP ${attempt}/${maxRetries}...`);
          await wait(attempt * 1000);
        }

        const semilla = await this.getSemillaSoap();
        const xmlSemilla = this._crearXMLSemilla(semilla);

        const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getToken>
      <pszXml>${xmlSemilla.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pszXml>
    </getToken>
  </soapenv:Body>
</soapenv:Envelope>`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': '',
          },
          body: soapEnvelope,
        });

        if (!response.ok) {
          const errorText = await response.text();
          if (isRetryableStatus(response.status) && attempt < maxRetries) {
            log.log(` [!] Error token SOAP (${response.status}), reintentando...`);
            continue;
          }
          throw siiError(`Error obteniendo token SOAP: ${response.status} - ${errorText}`, ERROR_CODES.SII_CONNECTION_FAILED);
        }

        const xml = await response.text();
        const decodedXml = xml
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');

        const tokenMatch = decodedXml.match(/<TOKEN>([^<]+)<\/TOKEN>/i);
        if (tokenMatch) {
          this.tokenSoap = tokenMatch[1];
          
          // Guardar en cache
          if (this.useTokenCache) {
            setCachedToken(this.ambiente, 'soap', this.rutCert, this.tokenSoap);
          }
          
          log.log(' [OK] Token SOAP obtenido');
          return this.tokenSoap;
        }

        const estadoMatch = decodedXml.match(/<ESTADO>(\d+)<\/ESTADO>/);
        const glosaMatch = decodedXml.match(/<GLOSA>([^<]+)<\/GLOSA>/);
        if (estadoMatch && estadoMatch[1] !== '00') {
          throw siiError(`Error del SII: Estado ${estadoMatch[1]} - ${glosaMatch ? glosaMatch[1] : 'Sin detalle'}`, ERROR_CODES.SII_AUTH_FAILED);
        }

        throw siiError('No se pudo obtener token SOAP del SII', ERROR_CODES.SII_INVALID_RESPONSE);
      } catch (error) {
        if (isRetryableError(error) && attempt < maxRetries) {
          log.log(` [!] Error de conexión token SOAP (${error.cause?.code || 'socket'}), reintentando...`);
          continue;
        }
        throw error;
      }
    }

    throw siiError('Token SOAP falló después de múltiples reintentos', ERROR_CODES.SII_TIMEOUT);
  }

  /**
   * Invalidar token cacheado (para forzar renovación)
   */
  invalidateCachedToken(tipo = 'soap') {
    invalidateToken(this.ambiente, tipo, this.rutCert);
    if (tipo === 'soap') {
      this.tokenSoap = null;
    } else {
      this.token = null;
    }
  }

  // ============================================
  // HELPERS DE FIRMA
  // ============================================

  /**
   * Crear XML de semilla firmado
   */
  _crearXMLSemilla(semilla) {
    const xmlContent = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
    
    const md = forge.md.sha1.create();
    md.update(xmlContent, 'utf8');
    const digestValue = forge.util.encode64(md.digest().bytes());
    
    const signedInfoParaFirmar = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digestValue}</DigestValue></Reference></SignedInfo>`;
    
    const mdSign = forge.md.sha1.create();
    mdSign.update(signedInfoParaFirmar, 'utf8');
    const signature = this.certificado.privateKey.sign(mdSign);
    const signatureValue = this._wordwrap(forge.util.encode64(signature), 64);
    
    const modulus = this._wordwrap(this.certificado.getModulus(), 64);
    const exponent = this.certificado.getExponent();
    const cert = this._wordwrap(this.certificado.getCertificateBase64(), 64);
    
    const xmlFirmado = `<?xml version="1.0" encoding="UTF-8"?>
<getToken><item><Semilla>${semilla}</Semilla></item><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digestValue}</DigestValue></Reference></SignedInfo><SignatureValue>${signatureValue}</SignatureValue><KeyInfo><KeyValue><RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></Signature></getToken>`;
    
    return xmlFirmado;
  }

  /**
   * Wordwrap para base64 (como PHP)
   */
  _wordwrap(str, width) {
    const lines = [];
    for (let i = 0; i < str.length; i += width) {
      lines.push(str.substring(i, i + width));
    }
    return lines.join('\n');
  }

  // ============================================
  // ENVÍO DE BOLETAS (API REST)
  // ============================================

  /**
   * Enviar EnvioBOLETA al SII (API REST para Boletas)
   */
  async enviar(envioBoleta, rutEmisor, rutEnvia) {
    if (!this.token) {
      await this.getToken();
    }
    
    if (!envioBoleta.xml) {
      envioBoleta.setCaratula({
        RutEmisor: rutEmisor,
        RutEnvia: rutEnvia,
        FchResol: envioBoleta.config?.fchResol || '2014-08-22',
        NroResol: envioBoleta.config?.nroResol !== undefined ? envioBoleta.config.nroResol : 0,
      });
      envioBoleta.generar();
    }
    
    const url = this.urls[this.ambiente].envio;
    let xml = envioBoleta.getXML();
    
    if (!xml) {
      throw new Error('No se pudo generar el XML del EnvioBOLETA');
    }
    
    if (!xml.startsWith('<?xml')) {
      xml = '<?xml version="1.0" encoding="ISO-8859-1"?>\n' + xml;
    }
    
    const [rutSenderStr, dvSender] = rutEnvia.split('-');
    const [rutCompanyStr, dvCompany] = rutEmisor.split('-');
    const rutSender = parseInt(rutSenderStr.replace(/\./g, ''), 10);
    const rutCompany = parseInt(rutCompanyStr.replace(/\./g, ''), 10);
    
    const formData = new FormData();
    formData.append('rutSender', rutSender.toString());
    formData.append('dvSender', dvSender.toUpperCase());
    formData.append('rutCompany', rutCompany.toString());
    formData.append('dvCompany', dvCompany.toUpperCase());
    
    const xmlBuffer = Buffer.from(xml, 'utf-8');
    formData.append('archivo', xmlBuffer, {
      filename: 'EnvioBOLETA.xml',
      contentType: 'application/xml',
    });
    
    log.log('Enviando al SII:', url);
    log.log('RUT Sender:', rutSender, '-', dvSender.toUpperCase());
    log.log('RUT Company:', rutCompany, '-', dvCompany.toUpperCase());
    log.log('XML Length:', xmlBuffer.length, 'bytes');
    
    const urlObj = new URL(url);
    const formBuffer = formData.getBuffer();
    const formHeaders = formData.getHeaders();
    
    const responseText = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          ...formHeaders,
          'Content-Length': formBuffer.length,
          'User-Agent': 'Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)',
          'Accept': 'application/json',
          'Cookie': `TOKEN=${this.token}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          log.log('HTTP Status:', res.statusCode);
          resolve({ text: data, status: res.statusCode });
        });
      });
      
      req.on('error', reject);
      req.write(formBuffer);
      req.end();
    });
    
    log.log('Respuesta SII:', responseText.text);
    
    const resultado = this._parsearRespuestaEnvio(responseText.text, responseText.status);
    saveEnvioArtifacts({
      xml,
      responseText: responseText.text,
      responseOk: resultado.ok,
      responseStatus: responseText.status,
      trackId: resultado.trackId || null,
      ambiente: this.ambiente,
      tipoEnvio: 'EnvioBOLETA-REST',
      error: resultado.error || null,
    });

    return resultado;
  }

  /**
   * Enviar XML ya generado directamente al SII
   */
  async enviarXmlDirecto(xml, rutEmisor, rutEnvia) {
    if (!this.token) {
      await this.getToken();
    }
    
    const url = this.urls[this.ambiente].envio;
    
    if (!xml.startsWith('<?xml')) {
      xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
    }
    
    const [rutSenderStr, dvSender] = rutEnvia.split('-');
    const [rutCompanyStr, dvCompany] = rutEmisor.split('-');
    const rutSender = parseInt(rutSenderStr.replace(/\./g, ''), 10);
    const rutCompany = parseInt(rutCompanyStr.replace(/\./g, ''), 10);
    
    const formData = new FormData();
    formData.append('rutSender', rutSender.toString());
    formData.append('dvSender', dvSender.toUpperCase());
    formData.append('rutCompany', rutCompany.toString());
    formData.append('dvCompany', dvCompany.toUpperCase());
    
    const xmlBuffer = Buffer.from(xml, 'utf-8');
    formData.append('archivo', xmlBuffer, {
      filename: 'EnvioBOLETA.xml',
      contentType: 'application/xml',
    });
    
    log.log('Enviando XML directo al SII:', url);
    log.log('RUT Sender:', rutSender, '-', dvSender.toUpperCase());
    log.log('RUT Company:', rutCompany, '-', dvCompany.toUpperCase());
    log.log('XML Length:', xmlBuffer.length, 'bytes');
    
    const urlObj = new URL(url);
    const formBuffer = formData.getBuffer();
    const formHeaders = formData.getHeaders();
    
    const responseText = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          ...formHeaders,
          'Content-Length': formBuffer.length,
          'User-Agent': 'Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)',
          'Accept': 'application/json',
          'Cookie': `TOKEN=${this.token}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          log.log('HTTP Status:', res.statusCode);
          resolve({ text: data, status: res.statusCode });
        });
      });
      
      req.on('error', reject);
      req.write(formBuffer);
      req.end();
    });
    
    log.log('Respuesta SII:', responseText.text);
    const resultado = this._parsearRespuestaEnvio(responseText.text, responseText.status);
    saveEnvioArtifacts({
      xml,
      responseText: responseText.text,
      responseOk: resultado.ok,
      responseStatus: responseText.status,
      trackId: resultado.trackId || null,
      ambiente: this.ambiente,
      tipoEnvio: 'EnvioBOLETA-REST',
      error: resultado.error || null,
    });
    return resultado;
  }

  /**
   * Parsear respuesta del envío (JSON de la API REST)
   */
  _parsearRespuestaEnvio(responseText, httpStatus) {
    if (httpStatus !== 200) {
      return {
        ok: false,
        status: httpStatus,
        trackId: null,
        mensaje: `Error HTTP ${httpStatus}`,
        respuesta: responseText,
      };
    }
    
    try {
      const json = JSON.parse(responseText);
      
      if (json.trackid) {
        return {
          ok: true,
          status: 0,
          trackId: json.trackid.toString(),
          mensaje: `[OK] Enviado al SII - TrackID: ${json.trackid}`,
          respuesta: json,
        };
      }
      
      if (json.error || json.mensaje) {
        return {
          ok: false,
          status: json.codigo || json.status || -1,
          trackId: null,
          mensaje: json.error || json.mensaje || 'Error desconocido',
          respuesta: json,
        };
      }
      
      return {
        ok: false,
        status: -1,
        trackId: null,
        mensaje: 'Respuesta JSON sin trackid',
        respuesta: json,
      };
    } catch (e) {
      const statusMatch = responseText.match(/<STATUS>(\d+)<\/STATUS>/);
      const trackIdMatch = responseText.match(/<TRACKID>(\d+)<\/TRACKID>/);
      
      const status = statusMatch ? parseInt(statusMatch[1]) : null;
      const trackId = trackIdMatch ? trackIdMatch[1] : null;
      
      if (status === 0 && trackId) {
        return {
          ok: true,
          status: status,
          trackId: trackId,
          mensaje: `[OK] Enviado al SII - TrackID: ${trackId}`,
        };
      }
      
      return {
        ok: false,
        status: status,
        trackId: trackId,
        mensaje: 'Error parseando respuesta',
        respuesta: responseText,
      };
    }
  }

  // ============================================
  // CONSULTA DE ESTADO
  // ============================================

  /**
   * Consultar estado de envío (API REST)
   */
  async consultarEstado(trackId, rutEmisor, rutEnvia = null) {
    if (!this.token) {
      await this.getToken();
    }
    
    const rutEmisorLimpio = rutEmisor.replace(/\./g, '');
    const url = `${this.urls[this.ambiente].estado}${rutEmisorLimpio}-${trackId}`;
    
    log.log('Consultando estado:', url);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': `TOKEN=${this.token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)',
      },
    });
    
    const responseText = await response.text();
    log.log('Respuesta estado:', responseText);
    
    if (!response.ok) {
      return {
        ok: false,
        error: `Error HTTP ${response.status}`,
        respuesta: responseText,
      };
    }
    
    try {
      const json = JSON.parse(responseText);
      
      let mensaje = '';
      const estado = json.estado;
      if (estado === 'REC') mensaje = 'Envío recibido';
      else if (estado === 'SOK') mensaje = '[OK] Esquema validado';
      else if (estado === 'FOK') mensaje = '[OK] Firma de envío validada';
      else if (estado === 'PRD') mensaje = '[...] Envío en proceso';
      else if (estado === 'CRT') mensaje = '[OK] Carátula OK';
      else if (estado === 'EPR') mensaje = '[OK] Envío procesado';
      else if (estado === 'RPT') mensaje = '[ERR] Rechazado por schema';
      else if (estado === 'RFR') mensaje = '[ERR] Rechazado por error en firma';
      else if (estado === 'VOF') mensaje = '[ERR] Error interno en SII';
      else if (estado === 'RCT') mensaje = '[ERR] Rechazado por error en carátula';
      else if (estado === 'RPR') mensaje = '[!] Aceptado con reparos';
      else if (estado === 'RLV') mensaje = '[OK] Aceptado - Documento(s) válido(s)';
      else if (estado === 'RCH') mensaje = `[ERR] Rechazado: ${json.glosa || json.descripcion || 'Sin detalle'}`;
      else mensaje = `Estado: ${estado}`;
      
      return {
        ok: true,
        trackId: trackId,
        estado: estado,
        descripcion: json.descripcion || json.glosa,
        mensaje,
        ...json,
      };
    } catch (e) {
      return {
        ok: false,
        error: 'Error parseando respuesta',
        mensaje: 'Error parseando respuesta del SII',
        respuesta: responseText,
      };
    }
  }

  /**
   * Consultar estado de envío via SOAP (QueryEstUp.jws)
   */
  async consultarEstadoSoap(trackId, rutEmisor) {
    if (!this.tokenSoap) {
      await this.getTokenSoap();
    }
    
    const servidor = this.ambiente === 'produccion' ? 'palena' : 'maullin';
    const [rutNum, dv] = rutEmisor.replace(/\./g, '').split('-');
    
    const urlQueryEstUp = `https://${servidor}.sii.cl/DTEWS/QueryEstUp.jws`;
    
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getEstUp>
      <RutEmpresa>${rutNum}</RutEmpresa>
      <DvEmpresa>${dv}</DvEmpresa>
      <TrackId>${trackId}</TrackId>
      <Token>${this.tokenSoap}</Token>
    </getEstUp>
  </soapenv:Body>
</soapenv:Envelope>`;
    
    log.log('Consultando estado SOAP:', urlQueryEstUp);
    log.log(' TrackID:', trackId, 'RUT:', rutEmisor);
    
    const response = await fetch(urlQueryEstUp, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '',
      },
      body: soapBody,
    });
    
    const text = await response.text();
    
    // Usar decodeXmlEntities centralizado
    const decoded = decodeXmlEntities(text).replace(/&#xd;/g, '\n');
    


    const estadoMatch = decoded.match(/<ESTADO>([^<]+)<\/ESTADO>/i);
    const glosaMatch = decoded.match(/<GLOSA>([^<]+)<\/GLOSA>/i);
    const numAtencionMatch = decoded.match(/<NUM_ATENCION>([^<]+)<\/NUM_ATENCION>/i);
    const errCodeMatch = decoded.match(/<ERR_CODE>([^<]+)<\/ERR_CODE>/i);
    
    const estado = estadoMatch ? estadoMatch[1] : null;
    const glosa = glosaMatch ? glosaMatch[1] : null;
    
    if (!estado) {
      if (errCodeMatch) {
        return {
          ok: false,
          error: `Error ${errCodeMatch[1]}`,
          glosa: glosa || 'Error desconocido',
          respuesta: decoded,
        };
      }
      return {
        ok: false,
        error: 'No se pudo obtener estado',
        respuesta: decoded,
      };
    }
    
    let mensaje = '';
    let esExitoso = false;
    let esIntermedio = false;
    let esRechazado = false;
    
    switch (estado) {
      case 'EPR':
        mensaje = '[OK] Envío Procesado';
        esExitoso = true;
        break;
      case 'RPR':
        mensaje = '[!] Aceptado con Reparos';
        esExitoso = true;
        break;
      case 'REC':
        mensaje = '[...] Envío Recibido - Esperando validación';
        esIntermedio = true;
        break;
      case 'SOK':
        mensaje = '[...] Schema OK - Validando firma...';
        esIntermedio = true;
        break;
      case 'FOK':
        mensaje = '[...] Firma Validada - Procesando envío...';
        esIntermedio = true;
        break;
      case 'PRD':
        mensaje = '[...] Envío en Proceso - Validando carátula...';
        esIntermedio = true;
        break;
      case 'CRT':
        mensaje = '[...] Carátula OK - Finalizando proceso...';
        esIntermedio = true;
        break;
      case 'DNK':
        mensaje = '[...] En proceso de revisión';
        esIntermedio = true;
        break;
      case 'RPT':
        mensaje = `[ERR] Rechazado por Schema: ${glosa || 'Error en estructura XML'}`;
        esRechazado = true;
        break;
      case 'RFR':
        mensaje = `[ERR] Rechazado por Firma: ${glosa || 'Error en firma digital'}`;
        esRechazado = true;
        break;
      case 'VOF':
        mensaje = `[ERR] Error Interno del SII: ${glosa || 'Reintentar más tarde'}`;
        esRechazado = true;
        break;
      case 'RCT':
        mensaje = `[ERR] Rechazado por Error en Carátula: ${glosa || 'Verificar datos del emisor'}`;
        esRechazado = true;
        break;
      case 'RCH':
        mensaje = `[ERR] Rechazado: ${glosa || 'Sin detalle'}`;
        esRechazado = true;
        break;
      case 'RLV':
        mensaje = `[ERR] Rechazado: ${glosa || 'Error en documento'}`;
        esRechazado = true;
        break;
      // Códigos de schema/firma rechazados
      case 'RSC':
        mensaje = `[ERR] Rechazado por Error en Schema: ${glosa || 'XML no cumple XSD del SII'}`;
        esRechazado = true;
        break;
      case 'PDR':
        mensaje = '[...] Envío en Proceso - Validando...';
        esIntermedio = true;
        break;
      // Códigos numéricos negativos = errores del servicio de consulta SII (NO rechazo del documento)
      // Según doc SII: son errores del sistema de consulta, el documento puede estar OK
      case '-11':
        mensaje = `[...] Error de consulta SII (ERR/SQL/SRV_CODE) - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-12':
        mensaje = `[...] Error retorno consulta SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-13':
        mensaje = `[...] Error: RUT usuario nulo - Verificar autenticación`;
        esIntermedio = true;
        break;
      case '-14':
        mensaje = `[...] Error XML retorno datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-10':
        mensaje = `[...] Error validación RUT usuario - Verificar credenciales`;
        esIntermedio = true;
        break;
      case '-9':
        mensaje = `[...] Error retorno datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-8':
        mensaje = `[...] Error retorno datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-7':
        mensaje = `[...] Error retorno datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-6':
        mensaje = `[...] Error: Usuario no autorizado para consultar - Verificar credenciales`;
        esIntermedio = true;
        break;
      case '-5':
        mensaje = `[...] Error retorno datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-4':
        mensaje = `[...] Error obtención de datos SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-3':
        mensaje = `[...] Error: RUT usuario no existe en SII - Verificar autenticación`;
        esIntermedio = true;
        break;
      case '-2':
        mensaje = `[...] Error retorno SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '-1':
        mensaje = `[...] Error: Campo estado no retornado por SII - Reintente más tarde`;
        esIntermedio = true;
        break;
      case '0':
        mensaje = `[...] Enviado al SII, pendiente de validación`;
        esIntermedio = true;
        break;
      default:
        mensaje = `Estado: ${estado} - ${glosa || 'Sin descripción'}`;
    }
    
    return {
      ok: true,
      esExitoso,
      esIntermedio,
      esRechazado,
      trackId,
      estado,
      glosa,
      mensaje,
      numAtencion: numAtencionMatch ? numAtencionMatch[1] : null,
      xmlRaw: decoded,
    };
  }

  // ============================================
  // ENVÍO SOAP/DTEUpload
  // ============================================

  /**
   * Enviar EnvioBOLETA al SII via SOAP/DTEUpload
   */
  async enviarBoletaSoap(envioBoleta) {
    const { DOMParser } = require('@xmldom/xmldom');
    
    if (!this.tokenSoap) {
      log.log('Obteniendo token SOAP para DTEUpload...');
      await this.getTokenSoap();
    }

    const xml = envioBoleta.getXML();
    if (!xml) {
      throw new Error('El EnvioBoleta no tiene XML generado. Llame a generar() primero.');
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const rutEmisor = doc.getElementsByTagName('RutEmisor')[0]?.textContent;
    const rutEnvia = doc.getElementsByTagName('RutEnvia')[0]?.textContent;
    
    if (!rutEmisor || !rutEnvia) {
      throw new Error('No se pudo extraer RutEmisor o RutEnvia del XML');
    }

    const url = this.urls[this.ambiente].rcof;
    
    log.log('Enviando EnvioBOLETA via SOAP/DTEUpload...');
    log.log(' URL:', url);
    log.log(' XML Length:', xml.length, 'bytes');

    const [rutNum, dv] = rutEmisor.split('-');
    const [rutEnviaNum, dvEnvia] = rutEnvia.split('-');
    
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="rutSender"\r\n\r\n`;
    body += `${parseInt(rutEnviaNum.replace(/\./g, ''), 10)}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="dvSender"\r\n\r\n`;
    body += `${dvEnvia.toUpperCase()}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="rutCompany"\r\n\r\n`;
    body += `${parseInt(rutNum.replace(/\./g, ''), 10)}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="dvCompany"\r\n\r\n`;
    body += `${dv.toUpperCase()}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="archivo"; filename="EnvioBOLETA.xml"\r\n`;
    body += `Content-Type: text/xml\r\n\r\n`;
    body += xml;
    body += `\r\n--${boundary}--\r\n`;

    // El SII DTEUpload requiere ISO-8859-1. Convertir body a latin1 para que los bytes
    // coincidan con la declaración XML → el SII decodifica correctamente → C14N correcto.
    const bodyBuffer = Buffer.from(body, 'latin1');
    return await this._enviarMultipart(url, bodyBuffer, boundary, xml, 'EnvioBOLETA');
  }

  /**
   * Enviar EnvioDTE al SII via SOAP/DTEUpload
   */
  async enviarDteSoap(envioDte) {
    const { DOMParser } = require('@xmldom/xmldom');

    if (!this.tokenSoap) {
      log.log('Obteniendo token SOAP para DTEUpload...');
      await this.getTokenSoap();
    }

    const xml = envioDte.getXML();
    if (!xml) {
      throw new Error('El EnvioDTE no tiene XML generado. Llame a generar() primero.');
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const rutEmisor = doc.getElementsByTagName('RutEmisor')[0]?.textContent;
    const rutEnvia = doc.getElementsByTagName('RutEnvia')[0]?.textContent;

    if (!rutEmisor || !rutEnvia) {
      throw new Error('No se pudo extraer RutEmisor o RutEnvia del XML');
    }

    const url = this.urls[this.ambiente].rcof;

    const xmlBuffer = Buffer.from(xml, 'latin1');

    log.log('Enviando EnvioDTE via SOAP/DTEUpload...');
    log.log(' URL:', url);
    log.log(' XML Length:', xmlBuffer.length, 'bytes');

    const [rutNum, dv] = rutEmisor.split('-');
    const [rutEnviaNum, dvEnvia] = rutEnvia.split('-');

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const bodyParts = [];
    bodyParts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    bodyParts.push(Buffer.from('Content-Disposition: form-data; name="rutSender"\r\n\r\n', 'utf8'));
    bodyParts.push(Buffer.from(`${parseInt(rutEnviaNum.replace(/\./g, ''), 10)}\r\n`, 'utf8'));

    bodyParts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    bodyParts.push(Buffer.from('Content-Disposition: form-data; name="dvSender"\r\n\r\n', 'utf8'));
    bodyParts.push(Buffer.from(`${dvEnvia.toUpperCase()}\r\n`, 'utf8'));

    bodyParts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    bodyParts.push(Buffer.from('Content-Disposition: form-data; name="rutCompany"\r\n\r\n', 'utf8'));
    bodyParts.push(Buffer.from(`${parseInt(rutNum.replace(/\./g, ''), 10)}\r\n`, 'utf8'));

    bodyParts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    bodyParts.push(Buffer.from('Content-Disposition: form-data; name="dvCompany"\r\n\r\n', 'utf8'));
    bodyParts.push(Buffer.from(`${dv.toUpperCase()}\r\n`, 'utf8'));

    bodyParts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    bodyParts.push(Buffer.from('Content-Disposition: form-data; name="archivo"; filename="EnvioDTE.xml"\r\n', 'utf8'));
    bodyParts.push(Buffer.from('Content-Type: text/xml\r\n\r\n', 'utf8'));
    bodyParts.push(xmlBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    const body = Buffer.concat(bodyParts);

    return await this._enviarMultipartBuffer(url, body, boundary, xml, 'EnvioDTE');
  }

  /**
   * Enviar Consumo de Folios (RCOF/RVD) al SII via SOAP/CGI
   */
  async enviarConsumoFolios(consumoFolio) {
    const { DOMParser } = require('@xmldom/xmldom');
    
    if (!this.tokenSoap) {
      log.log('Obteniendo token SOAP para DTEUpload...');
      await this.getTokenSoap();
    }

    const xml = consumoFolio.getXML();
    if (!xml) {
      throw new Error('El ConsumoFolio no tiene XML generado. Llame a generar() primero.');
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const rutEmisor = doc.getElementsByTagName('RutEmisor')[0]?.textContent;
    
    if (!rutEmisor) {
      throw new Error('No se pudo extraer RutEmisor del XML');
    }

    const url = this.urls[this.ambiente].rcof;
    
    log.log('Enviando RCOF a:', url);
    log.log('XML Length:', xml.length, 'bytes');

    const [rutNum, dv] = rutEmisor.split('-');
    const [rutEnviaNum, dvEnvia] = this.certificado.rut.split('-');
    
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="rutSender"\r\n\r\n`;
    body += `${parseInt(rutEnviaNum.replace(/\./g, ''), 10)}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="dvSender"\r\n\r\n`;
    body += `${dvEnvia.toUpperCase()}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="rutCompany"\r\n\r\n`;
    body += `${parseInt(rutNum.replace(/\./g, ''), 10)}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="dvCompany"\r\n\r\n`;
    body += `${dv.toUpperCase()}\r\n`;
    
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="archivo"; filename="ConsumoFolios.xml"\r\n`;
    body += `Content-Type: text/xml\r\n\r\n`;
    body += xml;
    body += `\r\n--${boundary}--\r\n`;

    return await this._enviarMultipart(url, body, boundary, xml, 'RCOF');
  }

  /**
   * Enviar Libro (Compra/Venta o Guías) al SII via SOAP/CGI
   */
  async enviarLibro(libro, nombreArchivo = 'LibroCV.xml') {
    const { DOMParser } = require('@xmldom/xmldom');

    if (!this.tokenSoap) {
      log.log('Obteniendo token SOAP para DTEUpload...');
      await this.getTokenSoap();
    }

    const xml = libro.getXML();
    if (!xml) {
      throw new Error('El Libro no tiene XML generado. Llame a generar() primero.');
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const rutEmisor = doc.getElementsByTagName('RutEmisorLibro')[0]?.textContent
      || doc.getElementsByTagName('RutEmisor')[0]?.textContent;
    const rutEnvia = doc.getElementsByTagName('RutEnvia')[0]?.textContent;

    if (!rutEmisor || !rutEnvia) {
      throw new Error('No se pudo extraer RutEmisorLibro o RutEnvia del XML');
    }

    const url = this.urls[this.ambiente].rcof;

    const [rutNum, dv] = rutEmisor.split('-');
    const [rutEnviaNum, dvEnvia] = rutEnvia.split('-');

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    let body = '';
    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="rutSender"\r\n\r\n';
    body += `${parseInt(rutEnviaNum.replace(/\./g, ''), 10)}\r\n`;

    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="dvSender"\r\n\r\n';
    body += `${dvEnvia.toUpperCase()}\r\n`;

    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="rutCompany"\r\n\r\n';
    body += `${parseInt(rutNum.replace(/\./g, ''), 10)}\r\n`;

    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="dvCompany"\r\n\r\n';
    body += `${dv.toUpperCase()}\r\n`;

    body += `--${boundary}\r\n`;
    const fileNameLibro = nombreArchivo || 'LibroCV.xml';
    body += `Content-Disposition: form-data; name="archivo"; filename="${fileNameLibro}"\r\n`;
    body += 'Content-Type: text/xml\r\n\r\n';
    body += xml;
    body += `\r\n--${boundary}--\r\n`;

    return await this._enviarMultipart(url, body, boundary, xml, 'Libro');
  }

  // ============================================
  // HELPERS DE ENVÍO
  // ============================================

  /**
   * Enviar multipart con reintentos (unificado para string y buffer)
   * Usa isRetryableError centralizado de utils
   * 
   * @param {string} url - URL de envío
   * @param {string|Buffer} body - Body del request
   * @param {string} boundary - Boundary del multipart
   * @param {string} xml - XML original para debug
   * @param {string} tipoEnvio - Tipo de envío para logs
   * @returns {Object} Resultado del envío
   */
  async _enviarMultipart(url, body, boundary, xml, tipoEnvio) {
    const retryConfig = getConfigSection('retry');
    const maxRetries = retryConfig?.maxRetries || 8;
    const initialDelay = retryConfig?.initialDelay || 2000;
    const backoffMultiplier = retryConfig?.backoffMultiplier || 1.8;
    let lastError = null;

    // Calcular Content-Length según tipo de body
    const contentLength = Buffer.isBuffer(body) 
      ? body.length.toString() 
      : Buffer.byteLength(body).toString();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        if (attempt > 1) {
          const delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt - 2), 15000);
          log.log(` [...] Reintento ${tipoEnvio} ${attempt}/${maxRetries} (delay: ${Math.round(delay/1000)}s)...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Cookie': `TOKEN=${this.tokenSoap}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'User-Agent': 'Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)',
            'Accept': '*/*',
            'Connection': 'keep-alive',
            'Content-Length': contentLength,
          },
          body: body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const responseText = await response.text();

        const result = this._parsearRespuestaSoap(responseText, response.ok, response.status, tipoEnvio);
        
        saveEnvioArtifacts({
          xml,
          responseText,
          responseOk: response.ok,
          responseStatus: response.status,
          trackId: result.trackId,
          ambiente: this.ambiente,
          tipoEnvio,
        });

        return result;
      } catch (fetchError) {
        clearTimeout(timeout);
        lastError = fetchError;
        
        // Usar isRetryableError centralizado de utils
        if (isRetryableError(fetchError) && attempt < maxRetries) {
          log.log(` [!] Error de conexión ${tipoEnvio} (${fetchError.cause?.code || 'socket'}), reintentando...`);
          continue;
        }
        
        saveEnvioArtifacts({
          xml,
          responseText: `ERROR_FETCH: ${fetchError.message}`,
          responseOk: false,
          responseStatus: null,
          trackId: null,
          ambiente: this.ambiente,
          tipoEnvio,
          error: fetchError.cause || fetchError,
        });

        log.error('Fetch error details:', fetchError.cause || fetchError);
        throw fetchError;
      }
    }

    throw lastError || new Error(`${tipoEnvio} falló después de múltiples reintentos`);
  }

  /**
   * Alias para compatibilidad con código existente que usa _enviarMultipartBuffer
   * @deprecated Usar _enviarMultipart directamente
   */
  async _enviarMultipartBuffer(url, body, boundary, xml, tipoEnvio) {
    return this._enviarMultipart(url, body, boundary, xml, tipoEnvio);
  }

  /**
   * Parsear respuesta SOAP/CGI
   */
  _parsearRespuestaSoap(responseText, responseOk, httpStatus, tipoEnvio) {
    if (!responseOk) {
      return {
        ok: false,
        error: `Error HTTP ${httpStatus}`,
        respuesta: responseText,
      };
    }

    const statusMatch = responseText.match(/<STATUS>(\d+)<\/STATUS>/i);
    const trackIdMatch = responseText.match(/<TRACKID>(\d+)<\/TRACKID>/i);
    const fileMatch = responseText.match(/<FILE>([^<]*)<\/FILE>/i);

    const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
    const trackId = trackIdMatch ? trackIdMatch[1] : null;
    const fileName = fileMatch ? fileMatch[1] : null;

    if (status === 0 && trackId) {
      return {
        ok: true,
        status: status,
        trackId: trackId,
        archivo: fileName,
        mensaje: `[OK] ${tipoEnvio} Enviado - TrackID: ${trackId}`,
        respuesta: responseText,
      };
    }

    const errorMessages = {
      1: 'Error de autenticación',
      2: 'Error en RUT',
      3: 'Error en XML',
      4: 'Error de firma',
      5: 'Error de sistema',
      99: 'Error desconocido',
    };

    return {
      ok: false,
      status: status,
      error: errorMessages[status] || `Error del SII - Status: ${status}`,
      respuesta: responseText,
    };
  }
}

module.exports = EnviadorSII;
