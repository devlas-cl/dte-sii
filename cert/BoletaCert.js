// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * BoletaCert.js
 * 
 * Módulo para certificación de Boletas Electrónicas (tipo 39 y 41).
 * 
 * Proceso de certificación:
 * 1. Usuario obtiene Set de Pruebas manualmente desde SII (requiere clave tributaria)
 *    URL: https://www4.sii.cl/certBolElectDteInternet/?SET=1
 * 2. Se genera EnvioBOLETA con todas las boletas del set
 * 3. Se genera RCOF (ConsumoFolio) para reportar los folios usados
 * 4. Se envían ambos documentos al SII
 * 5. SII valida y aprueba
 */

const path = require('path');
const fs = require('fs');

class BoletaCert {
  /**
   * @param {Object} options
   * @param {Object} options.certificado - Instancia de Certificado
   * @param {Object} options.emisor - Datos del emisor { rut, razon_social, giro, direccion, comuna, ciudad, fch_resol, nro_resol }
   * @param {string} options.ambiente - 'certificacion' | 'produccion'
   * @param {Object} options.resolucion - { fecha, numero }
   * @param {string} options.debugDir - Directorio para debug
   */
  constructor(options) {
    this.certificado = options.certificado;
    this.emisor = options.emisor;
    this.ambiente = options.ambiente || 'certificacion';
    this.resolucion = options.resolucion;
    this.debugDir = options.debugDir;
    
    // Librerías (se cargan bajo demanda)
    this._dteLib = null;
  }

  _lib() {
    if (!this._dteLib) {
      this._dteLib = require('../index');
    }
    return this._dteLib;
  }

  /**
   * Parsea el set de pruebas desde archivo de texto
   * @param {string} filePath - Ruta al archivo del set
   * @returns {Object[]} Array de casos parseados
   */
  parseSetPruebas(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').map(l => l.trim());
    
    const casos = [];
    let currentCaso = null;
    let inItems = false;
    
    for (const line of lines) {
      // Detectar inicio de caso
      const casoMatch = line.match(/^CASO-?(\d+)/i);
      if (casoMatch) {
        if (currentCaso) {
          casos.push(currentCaso);
        }
        currentCaso = {
          numero: parseInt(casoMatch[1], 10),
          items: [],
          observaciones: []
        };
        inItems = false;
        continue;
      }
      
      // Detectar línea de headers de items
      if (line.includes('Item') && line.includes('Cantidad') && line.includes('Precio')) {
        inItems = true;
        continue;
      }
      
      // Detectar observación
      if (line.startsWith('OBSERVACION')) {
        const obsMatch = line.match(/OBSERVACION[ES]*:\s*"?([^"]+)"?/i);
        if (obsMatch && currentCaso) {
          currentCaso.observaciones.push(obsMatch[1].trim());
        }
        continue;
      }
      
      // Parsear item (línea con tabs separando: nombre, cantidad, precio)
      if (inItems && currentCaso && line.length > 0 && !line.startsWith('=')) {
        // Separar por tabs o múltiples espacios
        const parts = line.split(/\t+|\s{2,}/).filter(p => p.trim().length > 0);
        if (parts.length >= 3) {
          const nombre = parts[0].trim();
          const cantidad = parseFloat(parts[1].replace(',', '.'));
          const precio = parseInt(parts[2].replace(/\./g, '').replace(',', ''), 10);
          
          if (!isNaN(cantidad) && !isNaN(precio)) {
            // Detectar si es exento por el nombre del item (ej: "item exento 2")
            const esExento = nombre.toLowerCase().includes('exento');
            
            currentCaso.items.push({
              nombre,
              cantidad,
              precio,
              exento: esExento
            });
          }
        }
      }
    }
    
    // Agregar último caso
    if (currentCaso) {
      casos.push(currentCaso);
    }
    
