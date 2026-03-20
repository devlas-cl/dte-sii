// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Certificado Digital
 * 
 * Maneja certificados PFX/P12 para firma electrónica
 */

const forge = require('node-forge');
const { 
  certError, 
  ERROR_CODES, 
  createScopedLogger,
  loadPfxFromBuffer,
  isCertificateExpired,
  getDaysUntilExpiry,
} = require('./utils');

const log = createScopedLogger('Certificado');

class Certificado {
  /**
   * @param {Buffer} pfxBuffer - Contenido del archivo .pfx/.p12
   * @param {string} password - Contraseña del certificado
   * @throws {DteSiiError} Si el certificado es inválido o la contraseña es incorrecta
   */
  constructor(pfxBuffer, password) {
    if (!pfxBuffer) {
      throw certError('PFX buffer es requerido', ERROR_CODES.CERT_INVALID);
    }
    
    if (!password) {
      throw certError('Password del certificado es requerido', ERROR_CODES.CERT_PASSWORD_WRONG);
    }

    // Usar utilidad centralizada para cargar PFX
    const pfxData = loadPfxFromBuffer(pfxBuffer, password);
    
    this.cert = pfxData.certificate;
    this.privateKey = pfxData.privateKey;
    
    // Verificar expiración usando utilidad centralizada
    if (isCertificateExpired(pfxData.notAfter)) {
      throw certError(
        `Certificado expirado el ${pfxData.notAfter.toISOString()}`,
        ERROR_CODES.CERT_EXPIRED,
        { expiresAt: pfxData.notAfter }
      );
    }
    
    // Advertir si está próximo a expirar
    const daysUntilExpiry = getDaysUntilExpiry(pfxData.notAfter);
    if (daysUntilExpiry <= 30) {
      log.warn(`⚠️ Certificado expira en ${daysUntilExpiry} días`);
    }
    
    // Usar datos extraídos por la utilidad centralizada
    this.rut = pfxData.rut;
    this.nombre = pfxData.cn;
    
    log.log('📜 Subject fields:', Object.entries(pfxData.subject).map(([k, v]) => `${k}: ${v}`).join(', '));
  }
  
  getPrivateKeyPem() {
    return forge.pki.privateKeyToPem(this.privateKey);
  }
  
  getCertificatePem() {
    return forge.pki.certificateToPem(this.cert);
  }
  
  // Alias para compatibilidad
  getPrivateKeyPEM() {
    return this.getPrivateKeyPem();
  }
  
  getCertificatePEM() {
    return this.getCertificatePem();
  }
  
  /**
   * Obtener certificado X509 en base64 (sin headers PEM)
   */
  getCertificateBase64() {
    const pem = this.getCertificatePem();
    return pem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/[\r\n\s]/g, '');
  }
  
  /**
   * Obtener Modulus de la clave pública en base64
   */
  getModulus() {
    let bytes = this.privateKey.n.toByteArray();
    if (bytes[0] === 0) bytes = bytes.slice(1);
    const str = bytes.map(b => String.fromCharCode(b < 0 ? b + 256 : b)).join('');
    return forge.util.encode64(str);
  }
  
  /**
   * Obtener Exponent de la clave pública en base64
   */
  getExponent() {
    let bytes = this.privateKey.e.toByteArray();
    if (bytes[0] === 0) bytes = bytes.slice(1);
    const str = bytes.map(b => String.fromCharCode(b < 0 ? b + 256 : b)).join('');
    return forge.util.encode64(str);
  }
  
  /**
   * Firmar datos con SHA1withRSA
   */
  sign(data, encoding = 'utf8') {
    const md = forge.md.sha1.create();
    md.update(data, encoding);
    const signature = this.privateKey.sign(md);
    return forge.util.encode64(signature);
  }
}

module.exports = Certificado;
