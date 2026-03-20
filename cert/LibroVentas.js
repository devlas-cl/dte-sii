// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroVentas.js - Generador de Libro de Ventas para Certificación SII
 * 
 * Construye el libro de ventas a partir de los resultados del SetBasico.
 * 
 * Documentos incluidos:
 * - Facturas (33)
 * - Notas de Crédito (61)
 * - Notas de Débito (56)
 * 
 * @module dte-sii/cert/LibroVentas
 */

const { LibroCompraVenta } = require('../index');

/**
 * @typedef {Object} LibroVentasConfig
 * @property {Object} emisor - Datos del emisor
 * @property {Object} receptor - Datos del receptor (para RUTDoc/RznSoc)
 * @property {string} periodo - Período tributario (YYYY-MM)
 * @property {Object} certificado - Instancia de Certificado
 * @property {string} [signoNC='POSITIVO'] - 'POSITIVO' o 'NEGATIVO' para NC
 */

class LibroVentas {
  /**
   * @param {LibroVentasConfig} config
   */
  constructor(config) {
    this.config = config;
    this.emisor = config.emisor;
    this.receptor = config.receptor;
    this.periodo = config.periodo;
    this.certificado = config.certificado;
    this.signoNC = (config.signoNC || 'POSITIVO').toUpperCase();
  }

  /**
   * Genera el libro de ventas desde los resultados del SetBasico
   * @param {Object} setBasicoResult - Resultado de SetBasico.ejecutar()
   * @returns {Object} { libro, xml, detalle, resumen }
   */
  generar(setBasicoResult) {
    const { documentos } = setBasicoResult;
    
    if (!documentos || documentos.length === 0) {
      throw new Error('LibroVentas: No hay documentos del SetBasico para generar libro');
    }

    const fechaBase = `${this.periodo}-15`;
    const detalles = [];
    const resumenMap = new Map();

    // Procesar cada documento del set básico
    for (const doc of documentos) {
      const tipoDte = doc.tipoDte;
      const folio = doc.folio;
      const totales = doc.totales || {};

      // Calcular signo (NC puede ser negativa según configuración)
      const sign = this._getSignByTipoDte(tipoDte);

      // Construir detalle
      const detalle = {
        TpoDoc: tipoDte,
        NroDoc: folio,
        FchDoc: fechaBase,
        RUTDoc: this.receptor.rut,
        RznSoc: this.receptor.razon_social,
        MntExe: Math.round(Number(totales.MntExe || 0) * sign),
        MntNeto: Math.round(Number(totales.MntNeto || 0) * sign),
        MntIVA: Math.round(Number(totales.IVA || 0) * sign),
        MntTotal: Math.round(Number(totales.MntTotal || 0) * sign),
      };

      // Agregar TasaImp si hay IVA
      if (totales.TasaIVA !== undefined && totales.TasaIVA > 0) {
        detalle.TasaImp = Number(totales.TasaIVA);
      }

      detalles.push(detalle);

      // Acumular resumen por tipo de documento
      this._addToResumen(resumenMap, tipoDte, totales, sign);
    }

    // Convertir resumen a array
    const resumen = Array.from(resumenMap.values());

    // Crear libro
    const libro = new LibroCompraVenta(this.certificado);
    libro.setCaratula({
      RutEmisorLibro: this.emisor.rut,
      RutEnvia: this.certificado.rut || this.emisor.rut,
      PeriodoTributario: this.periodo,
      FchResol: this.emisor.fch_resol,
      NroResol: this.emisor.nro_resol,
      TipoOperacion: 'VENTA',
      TipoLibro: 'MENSUAL',
      TipoEnvio: 'TOTAL',
    });
    libro.setResumen(resumen);
    libro.setDetalle(detalles);
    libro.generar();

    return {
      libro,
      xml: libro.getXML(),
      detalle: detalles,
      resumen,
    };
  }

  /**
   * Obtiene el signo para un tipo de DTE
   * @private
   */
  _getSignByTipoDte(tipoDte) {
    // NC (61) puede tener signo negativo según configuración
    if (tipoDte === 61 && this.signoNC === 'NEGATIVO') {
      return -1;
    }
    return 1;
  }

  /**
   * Agrega totales al resumen acumulado
   * @private
   */
  _addToResumen(resumenMap, tipoDte, totales, sign) {
    if (!resumenMap.has(tipoDte)) {
      resumenMap.set(tipoDte, {
        TpoDoc: tipoDte,
        TotDoc: 0,
        TotMntExe: 0,
        TotMntNeto: 0,
        TotMntIVA: 0,
        TotMntTotal: 0,
      });
    }

    const r = resumenMap.get(tipoDte);
    r.TotDoc += 1;
    r.TotMntExe += Math.round(Number(totales.MntExe || 0) * sign);
    r.TotMntNeto += Math.round(Number(totales.MntNeto || 0) * sign);
    r.TotMntIVA += Math.round(Number(totales.IVA || 0) * sign);
    r.TotMntTotal += Math.round(Number(totales.MntTotal || 0) * sign);
  }
}

module.exports = LibroVentas;
