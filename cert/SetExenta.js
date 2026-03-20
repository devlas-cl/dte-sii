// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Set Factura Exenta
 * 
 * Tipos DTE: 34 (Factura Exenta), 61 (NC), 56 (ND)
 * 
 * Flujo similar a SetBasico pero:
 *   - Todos los items son exentos
 *   - Totales sin IVA
 * 
 * @module dte-sii/cert/SetExenta
 */

const SetBase = require('./SetBase');
const { SET_LABELS, SETS_DTE } = require('./types');

class SetExenta extends SetBase {
  constructor(deps) {
    super(deps);
    
    this.key = 'exenta';
    this.label = SET_LABELS.exenta;
    this.tiposDte = SETS_DTE.exenta; // [34, 56, 61]
    
    // Registro de referencias entre documentos
    // { casoId: { tipoDte, folio, fecha, detalle, totales, items } }
    this._docRefs = {};
  }

  /**
   * @override
   * Valida casos específicos del set exenta
   */
  _validarCasos(casos) {
    super._validarCasos(casos);
    
    if (!casos.casosFactura?.length) {
      throw new Error('SetExenta: casosFactura es requerido');
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
    
    switch (tipoDte) {
      case 34: return casos.casosFactura?.length || 1;
      case 61: return casos.casosNC?.length || 1;
      case 56: return casos.casosND?.length || 1;
      default: return 1;
    }
  }

  /**
   * @override
   * Genera DTEs del set exenta
   * 
   * @param {Object} casos - { casosFactura, casosNC, casosND, cafRequired }
   * @param {Object} cafs - { 34: cafPath, 56: cafPath, 61: cafPath }
   * @returns {Promise<DTE[]>}
   */
  async generarDtes(casos, cafs) {
    const dtes = [];
    
    // 1. Generar facturas exentas primero
    this.logger.log('   📄 Generando facturas exentas...');
    for (const caso of casos.casosFactura || []) {
      const dte = await this._generarFacturaExenta(caso, cafs[34]);
      dtes.push(dte);
    }
    
    // 2. Generar notas de crédito
    this.logger.log('   📄 Generando notas de crédito...');
    for (const caso of casos.casosNC || []) {
      const dte = await this._generarNotaCredito(caso, cafs[61]);
      dtes.push(dte);
    }
    
    // 3. Generar notas de débito
    this.logger.log('   📄 Generando notas de débito...');
    for (const caso of casos.casosND || []) {
      const dte = await this._generarNotaDebito(caso, cafs[56]);
      dtes.push(dte);
    }
    
    return dtes;
  }

  // ═══════════════════════════════════════════════════════════════
  // Generadores de DTEs
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera factura exenta (tipo 34)
   * @private
   */
  async _generarFacturaExenta(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeDetalle, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Marcar todos los items como exentos
    const items = this._normalizarItemsExentos(caso.items);
    const detalle = buildDetalle(items, { allowIndExe: true });
    const totales = calcularTotalesDesdeDetalle(detalle, { soloExento: true });
    
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    const dteDatos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: 34,
          Folio: folio,
          FchEmis: fechaEmision,
        },
        Emisor: this._buildEmisor(),
        Receptor: this._buildReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    // Guardar referencia para NC/ND
    this._docRefs[caso.id] = {
      tipoDte: 34,
      folio,
      fecha: fechaEmision,
      detalle,
      totales,
      items,
    };
    
    this.logger.log(`      ✓ Factura Exenta caso ${caso.id}: folio ${folio}`);
    return dte;
  }

  /**
   * Genera nota de crédito exenta (tipo 61)
   * @private
   */
  async _generarNotaCredito(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeDetalle, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Obtener documento referenciado
    const docRef = this._docRefs[caso.referenciaCaso];
    if (!docRef) {
      throw new Error(`SetExenta: Documento referencia ${caso.referenciaCaso} no encontrado para NC ${caso.id}`);
    }
    
    // Determinar items según tipo de NC
    const items = this._resolverItemsNC(caso, docRef);
    const detalle = buildDetalle(items, { allowIndExe: true });
    const totales = calcularTotalesDesdeDetalle(detalle, { soloExento: true });
    
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
        Receptor: this._buildReceptor(),
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
      items,
    };
    
