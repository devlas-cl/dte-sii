// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Simulación - Generador del Set de Simulación para certificación SII
 * 
 * La etapa de Simulación requiere enviar múltiples DTEs en un solo envío,
 * simulando la operación real de la empresa. Usa todos los tipos de DTE
 * de los sets anteriores.
 * 
 * @module dte-sii/cert/Simulacion
 */

const fs = require('fs');
const path = require('path');

// Core
const { Certificado, CAF, DTE, EnvioDTE } = require('../index');
const { buildDetalle, buildDetalleGuia, buildDetalleCompra, calcularTotalesDesdeDetalle } = require('../index');

const normalizeText = (value) => String(value || '').trim();
const TASA_IVA = 19;

class Simulacion {
  /**
   * @param {Object} config
   * @param {Object} config.emisor - { rut, razon_social, giro, acteco, direccion, comuna, ciudad, fch_resol, nro_resol }
   * @param {Object} config.receptor - { rut, razon_social, giro, direccion, comuna, ciudad }
   * @param {Object} config.certificado - Instancia de Certificado
   * @param {Object} [config.resolucion] - { fecha, numero }
   */
  constructor(config) {
    this.emisor = config.emisor;
    this.receptor = config.receptor;
    this.certificado = config.certificado;
    this.resolucion = config.resolucion || {
      fecha: config.emisor.fch_resol,
      numero: config.emisor.nro_resol,
    };
  }

  /**
   * Genera el EnvioDTE de simulación a partir de las estructuras
   * @param {Object} estructuras - Estructuras del set de pruebas
   * @param {Object} cafs - { tipoDte: CAF } pre-cargados
   * @param {Object} folioHelper - Helper para gestionar folios
   * @param {Object} [options] - Opciones
   * @param {string} [options.fechaEmision] - Fecha de emisión (default: hoy)
   * @returns {Object} { envioDte, dtes, xmlPath, plan }
   */
  generar(estructuras, cafs, folioHelper, options = {}) {
    const fechaEmision = options.fechaEmision || this._getFechaHoy();
    const plan = this._buildPlan(estructuras);
    const docRefs = {};

    if (plan.length < 10) {
      console.warn('⚠️  Se recomienda mínimo 10 documentos para simulación.');
    }

    const envioDte = new EnvioDTE({ certificado: this.certificado });
    const generatedDtes = [];

    for (const doc of plan) {
      const tipoDte = Number(doc.tipoDte || 33);
      const caf = cafs[tipoDte];
      if (!caf) {
        throw new Error(`No hay CAF para tipo ${tipoDte}`);
      }

      // Obtener folio desde el CAF
      const folio = folioHelper.reserveNextFolio({
        tipoDte,
        folioDesde: caf.getFolioDesde(),
        folioHasta: caf.getFolioHasta(),
      });
      const base = doc.referenciaCaso ? docRefs[doc.referenciaCaso] : null;

      // Resolver items
      let items = doc.items || [];
      if (doc.kind === 'basico' || doc.kind === 'exenta') {
        items = this._resolveItems(doc, base, doc.kind === 'exenta');
      }
      if (doc.kind === 'compra' && base?.items?.length) {
        items = items.map((item) => {
          const original = base.items.find((i) => normalizeText(i.nombre) === normalizeText(item.nombre));
          return { ...item, precio: item.precio ?? original?.precio ?? 1 };
        });
      }

      // Receptor (para compra o guía con indTraslado=5, usar emisor)
      const receptor = (doc.kind === 'compra' || this._shouldUseEmisorAsReceptor(doc)) ? {
        rut: this.emisor.rut,
        razon_social: this.emisor.razon_social,
        giro: this.emisor.giro,
        direccion: this.emisor.direccion,
        comuna: this.emisor.comuna,
        ciudad: this.emisor.ciudad || this.emisor.comuna,
      } : this.receptor;

      // Construir detalle y totales según tipo
      const { detalle, totales } = this._buildDetalleYTotales(doc, items, tipoDte);

      // Construir DTE
      const dteDatos = {
        Encabezado: {
          IdDoc: {
            TipoDTE: tipoDte,
            Folio: folio,
            FchEmis: fechaEmision,
            ...(tipoDte === 33 ? { TpoTranVenta: 1 } : {}),
            ...(tipoDte === 52 ? {
              IndTraslado: doc.indTraslado,
              ...(doc.tpoDespacho ? { TpoDespacho: doc.tpoDespacho } : {}),
            } : {}),
          },
          Emisor: {
            RUTEmisor: this.emisor.rut,
            RznSoc: this.emisor.razon_social,
            GiroEmis: this.emisor.giro,
            Acteco: this.emisor.acteco,
            DirOrigen: this.emisor.direccion,
            CmnaOrigen: this.emisor.comuna,
            CiudadOrigen: this.emisor.ciudad || this.emisor.comuna || 'Santiago',
          },
          Receptor: {
            RUTRecep: receptor.rut,
            RznSocRecep: receptor.razon_social,
            GiroRecep: receptor.giro,
            DirRecep: receptor.direccion,
            CmnaRecep: receptor.comuna,
            CiudadRecep: receptor.ciudad || receptor.comuna,
          },
          Totales: totales,
        },
        Detalle: detalle,
      };

      // Descuento global
      if (doc.descuentoGlobalPct) {
        dteDatos.DscRcgGlobal = [{
          NroLinDR: 1,
          TpoMov: 'D',
          TpoValor: '%',
          ValorDR: Number(doc.descuentoGlobalPct),
        }];
      }

      // Referencia
      if (doc.referenciaCaso && base) {
        dteDatos.Referencia = [{
          NroLinRef: 1,
          TpoDocRef: base.tipoDte,
          FolioRef: base.folio,
          FchRef: base.fecha,
          CodRef: doc.codRef,
          RazonRef: doc.razonRef,
        }];
      }

      // Generar DTE
      const dte = new DTE(dteDatos);
      dte.generarXML().timbrar(caf).firmar(this.certificado);
      envioDte.agregar(dte);

      generatedDtes.push({
        tipoDte,
        folio,
        xml: dte.getXML(),
      });

      // Guardar referencia para NC/ND
      if (doc.id) {
        docRefs[doc.id] = {
          tipoDte,
          folio,
          fecha: fechaEmision,
          items,
        };
      }
    }

    // Carátula del envío
    envioDte.setCaratula({
      RutEmisor: this.emisor.rut,
      RutEnvia: this.certificado.rut || this.emisor.rut,
      RutReceptor: '60803000-K', // SII
      FchResol: this.resolucion.fecha,
      NroResol: this.resolucion.numero,
    });
    envioDte.generar();

    return {
      envioDte,
      dtes: generatedDtes,
      xml: envioDte.getXML(),
      plan,
      tiposUsados: [...new Set(plan.map(d => d.tipoDte))],
    };
  }

