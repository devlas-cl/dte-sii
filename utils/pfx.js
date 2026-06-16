// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * pfx.js - Loader centralizado de certificados PFX/P12
 * 
 * Centraliza la carga y extracción de certificados PFX para evitar
 * duplicación de código entre Certificado.js y SiiSession.js.
 * 
 * @module utils/pfx
 */

const fs = require('fs');
const forge = require('node-forge');
const { certError, ERROR_CODES } = require('./error');

/**
 * Resultado de cargar un PFX
 * @typedef {Object} PfxData
 * @property {forge.pki.PrivateKey} privateKey - Clave privada
 * @property {forge.pki.Certificate} certificate - Certificado
 * @property {string} privateKeyPem - Clave privada en formato PEM
 * @property {string} certificatePem - Certificado hoja en formato PEM (solo leaf, para firma XML)
 * @property {string} certificateChainPem - Cadena completa PEM: hoja → intermedios → raíz (para TLS mTLS)
 * @property {Object} subject - Campos del subject del certificado
 * @property {string} rut - RUT extraído del certificado (si existe)
 * @property {string} cn - Common Name del certificado
 * @property {Date} notBefore - Fecha de inicio de validez
 * @property {Date} notAfter - Fecha de expiración
 */

/**
 * Cargar y parsear un archivo PFX/P12 desde buffer
 * @param {Buffer} pfxBuffer - Buffer del archivo PFX
 * @param {string} password - Contraseña del PFX
 * @returns {PfxData} Datos del certificado
 * @throws {DteSiiError} Si hay error al parsear
 */
function loadPfxFromBuffer(pfxBuffer, password) {
  if (!pfxBuffer || !Buffer.isBuffer(pfxBuffer)) {
    throw certError('Buffer PFX es requerido', ERROR_CODES.CERT_INVALID);
  }

  let p12Asn1, p12;

  try {
    p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  } catch (err) {
    throw certError(`Error parseando PFX: ${err.message}`, ERROR_CODES.CERT_INVALID, { originalError: err });
  }

  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (err) {
    if (err.message.includes('Invalid password')) {
      throw certError('Contraseña del certificado incorrecta', ERROR_CODES.CERT_PASSWORD_INVALID, { originalError: err });
    }
    throw certError(`Error descifrando PFX: ${err.message}`, ERROR_CODES.CERT_INVALID, { originalError: err });
  }

  // Extraer todos los certificados y la clave privada
  const certBagsRaw = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  let keyBagRaw = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  // Fallback: keyBag sin cifrado (formato legacy)
  if (!keyBagRaw.length) {
    keyBagRaw = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  }

  if (!certBagsRaw.length) {
    throw certError('No se encontró certificado en el archivo PFX', ERROR_CODES.CERT_INVALID);
  }

  if (!keyBagRaw.length) {
    throw certError('No se encontró clave privada en el archivo PFX', ERROR_CODES.CERT_INVALID);
  }

  const allCerts = certBagsRaw.map(b => b.cert).filter(Boolean);
  const privateKey = keyBagRaw[0].key;

  // ── Identificar el certificado hoja (leaf) ───────────────────────────────
  // Estrategia 1: cert cuya clave pública coincide con la clave privada (RSA)
  let leafCert = null;
  try {
    const pubFromKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    if (pubFromKey) {
      const pubPem = forge.pki.publicKeyToPem(pubFromKey);
      leafCert = allCerts.find(c => forge.pki.publicKeyToPem(c.publicKey) === pubPem) ?? null;
    }
  } catch (_) { /* EC u otro tipo de clave */ }

  // Estrategia 2: primer cert cuyo basicConstraints no marca cA=true
  if (!leafCert) {
    leafCert = allCerts.find(c => {
      const bc = c.getExtension('basicConstraints');
      return !bc || bc.cA !== true;
    }) ?? allCerts[0];
  }

  // ── Ordenar cadena: hoja → intermedios → raíz ────────────────────────────
  // SII (palena.sii.cl) requiere la cadena completa en el TLS handshake mutuo.
  // Sin los intermedios, el servidor devuelve SSL alert 48 (unknown_ca).
  const remaining = allCerts.filter(c => c !== leafCert);
  const chain = [leafCert];
  let current = leafCert;
  while (remaining.length > 0) {
    const issuerHash = current.issuer.hash;
    const idx = remaining.findIndex(c => c.subject.hash === issuerHash);
    if (idx < 0) break;
    current = remaining.splice(idx, 1)[0];
    if (chain.includes(current)) break;
    chain.push(current);
  }
  chain.push(...remaining);

  const subject = extractSubjectFields(leafCert);
  const rut = extractRutFromCertificate(leafCert);

  return {
    privateKey,
    certificate: leafCert,
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certificatePem: forge.pki.certificateToPem(leafCert),
    certificateChainPem: chain.map(c => forge.pki.certificateToPem(c)).join(''),
    subject,
    rut,
    cn: subject.CN || null,
    notBefore: leafCert.validity.notBefore,
    notAfter: leafCert.validity.notAfter,
  };
}

