// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * ConsumoFolio.js
 * 
 * Genera RCOF (Resumen Consumo de Folios) para boletas electrónicas.
 * Documento requerido por SII para informar los folios de boletas utilizados.
 */

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');

class ConsumoFolio {
  constructor(certificado) {
    this.certificado = certificado;
    this.caratula = null;
    this.documentos = {
      39: [], // Boleta electrónica
      41: [], // Boleta exenta electrónica
    };
    this.xml = null;
    this.id = null;
  }

  /**
   * Establecer documentos desde objetos DTE
   */
  setDocumentos(tipo, documentos) {
    if (tipo !== 39 && tipo !== 41) {
      throw new Error('Tipo de documento debe ser 39 o 41');
    }
    this.documentos[tipo] = Array.isArray(documentos) ? documentos : [];
  }

  /**
   * Agregar documento individual
   */
  agregar(tipo, dte) {
    if (tipo !== 39 && tipo !== 41) {
      throw new Error('Tipo de documento debe ser 39 o 41');
    }
    this.documentos[tipo].push(dte);
  }

  /**
   * Agregar documentos desde un EnvioBoleta parseado
   * @param {Object} envioBoleta - Objeto con { Tipo39: [], Tipo41: [] }
   */
  agregarDesdeEnvioBoleta(envioBoleta) {
    if (envioBoleta.Tipo39) {
      for (const doc of envioBoleta.Tipo39) {
        this.agregar(39, doc);
      }
    }
    if (envioBoleta.Tipo41) {
      for (const doc of envioBoleta.Tipo41) {
        this.agregar(41, doc);
      }
    }
  }