  /**
   * Construye el plan de documentos a generar
   * @private
   */
  _buildPlan(estructuras) {
    const plan = [];
    const setBasico = estructuras?.setBasico;
    const setExenta = estructuras?.setFacturaExenta;
    const setGuia = estructuras?.setGuiaDespacho;
    const setCompra = estructuras?.setFacturaCompra;

    // Set Básico
    (setBasico?.casosFactura || []).forEach((caso) => plan.push({
      kind: 'basico', tipoDte: 33, id: caso.id,
      items: caso.items || [], descuentoGlobalPct: caso.descuentoGlobalPct,
    }));
    (setBasico?.casosNC || []).forEach((caso) => plan.push({
      kind: 'basico', tipoDte: 61, id: caso.id,
      referenciaCaso: caso.referenciaCaso, codRef: caso.codRef,
      razonRef: caso.razonRef, items: caso.items || [], itemsFromCaso: caso.itemsFromCaso,
    }));
    (setBasico?.casosND || []).forEach((caso) => plan.push({
      kind: 'basico', tipoDte: 56, id: caso.id,
      referenciaCaso: caso.referenciaCaso, codRef: caso.codRef,
      razonRef: caso.razonRef, items: caso.items || [],
    }));

    // Set Factura Exenta
    (setExenta?.casosFactura || []).forEach((caso) => plan.push({
      kind: 'exenta', tipoDte: 34, id: caso.id, items: caso.items || [],
    }));
    (setExenta?.casosNC || []).forEach((caso) => plan.push({
      kind: 'exenta', tipoDte: 61, id: caso.id,
      referenciaCaso: caso.referenciaCaso, codRef: caso.codRef,
      razonRef: caso.razonRef, items: caso.items || [],
    }));
    (setExenta?.casosND || []).forEach((caso) => plan.push({
      kind: 'exenta', tipoDte: 56, id: caso.id,
      referenciaCaso: caso.referenciaCaso, codRef: caso.codRef,
      razonRef: caso.razonRef, items: caso.items || [],
    }));

    // Set Guía Despacho
    (setGuia?.casos || []).forEach((caso) => plan.push({
      kind: 'guia', tipoDte: 52, id: caso.id,
      indTraslado: caso.indTraslado, tpoDespacho: caso.tpoDespacho, items: caso.items || [],
    }));

    // Set Factura Compra
    if (setCompra?.casoFactura) {
      plan.push({
        kind: 'compra', tipoDte: 46, id: setCompra.casoFactura.id,
        items: setCompra.casoFactura.items || [],
      });
    }
    if (setCompra?.casoNC) {
      plan.push({
        kind: 'compra', tipoDte: 61, id: setCompra.casoNC.id,
        referenciaCaso: setCompra.casoNC.referenciaCaso, codRef: setCompra.casoNC.codRef,
        razonRef: setCompra.casoNC.razonRef, items: setCompra.casoNC.items || [],
      });
    }
    if (setCompra?.casoND) {
      plan.push({
        kind: 'compra', tipoDte: 56, id: setCompra.casoND.id,
        referenciaCaso: setCompra.casoND.referenciaCaso, codRef: setCompra.casoND.codRef,
        razonRef: setCompra.casoND.razonRef, items: setCompra.casoND.items || [],
      });
    }

    return plan;
  }

