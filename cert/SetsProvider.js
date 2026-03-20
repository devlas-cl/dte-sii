// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SetsProvider - Obtención y Parseo de Sets de Prueba del SII
 * 
 * Responsabilidades:
 * - Iniciar/reusar sesión SII
 * - Obtener sets de prueba del portal
 * - Parsear HTML a estructuras JSON
 * - Detectar si se regeneró el set (requiere reiniciar proceso)
 * 
 * @module dte-sii/cert/SetsProvider
 */

const fs = require('fs');
const path = require('path');
const SiiCertificacion = require('../SiiCertificacion');

// Parser de sets (ahora en el core)
const SetParser = require('./SetParser');

/**
 * Resultado de obtener sets
 * @typedef {Object} SetsResult
 * @property {boolean} success
 * @property {boolean} regenerated - Si el set fue regenerado (reiniciar proceso)
 * @property {Object} estructuras - Casos parseados por set
 * @property {Object} estadoSets - Estado de cada set en el SII
 * @property {string|null} error
 */

/**
 * Sets opcionales por defecto para certificación
 */
const DEFAULT_SETS_OPCIONALES = {
  SET03: 'S', // Guía Despacho
  SET06: 'S', // Factura Exenta
  SET72: 'S', // Factura Compra
  // SET11: 'S', // Exportación - NO INCLUIR por defecto
  // SET84: 'S', // Liquidación - NO INCLUIR por defecto
};

class SetsProvider {
  /**
   * @param {Object} options
   * @param {string} options.pfxPath - Ruta al certificado .pfx
   * @param {string} options.pfxPassword - Contraseña del certificado
   * @param {string} options.rutEmpresa - RUT sin DV (ej: "76123456")
   * @param {string} options.dvEmpresa - Dígito verificador
   * @param {string} [options.sessionPath] - Ruta para guardar/cargar sesión
   * @param {string} [options.debugDir] - Directorio para debug
   * @param {Object} [options.logger] - Logger opcional
   */
  constructor(options) {
    this._validateOptions(options);
    
    this.pfxPath = options.pfxPath;
    this.pfxPassword = options.pfxPassword;
    this.rutEmpresa = options.rutEmpresa;
    this.dvEmpresa = options.dvEmpresa;
    this.sessionPath = options.sessionPath || null;
    this.debugDir = options.debugDir || null;
    this.logger = options.logger || console;
    
    // Instancia de SiiCertificacion (lazy init)
    this._siiCert = null;
    
    // Cache de estructuras
    this._estructurasCache = null;
    this._lastFetchTime = null;
    this._lastNumeroAtencion = null; // Para detectar regeneración
  }

  /**
   * Valida opciones requeridas
   * @private
   */
  _validateOptions(options) {
    const required = ['pfxPath', 'pfxPassword', 'rutEmpresa', 'dvEmpresa'];
    for (const key of required) {
      if (!options[key]) {
        throw new Error(`SetsProvider: '${key}' es requerido`);
      }
    }
  }

  /**
   * Obtiene la instancia de SiiCertificacion (lazy init)
   * @private
   */
  _getSiiCert() {
    if (!this._siiCert) {
      this._siiCert = new SiiCertificacion({
        pfxPath: this.pfxPath,
        pfxPassword: this.pfxPassword,
        rutEmpresa: this.rutEmpresa,
        dvEmpresa: this.dvEmpresa,
      });
    }
    return this._siiCert;
  }

