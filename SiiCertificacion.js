// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiCertificacion.js - Automatización del proceso de certificación DTE
 * 
 * Este servicio automatiza las operaciones del portal de certificación del SII:
 * - Generar set de pruebas
 * - Declarar avance
 * - Ver estado de avance
 * - Declarar cumplimiento
 * 
 * Solo requiere el certificado digital (autenticación TLS mutua).
 * No requiere clave SII del usuario.
 * 
 * @module SiiCertificacion
 */

const SiiSession = require('./SiiSession.js');

/**
 * Etapas de certificación DTE
 */
const ETAPAS_CERTIFICACION = {
  SET_BASICO: 'SET_BASICO',
  SET_SIMULACION_FACTURACION: 'SET_SIMULACION_FACTURACION', 
  SET_INTERCAMBIO: 'SET_INTERCAMBIO',
  SET_ENVIO_BOLETAS: 'SET_ENVIO_BOLETAS',
  MUESTRAS_IMPRESAS: 'MUESTRAS_IMPRESAS',
  DECLARACION_CUMPLIMIENTO: 'DECLARACION_CUMPLIMIENTO',
};

/**
 * Tipos de documentos para certificación
 */
const TIPOS_DTE = {
  FACTURA_ELECTRONICA: 33,
  FACTURA_EXENTA: 34,
  BOLETA_ELECTRONICA: 39,
  BOLETA_EXENTA: 41,
  LIQUIDACION_FACTURA: 43,
  FACTURA_COMPRA: 46,
  GUIA_DESPACHO: 52,
  NOTA_DEBITO: 56,
  NOTA_CREDITO: 61,
};

class SiiCertificacion {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.pfxPath - Ruta al certificado PFX/P12
   * @param {string} options.pfxPassword - Contraseña del certificado
   * @param {string} options.rutEmpresa - RUT de la empresa (sin DV)
   * @param {string} options.dvEmpresa - Dígito verificador de la empresa
   */
  constructor(options = {}) {
    if (!options.pfxPath) {
      throw new Error('SiiCertificacion: pfxPath es obligatorio');
    }
    if (!options.pfxPassword && options.pfxPassword !== '') {
      throw new Error('SiiCertificacion: pfxPassword es obligatorio');
    }
    if (!options.rutEmpresa || !options.dvEmpresa) {
      throw new Error('SiiCertificacion: rutEmpresa y dvEmpresa son obligatorios');
    }

    this.rutEmpresa = options.rutEmpresa.replace(/\./g, '');
    this.dvEmpresa = options.dvEmpresa.toUpperCase();
    
    this.session = new SiiSession({
      pfxPath: options.pfxPath,
      pfxPassword: options.pfxPassword,
      ambiente: 'certificacion',
    });
  }

  /**
   * Guarda la sesión actual en un archivo
   * @param {string} filePath - Ruta donde guardar la sesión
   */
  saveSession(filePath) {
    this.session.saveSession(filePath);
  }

  /**
   * Carga una sesión desde un archivo
   * @param {string} filePath - Ruta del archivo de sesión
   * @returns {boolean} - true si se cargó exitosamente
   */
  loadSession(filePath) {
    return this.session.loadSession(filePath);
  }

  /**
   * Verifica si existe una sesión válida en el archivo
   * @param {string} filePath - Ruta del archivo de sesión
   * @returns {boolean}
   */
  static isSessionValid(filePath) {
    return SiiSession.isSessionValid(filePath);
  }