  /**
   * Resuelve items heredados del caso referenciado
   * @private
   */
  _resolveItems(caso, base, exentoDefault) {
    let items = caso.items || [];

    if (caso.itemsFromCaso && base?.items?.length) {
      items = base.items;
    }

    if (!items || items.length === 0) {
      items = [{
        nombre: caso.razonRef || 'CORRECCION',
        cantidad: 1,
        precio: 0,
        exento: !!exentoDefault,
      }];
    }

    const razon = (caso.razonRef || '').toUpperCase();
    const esDevolucion = razon.includes('DEVOLUCION') || razon.includes('DEVOLUCIÓN');
    const esModificaMonto = razon.includes('MODIFICA MONTO');

    if (caso.codRef === 3 && esDevolucion && base?.items?.length) {
      items = base.items.map((bi) => ({ ...bi, exento: exentoDefault || bi.exento }));
    } else if (caso.codRef === 3 && esModificaMonto && base?.items?.length && items.length > 0) {
      items = items.map((ncItem) => {
        const nombreNc = normalizeText(ncItem.nombre).toUpperCase();
        const itemOriginal = base.items.find((bi) => normalizeText(bi.nombre).toUpperCase() === nombreNc);
        if (itemOriginal?.cantidad) {
          return { ...ncItem, cantidad: itemOriginal.cantidad, exento: exentoDefault || ncItem.exento };
        }
        return { ...ncItem, exento: exentoDefault || ncItem.exento };
      });
    }

    if (exentoDefault) {
      items = items.map((i) => ({ ...i, exento: true }));
    }

    return items;
  }

  /**
   * Construye detalle y totales según tipo de documento
   * @private
   */
  _buildDetalleYTotales(doc, items, tipoDte) {
    let detalle, totales;

    if (doc.kind === 'guia') {
      detalle = this._buildDetalleGuia(items);
      totales = this._calcularTotalesGuia(detalle);
    } else if (doc.kind === 'compra') {
      detalle = this._buildDetalleCompra(items);
      totales = this._calcularTotalesFacturaCompra(detalle);
    } else {
      detalle = this._buildDetalleGeneral(items, { allowIndExe: doc.kind === 'exenta' || doc.kind === 'basico' });
      totales = this._calcularTotalesGeneral(items, doc.descuentoGlobalPct);
    }

    return { detalle, totales };
  }

  /**
   * Construye detalle para factura/NC/ND general
   * @private
   */
  _buildDetalleGeneral(items = [], options = {}) {
    return items.map((i, idx) => {
      const qty = i.cantidad ?? 1;
      const prc = i.precio ?? 0;
      const base = Math.round(qty * prc);
      const descuentoPct = Number(i.descuentoPct || 0);
      const descuentoMonto = descuentoPct > 0 ? Math.round(base * (descuentoPct / 100)) : 0;
      const monto = base - descuentoMonto;
      const det = {
        NroLinDet: idx + 1,
        ...(options.allowIndExe && i.exento ? { IndExe: 1 } : {}),
        NmbItem: normalizeText(i.nombre),
      };
      if (prc > 0 || options.forcePriced) {
        det.QtyItem = qty;
        if (i.unidad) det.UnmdItem = i.unidad;
        det.PrcItem = prc;
        if (descuentoPct > 0) {
          det.DescuentoPct = descuentoPct;
          det.DescuentoMonto = descuentoMonto;
        }
      }
      det.MontoItem = monto;
      return det;
    });
  }

  /**
   * Construye detalle para Guía de Despacho
   * @private
   */
  _buildDetalleGuia(items = []) {
    return items.map((i, idx) => {
      const qty = i.cantidad ?? 1;
      const prc = i.precio ?? null;
      const monto = prc !== null ? Math.round(qty * prc) : (i.monto ?? undefined);
      return {
        NroLinDet: idx + 1,
        NmbItem: normalizeText(i.nombre),
        QtyItem: qty,
        UnmdItem: i.unidad || 'UN',
        ...(prc !== null && prc > 0 ? { PrcItem: prc } : {}),
        ...(monto !== undefined ? { MontoItem: monto } : {}),
        ...(i.exento ? { IndExe: 1 } : {}),
      };
    });
  }

