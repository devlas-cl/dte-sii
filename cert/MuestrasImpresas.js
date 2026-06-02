// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * MuestrasImpresas.js
 * 
 * Módulo para generar PDFs de muestras impresas según Manual SII v4.0
 * para la etapa "Documentos Impresos" del proceso de certificación.
 * 
 * Especificaciones:
 *   - Dimensiones: 21.5x11 cm (mín) a 21.5x33 cm (máx)
 *   - Borde sin letras: 0.5 cm mínimo
 *   - Recuadro tipo DTE: 1.5x5.5 cm (mín) a 4x8 cm (máx), negro/rojo
 *   - Timbre PDF417: 2x5 cm (mín) a 4x9 cm (máx)
 *   - Timbre a 2 cm mínimo del borde izquierdo
 * 
 * @module dte-sii/cert/MuestrasImpresas
 */

const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const bwipjs = require('bwip-js');

// Usar constantes del core
const {
  NOMBRES_DTE_IMPRESOS,
  NOMBRES_TRASLADO,
  TIPOS_CEDIBLES,
  TIPOS_NO_CEDIBLES,
  DECLARACION_RECIBO,
} = require('../utils/constants');
const { normalizeArray } = require('../index');

// Sets para lookup rápido
const CEDIBLE_TIPOS = new Set(TIPOS_CEDIBLES);
const NO_CEDIBLE_TIPOS = new Set(TIPOS_NO_CEDIBLES);

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const safeText = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const formatMonto = (value) => {
  if (!value) return '0';
  return Number(value).toLocaleString('es-CL');
};

// ═══════════════════════════════════════════════════════════════
// Constantes de layout PDF (SII Manual Muestras Impresas v3.0)
// 1 cm = 28.3465 puntos tipográficos (pt)
// ═══════════════════════════════════════════════════════════════

const PDF_LAYOUT = {
  page: {
    width:     609.45,   // 21.5 cm — ancho estándar hoja SII
    minHeight: 311.81,   // 11.0 cm — mínimo SII
    maxHeight: 935.43,   // 33.0 cm — máximo SII
  },
  margin:      14.17,    // 0.5 cm mínimo SII en todos los bordes

  gap: {
    section:   10,
    line:      13,
    small:      6,
    tiny:       4,
  },

  recuadro: {
    width:     155.91,   // 5.5 cm — mínimo SII
    minHeight:  42.52,   // 1.5 cm — mínimo SII
    maxHeight: 113.39,   // 4.0 cm — máximo SII
    border:     1.5,     // 0.5–1 mm según SII; usamos valor medio
    padX:       8,
    padY:       6,
  },

  ted: {
    minWidth:  141.73,   // 5.0 cm — mínimo SII
    minHeight:  56.69,   // 2.0 cm — mínimo SII
    maxWidth:  255.12,   // 9.0 cm — máximo SII
    maxHeight: 113.39,   // 4.0 cm — máximo SII
    marginLeft: 56.69,   // 2.0 cm desde borde izquierdo (mínimo SII)
    legendGap:   5,
  },

  font: {
    razonSocial: 11,
    normal:      10,
    small:        9,
    tiny:         8,
    legal:        7,
    legend:       7,
  },

  lineH: {
    normal: 13,
    small:  11,
    tiny:   10,
    legal:   9,
  },

  table: {
    rowH:    12,
    headerH: 14,
    padX:     3,
    padY:     2,
  },

  acuse: {
    padX:     8,
    padY:     8,
    fieldH:  14,
  },
};

/**
 * Formatea RUT con separador de miles '.' según convención chilena SII.
 * Ej: "12345678-9" → "12.345.678-9"
 */
