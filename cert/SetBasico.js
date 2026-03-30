// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Set Básico - Factura, Nota de Crédito, Nota de Débito
 * 
 * Tipos DTE: 33, 56, 61
 * Flujo:
 *   1. Generar facturas (casos tipo 33)
 *   2. Generar NC (referenciando facturas) 
 *   3. Generar ND (referenciando facturas)
 * 
 * @module dte-sii/cert/SetBasico
 */

const SetBase = require('./SetBase');
const { SET_LABELS, SETS_DTE } = require('./types');

class SetBasico extends SetBase {
  constructor(deps) {
    super(deps);
    
    this.key = 'basico';
    this.label = SET_LABELS.basico;
    this.tiposDte = SETS_DTE.basico; // [33, 56, 61]
    
    // Registro de referencias entre documentos
    // { casoId: { tipoDte, folio, fecha, detalle, totales, items } }
    this._docRefs = {};
  }

  /**
   * @override
   * Valida casos específicos del set básico
   */
  _validarCasos(casos) {
    super._validarCasos(casos);
    
    if (!casos.casosFactura?.length) {
      throw new Error('SetBasico: casosFactura es requerido');
    }
    // NC y ND pueden estar vacíos en algunos escenarios
  }

  /**
   * @override
   * Calcula folios necesarios por tipo
   */
  _calcularCantidadFolios(casos, tipoDte) {
    // Usar cafRequired si está definido
    if (casos.cafRequired?.[tipoDte]) {
      return casos.cafRequired[tipoDte];
    }
    
    // Si no, contar casos
    switch (tipoDte) {
      case 33: return casos.casosFactura?.length || 1;
      case 61: return casos.casosNC?.length || 1;
      case 56: return casos.casosND?.length || 1;
      default: return 1;
    }
  }

  /**
   * @override
   * Genera DTEs del set básico
   * 
   * @param {Object} casos - { casosFactura, casosNC, casosND, cafRequired }
   * @param {Object} cafs - { 33: cafPath, 56: cafPath, 61: cafPath }
   * @returns {Promise<DTE[]>}
   */
  async generarDtes(casos, cafs) {
    const dtes = [];
    
    // 1. Generar facturas primero (las NC/ND referencian facturas)
    this.logger.log(' Generando facturas...');
    for (const caso of casos.casosFactura || []) {
      const dte = await this._generarFactura(caso, cafs[33]);
      dtes.push(dte);
    }
    
    // 2. Generar notas de crédito
    this.logger.log(' Generando notas de crédito...');
    for (const caso of casos.casosNC || []) {
      const dte = await this._generarNotaCredito(caso, cafs[61]);
      dtes.push(dte);
    }
    
    // 3. Generar notas de débito
    this.logger.log(' Generando notas de débito...');
    for (const caso of casos.casosND || []) {
      const dte = await this._generarNotaDebito(caso, cafs[56]);
      dtes.push(dte);
    }
    
    return dtes;
  }

  /**
   * Genera una factura (tipo 33)
   * @private
   */
  async _generarFactura(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeItems, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    // Cargar CAF
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    
    // Reservar folio
    const folio = this._reservarFolio(caf, cafXml);
    
    // Construir detalle e items
    const detalle = buildDetalle(caso.items);
    const { totales } = calcularTotalesDesdeItems(caso.items, caso.descuentoGlobalPct);
    
    // Descuento global si aplica
    const dscRcgGlobal = caso.descuentoGlobalPct
      ? [{
          NroLinDR: 1,
          TpoMov: 'D',
          GlosaDR: 'DESCUENTO GLOBAL ITEMES AFECTOS',
          TpoValor: '%',
          ValorDR: caso.descuentoGlobalPct,
        }]
      : null;
    
    // Referencia del set de pruebas
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    // Construir DTE
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 33,
          Folio: folio,
          FchEmis: fechaEmision,
          TpoTranVenta: 1,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia],
      ...(dscRcgGlobal ? { DscRcgGlobal: dscRcgGlobal } : {}),
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    // Guardar referencia para NC/ND
    this._docRefs[caso.id] = {
      tipoDte: 33,
      folio,
      fecha: fechaEmision,
      detalle,
      totales,
      items: caso.items,
      descuentoGlobalPct: caso.descuentoGlobalPct,
    };
    
