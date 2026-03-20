// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Set Factura de Compra
 * 
 * Tipos DTE: 46 (Factura de Compra), 61 (NC), 56 (ND)
 * 
 * Particularidades:
 *   - El emisor actúa como comprador (retiene IVA)
 *   - ImptoReten con TipoImp=15 (IVA Retenido Total)
 *   - MntTotal = MntNeto (IVA se cancela con retención)
 *   - NC/ND referencian la factura de compra original
 * 
 * @module dte-sii/cert/SetCompra
 */

const SetBase = require('./SetBase');
const { SET_LABELS, SETS_DTE } = require('./types');

class SetCompra extends SetBase {
  constructor(deps) {
    super(deps);
    
    this.key = 'compra';
    this.label = SET_LABELS.compra;
    this.tiposDte = SETS_DTE.compra; // [46, 56, 61]
    
    // Registro de referencias entre documentos
    this._docRefs = {};
  }

  /**
   * @override
   * Valida casos específicos del set compra
   */
  _validarCasos(casos) {
    super._validarCasos(casos);
    
    if (!casos.casoFactura) {
      throw new Error('SetCompra: casoFactura es requerido');
    }
  }

  /**
   * @override
   * Calcula folios necesarios por tipo
   */
  _calcularCantidadFolios(casos, tipoDte) {
    if (casos.cafRequired?.[tipoDte]) {
      return casos.cafRequired[tipoDte];
    }
    
    // Set compra tiene 1 documento de cada tipo
    return 1;
  }

  /**
   * @override
   * Genera DTEs del set factura compra
   * 
   * @param {Object} casos - { casoFactura, casoNC, casoND, cafRequired }
   * @param {Object} cafs - { 46: cafPath, 56: cafPath, 61: cafPath }
   * @returns {Promise<DTE[]>}
   */
  async generarDtes(casos, cafs) {
    const dtes = [];
    
    // 1. Generar factura de compra
    this.logger.log('   📄 Generando factura de compra...');
    const dteFactura = await this._generarFacturaCompra(casos.casoFactura, cafs[46]);
    dtes.push(dteFactura);
    
    // 2. Generar nota de crédito
    if (casos.casoNC) {
      this.logger.log('   📄 Generando nota de crédito...');
      const dteNc = await this._generarNotaCredito(casos.casoNC, cafs[61]);
      dtes.push(dteNc);
    }
    
    // 3. Generar nota de débito
    if (casos.casoND) {
      this.logger.log('   📄 Generando nota de débito...');
      const dteNd = await this._generarNotaDebito(casos.casoND, cafs[56]);
      dtes.push(dteNd);
    }
    
    return dtes;
  }

