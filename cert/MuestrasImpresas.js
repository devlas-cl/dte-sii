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
const puppeteer = require('puppeteer');

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
  async generarPdf417(tedXml) {
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
      height: 12,
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
   * Genera PDF desde HTML
   * @private
   */
  async _generarPdf({ html, outputPath, browser }) {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      printBackground: true,
      width: '215mm',
      height: '280mm',
      margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
    });
    await page.close();
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
    fs.mkdirSync(outDir, { recursive: true });

    // Crear subdirectorios según requisitos del SII
    const pruebasDir = path.join(outDir, 'SET-PRUEBAS');
    const simulacionDir = path.join(outDir, 'SET-SIMULACION');
    fs.mkdirSync(pruebasDir, { recursive: true });
    fs.mkdirSync(simulacionDir, { recursive: true });

    console.log('\n' + '═'.repeat(60));
    console.log('📄 GENERACIÓN DE MUESTRAS IMPRESAS');
    console.log('═'.repeat(60));
    console.log(`   📂 SET-PRUEBAS: ${pruebasDir}`);
    console.log(`   📂 SET-SIMULACION: ${simulacionDir}`);

    const browser = await puppeteer.launch({ headless: true });
    const resultado = {
      success: true,
      totalDocs: 0,
      totalPdfs: 0,
      archivos: [],
      errores: [],
      setPruebas: 0,
      setSimulacion: 0,
    };

    try {
      for (const filePath of xmlFiles) {
        console.log(`\n   📄 Procesando: ${path.basename(filePath)}`);
        const xml = fs.readFileSync(filePath, 'utf8');
        
        let documentos;
        try {
          documentos = this.parseEnvioDTE(xml);
        } catch (e) {
          console.log(`      ⚠️ Error parseando: ${e.message}`);
          resultado.errores.push({ file: filePath, error: e.message });
          continue;
        }

        if (!documentos.length) {
          console.log('      ⚠️ Sin documentos');
          continue;
        }

        // Determinar directorio de salida según archivo fuente
        const sourceFile = path.basename(filePath).toLowerCase();
        const isPruebas = /envio-set-(basico|guia|exenta|compra)\.xml/i.test(sourceFile);
        const targetDir = isPruebas ? pruebasDir : simulacionDir;
        const categoria = isPruebas ? 'PRUEBAS' : 'SIMULACION';
        console.log(`      📁 Categoría: SET-${categoria}`);

        for (const doc of documentos) {
          resultado.totalDocs++;
          
          try {
            const tedDataUri = await this.generarPdf417(doc.tedXml);
            
            // Generar ejemplar tributario (sin cedible)
            const html = this._buildHtml({ doc, esCedible: false, tedDataUri });

            // PDFs organizados en subdirectorios según categoría SII
            const outputName = `muestra_${doc.tipoDte}_${doc.folio}.pdf`;
            const outputPath = path.join(targetDir, outputName);

            await this._generarPdf({ html, outputPath, browser });
            resultado.totalPdfs++;
            resultado.archivos.push(outputPath);
            if (isPruebas) resultado.setPruebas++;
            else resultado.setSimulacion++;
            console.log(`      ✓ ${outputName}`);

            // Generar copia cedible si corresponde
            if (generarCedible && CEDIBLE_TIPOS.has(doc.tipoDte)) {
              // Guía de traslado interno no tiene cedible
              if (doc.tipoDte === 52 && [5, 6].includes(doc.indTraslado)) {
                console.log(`      ⏭️ Guía traslado interno - sin cedible`);
                continue;
              }

              const htmlCedible = this._buildHtml({ doc, esCedible: true, tedDataUri });
              const outputNameCedible = `muestra_${doc.tipoDte}_${doc.folio}_cedible.pdf`;
              const outputPathCedible = path.join(targetDir, outputNameCedible);

              await this._generarPdf({ html: htmlCedible, outputPath: outputPathCedible, browser });
              resultado.totalPdfs++;
              resultado.archivos.push(outputPathCedible);
              if (isPruebas) resultado.setPruebas++;
              else resultado.setSimulacion++;
              console.log(`      ✓ ${outputNameCedible}`);
            }

          } catch (e) {
            console.log(`      ❌ Error: ${e.message}`);
            resultado.errores.push({ tipo: doc.tipoDte, folio: doc.folio, error: e.message });
          }
        }
      }
    } finally {
      await browser.close();
    }

    // Resumen
    console.log('\n' + '═'.repeat(60));
    console.log('✅ MUESTRAS IMPRESAS GENERADAS');
    console.log('═'.repeat(60));
    console.log(`   📄 Documentos procesados: ${resultado.totalDocs}`);
    console.log(`   📄 PDFs generados: ${resultado.totalPdfs}`);
    console.log(`   📂 SET-PRUEBAS: ${resultado.setPruebas} PDFs`);
    console.log(`   📂 SET-SIMULACION: ${resultado.setSimulacion} PDFs`);
    console.log(`   📂 Directorio base: ${outDir}`);

    if (resultado.errores.length > 0) {
      resultado.success = false;
      console.log(`   ⚠️ Errores: ${resultado.errores.length}`);
    }

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