    this.logger.log(`      ✓ NC Exenta caso ${caso.id}: folio ${folio} (ref: ${caso.referenciaCaso})`);
    return dte;
  }

  /**
   * Genera nota de débito exenta (tipo 56)
   * @private
   */
  async _generarNotaDebito(caso, cafPath) {
    const { DTE, CAF, buildDetalle, calcularTotalesDesdeDetalle, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    const folio = this._reservarFolio(caf, cafXml);
    
    // Obtener documento referenciado
    const docRef = this._docRefs[caso.referenciaCaso];
    if (!docRef) {
      throw new Error(`SetExenta: Documento referencia ${caso.referenciaCaso} no encontrado para ND ${caso.id}`);
    }
    
    // Determinar items según tipo de ND
    const items = this._resolverItemsND(caso, docRef);
    const detalle = buildDetalle(items, { allowIndExe: true });
    const totales = calcularTotalesDesdeDetalle(detalle, { soloExento: true });
    
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
        Receptor: this._buildReceptor(),
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia, docReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    this.logger.log(`      ✓ ND Exenta caso ${caso.id}: folio ${folio} (ref: ${caso.referenciaCaso})`);
    return dte;
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normaliza items marcándolos como exentos
   * @private
   */
  _normalizarItemsExentos(items) {
    return (items || []).map(item => ({
      nombre: item.nombre,
      cantidad: item.cantidad || 1,
      precio: item.precio || 0,
      unidad: item.unidad || 'UN',
      exento: true, // Siempre exento
    }));
  }

  /**
   * Resuelve items para NC según codRef
   * @private
   */
  _resolverItemsNC(caso, docRef) {
    const razon = (caso.razonRef || '').toUpperCase();
    
    // CodRef 2: Corrige giro/texto - usar item dummy
    if (caso.codRef === 2) {
      return [{
        nombre: caso.razonRef || 'CORRECCION',
        cantidad: 1,
        precio: 0,
        exento: true,
      }];
    }
    
    // CodRef 3: Modifica montos
    if (caso.codRef === 3) {
      const esDevolucion = razon.includes('DEVOLUCION') || razon.includes('DEVOLUCIÓN');
      const esModificaMonto = razon.includes('MODIFICA MONTO');
      
      // DEVOLUCION: usar items de factura original completos
      if (esDevolucion && docRef.items?.length) {
        return docRef.items.map(item => ({
          ...item,
          exento: true,
        }));
      }
      
      // MODIFICA MONTO: usar CANTIDAD de factura original con PRECIO nuevo del SII
      if (esModificaMonto && caso.items?.length && docRef.items?.length) {
        return caso.items.map(ncItem => {
          const nombreNc = (ncItem.nombre || '').toUpperCase().trim();
          const itemOriginal = docRef.items.find(i =>
            (i.nombre || '').toUpperCase().trim() === nombreNc
          );
          
          if (itemOriginal && itemOriginal.cantidad) {
            return {
              nombre: ncItem.nombre,
              cantidad: itemOriginal.cantidad, // Cantidad de factura ORIGINAL
              precio: ncItem.precio,           // Precio NUEVO del SII
              unidad: ncItem.unidad || itemOriginal.unidad || 'UN',
              exento: true,
            };
          }
          return { ...ncItem, exento: true };
        });
      }
      
      // Otros casos de codRef 3: usar items del caso
      if (caso.items?.length) {
        return this._normalizarItemsExentos(caso.items);
      }
      return docRef.items || [];
    }
    
    // CodRef 1: Anula documento completo
    if (caso.codRef === 1) {
      return docRef.items || [];
    }
    
    // Default: usar items de la NC o del documento
    return caso.items?.length 
      ? this._normalizarItemsExentos(caso.items) 
      : docRef.items || [];
  }

  /**
   * Resuelve items para ND según codRef
   * @private
   */
  _resolverItemsND(caso, docRef) {
    const razon = (caso.razonRef || '').toUpperCase();
    const esModificaMonto = razon.includes('MODIFICA MONTO');
    
    // Si no hay items, usar item dummy con la razón
    if (!caso.items?.length) {
      // Para ANULA o similar, usar items del documento referenciado si existen
      if (docRef.items?.length) {
        return docRef.items.map(i => ({ ...i, exento: true }));
      }
      return [{
        nombre: caso.razonRef || 'CORRECCION',
        cantidad: 1,
        precio: 0,
        exento: true,
      }];
    }
    
    // MODIFICA MONTO: usar CANTIDAD de documento original con PRECIO nuevo del SII
    if (caso.codRef === 3 && esModificaMonto && docRef.items?.length) {
      return caso.items.map(ndItem => {
        const nombreNd = (ndItem.nombre || '').toUpperCase().trim();
        const itemOriginal = docRef.items.find(i =>
          (i.nombre || '').toUpperCase().trim() === nombreNd
        );
        
        if (itemOriginal && itemOriginal.cantidad) {
          return {
            nombre: ndItem.nombre,
            cantidad: itemOriginal.cantidad, // Cantidad de documento ORIGINAL
            precio: ndItem.precio,           // Precio NUEVO del SII
            unidad: ndItem.unidad || itemOriginal.unidad || 'UN',
            exento: true,
          };
        }
        return { ...ndItem, exento: true };
      });
    }
    
    // Default: usar items del caso
    return this._normalizarItemsExentos(caso.items);
  }

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
   * Construye datos del receptor
   * @private
   */
  _buildReceptor() {
    const r = this.config.receptor;
    return {
      RUTRecep: r.rut,
      RznSocRecep: r.razon_social,
      GiroRecep: r.giro,
      DirRecep: r.direccion,
      CmnaRecep: r.comuna,
      CiudadRecep: r.ciudad || r.comuna,
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

module.exports = SetExenta;
