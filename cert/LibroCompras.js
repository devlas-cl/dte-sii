// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroCompras.js - Generador de Libro de Compras para Certificación SII
 * 
 * Construye el libro de compras a partir de los resultados del SetCompra.
 * 
 * Documentos incluidos:
 * - Facturas de Compra (46) con IVA Retenido Total
 * - Notas de Crédito (61)
 * - Notas de Débito (56)
 * 
 * Maneja campos especiales:
 * - IVANoRec (IVA no recuperable)
 * - IVAUsoComun (IVA de uso común con factor proporcionalidad)
 * - OtrosImp (otros impuestos)
 * - IVARetTotal (IVA retenido total)
 * 
 * @module dte-sii/cert/LibroCompras
 */

const { LibroCompraVenta } = require('../index');

// Factor de proporcionalidad para IVA de uso común (60%)
const FACTOR_PROPORCIONALIDAD = 0.6;

/**
 * @typedef {Object} LibroComprasConfig
 * @property {Object} emisor - Datos del emisor
 * @property {string} periodo - Período tributario (YYYY-MM)
 * @property {Object} certificado - Instancia de Certificado
 */

class LibroCompras {
  /**
   * @param {LibroComprasConfig} config
   */
  constructor(config) {
    this.config = config;
    this.emisor = config.emisor;
    this.periodo = config.periodo;
    this.certificado = config.certificado;
  }

