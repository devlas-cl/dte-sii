// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * IntercambioCert.js
 * 
 * Módulo para generar respuestas de Intercambio de Información DTE
 * - Respuesta Recepción de Envío
 * - Respuesta Aprobación Comercial (ResultadoDTE)
 * - Envío de Recibos (Recepción de Mercaderías)
 * 
 * @module dte-sii/cert/IntercambioCert
 */

const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { SignedXml } = require('xml-crypto');

const DECLARACION_RECIBO = 'El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la letra b) del Art. 4, y la letra c) del Art. 5 de la Ley 19.983, acredita que la entrega de mercaderias o servicio(s) prestado(s) ha(n) sido recibido(s).';

class IntercambioCert {
  /**
   * @param {Object} options
   * @param {Object} options.certificado - Instancia de Certificado
   * @param {Object} options.emisor - Datos del emisor { rut, razonSocial }
   * @param {Object} [options.contacto] - Datos de contacto { nombre, mail, fono }
   * @param {string} [options.debugDir] - Directorio para guardar XMLs
   */
  constructor({ certificado, emisor, contacto = {}, debugDir }) {
    this.certificado = certificado;
    this.emisor = emisor;
    this.contacto = contacto;
    this.debugDir = debugDir;
  }

  /**
   * Obtiene las utilidades del paquete
   * @private
   */
  _lib() {
    const { formatRut, normalizeArray, sanitizeSiiText } = require('../index');
    return { formatRut, normalizeArray, sanitizeSiiText };
  }

  /**
   * Formatea fecha/hora en formato SII
   * @private
   */
  _formatSiiDateTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Firma un XML con el certificado
   * @private
   */
  _signXml({ xml, referenceXpath, insertAfterXpath }) {
    const sig = new SignedXml();
    sig.privateKey = this.certificado.getPrivateKeyPem();
    sig.publicCert = this.certificado.getCertificatePem();
    sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
    sig.signatureAlgorithm = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    sig.addReference({
      xpath: referenceXpath,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    });
    sig.getKeyInfoContent = () => {
      const certBase64 = this.certificado.getCertificateBase64();
      const modulus = this.certificado.getModulus();
      const exponent = this.certificado.getExponent();
      return `<KeyValue><RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`;
    };

    sig.computeSignature(xml, {
      location: {
        reference: insertAfterXpath || referenceXpath,
        action: 'after',
      },
    });

    return sig.getSignedXml();
  }

