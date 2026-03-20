// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades XML
 * 
 * Funciones para manipulación de XML en DTEs del SII
 * 
 * @module dte-sii/utils/xml
 */

const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { safeSegment } = require('./sanitize');

// ============================================
// PARSERS SINGLETON (evita múltiples instancias)
// ============================================

/**
 * Parser XML configurado para DTEs del SII
 * Configuración estándar con atributos
 */
const defaultParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: true,
});

/**
 * Parser XML con namespaces removidos
 * Útil para respuestas SOAP del SII
 */
const noNsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

/**
 * Builder XML para generar DTEs
 */
const defaultBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  suppressEmptyNode: true,
});

/**
 * Builder XML con formato (para debug)
 */
const prettyBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

// ============================================
// FUNCIONES DE PARSING CENTRALIZADAS
// ============================================

/**
 * Parsear XML con configuración estándar
 * @param {string} xml - XML a parsear
 * @returns {Object} Objeto parseado
 */
function parseXml(xml) {
  return defaultParser.parse(xml);
}

/**
 * Parsear XML removiendo namespaces (para SOAP)
 * @param {string} xml - XML a parsear
 * @returns {Object} Objeto parseado
 */
function parseXmlNoNs(xml) {
  return noNsParser.parse(xml);
}

/**
 * Construir XML desde objeto
 * @param {Object} obj - Objeto a convertir
 * @param {boolean} [pretty=false] - Si formatear con indentación
 * @returns {string} XML generado
 */
function buildXml(obj, pretty = false) {
  return pretty ? prettyBuilder.build(obj) : defaultBuilder.build(obj);
}

/**
 * Decodificar entidades HTML en XML (común en respuestas SOAP)
 * @param {string} xml - XML con entidades
 * @returns {string} XML decodificado
 */
