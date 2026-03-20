// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroBase.js
 * 
 * Clase base para libros electrónicos (LibroCompraVenta, LibroGuia).
 * Contiene lógica común de C14N, firma digital y serialización XML.
 */

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { serializeElement, escapeText, escapeAttr } = require('./utils/c14n');

class LibroBase {
  constructor(certificado) {
    this.certificado = certificado;
    this.caratula = null;
    this.resumen = [];
    this.detalle = [];
    this.xml = null;
    this.id = null;
  }

  setResumen(resumen) {
    this.resumen = Array.isArray(resumen) ? resumen : [];
  }

  setDetalle(detalle) {
    this.detalle = Array.isArray(detalle) ? detalle : [];
  }

  /**
   * Firma el XML del libro.
   * Método genérico que puede ser usado por subclases.
   * 
   * @param {string} xml - XML sin firmar
   * @param {string} envioTagName - Nombre del tag de envío (ej: 'EnvioLibro')
   * @param {string} rootTagName - Nombre del tag raíz (ej: 'LibroCompraVenta', 'LibroGuia')
   * @returns {string} - XML firmado
   */
  firmar(xml, envioTagName = 'EnvioLibro', rootTagName = null) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const envioLibro = doc.getElementsByTagName(envioTagName)[0];
    
    // Detectar rootTagName si no se proporciona
    const detectedRootTagName = rootTagName || doc.documentElement.tagName;
    const root = doc.getElementsByTagName(detectedRootTagName)[0];
    const nsDefault = root.getAttribute('xmlns') || 'http://www.sii.cl/SiiDte';

    const c14nEnvio = this._c14nEnvioLibro(envioLibro, nsDefault, envioTagName);
    const digest = crypto.createHash('sha1').update(c14nEnvio).digest('base64');

    const signedInfoParaFirmar = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#${this.id}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

    const sign = crypto.createSign('RSA-SHA1');
    sign.update(signedInfoParaFirmar);
    const signatureValue = sign.sign(this.certificado.getPrivateKeyPem(), 'base64');
    const formattedSignatureValue = signatureValue.match(/.{1,76}/g).join('\n');

    const certBase64 = this.certificado.getCertificatePem()
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s/g, '');
    const modulus = this.certificado.getModulus();
    const exponent = this.certificado.getExponent();

    const signedInfoParaGuardar = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#${this.id}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

    const signatureXml = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfoParaGuardar}<SignatureValue>\n${formattedSignatureValue}</SignatureValue><KeyInfo><KeyValue><RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo></Signature>`;

    // Insertar firma antes del cierre del root tag
    const closeTag = `</${envioTagName}></${detectedRootTagName}>`;
    const closeTagWithSignature = `</${envioTagName}>${signatureXml}</${detectedRootTagName}>`;
    
    // Manejar variaciones de formato (con/sin espacios)
    return xml
      .replace(new RegExp(`</${envioTagName}>\\s*</${detectedRootTagName}>`), closeTagWithSignature);
  }

  /**
   * Canonicaliza un elemento de envío de libro - Usa utils/c14n.js
   */
  _c14nEnvioLibro(elemento, nsDefault, tagName = 'EnvioLibro') {
    const id = elemento.getAttribute('ID');
    let c14n = `<${tagName}`;
    c14n += ` xmlns="${nsDefault}"`;
    c14n += ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    c14n += ` ID="${id}">`;

    for (let i = 0; i < elemento.childNodes.length; i++) {
      const child = elemento.childNodes[i];
      if (child.nodeType === 1) {
        c14n += serializeElement(child, { omitRootNs: true });
      } else if (child.nodeType === 3) {
        c14n += escapeText(child.nodeValue);
      }
    }

    c14n += `</${tagName}>`;
    return c14n;
  }

  getXML() {
    return this.xml;
  }

  /**
   * Escapa texto XML (método de conveniencia para subclases)
   * Usa la función centralizada de utils/c14n.js
   */
  _escapeXmlText(text) {
    return escapeText(text);
  }

  /**
   * Escapa atributos XML (método de conveniencia para subclases)
   * Usa la función centralizada de utils/c14n.js
   */
  _escapeXmlAttr(text) {
    return escapeAttr(text);
  }

  /**
   * Obtener timestamp de firma en formato ISO
   */
  _getTmstFirma() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
}

module.exports = LibroBase;
