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
const { STEPS, emitProgress } = require('./utils/progress');
const { resolveArtifactDir } = require('./utils/paths');

/** Decodifica entidades HTML latinas (el portal SII las usa en vez de UTF-8 crudo) y limpia
 * tags/whitespace, para poder aplicar regex de texto sobre las respuestas de forma confiable. */
function limpiarTextoPortal(html) {
  const decodificar = (s) => s
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  return decodificar(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Etapas de certificacion DTE
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

    // Un solo lugar donde se decide dónde escribir. Antes había 7 call sites que
    // recalculaban la ruta a mano, y no coincidían entre sí: cuatro usaban
    // `../../debug/cert-v2` y tres `../../debug`, así que archivos de la misma
    // operación quedaban repartidos en dos carpetas distintas.
    this.debugDir = resolveArtifactDir(options.debugDir, options.debugDir ? '' : 'cert-v2');

    this.session = new SiiSession({
      pfxPath: options.pfxPath,
      pfxPassword: options.pfxPassword,
      ambiente: 'certificacion',
      debugDir: this.debugDir,
    });

    // Reutilización de sesión: cargar desde archivo y guardar automáticamente tras cada login
    if (options.sessionPath) {
      this._sessionPath = options.sessionPath;
      this.session.loadSession(options.sessionPath);
      const _origEnsure = this.session.ensureSession.bind(this.session);
      const _sess = this.session;
      const _sp = options.sessionPath;
      this.session.ensureSession = async function(targetPath) {
        const result = await _origEnsure(targetPath);
        // Best-effort: este hook corre en CADA establecimiento de sesión, así que
        // una falla al escribir el cache (disco lleno, permisos, volumen no montado)
        // tumbaría toda operación contra el SII. Persistir la sesión es una
        // optimización; la operación en curso ya tiene la sesión viva en memoria.
        try {
          _sess.saveSession(_sp);
        } catch (e) {
          console.warn(`[SiiCertificacion] No se pudo guardar la sesión en ${_sp}: ${e.message}`);
        }
        return result;
      };
    }
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
   * Consulta los libros IECV ya enviados al SII para un año dado.
   * Usa el portal QEstLibro (DTEauth?7) para determinar si cada período tiene
   * un envío MENSUAL (TOTAL/LTC) o RECTIFICA (AJUSTE) por tipo de operación.
   *
   * @param {number|string} year - Año (ej: 2026)
   * @returns {Promise<Object>} Mapa con estructura:
   *   { '2026-04': { COMPRA: { periodicidad: 'MENSUAL', estado: 'Recibido', codigo: 'COMPRA-...' }, VENTA: {...} } }
   */
  async consultarLibrosExistentes(year) {
    const year4 = String(year || new Date().getFullYear());

    await this.session.ensureSession('/cgi_dte/UPL/DTEauth?7');

    const url = `https://maullin.sii.cl/cgi_dte/UPL/QEstLibro` +
      `?rutCompany=${this.rutEmpresa}&dvCompany=${this.dvEmpresa}` +
      `&TrackId=&year=${year4}&month=00&tipo=TODOS`;

    const resp = await this.session.request(url);
    const html = resp.body || '';

    if (html.includes('NO ESTA AUTORIZADO') || html.includes('SESION HA EXPIRADO')) {
      throw new Error('QEstLibro: sesión no autorizada o expirada');
    }

    // Cada fila tiene 6 <td>: periodo, operacion, estado, tipoLibro, periodicidad, cantidad+link
    // Capturamos los 5 primeros <td> de texto plano + el Codigo de la URL del link
    const result = {};
    const rowRegex =
      /<tr><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>[^<]*<a href=QDetEstLibro\?Codigo=([^&"'\s>]+)/gi;

    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const periodo      = m[1].trim();
      const tipo         = m[2].trim().toUpperCase();        // COMPRA | VENTA
      const estado       = m[3].trim();                      // Recibido | ...
      const periodicidad = m[5].trim().toUpperCase();        // MENSUAL | RECTIFICA
      const codigo       = m[6].trim();

      if (!/^\d{4}-\d{2}$/.test(periodo)) continue;
      if (!result[periodo]) result[periodo] = {};
      result[periodo][tipo] = { periodicidad, estado, codigo };
    }

    return result;
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
        console.log(' [DEBUG] Campos hidden encontrados:', Object.keys(hiddenFields).join(', '));
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
        const debugDir = this.debugDir;
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance2_form.html');
        fs.writeFileSync(debugPath, formHtml, 'utf8');

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
                console.log(` [DEBUG] ${pattern.name} → NUM_ENV${numEnvMatch[1]}`);
              }
            }
            break; // Ya encontramos la fila para este pattern
          }
        }
      }
      
      if (process.env.DEBUG_SII) {
        console.log(' [DEBUG] Mapeo dinámico de índices:', fieldMapping);
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
        console.log(' [DEBUG] Datos del formulario a enviar:');
        for (const [k, v] of Object.entries(formData)) {
          console.log(` ${k}: ${v || '(vacío)'}`);
        }
        
        // Mostrar el body codificado
        const SiiSession = require('./SiiSession');
        const encodedBody = SiiSession.formEncode(formData);
        console.log(' [DEBUG] Body codificado (primeros 500 chars):');
        console.log(` ${encodedBody.substring(0, 500)}`);
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
        console.log(` [DEBUG] Respuesta: ${body.length} bytes, status: ${declareResponse.status}`);
        // Guardar respuesta de pe_avance3 para debug
        const fs = require('fs');
        const path = require('path');
        const debugDir = this.debugDir;
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance3_response.html');
        fs.writeFileSync(debugPath, body);
        console.log(` [DEBUG] Respuesta guardada en: ${debugPath}`);
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

      // ── Datos inconsistentes: error DEFINITIVO, no "todavía no" ────────────
      //
      // El SII contesta 200 con una página normal que dice, entre los antecedentes del
      // set, "FECHA NO CORRESPONDE AL ENVIO". No es un error de sesión ni de contenido,
      // así que caía en el camino de éxito: la verificación posterior encontraba los
      // campos vacíos, el bucle reintentaba 10 veces y después el polling seguía hasta
      // agotar el timeout de la etapa. Minutos quemados esperando algo imposible, y sin
      // que el mensaje real del SII llegara nunca al usuario.
      //
      // Esta ruta la comparten declarar avance, libros y simulación, así que detectarlo
      // acá los cubre a los tres.
      //
      // La causa habitual es la zona horaria: los runners arman las fechas con
      // `new Date().getDate()`, que usa la TZ del proceso. Corriendo en UTC, entre las
      // 20:00 y las 00:00 de Chile ya es el día siguiente y se declara con la fecha de
      // mañana. Por eso `TZ=America/Santiago` es obligatorio (ver CLAUDE.md).
      const _inconsistencia = body.replace(/<[^>]*>/g, ' ')
        .match(/((?:FECHA|RUT|FOLIO|NUMERO|N[UÚ]MERO)[^.<]{0,40}?NO\s+(?:CORRESPONDE|COINCIDE)[^.<]{0,40})/i);
      if (_inconsistencia) {
        const _detalle = _inconsistencia[1].replace(/\s+/g, ' ').trim();
        return {
          success: false,
          datoInconsistente: true,
          error: `El SII rechazó la declaración: ${_detalle}. Los datos declarados no coinciden con lo que el SII tiene registrado del envío; corrígelos y vuelve a declarar (esperar no lo resuelve).`,
          status: declareResponse.status,
          rawHtml: body,
          formHtml,
          setsDeclarados: Object.keys(sets),
          formDataSent: formData,
        };
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
        const debugDir = this.debugDir;
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, 'pe_avance3_response.html'), body, 'utf8');

      }

      // 7. VERIFICACIÓN POST-DECLARACIÓN: Re-leer pe_avance2 y confirmar que los TrackIDs se guardaron
      // Si aparece "EN REVISION" → la declaración fue aceptada y el SII está procesando
      // Si reaparecen inputs vacíos → la declaración no se guardó
      let verificado = true;
      let verificacionError = '';
      let enRevision = false;
      let camposVacios = [];
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
          const debugDir = this.debugDir;
          if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(path.join(debugDir, 'pe_avance2_verify.html'), verifyHtml, 'utf8');

        }

        // Para cada set que declaramos, verificar estado
        const verifyRows = verifyHtml.split(/<\/tr>/i);
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
          console.log(` [...] EN REVISION: ${camposEnRevision.join(', ')} — declaración aceptada, SII procesando`);
        }

        if (camposVacios.length > 0 && !enRevision) {
          verificado = false;
          verificacionError = `Declaración NO se guardó en el portal SII. Campos vacíos para: ${camposVacios.join(', ')}. Posible error de sesión o TrackID no reconocido.`;
          console.log(` [!] ${verificacionError}`);
        }
      } catch (verifyErr) {
        console.log(` [!] No se pudo verificar la declaración: ${verifyErr.message}`);
      }

      // conErrores: el SII procesó el envío pero encontró errores en el contenido del XML.
      // Detectar en el body de la respuesta de pe_avance3 (no en la re-verificación de pe_avance2).
      const _erroresBody = body || '';
      const _nombresConError = [];
      const _patronesNombre = [
        'LIBRO DE VENTAS', 'LIBRO DE COMPRAS PARA EXENTOS', 'LIBRO DE COMPRAS',
        'LIBRO DE GUIAS', 'SET BASICO', 'SET GUIA DE DESPACHO', 'SET FACTURA EXENTA',
        'SET CASO GENERAL FACTURA COMPRA', 'SET DE SIMULACION',
      ];
      for (const _nom of _patronesNombre) {
        // Buscar fila que contenga el nombre Y "ENVIO CON ERRORES O REPAROS".
        // Se usa un lookahead negativo para que "LIBRO DE COMPRAS" no haga match dentro de
        // "LIBRO DE COMPRAS PARA EXENTOS", evitando falsos positivos.
        const _nomEscapado = _nom.replace(/ /g, '\\s+');
        // Si el nombre es un prefijo de otro nombre más largo, agregar un límite tras él.
        const _otrosNombres = _patronesNombre.filter(n => n !== _nom && n.startsWith(_nom));
        let _patronNom = _nomEscapado;
        if (_otrosNombres.length > 0) {
          // Lookahead negativo: no debe seguir el texto diferenciador de los nombres más largos
          const _sufijos = _otrosNombres.map(n => n.slice(_nom.length).replace(/ /g, '\\s+').trim());
          _patronNom += `(?!\\s+(?:${_sufijos.join('|')}))`;
        }
        const _re = new RegExp(_patronNom + '[\\s\\S]{0,200}?ENVIO CON ERRORES O REPAROS', 'i');
        if (_re.test(_erroresBody)) _nombresConError.push(_nom);
      }
      const conErrores = _nombresConError.length > 0;
      if (conErrores) {
        console.log(` [ERR] SII rechazó por ERRORES DE CONTENIDO: ${_nombresConError.join(', ')}`);
      }

      // allRejected: SII rechazó todos los sets declarados — período incorrecto, no tiene sentido reintentar.
      // Solo aplica cuando NO hay errores de contenido explícitos (esos deben manejarse por separado).
      const _declaredCount = Object.keys(fieldMapping).filter(k => sets[k]).length;
      const allRejected = !enRevision && !conErrores && camposVacios.length > 0 && camposVacios.length >= _declaredCount && _declaredCount > 0;

      return {
        success: verificado || enRevision,
        error: conErrores
          ? `ENVIO CON ERRORES O REPAROS: ${_nombresConError.join(', ')}`
          : (verificacionError || errorMsg || undefined),
        verificado,
        enRevision,
        conErrores,
        nombresConError: _nombresConError,
        allRejected,
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

      // 3. Enviar formulario de avance final.
      // El botón "Avanzar Siguiente Paso" del portal es <input type="button" onclick="avanzar()">,
      // y avanzar() SOLO cambia el action del form a /pe_avance4 y lo submitea — no toca ningún
      // campo. TOTREG y PASO vienen en inputs hidden que YA trae el form de pe_avance2, y PASO
      // varía según la etapa actual (ej. "P01" para SET DE PRUEBAS, "P05" para DOCUMENTOS
      // IMPRESOS). Antes se hardcodeaba PASO:'P01' → solo funcionaba en la primera transición;
      // en cualquier otra etapa el SII lo ignoraba silenciosamente y respondía "la empresa ya
      // se encuentra en el paso X" (no avanzaba nada, pero tampoco reportaba error).
      const totregMatch = formHtml.match(/name="TOTREG"[^>]*value="([^"]*)"/i);
      const pasoMatch    = formHtml.match(/name="PASO"[^>]*value="([^"]*)"/i);
      const formData = {
        RUT_EMP: this.rutEmpresa,
        DV_EMP: this.dvEmpresa,
        TOTREG: totregMatch ? totregMatch[1] : '0',
        PASO: pasoMatch ? pasoMatch[1] : 'P01',
        ACEPTAR: 'Avanzar Siguiente Paso',
      };

      if (process.env.DEBUG_SII) {
        const fs = require('fs');
        const path = require('path');
        const debugDir = this.debugDir;
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance2_avanzar.html');
        fs.writeFileSync(debugPath, formHtml, 'utf8');
        console.log(' [DEBUG] HTML avanzar guardado en:', debugPath);
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
        const debugDir = this.debugDir;
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, 'pe_avance3_avanzar_response.html');
        fs.writeFileSync(debugPath, body);
        console.log(' [DEBUG] Respuesta avanzar guardada en:', debugPath);
      }

      // El botón real (avanzar()) solo cambia el action y submitea — no valida nada del lado
      // cliente. La respuesta del SII distingue estos casos por texto, no por status HTTP
      // (siempre 200) ni por la palabra "error" (aparece en el <script> de todas las páginas
      // del portal):
      //   "ha pasado al paso X"                    → avance REAL a otro paso intermedio
      //   "ha finalizado con la certificación..."   → avance REAL — llegó al paso final,
      //                                               queda pendiente declarar cumplimiento
      //                                               (pe_avance7→8, ver declararCumplimiento())
      //   "ya se encuentra en el paso X"            → no-op: no avanzó nada (PASO no
      //                                               coincidía, o el SII aún no habilita el
      //                                               siguiente paso) — NO es un error
      //   cualquier otro texto                      → error real
      const texto = limpiarTextoPortal(body);
      const RE_AVANZO = /ha pasado al paso|ha finalizado con la certificaci/i;
      const avanzo    = RE_AVANZO.test(texto);
      const sinCambio = /ya se encuentra en el paso/i.test(texto);
      const frases = texto.split(/(?<=\.)\s+/);
      const mensaje = (frases.find(f => RE_AVANZO.test(f) || /ya se encuentra en el paso/i.test(f)) || '').trim() || null;

      return {
        success: avanzo,
        sinCambio,
        mensaje,
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
   * Guarda un HTML de debug del flujo de declaración de cumplimiento.
   * @private
   */
  _saveDeclaracionDebug(filename, body) {
    try {
      const fs = require('fs');
      const path = require('path');
      const debugDir = this.debugDir;
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, filename), body || '', 'utf8');
    } catch (_e) { /* debug best-effort, no bloquear el flujo real */ }
  }

  /**
   * Declara cumplimiento de requisitos (etapa final).
   *
   * Es un wizard de 4 pasos en el portal SII, no uno solo:
   *   1. GET  pe_avance7               → formulario "ingrese RUT de la empresa"
   *   2. POST pe_avance8 (RUT/DV)      → pantalla intermedia con hidden OK_MSG=S
   *   3. POST pe_avance8 (OK_MSG=S)    → formulario real: 8 checkboxes de compromisos,
   *                                       action="pe_avance9"
   *   4. POST pe_avance9 (checkboxes)  → declaración efectuada (acción legal/irreversible)
   *
   * La versión anterior de este método solo hacía el paso 2 y devolvía `success: true`
   * si el texto no calzaba con el regex de bloqueo — pero el resultado del paso 2 es
   * SIEMPRE la pantalla intermedia del paso 3, nunca una confirmación real. Eso producía
   * un falso positivo: la declaración jurada real (paso 4) nunca se enviaba al SII, pero
   * quedaba registrada como completada en la base de datos del caller.
   *
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararCumplimiento() {
    const RE_BLOQUEO = /no ha finalizado su certificaci|no podr[aá] efectuar la Declaraci/i;
    const extraerBloqueo = (texto) => {
      const frases = texto.split(/(?<=\.)\s+/);
      return (frases.find(f => RE_BLOQUEO.test(f)) || '').trim() || null;
    };

    try {
      // Paso 1: acceder a la página de declarar cumplimiento
      let response = await this.session.ensureSession('/cvc_cgi/dte/pe_avance7');
      response = await this._handleRepresentacionPage(response);

      // Paso 2: enviar RUT/DV — primer submit del wizard
      let formResponse = await this.session.submitForm(
        '/cvc_cgi/dte/pe_avance8',
        {
          RUT_EMP: this.rutEmpresa,
          DV_EMP: this.dvEmpresa,
          ACEPTAR: 'Continuar',
        },
        'https://maullin.sii.cl/cvc_cgi/dte/pe_avance7'
      );

      let body = formResponse.body || '';
      this._saveDeclaracionDebug('pe_avance8-paso2.html', body);

      // El chequeo de bloqueo (SII no aprobó aún las muestras impresas) puede aparecer en
      // cualquiera de los pasos — se revisa después de cada submit.
      let texto = limpiarTextoPortal(body);
      if (RE_BLOQUEO.test(texto)) {
        return { success: false, bloqueado: true, mensaje: extraerBloqueo(texto), rawHtml: body };
      }

      // Paso 3: la respuesta del paso 2 es una pantalla intermedia con hidden OK_MSG=S —
      // hay que reenviarla para llegar al formulario real de checkboxes (action=pe_avance9).
      const hiddenPaso2 = SiiSession.extractInputValues(body);
      if (hiddenPaso2.OK_MSG) {
        formResponse = await this.session.submitForm(
          '/cvc_cgi/dte/pe_avance8',
          { ...hiddenPaso2, Aceptar: 'Continuar con la Declaración' },
          'https://maullin.sii.cl/cvc_cgi/dte/pe_avance8'
        );
        body = formResponse.body || '';
        this._saveDeclaracionDebug('pe_avance8-paso3.html', body);

        texto = limpiarTextoPortal(body);
        if (RE_BLOQUEO.test(texto)) {
          return { success: false, bloqueado: true, mensaje: extraerBloqueo(texto), rawHtml: body };
        }
      }

      // Paso 4: formulario final de checkboxes de compromisos (action=pe_avance9).
      // Es la declaración jurada real — marcar todos los OPC* y confirmar.
      const formAction = SiiSession.extractFormAction(body);
      if (formAction && formAction.includes('pe_avance9')) {
        const hiddenPaso3 = SiiSession.extractInputValues(body);
        // El HTML tiene DOS botones (CONFIRMAR="Confirmar Declaración" y Salir="No Confirmar",
        // este último con TYPE=button). extractInputValues lee <input> sin distinguir el type,
        // así que Salir queda en hiddenPaso3 con valor "No Confirmar". Un browser real solo
        // envía el par name/value del botón que el usuario clickeó — nunca ambos. Si se manda
        // Salir=No Confirmar junto con CONFIRMAR, el SII podría interpretar la presencia de ese
        // campo como "el usuario canceló", pisando la confirmación real.
        delete hiddenPaso3.Salir;
        const opcFields = {};
        for (const key of Object.keys(hiddenPaso3)) {
          if (/^OPC\d+$/.test(key)) opcFields[key] = 'S';
        }

        formResponse = await this.session.submitForm(
          formAction,
          { ...hiddenPaso3, ...opcFields, CONFIRMAR: 'Confirmar Declaración' },
          'https://maullin.sii.cl/cvc_cgi/dte/pe_avance8'
        );
        body = formResponse.body || '';
        this._saveDeclaracionDebug('pe_avance9-final.html', body);

        texto = limpiarTextoPortal(body);
        if (RE_BLOQUEO.test(texto)) {
          return { success: false, bloqueado: true, mensaje: extraerBloqueo(texto), rawHtml: body };
        }
      }

      // Verificación de éxito real: si la respuesta final TODAVÍA muestra el formulario de
      // checkboxes (OPC1) o el de ingreso de RUT inicial, el submit no se procesó como se
      // esperaba (ej. faltó un campo obligatorio) — no asumir éxito solo por ausencia de bloqueo.
      const siguePendiente = /NAME="OPC1"|name="RUT_EMP"[^>]*type=\s*text/i.test(body);
      if (siguePendiente) {
        return {
          success: false,
          bloqueado: false,
          mensaje: 'El SII no confirmó la declaración de cumplimiento — la respuesta final no coincide con lo esperado. Revisar el HTML de debug (pe_avance9-final.html) manualmente.',
          rawHtml: body,
        };
      }

      const mensaje = (texto.split(/(?<=\.)\s+/).find(f =>
        /declaraci[oó]n de cumplimiento|ha finalizado|certificad[ao]|efectuada/i.test(f)
      ) || '').trim() || null;

      return {
        success: true,
        bloqueado: false,
        mensaje,
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
          // Estados que NO se resuelven esperando: el dato declarado no cuadra con lo
          // que el SII tiene registrado, así que hay que corregirlo y volver a declarar.
          // Sin esta categoría caían en el limbo (ni conforme, ni en revisión, ni
          // rechazado) y el polling seguía hasta agotar el timeout de la etapa.
          // Caso real: "FECHA NO CORRESPONDE AL ENVIO" cuando el proceso corre en UTC
          // y declara con la fecha del día siguiente (ver TZ en docker-compose.yml).
          datoInconsistente: /NO CORRESPONDE|NO COINCIDE|FECHA INVALIDA/i.test(upper),
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
    // maxIntentos bajado de 30 a 5 (10s c/u = 50s tope, antes 5 min): evidencia real de hoy
    // (~10 corridas) muestra que esto SIEMPRE resuelve en el intento 1-3 (10-30s) — si tarda
    // más que eso, algo anda mal en vez de ser una demora normal del SII, y esperar 5 min
    // solo posterga descubrirlo.
    const { maxIntentos = 5, intervalo = 10000, onProgress } = options;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let intento = 1; intento <= maxIntentos; intento++) {
      await sleep(intervalo);

      if (onProgress) {
        onProgress({ intento, maxIntentos, estado: 'polling' });
      }
      emitProgress(STEPS.POLLING, { intento, max: maxIntentos, label: 'sets' });

      const result = await this.verAvanceParsed();
      if (!result.success) continue;

      // Filtrar solo los sets que nos interesan
      const estadosRelevantes = setsAEsperar.length > 0
        ? Object.fromEntries(
            Object.entries(result.estados).filter(([key]) => setsAEsperar.includes(key))
          )
        : result.estados;

      const todosConformes = Object.values(estadosRelevantes).every(e => e.esConforme);
      // `datoInconsistente` cuenta como rechazo: seguir esperando no lo arregla.
      const algunoRechazado = Object.values(estadosRelevantes)
        .some(e => e.esRechazado || e.datoInconsistente);

      if (onProgress) {
        onProgress({ intento, maxIntentos, estado: 'resultado', estados: estadosRelevantes });
      }

      if (todosConformes) {
        emitProgress(STEPS.SETS_APPROVED);
        return { success: true, estados: estadosRelevantes };
      }

      if (algunoRechazado) {
        emitProgress(STEPS.SETS_REJECTED);
        // El detalle va en el error, no solo en `estados`: el llamador suele
        // interpolar `error` en el mensaje que ve el usuario, y un literal
        // "Sets rechazados" rendía el inútil "Sets rechazados: Sets rechazados"
        // sin decir cuál set ni con qué estado. Se nombran solo los rechazados
        // para no ahogar el dato entre los que sí pasaron.
        const detalle = Object.values(estadosRelevantes)
          .filter(e => e.esRechazado || e.datoInconsistente)
          .map(e => `${e.nombre}: ${e.estado}`)
          .join('; ');
        return {
          success: false,
          error: detalle || 'el SII rechazó uno o más sets',
          estados: estadosRelevantes,
        };
      }
    }

    return { success: false, timedOut: true };
  }
}

// Exportar constantes junto con la clase
SiiCertificacion.ETAPAS = ETAPAS_CERTIFICACION;
SiiCertificacion.TIPOS_DTE = TIPOS_DTE;

module.exports = SiiCertificacion;
