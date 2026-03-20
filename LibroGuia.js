// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * LibroGuia.js
 * 
 * Genera Libro de Guías de Despacho electrónico para el SII.
 * 
 * Hereda de LibroBase: C14N, firma digital y serialización XML.
 */

const LibroBase = require('./LibroBase');

class LibroGuia extends LibroBase {
  constructor(certificado) {
    super(certificado);
  }

  setCaratula(caratula) {
    this.caratula = {
      RutEmisorLibro: null,
      RutEnvia: this.certificado?.rut || null,
      PeriodoTributario: null,
      FchResol: null,
      NroResol: 0,
      TipoLibro: 'ESPECIAL',
      TipoEnvio: 'TOTAL',
      FolioNotificacion: null,
      ...caratula,
    };
    
    if (this.caratula.TipoEnvio === 'ESPECIAL') {
      this.caratula.FolioNotificacion = null;
    }
    
    this.id = this.caratula.ID || `LIBRO_GUIA_${(this.caratula.RutEmisorLibro || '').replace('-', '')}_${String(this.caratula.PeriodoTributario || '').replace(/-/g, '')}_${Date.now()}`;
  }

  generar() {
    if (!this.caratula) {
      throw new Error('Debe establecer la carátula antes de generar');
    }

    const caratulaXml = this._renderCaratula();
    const resumenXml = this._renderResumen();
    const detalleXml = this._renderDetalle();

    const schemaLoc = 'http://www.sii.cl/SiiDte LibroGuia_v10.xsd';
    const tmstFirma = this._getTmstFirma();
    
    const xmlSinFirma = `<?xml version="1.0" encoding="ISO-8859-1"?>\n` +
      `<LibroGuia xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${schemaLoc}" version="1.0">` +
      `<EnvioLibro ID="${this.id}">${caratulaXml}${resumenXml}${detalleXml}<TmstFirma>${tmstFirma}</TmstFirma></EnvioLibro>` +
      `</LibroGuia>`;

    // Usar firmar() heredado de LibroBase
    this.xml = this.firmar(xmlSinFirma, 'EnvioLibro', 'LibroGuia');
    return this.xml;
  }

  _renderCaratula(includeVersion = false) {
    const c = this.caratula || {};
    const fields = [
      'RutEmisorLibro',
      'RutEnvia',
      'PeriodoTributario',
      'FchResol',
      'NroResol',
      'TipoLibro',
      'TipoEnvio',
      'FolioNotificacion',
    ];
    
    let xml = includeVersion ? '<Caratula version="1.0">' : '<Caratula>';
    for (const f of fields) {
      if (f === 'NroResol') {
        xml += `<NroResol>${this._escapeXmlText(String(c.NroResol !== undefined ? c.NroResol : '0'))}</NroResol>`;
        continue;
      }
      if (c[f] !== undefined && c[f] !== null && c[f] !== '') {
        xml += `<${f}>${this._escapeXmlText(String(c[f]))}</${f}>`;
      }
    }
    xml += '</Caratula>';
    return xml;
  }

  _renderResumen() {
    const resumen = this._buildResumenPeriodo();
    if (!resumen) return '';
    
    const order = [
      'TotFolAnulado',
      'TotGuiaAnulada',
      'TotGuiaVenta',
      'TotMntGuiaVta',
      'TotTraslado',
    ];
    
    let xml = '<ResumenPeriodo>';
    order.forEach((key) => {
      const value = resumen[key];
      if (value === undefined || value === null || value === '' || value === false) return;
      
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
          }
        });
      } else {
        xml += `<${key}>${this._escapeXmlText(String(value))}</${key}>`;
      }
    });
    xml += '</ResumenPeriodo>';
    return xml;
  }

  _renderDetalle() {
    if (!this.detalle.length) return '';
    
    const order = [
      'Folio', 'Anulado', 'Operacion', 'TpoOper', 'FchDoc', 'RUTDoc',
      'RznSoc', 'MntNeto', 'TasaImp', 'IVA', 'MntTotal', 'MntModificado',
      'TpoDocRef', 'FolioDocRef', 'FchDocRef',
    ];
    
    let xml = '';
    for (const d of this.detalle) {
      const normalized = {
        Folio: null,
        Anulado: null,
        Operacion: null,
        TpoOper: null,
        FchDoc: null,
        RUTDoc: null,
        RznSoc: null,
        MntNeto: null,
        TasaImp: 0,
        IVA: 0,
        MntTotal: null,
        MntModificado: null,
        TpoDocRef: null,
        FolioDocRef: null,
        FchDocRef: null,
        ...d,
      };
      
      // Calcular IVA si no existe
      if ((!normalized.IVA || Number(normalized.IVA) === 0) && normalized.TasaImp && normalized.MntNeto) {
        const neto = Number(normalized.MntNeto);
        const tasa = Number(normalized.TasaImp);
        if (Number.isFinite(neto) && Number.isFinite(tasa)) {
          normalized.IVA = Math.round(neto * (tasa / 100));
        }
      }
      
      // Calcular MntTotal si no existe
      if (normalized.MntTotal === null || normalized.MntTotal === undefined || normalized.MntTotal === '') {
        const neto = Number(normalized.MntNeto) || 0;
        const iva = Number(normalized.IVA) || 0;
        normalized.MntTotal = neto + iva;
      }

      xml += '<Detalle>';
      order.forEach((key) => {
        const value = normalized[key];
        if (value === undefined || value === null || value === '' || value === false) return;
        xml += `<${key}>${this._escapeXmlText(String(value))}</${key}>`;
      });
      xml += '</Detalle>';
    }
    return xml;
  }

  _buildResumenPeriodo() {
    if (!this.detalle.length) return null;
    
    const resumen = {
      TotFolAnulado: false,
      TotGuiaAnulada: false,
      TotGuiaVenta: 0,
      TotMntGuiaVta: 0,
      TotTraslado: false,
    };

    for (const d of this.detalle) {
      const anulado = Number(d.Anulado);
      if (anulado === 1 || anulado === 2) {
        if (anulado === 1) {
          resumen.TotFolAnulado = (resumen.TotFolAnulado || 0) + 1;
        } else {
          resumen.TotGuiaAnulada = (resumen.TotGuiaAnulada || 0) + 1;
        }
        continue;
      }

      const tpoOper = Number(d.TpoOper);
      const mntTotal = Number(d.MntTotal || 0);
      
      if (tpoOper === 1) {
        resumen.TotGuiaVenta += 1;
        resumen.TotMntGuiaVta += mntTotal;
      } else if (!Number.isNaN(tpoOper)) {
        if (!resumen.TotTraslado) resumen.TotTraslado = [];
        let item = resumen.TotTraslado.find((t) => Number(t.TpoTraslado) === tpoOper);
        if (!item) {
          item = { TpoTraslado: tpoOper, CantGuia: 0, MntGuia: 0 };
          resumen.TotTraslado.push(item);
        }
        item.CantGuia += 1;
        item.MntGuia += mntTotal;
      }
    }

    return resumen;
  }
}

module.exports = LibroGuia;