  /**
   * Extrae el valor de un campo de formulario del HTML
   * @private
   */
  _extractFormValue(html, fieldName) {
    const regex = new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, 'i');
    const match = html.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Extrae opciones de un select
   * @private
   */
  _extractSelectOptions(html, selectName) {
    const selectRegex = new RegExp(`<select[^>]*name="${selectName}"[^>]*>([\\s\\S]*?)<\\/select>`, 'i');
    const selectMatch = html.match(selectRegex);
    if (!selectMatch) return [];

    const options = [];
    const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(selectMatch[1])) !== null) {
      if (match[1]) {
        options.push({ value: match[1], text: match[2].trim() });
      }
    }
    return options;
  }

  /**
   * Maneja la página de selección de representación
   * @private
   */
  async _handleRepresentacionPage(response) {
    const body = response.body || '';
    
    // Si es página de selección de representación, seguir con "Continuar"
    if (body.includes('ESCOJA COMO DESEA INGRESAR')) {
      const continuarMatch = body.match(/href="([^"]+)"[^>]*>\s*Continuar\s*</i);
      if (continuarMatch) {
        const continuarUrl = continuarMatch[1];
        return await this.session.request(continuarUrl, { method: 'GET' });
      }
    }
    
    return response;
  }

  /**
   * Genera un set de pruebas para certificación
   * @param {Object} options - Opciones
   * @param {boolean} options.descargar - Si true, descarga el set (envía formulario)
   * @param {Object} options.setsOpcionales - Sets opcionales a incluir {SET03: 'S', SET06: 'S', etc}
   * @returns {Promise<Object>} Información del set generado
   */
  async generarSetPruebas(options = {}) {
    try {
      // 1. Acceder a la página de generación
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_generar');
      
      // 2. Manejar página de representación si aparece
      response = await this._handleRepresentacionPage(response);
      
      let body = response.body || '';

      // 3. Si la sesión guardada causó "no inscrito", limpiar cookies y re-autenticar
      //    desde pe_generar mismo (ensureSession hará el redirect TLS correcto)
      if (body.includes('no est\u00e1 inscrito') || body.includes('no esta inscrito')) {
        this.session.reset();
        response = await this.session.ensureSession('/cvc_cgi/dte/pe_generar');
        response = await this._handleRepresentacionPage(response);
        body = response.body || '';
      }

      // 4. Primer paso: Enviar RUT de empresa (pe_generar → pe_generar1) — solo si el portal lo pide
      if (body.includes('pe_generar1') || body.includes('Confirmar Empresa')) {
        const formResponse = await this.session.submitForm(
          '/cvc_cgi/dte/pe_generar1',
          {
            RUT_EMP: this.rutEmpresa,
            DV_EMP: this.dvEmpresa,
            CODIGO: '8',
            ACEPTAR: 'Confirmar Empresa',
          },
          'https://maullin.sii.cl/cvc_cgi/dte/pe_generar'
        );
        body = formResponse.body || '';
      }

      // 5. Parsear estado de sets desde la tabla HTML
      const estadoSets = this._parseEstadoSets(body);
      
      // 6. Extraer checkboxes de sets opcionales disponibles
      const setsOpcionales = this._extractSetsOpcionales(body);
      
      // 7. Información de la página
      const info = {
        success: true,
        estadoSets,
        setsOpcionales,
        rawHtml: body,
        // Detectar 'no inscrito' con y sin HTML entities (SII usa ISO-8859-1)
        noInscrito: body.includes('no está inscrito') || body.includes('no esta inscrito') ||
                    body.includes('no est&aacute;') || body.includes('no est\xE1 inscrito'),
      };

      // 8. Si se solicitó descargar, enviar formulario
      if (options.descargar) {
        // Leer AUTORIZADA y TOTAL dinámicamente desde el HTML
        const autorizadaMatch = body.match(/name=["']?AUTORIZADA["']?[^>]*value=["']([^"']*)["']/i)
                             || body.match(/value=["']([^"']*)["'][^>]*name=["']?AUTORIZADA["']?/i);
        const totalMatch     = body.match(/name=["']?TOTAL["']?[^>]*value=["']([^"']*)["']/i)
                             || body.match(/value=["']([^"']*)["'][^>]*name=["']?TOTAL["']?/i);

        const formData = {
          RUT_EMP:    this.rutEmpresa,
          DV_EMP:     this.dvEmpresa,
          AUTORIZADA: autorizadaMatch ? autorizadaMatch[1] : 'S',
          TOTAL:      totalMatch      ? totalMatch[1]      : '15',
        };

        // Marcar solo los sets opcionales configurados (DEFAULT_SETS_OPCIONALES)
        // No marcar todos para evitar incluir Exportación, Liquidación, etc.
        const requestedSets = options.setsOpcionales || {};
        for (const set of setsOpcionales) {
          if (requestedSets[set.id]) {
            formData[set.id] = 'S';
          }
        }
        // SET01 (básico) siempre incluido aunque no aparezca como checkbox opcional
        formData.SET01 = 'S';
        
        const genResponse = await this.session.submitForm(
          '/cvc_cgi/dte/pe_generar2',
          formData,
          'https://maullin.sii.cl/cvc_cgi/dte/pe_generar1'
        );

        info.setDescargado = {
          success: true,
          rawHtml: genResponse.body,
        };
        
        // Parsear el contenido del set descargado
        const setContent = this._parseSetDescargado(genResponse.body);
        if (setContent) {
          info.setDescargado.casos = setContent.casos;
          info.setDescargado.caratula = setContent.caratula;
        }
      }

      return info;

    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Parsea el estado de los sets desde la tabla HTML
   * @private
   */
  _parseEstadoSets(html) {
    const sets = [];
    
    // Buscar filas de la tabla con sets
    const filaRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>[\s\S]*?<font[^>]*>(.*?)<\/font>[\s\S]*?<\/td>[\s\S]*?<td[^>]*>[\s\S]*?<font[^>]*>(.*?)<\/font>[\s\S]*?<\/td>[\s\S]*?<\/tr>/gi;
    
    let match;
    while ((match = filaRegex.exec(html)) !== null) {
      const nombre = match[1].replace(/<[^>]+>/g, '').trim();
      const estado = match[2].replace(/<[^>]+>/g, '').trim();
      
      // Ignorar cabeceras
      if (nombre && !nombre.includes('Set Obtenido') && nombre.length > 2) {
        sets.push({ nombre, estado });
      }
    }
    
    return sets;
  }

  /**
   * Extrae los checkboxes de sets opcionales disponibles
   * @private
   */
  _extractSetsOpcionales(html) {
    const opcionales = [];
    
    // Buscar checkboxes con nombre SETXX (type="CHECKBOX" o type=CHECKBOX, con o sin comillas)
    const checkboxRegex = /<input[^>]*name=["']?(SET\d+)["']?[^>]*type=["']?checkbox["']?[^>]*>\s*([^<\r\n]+)/gi;
    
    let match;
    while ((match = checkboxRegex.exec(html)) !== null) {
      opcionales.push({
        id: match[1],
        nombre: match[2].trim(),
      });
    }
    
    return opcionales;
  }

  /**
   * Parsea el contenido del set descargado
   * @private
   */
  _parseSetDescargado(html) {
    if (!html) return null;
    
    // El set viene en formato texto plano dentro del HTML o como descarga
    // Buscar patrones de casos de prueba
    const resultado = {
      casos: [],
      caratula: null,
      rawText: '',
    };
    
    // Extraer texto limpio
    const textoLimpio = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&aacute;/g, 'á')
      .replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í')
      .replace(/&oacute;/g, 'ó')
      .replace(/&uacute;/g, 'ú')
      .replace(/&ntilde;/g, 'ñ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
    
    resultado.rawText = textoLimpio;
    
    // Buscar casos numerados (CASO-1, CASO-2, etc.)
    const casoRegex = /CASO[-\s]*(\d+)[\s:]+([^\n]+)/gi;
    let casoMatch;
    while ((casoMatch = casoRegex.exec(textoLimpio)) !== null) {
      resultado.casos.push({
        numero: parseInt(casoMatch[1]),
        descripcion: casoMatch[2].trim(),
      });
    }
    
    return resultado;
  }

  /**
   * Consulta el estado de los sets sin declarar avance
   * Solo accede a pe_avance2 para ver el estado actual
   * @returns {Promise<Object>} Estado de los sets
   */
  async consultarEstadoSets() {
    try {
      // 1. Acceder a la página de declarar avance
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance1');
      response = await this._handleRepresentacionPage(response);
      
      // 2. Enviar formulario con RUT empresa para ir al formulario de sets
      const formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance2',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance1'
      );

      const html = formResponse.body || '';
      
      // Parsear estado de cada set/libro
      const estadoSets = {};
      
      // Parsear estado de cada set/libro fila por fila para evitar falsos positivos
      // (la regex global cruzaba filas y asignaba REVISADO CONFORME de SET CASO GENERAL a LIBRO DE VENTAS)
      const rows = html.split(/<\/tr>/i);
      for (const row of rows) {
        const nameMatch = /(SET[^<\n\r]*|LIBRO[^<\n\r]*)<\/font><\/td>/i.exec(row);
        if (!nameMatch) continue;
        const nombre = nameMatch[1].trim();
        // Estado explícito en <b>...</b>
        const stateMatch = /<b>([^<]+)<\/b>/i.exec(row);
        if (stateMatch) {
          estadoSets[nombre] = stateMatch[1].trim().toUpperCase();
        } else {
          // Fila con campos input: leer valor EST oculto (S01 = sin declarar, S21 = declarado)
          const estMatch = /name="EST\d+"[^>]*value="([^"]+)"/i.exec(row);
          estadoSets[nombre] = estMatch ? estMatch[1] : 'S01';
        }
      }
      
      // Verificar si todos los sets requeridos están REVISADO CONFORME
      const setsRequeridos = [
        'SET BASICO',
        'SET GUIA DE DESPACHO',
        'SET FACTURA EXENTA',
        'SET CASO GENERAL FACTURA COMPRA'
      ];
      
      const todosConformes = setsRequeridos.every(setName => {
        const estado = Object.entries(estadoSets).find(([k]) => k.includes(setName))?.[1];
        return estado && estado.includes('REVISADO CONFORME');
      });

      // Verificar si todos los libros requeridos están REVISADO CONFORME
      const librosRequeridos = [
        'LIBRO DE VENTAS',
        'LIBRO DE COMPRAS',
        'LIBRO DE GUIAS'
      ];

      const librosConformes = librosRequeridos.every(libroName => {
        const estado = Object.entries(estadoSets).find(([k]) => k.includes(libroName))?.[1];
        return estado && estado.includes('REVISADO CONFORME');
      });

      const todosConformesTotales = todosConformes && librosConformes;

      return {
        success: true,
        estadoSets,
        todosConformes,
        librosConformes,
        todosConformesTotales,
        rawHtml: html,
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        todosConformes: false,
        librosConformes: false,
        todosConformesTotales: false,
      };
    }
  }

  /**
   * Declara avance en una etapa de certificación con TrackIds específicos
   * @param {Object} options - Opciones
   * @param {Object} options.sets - Sets a declarar con sus TrackIds
   * @param {Object} options.sets.setBasico - { trackId, fecha } para Set Básico
   * @param {Object} options.sets.setGuiaDespacho - { trackId, fecha } para Set Guía Despacho
   * @param {Object} options.sets.setFacturaExenta - { trackId, fecha } para Set Factura Exenta
   * @param {Object} options.sets.libroVentas - { trackId, fecha } para Libro Ventas
   * @param {Object} options.sets.libroCompras - { trackId, fecha } para Libro Compras
   * @param {Object} options.sets.libroGuias - { trackId, fecha } para Libro Guías
   * @param {Object} options.sets.setExportacion1 - { trackId, fecha } para Set Exportación 1
   * @param {Object} options.sets.setExportacion2 - { trackId, fecha } para Set Exportación 2
   * @param {Object} options.sets.setFacturaCompra - { trackId, fecha } para Set Factura Compra
  * @param {Object} options.sets.setLiquidacion - { trackId, fecha } para Set Liquidación
  * @param {Object} options.sets.setSimulacion - { trackId, fecha } para Set de Simulación
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararAvance(options = {}) {
    const { sets = {} } = options;
    
    try {
      // 1. Acceder a la página de declarar avance
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance1');
      response = await this._handleRepresentacionPage(response);
      
      // 2. Enviar formulario con RUT empresa para ir al formulario de sets
      const formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance2',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance1'
      );

      const formHtml = formResponse.body || '';
      
      // 3. Si no hay sets para declarar, solo retornar el estado actual
      if (!Object.keys(sets).length) {
        return {
          success: true,
          rawHtml: formHtml,
          message: 'Página de declaración de avance obtenida',
        };
      }

      // 4. Parsear los campos ocultos del formulario (SET1, EST1, etc.)
      const hiddenFields = {};
      const currentValues = {}; // Para preservar valores existentes de NUM_ENV y FEC_ENV
      
      // Regex más flexible para encontrar inputs hidden en cualquier orden de atributos
      const inputRegex = /<input[^>]+>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
        const tag = inputMatch[0];
        const nameMatch = tag.match(/name\s*=\s*["']([^"']+)["']/i);
        const valueMatch = tag.match(/value\s*=\s*["']([^"']*)["']/i);
        
        if (nameMatch) {
          const fieldName = nameMatch[1];
          const fieldValue = valueMatch ? valueMatch[1] : '';
          
          // Verificar si es hidden
          if (/type\s*=\s*["']?HIDDEN["']?/i.test(tag)) {
            hiddenFields[fieldName] = fieldValue;
          }
          // También capturar campos text que pueden tener valores (NUM_ENV, FEC_ENV)
          else if (/type\s*=\s*["']?text["']?/i.test(tag) && fieldValue) {
            currentValues[fieldName] = fieldValue;
          }
        }
      }
      
      if (process.env.DEBUG_SII) {
        console.log('   [DEBUG] Campos hidden encontrados:', Object.keys(hiddenFields).join(', '));
      }

      // Si no hay formulario para declarar (página de estado/reparos)
      const hasFormFields = Object.keys(hiddenFields).length > 0;
      if (!hasFormFields && Object.keys(sets).length > 0) {
        // Extraer estado visible en la página
        const estadoSets = [];
        const rowRegex = /<tr[^>]*>\s*<td[^>]*>\s*<font[^>]*>([^<]+)<\/font>\s*<\/td>\s*<td[^>]*>\s*<font[^>]*><b>([^<]+)<\/b><\/font>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(formHtml)) !== null) {
          const nombre = rowMatch[1].trim();
          const estado = rowMatch[2].trim();
          if (nombre && estado) estadoSets.push({ nombre, estado });
        }

        const reparos = estadoSets.some((s) => /REPAROS|ERRORES/i.test(s.estado));
        return {
          success: false,
          error: reparos
            ? 'ENVIO CON ERRORES O REPAROS'
            : 'No hay formulario para declarar avance (página de estado)',
          rawHtml: formHtml,
          estadoSets,
        };
      }

      // Parsear el HTML para encontrar el mapeo dinámico de índices
      // El SII cambia el orden según qué sets están aprobados
      const fieldMapping = {};
      
      // Guardar pe_avance2 para debug (siempre)
      {
        const fs = require('fs');
        const path = require('path');
        const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug/cert-v2');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance2_form.html');
        fs.writeFileSync(debugPath, formHtml, 'utf8');
        console.log('   📄 HTML pe_avance2 formulario guardado en debug/cert-v2/pe_avance2_form.html');
      }
      
      // Extraer todas las filas <tr>...</tr> del formulario
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const rows = [];
      let rowMatch;
      while ((rowMatch = rowRegex.exec(formHtml)) !== null) {
        rows.push(rowMatch[1]); // Contenido interno de cada <tr>
      }
      
      // Buscar en cada fila individualmente
      const patterns = [
        { name: 'setSimulacion', label: /SET DE SIMULACION/i },
        { name: 'libroVentas', label: /LIBRO DE VENTAS/i },
        { name: 'libroCompras', label: /LIBRO DE COMPRAS(?!\s+PARA EXENTOS)/i },
        { name: 'libroComprasExentos', label: /LIBRO DE COMPRAS PARA EXENTOS/i },
        { name: 'libroGuias', label: /LIBRO DE GUIAS/i },
        { name: 'setBasico', label: /SET BASICO/i },
        { name: 'setGuiaDespacho', label: /SET GUIA DE DESPACHO/i },
        { name: 'setFacturaExenta', label: /SET FACTURA EXENTA/i },
        { name: 'setExportacion1', label: /SET DOCUMENTOS DE EXPORTACION(?!\(2\))/i },
        { name: 'setExportacion2', label: /SET DOCUMENTOS DE EXPORTACION\(2\)/i },
        { name: 'setFacturaCompra', label: /SET CASO GENERAL FACTURA COMPRA/i },
        { name: 'setLiquidacion', label: /SET LIQUIDACION FACTURA/i },
      ];
      
      for (const pattern of patterns) {
        for (const rowContent of rows) {
          // Verificar si esta fila contiene el label
          if (pattern.label.test(rowContent)) {
            // Buscar NUM_ENV en esta fila específica
            const numEnvMatch = rowContent.match(/NAME="NUM_ENV(\d+)"/i);
            if (numEnvMatch) {
              // Solo agregar si tiene NUM_ENV (no si tiene REVISADO CONFORME o EN REVISION)
              fieldMapping[pattern.name] = parseInt(numEnvMatch[1]);
              if (process.env.DEBUG_SII) {
                console.log(`   [DEBUG] ${pattern.name} → NUM_ENV${numEnvMatch[1]}`);
              }
            }
            break; // Ya encontramos la fila para este pattern
          }
        }
      }
      
      if (process.env.DEBUG_SII) {
        console.log('   [DEBUG] Mapeo dinámico de índices:', fieldMapping);
      }

      if (sets.setSimulacion && !fieldMapping.setSimulacion) {
        return {
          success: false,
          error: 'SET DE SIMULACION no está disponible en pe_avance2. La empresa no está en la etapa SIMULACION.',
          rawHtml: formHtml,
        };
      }

      // Formato de fecha: dd-mm-aaaa
      const formatDate = (dateStr) => {
        if (!dateStr) return '';
        if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) return dateStr;
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
      };

      // Construir formData con todos los campos EN EL ORDEN CORRECTO del formulario HTML
      // El orden es: NUM_ENV1, FEC_ENV1, SET1, EST1, NUM_ENV2, FEC_ENV2, SET2, EST2, etc.
      // Luego: RUT_EMP, DV_EMP, TOTREG, ACEPTAR
      
      // Primero, preparar los valores de NUM_ENV/FEC_ENV que vamos a enviar
      const numEnvValues = {};
      const fecEnvValues = {};
      
      // Agregar/sobrescribir los TrackIds de los sets proporcionados
      for (const [setName, index] of Object.entries(fieldMapping)) {
        if (sets[setName]) {
          const { trackId, fecha } = sets[setName];
          if (trackId) {
            // SII espera el TrackID sin ceros iniciales (ej: 245711048, no 0245711048)
            const cleanTrackId = String(parseInt(String(trackId), 10));
            numEnvValues[index] = cleanTrackId;
            fecEnvValues[index] = formatDate(fecha);
            if (String(trackId) !== cleanTrackId) {
              console.log(`   [TrackID] Normalizado: ${trackId} → ${cleanTrackId}`);
            }
          }
        }
      }
      
      // Construir formData en orden - TODOS los campos deben enviarse
      const formData = {};
      
      // Agregar campos en el orden del formulario HTML: NUM_ENV, FEC_ENV, SET, EST para cada índice
      const maxIndex = parseInt(hiddenFields.TOTREG) || 10;
      for (let i = 1; i <= maxIndex; i++) {
        // NUM_ENV - siempre enviar (vacío si no hay valor)
        formData[`NUM_ENV${i}`] = numEnvValues[i] || currentValues[`NUM_ENV${i}`] || '';
        
        // FEC_ENV - siempre enviar (vacío si no hay valor)
        formData[`FEC_ENV${i}`] = fecEnvValues[i] || currentValues[`FEC_ENV${i}`] || '';
        
        // SET y EST (hidden) - siempre enviar
        formData[`SET${i}`] = hiddenFields[`SET${i}`] || '';
        formData[`EST${i}`] = hiddenFields[`EST${i}`] || '';
      }
      
      // Campos finales
      formData['RUT_EMP'] = this.rutEmpresa;
      formData['DV_EMP'] = this.dvEmpresa;
      formData['TOTREG'] = hiddenFields.TOTREG || '10';
      formData['ACEPTAR'] = 'Confirmar Revisión';

      // Debug: mostrar datos del formulario
      if (process.env.DEBUG_SII) {
        console.log('   [DEBUG] Datos del formulario a enviar:');
        for (const [k, v] of Object.entries(formData)) {
          console.log(`      ${k}: ${v || '(vacío)'}`);
        }
        
        // Mostrar el body codificado
        const SiiSession = require('./SiiSession');
        const encodedBody = SiiSession.formEncode(formData);
        console.log('   [DEBUG] Body codificado (primeros 500 chars):');
        console.log(`      ${encodedBody.substring(0, 500)}`);
      }

      // 5. Enviar formulario de declaración
      let declareResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance3',
        formData,
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance2'
      );

      // 6. Seguir redirecciones si las hay
      if ([301, 302, 303, 307, 308].includes(declareResponse.status)) {
        const redirectResult = await this.session.followRedirects(declareResponse);
        declareResponse = redirectResult.response;
      }

      const body = declareResponse.body || '';
      
      // Debug - guardar respuesta
      if (process.env.DEBUG_SII) {
        console.log(`   [DEBUG] Respuesta: ${body.length} bytes, status: ${declareResponse.status}`);
        // Guardar respuesta de pe_avance3 para debug
        const fs = require('fs');
        const path = require('path');
        const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance3_response.html');
        fs.writeFileSync(debugPath, body);
        console.log(`   [DEBUG] Respuesta guardada en: ${debugPath}`);
      }
      
      const bodyLower = body.toLowerCase();
      
      // "ERRORES O REPAROS" es un ESTADO del envío, NO un error de la declaración.
      // La declaración (submit del form) fue exitosa; el estado del envío se resuelve
      // después vía polling (EN REVISION → REVISADO CONFORME).
      // Reemplazar para no confundir la detección de errores reales.
      const bodyForErrorCheck = bodyLower.replace(/errores o reparos/g, 'reparos_estado');
      
      const hasError = bodyForErrorCheck.includes('error') && !body.includes('Error de Sesión');
      const hasSuccess = body.includes('exitosamente') || body.includes('Avance declarado') || body.includes('actualizado');
      const contenidoNoCorresponde = bodyLower.includes('contenido no corresponde');
      const sesionExpirada = bodyLower.includes('no se encuentra autenticado') || bodyLower.includes('error de sesi');

      let errorMsg = '';
      if (sesionExpirada) {
        errorMsg = 'Sesión SII no autenticada al declarar avance';
      } else if (contenidoNoCorresponde) {
        errorMsg = 'Contenido no corresponde a lo esperado';
      } else if (!body) {
        errorMsg = 'Respuesta vacía al declarar avance';
      } else if (hasError && !hasSuccess) {
        errorMsg = 'Respuesta inválida al declarar avance';
      }

      // Éxito si el form se envió sin errores de sesión/contenido.
      // El estado del envío (ERRORES O REPAROS / EN REVISION / REVISADO CONFORME)
      // NO determina el éxito de la declaración — eso se resuelve vía polling.
      const postOk = (!hasError || hasSuccess) && !sesionExpirada && !contenidoNoCorresponde;

      if (!postOk) {
        return {
          success: false,
          error: errorMsg || undefined,
          status: declareResponse.status,
          rawHtml: body,
          formHtml,
          setsDeclarados: Object.keys(sets),
          formDataSent: formData,
        };
      }

      // Guardar HTML de pe_avance3 (respuesta de declaración) siempre para debug
      {
        const fs = require('fs');
        const path = require('path');
        const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug/cert-v2');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, 'pe_avance3_response.html'), body, 'utf8');
        console.log('   📄 HTML pe_avance3 guardado en debug/cert-v2/pe_avance3_response.html');
      }

      // 7. VERIFICACIÓN POST-DECLARACIÓN: Re-leer pe_avance2 y confirmar que los TrackIDs se guardaron
      // Si aparece "EN REVISION" → la declaración fue aceptada y el SII está procesando
      // Si reaparecen inputs vacíos → la declaración no se guardó
      let verificado = true;
      let verificacionError = '';
      let enRevision = false;
      try {
        const verifyResponse = await this.session.submitForm(
          '/cvc_cgi/dte/pe_avance2',
          { RUT_EMP: this.rutEmpresa, DV_EMP: this.dvEmpresa, ACEPTAR: 'Continuar' },
          'https://maullin.sii.cl/cvc_cgi/dte/pe_avance1'
        );
        const verifyHtml = verifyResponse.body || '';

        // Guardar HTML de verificación pe_avance2 siempre
        {
          const fs = require('fs');
          const path = require('path');
          const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug/cert-v2');
          if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(path.join(debugDir, 'pe_avance2_verify.html'), verifyHtml, 'utf8');
          console.log('   📄 HTML pe_avance2 verificación guardado en debug/cert-v2/pe_avance2_verify.html');
        }

        // Para cada set que declaramos, verificar estado
        const verifyRows = verifyHtml.split(/<\/tr>/i);
        const camposVacios = [];
        const camposEnRevision = [];
        for (const [setName, index] of Object.entries(fieldMapping)) {
          if (!sets[setName]) continue;
          for (const row of verifyRows) {
            const numEnvMatch = row.match(new RegExp(`NAME="NUM_ENV${index}"`, 'i'));
            if (!numEnvMatch) {
              // Si no hay input NUM_ENV, verificar si aparece REVISADO CONFORME o EN REVISION
              const labelPattern = patterns.find(p => p.name === setName);
              if (labelPattern && labelPattern.label.test(row)) {
                if (/<b>[^<]*REVISADO CONFORME[^<]*<\/b>/i.test(row)) break;
                if (/EN REVISION/i.test(row)) {
                  camposEnRevision.push(setName);
                  break;
                }
              }
              continue;
            }
            // Tiene input — verificar si tiene valor o está REVISADO CONFORME
            const tieneConforme = /<b>[^<]*REVISADO CONFORME[^<]*<\/b>/i.test(row);
            if (tieneConforme) break;
            if (/EN REVISION/i.test(row)) {
              camposEnRevision.push(setName);
              break;
            }
            const valueMatch = row.match(new RegExp(`NAME="NUM_ENV${index}"[^>]*value="([^"]*)"`, 'i'));
            const tieneValor = valueMatch && valueMatch[1] && valueMatch[1].trim() !== '';
            if (!tieneValor) {
              camposVacios.push(setName);
            }
            break;
          }
        }

        if (camposEnRevision.length > 0) {
          enRevision = true;
          console.log(`   🔄 EN REVISION: ${camposEnRevision.join(', ')} — declaración aceptada, SII procesando`);
        }

        if (camposVacios.length > 0 && !enRevision) {
          verificado = false;
          verificacionError = `Declaración NO se guardó en el portal SII. Campos vacíos para: ${camposVacios.join(', ')}. Posible error de sesión o TrackID no reconocido.`;
          console.log(`   ⚠️ ${verificacionError}`);
        }
      } catch (verifyErr) {
        console.log(`   ⚠️ No se pudo verificar la declaración: ${verifyErr.message}`);
      }

      return {
        success: verificado || enRevision,
        error: verificacionError || errorMsg || undefined,
        verificado,
        enRevision,
        status: declareResponse.status,
        rawHtml: body,
        formHtml,
        setsDeclarados: Object.keys(sets),
        formDataSent: formData,
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Avanza al siguiente paso cuando todos los ítems están REVISADO CONFORME
   * @returns {Promise<Object>} Resultado del avance
   */
  async avanzarSiguientePaso() {
    try {
      // 1. Acceder a la página de declarar avance
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance1');
      response = await this._handleRepresentacionPage(response);

      // 2. Enviar formulario con RUT empresa para ir al formulario de sets
      const formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance2',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance1'
      );

      const formHtml = formResponse.body || '';

      // 3. Enviar formulario de avance final
      // El botón "Avanzar Siguiente Paso" cambia la acción a /pe_avance4
      const formData = {
        RUT_EMP: this.rutEmpresa,
        DV_EMP: this.dvEmpresa,
        TOTREG: '0',
        PASO: 'P01',
        ACEPTAR: 'Avanzar Siguiente Paso',
      };

      if (process.env.DEBUG_SII) {
        const fs = require('fs');
        const path = require('path');
        const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance2_avanzar.html');
        fs.writeFileSync(debugPath, formHtml, 'utf8');
        console.log('   [DEBUG] HTML avanzar guardado en:', debugPath);
      }

      let avanceResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance4',
        formData,
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance2'
      );

      // 4. Seguir redirecciones si las hay
      if ([301, 302, 303, 307, 308].includes(avanceResponse.status)) {
        const redirectResult = await this.session.followRedirects(avanceResponse);
        avanceResponse = redirectResult.response;
      }

      const body = avanceResponse.body || '';

      if (process.env.DEBUG_SII) {
        const fs = require('fs');
        const path = require('path');
        const debugDir = process.env.SII_DEBUG_DIR || path.join(__dirname, '../../debug');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance3_avanzar_response.html');
        fs.writeFileSync(debugPath, body);
        console.log('   [DEBUG] Respuesta avanzar guardada en:', debugPath);
      }

      const hasError = body.toLowerCase().includes('error') && !body.includes('Error de Sesión');
      const hasSuccess = body.includes('exitosamente') || body.includes('Avance declarado') || body.includes('actualizado');

      return {
        success: !hasError || hasSuccess,
        rawHtml: body,
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Consulta el estado de avance de la certificación
   * @returns {Promise<Object>} Estado de avance
   */
  async verAvance() {
    try {
      // 0. Visitar pe_avance1 y enviar formulario a pe_avance2 para "activar" la actualización
      // El SII parece requerir este flujo para refrescar el estado internamente
      let activateResponse = await this.session.ensureSession('/cvc_cgi/dte/pe_avance1');
      activateResponse = await this._handleRepresentacionPage(activateResponse);
      
      // Enviar formulario a pe_avance2 con RUT (esto es lo que hace el portal web)
      await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance2',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance1'
      );
      
      // 1. Acceder a la página de ver avance
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance5');
      response = await this._handleRepresentacionPage(response);

      // 2. Enviar formulario con RUT empresa
      const formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance6',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance5'
      );

      // 3. Parsear el estado de avance
      const body = formResponse.body || '';
      const avance = this._parseEstadoAvance(body);

      return {
        success: true,
        avance,
        rawHtml: body,
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Parsea el HTML de estado de avance para extraer información estructurada
   * @private
   */
  _parseEstadoAvance(html) {
    const estado = {
      etapas: [],
      porcentajeTotal: null,
      fechaInicio: null,
      fechaUltimoAvance: null,
    };

    // Buscar tabla de etapas
    const filaRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const celdaRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    
    let filaMatch;
    while ((filaMatch = filaRegex.exec(html)) !== null) {
      const fila = filaMatch[1];
      const celdas = [];
      let celdaMatch;
      while ((celdaMatch = celdaRegex.exec(fila)) !== null) {
        // Limpiar HTML de la celda
        const texto = celdaMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim();
        celdas.push(texto);
      }
      
      if (celdas.length >= 2) {
        estado.etapas.push({
          nombre: celdas[0],
          estado: celdas[1],
          fecha: celdas[2] || null,
        });
      }
    }

    return estado;
  }

  /**
   * Declara cumplimiento de requisitos (etapa final)
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararCumplimiento() {
    try {
      // 1. Acceder a la página de declarar cumplimiento
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance7');
      response = await this._handleRepresentacionPage(response);

      // 2. Enviar formulario
      const formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance8',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance7'
      );

      const body = formResponse.body || '';
      const hasError = body.includes('Error') || body.includes('error');

      return {
        success: !hasError,
        rawHtml: body,
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Flujo completo de certificación automática
   * @param {Object} options - Opciones del flujo
   * @param {Function} options.onProgress - Callback para reportar progreso
   * @returns {Promise<Object>} Resultado del flujo completo
   */
  async flujoCompleto(options = {}) {
    const onProgress = options.onProgress || (() => {});
    const resultados = {
      success: true,
      pasos: [],
    };

    const pasos = [
      { nombre: 'Verificar estado actual', fn: () => this.verAvance() },
      { nombre: 'Generar set básico', fn: () => this.generarSetPruebas({ tipoSet: 'SET_BASICO' }) },
      // Los demás pasos dependen del resultado de verAvance
    ];

    for (const paso of pasos) {
      onProgress({ paso: paso.nombre, estado: 'iniciando' });
      
      try {
        const resultado = await paso.fn();
        resultados.pasos.push({
          nombre: paso.nombre,
          success: resultado.success,
          detalle: resultado,
        });
        
        onProgress({ paso: paso.nombre, estado: resultado.success ? 'completado' : 'error' });
        
        if (!resultado.success) {
          resultados.success = false;
          break;
        }
      } catch (error) {
        resultados.pasos.push({
          nombre: paso.nombre,
          success: false,
          error: error.message,
        });
        resultados.success = false;
        onProgress({ paso: paso.nombre, estado: 'error', error: error.message });
        break;
      }
    }

    return resultados;
  }

  // ═══════════════════════════════════════════════════════════════
  // Métodos de estado de certificación (parsing y polling)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Patrones para extraer estados del HTML de avance
   * @private
   */
  static get ESTADO_PATTERNS() {
    return {
      setBasico: { nombre: 'SET BASICO', regex: /SET BASICO[\s\S]*?<b>([^<]+)<\/b>/i },
      setGuiaDespacho: { nombre: 'SET GUIA DESPACHO', regex: /SET GUIA[\s\S]*?DESP[\s\S]*?<b>([^<]+)<\/b>/i },
      setFacturaExenta: { nombre: 'SET FACTURA EXENTA', regex: /SET FACTURA EXENTA[\s\S]*?<b>([^<]+)<\/b>/i },
      setFacturaCompra: { nombre: 'SET FACTURA COMPRA', regex: /SET CASO GENERAL FACTURA COMPRA[\s\S]*?<b>([^<]+)<\/b>/i },
      setSimulacion: { nombre: 'SET SIMULACION', regex: /SET(?:\s+DE)?\s+SIMULACION[\s\S]*?<b>([^<]+)<\/b>/i },
      libroVentas: { nombre: 'LIBRO VENTAS', regex: /LIBRO[\s\S]*?VENTA[\s\S]*?<b>([^<]+)<\/b>/i },
      libroCompras: { nombre: 'LIBRO COMPRAS', regex: /LIBRO DE COMPRAS(?!\s+PARA EXENTOS)[\s\S]*?<b>([^<]+)<\/b>/i },
      libroComprasExentos: { nombre: 'LIBRO COMPRAS EXENTOS', regex: /LIBRO DE COMPRAS PARA EXENTOS[\s\S]*?<b>([^<]+)<\/b>/i },
      libroGuias: { nombre: 'LIBRO GUIAS', regex: /LIBRO[\s\S]*?GUIA[\s\S]*?<b>([^<]+)<\/b>/i },
    };
  }

  /**
   * Consulta y parsea el estado de avance
   * @returns {Promise<Object>} { success, etapaActual, estados: { setBasico: 'REVISADO CONFORME', ... }, rawHtml }
   */
  async verAvanceParsed() {
    const result = await this.verAvance();
    if (!result.success) return result;

    // Detectar etapa actual del proceso (múltiples formatos)
    let etapaActual = null;
    const etapaPatterns = [
      /paso\s*<b>\s*([^<]+)<\/b>/i,
      /etapa[:\s]+<b>([^<]+)<\/b>/i,
      /etapa\s*<b>\s*([^<]+)<\/b>/i,
      /ETAPA\s+DE\s+([A-ZÁÉÍÓÚÑ\s]+)/i,
    ];
    for (const pattern of etapaPatterns) {
      const match = result.rawHtml?.match(pattern);
      if (match) {
        etapaActual = match[1].trim().toUpperCase();
        break;
      }
    }

    // Detectar si está esperando "Confirmar Revisión" de simulación
    // El formulario pe_avance3 con "SET DE SIMULACION" indica que simulación está aprobada
    let simulacionAprobadaIndicador = result.rawHtml?.includes('pe_avance3') && 
                                       result.rawHtml?.includes('SET DE SIMULACION') &&
                                       result.rawHtml?.includes('Confirmar Revisi');

    // Si la etapa es SIMULACION, también verificar en pe_avance2 si hay formulario de confirmación
    if (etapaActual === 'SIMULACION' && !simulacionAprobadaIndicador) {
      try {
        const estadoSets = await this.consultarEstadoSets();
        if (estadoSets.success && estadoSets.rawHtml) {
          const html = estadoSets.rawHtml;
          // Buscar el formulario de confirmación de simulación en pe_avance2
          if (html.includes('pe_avance3') && 
              html.includes('SET DE SIMULACION') &&
              html.includes('Confirmar Revisi')) {
            simulacionAprobadaIndicador = true;
          }
        }
      } catch (e) {
        // Ignorar error, continuar con la detección normal
      }
    }

    const estados = {};
    for (const [key, { nombre, regex }] of Object.entries(SiiCertificacion.ESTADO_PATTERNS)) {
      const match = result.rawHtml?.match(regex);
      if (match) {
        const estadoTexto = match[1].trim();
        const upper = estadoTexto.toUpperCase();
        estados[key] = {
          nombre,
          estado: estadoTexto,
          esConforme:  upper.includes('REVISADO CONFORME'),
          enRevision:  upper.includes('EN REVISION'),
          esRechazado: upper.includes('RECHAZADO') || upper.includes('ERRORES'),
          esReparos:   upper.includes('REPAROS'),
          porRealizar: upper.includes('POR REALIZAR'),
          esAnulado:   upper.includes('ANULADO'),
        };
      }
    }

    // Si detectamos el formulario de confirmación de simulación pero no hay estado,
    // solo indica que hay una declaración pendiente por confirmar (no aprobada aún).
    if (simulacionAprobadaIndicador && !estados.setSimulacion) {
      estados.setSimulacion = {
        nombre: 'SET SIMULACION',
        estado: 'PENDIENTE CONFIRMAR',
        esConforme:  false,
        enRevision:  true,
        esRechazado: false,
        esReparos:   false,
        porRealizar: false,
        esAnulado:   false,
        pendienteConfirmar: true,
      };
    }

    return {
      success: true,
      etapaActual,
      estados,
      simulacionAprobadaIndicador,
      rawHtml: result.rawHtml,
    };
  }

  /**
   * Espera hasta que los sets especificados sean aprobados
   * @param {string[]} setsAEsperar - Array de keys: ['setBasico', 'setGuiaDespacho', ...]
   * @param {Object} options - Opciones de polling
   * @param {number} options.maxIntentos - Máximo de intentos (default: 30)
   * @param {number} options.intervalo - Intervalo entre intentos en ms (default: 10000)
   * @param {Function} options.onProgress - Callback de progreso (opcional)
   * @returns {Promise<Object>} { success, estados, timedOut }
   */
  async waitForApproval(setsAEsperar = [], options = {}) {
    const { maxIntentos = 30, intervalo = 10000, onProgress } = options;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let intento = 1; intento <= maxIntentos; intento++) {
      await sleep(intervalo);

      if (onProgress) {
        onProgress({ intento, maxIntentos, estado: 'polling' });
      }

      const result = await this.verAvanceParsed();
      if (!result.success) continue;

      // Filtrar solo los sets que nos interesan
      const estadosRelevantes = setsAEsperar.length > 0
        ? Object.fromEntries(
            Object.entries(result.estados).filter(([key]) => setsAEsperar.includes(key))
          )
        : result.estados;

      const todosConformes = Object.values(estadosRelevantes).every(e => e.esConforme);
      const algunoRechazado = Object.values(estadosRelevantes).some(e => e.esRechazado);

      if (onProgress) {
        onProgress({ intento, maxIntentos, estado: 'resultado', estados: estadosRelevantes });
      }

      if (todosConformes) {
        return { success: true, estados: estadosRelevantes };
      }

      if (algunoRechazado) {
        return { success: false, error: 'Sets rechazados', estados: estadosRelevantes };
      }
    }

    return { success: false, timedOut: true };
  }
}

// Exportar constantes junto con la clase
SiiCertificacion.ETAPAS = ETAPAS_CERTIFICACION;
SiiCertificacion.TIPOS_DTE = TIPOS_DTE;

module.exports = SiiCertificacion;