    this.logger.log(` ✓ Factura caso ${caso.id}: folio ${folio}`);
    return dte;
  }

  /**
   * Genera una nota de crédito (tipo 61)
   * @private
   */
  async _generarNotaCredito(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeItems, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    // Obtener documento referenciado
    const base = this._docRefs[caso.referenciaCaso];
    if (!base) {
      throw new Error(`SetBasico: No se encontró referencia del caso ${caso.referenciaCaso}`);
    }
    
    // Cargar CAF
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    
    // Reservar folio
    const folio = this._reservarFolio(caf, cafXml);
    
    // Determinar items a usar
    let items = caso.itemsFromCaso
      ? (this._docRefs[caso.itemsFromCaso]?.items || [])
      : (caso.items || []);
    
    // Si codRef es 3 (DEVOLUCION/MODIFICACION), asegurar precios de la factura original
    if (caso.codRef === 3 && items.length > 0 && base.items?.length > 0) {
      const baseItemsMap = new Map(base.items.map(bi => [bi.nombre, bi]));
      items = items.map(item => {
        if ((!item.precio || item.precio === 0) && baseItemsMap.has(item.nombre)) {
          const baseItem = baseItemsMap.get(item.nombre);
          return { ...item, precio: baseItem.precio, descuentoPct: baseItem.descuentoPct };
        }
        return item;
      });
    }
    
    const itemsFinal = items.length ? items : [{ nombre: 'SIN MONTO', cantidad: 1, precio: 0 }];
    const detalle = buildDetalle(itemsFinal);
    const { totales } = calcularTotalesDesdeItems(itemsFinal, null);
    
    // Referencias
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    const docReferencia = {
      NroLinRef: 2,
      TpoDocRef: base.tipoDte,
      FolioRef: base.folio,
      FchRef: base.fecha,
      CodRef: caso.codRef,
      RazonRef: caso.razonRef,
    };
    
    // Construir DTE
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 61,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildReceptor(caso.receptorOverride),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia, docReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    // Guardar referencia
    this._docRefs[caso.id] = {
      tipoDte: 61,
      folio,
      fecha: fechaEmision,
      detalle,
      totales,
      items: itemsFinal,
    };
    
    this.logger.log(` ✓ NC caso ${caso.id}: folio ${folio} (ref: caso ${caso.referenciaCaso})`);
    return dte;
  }

  /**
   * Genera una nota de débito (tipo 56)
   * @private
   */
  async _generarNotaDebito(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeItems, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    // Obtener documento referenciado
    const base = this._docRefs[caso.referenciaCaso];
    if (!base) {
      throw new Error(`SetBasico: No se encontró referencia del caso ${caso.referenciaCaso}`);
    }
    
    // Cargar CAF
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    
    // Reservar folio
    const folio = this._reservarFolio(caf, cafXml);
    
    // Items
    const itemsFinal = caso.items || [{ nombre: 'SIN MONTO', cantidad: 1, precio: 0 }];
    const detalle = buildDetalle(itemsFinal);
    const { totales } = calcularTotalesDesdeItems(itemsFinal, null);
    
    // Referencias
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    const docReferencia = {
      NroLinRef: 2,
      TpoDocRef: base.tipoDte,
      FolioRef: base.folio,
      FchRef: base.fecha,
      CodRef: caso.codRef,
      RazonRef: caso.razonRef,
    };
    
    // Construir DTE
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 56,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia, docReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    this.logger.log(` ✓ ND caso ${caso.id}: folio ${folio} (ref: caso ${caso.referenciaCaso})`);
    return dte;
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers internos
  // ─────────────────────────────────────────────────────────────────

  /**
   * Reserva el siguiente folio disponible
   * Compatible con folioHelper de cert-base
   * @private
   */
  _reservarFolio(caf, cafXml) {
    const cafFingerprint = this.folioHelper.createCafFingerprint(cafXml);
    const folio = this.folioHelper.reserveNextFolio({
      rutEmisor: this.config.emisor.rut,
      tipoDte: caf.getTipoDTE(),
      folioDesde: caf.getFolioDesde(),
      folioHasta: caf.getFolioHasta(),
      ambiente: this.config.ambiente || 'certificacion',
      cafFingerprint,
    });
    return folio;
  }

  /**
   * Obtiene la fecha de emisión en formato YYYY-MM-DD
   * @private
   */
  _getFechaEmision() {
    if (this._fechaEmision) return this._fechaEmision;
    const now = new Date();
    this._fechaEmision = now.toISOString().split('T')[0];
    return this._fechaEmision;
  }

  /**
   * Construye datos del emisor
   * @private
   */
  _buildEmisor() {
    const e = this.config.emisor;
    return {
      RUTEmisor: e.rut,
      RznSoc: e.razon_social,
      GiroEmis: e.giro,
      Acteco: e.acteco,
      DirOrigen: e.direccion,
      CmnaOrigen: e.comuna,
      CiudadOrigen: e.ciudad || e.comuna || 'Santiago',
    };
  }

  /**
   * Construye datos del receptor
   * @private
   */
  _buildReceptor(override = null) {
    const r = this.config.receptor;
    return {
      RUTRecep: r.rut,
      RznSocRecep: r.razon_social,
      GiroRecep: r.giro,
      DirRecep: r.direccion,
      CmnaRecep: r.comuna,
      CiudadRecep: r.ciudad || r.comuna,
      ...(override || {}),
    };
  }

  /**
   * Timbra y firma el DTE
   * @private
   */
  _timbrarYFirmar(dte, caf) {
    const { Certificado } = require('../index');
    const fs = require('fs');
    
    // Cargar certificado
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const cert = new Certificado(pfxBuffer, this.config.certificado.password);
    
    // Timestamp
    const timestamp = new Date().toISOString().replace('Z', '');
    
    // Generar, timbrar y firmar
    dte.generarXML().timbrar(caf, timestamp);
    dte.firmar(cert);
  }

  /**
   * Obtiene las referencias de documentos generados
   * Útil para debugging o para otros sets que necesiten referencias
   * @returns {Object}
   */
  getDocRefs() {
    return { ...this._docRefs };
  }
}

module.exports = SetBasico;