  /**
   * Inicializa o reutiliza la sesión SII
   * @returns {Promise<boolean>}
   */
  async initSession() {
    this.logger.log('[SetsProvider] 🔐 Inicializando sesión SII...');
    
    const siiCert = this._getSiiCert();
    
    // Intentar cargar sesión existente
    if (this.sessionPath && SiiCertificacion.isSessionValid(this.sessionPath)) {
      this.logger.log('[SetsProvider]    ✓ Sesión existente válida');
      const loaded = siiCert.loadSession(this.sessionPath);
      if (loaded) {
        return true;
      }
    }
    
    // Crear nueva sesión
    this.logger.log('[SetsProvider]    Estableciendo nueva sesión...');
    try {
      // verAvance() fuerza el login
      await siiCert.verAvance();
      
      // Guardar sesión para reutilizar
      if (this.sessionPath) {
        this._ensureDir(path.dirname(this.sessionPath));
        siiCert.saveSession(this.sessionPath);
        this.logger.log('[SetsProvider]    ✓ Sesión guardada');
      }
      
      return true;
    } catch (error) {
      this.logger.error(`[SetsProvider]    ❌ Error: ${error.message}`);
      return false;
    }
  }

  /**
   * Obtiene los sets de prueba del SII
   * @param {Object} [options]
   * @param {boolean} [options.descargar=true] - Descargar contenido del set
   * @param {boolean} [options.forceRefresh=false] - Forzar nueva descarga
   * @param {Object} [options.setsOpcionales] - Sets opcionales a incluir
   * @returns {Promise<SetsResult>}
   */
  async obtenerSets(options = {}) {
    const {
      descargar = true,
      forceRefresh = false,
      setsOpcionales = DEFAULT_SETS_OPCIONALES,
    } = options;

    this.logger.log('\n[SetsProvider] 📦 Obteniendo sets de prueba...');

    // Si hay cache y no se fuerza refresh, retornar cache
    if (!forceRefresh && this._estructurasCache) {
      this.logger.log('[SetsProvider]    ✓ Usando cache de estructuras');
      return {
        success: true,
        regenerated: false,
        estructuras: this._estructurasCache,
        fromCache: true,
      };
    }

    try {
      // Asegurar sesión activa
      const sessionOk = await this.initSession();
      if (!sessionOk) {
        return {
          success: false,
          error: 'No se pudo establecer sesión con el SII',
        };
      }

      const siiCert = this._getSiiCert();
      
      // Obtener sets del SII
      const result = await siiCert.generarSetPruebas({
        descargar,
        setsOpcionales,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Error al obtener sets del SII',
        };
      }

      // Si después del self-reauth interno de generarSetPruebas SIGUE mostrando
      // "no inscrito", la empresa genuinamente no está en el programa de postulación
      if (result.noInscrito) {
        return {
          success: false,
          error: 'El contribuyente no está inscrito en Postulación en el portal SII. ' +
                 'Accede a https://maullin.sii.cl y verifica el estado de certificación.',
        };
      }

      // Guardar sesión después de operación exitosa
      this.saveSession();

      // Guardar HTML para debug
      if (this.debugDir && result.rawHtml) {
        this._saveDebug('sets-raw.html', result.rawHtml);
      }

      // Detectar si el set fue regenerado
      const regenerated = this._detectRegeneration(result);
      if (regenerated) {
        this.logger.log('[SetsProvider]    ⚠️ Set regenerado - reiniciar proceso');
        // Invalidar cualquier cache anterior
        this.invalidateCache();
      }

      // Parsear estructuras si se descargó
      let estructuras = null;
      let datosExtraidos = null;
      
      if (descargar && result.setDescargado) {
        // Verificar sesión válida
        const htmlLower = String(result.setDescargado.rawHtml || '').toLowerCase();
        if (htmlLower.includes('no se encuentra autenticado') || 
            (htmlLower.includes('postulacion factura electronica') && !htmlLower.includes('caso'))) {
          // Distinguir: ¿es "no inscrito" o expiró la sesión?
          if (htmlLower.includes('no inscrito') || (htmlLower.includes('no est') && htmlLower.includes('inscrito'))) {
            this.logger.log('[SetsProvider]    ℹ️  pe_generar2: empresa no inscrita en Postulación (fase avanzada).');
            return { success: false, error: 'El contribuyente no está inscrito en Postulación en el portal SII.' };
          }
          // Sesión expiró en el portal aunque el archivo no lo sabía → forzar re-autenticación
          // Cookies vencidas server-side: limpiar sesión guardada y pedir a
          // generarSetPruebas que re-autentique por sí mismo via pe_generar
          this.logger.log('[SetsProvider]    ⚠️ Sesión rechazada por portal, limpiando y reintentando...');
          if (this.sessionPath) {
            const SiiSession = require('../SiiSession');
            SiiSession.clearSession(this.sessionPath);
          }
          this._siiCert = null;

          const siiCertFresh = this._getSiiCert();
          // sesión vacía → ensureSession dentro de generarSetPruebas hará el login redirect
          const retryResult = await siiCertFresh.generarSetPruebas({ descargar, setsOpcionales });
          if (!retryResult.success) {
            return {
              success: false,
              error: retryResult.error || 'Error al obtener sets tras re-autenticación',
            };
          }
          if (retryResult.noInscrito) {
            return {
              success: false,
              error: 'El contribuyente no está inscrito en Postulación en el portal SII.',
            };
          }
          // Guardar nueva sesión
          if (this.sessionPath) {
            this._ensureDir(path.dirname(this.sessionPath));
            siiCertFresh.saveSession(this.sessionPath);
          }
          // Reemplazar result con el reintento exitoso para continuar el flujo normal
          Object.assign(result, retryResult);
        }

        // Parsear usando flujoCert si está disponible
        const parseResult = this._parseSetDescargado(result.setDescargado.rawHtml);
        estructuras = parseResult.estructuras;
        datosExtraidos = parseResult.datosExtraidos;
        
        if (estructuras) {
          this._estructurasCache = estructuras;
          this._lastFetchTime = Date.now();
          
          // Guardar estructuras para debug
          if (this.debugDir) {
            this._saveDebug('estructuras.json', JSON.stringify(estructuras, null, 2));
            if (datosExtraidos) {
              this._saveDebug('datos-extraidos.json', JSON.stringify(datosExtraidos, null, 2));
            }
          }
        }
      }

      this.logger.log('[SetsProvider]    ✓ Sets obtenidos correctamente');

      return {
        success: true,
        regenerated,
        estructuras,
        datosExtraidos,
        estadoSets: result.estadoSets,
        setsOpcionales: result.setsOpcionales,
      };

    } catch (error) {
      this.logger.error(`[SetsProvider]    ❌ Error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Consulta el estado de avance en el SII
   * @returns {Promise<Object>}
   */
  async consultarAvance() {
    const siiCert = this._getSiiCert();
    return siiCert.verAvance();
  }

  /**
   * Detecta si el set fue regenerado (folios nuevos)
   * @private
   */
  _detectRegeneration(result) {
    // Si el HTML contiene indicadores de regeneración
    const html = result.rawHtml || '';
    if (html.includes('Set generado correctamente') ||
        html.includes('nuevos folios asignados')) {
      return true;
    }
    
    // Comparar número de atención con el anterior si existe
    if (result.setDescargado?.rawHtml && this._lastNumeroAtencion) {
      const match = result.setDescargado.rawHtml.match(/NUMERO DE ATENCI[^:]*:\s*(\d+)/i);
      if (match && match[1] !== this._lastNumeroAtencion) {
        this.logger.log(`[SetsProvider]    Número de atención cambió: ${this._lastNumeroAtencion} → ${match[1]}`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Parsea el set descargado usando flujoCert
   * @private
   * @param {string} rawHtml - HTML del set descargado
   * @returns {{ estructuras: Object, datosExtraidos: Object }}
   */
  _parseSetDescargado(rawHtml) {
    // Limpiar HTML y extraer texto
    const textoLimpio = this._limpiarHtml(rawHtml);
    
    // Guardar texto limpio para debug
    if (this.debugDir) {
      this._saveDebug('set-texto.txt', textoLimpio);
    }

    // Usar SetParser del core
    this.logger.log('[SetsProvider]    Usando SetParser del core...');
    
    const datosExtraidos = SetParser.extraerCasosDelSet(textoLimpio);
    
    if (datosExtraidos.sets.length === 0) {
      this.logger.log('[SetsProvider]    ⚠️ No se encontraron sets en el contenido');
      return { estructuras: null, datosExtraidos: null };
    }

    this.logger.log(`[SetsProvider]    📦 Sets encontrados: ${datosExtraidos.sets.length}`);
    this.logger.log(`[SetsProvider]    📄 Total casos: ${datosExtraidos.totalCasos}`);

    // Guardar número de atención para detectar regeneración
    if (datosExtraidos.sets[0]?.numeroAtencion) {
      this._lastNumeroAtencion = datosExtraidos.sets[0].numeroAtencion;
    }

    // Generar estructuras para scripts
    const estructuras = SetParser.generarEstructurasParaScripts(datosExtraidos);
    
    return { estructuras, datosExtraidos };
  }

  /**
   * Limpia HTML y extrae texto plano
   * @private
   */
  _limpiarHtml(html) {
    return html
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
      .replace(/&Aacute;/g, 'Á')
      .replace(/&Eacute;/g, 'É')
      .replace(/&Iacute;/g, 'Í')
      .replace(/&Oacute;/g, 'Ó')
      .replace(/&Uacute;/g, 'Ú')
      .replace(/&Ntilde;/g, 'Ñ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  }

  /**
   * Parsea las estructuras del set descargado (método legacy)
   * @private
   * @deprecated Usar _parseSetDescargado en su lugar
   */
  _parseEstructuras(setDescargado) {
    if (setDescargado.rawHtml) {
      const result = this._parseSetDescargado(setDescargado.rawHtml);
      return result.estructuras;
    }
    return null;
  }

  /**
   * Organiza los casos por tipo de set
   * @private
   */
  _organizarCasosPorSet(casos) {
    const estructuras = {
      setBasico: { casos: [], cafRequired: {} },
      setExenta: { casos: [], cafRequired: {} },
      setGuia: { casos: [], cafRequired: {} },
      setCompra: { casos: [], cafRequired: {} },
    };

    for (const caso of casos) {
      const tipoDte = caso.tipoDte || caso.tipo;
      
      // Clasificar por tipo de DTE
      if ([33, 56, 61].includes(tipoDte)) {
        estructuras.setBasico.casos.push(caso);
        this._incrementCafRequired(estructuras.setBasico.cafRequired, tipoDte);
      } else if (tipoDte === 34) {
        estructuras.setExenta.casos.push(caso);
        this._incrementCafRequired(estructuras.setExenta.cafRequired, tipoDte);
      } else if (tipoDte === 52) {
        estructuras.setGuia.casos.push(caso);
        this._incrementCafRequired(estructuras.setGuia.cafRequired, tipoDte);
      } else if (tipoDte === 46) {
        estructuras.setCompra.casos.push(caso);
        this._incrementCafRequired(estructuras.setCompra.cafRequired, tipoDte);
      }
    }

    return estructuras;
  }

  /**
   * Incrementa contador de CAF requerido
   * @private
   */
  _incrementCafRequired(cafRequired, tipoDte) {
    cafRequired[tipoDte] = (cafRequired[tipoDte] || 0) + 1;
  }

  /**
   * Guarda la sesión actual
   */
  saveSession() {
    if (this.sessionPath && this._siiCert) {
      this._ensureDir(path.dirname(this.sessionPath));
      this._siiCert.saveSession(this.sessionPath);
    }
  }

  /**
   * Invalida el cache de estructuras
   */
  invalidateCache() {
    this._estructurasCache = null;
    this._lastFetchTime = null;
  }

  /**
   * Crea directorio si no existe
   * @private
   */
  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Guarda archivo de debug
   * @private
   */
  _saveDebug(filename, content) {
    if (!this.debugDir) return;
    this._ensureDir(this.debugDir);
    fs.writeFileSync(path.join(this.debugDir, filename), content);
  }
}

module.exports = SetsProvider;