/**
 * Cargar PFX desde archivo
 * @param {string} pfxPath - Ruta al archivo PFX
 * @param {string} password - Contraseña del PFX
 * @returns {PfxData} Datos del certificado
 */
function loadPfxFromFile(pfxPath, password) {
  if (!fs.existsSync(pfxPath)) {
    throw certError(`Archivo PFX no encontrado: ${pfxPath}`, ERROR_CODES.CERT_NOT_FOUND, { path: pfxPath });
  }

  const pfxBuffer = fs.readFileSync(pfxPath);
  return loadPfxFromBuffer(pfxBuffer, password);
}

/**
 * Extraer campos del subject del certificado
 * @param {forge.pki.Certificate} cert - Certificado
 * @returns {Object} Campos del subject
 */
function extractSubjectFields(cert) {
  const fields = {};
  
  if (cert.subject && cert.subject.attributes) {
    cert.subject.attributes.forEach((attr) => {
      const name = attr.shortName || attr.name;
      if (name) {
        fields[name] = attr.value;
      }
    });
  }

  return fields;
}

/**
 * Extraer RUT del certificado (desde serialNumber o CN)
 * @param {forge.pki.Certificate} cert - Certificado
 * @returns {string|null} RUT o null
 */
function extractRutFromCertificate(cert) {
  const subject = extractSubjectFields(cert);

  // Intentar desde serialNumber (más confiable)
  if (subject.serialNumber) {
    const clean = subject.serialNumber.replace(/\./g, '').toUpperCase();
    if (/^\d{7,8}-[\dK]$/.test(clean)) {
      return clean;
    }
  }

  // Intentar desde CN
  if (subject.CN) {
    const match = subject.CN.match(/(\d{7,8}-[\dK])/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Verificar si un certificado está expirado
 * @param {Date} notAfter - Fecha de expiración
 * @param {number} [marginDays=0] - Días de margen
 * @returns {boolean} True si está expirado
 */
function isCertificateExpired(notAfter, marginDays = 0) {
  const now = new Date();
  const expiry = new Date(notAfter);
  expiry.setDate(expiry.getDate() - marginDays);
  return now > expiry;
}

/**
 * Obtener días hasta expiración
 * @param {Date} notAfter - Fecha de expiración
 * @returns {number} Días hasta expiración (negativo si expirado)
 */
function getDaysUntilExpiry(notAfter) {
  const now = new Date();
  const expiry = new Date(notAfter);
  const diffMs = expiry - now;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Crear opciones TLS desde datos PFX
 * @param {PfxData} pfxData - Datos del PFX
 * @returns {Object} Opciones TLS para https/got
 */
function createTlsOptions(pfxData) {
  return {
    key: pfxData.privateKeyPem,
    cert: pfxData.certificateChainPem || pfxData.certificatePem,
    rejectUnauthorized: false,
  };
}

module.exports = {
  loadPfxFromBuffer,
  loadPfxFromFile,
  extractSubjectFields,
  extractRutFromCertificate,
  isCertificateExpired,
  getDaysUntilExpiry,
  createTlsOptions,
};
