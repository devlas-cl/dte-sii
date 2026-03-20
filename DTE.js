// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Documento Tributario Electrónico
 * 
 * Genera, timbra y firma documentos tributarios electrónicos
 */

const crypto = require('crypto');
const { XMLBuilder } = require('fast-xml-parser');
const { DOMParser } = require('@xmldom/xmldom');
const {
  sanitizeSiiText,
  formatBase64InXml,
  normalizeEmisor,
  normalizeReceptor,
  calcularTotalesDesdeDetalle,
  TASA_IVA_DEFAULT,
  TIPOS_BOLETA,
  TASA_IVA,
} = require('./utils');
const { serializeNode, fixEntities, escapeAttr, escapeText, buildSignedInfo, buildSignature } = require('./utils/c14n');

// ============================================
// CONSTANTES
// ============================================

// Según schema SII EnvioDTE_v10.xsd, el orden de campos en IdDoc es:
// TipoDTE, Folio, FchEmis, IndNoRebaja, TipoDespacho, IndTraslado, TpoImpresion,
// IndServicio, MntBruto, TpoTranCompra, TpoTranVenta, FmaPago, FmaPagExp, ...
const CAMPOS_IDDOC_OPCIONALES = [
  'IndNoRebaja', 'TipoDespacho', 'IndTraslado', 'TpoImpresion', 'IndServicio',
  'MntBruto', 'TpoTranCompra', 'TpoTranVenta', 'FmaPago', 'FmaPagExp',
  'FchCancel', 'MntCancel', 'SaldoInsol', 'MntPagos', 'FchVenc',
  'PeriodoDesde', 'PeriodoHasta', 'MedioPago', 'TpoCtaPago', 'NumCtaPago',
  'BcoPago', 'TermPagoCdg', 'TermPagoGlosa', 'TermPagoDias', 'FchVencPago',
  'IndMntNeto',
];

// ============================================
// CLASE DTE
// ============================================

class DTE {
  /**
   * @param {Object} datos - Datos del DTE (simplificado o estructurado)
   */
  constructor(datos) {
    if (this._esFormatoSimplificado(datos)) {
      this.datos = this._convertirDatosSimplificados(datos);
      this._certificado = datos.certificado;
      this._caf = datos.caf;
    } else {
      this.datos = datos;
    }
    
    this.montoTotal = this.datos.Encabezado?.Totales?.MntTotal || 0;
    this.fechaEmision = this.datos.Encabezado?.IdDoc?.FchEmis;
    this.xml = null;
    this.tedXml = null;
    this.tmstFirma = null;
  }
  
  _esFormatoSimplificado(datos) {
    return datos.tipo !== undefined && datos.folio !== undefined;
  }
  
  // ============================================
  // CONVERSIÓN DE DATOS
  // ============================================
  
  _convertirDatosSimplificados(d) {
    const esExenta = d.tipo === 41;
    const { detalle, mntBruto, mntExento } = this._procesarItems(d.items, esExenta);
    const totales = this._calcularTotales(mntBruto, mntExento, esExenta);
    
    const resultado = {
      Encabezado: {
        IdDoc: {
          TipoDTE: d.tipo,
          Folio: d.folio,
          FchEmis: d.fechaEmision,
          IndServicio: d.indServicio || 3,
        },
        Emisor: d.emisor,
        Receptor: {
          RUTRecep: d.receptor?.RUTRecep ?? '66666666-6',
          RznSocRecep: sanitizeSiiText(d.receptor?.RznSocRecep ?? 'Consumidor Final'),
          DirRecep: sanitizeSiiText(d.receptor?.DirRecep ?? 'Sin Direccion'),
          CmnaRecep: d.receptor?.CmnaRecep ?? 'Santiago',
        },
        Totales: totales,
      },
      Detalle: detalle,
    };
    
    if (d.referencia) {
      resultado.Referencia = {
        NroLinRef: d.referencia.NroLinRef || 1,
        CodRef: d.referencia.CodRef || d.referencia.codigo,
        RazonRef: d.referencia.RazonRef || d.referencia.razon,
      };
    }
    
    return resultado;
  }
  
  _procesarItems(items, esExenta) {
    let mntBruto = 0;
    let mntExento = 0;
    
    const detalle = items.map((item, idx) => {
      const qty = item.QtyItem || 1;
      const prc = item.PrcItem;
      const montoItem = Math.round(qty * prc);
      
      if (esExenta || item.IndExe === 1) {
        mntExento += montoItem;
      } else {
        mntBruto += montoItem;
      }
      
      const det = {
        NroLinDet: idx + 1,
        ...(esExenta || item.IndExe ? { IndExe: 1 } : {}),
        NmbItem: sanitizeSiiText(item.NmbItem),
        QtyItem: qty,
        ...(item.UnmdItem ? { UnmdItem: item.UnmdItem } : {}),
        PrcItem: prc,
        MontoItem: montoItem,
      };
      
      return det;
    });
    
    return { detalle, mntBruto, mntExento };
  }
  
