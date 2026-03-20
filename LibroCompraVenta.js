// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroCompraVenta.js
 * 
 * Genera Libro de Compra/Venta electrónico para el SII.
 * 
 * Hereda de LibroBase: C14N, firma digital y serialización XML.
 */

const LibroBase = require('./LibroBase');

class LibroCompraVenta extends LibroBase {
  constructor(certificado) {
    super(certificado);
  }

  setCaratula(caratula) {
    this.caratula = { ...caratula };
    this.id = this.caratula.ID || `LCV_${(caratula.RutEmisorLibro || '').replace('-', '')}_${Date.now()}`;
  }

  generar() {
    if (!this.caratula) {
      throw new Error('Debe establecer la carátula antes de generar');
    }
    
    const caratulaXml = this._renderCaratula();
    const resumenXml = this._renderResumen();
    const detalleXml = this._renderDetalle();
    const envioLibroId = this.id;
    const tmstFirma = this._getTmstFirma();
    
    const xmlSinFirma = `<?xml version="1.0" encoding="ISO-8859-1"?>\n` +
      `<LibroCompraVenta xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sii.cl/SiiDte LibroCV_v10.xsd" version="1.0">` +
      `<EnvioLibro ID="${envioLibroId}">${caratulaXml}${resumenXml}${detalleXml}<TmstFirma>${tmstFirma}</TmstFirma></EnvioLibro>` +
      `</LibroCompraVenta>`;
    
    const xmlConSaltos = xmlSinFirma.replace(/></g, '><').replace(/></g, '>\n<');
    // Usar firmar() heredado de LibroBase
    this.xml = this.firmar(xmlConSaltos, 'EnvioLibro', 'LibroCompraVenta');
    return this.xml;
  }

  _renderCaratula() {
    const c = this.caratula || {};
    let xml = '<Caratula>';
    
    if (c.RutEmisorLibro) xml += `<RutEmisorLibro>${this._escapeXmlText(String(c.RutEmisorLibro))}</RutEmisorLibro>`;
    if (c.RutEnvia) xml += `<RutEnvia>${this._escapeXmlText(String(c.RutEnvia))}</RutEnvia>`;
    if (c.PeriodoTributario) xml += `<PeriodoTributario>${this._escapeXmlText(String(c.PeriodoTributario))}</PeriodoTributario>`;
    if (c.FchResol) xml += `<FchResol>${this._escapeXmlText(String(c.FchResol))}</FchResol>`;
    // NroResol SIEMPRE presente (aunque sea 0)
    xml += `<NroResol>${this._escapeXmlText(String(c.NroResol !== undefined ? c.NroResol : '0'))}</NroResol>`;
    if (c.TipoOperacion) xml += `<TipoOperacion>${this._escapeXmlText(String(c.TipoOperacion))}</TipoOperacion>`;
    if (c.TipoLibro) xml += `<TipoLibro>${this._escapeXmlText(String(c.TipoLibro))}</TipoLibro>`;
    if (c.TipoEnvio) xml += `<TipoEnvio>${this._escapeXmlText(String(c.TipoEnvio))}</TipoEnvio>`;
    if (c.FolioNotificacion) xml += `<FolioNotificacion>${this._escapeXmlText(String(c.FolioNotificacion))}</FolioNotificacion>`;
    if (c.TmstFirmaEnv) xml += `<TmstFirmaEnv>${this._escapeXmlText(String(c.TmstFirmaEnv))}</TmstFirmaEnv>`;
    
    xml += '</Caratula>';
    return xml;
  }