    return casos;
  }

  /**
   * Genera boletas a partir de los casos del set
   * @param {Object[]} casos - Casos parseados del set
   * @param {Object} cafBoleta - CAF para boletas tipo 39
   * @param {number} folioInicial - Folio inicial
   * @returns {Object} { boletas: DTE[], folioUsados }
   */
  async generarBoletasSet(casos, cafBoleta, folioInicial) {
    const { DTE, CAF } = this._lib();
    
    const boletas = [];
    let folioActual = folioInicial;
    
    const fechaHoy = new Date().toISOString().split('T')[0];
    
    for (const caso of casos) {
      // Preparar items
      const items = caso.items.map(item => ({
        NmbItem: item.nombre,
        QtyItem: item.cantidad,
        PrcItem: item.precio,
        ...(item.unidad ? { UnmdItem: item.unidad } : {}),
        ...(item.exento ? { IndExe: 1 } : {}),
      }));
      
      // Verificar si el caso tiene observación sobre unidad de medida
      const obsUnidad = caso.observaciones.find(obs => 
        obs.toLowerCase().includes('unidad de medida')
      );
      if (obsUnidad) {
        // Ejemplo: "Se debe informar en el XML Unidad de medida en Kg."
        const unidadMatch = obsUnidad.match(/en\s+(\w+)\.?$/i);
        if (unidadMatch && items.length > 0) {
          items[0].UnmdItem = unidadMatch[1];
        }
      }
      
      // Crear DTE
      const dteDatos = {
        tipo: 39,
        folio: folioActual,
        fechaEmision: fechaHoy,
        emisor: {
          RUTEmisor: this.emisor.rut,
          RznSocEmisor: this.emisor.razon_social,
          GiroEmisor: this.emisor.giro,
          DirOrigen: this.emisor.direccion,
          CmnaOrigen: this.emisor.comuna,
          CiudadOrigen: this.emisor.ciudad,
        },
        receptor: {
          RUTRecep: '66666666-6', // Consumidor final
          RznSocRecep: 'Consumidor Final',
          DirRecep: 'Sin Direccion',
          CmnaRecep: 'Santiago',
        },
        items,
        referencia: {
          codigo: 'SET',
          razon: `CASO-${caso.numero}`,
        },
        certificado: this.certificado,
        caf: cafBoleta,
      };
      
      const dte = new DTE(dteDatos);
      boletas.push({
        dte,
        caso: caso.numero,
        folio: folioActual,
      });
      
      folioActual++;
    }
    
    return {
      boletas,
      foliosUsados: boletas.length,
      folioInicial,
      folioFinal: folioActual - 1,
    };
  }

  /**
   * Genera el EnvioBOLETA con todas las boletas del set
   * @param {Object[]} boletas - Array de { dte, caso, folio }
   * @returns {EnvioBOLETA}
   */
  generarEnvioBoleta(boletas) {
    const { EnvioBOLETA } = this._lib();
    
    const envioBoleta = new EnvioBOLETA({
      rutEmisor: this.emisor.rut,
      rutEnvia: this.certificado.rut,
      fchResol: this.resolucion.fecha,
      nroResol: this.resolucion.numero,
      certificado: this.certificado,
    });
    
    // Agregar cada boleta
    for (const { dte } of boletas) {
      envioBoleta.agregar(dte);
    }
    
    // Carátula para certificación
    envioBoleta.setCaratula({
      RutEmisor: this.emisor.rut,
      RutEnvia: this.certificado.rut,
      RutReceptor: '60803000-K', // SII en certificación
      FchResol: this.resolucion.fecha,
      NroResol: this.resolucion.numero,
    });
    
    envioBoleta.generar();
    
    return envioBoleta;
  }

  /**
   * Genera el RCOF (ConsumoFolio) para las boletas
   * @param {EnvioBOLETA} envioBoleta - EnvioBOLETA generado
   * @param {Object} [options] - Opciones opcionales
   * @param {number} [options.secEnvio] - Número de secuencia del envío (default: 1)
   * @returns {ConsumoFolio}
   */
  generarConsumoFolio(envioBoleta, options = {}) {
    const { ConsumoFolio } = this._lib();
    
    const consumoFolio = new ConsumoFolio(this.certificado);
    
    // Agregar documentos desde el EnvioBOLETA
    // Necesitamos extraer la info de cada boleta
    const boletas = envioBoleta.dtes || [];
    for (const dte of boletas) {
      const tipo = dte.datos.Encabezado.IdDoc.TipoDTE;
      const folio = dte.datos.Encabezado.IdDoc.Folio;
      const fechaEmision = dte.datos.Encabezado.IdDoc.FchEmis;
      const totales = dte.datos.Encabezado.Totales;
      
      // Estructura que espera ConsumoFolio: Totales como hijo de Encabezado
      consumoFolio.agregar(tipo, {
        Encabezado: {
          IdDoc: {
            TipoDTE: tipo,
            Folio: folio,
            FchEmis: fechaEmision,
          },
          Totales: {
            MntNeto: totales.MntNeto || 0,
            MntExe: totales.MntExe || 0,
            IVA: totales.IVA || 0,
            MntTotal: totales.MntTotal || 0,
          }
        },
      });
    }
    
    // Establecer carátula
    consumoFolio.setCaratula({
      RutEmisor: this.emisor.rut,
      RutEnvia: this.certificado.rut,
      FchResol: this.resolucion.fecha,
      NroResol: this.resolucion.numero,
      SecEnvio: options?.secEnvio || 1,
    });
    
    return consumoFolio;
  }

  /**
   * Reenvía solo el RCOF para un EnvioBOLETA ya enviado
   * Útil cuando el RCOF anterior fue rechazado por secuencia o tenía datos incorrectos
   * @param {Object} options
   * @param {string} options.envioBOLETAPath - Ruta al XML del EnvioBOLETA ya enviado
   * @param {number} options.secEnvio - Número de secuencia para el RCOF
   * @returns {Promise<Object>} Resultado con trackId
   */
  async reenviarRCOF(options) {
    const { EnviadorSII, DOMParser } = this._lib();
    const { DOMParser: XMLParser } = require('@xmldom/xmldom');
    
    console.log('\n' + '═'.repeat(60));
    console.log('REENVÍO RCOF (ConsumoFolio)');
    console.log('═'.repeat(60));
    
    // 1. Parsear el EnvioBOLETA existente para extraer info
    console.log('\nLeyendo EnvioBOLETA...');
    const envioBOLETAXml = fs.readFileSync(options.envioBOLETAPath, 'utf-8');
    const parser = new XMLParser();
    const doc = parser.parseFromString(envioBOLETAXml, 'text/xml');
    
    // Extraer info de cada DTE
    const dtes = doc.getElementsByTagName('Documento');
    const boletas = [];
    
    for (let i = 0; i < dtes.length; i++) {
      const dte = dtes[i];
      const tipo = parseInt(dte.getElementsByTagName('TipoDTE')[0]?.textContent || '39', 10);
      const folio = parseInt(dte.getElementsByTagName('Folio')[0]?.textContent || '0', 10);
      const fchEmis = dte.getElementsByTagName('FchEmis')[0]?.textContent || '';
      
      const totalesEl = dte.getElementsByTagName('Totales')[0];
      const mntNeto = parseInt(totalesEl?.getElementsByTagName('MntNeto')[0]?.textContent || '0', 10);
      const mntExe = parseInt(totalesEl?.getElementsByTagName('MntExe')[0]?.textContent || '0', 10);
      const iva = parseInt(totalesEl?.getElementsByTagName('IVA')[0]?.textContent || '0', 10);
      const mntTotal = parseInt(totalesEl?.getElementsByTagName('MntTotal')[0]?.textContent || '0', 10);
      
      boletas.push({
        Encabezado: {
          IdDoc: { TipoDTE: tipo, Folio: folio, FchEmis: fchEmis },
          Totales: { MntNeto: mntNeto, MntExe: mntExe, IVA: iva, MntTotal: mntTotal }
        }
      });
      console.log(` - Folio ${folio}: Neto=${mntNeto}, Exento=${mntExe}, IVA=${iva}, Total=${mntTotal}`);
    }
    
    // 2. Crear RCOF
    console.log(`\nGenerando RCOF con SecEnvio=${options.secEnvio}...`);
    const { ConsumoFolio } = this._lib();
    const consumoFolio = new ConsumoFolio(this.certificado);
    
    for (const b of boletas) {
      consumoFolio.agregar(b.Encabezado.IdDoc.TipoDTE, b);
    }
    
    consumoFolio.setCaratula({
      RutEmisor: this.emisor.rut,
      RutEnvia: this.certificado.rut,
      FchResol: this.resolucion.fecha,
      NroResol: this.resolucion.numero,
      SecEnvio: options.secEnvio,
    });
    
    consumoFolio.generar();
    console.log(` ✓ XML generado: ${consumoFolio.xml.length} bytes`);
    
    // Guardar debug
    if (this.debugDir) {
      const debugPath = path.join(this.debugDir, 'boleta-cert');
      fs.mkdirSync(debugPath, { recursive: true });
      fs.writeFileSync(path.join(debugPath, `ConsumoFolio-sec${options.secEnvio}.xml`), consumoFolio.xml, 'utf-8');
      console.log(` Guardado en: ${path.join(debugPath, `ConsumoFolio-sec${options.secEnvio}.xml`)}`);
    }
    
    // 3. Enviar RCOF
    console.log('\nEnviando RCOF al SII...');
    const enviador = new EnviadorSII(this.certificado, this.ambiente);
    const resultadoRCOF = await enviador.enviarConsumoFolios(consumoFolio);
    
    if (!resultadoRCOF.ok) {
      console.log(` [ERR] Error: ${resultadoRCOF.error}`);
      return { success: false, error: resultadoRCOF.error };
    }
    console.log(` [OK] Enviado - TrackId: ${resultadoRCOF.trackId}`);
    
    return { success: true, trackIdRCOF: resultadoRCOF.trackId };
  }

  /**
   * Ejecuta el proceso completo de certificación de boletas
   * @param {Object} options
   * @param {string} options.setPath - Ruta al archivo del set de pruebas
   * @param {Object} options.cafBoleta - CAF para boletas tipo 39
   * @param {number} options.folioInicial - Folio inicial a usar
   * @returns {Promise<Object>} Resultado con trackIds
   */
  async ejecutarCertificacion(options) {
    const { EnviadorSII } = this._lib();
    
    console.log('\n' + '═'.repeat(60));
    console.log('CERTIFICACIÓN BOLETAS ELECTRÓNICAS');
    console.log('═'.repeat(60));
    
    // 1. Parsear set de pruebas
    console.log('\nParseando set de pruebas...');
    const casos = this.parseSetPruebas(options.setPath);
    console.log(` ✓ ${casos.length} casos encontrados`);
    
    // 2. Generar boletas
    console.log('\nGenerando boletas...');
    const { boletas, foliosUsados, folioInicial, folioFinal } = await this.generarBoletasSet(
      casos, 
      options.cafBoleta, 
      options.folioInicial
    );
    console.log(` ✓ ${boletas.length} boletas generadas (folios ${folioInicial}-${folioFinal})`);
    
    for (const b of boletas) {
      const monto = b.dte.montoTotal || 0;
      console.log(` - CASO-${b.caso}: Folio ${b.folio} - $${monto.toLocaleString('es-CL')}`);
    }
    
    // 3. Generar EnvioBOLETA
    console.log('\nGenerando EnvioBOLETA...');
    const envioBoleta = this.generarEnvioBoleta(boletas);
    console.log(` ✓ XML generado: ${envioBoleta.xml.length} bytes`);
    
    // Guardar debug
    if (this.debugDir) {
      const debugPath = path.join(this.debugDir, 'boleta-cert');
      fs.mkdirSync(debugPath, { recursive: true });
      fs.writeFileSync(path.join(debugPath, 'EnvioBOLETA.xml'), envioBoleta.xml, 'utf-8');
      console.log(` Guardado en: ${path.join(debugPath, 'EnvioBOLETA.xml')}`);
    }
    
    // 4. Enviar EnvioBOLETA
    console.log('\nEnviando EnvioBOLETA al SII...');
    const enviador = new EnviadorSII(this.certificado, this.ambiente);
    const resultadoBoleta = await enviador.enviarBoletaSoap(envioBoleta);
    
    if (!resultadoBoleta.ok) {
      console.log(` [ERR] Error: ${resultadoBoleta.error}`);
      return { success: false, error: resultadoBoleta.error, fase: 'EnvioBOLETA' };
    }
    console.log(` [OK] Enviado - TrackId: ${resultadoBoleta.trackId}`);
    
    // 5. Generar RCOF
    console.log('\nGenerando RCOF (ConsumoFolio)...');
    const consumoFolio = this.generarConsumoFolio(envioBoleta);
    consumoFolio.generar(); // generar() ya incluye firmar() internamente
    console.log(` ✓ XML generado: ${consumoFolio.xml.length} bytes`);
    
    // Guardar debug
    if (this.debugDir) {
      const debugPath = path.join(this.debugDir, 'boleta-cert');
      fs.writeFileSync(path.join(debugPath, 'ConsumoFolio.xml'), consumoFolio.xml, 'utf-8');
      console.log(` Guardado en: ${path.join(debugPath, 'ConsumoFolio.xml')}`);
    }
    
    // 6. Enviar RCOF
    console.log('\nEnviando RCOF al SII...');
    const resultadoRCOF = await enviador.enviarConsumoFolios(consumoFolio);
    
    if (!resultadoRCOF.ok) {
      console.log(` [ERR] Error: ${resultadoRCOF.error}`);
      return { 
        success: false, 
        error: resultadoRCOF.error, 
        fase: 'RCOF',
        trackIdBoleta: resultadoBoleta.trackId 
      };
    }
    console.log(` [OK] Enviado - TrackId: ${resultadoRCOF.trackId}`);
    
    // Resumen
    console.log('\n' + '═'.repeat(60));
    console.log('[OK] CERTIFICACIÓN BOLETAS COMPLETADA');
    console.log('═'.repeat(60));
    console.log(` EnvioBOLETA: ${resultadoBoleta.trackId}`);
    console.log(` RCOF: ${resultadoRCOF.trackId}`);
    console.log(` Boletas: ${boletas.length}`);
    console.log(` Folios: ${folioInicial} - ${folioFinal}`);
    
    return {
      success: true,
      trackIdBoleta: resultadoBoleta.trackId,
      trackIdRCOF: resultadoRCOF.trackId,
      boletas: boletas.length,
      folioInicial,
      folioFinal,
    };
  }

  /**
   * Declara avance de certificación de boletas validando el TrackId
   * Usa el endpoint DTEauth?3 que requiere autenticación con certificado
   * @param {string} trackId - TrackId del envío a validar
   * @returns {Promise<Object>} Resultado de la validación
   */
  async declararAvance(trackId) {
    const https = require('https');
    const forge = require('node-forge');
    
    console.log('\n' + '═'.repeat(60));
    console.log('DECLARAR AVANCE BOLETAS');
    console.log('═'.repeat(60));
    console.log(` TrackId: ${trackId}`);
    
    const host = this.ambiente === 'produccion' ? 'palena.sii.cl' : 'maullin.sii.cl';
    const endpoint = '/cgi_dte/UPL/DTEauth?3';
    const url = `https://${host}${endpoint}`;
    
    // Preparar datos del formulario
    const { splitRut } = this._lib();
    const { numero: rutNum, dv } = splitRut(this.emisor.rut);
    
    const formData = {
      RUT: rutNum,
      DV: dv,
      ESSION_ID: trackId,
    };
    
    // Codificar como form-urlencoded
    const formEncode = (obj) => Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const body = formEncode(formData);
    
    // Cargar certificado para TLS mutuo
    const pfx = this.certificado.pfxBuffer;
    const password = this.certificado.password;
    const p12Asn1 = forge.asn1.fromDer(pfx.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    const keyObj = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0];
    const certObj = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0];
    
    const tlsOptions = {
      key: forge.pki.privateKeyToPem(keyObj.key),
      cert: forge.pki.certificateToPem(certObj.cert),
      rejectUnauthorized: false,
    };
    
    // Hacer request
    const requestWithCert = (options, payload) => new Promise((resolve, reject) => {
      const req = https.request({ ...options, ...tlsOptions }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          text: data,
          headers: res.headers,
        }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    
    console.log(` URL: ${url}`);
    
    try {
      const response = await requestWithCert({
        method: 'POST',
        hostname: host,
        path: endpoint,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, body);
      
      console.log(` Status: ${response.status}`);
      
      // Guardar respuesta para debug
      if (this.debugDir) {
        const debugPath = path.join(this.debugDir, 'boleta-cert');
        fs.mkdirSync(debugPath, { recursive: true });
        fs.writeFileSync(
          path.join(debugPath, `validacion-${trackId}.html`),
          response.text,
          'utf-8'
        );
      }
      
      // Parsear respuesta
      const html = response.text;
      
      // Detectar estados
      const esAprobado = /REVISADO CONFORME|APROBADO|OK/i.test(html);
      const esRechazado = /RECHAZADO|ERROR|REPARO/i.test(html);
      const enRevision = /EN REVISION|PROCESANDO/i.test(html);
      
      if (esAprobado) {
        console.log(' [OK] BOLETAS APROBADAS');
        return { success: true, estado: 'APROBADO', html };
      } else if (esRechazado) {
        console.log(' [ERR] BOLETAS RECHAZADAS');
        // Extraer mensaje de error si existe
        const errorMatch = html.match(/<font[^>]*color[^>]*red[^>]*>([^<]+)</i);
        const errorMsg = errorMatch ? errorMatch[1].trim() : 'Error desconocido';
        return { success: false, estado: 'RECHAZADO', error: errorMsg, html };
      } else if (enRevision) {
        console.log(' [...] EN REVISIÓN');
        return { success: true, estado: 'EN_REVISION', html };
      } else {
        console.log(' Respuesta recibida (verificar manualmente)');
        return { success: true, estado: 'DESCONOCIDO', html };
      }
      
    } catch (error) {
      console.error(` [ERR] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Valida el estado del set de pruebas de boletas consultando al SII
   * @param {string} trackId - TrackId del EnvioBOLETA
   * @returns {Promise<Object>} Estado del set (SOK, SRH, etc.)
   */
  async validarSetBoletas(trackId) {
    const https = require('https');
    const forge = require('node-forge');
    
    console.log(`\n Consultando estado del set...`);
    console.log(` TrackId: ${trackId}`);
    
    const host = this.ambiente === 'produccion' ? 'www4.sii.cl' : 'www4.sii.cl';
    
    // Endpoint para consultar estado del set de boletas
    // El portal usa certBolElectDteInternet con parámetro SET=2 para revisar
    const endpoint = `/certBolElectDteInternet/ConsSetDte.do`;
    
    // Preparar datos del formulario
    const { splitRut } = this._lib();
    const { numero: rutNum, dv } = splitRut(this.emisor.rut);
    
    const formData = {
      RUT_EMPRESA: rutNum,
      DV_EMPRESA: dv,
      TRACK_ID: trackId,
    };
    
    // Codificar como form-urlencoded
    const formEncode = (obj) => Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const body = formEncode(formData);
    
    // Cargar certificado para TLS mutuo
    const pfx = this.certificado.pfxBuffer;
    const password = this.certificado.password;
    const p12Asn1 = forge.asn1.fromDer(pfx.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    const keyObj = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0];
    const certObj = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0];
    
    const tlsOptions = {
      key: forge.pki.privateKeyToPem(keyObj.key),
      cert: forge.pki.certificateToPem(certObj.cert),
      rejectUnauthorized: false,
    };
    
    // Hacer request
    const requestWithCert = (options, payload) => new Promise((resolve, reject) => {
      const req = https.request({ ...options, ...tlsOptions }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          text: data,
          headers: res.headers,
        }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    
    try {
      const response = await requestWithCert({
        method: 'POST',
        hostname: host,
        path: endpoint,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, body);
      
      // Guardar respuesta para debug
      if (this.debugDir) {
        const debugPath = path.join(this.debugDir, 'boleta-cert');
        fs.mkdirSync(debugPath, { recursive: true });
        fs.writeFileSync(
          path.join(debugPath, `set-estado-${trackId}.html`),
          response.text,
          'utf-8'
        );
      }
      
      const html = response.text;
      
      // Buscar estado del set en la respuesta
      const sokMatch = /SOK|SET DE PRUEBA CORRECTO/i.test(html);
      const srhMatch = /SRH|SET DE PRUEBA RECHAZADO/i.test(html);
      const pendienteMatch = /PENDIENTE|EN PROCESO|PROCESANDO/i.test(html);
      
      // Extraer detalle de reparos si existe
      const reparosMatch = html.match(/Detalle de Reparos[\s\S]*?(<table[\s\S]*?<\/table>|CASO-\d+[\s\S]*?(?=\n\n|\<))/i);
      const detalle = reparosMatch ? reparosMatch[0].replace(/<[^>]+>/g, ' ').trim().substring(0, 500) : null;
      
      if (sokMatch) {
        return { success: true, estado: 'SOK', detalle: 'Set de prueba correcto' };
      } else if (srhMatch) {
        return { success: false, estado: 'SRH', detalle: detalle || 'Set rechazado - ver correo SII' };
      } else if (pendienteMatch) {
        return { success: true, estado: 'PENDIENTE', detalle: 'Aún en proceso de validación' };
      } else {
        // Si no podemos determinar el estado, intentar consultar por correo
        return { 
          success: true, 
          estado: 'DESCONOCIDO', 
          detalle: 'Estado no determinado - verificar correo SII o portal manualmente'
        };
      }
      
    } catch (error) {
      console.error(` [!] Error consultando estado: ${error.message}`);
      return { 
        success: true, 
        estado: 'DESCONOCIDO', 
        detalle: `No se pudo consultar automáticamente: ${error.message}`
      };
    }
  }
}

module.exports = BoletaCert;