  /**
   * Parsea un EnvioDTE XML y extrae los documentos
   * @param {string} xml - XML del EnvioDTE
   * @returns {Object} Metadatos del envío
   */
  parseEnvioDTE(xml) {
    const { normalizeArray } = this._lib();
    
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      parseTagValue: true,
    });

    const data = parser.parse(xml);
    const envio = data?.EnvioDTE || data?.EnvioDTEB || data?.EnvioDTETraslado || data?.EnvioBOLETA || {};
    const setDte = envio?.SetDTE || data?.SetDTE || {};
    const caratula = setDte?.Caratula || {};
    const setId = setDte?.['@_ID'] || setDte?.ID || 'SetDTE';

    const rutEmisor = caratula?.RutEmisor || null;
    const rutEnvia = caratula?.RutEnvia || null;
    const rutReceptor = caratula?.RutReceptor || null;

    const dtes = normalizeArray(setDte?.DTE);
    const documentos = dtes.map((dte) => dte?.Documento || dte?.DTE?.Documento || dte?.DTE?.Documento || {}).filter(Boolean);

    const items = documentos.map((doc) => {
      const encabezado = doc?.Encabezado || {};
      const idDoc = encabezado?.IdDoc || {};
      const emisor = encabezado?.Emisor || {};
      const receptor = encabezado?.Receptor || {};
      const totales = encabezado?.Totales || {};

      return {
        tipoDTE: parseInt(idDoc?.TipoDTE ?? idDoc?.TpoDoc ?? 0, 10) || 0,
        folio: parseInt(idDoc?.Folio ?? 0, 10) || 0,
        fchEmis: idDoc?.FchEmis || null,
        rutEmisor: emisor?.RUTEmisor || emisor?.RutEmisor || rutEmisor || null,
        rutRecep: receptor?.RUTRecep || receptor?.RutRecep || rutReceptor || null,
        mntTotal: parseInt(totales?.MntTotal ?? 0, 10) || 0,
      };
    });

    return {
      setId,
      rutEmisor,
      rutEnvia,
      rutReceptor,
      items,
    };
  }

  /**
   * Genera la Respuesta de Recepción de Envío
   * @param {Object} meta - Metadatos del EnvioDTE parseado
   * @param {string} [envioNombre] - Nombre del envío
   * @returns {string} XML firmado
   */
  generarRespuestaRecepcionEnvio(meta, envioNombre) {
    const { formatRut, sanitizeSiiText } = this._lib();
    const now = this._formatSiiDateTime();
    const resultId = `R_ENVIO_${Date.now()}`;
    const rutEmpresa = this.emisor.rut;

    const recepcionDte = meta.items.map((item) => {
      const ok = formatRut(item.rutRecep || '') === formatRut(rutEmpresa);
      return {
        TipoDTE: item.tipoDTE,
        Folio: item.folio,
        FchEmis: item.fchEmis,
        RUTEmisor: formatRut(item.rutEmisor || ''),
        RUTRecep: formatRut(item.rutRecep || ''),
        MntTotal: item.mntTotal,
        EstadoRecepDTE: ok ? 0 : 3,
        RecepDTEGlosa: ok ? 'DTE Recibido OK.' : 'DTE No Recibido - Error en RUT Receptor.',
      };
    });

    const data = {
      RespuestaDTE: {
        '@_xmlns': 'http://www.sii.cl/SiiDte',
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_xsi:schemaLocation': 'http://www.sii.cl/SiiDte RespuestaEnvioDTE_v10.xsd',
        '@_version': '1.0',
        Resultado: {
          '@_ID': resultId,
          Caratula: {
            '@_version': '1.0',
            RutResponde: formatRut(rutEmpresa),
            RutRecibe: formatRut(meta.rutEmisor || ''),
            IdRespuesta: 1,
            NroDetalles: 1,
            ...(this.contacto?.nombre ? { NmbContacto: sanitizeSiiText(this.contacto.nombre) } : {}),
            ...(this.contacto?.mail ? { MailContacto: this.contacto.mail } : {}),
            TmstFirmaResp: now,
          },
          RecepcionEnvio: {
            NmbEnvio: envioNombre || `ENVIO_DTE_${Date.now()}`,
            FchRecep: now,
            CodEnvio: 1,
            EnvioDTEID: meta.setId,
            RutEmisor: formatRut(meta.rutEmisor || ''),
            RutReceptor: formatRut(rutEmpresa),
            EstadoRecepEnv: 0,
            RecepEnvGlosa: 'Envío recibido conforme.',
            NroDTE: meta.items.length,
            RecepcionDTE: recepcionDte,
          },
        },
      },
    };

    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false });
    let xml = builder.build(data);
    
    xml = this._signXml({
      xml,
      referenceXpath: `//*[local-name()='Resultado' and @ID='${resultId}']`,
      insertAfterXpath: `//*[local-name()='Resultado' and @ID='${resultId}']`,
    });

    return xml;
  }

  /**
   * Genera la Respuesta de Aprobación Comercial (ResultadoDTE)
   * @param {Object} meta - Metadatos del EnvioDTE parseado
   * @returns {string} XML firmado
   */
  generarRespuestaAprobacionComercial(meta) {
    const { formatRut, sanitizeSiiText } = this._lib();
    const now = this._formatSiiDateTime();
    const resultId = `R_DTE_${Date.now()}`;
    const rutEmpresa = this.emisor.rut;

    const resultados = meta.items.map((item, idx) => {
      const ok = formatRut(item.rutRecep || '') === formatRut(rutEmpresa);
      return {
        TipoDTE: item.tipoDTE,
        Folio: item.folio,
        FchEmis: item.fchEmis,
        RUTEmisor: formatRut(item.rutEmisor || ''),
        RUTRecep: formatRut(item.rutRecep || ''),
        MntTotal: item.mntTotal,
        CodEnvio: idx + 1,
        EstadoDTE: ok ? 0 : 2,
        EstadoDTEGlosa: ok ? 'DTE Aceptado OK' : 'DTE Rechazado',
        ...(ok ? {} : { CodRchDsc: -1 }),
      };
    });

    const data = {
      RespuestaDTE: {
        '@_xmlns': 'http://www.sii.cl/SiiDte',
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_xsi:schemaLocation': 'http://www.sii.cl/SiiDte RespuestaEnvioDTE_v10.xsd',
        '@_version': '1.0',
        Resultado: {
          '@_ID': resultId,
          Caratula: {
            '@_version': '1.0',
            RutResponde: formatRut(rutEmpresa),
            RutRecibe: formatRut(meta.rutEmisor || ''),
            IdRespuesta: 1,
            NroDetalles: meta.items.length,
            ...(this.contacto?.nombre ? { NmbContacto: sanitizeSiiText(this.contacto.nombre) } : {}),
            ...(this.contacto?.mail ? { MailContacto: this.contacto.mail } : {}),
            TmstFirmaResp: now,
          },
          ResultadoDTE: resultados,
        },
      },
    };

    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false });
    let xml = builder.build(data);
    
    xml = this._signXml({
      xml,
      referenceXpath: `//*[local-name()='Resultado' and @ID='${resultId}']`,
      insertAfterXpath: `//*[local-name()='Resultado' and @ID='${resultId}']`,
    });

    return xml;
  }

  /**
   * Genera el Envío de Recibos (Recepción de Mercaderías)
   * @param {Object} meta - Metadatos del EnvioDTE parseado
   * @returns {string} XML firmado
   */
  generarEnvioRecibos(meta) {
    const { formatRut, sanitizeSiiText } = this._lib();
    const now = this._formatSiiDateTime();
    const setId = `SetRecibos_${Date.now()}`;
    const rutEmpresa = this.emisor.rut;
    const rutFirma = this.certificado.rut || rutEmpresa;

    const recibos = meta.items.map((item, idx) => {
      const docId = `REC-${idx + 1}`;
      return {
        '@_version': '1.0',
        DocumentoRecibo: {
          '@_ID': docId,
          TipoDoc: item.tipoDTE,
          Folio: item.folio,
          FchEmis: item.fchEmis,
          RUTEmisor: formatRut(item.rutEmisor || ''),
          RUTRecep: formatRut(item.rutRecep || ''),
          MntTotal: item.mntTotal,
          Recinto: 'Oficina central',
          RutFirma: formatRut(rutFirma),
          Declaracion: DECLARACION_RECIBO,
          TmstFirmaRecibo: now,
        },
      };
    });

    const data = {
      EnvioRecibos: {
        '@_xmlns': 'http://www.sii.cl/SiiDte',
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_xsi:schemaLocation': 'http://www.sii.cl/SiiDte EnvioRecibos_v10.xsd',
        '@_version': '1.0',
        SetRecibos: {
          '@_ID': setId,
          Caratula: {
            '@_version': '1.0',
            RutResponde: formatRut(rutEmpresa),
            RutRecibe: formatRut(meta.rutEmisor || ''),
            ...(this.contacto?.nombre ? { NmbContacto: sanitizeSiiText(this.contacto.nombre) } : {}),
            ...(this.contacto?.fono ? { FonoContacto: this.contacto.fono } : {}),
            ...(this.contacto?.mail ? { MailContacto: this.contacto.mail } : {}),
            TmstFirmaEnv: now,
          },
          Recibo: recibos,
        },
      },
    };

    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false });
    let xml = builder.build(data);

    // Firmar cada DocumentoRecibo
    meta.items.forEach((_, idx) => {
      const docId = `REC-${idx + 1}`;
      xml = this._signXml({
        xml,
        referenceXpath: `//*[local-name()='DocumentoRecibo' and @ID='${docId}']`,
        insertAfterXpath: `//*[local-name()='DocumentoRecibo' and @ID='${docId}']`,
      });
    });

    // Firmar SetRecibos
    xml = this._signXml({
      xml,
      referenceXpath: `//*[local-name()='SetRecibos' and @ID='${setId}']`,
      insertAfterXpath: `//*[local-name()='SetRecibos' and @ID='${setId}']`,
    });

    return xml;
  }

  /**
   * Genera todas las respuestas de intercambio
   * @param {string} envioDteXml - XML del EnvioDTE de entrada
   * @param {Object} [options]
   * @param {string} [options.envioNombre] - Nombre del envío
   * @param {string} [options.outDir] - Directorio de salida (override debugDir)
   * @returns {Object} Resultado con rutas de archivos generados
   */
  async generarIntercambio(envioDteXml, options = {}) {
    const outDir = options.outDir || this.debugDir || './debug/intercambio';
    fs.mkdirSync(outDir, { recursive: true });

    console.log('\n' + '═'.repeat(60));
    console.log('📬 INTERCAMBIO DE INFORMACIÓN DTE');
    console.log('═'.repeat(60));

    // Parsear EnvioDTE
    console.log('\n📋 Parseando EnvioDTE...');
    const meta = this.parseEnvioDTE(envioDteXml);
    
    if (!meta?.items?.length) {
      throw new Error('No se encontraron DTEs en el EnvioDTE de entrada');
    }

    console.log(`   ✓ ${meta.items.length} documentos encontrados`);
    console.log(`   ✓ Emisor: ${meta.rutEmisor}`);
    console.log(`   ✓ Receptor: ${meta.rutReceptor}`);
    
    meta.items.forEach((item, idx) => {
      console.log(`      ${idx + 1}. Tipo ${item.tipoDTE} Folio ${item.folio} - $${item.mntTotal.toLocaleString('es-CL')}`);
    });

    // Generar respuestas
    console.log('\n📝 Generando respuestas de intercambio...');

    // 1. Respuesta Recepción de Envío
    console.log('   1. Respuesta Recepción de Envío...');
    const recepcionXml = this.generarRespuestaRecepcionEnvio(meta, options.envioNombre);
    const recepcionPath = path.join(outDir, 'respuesta-recepcion-envio.xml');
    fs.writeFileSync(recepcionPath, recepcionXml, 'utf8');
    console.log(`      ✓ ${recepcionPath}`);

    // 2. Respuesta Aprobación Comercial
    console.log('   2. Respuesta Aprobación Comercial...');
    const aprobacionXml = this.generarRespuestaAprobacionComercial(meta);
    const aprobacionPath = path.join(outDir, 'respuesta-aprobacion-comercial.xml');
    fs.writeFileSync(aprobacionPath, aprobacionXml, 'utf8');
    console.log(`      ✓ ${aprobacionPath}`);

    // 3. Envío de Recibos
    console.log('   3. Envío de Recibos (Mercaderías)...');
    const recibosXml = this.generarEnvioRecibos(meta);
    const recibosPath = path.join(outDir, 'envio-recibos.xml');
    fs.writeFileSync(recibosPath, recibosXml, 'utf8');
    console.log(`      ✓ ${recibosPath}`);

    console.log('\n' + '═'.repeat(60));
    console.log('✅ INTERCAMBIO GENERADO');
    console.log('═'.repeat(60));
    console.log(`   📂 Directorio: ${outDir}`);
    console.log('   📄 Archivos generados:');
    console.log('      - respuesta-recepcion-envio.xml');
    console.log('      - respuesta-aprobacion-comercial.xml');
    console.log('      - envio-recibos.xml');

    return {
      success: true,
      outDir,
      meta,
      files: {
        recepcion: recepcionPath,
        aprobacion: aprobacionPath,
        recibos: recibosPath,
      },
    };
  }
}

module.exports = IntercambioCert;
