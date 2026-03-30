// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Clase Base para Sets de Certificación
 * 
 * Proporciona la estructura común para todos los sets:
 * - SetBasico (33, 56, 61)
 * - SetExenta (34)
 * - SetGuia (52)
 * - SetCompra (46)
 * 
 * Patrón: Template Method
 * - ejecutar() define el flujo general
 * - Subclases implementan generarDtes()
 * 
 * @module dte-sii/cert/SetBase
 */

const { SetResult } = require('./types');

class SetBase {
  /**
   * @param {Object} deps - Dependencias inyectadas
   * @param {Object} deps.config - Configuración (emisor, receptor, certificado, etc.)
   * @param {Object} deps.cafManager - Gestor de CAFs (ensureCaf)
   * @param {Object} deps.folioHelper - Helper de folios (reserveNextFolio, createCafFingerprint)
   * @param {Object} deps.enviador - Función o clase para enviar al SII
   * @param {Object} [deps.logger] - Logger opcional
   */
  constructor(deps) {
    this._validateDeps(deps);
    
    this.config = deps.config;
    this.cafManager = deps.cafManager;
    this.folioHelper = deps.folioHelper;
    this.enviador = deps.enviador;
    this.logger = deps.logger || console;
    
    // Subclases deben definir estos
    this.key = ''; // 'basico', 'exenta', 'guia', 'compra'
    this.label = ''; // 'Set Básico (Facturas)'
    this.tiposDte = [];      // [33, 56, 61]
  }

  /**
   * Valida que las dependencias requeridas estén presentes
   * @private
   */
  _validateDeps(deps) {
    const required = ['config', 'cafManager', 'folioHelper', 'enviador'];
    for (const dep of required) {
      if (!deps[dep]) {
        throw new Error(`SetBase: dependencia '${dep}' es requerida`);
      }
    }
    
    // Validar config mínima
    const { config } = deps;
    if (!config.emisor?.rut) {
      throw new Error('SetBase: config.emisor.rut es requerido');
    }
    if (!config.certificado?.path) {
      throw new Error('SetBase: config.certificado.path es requerido');
    }
  }

  /**
   * Ejecuta el set completo (Template Method)
   * 
   * Flujo:
   * 1. Validar casos de entrada
   * 2. Asegurar CAFs disponibles
   * 3. Generar DTEs (implementado por subclases)
   * 4. Crear envío firmado
   * 5. Enviar al SII
   * 6. Retornar resultado
   * 
   * @param {Object} casos - Casos del set parseados del SII
   * @param {Object} [preloadedCafs] - CAFs pre-cargados { tipoDte: path } (opcional)
   * @returns {Promise<SetResult>}
   */
  async ejecutar(casos, preloadedCafs = null) {
    const startTime = Date.now();
    this.logger.log(`\n${'═'.repeat(60)}`);
    this.logger.log(`${this.label}`);
    this.logger.log(`${'═'.repeat(60)}\n`);

    try {
      // 1. Validar casos
      this._validarCasos(casos);
      
      // 2. Asegurar CAFs disponibles (usa pre-cargados si existen)
      this.logger.log('Verificando folios (CAFs)...');
      const cafs = preloadedCafs || await this.ensureCafs(casos);
      
      if (preloadedCafs) {
        for (const [tipoDte, cafPath] of Object.entries(preloadedCafs)) {
          this.logger.log(` ✓ CAF tipo ${tipoDte} (pre-cargado)`);
        }
      }
      
      // 3. Generar DTEs (subclases implementan)
      this.logger.log('Generando DTEs...');
      const dtes = await this.generarDtes(casos, cafs);
      this.logger.log(` ✓ ${dtes.length} DTEs generados`);
      
      // 4. Crear envío firmado
      this.logger.log('Firmando envío...');
      const envio = await this.crearEnvio(dtes);
      
      // 5. Enviar al SII
      this.logger.log('Enviando al SII...');
      const respuesta = await this.enviarSii(envio);
      
      // 6. Construir resultado con documentos para libros
      const documentos = dtes.map(dte => {
        const idDocData = dte.datos?.Encabezado?.IdDoc || {};
        const totalesData = dte.datos?.Encabezado?.Totales || {};
        
        // Extraer IVARetTotal desde ImptoReten (TipoImp=15)
        let ivaRetTotal = 0;
        if (totalesData.ImptoReten) {
          const retenciones = Array.isArray(totalesData.ImptoReten) 
            ? totalesData.ImptoReten 
            : [totalesData.ImptoReten];
          const ret15 = retenciones.find(r => r.TipoImp === 15);
          if (ret15) {
            ivaRetTotal = Number(ret15.MontoImp || 0);
          }
        }
        
        return {
          tipoDte: dte.getTipoDTE(),
          folio: dte.getFolio(),
          id: dte.getId(),
          fecha: idDocData.FchEmis,
          indTraslado: idDocData.IndTraslado, // Para guías
          totales: {
            MntExe: totalesData.MntExe || 0,
            MntNeto: totalesData.MntNeto || 0,
            IVA: totalesData.IVA || 0,
            MntTotal: totalesData.MntTotal || dte.getMontoTotal(),
            TasaIVA: totalesData.TasaIVA || 19,
            IVARetTotal: ivaRetTotal, // Extraído de ImptoReten[TipoImp=15]
          },
        };
      });
      
      const result = SetResult.success({
        trackId: respuesta.trackId,
        documentos, // Incluye totales para libros
        dtes: documentos.map(d => ({ // Compatibilidad
          tipo: d.tipoDte,
          folio: d.folio,
          id: d.id,
          montoTotal: d.totales.MntTotal,
        })),
        xmlPath: respuesta.xmlPath,
        responsePath: respuesta.responsePath,
        duration: Date.now() - startTime,
      });

      this.logger.log(`\n[OK] ${this.label} completado`);
      this.logger.log(` Track ID: ${result.trackId}`);
      this.logger.log(` Duración: ${result.duration}ms\n`);

      return result;

    } catch (error) {
      this.logger.error(`\n[ERR] Error en ${this.label}: ${error.message}\n`);
      
      const result = SetResult.failure(error.message);
      result.duration = Date.now() - startTime;
      return result;
    }
  }

