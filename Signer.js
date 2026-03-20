// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Signer (Firma XML-DSig)
 * 
 * Implementa firma XML-DSig compatible con SII usando C14N
 */

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { formatBase64InXml } = require('./utils');
const { serializeNode, fixEntities, buildSignedInfo, buildSignature } = require('./utils/c14n');

// ============================================
// CLASE SIGNER
// ============================================

class Signer {
  constructor(certificado) {
    this.certificado = certificado;
  }
  
  /**
   * Firmar un SetDTE dentro de un envío
   * @param {string} xmlSinFirma - XML del envío sin firma
   * @param {string} setId - ID del SetDTE
   * @param {string} rootTag - Tag raíz del envío (EnvioDTE, EnvioBOLETA, etc.)
   * @returns {string} - XML firmado
   */
  firmarSetDTE(xmlSinFirma, setId, rootTag) {
    const doc = new DOMParser().parseFromString(xmlSinFirma, 'application/xml');
    const setDTEC14N = this._c14nSetDTE(doc, rootTag);
    
    const digestValue = crypto.createHash('sha1')
      .update(Buffer.from(setDTEC14N, 'utf8'))
      .digest('base64');
    
    // Usar helpers centralizados de c14n
    const signedInfoParaFirmar = buildSignedInfo(setId, digestValue, { expandTags: true, includeXsi: true });
    const signedInfoParaGuardar = buildSignedInfo(setId, digestValue, { expandTags: false, includeXsi: true });
    
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(signedInfoParaFirmar);
    const signatureValue = sign.sign(this.certificado.getPrivateKeyPem(), 'base64');
    const formattedSignature = signatureValue.match(/.{1,76}/g).join('\n');
    
    const signatureXml = buildSignature(signedInfoParaGuardar, formattedSignature, {
      modulus: this.certificado.getModulus(),
      exponent: this.certificado.getExponent(),
      certificate: this.certificado.getCertificateBase64(),
    });
    
    const xmlFirmado = xmlSinFirma.replace(
      `</SetDTE></${rootTag}>`, 
      `</SetDTE>${signatureXml}</${rootTag}>`
    );
    
    return formatBase64InXml(xmlFirmado);
  }
  
// ============================================
  // CANONICALIZACIÓN (C14N)
  // ============================================
  
  /**
   * Calcular C14N del SetDTE - Usa utils/c14n.js
   */
  _c14nSetDTE(doc, rootTag) {
    const setDTE = doc.getElementsByTagName('SetDTE')[0];
    const envio = doc.getElementsByTagName(rootTag)[0];
    
    const inheritedNs = new Map();
    const defaultNs = envio.getAttribute('xmlns');
    if (defaultNs) inheritedNs.set('xmlns', defaultNs);
    const xsiNs = envio.getAttribute('xmlns:xsi');
    if (xsiNs) inheritedNs.set('xmlns:xsi', xsiNs);
    
    const id = setDTE.getAttribute('ID');
    
    let c14n = '<SetDTE';
    if (inheritedNs.has('xmlns')) c14n += ` xmlns="${inheritedNs.get('xmlns')}"`;
    if (inheritedNs.has('xmlns:xsi')) c14n += ` xmlns:xsi="${inheritedNs.get('xmlns:xsi')}"`;
    c14n += ` ID="${id}">`;
    
    for (let i = 0; i < setDTE.childNodes.length; i++) {
      c14n += serializeNode(setDTE.childNodes[i], inheritedNs);
    }
    
    c14n += '</SetDTE>';
    return fixEntities(c14n);
  }
}

module.exports = Signer;
