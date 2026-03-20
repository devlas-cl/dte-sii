// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroGuias.js - Generador de Libro de Guías para Certificación SII
 * 
 * Construye el libro de guías a partir de los resultados del SetGuia.
 * 
 * Documentos incluidos:
 * - Guías de Despacho (52)
 * 
 * El resumen (ResumenPeriodo) se genera automáticamente por LibroGuia._buildResumenPeriodo()
 * 
 * Tipos de Operación (TpoOper):
 * - 1: Venta (incluye datos de receptor y montos)
 * - 2-9: Traslados varios (sin datos comerciales)
 * 
 * Estados especiales:
 * - Anulado=1: Folio anulado (TotFolAnulado)
 * - Anulado=2: Guía anulada (TotGuiaAnulada)
 * 
 * @module dte-sii/cert/LibroGuias
 */

const { LibroGuia } = require('../index');

// Valor por defecto para certificación
const FOLIO_NOTIFICACION_DEFAULT = 3;

/**
 * @typedef {Object} LibroGuiasConfig
 * @property {Object} emisor - Datos del emisor
 * @property {Object} receptor - Datos del receptor
 * @property {string} periodo - Período tributario (YYYY-MM)
 * @property {Object} certificado - Instancia de Certificado
 * @property {number} [folioNotificacion=3] - Folio de notificación SII
 */

class LibroGuias {
  /**
   * @param {LibroGuiasConfig} config
   */
  constructor(config) {
    this.config = config;
    this.emisor = config.emisor;
    this.receptor = config.receptor;
    this.periodo = config.periodo;
    this.certificado = config.certificado;
    this.folioNotificacion = config.folioNotificacion || FOLIO_NOTIFICACION_DEFAULT;
  }

  /**
   * Genera el libro de guías desde los resultados del SetGuia
   * @param {Object} setGuiaResult - Resultado de SetGuia.ejecutar()
   * @param {Object} [options] - Opciones adicionales
   * @param {Object} [options.casosLibro] - Configuración especial por caso (anulado, operacion)
   * @returns {Object} { libro, xml, detalle }
   */
  generar(setGuiaResult, options = {}) {
    const { documentos } = setGuiaResult;
    
    if (!documentos || documentos.length === 0) {
      throw new Error('LibroGuias: No hay documentos del SetGuia para generar libro');
    }

    const casosLibro = options.casosLibro || this._getDefaultCasosLibro(documentos.length);
    const detalles = [];

    // Procesar cada documento del set guía
    for (let i = 0; i < documentos.length; i++) {
      const doc = documentos[i];
      const casoConfig = casosLibro[i] || {};
      const detalle = this._buildDetalle(doc, casoConfig);
      detalles.push(detalle);
    }

    // Crear libro (el resumen se genera automáticamente en LibroGuia._buildResumenPeriodo)
    const libro = new LibroGuia(this.certificado);
    libro.setCaratula({
      RutEmisorLibro: this.emisor.rut,
      RutEnvia: this.certificado.rut || this.emisor.rut,
      PeriodoTributario: this.periodo,
      FchResol: this.emisor.fch_resol,
      NroResol: this.emisor.nro_resol,
      TipoLibro: 'ESPECIAL',
      TipoEnvio: 'TOTAL',
      FolioNotificacion: this.folioNotificacion,
    });
    libro.setDetalle(detalles);
    libro.generar();

    return {
      libro,
      xml: libro.getXML(),
      detalle: detalles,
    };
  }

  /**
   * Configuración por defecto para casos de certificación:
   * - Caso 1 (índice 0): Normal
   * - Caso 2 (índice 1): Operacion=1 (modificación)
   * - Caso 3 (índice 2): Anulado=2 (guía anulada)
   * @private
   */
  _getDefaultCasosLibro(count) {
    const casos = [];
    for (let i = 0; i < count; i++) {
      const caso = {};
      if (i === 1) caso.operacion = 1; // Segundo caso: modificación
      if (i === 2) caso.anulado = 2;   // Tercer caso: anulado
      casos.push(caso);
    }
    return casos;
  }

  /**
   * Construye un registro de detalle desde un documento
   * @private
   */
  _buildDetalle(doc, casoConfig) {
    const totales = doc.totales || {};
    const fechaDoc = doc.fecha || `${this.periodo}-15`;
    
    // Determinar tipo de operación desde el documento o caso
    // IndTraslado=1 (venta) => TpoOper=1
    const indTraslado = doc.indTraslado || 1;
    const tpoOper = indTraslado === 1 ? 1 : indTraslado;

    const detalle = {
      Folio: doc.folio,
      TpoOper: tpoOper,
      FchDoc: fechaDoc,
    };

    // Anulado (1=folio anulado, 2=guía anulada)
    if (casoConfig.anulado) {
      detalle.Anulado = casoConfig.anulado;
      detalle.MntTotal = 0;
      // No incluir otros campos en guías anuladas
      return detalle;
    }

    // Operación (1=modificación de texto)
    if (casoConfig.operacion) {
      detalle.Operacion = casoConfig.operacion;
    }

    // Para ventas (TpoOper=1), incluir datos comerciales
    if (tpoOper === 1) {
      if (this.receptor.rut) detalle.RUTDoc = this.receptor.rut;
      if (this.receptor.razon_social) detalle.RznSoc = this.receptor.razon_social;
      
      const mntNeto = Number(totales.MntNeto || 0);
      const tasaIva = Number(totales.TasaIVA || 19);
      const iva = Number(totales.IVA || 0);
      
      if (mntNeto > 0) {
        detalle.MntNeto = mntNeto;
        detalle.TasaImp = tasaIva;
        detalle.IVA = iva > 0 ? iva : Math.round(mntNeto * (tasaIva / 100));
      }
    }

    // Monto Total
    detalle.MntTotal = Number(totales.MntTotal || 0);

    return detalle;
  }
}

module.exports = LibroGuias;