  _renderResumen() {
    if (!this.resumen.length) return '';
    
    const tipoEnvio = String(this.caratula?.TipoEnvio || '').toUpperCase();
    const useSegmento = tipoEnvio && tipoEnvio !== 'TOTAL';
    const resumenTag = useSegmento ? 'ResumenSegmento' : 'ResumenPeriodo';
    const totalesTag = useSegmento ? 'TotalesSegmento' : 'TotalesPeriodo';
    
    const order = [
      'TpoDoc', 'TpoImp', 'TotDoc', 'TotAnulado', 'TotOpExe', 'TotMntExe',
      'TotMntNeto', 'TotOpIVARec', 'TotMntIVA', 'TotOpActivoFijo',
      'TotMntActivoFijo', 'TotMntIVAActivoFijo', 'TotIVANoRec',
      'TotOpIVAUsoComun', 'TotIVAUsoComun', 'FctProp', 'TotCredIVAUsoComun',
      'TotIVAFueraPlazo', 'TotIVAPropio', 'TotIVATerceros', 'TotLey18211',
      'TotOtrosImp', 'TotImpSinCredito', 'TotOpIVARetTotal', 'TotIVARetTotal',
      'TotOpIVARetParcial', 'TotIVARetParcial', 'TotCredEC', 'TotDepEnvase',
      'TotLiquidaciones', 'TotMntTotal', 'TotOpIVANoRetenido', 'TotIVANoRetenido',
      'TotMntNoFact', 'TotMntPeriodo', 'TotPsjNac', 'TotPsjInt', 'TotTabPuros',
      'TotTabCigarrillos', 'TotTabElaborado', 'TotImpVehiculo',
    ];
    
    let xml = `<${resumenTag}>`;
    for (const r of this.resumen) {
      const normalized = { ...r };
      if (
        normalized.TotMntExe === undefined &&
        (normalized.TotMntNeto !== undefined ||
          normalized.TotMntIVA !== undefined ||
          normalized.TotMntTotal !== undefined)
      ) {
        normalized.TotMntExe = 0;
      }
      
      xml += `<${totalesTag}>`;
      order.forEach((key) => {
        const value = normalized[key];
        if (value === undefined || value === null || value === '') return;
        
        if (Array.isArray(value)) {
          value.forEach((item) => {
            if (item && typeof item === 'object') {
              xml += `<${key}>`;
              Object.keys(item).forEach((itemKey) => {
                if (item[itemKey] !== undefined && item[itemKey] !== null && item[itemKey] !== '') {
                  xml += `<${itemKey}>${this._escapeXmlText(String(item[itemKey]))}</${itemKey}>`;
                }
              });
              xml += `</${key}>`;
            } else {
              xml += `<${key}>${this._escapeXmlText(String(item))}</${key}>`;
            }
          });
        } else if (value && typeof value === 'object') {
          xml += `<${key}>`;
          Object.keys(value).forEach((itemKey) => {
            if (value[itemKey] !== undefined && value[itemKey] !== null && value[itemKey] !== '') {
              xml += `<${itemKey}>${this._escapeXmlText(String(value[itemKey]))}</${itemKey}>`;
            }
          });
          xml += `</${key}>`;
        } else {
          xml += `<${key}>${this._escapeXmlText(String(value))}</${key}>`;
        }
      });
      xml += `</${totalesTag}>`;
    }
    xml += `</${resumenTag}>`;
    return xml;
  }

  _renderDetalle() {
    if (!this.detalle.length) return '';
    
    const order = [
      'TpoDoc', 'Emisor', 'IndFactCompra', 'NroDoc', 'Anulado', 'Operacion',
      'TpoImp', 'TasaImp', 'NumInt', 'IndServicio', 'IndSinCosto', 'FchDoc',
      'CdgSIISucur', 'RUTDoc', 'RznSoc', 'Extranjero', 'TpoDocRef', 'FolioDocRef',
      'MntExe', 'MntNeto', 'MntIVA', 'MntActivoFijo', 'MntIVAActivoFijo',
      'IVANoRec', 'IVAUsoComun', 'IVAFueraPlazo', 'IVAPropio', 'IVATerceros',
      'Ley18211', 'OtrosImp', 'MntSinCred', 'IVARetTotal', 'IVARetParcial',
      'CredEC', 'DepEnvase', 'Liquidaciones', 'MntTotal', 'IVANoRetenido',
      'MntNoFact', 'MntPeriodo', 'PsjNac', 'PsjInt', 'TabPuros', 'TabCigarrillos',
      'TabElaborado', 'ImpVehiculo',
    ];
    
    let xml = '';
    for (const d of this.detalle) {
      const normalized = { ...d };
      
      // Calcular TasaImp si no existe
      if (
        (normalized.TasaImp === undefined || normalized.TasaImp === null || normalized.TasaImp === '') &&
        normalized.MntNeto !== undefined &&
        normalized.MntIVA !== undefined
      ) {
        const neto = Number(normalized.MntNeto);
        const iva = Number(normalized.MntIVA);
        if (Number.isFinite(neto) && Number.isFinite(iva) && neto > 0 && iva > 0) {
          const tasa = (iva / neto) * 100;
          normalized.TasaImp = tasa.toFixed(2).replace(/\.00$/, '.0');
        }
      }
      
      xml += '<Detalle>';
      order.forEach((key) => {
        const value = normalized[key];
        if (value === undefined || value === null || value === '') return;
        
        if (Array.isArray(value)) {
          value.forEach((item) => {
            if (item && typeof item === 'object') {
              xml += `<${key}>`;
              Object.keys(item).forEach((itemKey) => {
                if (item[itemKey] !== undefined && item[itemKey] !== null && item[itemKey] !== '') {
                  xml += `<${itemKey}>${this._escapeXmlText(String(item[itemKey]))}</${itemKey}>`;
                }
              });
              xml += `</${key}>`;
            } else {
              xml += `<${key}>${this._escapeXmlText(String(item))}</${key}>`;
            }
          });
        } else if (value && typeof value === 'object') {
          xml += `<${key}>`;
          Object.keys(value).forEach((itemKey) => {
            if (value[itemKey] !== undefined && value[itemKey] !== null && value[itemKey] !== '') {
              xml += `<${itemKey}>${this._escapeXmlText(String(value[itemKey]))}</${itemKey}>`;
            }
          });
          xml += `</${key}>`;
        } else {
          xml += `<${key}>${this._escapeXmlText(String(value))}</${key}>`;
        }
      });
      xml += '</Detalle>';
    }
    return xml;
  }
}

module.exports = LibroCompraVenta;
