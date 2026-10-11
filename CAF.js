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

/** Tipos cuyo CAF vence (Res. Ex. SII 58 de 2017): facturas y notas. */
const TIPOS_CAF_CON_VENCIMIENTO = [33, 46, 56, 61];
const MESES_VIGENCIA_CAF = 6;
/** Entre timbrar y que el SII reciba el envío puede pasar un rato. */
const MARGEN_VENCIMIENTO_MS = 24 * 60 * 60 * 1000;

/** Fecha de autorización más 6 meses, para los tipos que vencen; null si no aplica. */
function vencimientoCaf(tipo, fa) {
  if (!TIPOS_CAF_CON_VENCIMIENTO.includes(tipo) || !fa) return null;
  const [a, m, d] = fa.split('-').map(Number);
  // Medianoche de Chile continental: UTC-4, el más tardío.
  return new Date(Date.UTC(a, m - 1 + MESES_VIGENCIA_CAF, d, 4));
}

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

  /** Fecha de autorización del SII (`<FA>`, AAAA-MM-DD), o null si no viene. */
  getFechaAutorizacion() {
    const fa = String(this.da.FA ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(fa) ? fa : null;
  }

  /**
   * Vencimiento del CAF: fecha de autorización más 6 meses, solo para los tipos que
   * vencen (33, 46, 56, 61). null para el resto o sin fecha.
   *
   * El SII rechaza cada DTE timbrado con un CAF vencido al recibirlo:
   * `(CAF-3-517) RECHAZO- CAF Vencido : (Firma_DTE - CAF) > 6 meses`.
   * @returns {Date|null}
   */
  getVencimiento() {
    return vencimientoCaf(this.getTipoDTE(), this.getFechaAutorizacion());
  }

  /**
   * true si el CAF ya venció o vence dentro de `margenMs` (por defecto 1 día: entre
   * timbrar y que el SII reciba el envío puede pasar un rato).
   * @param {Date} [ahora]
   * @param {number} [margenMs]
   */
  estaVencido(ahora = new Date(), margenMs = MARGEN_VENCIMIENTO_MS) {
    const vence = this.getVencimiento();
    return !!vence && vence.getTime() - ahora.getTime() < margenMs;
  }

  /**
   * Lo mismo que `estaVencido`, leyendo solo `<TD>` y `<FA>` del XML, sin parsear la llave.
   * Devuelve la fecha de autorización si venció; null si sirve o no se puede leer.
   * @param {string} xml
   * @param {Date} [ahora]
   * @returns {string|null}
   */
  static vencidoDesdeXml(xml, ahora = new Date()) {
    const tipo = Number(/<TD>\s*(\d+)\s*<\/TD>/.exec(String(xml))?.[1]);
    const fa = /<FA>\s*(\d{4}-\d{2}-\d{2})\s*<\/FA>/.exec(String(xml))?.[1] ?? null;
    const vence = vencimientoCaf(tipo, fa);
    return vence && vence.getTime() - ahora.getTime() < MARGEN_VENCIMIENTO_MS ? fa : null;
  }
  
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