  /**
   * Construye detalle para Factura de Compra
   * @private
   */
  _buildDetalleCompra(items = []) {
    return items.map((i, idx) => {
      const qty = i.cantidad ?? 1;
      const prc = i.precio ?? 0;
      const monto = Math.round(qty * prc);
      // Para facturas de compra, siempre agregar CodImpAdic: 15 a items afectos
      const codImpAdic = i.exento ? null : (i.codImpAdic ?? 15);
      return {
        NroLinDet: idx + 1,
        NmbItem: normalizeText(i.nombre),
        QtyItem: qty,
        UnmdItem: i.unidad || 'UN',
        PrcItem: prc,
        ...(codImpAdic ? { CodImpAdic: codImpAdic } : {}),
        MontoItem: monto,
        ...(i.exento ? { IndExe: 1 } : {}),
      };
    });
  }

  /**
   * Calcula totales para factura general
   * @private
   */
  _calcularTotalesGeneral(items = [], descuentoGlobalPct = 0) {
    let mntNeto = 0;
    let mntExe = 0;

    for (const item of items) {
      const qty = Number(item.cantidad || 1);
      const precio = Number(item.precio || 0);
      const descuento = Number(item.descuentoPct || 0);
      const base = Math.round(qty * precio);
      const descuentoMonto = descuento > 0 ? Math.round(base * (descuento / 100)) : 0;
      const linea = base - descuentoMonto;
      if (item.exento) mntExe += linea;
      else mntNeto += linea;
    }

    const descGlobalMonto = descuentoGlobalPct ? Math.round(mntNeto * (descuentoGlobalPct / 100)) : 0;
    mntNeto = Math.max(0, mntNeto - descGlobalMonto);

    const iva = Math.round(mntNeto * (TASA_IVA / 100));
    const total = mntNeto + iva + mntExe;

    const totales = {};
    if (mntNeto > 0) totales.MntNeto = mntNeto;
    if (mntExe > 0) totales.MntExe = mntExe;
    if (mntNeto > 0) {
      totales.TasaIVA = TASA_IVA;
      totales.IVA = iva;
    }
    totales.MntTotal = total;
    return totales;
  }

  /**
   * Calcula totales para Guía de Despacho
   * @private
   */
  _calcularTotalesGuia(detalle = []) {
    let mntNeto = 0;
    let mntExe = 0;

    detalle.forEach((det) => {
      if (det.IndExe === 1) mntExe += det.MontoItem || 0;
      else mntNeto += det.MontoItem || 0;
    });

    if (mntNeto === 0 && mntExe === 0) {
      return { TasaIVA: TASA_IVA, MntTotal: 0 };
    }

    const iva = mntNeto > 0 ? Math.round(mntNeto * (TASA_IVA / 100)) : 0;
    const mntTotal = mntNeto + iva + mntExe;

    const totales = {};
    if (mntNeto > 0) totales.MntNeto = mntNeto;
    if (mntExe > 0) totales.MntExe = mntExe;
    if (mntNeto > 0) totales.TasaIVA = TASA_IVA;
    if (mntNeto > 0) totales.IVA = iva;
    totales.MntTotal = mntTotal;
    return totales;
  }

  /**
   * Calcula totales para Factura de Compra
   * @private
   */
  _calcularTotalesFacturaCompra(detalle = []) {
    let mntNeto = 0;
    let mntExe = 0;

    detalle.forEach((det) => {
      if (det.IndExe === 1) mntExe += det.MontoItem || 0;
      else mntNeto += det.MontoItem || 0;
    });

    const iva = mntNeto > 0 ? Math.round(mntNeto * (TASA_IVA / 100)) : 0;
    const mntTotal = mntNeto + mntExe;

    const totales = {};
    if (mntNeto > 0) totales.MntNeto = mntNeto;
    if (mntExe > 0) totales.MntExe = mntExe;
    if (mntNeto > 0) totales.TasaIVA = TASA_IVA;
    if (mntNeto > 0) totales.IVA = iva;
    if (iva > 0) {
      totales.ImptoReten = [{
        TipoImp: 15,
        TasaImp: TASA_IVA,
        MontoImp: iva,
      }];
    }
    totales.MntTotal = mntTotal;
    return totales;
  }

  _shouldUseEmisorAsReceptor(doc) {
    return Number(doc.indTraslado) === 5;
  }

  _getFechaHoy() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}

module.exports = Simulacion;