  /**
   * Establecer carátula del RCOF
   */
  setCaratula(caratula) {
    this.caratula = { ...caratula };
    // Normalizar FchResol: DD-MM-YYYY → YYYY-MM-DD (xs:date)
    if (this.caratula.FchResol) {
      const m = String(this.caratula.FchResol).match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m) this.caratula.FchResol = `${m[3]}-${m[2]}-${m[1]}`;
    }
    this.caratula.FchInicio = this.caratula.FchInicio || this.getFechaEmisionInicial();
    this.caratula.FchFinal = this.caratula.FchFinal || this.getFechaEmisionFinal();
    // Generar TmstFirmaEnv si no viene (formato ISO 8601: YYYY-MM-DDTHH:MM:SS)
    if (!this.caratula.TmstFirmaEnv) {
      const now = new Date();
      this.caratula.TmstFirmaEnv = now.toISOString().slice(0, 19);
    }
    this.id = `RCOF_${(caratula.RutEmisor || '').replace('-', '')}_${Date.now()}`;
  }

  getFechaEmisionInicial() {
    const todas = [...this.documentos[39], ...this.documentos[41]];
    if (todas.length === 0) return null;
    
    const fechas = todas.map(d => {
      if (d.Encabezado?.IdDoc?.FchEmis) return d.Encabezado.IdDoc.FchEmis;
      if (d.FchEmis) return d.FchEmis;
      return null;
    }).filter(f => f);
    
    if (fechas.length === 0) return null;
    fechas.sort();
    return fechas[0];
  }

  getFechaEmisionFinal() {
    const todas = [...this.documentos[39], ...this.documentos[41]];
    if (todas.length === 0) return null;
    
    const fechas = todas.map(d => {
      if (d.Encabezado?.IdDoc?.FchEmis) return d.Encabezado.IdDoc.FchEmis;
      if (d.FchEmis) return d.FchEmis;
      return null;
    }).filter(f => f);
    
    if (fechas.length === 0) return null;
    fechas.sort();
    return fechas[fechas.length - 1];
  }

  /**
   * Obtener resumen por tipo de documento
   */
  getResumen() {
    const resumenes = [];
    
    for (const tipo of [39, 41]) {
      const docs = this.documentos[tipo];
      if (docs.length === 0) continue;
      
      const resumen = {
        TipoDocumento: tipo,
        MntNeto: 0,
        MntIva: 0,
        TasaIVA: 19,
        MntExento: 0,
        MntTotal: 0,
        FoliosEmitidos: docs.length,
        FoliosAnulados: 0,
        FoliosUtilizados: docs.length,
        RangoUtilizados: this.getRangos(docs),
      };
      
      for (const doc of docs) {
        const totales = doc.Encabezado?.Totales || doc;
        resumen.MntNeto += totales.MntNeto || 0;
        resumen.MntIva += totales.IVA || 0;
        resumen.MntExento += totales.MntExe || 0;
        resumen.MntTotal += totales.MntTotal || 0;
      }
      
      // Boleta exenta no tiene IVA
      if (tipo === 41) {
        resumen.MntNeto = 0;
        resumen.MntIva = 0;
        resumen.TasaIVA = 0;
      }
      
      resumenes.push(resumen);
    }
    
    return resumenes;
  }

  /**
   * Obtener rangos de folios utilizados
   */
  getRangos(docs) {
    const folios = docs.map(d => {
      if (d.Encabezado?.IdDoc?.Folio) return d.Encabezado.IdDoc.Folio;
      if (d.Folio) return d.Folio;
      return null;
    }).filter(f => f !== null).sort((a, b) => a - b);
    
    if (folios.length === 0) return [];
    
    const rangos = [];
    let inicio = folios[0];
    let fin = folios[0];
    
    for (let i = 1; i < folios.length; i++) {
      if (folios[i] === fin + 1) {
        fin = folios[i];
      } else {
        rangos.push({ Inicial: inicio, Final: fin });
        inicio = folios[i];
        fin = folios[i];
      }
    }
    rangos.push({ Inicial: inicio, Final: fin });
    
    return rangos;
  }

  /**
   * Generar XML del Consumo de Folios
   * Genera XML SIN indentación para C14N consistente
   */
  generar() {
    if (!this.caratula) {
      throw new Error('Debe establecer la carátula antes de generar');
    }

    const resumenes = this.getResumen();
    
    // Construir XML de resúmenes SIN indentación (para C14N limpio)
    let resumenXml = '';
    for (const r of resumenes) {
      resumenXml += '<Resumen>';
      resumenXml += `<TipoDocumento>${r.TipoDocumento}</TipoDocumento>`;
      
      if (r.MntNeto) resumenXml += `<MntNeto>${r.MntNeto}</MntNeto>`;
      if (r.MntIva) resumenXml += `<MntIva>${r.MntIva}</MntIva>`;
      if (r.TasaIVA) resumenXml += `<TasaIVA>${r.TasaIVA}</TasaIVA>`;
      if (r.MntExento) resumenXml += `<MntExento>${r.MntExento}</MntExento>`;
      
      resumenXml += `<MntTotal>${r.MntTotal}</MntTotal>`;
      resumenXml += `<FoliosEmitidos>${r.FoliosEmitidos}</FoliosEmitidos>`;
      resumenXml += `<FoliosAnulados>${r.FoliosAnulados}</FoliosAnulados>`;
      resumenXml += `<FoliosUtilizados>${r.FoliosUtilizados}</FoliosUtilizados>`;
      
      if (r.RangoUtilizados && r.RangoUtilizados.length > 0) {
        for (const rango of r.RangoUtilizados) {
          resumenXml += '<RangoUtilizados>';
          resumenXml += `<Inicial>${rango.Inicial}</Inicial>`;
          resumenXml += `<Final>${rango.Final}</Final>`;
          resumenXml += '</RangoUtilizados>';
        }
      }
      
      resumenXml += '</Resumen>';
    }

    // Construir XML SIN indentación para C14N consistente
    const schemaLoc = 'http://www.sii.cl/SiiDte ConsumoFolio_v10.xsd';
    const xmlSinFirma = `<?xml version="1.0" encoding="UTF-8"?>
<ConsumoFolios xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${schemaLoc}" version="1.0"><DocumentoConsumoFolios ID="${this.id}"><Caratula version="1.0"><RutEmisor>${this.caratula.RutEmisor}</RutEmisor><RutEnvia>${this.caratula.RutEnvia}</RutEnvia><FchResol>${this.caratula.FchResol}</FchResol><NroResol>${this.caratula.NroResol}</NroResol><FchInicio>${this.caratula.FchInicio}</FchInicio><FchFinal>${this.caratula.FchFinal}</FchFinal><SecEnvio>${this.caratula.SecEnvio}</SecEnvio><TmstFirmaEnv>${this.caratula.TmstFirmaEnv}</TmstFirmaEnv></Caratula>${resumenXml}</DocumentoConsumoFolios></ConsumoFolios>`;

    // Firmar el documento
    this.xml = this.firmar(xmlSinFirma);
    return this.xml;
  }

  /**
   * Firmar el XML del Consumo de Folios
   * 
   * Estrategia: usar C14N con namespaces heredados como PHP DOMElement::C14N()
   */
  firmar(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    
    // Obtener el elemento a firmar
    const documentoConsumoFolios = doc.getElementsByTagName('DocumentoConsumoFolios')[0];
    
    // Obtener namespace del padre (ConsumoFolios)
    const root = doc.getElementsByTagName('ConsumoFolios')[0];
    const nsDefault = root.getAttribute('xmlns') || 'http://www.sii.cl/SiiDte';
    
    // Calcular C14N manual (incluye namespace heredado como PHP)
    const c14nDocumento = this._c14nDocumentoConsumoFolios(documentoConsumoFolios, nsDefault);
    
    console.log('🔍 C14N Length:', c14nDocumento.length);
    console.log('🔍 C14N primeros 300 chars:', c14nDocumento.substring(0, 300));
    
    // Calcular DigestValue = base64(sha1(C14N))
    const digest = crypto.createHash('sha1').update(c14nDocumento).digest('base64');
    console.log('🔍 DigestValue:', digest);

    // Construir SignedInfo (con tags expandidos para firmar)
    // PHP incluye xmlns:xsi en SignedInfo para ConsumoFolio
    const signedInfoParaFirmar = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#${this.id}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

    // Firmar SignedInfo con RSA-SHA1
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(signedInfoParaFirmar);
    const signatureValue = sign.sign(this.certificado.getPrivateKeyPem(), 'base64');
    const formattedSignatureValue = signatureValue.match(/.{1,76}/g).join('\n');

    // Obtener datos del certificado
    const certBase64 = this.certificado.getCertificatePem()
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s/g, '');
    const modulus = this.certificado.getModulus();
    const exponent = this.certificado.getExponent();

    // Construir Signature (con self-closing tags para guardar)
    const signedInfoParaGuardar = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#${this.id}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

    const signatureXml = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfoParaGuardar}<SignatureValue>\n${formattedSignatureValue}</SignatureValue><KeyInfo><KeyValue><RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo></Signature>`;

    // Insertar firma DESPUÉS de DocumentoConsumoFolios, ANTES del cierre de ConsumoFolios
    const xmlFirmado = xml.replace('</DocumentoConsumoFolios></ConsumoFolios>', `</DocumentoConsumoFolios>${signatureXml}</ConsumoFolios>`);
    
    return xmlFirmado;
  }

  /**
   * Calcular C14N del DocumentoConsumoFolios
   * 
   * PHP DOMElement::C14N() incluye TODOS los namespaces en ámbito (in-scope),
   * no solo los que están en uso directo.
   */
  _c14nDocumentoConsumoFolios(elemento, nsDefault) {
    const id = elemento.getAttribute('ID');
    
    // Construir apertura con AMBOS namespaces heredados (como PHP C14N)
    let c14n = `<DocumentoConsumoFolios`;
    c14n += ` xmlns="${nsDefault}"`;
    c14n += ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    c14n += ` ID="${id}">`;
    
    // Serializar contenido recursivamente
    for (let i = 0; i < elemento.childNodes.length; i++) {
      const child = elemento.childNodes[i];
      if (child.nodeType === 1) { // Element
        c14n += this._serializeElementForC14N(child);
      } else if (child.nodeType === 3) { // Text
        c14n += this._escapeXmlText(child.nodeValue);
      }
    }
    
    c14n += '</DocumentoConsumoFolios>';
    return c14n;
  }

  /**
   * Serializar elemento para C14N (sin repetir namespaces del padre)
   */
  _serializeElementForC14N(elemento) {
    const tagName = elemento.tagName || elemento.nodeName;
    let result = `<${tagName}`;
    
    // Agregar atributos (excepto xmlns que ya está en el padre)
    const attrs = [];
    for (let i = 0; i < elemento.attributes.length; i++) {
      const attr = elemento.attributes[i];
      if (attr.name !== 'xmlns' && attr.name !== 'xmlns:xsi') {
        attrs.push({ name: attr.name, value: attr.value });
      }
    }
    // Ordenar atributos alfabéticamente (requisito C14N)
    attrs.sort((a, b) => a.name.localeCompare(b.name));
    for (const attr of attrs) {
      result += ` ${attr.name}="${this._escapeXmlAttr(attr.value)}"`;
    }
    
    result += '>';
    
    // Serializar hijos
    for (let i = 0; i < elemento.childNodes.length; i++) {
      const child = elemento.childNodes[i];
      if (child.nodeType === 1) {
        result += this._serializeElementForC14N(child);
      } else if (child.nodeType === 3) {
        result += this._escapeXmlText(child.nodeValue);
      }
    }
    
    result += `</${tagName}>`;
    return result;
  }

  _escapeXmlText(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _escapeXmlAttr(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  getXML() {
    return this.xml;
  }
}

module.exports = ConsumoFolio;