function decodeXmlEntities(xml) {
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extraer contenido de una etiqueta XML
 * @param {string} xml - XML fuente
 * @param {string} tagName - Nombre de la etiqueta
 * @returns {string|null} Contenido o null
 */
function extractTagContent(xml, tagName) {
  const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

/**
 * Extraer valor de atributo XML
 * @param {string} xml - XML fuente
 * @param {string} tagName - Nombre de la etiqueta
 * @param {string} attrName - Nombre del atributo
 * @returns {string|null} Valor o null
 */
function extractAttribute(xml, tagName, attrName) {
  const regex = new RegExp(`<${tagName}[^>]*${attrName}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

// ============================================
// FORMATEO XML
// ============================================

/**
 * Formatear valores base64 en XML con saltos de línea cada 64 caracteres
 * Requerido por el SII para certificados y firmas
 * 
 * @param {string} xml - XML a formatear
 * @returns {string} - XML con base64 formateado
 */
function formatBase64InXml(xml) {
  const formatTag = (tagName) => {
    const regex = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g');
    return xml.replace(regex, (match, b64) => {
      const clean = b64.replace(/[\r\n\s]/g, '');
      const formatted = clean.replace(/(.{64})/g, '$1\n').trim();
      return `<${tagName}>${formatted}</${tagName}>`;
    });
  };

  xml = formatTag('SignatureValue');
  xml = formatTag('Modulus');
  xml = formatTag('X509Certificate');

  return xml;
}

/**
 * Convertir elementos autocerrados a etiquetas explícitas (requerido para C14N)
 * 
 * @param {string} xml - XML a procesar
 * @returns {string} - XML con tags expandidos
 */
function expandSelfClosingTags(xml) {
  const elements = ['CanonicalizationMethod', 'SignatureMethod', 'Transform', 'DigestMethod'];

  for (const el of elements) {
    const regex = new RegExp(`<${el}([^>]*?)/>`, 'g');
    xml = xml.replace(regex, `<${el}$1></${el}>`);
  }

  return xml;
}

/**
 * Normalizar valor a array
 * 
 * @param {*} value - Valor a normalizar
 * @returns {Array}
 */
function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

// ============================================
// METADATA EXTRACTION
// ============================================

/**
 * Extraer metadata de un XML de envío DTE
 * 
 * @param {string} xml - XML del envío
 * @returns {Object} Metadata extraída
 */
function extractEnvioMetadata(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: true,
  });

  try {
    const data = parser.parse(xml);
    const envio = data?.EnvioBOLETA || data?.EnvioDTE || data?.EnvioDTEB || data?.EnvioDTETraslado;
    const setDTE = envio?.SetDTE || data?.SetDTE || {};
    const caratula = setDTE?.Caratula || {};

    const dtes = normalizeArray(setDTE?.DTE);
    const items = dtes.map((dte) => {
      const doc = dte?.Documento || dte?.DTE?.Documento || {};
      const idDoc = doc?.Encabezado?.IdDoc || {};
      return {
        tipoDTE: idDoc?.TipoDTE?.toString?.() ?? null,
        folio: idDoc?.Folio?.toString?.() ?? null,
        fchEmis: idDoc?.FchEmis?.toString?.() ?? null,
      };
    });

    return {
      rutEmisor: caratula?.RutEmisor || null,
      rutEnvia: caratula?.RutEnvia || null,
      setId: setDTE?.['@_ID'] || setDTE?.ID || null,
      items,
    };
  } catch (error) {
    return {
      rutEmisor: null,
      rutEnvia: null,
      setId: null,
      items: [],
      parseError: error.message,
    };
  }
}

// ============================================
// HISTÓRICO Y DEBUG
// ============================================

/**
 * Guardar artefactos de envío para histórico y debug
 * 
 * @param {Object} params - Parámetros
 * @param {string} params.xml - XML del envío
 * @param {string} [params.responseText] - Respuesta del SII
 * @param {boolean} [params.responseOk] - Si la respuesta fue OK
 * @param {number} [params.responseStatus] - Status HTTP de la respuesta
 * @param {string} [params.trackId] - Track ID del envío
 * @param {string} [params.ambiente] - Ambiente (certificacion/produccion)
 * @param {string} [params.tipoEnvio] - Tipo de envío
 * @param {string} [params.error] - Error si lo hubo
 * @param {string} [params.baseDir] - Directorio base (para multi-tenant)
 */
function saveEnvioArtifacts({
  xml,
  responseText,
  responseOk,
  responseStatus,
  trackId,
  ambiente,
  tipoEnvio,
  error,
  baseDir,
}) {
  try {
    const fs = require('fs');
    const path = require('path');

    const meta = extractEnvioMetadata(xml);
    const fecha = meta.items[0]?.fchEmis || new Date().toISOString().slice(0, 10);
    const tipoDte = meta.items.length === 1 ? meta.items[0]?.tipoDTE : 'multiple';
    const folio = meta.items.length === 1 ? meta.items[0]?.folio : null;

    // Usar baseDir si se proporciona, sino raíz de static/nodejs como fallback
    const effectiveBase = baseDir || path.resolve(__dirname, '..', '..', '..');
    const historicoBaseDir = path.join(effectiveBase, 'historicos');
    const rutDir = safeSegment(meta.rutEmisor || 'sin-rut');
    const tipoDir = safeSegment(`dte-${tipoDte || 'sin-tipo'}`);
    const fechaDir = safeSegment(fecha);
    const idDir = safeSegment(trackId || meta.setId || (folio ? `folio-${folio}` : `envio-${Date.now()}`));

    const historicoDir = path.join(historicoBaseDir, rutDir, tipoDir, fechaDir, idDir);
    fs.mkdirSync(historicoDir, { recursive: true });

    fs.writeFileSync(path.join(historicoDir, 'envio.xml'), xml, 'utf-8');
    if (responseText) {
      fs.writeFileSync(path.join(historicoDir, 'respuesta.xml'), responseText, 'utf-8');
    }

    const metadata = {
      createdAt: new Date().toISOString(),
      ambiente,
      tipoEnvio,
      rutEmisor: meta.rutEmisor,
      rutEnvia: meta.rutEnvia,
      setId: meta.setId,
      items: meta.items,
      trackId: trackId || null,
      responseOk: !!responseOk,
      responseStatus: responseStatus ?? null,
      error: error ? String(error) : null,
      parseError: meta.parseError || null,
    };

    fs.writeFileSync(
      path.join(historicoDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    // Debug copy: organizar por RUT/fecha-hora de ejecución
    const debugBaseDir = process.env.CERT_RUNNER_OUT_DIR
      ? path.resolve(process.env.CERT_RUNNER_OUT_DIR)
      : path.join(effectiveBase, 'debug');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDir = path.join(debugBaseDir, rutDir, stamp);
    fs.mkdirSync(debugDir, { recursive: true });
    const debugPrefix = `${safeSegment(tipoEnvio)}-${safeSegment(tipoDte || 'sin-tipo')}`;
    fs.writeFileSync(path.join(debugDir, `envio-${debugPrefix}.xml`), xml, 'utf-8');
    if (responseText) {
      fs.writeFileSync(path.join(debugDir, `respuesta-${debugPrefix}.xml`), responseText, 'utf-8');
    }
  } catch (saveError) {
    console.warn('⚠️ No se pudo guardar histórico/debug:', saveError.message || saveError);
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Parsers singleton (para uso directo si es necesario)
  defaultParser,
  noNsParser,
  defaultBuilder,
  prettyBuilder,
  
  // Funciones de parsing
  parseXml,
  parseXmlNoNs,
  buildXml,
  decodeXmlEntities,
  extractTagContent,
  extractAttribute,
  
  // Formateo
  formatBase64InXml,
  expandSelfClosingTags,
  normalizeArray,
  extractEnvioMetadata,
  saveEnvioArtifacts,
};
