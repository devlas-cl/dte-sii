// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Utilidades de Cálculo
 * 
 * Funciones centralizadas para cálculo de totales y construcción de detalle DTE.
 * Estas funciones son reutilizables tanto en certificación como en producción.
 * 
 * @module dte-sii/utils/calculo
 */

// Usar la constante centralizada de constants.js
const { TASA_IVA } = require('./constants');

// Alias para compatibilidad con código existente
const TASA_IVA_DEFAULT = TASA_IVA;

// ============================================
// FORMATEO
// ============================================

/**
 * Formatea un número con decimales fijos
 * @param {number} value - Valor a formatear
 * @param {number} [decimals=6] - Cantidad de decimales
 * @returns {string}
 */
function formatDecimal(value, decimals = 6) {
  return Number(value).toFixed(decimals);
}

/**
 * Calcula el monto de un ítem con descuento
 * @param {number} cantidad - Cantidad de unidades
 * @param {number} precio - Precio unitario
 * @param {number} [descuentoPct=0] - Porcentaje de descuento
 * @returns {{ base: number, descuentoMonto: number, montoItem: number }}
 */
function calcularMontoItem(cantidad, precio, descuentoPct = 0) {
  const qty = Number(cantidad || 1);
  const prc = Number(precio || 0);
  const base = Math.round(qty * prc);
  const descuentoMonto = descuentoPct > 0 ? Math.round(base * (descuentoPct / 100)) : 0;
  const montoItem = base - descuentoMonto;
  return { base, descuentoMonto, montoItem };
}

// ============================================
// CÁLCULO DE TOTALES
// ============================================

/**
 * Calcula totales desde un array de items
 * Función unificada que maneja todos los tipos de DTE
 * 
 * @param {Array} items - Array de items con { cantidad, precio, exento?, descuentoPct? }
 * @param {Object} [options] - Opciones de cálculo
 * @param {number} [options.tasaIva=19] - Tasa de IVA
 * @param {number} [options.descuentoGlobalPct=0] - Descuento global en porcentaje
 * @param {boolean} [options.preciosNetos=true] - Si los precios son netos (sin IVA)
 * @param {boolean} [options.soloExento=false] - Si el documento es solo exento (ej: tipo 34)
 * @param {boolean} [options.conRetencion=false] - Si aplica retención total IVA (ej: tipo 46)
 * @param {number} [options.tipoImpRetencion=15] - Tipo de impuesto para retención
 * @returns {{ totales: Object, descuentoGlobalMonto: number }}
 */
function calcularTotalesDesdeItems(items, optionsOrDescuento = {}) {
  // Compatibilidad: si el segundo parámetro es número, es descuentoGlobalPct (API antigua)
  const options = typeof optionsOrDescuento === 'number' || optionsOrDescuento === null
    ? { descuentoGlobalPct: optionsOrDescuento || 0 }
    : (optionsOrDescuento || {});

  const {
    tasaIva = TASA_IVA_DEFAULT,
    descuentoGlobalPct = 0,
    preciosNetos = true,
    soloExento = false,
    conRetencion = false,
    tipoImpRetencion = 15,
  } = options;

  let mntAfecto = 0;
  let mntExento = 0;

  (items || []).forEach((item) => {
    const { montoItem } = calcularMontoItem(
      item.cantidad,
      item.precio,
      item.descuentoPct
    );

    if (item.exento || soloExento) {
      mntExento += montoItem;
    } else {
      mntAfecto += montoItem;
    }
  });

  // Aplicar descuento global solo a afectos
  const descuentoGlobalMonto = descuentoGlobalPct > 0
    ? Math.round(mntAfecto * (descuentoGlobalPct / 100))
    : 0;

  // Calcular neto
  let mntNeto;
  if (preciosNetos) {
    mntNeto = Math.max(0, mntAfecto - descuentoGlobalMonto);
  } else {
    // Precios incluyen IVA - extraer neto
    const afectoNeto = mntAfecto - descuentoGlobalMonto;
    mntNeto = afectoNeto > 0 ? Math.round(afectoNeto / (1 + (tasaIva / 100))) : 0;
  }

  // Calcular IVA
  const iva = mntNeto > 0 ? Math.round(mntNeto * (tasaIva / 100)) : 0;

  // Calcular total
  // Con retención: MntTotal = MntNeto + MntExe (IVA se cancela con retención)
  // Sin retención: MntTotal = MntNeto + IVA + MntExe
  const mntTotal = conRetencion
    ? mntNeto + mntExento
    : mntNeto + iva + mntExento;

  // Construir objeto de totales en orden SII
  const totales = {};
  if (mntNeto > 0) totales.MntNeto = mntNeto;
  if (mntExento > 0) totales.MntExe = mntExento;
  if (mntNeto > 0) totales.TasaIVA = tasaIva;
  if (mntNeto > 0) totales.IVA = iva;

  // Retención de IVA (para Factura de Compra tipo 46)
  if (conRetencion && iva > 0) {
    totales.ImptoReten = [{
      TipoImp: tipoImpRetencion,
      TasaImp: tasaIva,
      MontoImp: iva,
    }];
  }

  totales.MntTotal = mntTotal;

  return { totales, descuentoGlobalMonto };
}