function _formatRutConPuntos(rut) {
  if (!rut) return '';
  const str = String(rut).trim().replace(/\./g, '');
  const idx  = str.lastIndexOf('-');
  if (idx === -1) return str;
  const num  = str.slice(0, idx);
  const dv   = str.slice(idx + 1);
  const formatted = num.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formatted}-${dv}`;
}

class MuestrasImpresas {
  /**
   * @param {Object} options
   * @param {Object} options.emisor - Datos del emisor { rut, razonSocial, giro, direccion, comuna }
   * @param {string} [options.siiOficina] - Oficina SII (ej: "S.I.I. - SANTIAGO CENTRO")
   * @param {string} [options.resolucion] - Texto resolución (ej: "Res. Ex. SII N° 0 del 2026")
   * @param {string} [options.logoPath] - Ruta al logo PNG (opcional)
   * @param {string} [options.debugDir] - Directorio para guardar PDFs
   */
  constructor({ emisor, siiOficina, resolucion, logoPath, debugDir }) {
    this.emisor = emisor;
    this.siiOficina = siiOficina || 'S.I.I. - SANTIAGO CENTRO';
    this.resolucion = resolucion || `Res. Ex. SII N° 0 del ${new Date().getFullYear()}`;
    this.logoDataUri = this._loadLogo(logoPath);
    this.debugDir = debugDir;
  }

  /**
   * Carga logo como data URI
   * @private
   */
  _loadLogo(logoPath) {
    if (!logoPath) return '';
    const resolved = path.resolve(logoPath);
    if (!fs.existsSync(resolved)) return '';
    const ext = path.extname(resolved).toLowerCase().replace('.', '') || 'png';
    const data = fs.readFileSync(resolved);
    return `data:image/${ext};base64,${data.toString('base64')}`;
  }

  /**
   * Parsea un EnvioDTE XML y extrae los documentos
   * @param {string} xml - XML del EnvioDTE (en UTF-8)
   * @returns {Object[]} Array de documentos parseados
   */
  parseEnvioDTE(xml) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      parseTagValue: true,
    });

    const data = parser.parse(xml);
    const envio = data?.EnvioDTE || data?.EnvioDTEB || data?.EnvioDTETraslado || data?.EnvioBOLETA || {};
    const setDte = envio?.SetDTE || data?.SetDTE || {};
    const dtes = normalizeArray(setDte?.DTE);

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: false,
    });

    // Extraer TEDs directamente del XML original
    // El TED debe extraerse exactamente como está en el XML para preservar la firma
    const extractTedsFromOriginal = (originalXml) => {
      const teds = [];
      const tedRegex = /<TED[^>]*>[\s\S]*?<\/TED>/g;
      let match;
      while ((match = tedRegex.exec(originalXml)) !== null) {
        teds.push(match[0]);
      }
      return teds;
    };

    // Extraer TEDs del XML como UTF-8 (que es el encoding real del archivo)
    const tedsOriginales = extractTedsFromOriginal(xml);

    const extractTedValue = (ted, tag) => {
      if (!ted) return '';
      const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`);
      const match = ted.match(regex);
      return match ? match[1] : '';
    };

    return dtes.map((dte, idx) => {
      const doc = dte?.Documento || dte?.DTE?.Documento || {};
      const encabezado = doc?.Encabezado || {};
      const idDoc = encabezado?.IdDoc || {};
      const emisor = encabezado?.Emisor || {};
      const receptor = encabezado?.Receptor || {};
      const totales = encabezado?.Totales || {};
      const transporte = encabezado?.Transporte || {};
      const detalle = toArray(doc?.Detalle);
      const referencias = toArray(doc?.Referencia);
      const descuentosGlobales = toArray(doc?.DscRcgGlobal);

      // Obtener TED original del XML (preserva encoding ISO-8859-1 para firma válida)
      // Buscar el TED que corresponda al folio de este documento
      const docFolio = idDoc?.Folio?.toString?.() || '';
      const docTipo = idDoc?.TipoDTE?.toString?.() || '';
      
      let tedXml = '';
      // Buscar TED original que coincida con este documento
      for (const ted of tedsOriginales) {
        const tedFolio = extractTedValue(ted, 'F');
        const tedTipo = extractTedValue(ted, 'TD');
        if (tedFolio === docFolio && tedTipo === docTipo) {
          tedXml = ted;
          break;
        }
      }
      
      // Fallback: si no encontramos, usar siguiente TED disponible en orden
      if (!tedXml && tedsOriginales.length > idx) {
        tedXml = tedsOriginales[idx];
      }

      const tipoDteTed = Number(extractTedValue(tedXml, 'TD') || 0);
      const folioTed = extractTedValue(tedXml, 'F');
      const fechaTed = extractTedValue(tedXml, 'FE');

      const tipoDte = Number(idDoc?.TipoDTE || tipoDteTed || 0);
      const folio = (idDoc?.Folio?.toString?.() ?? '') || folioTed || '';
      const fechaEmision = (idDoc?.FchEmis?.toString?.() ?? '') || fechaTed || '';
      const indTraslado = idDoc?.IndTraslado ? Number(idDoc.IndTraslado) : null;

      return {
        tipoDte,
        folio,
        fechaEmision,
        indTraslado,
        emisor,
        receptor,
        totales,
        transporte,
        detalle,
        referencias,
        descuentosGlobales,
        tedXml,
      };
    });
  }

  /**
   * Genera código de barras PDF417 del TED
   * El PDF417 debe contener exactamente los mismos bytes que se usaron para firmar el TED.
   * 
   * La firma en CAF.sign() usa forge con 'latin1', lo que toma cada codepoint Unicode
   * del string JavaScript y lo usa directamente como byte. Por ejemplo:
   * - 'ñ' (U+00F1 = 241) → byte 0xF1
   * - 'ó' (U+00F3 = 243) → byte 0xF3
   * 
   * El SII espera que el PDF417 contenga estos mismos bytes (ISO-8859-1).
   * Si pasamos el string directamente a bwip-js, internamente lo convierte a UTF-8:
   * - 'ñ' → bytes 0xC3 0xB1 (UTF-8)
   * Esto causa que el SII vea "Ã±" en lugar de "ñ" → firma inválida.
   * 
   * Solución: Convertir el string a Buffer con encoding 'latin1' para que
   * cada codepoint Unicode se mapee directamente a un byte (codepoint → byte),
   * luego convertir de vuelta a string binary para que bwip-js lo acepte.
   * 
   * @param {string} tedXml - XML del TED
   * @returns {Promise<string>} Data URI de la imagen PNG
   */
  async generarPdf417(tedXml, height = 12) {
    if (!tedXml || !tedXml.includes('<TED')) {
      throw new Error('No se encontró TED para generar PDF417');
    }

    // Convertir string a Buffer con encoding 'latin1' y luego a string 'binary'
    // Esto asegura que cada codepoint Unicode se convierta a exactamente un byte
    // y que bwip-js reciba un string con esos bytes
    const latin1Buffer = Buffer.from(tedXml, 'latin1');
    const binaryString = latin1Buffer.toString('binary');
    
    const buffer = await bwipjs.toBuffer({
      bcid: 'pdf417',
      text: binaryString,
      scale: 3,
      height,
      padding: 6,
      includetext: false,
      // CRÍTICO: Indicar a bwip-js que el texto ya está en formato binario 8-bit
      // Sin esto, bwip-js convierte el string a UTF-8 internamente, lo que
      // causa que ñ (0xF1) se convierta a 0xC3 0xB1 y la firma falle
      binarytext: true,
    });

    return `data:image/png;base64,${buffer.toString('base64')}`;
  }

  /**
   * Construye HTML de la muestra impresa según Manual SII
   * @private
   */
  _buildHtml({ doc, esCedible, tedDataUri }) {
    const tipoNombre = NOMBRES_DTE_IMPRESOS[doc.tipoDte] || `DTE ${doc.tipoDte}`;
    const puedeSerCedible = CEDIBLE_TIPOS.has(doc.tipoDte);
    const esNota = NO_CEDIBLE_TIPOS.has(doc.tipoDte);
    
    // Guía con traslado interno no tiene cedible
    const esGuiaInterna = doc.tipoDte === 52 && [5, 6].includes(doc.indTraslado);
    const mostrarCedible = esCedible && puedeSerCedible && !esGuiaInterna;
    const cedibleTexto = doc.tipoDte === 52 ? 'CEDIBLE CON SU FACTURA' : 'CEDIBLE';

    const emisor = doc.emisor || {};
    const receptor = doc.receptor || {};
    const totales = doc.totales || {};

    // Detalle con descuentos
    const detallesHtml = doc.detalle.map((item, idx) => {
      const descuento = item?.DescuentoMonto || item?.DescuentoPct ? 
        `<br><small>Dcto: ${item.DescuentoMonto ? '$' + formatMonto(item.DescuentoMonto) : item.DescuentoPct + '%'}</small>` : '';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${safeText(item?.CdgItem?.VlrCodigo || item?.CdgItem || '')}</td>
          <td>${safeText(item?.NmbItem || '')}${descuento}</td>
          <td class="num">${item?.QtyItem ?? ''}</td>
          <td>${safeText(item?.UnmdItem || 'UN')}</td>
          <td class="num">${item?.PrcItem ? '$' + formatMonto(item.PrcItem) : ''}</td>
          <td class="num">${item?.MontoItem ? '$' + formatMonto(item.MontoItem) : ''}</td>
        </tr>
      `;
    }).join('');

    // Referencias
    const refsHtml = doc.referencias.length
      ? `
        <div class="seccion">
          <div class="seccion-titulo">Referencias a otros documentos</div>
          <table class="refs">
            <thead>
              <tr><th>Tipo Documento</th><th>Folio</th><th>Fecha</th><th>Razón Referencia</th></tr>
            </thead>
            <tbody>
              ${doc.referencias.map((ref) => {
                const tipoRef = ref?.TpoDocRef ? (NOMBRES_DTE_IMPRESOS[ref.TpoDocRef] || `Tipo ${ref.TpoDocRef}`) : '';
                return `
                  <tr>
                    <td>${safeText(tipoRef)}</td>
                    <td>${safeText(ref?.FolioRef || '')}</td>
                    <td>${safeText(ref?.FchRef || '')}</td>
                    <td>${safeText(ref?.RazonRef || '')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `
      : '';

    // Tipo de traslado para guías
    const trasladoHtml = doc.tipoDte === 52 && doc.indTraslado
      ? `<div class="traslado"><strong>Tipo de Traslado:</strong> ${doc.indTraslado} - ${NOMBRES_TRASLADO[doc.indTraslado] || ''}</div>`
      : '';

    // Descuentos globales
    const dctoGlobalHtml = doc.descuentosGlobales.length
      ? doc.descuentosGlobales.map((dg) => {
          const esDesc = dg?.TpoMov === 'D';
          const label = esDesc ? 'Descuento Global' : 'Recargo Global';
          const valor = dg?.ValorDR ? '$' + formatMonto(dg.ValorDR) : (dg?.PctDR ? dg.PctDR + '%' : '');
          return `<tr><td>${label}</td><td class="num">${valor}</td></tr>`;
        }).join('')
      : '';

    // Totales según tipo de documento
    let totalesHtml = '';
    const esExenta = doc.tipoDte === 34;
    
    if (esExenta) {
      totalesHtml = `
        ${totales?.MntExe ? `<tr><td>Monto Exento</td><td class="num">$${formatMonto(totales.MntExe)}</td></tr>` : ''}
        ${totales?.MntTotal ? `<tr><td><strong>Monto Total</strong></td><td class="num"><strong>$${formatMonto(totales.MntTotal)}</strong></td></tr>` : ''}
      `;
    } else {
      totalesHtml = `
        ${dctoGlobalHtml}
        ${totales?.MntNeto ? `<tr><td>Monto Neto</td><td class="num">$${formatMonto(totales.MntNeto)}</td></tr>` : ''}
        ${totales?.MntExe ? `<tr><td>Monto Exento</td><td class="num">$${formatMonto(totales.MntExe)}</td></tr>` : ''}
        ${totales?.IVA ? `<tr><td>IVA (${totales?.TasaIVA || 19}%)</td><td class="num">$${formatMonto(totales.IVA)}</td></tr>` : ''}
        ${totales?.MntTotal ? `<tr><td><strong>Monto Total</strong></td><td class="num"><strong>$${formatMonto(totales.MntTotal)}</strong></td></tr>` : ''}
      `;
    }

    // Acuse de recibo (solo en cedible y tipos que aplican)
    const acuseHtml = mostrarCedible && !esNota
      ? `
        <div class="acuse">
          <table class="acuse-tabla">
            <tr>
              <td width="50%">Nombre: _______________________________</td>
              <td width="50%">R.U.T.: _______________________________</td>
            </tr>
            <tr>
              <td>Fecha: _______________________________</td>
              <td>Recinto: _______________________________</td>
            </tr>
            <tr>
              <td colspan="2">Firma: _______________________________</td>
            </tr>
          </table>
          <div class="acuse-leyenda">${DECLARACION_RECIBO}</div>
        </div>
      `
      : '';

    return `
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<style>
  @page { size: 215mm 280mm; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #000; margin: 0; padding: 0; line-height: 1.3; }
  
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
  .emisor-info { flex: 1; }
  .emisor-info .razon-social { font-size: 12px; font-weight: bold; margin-bottom: 3px; }
  .emisor-info .giro { margin-bottom: 2px; }
  .logo { max-width: 60mm; max-height: 15mm; margin-bottom: 5px; }
  
  .recuadro { border: 1.5px solid #C00; padding: 8px 12px; text-align: center; width: 55mm; min-height: 15mm; }
  .recuadro .rut { font-size: 11px; font-weight: bold; color: #C00; }
  .recuadro .tipo { font-size: 10px; font-weight: bold; color: #C00; margin: 4px 0; }
  .recuadro .folio { font-size: 11px; font-weight: bold; color: #C00; }
  .recuadro-sii { font-size: 9px; color: #C00; margin-top: 3px; text-align: center; }
  
  .receptor { border: 1px solid #999; padding: 8px; margin: 10px 0; font-size: 9px; }
  .receptor-row { margin: 2px 0; }
  .receptor-label { font-weight: bold; }
  
  .fecha-emision { font-size: 10px; margin: 8px 0; }
  .traslado { font-size: 9px; margin: 5px 0; padding: 4px; background: #f5f5f5; }
  
  .seccion { margin: 10px 0; }
  .seccion-titulo { font-weight: bold; font-size: 10px; margin-bottom: 5px; border-bottom: 1px solid #000; padding-bottom: 2px; }
  
  table { width: 100%; border-collapse: collapse; }
  .detalle th, .detalle td { border: 1px solid #666; padding: 3px 4px; font-size: 9px; }
  .detalle th { background: #e0e0e0; font-weight: bold; }
  .refs th, .refs td { border: 1px solid #999; padding: 2px 4px; font-size: 8px; }
  .refs th { background: #f0f0f0; }
  .num { text-align: right; }
  
  .totales-container { display: flex; justify-content: flex-end; margin-top: 10px; }
  .totales { width: 45%; }
  .totales td { padding: 3px 6px; font-size: 10px; border: 1px solid #999; }
  
  .acuse { border: 1px solid #000; padding: 8px; margin-top: 15px; font-size: 9px; }
  .acuse-tabla { border: none; }
  .acuse-tabla td { border: none; padding: 4px 0; }
  .acuse-leyenda { margin-top: 8px; font-size: 8px; text-align: justify; border-top: 1px solid #999; padding-top: 5px; }
  
  .timbre-container { margin-top: 15px; margin-left: 20mm; display: flex; align-items: flex-start; gap: 10px; }
  .timbre-img { width: 50mm; height: auto; }
  .timbre-text { font-size: 8px; }
  .timbre-text div { margin: 2px 0; }
  
  .cedible-marca { font-weight: bold; font-size: 12px; text-align: right; margin-top: 10px; }
</style>
</head>
<body>
  <div class="header">
    <div class="emisor-info">
      ${this.logoDataUri ? `<img class="logo" src="${this.logoDataUri}" />` : ''}
      <div class="razon-social">${safeText(emisor?.RznSoc || emisor?.RznSocEmisor || '')}</div>
      <div class="giro">${safeText(emisor?.GiroEmis || '')}</div>
      <div>Casa Matriz: ${safeText(emisor?.DirOrigen || '')}${emisor?.CmnaOrigen ? ', ' + safeText(emisor.CmnaOrigen) : ''}</div>
      ${emisor?.Sucursal ? `<div>Sucursal: ${safeText(emisor.Sucursal)}</div>` : ''}
    </div>
    <div>
      <div class="recuadro">
        <div class="rut">R.U.T.: ${safeText(emisor?.RUTEmisor || '').replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.')}</div>
        <div class="tipo">${safeText(tipoNombre)}</div>
        <div class="folio">N° ${safeText(doc.folio)}</div>
      </div>
      <div class="recuadro-sii">${this.siiOficina}</div>
    </div>
  </div>

  <div class="fecha-emision"><strong>Fecha Emisión:</strong> ${safeText(doc.fechaEmision)}</div>

  <div class="receptor">
    <div class="receptor-row"><span class="receptor-label">Señor(es):</span> ${safeText(receptor?.RznSocRecep || '')} &nbsp;&nbsp;&nbsp; <span class="receptor-label">RUT:</span> ${safeText(receptor?.RUTRecep || '')}</div>
    <div class="receptor-row"><span class="receptor-label">Dirección:</span> ${safeText(receptor?.DirRecep || '')} &nbsp;&nbsp;&nbsp; <span class="receptor-label">Comuna:</span> ${safeText(receptor?.CmnaRecep || '')}</div>
    <div class="receptor-row"><span class="receptor-label">Giro:</span> ${safeText(receptor?.GiroRecep || '')}</div>
  </div>

  ${trasladoHtml}
  ${refsHtml}

  <div class="seccion">
    <div class="seccion-titulo">Detalle</div>
    <table class="detalle">
      <thead>
        <tr>
          <th width="5%">#</th>
          <th width="10%">Código</th>
          <th width="40%">Descripción</th>
          <th width="10%">Cant.</th>
          <th width="8%">Unid.</th>
          <th width="12%">P.Unit.</th>
          <th width="15%">Valor</th>
        </tr>
      </thead>
      <tbody>
        ${detallesHtml}
      </tbody>
    </table>
  </div>

  <div class="totales-container">
    <table class="totales">
      <tbody>
        ${totalesHtml}
      </tbody>
    </table>
  </div>

  ${acuseHtml}

  <div class="timbre-container">
    <img class="timbre-img" src="${tedDataUri}" />
    <div class="timbre-text">
      <div><strong>Timbre Electrónico SII</strong></div>
      <div>${this.resolucion}</div>
      <div>Verifique documento: www.sii.cl</div>
    </div>
  </div>

  ${mostrarCedible ? `<div class="cedible-marca">${cedibleTexto}</div>` : ''}
</body>
</html>
    `;
  }

  /**
   * Genera PDF desde HTML y lo escribe a disco.
   * @private
   */
  // ═══════════════════════════════════════════════════════════════
  // Helpers internos para generarPDFBuffer (pdf-lib, sin Chromium)
  // ═══════════════════════════════════════════════════════════════

  /** Parte texto en líneas que caben dentro de maxWidth usando la fuente dada. */
  _pdfWrapText(text, font, fontSize, maxWidth) {
    const str = String(text || '').trim();
    if (!str) return [''];
    const words  = str.split(' ');
    const lines  = [];
    let   line   = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
        line = test;
      } else {
        if (line) lines.push(line);
        // Palabra sola más larga que maxWidth: dividir por caracteres
        if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
          let chars = '';
          for (const ch of word) {
            if (font.widthOfTextAtSize(chars + ch, fontSize) <= maxWidth) {
              chars += ch;
            } else {
              if (chars) lines.push(chars);
              chars = ch;
            }
          }
          line = chars;
        } else {
          line = word;
        }
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /** Dibuja texto en coordenadas desde el tope de la página. */
  _pdfText(page, text, x, yFromTop, H, font, size, color) {
    const y = H - yFromTop - size;
    if (y < -size || y > H + size) return; // fuera de página
    page.drawText(String(text || ''), { x: Math.round(x), y: Math.round(y), font, size, color });
  }

  /** Dibuja texto centrado horizontalmente dentro de [x, x+width]. */
  _pdfTextCentered(page, text, x, width, yFromTop, H, font, size, color) {
    const str  = String(text || '');
    const textW = font.widthOfTextAtSize(str, size);
    this._pdfText(page, str, x + Math.max(0, (width - textW) / 2), yFromTop, H, font, size, color);
  }

  /** Dibuja un rectángulo (borde, relleno o ambos). */
  _pdfRect(page, x, yFromTop, width, height, H, opts = {}) {
    const drawOpts = {
      x:      Math.round(x),
      y:      Math.round(H - yFromTop - height),
      width:  Math.round(width),
      height: Math.round(height),
    };
    if (opts.fill)   drawOpts.color       = opts.fill;
    if (opts.stroke) { drawOpts.borderColor = opts.stroke; drawOpts.borderWidth = opts.strokeWidth || 0.5; }
    page.drawRectangle(drawOpts);
  }

  /** Dibuja una línea horizontal. */
  _pdfHLine(page, x1, x2, yFromTop, H, opts = {}) {
    page.drawLine({
      start: { x: Math.round(x1), y: Math.round(H - yFromTop) },
      end:   { x: Math.round(x2), y: Math.round(H - yFromTop) },
      thickness: opts.thickness || 0.5,
      color: opts.color,
    });
  }

  /**
   * Genera el PNG del TED como Buffer (no data URI) para embeber en pdf-lib.
   * Preserva el encoding latin1/binarytext que garantiza validez de firma SII.
   */
  async _generarTedPngBuffer(tedXml) {
    if (!tedXml || !tedXml.includes('<TED')) {
      throw new Error('[MuestrasImpresas] _generarTedPngBuffer: TED XML inválido');
    }
    const latin1Buffer = Buffer.from(tedXml, 'latin1');
    const binaryString = latin1Buffer.toString('binary');
    return bwipjs.toBuffer({
      bcid:        'pdf417',
      text:        binaryString,
      scale:       3,
      height:      10,
      padding:     6,
      includetext: false,
      binarytext:  true,
    });
  }

  /** Retorna true si la guía de despacho es de traslado interno (sin cedible). */
  _esGuiaInterna(doc) {
    return doc.tipoDte === 52 && [5, 6].includes(doc.indTraslado);
  }

  /** Retorna true si el documento debe incluir acuse de recibo. */
  _pdfNecesitaAcuse(doc, cedible) {
    if (!cedible) return false;
    if (NO_CEDIBLE_TIPOS.has(doc.tipoDte)) return false;
    if (!CEDIBLE_TIPOS.has(doc.tipoDte))   return false;
    if (this._esGuiaInterna(doc))          return false;
    return true;
  }

  /** Carga logo como imagen pdf-lib (PNG o JPG). Retorna null si no hay logo. */
  async _pdfLoadLogo(pdfDoc) {
    if (!this.logoDataUri) return null;
    try {
      const match = this.logoDataUri.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      if (!match) return null;
      const buf = Buffer.from(match[2], 'base64');
      return /jpe?g/i.test(match[1]) ? await pdfDoc.embedJpg(buf) : await pdfDoc.embedPng(buf);
    } catch {
      return null;
    }
  }

  // ── Cálculos de altura (fase 1: sin dibujar) ─────────────────

  _pdfCalcRecuadroHeight(doc, fonts) {
    const innerW    = PDF_LAYOUT.recuadro.width - PDF_LAYOUT.recuadro.padX * 2;
    const tipoLines = this._pdfWrapText(
      NOMBRES_DTE_IMPRESOS[doc.tipoDte] || `DTE ${doc.tipoDte}`,
      fonts.bold, PDF_LAYOUT.font.normal, innerW
    );
    const content =
      PDF_LAYOUT.recuadro.padY +
      PDF_LAYOUT.lineH.small +                          // RUT
      PDF_LAYOUT.gap.tiny +
      tipoLines.length * PDF_LAYOUT.lineH.small +       // tipo DTE (puede ser multilinea)
      PDF_LAYOUT.gap.tiny +
      PDF_LAYOUT.lineH.small +                          // folio
      PDF_LAYOUT.recuadro.padY;
    return Math.min(PDF_LAYOUT.recuadro.maxHeight, Math.max(PDF_LAYOUT.recuadro.minHeight, content));
  }

  _pdfCalcHeaderHeight(doc, fonts, logoImage) {
    let leftH = 0;
    if (logoImage) leftH += 25 + PDF_LAYOUT.gap.small;
    leftH += PDF_LAYOUT.lineH.normal;   // razón social
    leftH += PDF_LAYOUT.lineH.small;    // giro
    leftH += PDF_LAYOUT.lineH.small;    // dirección
    if (doc.emisor && doc.emisor.Sucursal) leftH += PDF_LAYOUT.lineH.small;

    const recuadroH = this._pdfCalcRecuadroHeight(doc, fonts);
    const rightH    = recuadroH + PDF_LAYOUT.gap.small + PDF_LAYOUT.lineH.small; // recuadro + oficina SII
    return Math.max(leftH, rightH);
  }

  _pdfCalcReceptorHeight() {
    return PDF_LAYOUT.acuse.padY * 2 + PDF_LAYOUT.lineH.small * 3 + PDF_LAYOUT.gap.tiny * 2;
  }

  _pdfCalcReferencesHeight(doc) {
    if (!doc.referencias || !doc.referencias.length) return 0;
    return (
      PDF_LAYOUT.lineH.normal + PDF_LAYOUT.gap.small +
      PDF_LAYOUT.table.headerH +
      doc.referencias.length * PDF_LAYOUT.table.rowH +
      PDF_LAYOUT.gap.section
    );
  }

  _pdfCalcDetalleHeight(doc, fonts, W, M) {
    const tableW = W - 2 * M;
    const descW  = Math.round(tableW * 0.37) - PDF_LAYOUT.table.padX * 2;
    let   rowsH  = 0;
    for (const item of (doc.detalle || [])) {
      const lines  = this._pdfWrapText(safeText(item && item.NmbItem || ''), fonts.normal, PDF_LAYOUT.font.tiny, descW);
      const hasDcto = !!(item && (item.DescuentoMonto || item.DescuentoPct));
      rowsH += Math.max(
        PDF_LAYOUT.table.rowH,
        lines.length * PDF_LAYOUT.lineH.tiny + PDF_LAYOUT.table.padY * 2 + (hasDcto ? PDF_LAYOUT.lineH.tiny : 0)
      );
    }
    return PDF_LAYOUT.lineH.normal + PDF_LAYOUT.gap.small + PDF_LAYOUT.table.headerH + rowsH;
  }

  _pdfCalcTotalesHeight(doc) {
    const { totales = {}, descuentosGlobales = [], tipoDte } = doc;
    let rows = 0;
    if (tipoDte === 34) {
      if (totales.MntExe)   rows++;
      if (totales.MntTotal) rows++;
    } else {
      rows += (descuentosGlobales || []).length;
      if (totales.MntNeto)  rows++;
      if (totales.MntExe)   rows++;
      if (totales.IVA)      rows++;
      if (totales.MntTotal) rows++;
    }
    return rows * (PDF_LAYOUT.table.rowH + 2) + 8;
  }

  _pdfCalcAcuseHeight(leyendaLines) {
    const fieldsH  = PDF_LAYOUT.acuse.fieldH * 4 + PDF_LAYOUT.gap.small * 3;
    const leyendaH = (leyendaLines || 3) * PDF_LAYOUT.lineH.legal;
    return PDF_LAYOUT.acuse.padY * 2 + fieldsH + PDF_LAYOUT.gap.small + leyendaH + PDF_LAYOUT.gap.small;
  }

  // ── Renderizadores de sección (fase 2: dibujar) ───────────────

  _pdfRenderHeader(page, doc, fonts, logoImage, y, H, W, M, rgb) {
    const recuadroW = PDF_LAYOUT.recuadro.width;
    const recuadroH = this._pdfCalcRecuadroHeight(doc, fonts);
    const recuadroX = W - M - recuadroW;
    const emisor    = doc.emisor || {};
    const BLACK     = rgb(0, 0, 0);
    const RED       = rgb(0.75, 0, 0);

    // ── Columna izquierda: logo + datos emisor ──────────────────
    let lx = M;
    let ly = y;

    if (logoImage) {
      // Resolver Promise si fue retornada como tal
      const img = logoImage;
      const maxW = Math.min((recuadroX - M - PDF_LAYOUT.gap.section) * 0.4, 120);
      const maxLogoH = 25;
      const scale    = Math.min(maxW / img.width, maxLogoH / img.height);
      const lw = img.width * scale;
      const lh = img.height * scale;
      page.drawImage(img, { x: lx, y: H - ly - lh, width: lw, height: lh });
      ly += lh + PDF_LAYOUT.gap.small;
    }

    this._pdfText(page, safeText(emisor.RznSoc || emisor.RznSocEmisor || ''), lx, ly, H, fonts.bold, PDF_LAYOUT.font.razonSocial, BLACK);
    ly += PDF_LAYOUT.lineH.normal;
    this._pdfText(page, safeText(emisor.GiroEmis || ''), lx, ly, H, fonts.normal, PDF_LAYOUT.font.small, BLACK);
    ly += PDF_LAYOUT.lineH.small;
    const dir = `Casa Matriz: ${safeText(emisor.DirOrigen || '')}${emisor.CmnaOrigen ? ', ' + safeText(emisor.CmnaOrigen) : ''}`;
    this._pdfText(page, dir, lx, ly, H, fonts.normal, PDF_LAYOUT.font.small, BLACK);
    ly += PDF_LAYOUT.lineH.small;
    if (emisor.Sucursal) {
      this._pdfText(page, `Sucursal: ${safeText(emisor.Sucursal)}`, lx, ly, H, fonts.normal, PDF_LAYOUT.font.small, BLACK);
    }

    // ── Columna derecha: recuadro SII ───────────────────────────
    this._pdfRect(page, recuadroX, y, recuadroW, recuadroH, H, { stroke: RED, strokeWidth: PDF_LAYOUT.recuadro.border });

    const innerW     = recuadroW - PDF_LAYOUT.recuadro.padX * 2;
    let   ry         = y + PDF_LAYOUT.recuadro.padY;

    // RUT emisor
    const rutText    = `R.U.T.: ${_formatRutConPuntos(safeText(emisor.RUTEmisor || ''))}`;
    this._pdfTextCentered(page, rutText, recuadroX, recuadroW, ry, H, fonts.bold, PDF_LAYOUT.font.small, RED);
    ry += PDF_LAYOUT.lineH.small + PDF_LAYOUT.gap.tiny;

    // Tipo DTE (puede ocupar 2 líneas)
    const tipoNombre = NOMBRES_DTE_IMPRESOS[doc.tipoDte] || `DTE ${doc.tipoDte}`;
    const tipoLines  = this._pdfWrapText(tipoNombre, fonts.bold, PDF_LAYOUT.font.normal, innerW);
    for (const line of tipoLines) {
      this._pdfTextCentered(page, line, recuadroX, recuadroW, ry, H, fonts.bold, PDF_LAYOUT.font.normal, RED);
      ry += PDF_LAYOUT.lineH.small;
    }
    ry += PDF_LAYOUT.gap.tiny;

    // Folio
    this._pdfTextCentered(page, `N° ${safeText(doc.folio)}`, recuadroX, recuadroW, ry, H, fonts.bold, PDF_LAYOUT.font.small, RED);

    // Oficina SII bajo el recuadro
    this._pdfTextCentered(
      page, this.siiOficina,
      recuadroX, recuadroW,
      y + recuadroH + PDF_LAYOUT.gap.small,
      H, fonts.normal, PDF_LAYOUT.font.tiny, BLACK
    );

    const headerBottom = Math.max(ly, y + recuadroH + PDF_LAYOUT.gap.small + PDF_LAYOUT.lineH.small);
    return headerBottom;
  }

  _pdfRenderFecha(page, doc, fonts, y, H, M, rgb) {
    this._pdfText(page, `Fecha Emisión: ${safeText(doc.fechaEmision)}`, M, y, H, fonts.bold, PDF_LAYOUT.font.normal, rgb(0,0,0));
    return y + PDF_LAYOUT.lineH.normal;
  }

  _pdfRenderReceptor(page, doc, fonts, y, H, W, M, rgb) {
    const receptor = doc.receptor || {};
    const boxH     = this._pdfCalcReceptorHeight();
    const boxW     = W - 2 * M;
    const BLACK    = rgb(0,0,0);
    const GRAY     = rgb(0.5, 0.5, 0.5);
    const fs       = PDF_LAYOUT.font.small;
    const lh       = PDF_LAYOUT.lineH.small;
    const px       = M + PDF_LAYOUT.acuse.padX;

    this._pdfRect(page, M, y, boxW, boxH, H, { stroke: GRAY, strokeWidth: 0.5 });

    let py = y + PDF_LAYOUT.acuse.padY;

    // Fila 1: Señor(es) + RUT
    const sLabel = 'Señor(es): ';
    this._pdfText(page, sLabel, px, py, H, fonts.bold, fs, BLACK);
    this._pdfText(page, safeText(receptor.RznSocRecep || ''), px + fonts.bold.widthOfTextAtSize(sLabel, fs), py, H, fonts.normal, fs, BLACK);
    const rutLabel = 'RUT: ';
    const rutVal   = safeText(receptor.RUTRecep || '');
    const rutTotal = `${rutLabel}${rutVal}`;
    const rutX     = W - M - PDF_LAYOUT.acuse.padX - fonts.normal.widthOfTextAtSize(rutTotal, fs);
    this._pdfText(page, rutLabel, rutX, py, H, fonts.bold, fs, BLACK);
    this._pdfText(page, rutVal,   rutX + fonts.bold.widthOfTextAtSize(rutLabel, fs), py, H, fonts.normal, fs, BLACK);
    py += lh + PDF_LAYOUT.gap.tiny;

    // Fila 2: Dirección + Comuna
    const dLabel = 'Dirección: ';
    this._pdfText(page, dLabel, px, py, H, fonts.bold, fs, BLACK);
    this._pdfText(page, safeText(receptor.DirRecep || ''), px + fonts.bold.widthOfTextAtSize(dLabel, fs), py, H, fonts.normal, fs, BLACK);
    const cLabel   = 'Comuna: ';
    const cVal     = safeText(receptor.CmnaRecep || '');
    const cTotal   = `${cLabel}${cVal}`;
    const cX       = W - M - PDF_LAYOUT.acuse.padX - fonts.normal.widthOfTextAtSize(cTotal, fs);
    this._pdfText(page, cLabel, cX, py, H, fonts.bold, fs, BLACK);
    this._pdfText(page, cVal,   cX + fonts.bold.widthOfTextAtSize(cLabel, fs), py, H, fonts.normal, fs, BLACK);
    py += lh + PDF_LAYOUT.gap.tiny;

    // Fila 3: Giro
    const gLabel = 'Giro: ';
    this._pdfText(page, gLabel, px, py, H, fonts.bold, fs, BLACK);
    this._pdfText(page, safeText(receptor.GiroRecep || ''), px + fonts.bold.widthOfTextAtSize(gLabel, fs), py, H, fonts.normal, fs, BLACK);

    return y + boxH;
  }

  _pdfRenderTraslado(page, doc, fonts, y, H, M, rgb) {
    const texto = `Tipo de Traslado: ${doc.indTraslado} - ${NOMBRES_TRASLADO[doc.indTraslado] || ''}`;
    this._pdfText(page, texto, M, y, H, fonts.normal, PDF_LAYOUT.font.small, rgb(0,0,0));
    return y + PDF_LAYOUT.lineH.small;
  }

  _pdfRenderReferencias(page, doc, fonts, y, H, W, M, rgb) {
    const tableW = W - 2 * M;
    const BLACK  = rgb(0,0,0);
    const DARK   = rgb(0.4, 0.4, 0.4);
    const LGRAY  = rgb(0.88, 0.88, 0.88);

    this._pdfText(page, 'Referencias a otros documentos', M, y, H, fonts.bold, PDF_LAYOUT.font.normal, BLACK);
    y += PDF_LAYOUT.lineH.normal + PDF_LAYOUT.gap.small;

    const colW = {
      tipo:  Math.round(tableW * 0.30),
      folio: Math.round(tableW * 0.15),
      fecha: Math.round(tableW * 0.20),
      razon: tableW - Math.round(tableW * 0.30) - Math.round(tableW * 0.15) - Math.round(tableW * 0.20),
    };
    const headers = ['Tipo Documento', 'Folio', 'Fecha', 'Razón Referencia'];
    const widths  = [colW.tipo, colW.folio, colW.fecha, colW.razon];

    // Encabezado tabla
    this._pdfRect(page, M, y, tableW, PDF_LAYOUT.table.headerH, H, { fill: LGRAY });
    let cx = M;
    for (let i = 0; i < headers.length; i++) {
      this._pdfRect(page, cx, y, widths[i], PDF_LAYOUT.table.headerH, H, { stroke: DARK, strokeWidth: 0.5 });
      this._pdfText(page, headers[i], cx + PDF_LAYOUT.table.padX, y + PDF_LAYOUT.table.padY, H, fonts.bold, PDF_LAYOUT.font.tiny, BLACK);
      cx += widths[i];
    }
    y += PDF_LAYOUT.table.headerH;

    // Filas
    for (const ref of doc.referencias) {
      const tipRef  = ref && ref.TpoDocRef ? (NOMBRES_DTE_IMPRESOS[ref.TpoDocRef] || `Tipo ${ref.TpoDocRef}`) : '';
      const values  = [
        safeText(tipRef),
        safeText(ref && ref.FolioRef || ''),
        safeText(ref && ref.FchRef   || ''),
        safeText(ref && ref.RazonRef || ''),
      ];
      cx = M;
      for (let i = 0; i < values.length; i++) {
        this._pdfRect(page, cx, y, widths[i], PDF_LAYOUT.table.rowH, H, { stroke: DARK, strokeWidth: 0.5 });
        this._pdfText(page, values[i], cx + PDF_LAYOUT.table.padX, y + PDF_LAYOUT.table.padY, H, fonts.normal, PDF_LAYOUT.font.tiny, BLACK);
        cx += widths[i];
      }
      y += PDF_LAYOUT.table.rowH;
    }
    return y;
  }

  _pdfRenderDetalle(page, doc, fonts, y, H, W, M, rgb) {
    const tableW = W - 2 * M;
    const BLACK  = rgb(0,0,0);
    const DARK   = rgb(0.4, 0.4, 0.4);
    const LGRAY  = rgb(0.88, 0.88, 0.88);
    const MGRAY  = rgb(0.4, 0.4, 0.4);

    this._pdfText(page, 'Detalle', M, y, H, fonts.bold, PDF_LAYOUT.font.normal, BLACK);
    y += PDF_LAYOUT.lineH.normal + PDF_LAYOUT.gap.small;

    // Definición de columnas
    const T = tableW;
    const colW = {
      num:   Math.round(T * 0.05),
      cod:   Math.round(T * 0.10),
      cant:  Math.round(T * 0.09),
      unid:  Math.round(T * 0.07),
      punit: Math.round(T * 0.13),
      valor: Math.round(T * 0.14),
    };
    colW.desc = T - colW.num - colW.cod - colW.cant - colW.unid - colW.punit - colW.valor;

    const colDefs = [
      { key: 'num',   w: colW.num,   label: '#',         align: 'center' },
      { key: 'cod',   w: colW.cod,   label: 'Código',    align: 'left'   },
      { key: 'desc',  w: colW.desc,  label: 'Descripción', align: 'left', wrap: true },
      { key: 'cant',  w: colW.cant,  label: 'Cant.',     align: 'right'  },
      { key: 'unid',  w: colW.unid,  label: 'Unid.',     align: 'center' },
      { key: 'punit', w: colW.punit, label: 'P.Unit.',   align: 'right'  },
      { key: 'valor', w: colW.valor, label: 'Valor',     align: 'right'  },
    ];

    // Encabezado
    this._pdfRect(page, M, y, tableW, PDF_LAYOUT.table.headerH, H, { fill: LGRAY });
    let cx = M;
    for (const col of colDefs) {
      this._pdfRect(page, cx, y, col.w, PDF_LAYOUT.table.headerH, H, { stroke: DARK, strokeWidth: 0.5 });
      const lw  = fonts.bold.widthOfTextAtSize(col.label, PDF_LAYOUT.font.tiny);
      const lx  = col.align === 'center'
        ? cx + (col.w - lw) / 2
        : col.align === 'right'
          ? cx + col.w - lw - PDF_LAYOUT.table.padX
          : cx + PDF_LAYOUT.table.padX;
      this._pdfText(page, col.label, lx, y + PDF_LAYOUT.table.padY, H, fonts.bold, PDF_LAYOUT.font.tiny, BLACK);
      cx += col.w;
    }
    y += PDF_LAYOUT.table.headerH;

    // Filas de detalle
    for (let idx = 0; idx < (doc.detalle || []).length; idx++) {
      const item    = doc.detalle[idx] || {};
      const descW   = colW.desc - PDF_LAYOUT.table.padX * 2;
      const descLines = this._pdfWrapText(safeText(item.NmbItem || ''), fonts.normal, PDF_LAYOUT.font.tiny, descW);
      const hasDcto   = !!(item.DescuentoMonto || item.DescuentoPct);
      const rowH      = Math.max(
        PDF_LAYOUT.table.rowH,
        descLines.length * PDF_LAYOUT.lineH.tiny + PDF_LAYOUT.table.padY * 2 + (hasDcto ? PDF_LAYOUT.lineH.tiny : 0)
      );

      const vals = {
        num:   String(idx + 1),
        cod:   safeText((item.CdgItem && item.CdgItem.VlrCodigo) || item.CdgItem || ''),
        cant:  item.QtyItem != null ? String(item.QtyItem) : '',
        unid:  safeText(item.UnmdItem || 'UN'),
        punit: item.PrcItem != null ? `$${formatMonto(item.PrcItem)}` : '',
        valor: item.MontoItem != null ? `$${formatMonto(item.MontoItem)}` : '',
      };

      cx = M;
      for (const col of colDefs) {
        this._pdfRect(page, cx, y, col.w, rowH, H, { stroke: DARK, strokeWidth: 0.5 });

        if (col.key === 'desc') {
          let ty = y + PDF_LAYOUT.table.padY;
          for (const line of descLines) {
            this._pdfText(page, line, cx + PDF_LAYOUT.table.padX, ty, H, fonts.normal, PDF_LAYOUT.font.tiny, BLACK);
            ty += PDF_LAYOUT.lineH.tiny;
          }
          if (hasDcto) {
            const dctoStr = item.DescuentoMonto
              ? `Dcto: $${formatMonto(item.DescuentoMonto)}`
              : `Dcto: ${item.DescuentoPct}%`;
            this._pdfText(page, dctoStr, cx + PDF_LAYOUT.table.padX, ty, H, fonts.normal, PDF_LAYOUT.font.legal, MGRAY);
          }
        } else {
          const val  = vals[col.key] || '';
          const vW   = fonts.normal.widthOfTextAtSize(val, PDF_LAYOUT.font.tiny);
          const valX = col.align === 'center'
            ? cx + (col.w - vW) / 2
            : col.align === 'right'
              ? cx + col.w - vW - PDF_LAYOUT.table.padX
              : cx + PDF_LAYOUT.table.padX;
          this._pdfText(page, val, valX, y + (rowH - PDF_LAYOUT.font.tiny) / 2, H, fonts.normal, PDF_LAYOUT.font.tiny, BLACK);
        }
        cx += col.w;
      }
      y += rowH;
    }
    return y;
  }

  _pdfRenderTotales(page, doc, fonts, y, H, W, M, rgb) {
    const { totales = {}, descuentosGlobales = [], tipoDte } = doc;
    const esExenta = tipoDte === 34;
    const boxW     = Math.round(W * 0.45);
    const boxX     = W - M - boxW;
    const rowH     = PDF_LAYOUT.table.rowH + 2;
    const fs       = PDF_LAYOUT.font.normal;
    const DARK     = rgb(0.4, 0.4, 0.4);
    const BLACK    = rgb(0,0,0);

    const rows = [];
    if (esExenta) {
      if (totales.MntExe)   rows.push(['Monto Exento',  `$${formatMonto(totales.MntExe)}`,  false]);
      if (totales.MntTotal) rows.push(['Monto Total',   `$${formatMonto(totales.MntTotal)}`, true]);
    } else {
      for (const dg of (descuentosGlobales || [])) {
        const label = dg && dg.TpoMov === 'D' ? 'Descuento Global' : 'Recargo Global';
        const valor = dg && dg.ValorDR ? `$${formatMonto(dg.ValorDR)}` : (dg && dg.PctDR ? `${dg.PctDR}%` : '');
        rows.push([label, valor, false]);
      }
      if (totales.MntNeto)  rows.push(['Monto Neto',                         `$${formatMonto(totales.MntNeto)}`,  false]);
      if (totales.MntExe)   rows.push(['Monto Exento',                       `$${formatMonto(totales.MntExe)}`,   false]);
      if (totales.IVA)      rows.push([`IVA (${totales.TasaIVA || 19}%)`,   `$${formatMonto(totales.IVA)}`,      false]);
      if (totales.MntTotal) rows.push(['Monto Total',                        `$${formatMonto(totales.MntTotal)}`, true]);
    }

    let ry      = y + 2;
    const labelW = Math.round(boxW * 0.55);
    const valorW = boxW - labelW;

    for (const [label, valor, isBold] of rows) {
      const font = isBold ? fonts.bold : fonts.normal;
      this._pdfRect(page, boxX,         ry, labelW, rowH, H, { stroke: DARK, strokeWidth: 0.5 });
      this._pdfRect(page, boxX + labelW, ry, valorW, rowH, H, { stroke: DARK, strokeWidth: 0.5 });
      this._pdfText(page, label, boxX + PDF_LAYOUT.table.padX, ry + PDF_LAYOUT.table.padY, H, font, fs, BLACK);
      const vW  = font.widthOfTextAtSize(valor, fs);
      this._pdfText(page, valor, boxX + labelW + valorW - vW - PDF_LAYOUT.table.padX, ry + PDF_LAYOUT.table.padY, H, font, fs, BLACK);
      ry += rowH;
    }
    return y + rows.length * rowH + 8;
  }

  _pdfRenderAcuse(page, doc, fonts, y, H, W, M, rgb, leyendaMaxW) {
    const BLACK = rgb(0,0,0);
    const GRAY  = rgb(0.5, 0.5, 0.5);
    const fs    = PDF_LAYOUT.font.small;
    const px    = M + PDF_LAYOUT.acuse.padX;

    const leyendaLines = this._pdfWrapText(DECLARACION_RECIBO, fonts.normal, PDF_LAYOUT.font.legal, leyendaMaxW);
    const boxH  = this._pdfCalcAcuseHeight(leyendaLines.length);
    const boxW  = W - 2 * M;

    this._pdfRect(page, M, y, boxW, boxH, H, { stroke: BLACK, strokeWidth: 0.5 });

    let py = y + PDF_LAYOUT.acuse.padY;

    this._pdfText(page, 'Acuse de Recibo', px, py, H, fonts.bold, fs, BLACK);
    py += PDF_LAYOUT.acuse.fieldH;

    this._pdfText(page, 'Nombre: ____________________________', px, py, H, fonts.normal, fs, BLACK);
    this._pdfText(page, 'R.U.T.: ___________________', px + (W - 2 * M - PDF_LAYOUT.acuse.padX * 2) * 0.5, py, H, fonts.normal, fs, BLACK);
    py += PDF_LAYOUT.acuse.fieldH;

    this._pdfText(page, 'Fecha: ___________________', px, py, H, fonts.normal, fs, BLACK);
    this._pdfText(page, 'Recinto: __________________', px + (W - 2 * M - PDF_LAYOUT.acuse.padX * 2) * 0.5, py, H, fonts.normal, fs, BLACK);
    py += PDF_LAYOUT.acuse.fieldH;

    this._pdfText(page, 'Firma: ____________________________', px, py, H, fonts.normal, fs, BLACK);
    py += PDF_LAYOUT.acuse.fieldH + PDF_LAYOUT.gap.small;

    this._pdfHLine(page, px, M + boxW - PDF_LAYOUT.acuse.padX, py, H, { thickness: 0.5, color: GRAY });
    py += PDF_LAYOUT.gap.tiny + 2;

    for (const line of leyendaLines) {
      this._pdfText(page, line, px, py, H, fonts.normal, PDF_LAYOUT.font.legal, BLACK);
      py += PDF_LAYOUT.lineH.legal;
    }
    return y + boxH;
  }

  async _pdfRenderTed(pdfDoc, page, tedPng, fonts, y, H, W, M, rgb) {
    const BLACK    = rgb(0,0,0);
    const pdfImage = await pdfDoc.embedPng(tedPng);
    const dims     = pdfImage.scale(1);

    // Escalar respetando mínimos y máximos SII
    const targetW  = Math.max(PDF_LAYOUT.ted.minWidth, Math.min(PDF_LAYOUT.ted.maxWidth, dims.width));
    const scale    = targetW / dims.width;
    const scaledW  = Math.round(targetW);
    const scaledH  = Math.max(PDF_LAYOUT.ted.minHeight, Math.min(PDF_LAYOUT.ted.maxHeight, Math.round(dims.height * scale)));

    // Distancia mínima de 2 cm desde el borde izquierdo del documento (incluye margen)
    const tedX = M + PDF_LAYOUT.ted.marginLeft;

    y += PDF_LAYOUT.gap.section;
    page.drawImage(pdfImage, { x: tedX, y: H - y - scaledH, width: scaledW, height: scaledH });
    y += scaledH + PDF_LAYOUT.ted.legendGap;

    // Leyenda obligatoria (≥ 6pt según SII)
    this._pdfText(page, 'Timbre Electrónico SII', tedX, y, H, fonts.bold, PDF_LAYOUT.font.legend, BLACK);
    y += PDF_LAYOUT.lineH.legal;
    this._pdfText(page, this.resolucion, tedX, y, H, fonts.normal, PDF_LAYOUT.font.legend, BLACK);
    y += PDF_LAYOUT.lineH.legal;
    this._pdfText(page, 'Verifique documento: www.sii.cl', tedX, y, H, fonts.normal, PDF_LAYOUT.font.legend, BLACK);
    y += PDF_LAYOUT.lineH.legal;
    return y;
  }

  _pdfRenderCedible(page, doc, fonts, H, W, M, rgb) {
    const texto = doc.tipoDte === 52 ? 'CEDIBLE CON SU FACTURA' : 'CEDIBLE';
    const tW    = fonts.bold.widthOfTextAtSize(texto, PDF_LAYOUT.font.razonSocial);
    // Posición: inferior derecha del documento
    this._pdfText(page, texto, W - M - tW, H - M - PDF_LAYOUT.font.razonSocial - PDF_LAYOUT.lineH.normal, H, fonts.bold, PDF_LAYOUT.font.razonSocial, rgb(0,0,0));
  }

  // ═══════════════════════════════════════════════════════════════
  // Método público principal — sin Chromium, usa pdf-lib
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera un Buffer PDF de la muestra impresa según Manual SII v3.0.
   * No requiere Chromium ni ninguna dependencia del sistema operativo.
   *
   * El parámetro `doc` debe ser un elemento del array que retorna parseEnvioDTE().
   *
   * @param {Object}  doc              - Documento DTE parseado
   * @param {Object}  [opts={}]
   * @param {boolean} [opts.cedible=false] - Generar copia cedible con acuse de recibo
   * @returns {Promise<Buffer>}        - Buffer PDF listo para enviar por HTTP
   */
  async generarPDFBuffer(doc, opts = {}) {
    if (!doc || typeof doc !== 'object') {
      throw new Error('[MuestrasImpresas] generarPDFBuffer: doc es requerido (resultado de parseEnvioDTE)');
    }
    if (!doc.tipoDte) {
      throw new Error('[MuestrasImpresas] generarPDFBuffer: doc.tipoDte no encontrado');
    }

    const { cedible = false } = opts;
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

    const pdfDoc     = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fonts      = { normal: fontNormal, bold: fontBold };
    const logoImage  = this.logoDataUri ? await this._pdfLoadLogo(pdfDoc) : null;

    const W = PDF_LAYOUT.page.width;
    const M = PDF_LAYOUT.margin;

    // ── Fase 1: precalcular alturas para dimensionar la página ────
    const needsAcuse    = this._pdfNecesitaAcuse(doc, cedible);
    const leyendaW      = W - 2 * M - PDF_LAYOUT.acuse.padX * 2;
    const leyendaLines  = needsAcuse
      ? this._pdfWrapText(DECLARACION_RECIBO, fontNormal, PDF_LAYOUT.font.legal, leyendaW)
      : [];

    const headerH    = this._pdfCalcHeaderHeight(doc, fonts, logoImage);
    const fechaH     = PDF_LAYOUT.lineH.normal;
    const receptorH  = this._pdfCalcReceptorHeight();
    const trasladoH  = (doc.tipoDte === 52 && doc.indTraslado) ? PDF_LAYOUT.lineH.small + PDF_LAYOUT.gap.small : 0;
    const refsH      = this._pdfCalcReferencesHeight(doc);
    const detalleH   = this._pdfCalcDetalleHeight(doc, fonts, W, M);
    const totalesH   = this._pdfCalcTotalesHeight(doc);
    const acuseH     = needsAcuse ? this._pdfCalcAcuseHeight(leyendaLines.length) + PDF_LAYOUT.gap.section : 0;
    const tedH       = doc.tedXml
      ? PDF_LAYOUT.gap.section + PDF_LAYOUT.ted.maxHeight + PDF_LAYOUT.ted.legendGap + PDF_LAYOUT.lineH.legal * 3 + M
      : M;

    const totalH =
      M +
      headerH   + PDF_LAYOUT.gap.section +
      fechaH    + PDF_LAYOUT.gap.small   +
      receptorH + PDF_LAYOUT.gap.section +
      trasladoH +
      refsH +
      detalleH  + PDF_LAYOUT.gap.section +
      totalesH  + PDF_LAYOUT.gap.section +
      acuseH +
      tedH;

    const H = Math.min(
      PDF_LAYOUT.page.maxHeight,
      Math.max(PDF_LAYOUT.page.minHeight, Math.ceil(totalH))
    );

    // ── Fase 2: crear página y renderizar ─────────────────────────
    const page = pdfDoc.addPage([W, H]);
    let   y    = M;

    y = this._pdfRenderHeader(page, doc, fonts, logoImage, y, H, W, M, rgb);
    y += PDF_LAYOUT.gap.section;

    y = this._pdfRenderFecha(page, doc, fonts, y, H, M, rgb);
    y += PDF_LAYOUT.gap.small;

    y = this._pdfRenderReceptor(page, doc, fonts, y, H, W, M, rgb);
    y += PDF_LAYOUT.gap.section;

    if (trasladoH > 0) {
      y = this._pdfRenderTraslado(page, doc, fonts, y, H, M, rgb);
      y += PDF_LAYOUT.gap.small;
    }

    if (refsH > 0) {
      y = this._pdfRenderReferencias(page, doc, fonts, y, H, W, M, rgb);
      y += PDF_LAYOUT.gap.section;
    }

    y = this._pdfRenderDetalle(page, doc, fonts, y, H, W, M, rgb);
    y += PDF_LAYOUT.gap.section;

    y = this._pdfRenderTotales(page, doc, fonts, y, H, W, M, rgb);
    y += PDF_LAYOUT.gap.section;

    if (needsAcuse) {
      y = this._pdfRenderAcuse(page, doc, fonts, y, H, W, M, rgb, leyendaW);
      y += PDF_LAYOUT.gap.section;
    }

    if (doc.tedXml) {
      const tedPng = await this._generarTedPngBuffer(doc.tedXml);
      y = await this._pdfRenderTed(pdfDoc, page, tedPng, fonts, y, H, W, M, rgb);
    }

    if (cedible && CEDIBLE_TIPOS.has(doc.tipoDte) && !this._esGuiaInterna(doc)) {
      this._pdfRenderCedible(page, doc, fonts, H, W, M, rgb);
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  /**
   * Genera muestras impresas desde archivos XML
   * @param {Object} options
   * @param {string[]} options.xmlFiles - Array de rutas a archivos XML
   * @param {string} options.outDir - Directorio de salida
   * @param {boolean} [options.generarCedible=false] - Generar también copias cedibles
   * @returns {Promise<Object>} Resultado con estadísticas y archivos generados
   */
  async generarMuestras({ xmlFiles, outDir, generarCedible = false }) {
    const pruebasDir    = path.join(outDir, 'SET-PRUEBAS');
    const simulacionDir = path.join(outDir, 'SET-SIMULACION');
    fs.mkdirSync(pruebasDir,    { recursive: true });
    fs.mkdirSync(simulacionDir, { recursive: true });

    const resultado = {
      success: true, totalDocs: 0, totalPdfs: 0,
      archivos: [], errores: [], setPruebas: 0, setSimulacion: 0,
    };

    for (const filePath of xmlFiles) {
      const sourceFile = path.basename(filePath).toLowerCase();
      const isPruebas  = /envio-set-(basico|guia|exenta|compra)\.xml/i.test(sourceFile);
      const targetDir  = isPruebas ? pruebasDir : simulacionDir;

      let docs;
      try {
        docs = this.parseEnvioDTE(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        resultado.errores.push({ file: filePath, error: e.message });
        continue;
      }

      for (const doc of docs) {
        resultado.totalDocs++;
        const base = `muestra_${doc.tipoDte}_${doc.folio}`;

        try {
          const buf = await this.generarPDFBuffer(doc, { cedible: false });
          const out = path.join(targetDir, `${base}.pdf`);
          fs.writeFileSync(out, buf);
          resultado.totalPdfs++;
          resultado.archivos.push(out);
          if (isPruebas) resultado.setPruebas++; else resultado.setSimulacion++;
          console.log(`   ✓ ${base}.pdf  (${buf.length} bytes)`);
        } catch (e) {
          resultado.errores.push({ tipo: doc.tipoDte, folio: doc.folio, error: e.message });
          console.error(`   ✗ ${base}.pdf  →  ${e.message}`);
        }

        if (generarCedible && CEDIBLE_TIPOS.has(doc.tipoDte) && !this._esGuiaInterna(doc)) {
          try {
            const buf = await this.generarPDFBuffer(doc, { cedible: true });
            const out = path.join(targetDir, `${base}_cedible.pdf`);
            fs.writeFileSync(out, buf);
            resultado.totalPdfs++;
            resultado.archivos.push(out);
            if (isPruebas) resultado.setPruebas++; else resultado.setSimulacion++;
            console.log(`   ✓ ${base}_cedible.pdf  (${buf.length} bytes)`);
          } catch (e) {
            resultado.errores.push({ tipo: doc.tipoDte, folio: doc.folio, cedible: true, error: e.message });
            console.error(`   ✗ ${base}_cedible.pdf  →  ${e.message}`);
          }
        }
      }
    }

    if (resultado.errores.length > 0) resultado.success = false;
    return resultado;
  }

  /**
   * Busca archivos XML recursivamente en una carpeta
   * Filtra solo envíos que contienen DTEs (no respuestas de intercambio)
   * @param {string} inputPath - Ruta a archivo o carpeta
   * @returns {string[]} Array de rutas a archivos XML
   */
  static buscarXmls(inputPath) {
    if (!inputPath) return [];
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) return [];
    const stats = fs.statSync(resolved);
    if (stats.isFile()) return [resolved];
    if (stats.isDirectory()) {
      const files = [];
      const scanDir = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath);
          } else if (item.toLowerCase().endsWith('.xml')) {
            const lowerItem = item.toLowerCase();
            // Incluir: envio-set-*, envio-simulacion, EnvioBOLETA
            // Excluir: respuesta-*, envio-recibos (intercambio sin DTEs)
            const isEnvioDTE = (
              lowerItem.includes('envio-set-') ||
              lowerItem.includes('envio-simulacion') ||
              lowerItem.includes('envioboleta') ||
              lowerItem === 'envioboleta.xml'
            );
            if (isEnvioDTE) {
              files.push(fullPath);
            }
          }
        }
      };
      scanDir(resolved);
      return files;
    }
    return [];
  }
}

module.exports = MuestrasImpresas;
