// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * CAF (Código de Autorización de Folios)
 * 
 * Maneja los archivos CAF del SII para timbraje de documentos
 */

const forge = require('node-forge');
const { 
  cafError, 
  ERROR_CODES, 
  createScopedLogger,
  parseXml,
  buildXml,
  IDK_CERTIFICACION,
  getNombreDte,
} = require('./utils');

const log = createScopedLogger('CAF');

class CAF {
  /**
   * @param {string} xmlContent - Contenido XML del archivo CAF
   * @throws {DteSiiError} Si el CAF es inválido
   */
  constructor(xmlContent) {
    if (!xmlContent || typeof xmlContent !== 'string') {
      throw cafError('CAF XML content es requerido', ERROR_CODES.CAF_INVALID, { xmlContent });
    }
    
    // Usar parser centralizado
    try {
      this.data = parseXml(xmlContent);
    } catch (err) {
      throw cafError(`Error parseando CAF XML: ${err.message}`, ERROR_CODES.CAF_INVALID, { originalError: err });
    }

    // Validar estructura
    if (!this.data.AUTORIZACION) {
      throw cafError('CAF inválido: falta elemento AUTORIZACION', ERROR_CODES.CAF_INVALID);
    }

    this.autorizacion = this.data.AUTORIZACION;
    this.caf = this.autorizacion.CAF;
    
    if (!this.caf) {
      throw cafError('CAF inválido: falta elemento CAF', ERROR_CODES.CAF_INVALID);
    }

    this.da = this.caf.DA;
    
    if (!this.da) {
      throw cafError('CAF inválido: falta elemento DA (Datos de Autorización)', ERROR_CODES.CAF_INVALID);
    }
    
    // Propiedades principales
    this.tipo = parseInt(this.da.TD, 10);
    this.folioDesde = parseInt(this.da.RNG?.D, 10);
    this.folioHasta = parseInt(this.da.RNG?.H, 10);
    this.rutEmisor = this.da.RE;
    
    if (isNaN(this.folioDesde) || isNaN(this.folioHasta)) {
      throw cafError('CAF inválido: rango de folios no válido', ERROR_CODES.CAF_INVALID, {
        folioDesde: this.da.RNG?.D,
        folioHasta: this.da.RNG?.H,
      });
    }
    
    // Clave privada del CAF
    if (!this.autorizacion.RSASK) {
      throw cafError('CAF inválido: falta clave privada RSASK', ERROR_CODES.CAF_INVALID);
    }

    this.privateKeyPem = this.autorizacion.RSASK.trim();
    
    try {
      this.privateKey = forge.pki.privateKeyFromPem(this.privateKeyPem);
    } catch (err) {
      throw cafError(`Error cargando clave privada del CAF: ${err.message}`, ERROR_CODES.CAF_INVALID, { originalError: err });
    }
    
    // CAF XML original (el SII exige formato exacto)
    this._originalCafXml = this._extractCafXml(xmlContent);

    log.debug(`CAF cargado: Tipo ${this.tipo}, Folios ${this.folioDesde}-${this.folioHasta}`);
  }
  
  /**
   * Extraer el CAF XML exacto del archivo original
   */
  _extractCafXml(xmlContent) {
    const cafMatch = xmlContent.match(/<CAF[^>]*>[\s\S]*?<\/CAF>/);
    if (cafMatch) {
      // Normalizar: quitar espacios entre tags
      return cafMatch[0].replace(/>\s+</g, '><');
    }
    return null;
  }
  
  // Getters
  getRutEmisor() { return this.da.RE; }
  getTipoDTE() { return parseInt(this.da.TD, 10); }
  getFolioDesde() { return parseInt(this.da.RNG.D, 10); }
  getFolioHasta() { return parseInt(this.da.RNG.H, 10); }
  getIDK() { return parseInt(this.da.IDK, 10); }
  esCertificacion() { return this.getIDK() === IDK_CERTIFICACION; }
  
  /**
   * Obtener nombre del tipo de DTE
   * @param {boolean} [corto=false] - Si usar nombre corto
   * @returns {string}
   */
  getNombreTipoDTE(corto = false) {
    return getNombreDte(this.tipo, corto);
  }
  
  /**
   * Obtener CAF XML para insertar en TED
   */
  getCafXml() {
    if (this._originalCafXml) {
      return this._originalCafXml;
    }
    // Fallback: reconstruir usando builder centralizado
    return buildXml({ CAF: this.caf });
  }
  
  /**
   * Firmar datos con la clave privada del CAF (para TED)
   * IMPORTANTE: Usamos 'latin1' porque así interpreta forge los bytes
   * y debe coincidir con lo que se pasa al PDF417
   */
  sign(data) {
    const md = forge.md.sha1.create();
    md.update(data, 'latin1');
    const signature = this.privateKey.sign(md);
    return forge.util.encode64(signature);
  }
  
  /**
   * Verificar si un folio está dentro del rango autorizado
   * @param {number} folio - Número de folio
   * @returns {boolean} True si es válido
   */
  isFolioValido(folio) {
    return folio >= this.folioDesde && folio <= this.folioHasta;
  }

  /**
   * Validar folio y lanzar error si no es válido
   * @param {number} folio - Número de folio
   * @throws {DteSiiError} Si el folio está fuera de rango
   */
  validarFolio(folio) {
    if (!this.isFolioValido(folio)) {
      throw cafError(
        `Folio ${folio} fuera de rango autorizado (${this.folioDesde}-${this.folioHasta})`,
        ERROR_CODES.FOLIO_OUT_OF_RANGE,
        { folio, folioDesde: this.folioDesde, folioHasta: this.folioHasta, tipo: this.tipo }
      );
    }
  }
  
  /**
   * Obtener folios disponibles
   */
  getFoliosDisponibles() {
    return this.folioHasta - this.folioDesde + 1;
  }
}

module.exports = CAF;