/**
 * Calcula totales desde un array de detalle ya construido
 * Útil para Guías de Despacho y otros casos donde el detalle ya está armado
 * 
 * @param {Array} detalle - Array de líneas de detalle con { MontoItem, IndExe? }
 * @param {Object} [options] - Opciones de cálculo
 * @param {number} [options.tasaIva=19] - Tasa de IVA
 * @param {boolean} [options.preciosNetos=true] - Si los precios son netos
 * @param {boolean} [options.conRetencion=false] - Si aplica retención de IVA
 * @param {boolean} [options.sinValores=false] - Si es traslado sin valores (IndTraslado=5)
 * @returns {Object} Totales para el DTE
 */
function calcularTotalesDesdeDetalle(detalle, options = {}) {
  const {
    tasaIva = TASA_IVA_DEFAULT,
    preciosNetos = true,
    conRetencion = false,
    sinValores = false,
  } = options;

  // Traslado sin valores
  if (sinValores) {
    return { TasaIVA: tasaIva, MntTotal: 0 };
  }

  let mntBruto = 0;
  let mntExento = 0;

  (detalle || []).forEach((det) => {
    const monto = Number(det.MontoItem || 0);
    if (det.IndExe === 1) {
      mntExento += monto;
    } else {
      mntBruto += monto;
    }
  });

  if (mntBruto === 0 && mntExento === 0) {
    return { TasaIVA: tasaIva, MntTotal: 0 };
  }

  const mntNeto = preciosNetos
    ? mntBruto
    : (mntBruto > 0 ? Math.round(mntBruto / (1 + (tasaIva / 100))) : 0);

  const iva = mntNeto > 0 ? Math.round(mntNeto * (tasaIva / 100)) : 0;

  const mntTotal = conRetencion
    ? mntNeto + mntExento
    : mntNeto + iva + mntExento;

  const totales = {};
  if (mntNeto > 0) totales.MntNeto = mntNeto;
  if (mntExento > 0) totales.MntExe = mntExento;
  if (mntNeto > 0) totales.TasaIVA = tasaIva;
  if (mntNeto > 0) totales.IVA = iva;

  if (conRetencion && iva > 0) {
    totales.ImptoReten = [{
      TipoImp: 15,
      TasaImp: tasaIva,
      MontoImp: iva,
    }];
  }

  totales.MntTotal = mntTotal;

  return totales;
}

// ============================================
// CONSTRUCCIÓN DE DETALLE
// ============================================

/**
 * Construye array de detalle para DTE desde items
 * Función unificada que maneja todos los tipos de documentos
 * 
 * @param {Array} items - Items con { nombre, cantidad?, precio?, unidad?, exento?, descuentoPct? }
 * @param {Object} [options] - Opciones de construcción
 * @param {boolean} [options.allowIndExe=true] - Agregar IndExe=1 para items exentos (default: true para compatibilidad)
 * @param {number} [options.codImpAdic=null] - Código de impuesto adicional (ej: 15 para F. Compra)
 * @param {boolean} [options.forcePriced=false] - Forzar QtyItem/PrcItem aunque precio sea 0
 * @param {boolean} [options.includeUnidad=false] - Incluir UnmdItem siempre
 * @param {Function} [options.sanitize=null] - Función para sanitizar texto
 * @returns {Array} Detalle formateado para DTE
 */
