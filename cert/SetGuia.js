// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Set Guía de Despacho
 * 
 * Tipo DTE: 52
 * 
 * Campos específicos de Guía de Despacho:
 *   - IndTraslado: 1=Venta, 2=Consignación, 3=Entrega gratuita, 
 *                  4=Comprobante, 5=Traslado interno, 6=Devolución
 *   - TpoDespacho: 1=Por cuenta del cliente, 2=Por cuenta del emisor
 * 
 * @module dte-sii/cert/SetGuia
 */

const SetBase = require('./SetBase');
const { SET_LABELS, SETS_DTE } = require('./types');

class SetGuia extends SetBase {
  constructor(deps) {
    super(deps);
    
    this.key = 'guia';
    this.label = SET_LABELS.guia;
    this.tiposDte = SETS_DTE.guia; // [52]
  }

  /**
   * @override
   * Valida casos específicos del set guía
   */
  _validarCasos(casos) {
    super._validarCasos(casos);
    
    if (!casos.casos?.length) {
      throw new Error('SetGuia: casos es requerido');
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
    
    // Solo tipo 52
    if (tipoDte === 52) {
      return casos.casos?.length || 1;
    }
    return 1;
  }

  /**
   * @override
   * Genera DTEs del set guía de despacho
   * 
   * @param {Object} casos - { casos, cafRequired }
   * @param {Object} cafs - { 52: cafPath }
   * @returns {Promise<DTE[]>}
   */
  async generarDtes(casos, cafs) {
    const dtes = [];
    
    this.logger.log('   📄 Generando guías de despacho...');
    for (const caso of casos.casos || []) {
      const dte = await this._generarGuia(caso, cafs[52]);
      dtes.push(dte);
    }
    
    return dtes;
  }

  /**
   * Genera una guía de despacho (tipo 52)
   * @private
   */
  async _generarGuia(caso, cafPath) {
    const { DTE, CAF, buildDetalleGuia, calcularTotalesDesdeDetalle, buildSetReferencia } = require('../index');
    const fs = require('fs');
    
    // Cargar CAF
    const cafXml = fs.readFileSync(cafPath, 'utf8');
    const caf = new CAF(cafXml);
    
    // Reservar folio
    const folio = this._reservarFolio(caf, cafXml);
    
    // Construir detalle (buildDetalleGuia siempre incluye QtyItem)
    const items = this._normalizarItems(caso.items);
    const detalle = buildDetalleGuia(items);
    
    // Calcular totales:
    // - Para IndTraslado 5 (traslado interno sin valor): TasaIVA: 19, MntTotal: 0
    // - Para otros casos: calcular desde el detalle
    const totales = caso.indTraslado === 5
      ? { TasaIVA: 19, MntTotal: 0 }
      : calcularTotalesDesdeDetalle(detalle, { preciosNetos: true });
    
    // Referencia del set de pruebas
    const fechaEmision = this._getFechaEmision();
    const setReferencia = buildSetReferencia(caso.id, fechaEmision);
    
    // Construir IdDoc con campos específicos de guía
    // Orden XSD: TipoDTE, Folio, FchEmis, ..., TipoDespacho, IndTraslado
    const idDoc = {
      TipoDTE: 52,
      Folio: folio,
      FchEmis: fechaEmision,
    };
    
    // TipoDespacho va ANTES de IndTraslado según XSD
    if (caso.tpoDespacho) {
      idDoc.TipoDespacho = caso.tpoDespacho;
    }
    
    idDoc.IndTraslado = caso.indTraslado || 1; // Default: Venta
    
    // Para IndTraslado 5 (traslado interno), el receptor es el mismo emisor
    const receptor = this._shouldUseEmisorAsReceptor(caso)
      ? this._buildEmisorAsReceptor()
      : this._buildReceptor();
    
    // Construir DTE
    const dteDatos = {
      Encabezado: {
        IdDoc: idDoc,
        Emisor: this._buildEmisor(),
        Receptor: receptor,
        Totales: totales,
      },
      Detalle: detalle,
      Referencia: [setReferencia],
    };
    
    const dte = new DTE(dteDatos);
    this._timbrarYFirmar(dte, caf);
    
    this.logger.log(`      ✓ Guía caso ${caso.id}: folio ${folio} (IndTraslado: ${idDoc.IndTraslado})`);
    return dte;
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers internos
  // ─────────────────────────────────────────────────────────────────

  /**
   * Normaliza items para guías de despacho
   * Las guías pueden tener items con monto: 0 (traslados internos)
   * @private
   */
  _normalizarItems(items) {
    return (items || []).map(item => {
      // Preservar monto si existe (para traslados internos sin precio)
      if (item.monto !== undefined && item.precio === undefined) {
        return {
          nombre: item.nombre,
          cantidad: item.cantidad || 1,
          monto: item.monto, // Preservar monto original
          unidad: item.unidad || 'UN',
          // No incluir precio - buildDetalleGuia usará monto directamente
        };
      }
      
      return {
        nombre: item.nombre,
        cantidad: item.cantidad || 1,
        precio: item.precio || 0,
        unidad: item.unidad || 'UN',
        ...(item.exento ? { exento: true } : {}),
      };
    });
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
   * Determina si debe usar el emisor como receptor (traslado interno)
   * @private
   */
  _shouldUseEmisorAsReceptor(caso) {
    return Number(caso?.indTraslado) === 5;
  }

  /**
   * Construye datos del emisor como receptor (para traslados internos)
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
    
    // Cargar certificado
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const cert = new Certificado(pfxBuffer, this.config.certificado.password);
    
    // Timestamp
    const timestamp = new Date().toISOString().replace('Z', '');
    
    // Generar, timbrar y firmar
    dte.generarXML().timbrar(caf, timestamp);
    dte.firmar(cert);
  }
}

module.exports = SetGuia;