  _calcularTotales(mntBruto, mntExento, esExenta) {
    const mntNeto = esExenta ? 0 : Math.round(mntBruto / (1 + (TASA_IVA / 100)));
    const iva = esExenta ? 0 : (mntBruto - mntNeto);
    const mntTotal = mntNeto + iva + mntExento;
    
    const totales = {};
    if (mntNeto > 0) totales.MntNeto = mntNeto;
    if (mntExento > 0) totales.MntExe = mntExento;
    if (mntNeto > 0) totales.IVA = iva;
    totales.MntTotal = mntTotal;
    
    return totales;
  }
  
  // ============================================
  // GENERACIÓN XML
  // ============================================
  
  generarXML() {
    const enc = this.datos.Encabezado;
    const det = this.datos.Detalle;
    const tipoDte = Number(enc.IdDoc.TipoDTE);
    const esBoleta = TIPOS_BOLETA.includes(tipoDte);
    
    this.id = `DTE_T${tipoDte}F${enc.IdDoc.Folio}`;
    
    const idDoc = this._buildIdDoc(enc.IdDoc, esBoleta);
    const emisor = this._buildEmisor(enc.Emisor, esBoleta);
    const receptor = this._buildReceptor(enc.Receptor, esBoleta);
    const detalle = this._buildDetalle(det);
    
    this.documento = {
      Documento: {
        '@_ID': this.id,
        Encabezado: { IdDoc: idDoc, Emisor: emisor, Receptor: receptor, Totales: enc.Totales },
        Detalle: detalle,
        ...(this.datos.DscRcgGlobal ? { DscRcgGlobal: this.datos.DscRcgGlobal } : {}),
        ...(this.datos.Referencia ? { Referencia: this.datos.Referencia } : {}),
        TED: null,
      }
    };
    
    return this;
  }
  
  _buildIdDoc(idDoc, esBoleta) {
    const result = {
      TipoDTE: idDoc.TipoDTE,
      Folio: idDoc.Folio,
      FchEmis: idDoc.FchEmis,
    };
    
    CAMPOS_IDDOC_OPCIONALES.forEach(campo => {
      if (idDoc[campo] !== undefined && idDoc[campo] !== null) {
        result[campo] = idDoc[campo];
      }
    });
    
    if (esBoleta && !result.IndServicio) {
      result.IndServicio = 3;
    }
    
    return result;
  }
  
  _buildEmisor(emisor, esBoleta) {
    return normalizeEmisor(emisor, esBoleta);
  }
  
  _buildReceptor(receptor, esBoleta) {
    return normalizeReceptor(receptor, esBoleta);
  }
  
  _buildDetalle(det) {
    return (Array.isArray(det) ? det : [det]).map(item => ({
      ...item,
      NmbItem: sanitizeSiiText(item.NmbItem),
      ...(item.DscItem ? { DscItem: sanitizeSiiText(item.DscItem) } : {}),
    }));
  }
  
  // ============================================
  // TIMBRAJE (TED)
  // ============================================
  
  timbrar(caf, timestampOverride) {
    const enc = this.datos.Encabezado;
    const det = this.datos.Detalle;
    const primerItem = Array.isArray(det) ? det[0] : det;
    const tipoDte = Number(enc.IdDoc.TipoDTE);
    const esBoleta = TIPOS_BOLETA.includes(tipoDte);
    
    this.tmstFirma = timestampOverride || new Date().toISOString().replace(/\.\d{3}Z$/, '');
    
    const rznRecepRaw = sanitizeSiiText((enc.Receptor.RznSocRecep || '').substring(0, 40));
    const it1Raw = sanitizeSiiText((primerItem.NmbItem || 'Producto').substring(0, 40));
    const rznRecepXml = this._escapeXmlText(rznRecepRaw);
    const it1Xml = this._escapeXmlText(it1Raw);
    
    const dd = {
      RE: enc.Emisor.RUTEmisor,
      TD: enc.IdDoc.TipoDTE,
      F: enc.IdDoc.Folio,
      FE: enc.IdDoc.FchEmis,
      RR: enc.Receptor.RUTRecep || (esBoleta ? '' : undefined),
      MNT: enc.Totales.MntTotal,
      CAF: caf.getCafXml(),
      TSTED: this.tmstFirma,
    };
    
    const ddString = this._buildDDString(dd, rznRecepXml, it1Xml);
    const firma = caf.sign(ddString);
    
    this.tedXml = `<TED version="1.0"><DD><RE>${dd.RE}</RE><TD>${dd.TD}</TD><F>${dd.F}</F><FE>${dd.FE}</FE><RR>${dd.RR}</RR><RSR>${rznRecepXml}</RSR><MNT>${dd.MNT}</MNT><IT1>${it1Xml}</IT1>${dd.CAF}<TSTED>${dd.TSTED}</TSTED></DD><FRMT algoritmo="SHA1withRSA">${firma}</FRMT></TED>`;
    
    this.documento.Documento.TED = '__TED_PLACEHOLDER__';
    this.documento.Documento.TmstFirma = '__TMSTFIRMA_PLACEHOLDER__';
    
    return this;
  }
  