function buildDetalle(items, options = {}) {
  const {
    allowIndExe = true, // Por defecto true para mantener compatibilidad con código original
    codImpAdic = null,
    forcePriced = false,
    includeUnidad = false,
    sanitize = (v) => String(v || '').trim(),
  } = options;

  return (items || []).map((item, idx) => {
    const qty = Number(item.cantidad ?? 1);
    const prc = Number(item.precio ?? 0);
    const descuentoPct = Number(item.descuentoPct || 0);
    const nombreItem = sanitize(item.nombre);

    const { base, descuentoMonto, montoItem } = calcularMontoItem(qty, prc, descuentoPct);

    // Construir línea de detalle en orden del schema SII
    const det = {
      NroLinDet: idx + 1,
    };

    // IndExe antes de NmbItem
    if (allowIndExe && item.exento) {
      det.IndExe = 1;
    }

    det.NmbItem = nombreItem;

    // QtyItem, UnmdItem, PrcItem
    if (prc > 0 || forcePriced) {
      det.QtyItem = qty;
      if (item.unidad || includeUnidad) {
        det.UnmdItem = item.unidad || 'UN';
      }
      det.PrcItem = prc > 0 ? formatDecimal(Math.max(0.000001, prc)) : prc;

      // Descuento por línea
      if (descuentoPct > 0) {
        det.DescuentoPct = descuentoPct;
        det.DescuentoMonto = descuentoMonto;
      }
    }

    // CodImpAdic (antes de MontoItem según schema)
    if (codImpAdic && !item.exento) {
      det.CodImpAdic = codImpAdic;
    }

    det.MontoItem = montoItem;

    return det;
  });
}

/**
 * Construye detalle para Guía de Despacho
 * Similar a buildDetalle pero con lógica específica para guías
 * 
 * @param {Array} items - Items de la guía
 * @param {Object} [options] - Opciones
 * @returns {Array} Detalle formateado
 */
function buildDetalleGuia(items, options = {}) {
  const { sanitize = (v) => String(v || '').trim() } = options;

  return (items || []).map((item, idx) => {
    const qty = Number(item.cantidad ?? 1);
    const prc = item.precio !== undefined && item.precio !== null ? Number(item.precio) : null;
    const monto = prc !== null ? Math.round(qty * prc) : (item.monto ?? undefined);

    // Orden XSD: NroLinDet, CdgItem?, IndExe?, NmbItem, DscItem?, QtyRef?, UnmdRef?, PrcRef?, QtyItem?, UnmdItem?, PrcItem?, MontoItem?
    const det = {
      NroLinDet: idx + 1,
    };

    // IndExe va ANTES de NmbItem según XSD
    if (item.exento) {
      det.IndExe = 1;
    }

    det.NmbItem = sanitize(item.nombre);
    det.QtyItem = qty;
    det.UnmdItem = item.unidad || 'UN';

    if (prc !== null && prc > 0) {
      det.PrcItem = prc;
    }

    if (monto !== undefined) {
      det.MontoItem = monto;
    }

    return det;
  });
}

/**
 * Construye detalle para Factura de Compra (tipo 46)
 * Similar a buildDetalle pero siempre incluye unidad y soporta CodImpAdic
 * 
 * @param {Array} items - Items de la factura de compra
 * @param {Object} [options] - Opciones
 * @param {number} [options.codImpAdic=15] - Código impuesto adicional (15 = IVA Retenido Total)
 * @param {Function} [options.sanitize] - Función para sanitizar texto
 * @returns {Array} Detalle formateado
 */
function buildDetalleCompra(items, options = {}) {
  const { codImpAdic = 15, sanitize = (v) => String(v || '').trim() } = options;

  return buildDetalle(items, {
    allowIndExe: true,
    codImpAdic,
    forcePriced: true,
    includeUnidad: true,
    sanitize,
  });
}

// ============================================
// DESCUENTO/RECARGO GLOBAL
// ============================================

/**
 * Construye estructura DscRcgGlobal para descuento global
 * 
 * @param {number} descuentoPct - Porcentaje de descuento
 * @param {string} [glosa='DESCUENTO GLOBAL ITEMES AFECTOS'] - Descripción
 * @returns {Array|null} Estructura DscRcgGlobal o null si no hay descuento
 */
function buildDescuentoGlobal(descuentoPct, glosa = 'DESCUENTO GLOBAL ITEMES AFECTOS') {
  if (!descuentoPct || descuentoPct <= 0) return null;

  return [{
    NroLinDR: 1,
    TpoMov: 'D',
    GlosaDR: glosa,
    TpoValor: '%',
    ValorDR: descuentoPct,
  }];
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Constantes
  TASA_IVA_DEFAULT,

  // Formateo
  formatDecimal,
  calcularMontoItem,

  // Cálculo de totales
  calcularTotalesDesdeItems,
  calcularTotalesDesdeDetalle,

  // Construcción de detalle
  buildDetalle,
  buildDetalleGuia,
  buildDetalleCompra,

  // Descuento global
  buildDescuentoGlobal,
};
