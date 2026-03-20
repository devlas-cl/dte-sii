// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * CertFolioHelper
 * 
 * Helper para gestión de folios en certificación.
 * Centraliza la lógica de reserva local de folios que estaba duplicada en todos los tests.
 * 
 * @module dte-sii/cert/CertFolioHelper
 */

const crypto = require('crypto');

/**
 * Clase helper para gestión de folios en certificación
 * Reemplaza las funciones locales duplicadas en cada test
 */
class CertFolioHelper {
  /**
   * @param {Object} [options] - Opciones de configuración
   * @param {string} [options.ambiente='certificacion'] - Ambiente (certificacion/produccion)
   */
  constructor(options = {}) {
    this.ambiente = options.ambiente || 'certificacion';
    this.counters = new Map(); // Contadores de folios por CAF
    this.usedFolios = new Map(); // Folios usados por tipo DTE
    this.sentFolios = new Map(); // Folios marcados como enviados
  }

  /**
   * Construye clave única para un CAF
   * @private
   */
  _buildKey({ tipoDte, folioDesde, folioHasta }) {
    return `${tipoDte}|${folioDesde}|${folioHasta}`;
  }

  /**
   * Crea fingerprint de un CAF para identificación única
   * @param {string} cafXml - XML del CAF
   * @returns {string} Hash del CAF
   */
  createCafFingerprint(cafXml) {
    if (!cafXml) return 'local';
    return crypto.createHash('sha256').update(cafXml).digest('hex').slice(0, 12);
  }

  /**
   * Reserva el siguiente folio disponible para un CAF
   * 
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE
   * @param {number} params.folioDesde - Folio inicial del CAF
   * @param {number} params.folioHasta - Folio final del CAF
   * @returns {number} Folio reservado
   * @throws {Error} Si no hay folios disponibles
   */
  reserveNextFolio({ tipoDte, folioDesde, folioHasta }) {
    const desde = Number(folioDesde);
    const hasta = Number(folioHasta);

    if (Number.isNaN(desde) || Number.isNaN(hasta)) {
      throw new Error('Parámetros inválidos para reservar folio');
    }

    const key = this._buildKey({ tipoDte, folioDesde: desde, folioHasta: hasta });
    const next = this.counters.has(key) ? this.counters.get(key) : desde;

    if (next > hasta) {
      throw new Error(`No hay más folios disponibles (${desde}-${hasta})`);
    }

    this.counters.set(key, next + 1);
    return next;
  }

  /**
   * Marca un folio como usado (para evitar reutilización)
   * 
   * @param {number} tipoDte - Tipo de DTE
   * @param {number} folio - Número de folio
   */
  markFolioUsed(tipoDte, folio) {
    if (!this.usedFolios.has(tipoDte)) {
      this.usedFolios.set(tipoDte, new Set());
    }
    this.usedFolios.get(tipoDte).add(folio);
  }

  /**
   * Verifica si un folio ya fue usado
   * 
   * @param {number} tipoDte - Tipo de DTE
   * @param {number} folio - Número de folio
   * @returns {boolean}
   */
  isFolioUsed(tipoDte, folio) {
    return this.usedFolios.get(tipoDte)?.has(folio) || false;
  }

  /**
   * Marca un folio como enviado al SII
   * 
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE
   * @param {number} params.folio - Número de folio
   * @param {string} [params.trackId] - TrackId del envío
   * @param {Object} [params.extra] - Datos adicionales
   */
  markFolioSent({ tipoDte, folio, trackId, extra }) {
    const key = `${tipoDte}|${folio}`;
    this.sentFolios.set(key, {
      tipoDte,
      folio,
      trackId,
      sentAt: new Date().toISOString(),
      ...extra,
    });
  }

  /**
   * Libera folios reservados (para cleanup en caso de error)
   * Nota: En esta implementación simple no hace nada real
   * ya que los counters son locales a la ejecución
   * 
   * @param {Object} params - Parámetros
   */
  releaseFolios(params) {
    // En certificación local, no hay necesidad de liberar
    // Esta función existe para compatibilidad con la interfaz
  }

  /**
   * Resetea contadores para un tipo de DTE específico
   * Útil cuando se solicita un nuevo CAF
   * 
   * @param {number} tipoDte - Tipo de DTE
   */
  resetCountersForTipo(tipoDte) {
    for (const [key] of this.counters) {
      if (key.startsWith(`${tipoDte}|`)) {
        this.counters.delete(key);
      }
    }
  }

  /**
   * Obtiene estadísticas de folios usados
   * 
   * @returns {Object} Estadísticas por tipo de DTE
   */
  getStats() {
    const stats = {};
    for (const [tipoDte, folios] of this.usedFolios) {
      stats[tipoDte] = {
        count: folios.size,
        folios: Array.from(folios).sort((a, b) => a - b),
      };
    }
    return stats;
  }

  /**
   * Verifica que un CAF tenga folios nuevos disponibles
   * (que no hayan sido usados en esta sesión)
   * 
   * @param {number} tipoDte - Tipo de DTE
   * @param {number} folioDesde - Folio inicial
   * @param {number} folioHasta - Folio final
   * @returns {boolean}
   */
  hasNewFolios(tipoDte, folioDesde, folioHasta) {
    const usados = this.usedFolios.get(tipoDte);
    if (!usados || usados.size === 0) return true;

    for (let f = folioDesde; f <= folioHasta; f++) {
      if (!usados.has(f)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = CertFolioHelper;