  /**
   * Valida que los casos tengan la estructura esperada
   * @protected
   * @param {Object} casos
   */
  _validarCasos(casos) {
    if (!casos) {
      throw new Error(`No se proporcionaron casos para ${this.label}`);
    }
    // Subclases pueden extender esta validación
  }

  /**
   * Asegura que hay CAFs disponibles para todos los tipos de DTE
   * @param {Object} casos - Para calcular cantidad necesaria
   * @returns {Promise<Object>} - { [tipoDte]: cafPath }
   */
  async ensureCafs(casos) {
    const cafs = {};
    
    for (const tipoDte of this.tiposDte) {
      const cantidad = this._calcularCantidadFolios(casos, tipoDte);
      this.logger.log(` Tipo ${tipoDte}: ${cantidad} folios requeridos`);
      
      const cafPath = await this.cafManager.ensureCaf({
        tipoDte,
        rutEmisor: this.config.emisor.rut,
        requiredCount: cantidad,
        forceNew: false,
        preferExisting: true,
      });
      
      if (!cafPath) {
        throw new Error(`No se pudo obtener CAF para tipo ${tipoDte}`);
      }
      
      cafs[tipoDte] = cafPath;
      this.logger.log(` ✓ CAF tipo ${tipoDte}: ${cafPath}`);
    }
    
    return cafs;
  }

  /**
   * Calcula cuántos folios se necesitan para un tipo de DTE
   * Subclases pueden sobrescribir para lógica específica
   * @protected
   * @param {Object} casos
   * @param {number} tipoDte
   * @returns {number}
   */
  _calcularCantidadFolios(casos, tipoDte) {
    // Implementación por defecto: cuenta los casos de ese tipo
    if (casos.cafRequired && casos.cafRequired[tipoDte]) {
      return casos.cafRequired[tipoDte];
    }
    return 1;
  }

  /**
   * Genera los DTEs del set
   * 
   * [!] DEBE SER IMPLEMENTADO POR SUBCLASES
   * 
   * @abstract
   * @param {Object} casos - Casos parseados del SII
   * @param {Object} cafs - { [tipoDte]: cafPath }
   * @returns {Promise<DTE[]>}
   */
  async generarDtes(casos, cafs) {
    throw new Error(`${this.constructor.name} debe implementar generarDtes()`);
  }

  /**
   * Crea un EnvioDTE firmado con los DTEs generados
   * @param {DTE[]} dtes
   * @returns {Promise<Object>} - Envío listo para enviar
   */
  async crearEnvio(dtes) {
    const { EnvioDTE, Certificado } = require('../index');
    const fs = require('fs');
    
    // Cargar certificado
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const cert = new Certificado(pfxBuffer, this.config.certificado.password);
    
    // Timestamp para firma
    const timestamp = new Date().toISOString().replace('Z', '');
    
    // Crear envío
    const envio = new EnvioDTE({ certificado: cert });
    
    // Agregar DTEs
    for (const dte of dtes) {
      envio.agregar(dte);
    }
    
    // Configurar carátula
    envio.setCaratula({
      RutEmisor: this.config.emisor.rut,
      RutEnvia: cert.rut || this.config.emisor.rut,
      RutReceptor: '60803000-K', // SII para certificación
      FchResol: this.config.resolucion?.fecha || this.config.emisor.fch_resol,
      NroResol: this.config.resolucion?.numero ?? this.config.emisor.nro_resol,
      TmstFirmaEnv: timestamp,
      SetDTEId: 'DTE_SetDoc',
    });
    
    // Generar XML
    envio.generar();
    
    return envio;
  }

  /**
   * Envía el envío firmado al SII
   * @param {Object} envio - EnvioDTE firmado
   * @returns {Promise<Object>} - { trackId, xmlPath, responsePath }
   */
  async enviarSii(envio) {
    const resultado = await this.enviador.enviar(envio, {
      ambiente: this.config.ambiente || 'certificacion',
    });
    
    if (!resultado.success) {
      throw new Error(resultado.error || 'Error al enviar al SII');
    }
    
    return resultado;
  }

  /**
   * Genera los DTEs sin enviar (para preview/debug)
   * @param {Object} casos
   * @returns {Promise<DTE[]>}
   */
  async preview(casos) {
    this._validarCasos(casos);
    const cafs = await this.ensureCafs(casos);
    return this.generarDtes(casos, cafs);
  }
}

module.exports = SetBase;
