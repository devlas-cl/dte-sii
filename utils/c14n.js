// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Módulo de Canonicalización XML (C14N)
 * 
 * Funciones compartidas para serialización canónica de XML
 * según el estándar W3C Canonical XML Version 1.0.
 * 
 * Usado por: DTE.js, Signer.js, LibroBase.js, ConsumoFolio.js
 */

/**
 * Escapa atributos XML según C14N
 * @param {string} value - Valor del atributo
 * @returns {string} - Valor escapado
 */
function escapeAttr(value) {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/**
 * Escapa contenido de texto XML según C14N
 * @param {string} text - Contenido de texto
 * @returns {string} - Texto escapado
 */
function escapeText(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

/**
 * Corrige entidades en contenido XML (apóstrofes y comillas)
 * @param {string} xml - XML a procesar
 * @returns {string} - XML con entidades corregidas
 */
function fixEntities(xml) {
  let out = '';
  let inContent = false;
  for (let i = 0; i < xml.length; i++) {
    const ch = xml[i];
    if (ch === '>') inContent = true;
    if (ch === '<') inContent = false;
    if (inContent && ch === "'") { out += '&apos;'; continue; }
    if (inContent && ch === '"') { out += '&quot;'; continue; }
    out += ch;
  }
  return out;
}

/**
 * Serializa un nodo DOM a XML canónico
 * @param {Node} node - Nodo DOM a serializar
 * @param {Map} inheritedNs - Namespaces heredados
 * @param {Object} options - Opciones
 * @param {boolean} [options.omitNsFromChildren=false] - No incluir xmlns en hijos
 * @returns {string} - XML serializado
 */
function serializeNode(node, inheritedNs, options = {}) {
  const { omitNsFromChildren = false } = options;

  // Nodo de texto
  if (node.nodeType === 3) {
    return escapeText(node.nodeValue || '');
  }

  // Solo elementos
  if (node.nodeType !== 1) return '';

  const tagName = node.tagName || node.nodeName;
  const currentNs = new Map(inheritedNs);
  let result = `<${tagName}`;

  // Recoger y ordenar atributos
  const attrs = [];
  for (let i = 0; i < node.attributes.length; i++) {
    const attr = node.attributes[i];
    
    // Manejar namespaces
    if (attr.name.startsWith('xmlns')) {
      // Si ya está en el contexto heredado con el mismo valor, omitir
      if (currentNs.get(attr.name) === attr.value) continue;
      // Opción: omitir xmlns de hijos
      if (omitNsFromChildren && (attr.name === 'xmlns' || attr.name === 'xmlns:xsi')) continue;
      currentNs.set(attr.name, attr.value);
    }
    
    attrs.push({ name: attr.name, value: attr.value });
  }

  // Ordenar: xmlns primero, luego xmlns:*, luego otros alfabéticamente
  attrs.sort((a, b) => {
    if (a.name === 'xmlns') return -1;
    if (b.name === 'xmlns') return 1;
    const aXmlns = a.name.startsWith('xmlns:');
    const bXmlns = b.name.startsWith('xmlns:');
    if (aXmlns && !bXmlns) return -1;
    if (!aXmlns && bXmlns) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const attr of attrs) {
    result += ` ${attr.name}="${escapeAttr(attr.value)}"`;
  }
  result += '>';

  // Serializar hijos
  for (let i = 0; i < node.childNodes.length; i++) {
    result += serializeNode(node.childNodes[i], currentNs, options);
  }

  result += `</${tagName}>`;
  return result;
}

/**
 * Serializa un elemento con sus hijos para C14N (versión simplificada para Libros)
 * @param {Element} elemento - Elemento DOM
 * @param {Object} options - Opciones
 * @param {boolean} [options.omitRootNs=false] - Omitir xmlns/xmlns:xsi del elemento
 * @returns {string} - XML serializado
 */
function serializeElement(elemento, options = {}) {
  const { omitRootNs = false } = options;
  const tagName = elemento.tagName || elemento.nodeName;
  let result = `<${tagName}`;

  // Recoger y ordenar atributos
  const attrs = [];
  for (let i = 0; i < elemento.attributes.length; i++) {
    const attr = elemento.attributes[i];
    // Opcionalmente omitir xmlns del root
    if (omitRootNs && (attr.name === 'xmlns' || attr.name === 'xmlns:xsi')) continue;
    attrs.push({ name: attr.name, value: attr.value });
  }
  
  attrs.sort((a, b) => a.name.localeCompare(b.name));
  
  for (const attr of attrs) {
    result += ` ${attr.name}="${escapeAttr(attr.value)}"`;
  }
  result += '>';

  // Serializar hijos
  for (let i = 0; i < elemento.childNodes.length; i++) {
    const child = elemento.childNodes[i];
    if (child.nodeType === 1) {
      result += serializeElement(child, { omitRootNs: false });
    } else if (child.nodeType === 3) {
      result += escapeText(child.nodeValue);
    }
  }

  result += `</${tagName}>`;
  return result;
}

/**
 * Canonicaliza un elemento raíz con namespaces específicos
 * @param {Element} elemento - Elemento DOM raíz
 * @param {Object} config - Configuración
 * @param {string} config.tagName - Nombre del tag raíz
 * @param {string} config.id - ID del elemento
 * @param {string} config.xmlns - Namespace por defecto
 * @param {string} [config.xmlnsXsi] - Namespace XSI (opcional)
 * @returns {string} - XML canonicalizado
 */
function canonicalizeRoot(elemento, config) {
  const { tagName, id, xmlns, xmlnsXsi } = config;
  
  let c14n = `<${tagName}`;
  if (xmlns) c14n += ` xmlns="${xmlns}"`;
  if (xmlnsXsi) c14n += ` xmlns:xsi="${xmlnsXsi}"`;
  if (id) c14n += ` ID="${id}"`;
  c14n += '>';

  // Serializar hijos (sin heredar xmlns del padre)
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

// ============================================
// XML-DSig SignedInfo / Signature Helpers
// ============================================

/**
 * Constantes XML-DSig
 */
const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N_ALGORITHM = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1_ALGORITHM = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1_ALGORITHM = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/**
 * Construye el elemento SignedInfo para firma XML-DSig
 * @param {string} refId - ID del elemento referenciado (con o sin #)
 * @param {string} digestValue - DigestValue calculado en base64
 * @param {Object} options - Opciones de construcción
 * @param {boolean} [options.expandTags=false] - Expandir tags vacíos (para cálculo de firma)
 * @param {boolean} [options.includeXsi=true] - Incluir xmlns:xsi
 * @returns {string} - SignedInfo XML
 */
function buildSignedInfo(refId, digestValue, options = {}) {
  const { expandTags = false, includeXsi = true } = options;
  
  // Normalizar refId (agregar # si no lo tiene)
  const uri = refId.startsWith('#') ? refId : `#${refId}`;
  
  const xmlns = `xmlns="${XMLDSIG_NS}"`;
  const xsi = includeXsi ? ` xmlns:xsi="${XSI_NS}"` : '';
  
  if (expandTags) {
    // Tags expandidos: <Tag></Tag> - usado para calcular firma
    return `<SignedInfo ${xmlns}${xsi}><CanonicalizationMethod Algorithm="${C14N_ALGORITHM}"></CanonicalizationMethod><SignatureMethod Algorithm="${RSA_SHA1_ALGORITHM}"></SignatureMethod><Reference URI="${uri}"><Transforms><Transform Algorithm="${ENVELOPED_SIGNATURE}"></Transform></Transforms><DigestMethod Algorithm="${SHA1_ALGORITHM}"></DigestMethod><DigestValue>${digestValue}</DigestValue></Reference></SignedInfo>`;
  }
  
  // Tags compactos: <Tag/> - usado para guardar en XML
  return `<SignedInfo ${xmlns}${xsi}><CanonicalizationMethod Algorithm="${C14N_ALGORITHM}"/><SignatureMethod Algorithm="${RSA_SHA1_ALGORITHM}"/><Reference URI="${uri}"><Transforms><Transform Algorithm="${ENVELOPED_SIGNATURE}"/></Transforms><DigestMethod Algorithm="${SHA1_ALGORITHM}"/><DigestValue>${digestValue}</DigestValue></Reference></SignedInfo>`;
}

/**
 * Construye la Signature completa XML-DSig
 * @param {string} signedInfo - SignedInfo XML (formato compacto)
 * @param {string} signatureValue - Valor de firma en base64
 * @param {Object} keyInfo - Información de la clave
 * @param {string} keyInfo.modulus - Modulus RSA en base64
 * @param {string} keyInfo.exponent - Exponent RSA en base64
 * @param {string} keyInfo.certificate - Certificado X509 en base64
 * @returns {string} - Signature XML completa
 */
function buildSignature(signedInfo, signatureValue, keyInfo) {
  const { modulus, exponent, certificate } = keyInfo;
  
  return `<Signature xmlns="${XMLDSIG_NS}">${signedInfo}<SignatureValue>\n${signatureValue}</SignatureValue><KeyInfo><KeyValue><RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue></KeyValue><X509Data><X509Certificate>${certificate}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

module.exports = {
  // Escape/Text functions
  escapeAttr,
  escapeText,
  fixEntities,
  // Serialization
  serializeNode,
  serializeElement,
  canonicalizeRoot,
  // XML-DSig helpers
  buildSignedInfo,
  buildSignature,
  // Constantes
  XMLDSIG_NS,
  C14N_ALGORITHM,
  RSA_SHA1_ALGORITHM,
  SHA1_ALGORITHM,
  ENVELOPED_SIGNATURE,
  XSI_NS,
};
