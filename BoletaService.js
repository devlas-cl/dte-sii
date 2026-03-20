// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * BoletaService
 * 
 * Servicio simplificado para crear boletas electrónicas
 */

const Certificado = require('./Certificado');
const CAF = require('./CAF');
const DTE = require('./DTE');
const { 
  sanitizeSiiText,
  buildDetalle,
  calcularTotalesDesdeItems,
  buildReceptorConsumidorFinal,
  dteError,
  ERROR_CODES,
  createScopedLogger,
  TIPOS_DTE,
  esBoleta,
} = require('./utils');

const log = createScopedLogger('BoletaService');

class BoletaService {
  constructor(config) {
    this.config = config;
    this.certificado = null;
    this.caf = null;
  }
  
  /**
   * Cargar certificado desde buffer PFX
   */
  cargarCertificado(pfxBuffer, password) {
    this.certificado = new Certificado(pfxBuffer, password);
    return this;
  }
  
  /**
   * Cargar CAF desde string XML
   */
  cargarCAF(xmlContent) {
    this.caf = new CAF(xmlContent);
    return this;
  }
  
  /**
   * Crear y firmar una boleta
   * @param {Array} items - Items de la boleta [{NmbItem, QtyItem, PrcItem}]
   * @param {number} folio - Número de folio
   * @param {Object} receptor - Datos del receptor (opcional)
   * @returns {Object} - Resultado con XML firmado
   */
  crearBoleta(items, folio, receptor = null) {
    if (!this.certificado) {
      throw dteError('Certificado no cargado', ERROR_CODES.CERT_INVALID);
    }
    if (!this.caf) {
      throw dteError('CAF no cargado', ERROR_CODES.CAF_INVALID);
    }
    
    // Usar utilidades centralizadas para construir detalle y calcular totales
    const detalle = buildDetalle(items);
    const totales = calcularTotalesDesdeItems(items);
    
    const datos = {
      Encabezado: {
        IdDoc: {
          TipoDTE: TIPOS_DTE.BOLETA,
          Folio: folio,
          FchEmis: new Date().toISOString().split('T')[0],
          IndServicio: 3,
        },
        Emisor: {
          RUTEmisor: this.config.rutEmisor,
          RznSocEmisor: this.config.razonSocial,
          GiroEmisor: this.config.giro,
          DirOrigen: this.config.direccion,
          CmnaOrigen: this.config.comuna,
        },
        Receptor: receptor || buildReceptorConsumidorFinal(),
        Totales: {
          MntTotal: totales.MntTotal,
        },
      },
      Detalle: detalle,
    };
    
    const dte = new DTE(datos);
    dte.generarXML();
    dte.timbrar(this.caf);
    dte.firmar(this.certificado);
    
    log.log(`✅ Boleta creada: Folio ${folio}, Monto $${totales.MntTotal}`);
    
    return {
      ok: true,
      folio,
      tipo_dte: TIPOS_DTE.BOLETA,
      fecha: datos.Encabezado.IdDoc.FchEmis,
      monto_total: totales.MntTotal,
      xml: dte.getXML(),
    };
  }
}

module.exports = BoletaService;