  _buildDDString(dd, rsrXml, it1Xml) {
    return `<DD><RE>${dd.RE}</RE><TD>${dd.TD}</TD><F>${dd.F}</F><FE>${dd.FE}</FE><RR>${dd.RR}</RR><RSR>${rsrXml}</RSR><MNT>${dd.MNT}</MNT><IT1>${it1Xml}</IT1>${dd.CAF}<TSTED>${dd.TSTED}</TSTED></DD>`;
  }
  
  _escapeXmlText(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  
  // ============================================
  // FIRMA ELECTRÓNICA
  // ============================================
  
  firmar(certificado) {
    const dteXml = this._buildXmlSinFirma();
    const doc = new DOMParser().parseFromString(dteXml, 'application/xml');
    
    // Canonicalizar documento
    const documentoC14N = this._c14nDocumento(doc);
    const documentoC14NBytes = Buffer.from(documentoC14N, 'utf8');
    const digestValue = crypto.createHash('sha1').update(documentoC14NBytes).digest('base64');
    
    // Construir SignedInfo (usando c14n centralizado)
    const signedInfoParaFirmar = buildSignedInfo(this.id, digestValue, { expandTags: true, includeXsi: true });
    const signedInfoParaGuardar = buildSignedInfo(this.id, digestValue, { expandTags: false, includeXsi: false });
    
    // Firmar
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(Buffer.from(signedInfoParaFirmar, 'utf8'));
    const signatureValue = sign.sign(certificado.getPrivateKeyPem(), 'base64');
    const formattedSignature = signatureValue.match(/.{1,76}/g).join('\n');
    
    // Construir Signature (usando c14n centralizado)
    const signatureXml = buildSignature(signedInfoParaGuardar, formattedSignature, {
      modulus: certificado.getModulus(),
      exponent: certificado.getExponent(),
      certificate: certificado.getCertificateBase64(),
    });
    
    // Insertar firma
    const xmlFirmado = dteXml.replace('</Documento></DTE>', `</Documento>${signatureXml}</DTE>`);
    this.xml = formatBase64InXml(xmlFirmado);
    
    return this;
  }
  
  // NOTA: _buildSignedInfo y _buildSignature movidos a utils/c14n.js (v2.6.0)
  
  _buildXmlSinFirma() {
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: false,
    });

    const dteConVersion = {
      '@_xmlns': 'http://www.sii.cl/SiiDte',
      '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@_version': '1.0',
      ...this.documento
    };

    let dteXml = builder.build({ DTE: dteConVersion });
    dteXml = dteXml.replace('<TED>__TED_PLACEHOLDER__</TED>', this.tedXml);
    dteXml = dteXml.replace('<TmstFirma>__TMSTFIRMA_PLACEHOLDER__</TmstFirma>', `<TmstFirma>${this.tmstFirma}</TmstFirma>`);

    return dteXml;
  }
  
  // ============================================
  // CANONICALIZACIÓN (C14N) - Usa utils/c14n.js
  // ============================================
  
  _c14nDocumento(doc) {
    const documento = doc.getElementsByTagName('Documento')[0];
    const dteRoot = doc.getElementsByTagName('DTE')[0];
    if (!documento) return '';

    const inheritedNs = new Map();
    if (dteRoot) {
      const defaultNs = dteRoot.getAttribute('xmlns');
      if (defaultNs) inheritedNs.set('xmlns', defaultNs);
      const xsiNs = dteRoot.getAttribute('xmlns:xsi');
      if (xsiNs) inheritedNs.set('xmlns:xsi', xsiNs);
    }

    let c14n = '<Documento';
    if (inheritedNs.has('xmlns')) c14n += ` xmlns="${inheritedNs.get('xmlns')}"`;
    if (inheritedNs.has('xmlns:xsi')) c14n += ` xmlns:xsi="${inheritedNs.get('xmlns:xsi')}"`;
    const id = documento.getAttribute('ID');
    if (id) c14n += ` ID="${id}"`;
    c14n += '>';

    for (let i = 0; i < documento.childNodes.length; i++) {
      c14n += serializeNode(documento.childNodes[i], inheritedNs);
    }

    c14n += '</Documento>';
    return fixEntities(c14n);
  }
  
  // ============================================
  // GETTERS
  // ============================================
  
  getXML() { return this.xml; }
  getXMLSinFirma() { return this._buildXmlSinFirma(); }
  getTED() { return this.tedXml; }
  getId() { return this.id; }
  
  /**
   * Obtiene el tipo de DTE
   * @returns {number}
   */
  getTipoDTE() {
    return Number(this.datos?.Encabezado?.IdDoc?.TipoDTE);
  }
  
  /**
   * Obtiene el folio del documento
   * @returns {number}
   */
  getFolio() {
    return Number(this.datos?.Encabezado?.IdDoc?.Folio);
  }
  
  /**
   * Obtiene el monto total del documento
   * @returns {number}
   */
  getMontoTotal() {
    return Number(this.datos?.Encabezado?.Totales?.MntTotal || 0);
  }
}

module.exports = DTE;