  /**
   * Genera el libro de compras desde los resultados del SetCompra
   * @param {Object} setCompraResult - Resultado de SetCompra.ejecutar()
   * @returns {Object} { libro, xml, detalle, resumen }
   */
  generar(setCompraResult) {
    const { documentos } = setCompraResult;
    
    if (!documentos || documentos.length === 0) {
      throw new Error('LibroCompras: No hay documentos del SetCompra para generar libro');
    }

    const fechaBase = `${this.periodo}-15`;
    const detalles = [];

    // Procesar cada documento del set compra
    for (const doc of documentos) {
      const detalle = this._buildDetalle(doc, fechaBase);
      detalles.push(detalle);
    }

    // Calcular resumen automáticamente desde el detalle
    const resumen = this._calcularResumenDesdeDetalle(detalles);

    // Crear libro
    const libro = new LibroCompraVenta(this.certificado);
    libro.setCaratula({
      RutEmisorLibro: this.emisor.rut,
      RutEnvia: this.certificado.rut || this.emisor.rut,
      PeriodoTributario: this.periodo,
      FchResol: this.emisor.fch_resol,
      NroResol: this.emisor.nro_resol,
      TipoOperacion: 'COMPRA',
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
   * Genera el libro de compras desde los datos pre-procesados del SII (estructuras)
   * @param {Object} libroComprasData - Datos del libro de compras { detalle, resumen, factorProporcionalidad }
   * @param {string} periodo - Período tributario (YYYY-MM)
   * @returns {Object} { libro, xml, detalle, resumen }
   */
  generarDesdeEstructuras(libroComprasData, periodo) {
    const { detalle, resumen, factorProporcionalidad } = libroComprasData;
    
    if (!detalle || detalle.length === 0) {
      throw new Error('LibroCompras: No hay detalle en los datos del SII');
    }

    // Ajustar fechas al período correcto y aplicar reglas SII
    const fechaBase = `${periodo}-15`;
    const detalleAjustado = detalle.map(doc => {
      const docAjustado = {
        ...doc,
        FchDoc: fechaBase,
      };

      // Regla SII: Cuando hay IVAUsoComun, TasaImp y MntIVA van en 0
      if (doc.IVAUsoComun) {
        docAjustado.TasaImp = 0;
        docAjustado.MntIVA = 0;
      }
      // Regla SII: Cuando hay IVANoRec, TasaImp y MntIVA van en 0
      else if (doc.IVANoRec) {
        docAjustado.TasaImp = 0;
        docAjustado.MntIVA = 0;
        // SII requiere MntNeto presente (aunque sea 0) cuando hay IVANoRec — LBR-3 si falta
        if (docAjustado.MntNeto === undefined || docAjustado.MntNeto === null) {
          docAjustado.MntNeto = 0;
        }
      }
      // Caso normal: Asegurar TasaImp sea número entero (19) no decimal (0.19)
      // Si hay TasaImp pero no hay MntNeto, el SII igual exige TasaImp + MntNeto=0 + MntIVA=0 explícitos
      else if (doc.TasaImp !== undefined) {
        const tasaNum = doc.TasaImp < 1 ? Math.round(doc.TasaImp * 100) : doc.TasaImp;
        const tieneMntNeto = doc.MntNeto !== undefined && Number(doc.MntNeto) > 0;
        const tieneMntExe = doc.MntExe !== undefined && Number(doc.MntExe) > 0;
        if (tasaNum > 0 && !tieneMntNeto && tieneMntExe) {
          // Documento con TasaImp + MntExe pero sin MntNeto (p.ej. TipoDoc=30 folio exento)
          // SII exige TasaImp + MntNeto + MntIVA presentes; con MntNeto=0 da LOK+LBR-2 (aceptado)
          // Borrar los campos da LRH+LBR-3 (rechazado) — NO borrar
          docAjustado.TasaImp = tasaNum;
          docAjustado.MntNeto = 0;
          docAjustado.MntIVA = 0;
        } else if (tasaNum > 0 && !tieneMntNeto) {
          // TasaImp presente pero sin MntNeto ni MntExe: SII exige ceros explícitos
          docAjustado.TasaImp = tasaNum;
          docAjustado.MntNeto = 0;
          docAjustado.MntIVA = 0;
        } else {
          docAjustado.TasaImp = tasaNum;
        }
      }

      return docAjustado;
    });

    // Recalcular resumen desde el detalle ajustado
    const resumenRecalculado = this._calcularResumenDesdeDetalle(detalleAjustado, factorProporcionalidad);

    // Crear libro
    const libro = new LibroCompraVenta(this.certificado);
    libro.setCaratula({
      RutEmisorLibro: this.emisor.rut,
      RutEnvia: this.certificado.rut || this.emisor.rut,
      PeriodoTributario: periodo,
      FchResol: this.emisor.fch_resol,
      NroResol: this.emisor.nro_resol,
      TipoOperacion: 'COMPRA',
      TipoLibro: 'MENSUAL',
      TipoEnvio: 'TOTAL',
    });
    libro.setResumen(resumenRecalculado);
    libro.setDetalle(detalleAjustado);
    libro.generar();

    return {
      libro,
      xml: libro.getXML(),
      detalle: detalleAjustado,
      resumen: resumenRecalculado,
    };
  }

  /**
   * Construye un registro de detalle desde un documento
   * @private
   */
  _buildDetalle(doc, fechaBase) {
    const tipoDte = doc.tipoDte;
    const totales = doc.totales || {};
    
    // En Factura de Compra (46), el emisor ES el receptor del documento
    // porque nosotros RECIBIMOS la factura de compra
    const rutDoc = this.emisor.rut;
    const rznSoc = this.emisor.razon_social;

    const detalle = {
      TpoDoc: tipoDte,
      NroDoc: doc.folio,
      FchDoc: fechaBase,
      RUTDoc: rutDoc,
      RznSoc: rznSoc,
    };

    // Montos básicos
    const mntNeto = Number(totales.MntNeto || 0);
    const mntExe = Number(totales.MntExe || 0);
    const mntIva = Number(totales.IVA || 0);
    const ivaRetTotal = Number(totales.IVARetTotal || 0);
    
    if (mntExe > 0) detalle.MntExe = mntExe;
    if (mntNeto > 0) detalle.MntNeto = mntNeto;

    // Tasa de IVA - siempre informar si hay MntNeto
    const tasaIva = Number(totales.TasaIVA || 19);
    
    // IVA No Recuperable
    if (totales.IVANoRec) {
      detalle.IVANoRec = {
        CodIVANoRec: totales.IVANoRec.CodIVANoRec || 1,
        MntIVANoRec: Number(totales.IVANoRec.MntIVANoRec || 0),
      };
      // Con IVA no recuperable, TasaImp y MntIVA van en 0
      detalle.TasaImp = 0;
      detalle.MntIVA = 0;
    } else if (totales.IVAUsoComun !== undefined && totales.IVAUsoComun > 0) {
      // IVA Uso Común
      detalle.IVAUsoComun = Number(totales.IVAUsoComun);
      // Con IVA uso común, TasaImp y MntIVA van en 0
      detalle.TasaImp = 0;
      detalle.MntIVA = 0;
    } else if (mntNeto > 0) {
      // Caso normal: informar TasaImp y MntIVA
      detalle.TasaImp = tasaIva;
      detalle.MntIVA = mntIva;
    }
    
    // IVA Retenido Total (para Factura de Compra tipo 46 y sus NC/ND)
    // Se informa ADEMÁS del MntIVA, no en lugar de
    if (ivaRetTotal > 0) {
      detalle.IVARetTotal = ivaRetTotal;
    }

    // Otros Impuestos
    const otrosImpMonto = totales.OtrosImp ? Number(totales.OtrosImp.MntImp || 0) : 0;
    if (totales.OtrosImp) {
      detalle.OtrosImp = {
        CodImp: totales.OtrosImp.CodImp,
        TasaImp: totales.OtrosImp.TasaImp || 0,
        MntImp: otrosImpMonto,
      };
    }

    // Monto Total - RECALCULAR según fórmula del libro:
    // MntTotal = MntNeto + MntExe + MntIVA + IVANoRec + IVAUsoComun + OtrosImp - IVARetTotal
    const mntIvaNoRec = totales.IVANoRec ? Number(totales.IVANoRec.MntIVANoRec || 0) : 0;
    const ivaUsoComun = Number(totales.IVAUsoComun || 0);
    detalle.MntTotal = mntNeto + mntExe + mntIva + mntIvaNoRec + ivaUsoComun + otrosImpMonto - ivaRetTotal;

    return detalle;
  }

  /**
   * Calcula el RESUMEN automáticamente desde el DETALLE
   * @private
   * @param {Array} detalle - Array de documentos
   * @param {number} [factorProp] - Factor de proporcionalidad (default 0.6)
   */
  _calcularResumenDesdeDetalle(detalle, factorProp) {
    const factor = factorProp || FACTOR_PROPORCIONALIDAD;
    const resumenMap = new Map();

    for (const doc of detalle) {
      const tipo = doc.TpoDoc;

      if (!resumenMap.has(tipo)) {
        resumenMap.set(tipo, {
          TpoDoc: tipo,
          TotDoc: 0,
          TotMntExe: 0,
          TotMntNeto: 0,
          TotMntIVA: 0,
          TotMntTotal: 0,
          TotOpIVAUsoComun: 0,
          TotIVAUsoComun: 0,
          TotCredIVAUsoComun: 0,
          TotIVANoRec: {},
          TotOtrosImp: {},
          TotIVARetTotal: 0,
          TotMntNoFact: 0,
        });
      }

      const r = resumenMap.get(tipo);
      r.TotDoc += 1;
      r.TotMntExe += Number(doc.MntExe || 0);
      r.TotMntNeto += Number(doc.MntNeto || 0);
      r.TotMntIVA += Number(doc.MntIVA || 0);
      r.TotMntTotal += Number(doc.MntTotal || 0);
      r.TotMntNoFact += Number(doc.MntNoFact || 0);

      // IVA Uso Común
      if (doc.IVAUsoComun) {
        r.TotOpIVAUsoComun += 1;
        r.TotIVAUsoComun += Number(doc.IVAUsoComun);
        r.TotCredIVAUsoComun += Math.round(Number(doc.IVAUsoComun) * factor);
        r.FctProp = factor;
      }

      // IVA No Recuperable
      if (doc.IVANoRec) {
        const codIVA = doc.IVANoRec.CodIVANoRec;
        if (!r.TotIVANoRec[codIVA]) {
          r.TotIVANoRec[codIVA] = {
            CodIVANoRec: codIVA,
            TotOpIVANoRec: 0,
            TotMntIVANoRec: 0,
          };
        }
        r.TotIVANoRec[codIVA].TotOpIVANoRec += 1;
        r.TotIVANoRec[codIVA].TotMntIVANoRec += Number(doc.IVANoRec.MntIVANoRec || 0);
      }

      // Otros Impuestos
      if (doc.OtrosImp) {
        const codImp = doc.OtrosImp.CodImp;
        if (!r.TotOtrosImp[codImp]) {
          r.TotOtrosImp[codImp] = {
            CodImp: codImp,
            TotMntImp: 0,
          };
        }
        r.TotOtrosImp[codImp].TotMntImp += Number(doc.OtrosImp.MntImp || 0);
      }

      // IVA Retenido Total
      if (doc.IVARetTotal) {
        r.TotIVARetTotal += Number(doc.IVARetTotal);
      }
    }

    // Convertir a array limpio
    const resumenArray = Array.from(resumenMap.values()).map((r) => {
      const limpio = {
        TpoDoc: r.TpoDoc,
        TotDoc: r.TotDoc,
      };

      // TotMntExe siempre presente (incluso como 0)
      // TotMntNeto y TotMntIVA solo se emiten cuando son > 0:
      //   - Para docs afectos: siempre > 0 → se emiten
      //   - Para docs puramente exentos (TpoDoc=30/34/etc sin IVA): son 0
      //     y emitir <TotMntNeto>0</TotMntNeto> causa 'El Monto Neto No Cuadra'
      //     porque el SII espera que esté AUSENTE, no cero
      limpio.TotMntExe = r.TotMntExe;
      // El XSD LibroCV requiere el orden estricto: TotMntNeto → TotMntIVA → TotIVANoRec/TotOtrosImp
      // TotMntNeto y TotMntIVA son SIEMPRE requeridos por el XSD (incluso como 0)
      const tieneIVANoRec = Object.keys(r.TotIVANoRec).length > 0;
      const tieneOtrosImp = Object.keys(r.TotOtrosImp).length > 0;
      const necesitaIVAFields = tieneIVANoRec || tieneOtrosImp;
      limpio.TotMntNeto = r.TotMntNeto;
      limpio.TotMntIVA = r.TotMntIVA;
      limpio.TotMntTotal = r.TotMntTotal;

      // MntNoFact (TpoDoc=32 Liquidación-Factura)
      if (r.TotMntNoFact > 0) {
        limpio.TotMntNoFact = r.TotMntNoFact;
      }

      // IVA Uso Común
      if (r.TotOpIVAUsoComun > 0) {
        limpio.TotOpIVAUsoComun = r.TotOpIVAUsoComun;
        limpio.TotIVAUsoComun = r.TotIVAUsoComun;
        limpio.FctProp = r.FctProp;
        limpio.TotCredIVAUsoComun = r.TotCredIVAUsoComun;
      }

      // IVA No Recuperable
      const ivaNoRecArray = Object.values(r.TotIVANoRec);
      if (ivaNoRecArray.length > 0) {
        limpio.TotIVANoRec = ivaNoRecArray;
      }

      // Otros Impuestos
      const otrosImpArray = Object.values(r.TotOtrosImp);
      if (otrosImpArray.length > 0) {
        limpio.TotOtrosImp = otrosImpArray;
      }

      // IVA Retenido Total
      if (r.TotIVARetTotal > 0) {
        limpio.TotIVARetTotal = r.TotIVARetTotal;
      }

      return limpio;
    });

    return resumenArray;
  }
}

module.exports = LibroCompras;