  // ═══════════════════════════════════════════════════════════════
  // Generadores de DTEs
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera factura de compra (tipo 46)
   * @private
   */
  async _generarFacturaCompra(caso, cafPath) {
    const { DTE, CAF, buildDetalleCompra, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Construir detalle con buildDetalleCompra (incluye CodImpAdic)
    const items = this._normalizarItems(caso.items);
    const detalle = buildDetalleCompra(items, { codImpAdic: 15 });
    const totales = this._calcularTotalesFacturaCompra(detalle);
    
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 46,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildEmisorAsReceptor(), // Emisor es también receptor en F. Compra
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    // Guardar referencia para NC/ND
    this._docRefs[caso.id] = {
      tipoDte: 46,
      folio,
      fecha: fechaEmision,
      detalle,
      totales,
      items,
    };
    
    this.logger.log(`      ✓ Factura Compra caso ${caso.id}: folio ${folio}`);
    return dte;
  }

  /**
   * Genera nota de crédito para factura de compra (tipo 61)
   * @private
   */
  async _generarNotaCredito(caso, cafPath) {
    const { DTE, CAF, buildDetalleCompra, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Obtener documento referenciado
    const docRef = this._docRefs[caso.referenciaCaso];
    if (!docRef) {
      throw new Error(`SetCompra: Documento referencia ${caso.referenciaCaso} no encontrado para NC ${caso.id}`);
    }
    
    // Resolver items: NC puede tener cantidades parciales
    const items = this._resolverItemsNC(caso, docRef);
    const detalle = buildDetalleCompra(items, { codImpAdic: 15 });
    const totales = this._calcularTotalesFacturaCompra(detalle);
    
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    // Referencia al documento original
    const docReferencia = {
      NroLinRef: 2,
      TpoDocRef: docRef.tipoDte,
      FolioRef: docRef.folio,
      FchRef: docRef.fecha,
      CodRef: caso.codRef,
      RazonRef: caso.razonRef,
    };
    
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 61,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildEmisorAsReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia, docReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    // Guardar referencia para ND
    this._docRefs[caso.id] = {
      tipoDte: 61,
      folio,
      fecha: fechaEmision,
      detalle,
      totales,
      items,
    };
    
    this.logger.log(`      ✓ NC Compra caso ${caso.id}: folio ${folio} (ref: ${caso.referenciaCaso})`);
    return dte;
  }

  /**
   * Genera nota de débito para factura de compra (tipo 56)
   * @private
   */
  async _generarNotaDebito(caso, cafPath) {
    const { DTE, CAF, buildDetalleCompra, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Obtener documento referenciado
    const docRef = this._docRefs[caso.referenciaCaso];
    if (!docRef) {
      throw new Error(`SetCompra: Documento referencia ${caso.referenciaCaso} no encontrado para ND ${caso.id}`);
    }
    
    // ND generalmente tiene los mismos items que NC (anula NC)
    const items = this._resolverItemsND(caso, docRef);
    const detalle = buildDetalleCompra(items, { codImpAdic: 15 });
    const totales = this._calcularTotalesFacturaCompra(detalle);
    
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    // Referencia al documento original
    const docReferencia = {
      NroLinRef: 2,
      TpoDocRef: docRef.tipoDte,
      FolioRef: docRef.folio,
      FchRef: docRef.fecha,
      CodRef: caso.codRef,
      RazonRef: caso.razonRef,
    };
    
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 56,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildEmisorAsReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia, docReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    this.logger.log(`      ✓ ND Compra caso ${caso.id}: folio ${folio} (ref: ${caso.referenciaCaso})`);
    return dte;
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers de cálculo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Calcula totales para Factura de Compra con IVA Retenido Total
   * @private
   */
  _calcularTotalesFacturaCompra(detalle) {
    let mntBruto = 0;
    let mntExento = 0;
    
    for (const det of detalle) {
      if (det.IndExe === 1) {
        mntExento += det.MontoItem || 0;
      } else {
        mntBruto += det.MontoItem || 0;
      }
    }
    
    const tasaIva = 19;
    // Precios son netos en certificación
    const mntNeto = mntBruto;
    const iva = mntNeto > 0 ? Math.round(mntNeto * (tasaIva / 100)) : 0;
    
    // MntTotal = MntNeto (IVA se cancela con retención)
    const mntTotal = mntNeto + mntExento;
    
    // Orden según schema: MntNeto, MntExe, TasaIVA, IVA, ImptoReten, MntTotal
    const totales = {};
    if (mntNeto > 0) totales.MntNeto = mntNeto;
    if (mntExento > 0) totales.MntExe = mntExento;
    if (mntNeto > 0) totales.TasaIVA = tasaIva;
    if (mntNeto > 0) totales.IVA = iva;
    
    // ImptoReten con TipoImp=15 = IVA Retenido Total
    if (iva > 0) {
      totales.ImptoReten = [{
        TipoImp: 15,
        TasaImp: tasaIva,
        MontoImp: iva,
      }];
    }
    
    totales.MntTotal = mntTotal;
    
    return totales;
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers de items
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normaliza items
   * @private
   */
  _normalizarItems(items) {
    return (items || []).map(item => ({
      nombre: item.nombre,
      cantidad: item.cantidad || 1,
      precio: item.precio || 0,
      unidad: item.unidad || 'UN',
    }));
  }

  /**
   * Resuelve items para NC
   * Si NC tiene items con cantidad pero sin precio, usar precio del original
   * @private
   */
  _resolverItemsNC(caso, docRef) {
    const ncItems = caso.items || [];
    
    return ncItems.map(ncItem => {
      // Buscar item original por nombre para obtener precio
      const originalItem = (docRef.items || []).find(
        i => i.nombre === ncItem.nombre
      );
      
      return {
        nombre: ncItem.nombre,
        cantidad: ncItem.cantidad || 1,
        precio: ncItem.precio || originalItem?.precio || 0,
        unidad: ncItem.unidad || originalItem?.unidad || 'UN',
      };
    });
  }

  /**
   * Resuelve items para ND
   * @private
   */
  _resolverItemsND(caso, docRef) {
    const ndItems = caso.items || [];
    
    // Si ND tiene items propios
    if (ndItems.length) {
      return ndItems.map(ndItem => {
        // Buscar item original por nombre para obtener precio
        const originalItem = (docRef.items || []).find(
          i => i.nombre === ndItem.nombre
        );
        
        return {
          nombre: ndItem.nombre,
          cantidad: ndItem.cantidad || 1,
          precio: ndItem.precio || originalItem?.precio || 0,
          unidad: ndItem.unidad || originalItem?.unidad || 'UN',
        };
      });
    }
    
    // Si no, usar items del documento referenciado
    return docRef.items || [];
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers comunes
  // ═══════════════════════════════════════════════════════════════

  /**
   * Reserva el siguiente folio disponible
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
   * Obtiene la fecha de emisión
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
   * Construye datos del emisor como receptor (Factura de Compra)
   * @private
   */
  _buildEmisorAsReceptor() {
    const e = this.config.emisor;
    return {
      RUTRecep: e.rut,
      RznSocRecep: e.razon_social,
      GiroRecep: e.giro,
      DirRecep: e.direccion,
      CmnaRecep: e.comuna,
      CiudadRecep: e.ciudad || e.comuna || 'Santiago',
    };
  }

  /**
   * Timbra y firma el DTE
   * @private
   */
  _timbrarYFirmar(dte, caf) {
    const { Certificado } = require('../index');
    const fs = require('fs');
    
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const cert = new Certificado(pfxBuffer, this.config.certificado.password);
    
    const timestamp = new Date().toISOString().replace('Z', '');
    
    dte.generarXML().timbrar(caf, timestamp);
    dte.firmar(cert);
  }
}

module.exports = SetCompra;
