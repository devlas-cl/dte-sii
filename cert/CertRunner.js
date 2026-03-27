// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * CertRunner - Orquestador del proceso de certificación SII
 * 
 * Encapsula todo el flujo de certificación:
 * - Obtención de sets de prueba
 * - Solicitud de CAFs
 * - Ejecución de sets (Básico, Guía, Exenta, Compra)
 * - Envío de libros
 * - Declaración de avance
 * - Polling de estado
 * 
 * @module dte-sii/cert/CertRunner
 */

const fs = require('fs');
const path = require('path');

// Core
const { Certificado, EnvioDTE } = require('../index');
const EnviadorSII = require('../EnviadorSII');
const FolioService = require('../FolioService');
const SiiCertificacion = require('../SiiCertificacion');

// Módulo cert
const SetsProvider = require('./SetsProvider');
const CertFolioHelper = require('./CertFolioHelper');
const SetBasico = require('./SetBasico');
const SetGuia = require('./SetGuia');
const SetExenta = require('./SetExenta');
const SetCompra = require('./SetCompra');

// Libros (Fase 4)
const LibroVentas = require('./LibroVentas');
const LibroCompras = require('./LibroCompras');
const LibroGuias = require('./LibroGuias');

// Simulación (Fase 6)
const Simulacion = require('./Simulacion');

// Intercambio (Fase 7)
const IntercambioCert = require('./IntercambioCert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {Object} CertConfig
 * @property {Object} certificado - { path, password }
 * @property {Object} emisor - { rut, razon_social, giro, acteco, direccion, comuna, ciudad, fch_resol, nro_resol }
 * @property {Object} receptor - { rut, razon_social, giro, direccion, comuna, ciudad }
 * @property {string} [ambiente='certificacion']
 * @property {string} [debugDir]
 * @property {string} [sessionPath]
 */

class CertRunner {
  /**
   * @param {CertConfig} config - Configuración del runner
   */
  constructor(config) {
    this._validateConfig(config);
    
    this.config = config;
    this.ambiente = config.ambiente || 'certificacion';
    this.debugDir = config.debugDir || path.join(process.cwd(), 'debug', 'cert-v2');
    this.sessionPath = config.sessionPath || path.join(this.debugDir, 'session.json');
    
    // Componentes (lazy init)
    this._certificado = null;
    this._folioService = null;
    this._folioHelper = null;
    this._siiCert = null;
    this._setsProvider = null;
    this._estructuras = null;

    // Caché de sesión SII en memoria (evita logins múltiples durante la misma ejecución)
    // Se puede inyectar un cookieJar ya obtenido vía config.cookieJar para reutilizar sesión.
    this._siiCookieJar = config.cookieJar || null;
    
    // Resultados de ejecución
    this.resultados = {};
  }

  _validateConfig(config) {
    if (!config.certificado?.path) throw new Error('CertRunner: config.certificado.path es obligatorio');
    if (!config.certificado?.password && config.certificado?.password !== '') {
      throw new Error('CertRunner: config.certificado.password es obligatorio');
    }
    if (!config.emisor?.rut) throw new Error('CertRunner: config.emisor.rut es obligatorio');
    // receptor solo es obligatorio para flujos de emisión DTE (no para métodos de portal Puppeteer)
    if (config.receptor && !config.receptor.rut) {
      throw new Error('CertRunner: config.receptor.rut es obligatorio cuando se proporciona config.receptor');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Getters lazy para componentes
  // ═══════════════════════════════════════════════════════════════

  get certificado() {
    if (!this._certificado) {
      const pfxBuffer = fs.readFileSync(this.config.certificado.path);
      this._certificado = new Certificado(pfxBuffer, this.config.certificado.password);
    }
    return this._certificado;
  }

  get folioService() {
    if (!this._folioService) {
      this._folioService = new FolioService({
        ambiente: this.ambiente,
        rutEmisor: this.config.emisor.rut,
        pfxPath: this.config.certificado.path,
        pfxPassword: this.config.certificado.password,
        debugDir: this.debugDir,
        sessionPath: this.sessionPath, // Usar sesión compartida
        retries: 3,
      });
    }
    return this._folioService;
  }

  get folioHelper() {
    if (!this._folioHelper) {
      this._folioHelper = new CertFolioHelper({ ambiente: this.ambiente });
    }
    return this._folioHelper;
  }

  get siiCert() {
    if (!this._siiCert) {
      const [rut, dv] = this.config.emisor.rut.split('-');
      this._siiCert = new SiiCertificacion({
        pfxPath: this.config.certificado.path,
        pfxPassword: this.config.certificado.password,
        rutEmpresa: rut,
        dvEmpresa: dv,
      });
    }
    return this._siiCert;
  }

  get setsProvider() {
    if (!this._setsProvider) {
      const [rut, dv] = this.config.emisor.rut.split('-');
      this._setsProvider = new SetsProvider({
        pfxPath: this.config.certificado.path,
        pfxPassword: this.config.certificado.password,
        rutEmpresa: rut,
        dvEmpresa: dv,
        sessionPath: this.sessionPath,
        debugDir: this.debugDir,
      });
    }
    return this._setsProvider;
  }

  // ═══════════════════════════════════════════════════════════════
  // Métodos públicos
  // ═══════════════════════════════════════════════════════════════

  /**
   * Obtiene los sets de prueba del SII
   * @param {Object} [options] - { setsOpcionales }
   * @returns {Promise<Object>} { success, estructuras, error }
   */
  async obtenerSets(options = {}) {
    const resultado = await this.setsProvider.obtenerSets({
      setsOpcionales: options.setsOpcionales || {
        SET03: 'S',  // SET GUIA DE DESPACHO
        SET06: 'S',  // SET FACTURA EXENTA
        SET07: 'S',  // LIBRO DE VENTAS
        SET08: 'S',  // LIBRO DE COMPRAS
        SET09: 'S',  // LIBRO DE GUIAS
        SET15: 'S',  // LIBRO DE COMPRAS PARA EXENTOS
        SET72: 'S',  // SET CASO GENERAL FACTURA COMPRA
      },
      forceRefresh: true,  // siempre fresco — nunca reusar caché de ejecuciones anteriores
    });

    if (!resultado.success) {
      return { success: false, error: resultado.error || 'Error desconocido al obtener sets' };
    }

    this._estructuras = resultado.estructuras;
    
    // Guardar debug — solo si hay estructuras reales (no sobreescribir con null)
    if (resultado.estructuras) {
      fs.mkdirSync(this.debugDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.debugDir, 'estructuras.json'),
        JSON.stringify(resultado.estructuras, null, 2)
      );
    }

    return { success: true, estructuras: resultado.estructuras };
  }

  /**
   * Solicita CAFs frescos para los tipos especificados
   * @param {Object} cafRequired - { 33: 4, 56: 1, 61: 3 }
   * @returns {Promise<Object>} { 33: cafPath, 56: cafPath, ... }
   */
  async solicitarCafs(cafRequired) {
    const cafs = {};
    
    // Limpiar contadores para nuevos CAFs
    this.folioHelper.counters.clear();
    this.folioHelper.usedFolios.clear();
    
    for (const [tipoDte, cantidad] of Object.entries(cafRequired)) {
      console.log(`   Tipo ${tipoDte}: ${cantidad} folios...`);
      
      // Usar solicitarCafConFallback que solicita y retorna el path
      const cafPath = await this.folioService.solicitarCafConFallback({
        tipoDte: Number(tipoDte),
        cantidad: Number(cantidad),
      });
      
      if (!cafPath) {
        throw new Error(`No se pudo obtener CAF para tipo ${tipoDte}`);
      }
      
      cafs[tipoDte] = cafPath;
      console.log(`   ✓ CAF tipo ${tipoDte}`);
    }
    
    return cafs;
  }

  /**
   * Crea un enviador para enviar DTEs al SII
   * @param {string} [setName] - Nombre del set para guardar XML (ej: 'basico', 'guia')
   * @returns {Object} Enviador compatible con Sets
   */
  _createEnviador(setName = null) {
    const enviador = new EnviadorSII(this.certificado, this.ambiente);
    const debugDir = this.debugDir;

    return {
      async enviar(envio) {
        // Guardar XML del set antes de enviar (para muestras impresas)
        if (setName && debugDir && envio.xml) {
          const setsDir = path.join(debugDir, 'sets-prueba');
          fs.mkdirSync(setsDir, { recursive: true });
          
          // Guardar envío consolidado
          const envioPath = path.join(setsDir, `envio-set-${setName}.xml`);
          fs.writeFileSync(envioPath, envio.xml, 'utf8');
          console.log(`   📄 XML guardado: ${envioPath}`);
          
          // Guardar DTEs individuales
          if (envio.dtes && envio.dtes.length > 0) {
            const dtesDir = path.join(setsDir, 'dtes');
            fs.mkdirSync(dtesDir, { recursive: true });
            for (const dte of envio.dtes) {
              const tipoDte = dte.getTipoDTE ? dte.getTipoDTE() : dte.tipoDte;
              const folio = dte.getFolio ? dte.getFolio() : dte.folio;
              const dteXml = dte.xml || (dte.getXml ? dte.getXml() : null);
              if (dteXml) {
                const filename = `dte-${String(tipoDte).padStart(2, '0')}-${String(folio).padStart(6, '0')}.xml`;
                fs.writeFileSync(path.join(dtesDir, filename), dteXml, 'utf8');
              }
            }
          }
        }
        
        const resultado = await enviador.enviarDteSoap(envio);
        return {
          success: !!resultado?.trackId,
          trackId: resultado?.trackId,
          error: resultado?.error,
        };
      },
    };
  }

  /**
   * Ejecuta un set genérico — toda la lógica común entre los 4 sets.
   * @private
   */
  async _ejecutarSet(ClaseSet, estructuraKey, resultadoKey, cafFallback, enviadorNombre, casosExterno) {
    const setData = casosExterno || this._estructuras?.[estructuraKey];
    if (!setData) {
      throw new Error(`No hay casos para ${ClaseSet.name}. Ejecutar obtenerSets() primero.`);
    }

    const cafRequired = setData.cafRequired ||
      (typeof cafFallback === 'function' ? cafFallback(setData) : cafFallback);
    const cafs = await this.solicitarCafs(cafRequired);

    const set = new ClaseSet({
      config: {
        emisor: this.config.emisor,
        receptor: this.config.receptor,
        certificado: this.config.certificado,
        ambiente: this.ambiente,
        resolucion: {
          fecha: this.config.emisor.fch_resol,
          numero: this.config.emisor.nro_resol,
        },
      },
      cafManager: { ensureCaf: ({ tipoDte }) => cafs[tipoDte] },
      folioHelper: this.folioHelper,
      enviador: this._createEnviador(enviadorNombre),
    });

    const resultado = await set.ejecutar(setData, cafs);
    this.resultados[resultadoKey] = resultado;
    return resultado;
  }

  async ejecutarSetBasico(casos) {
    return this._ejecutarSet(SetBasico, 'setBasico', 'basico', { 33: 4, 56: 1, 61: 3 }, 'basico', casos);
  }

  async ejecutarSetGuia(casos) {
    return this._ejecutarSet(SetGuia, 'setGuiaDespacho', 'guia',
      (setData) => ({ 52: setData.casos?.length || 1 }), 'guia', casos);
  }

  async ejecutarSetExenta(casos) {
    return this._ejecutarSet(SetExenta, 'setFacturaExenta', 'exenta', { 34: 3, 56: 1, 61: 4 }, 'exenta', casos);
  }

  async ejecutarSetCompra(casos) {
    return this._ejecutarSet(SetCompra, 'setFacturaCompra', 'compra', { 46: 1, 56: 1, 61: 1 }, 'compra', casos);
  }

  /**
   * Bucle de reintentos común para declarar avance/libros/simulación.
   * @private
   * @param {Object} sets - Sets a declarar (pasados a siiCert.declararAvance)
   * @param {string} debugPrefix - Prefijo del archivo HTML de debug (ej: 'declaracion-response')
   * @param {Object} [options] - { maxIntentos, intervalo, label }
   */
  async _declararConReintentos(sets, debugPrefix, options = {}) {
    const { maxIntentos = 10, intervalo = 5000, label = 'avance' } = options;

    console.log(`   ⏳ Esperando 10s para que SII procese los envíos...`);
    await sleep(10000);

    let lastResult = null;
    for (let intento = 1; intento <= maxIntentos; intento++) {
      console.log(`   🔄 Declarando ${label} (intento ${intento}/${maxIntentos})...`);

      const result = await this.siiCert.declararAvance({ sets });
      lastResult = result;

      if (result.rawHtml) {
        fs.writeFileSync(
          path.join(this.debugDir, `${debugPrefix}-${intento}.html`),
          result.rawHtml,
          'utf8'
        );
      }

      const html = result.rawHtml || '';
      const noProcessedError =
        html.includes('no ha sido procesado') ||
        html.includes('aún no está disponible') ||
        html.includes('intente más tarde') ||
        html.includes('no se encuentra');

      if (result.success && !noProcessedError) {
        return result;
      }

      if (noProcessedError && intento < maxIntentos) {
        console.log(`   ⏳ SII aún procesando, reintentando en ${intervalo / 1000}s...`);
        await sleep(intervalo);
      } else if (!result.success) {
        console.log(`   ⚠️ Error declarando ${label}: ${result.error || 'desconocido'}`);
        break;
      }
    }

    return lastResult;
  }

  /**
   * Declara avance de los sets ejecutados con reintentos automáticos
   * @param {Object} [resultadosExt] - Resultados externos (usa this.resultados si no se pasa)
   * @param {Object} [estructurasExt] - Estructuras externas (usa this._estructuras si no se pasa)
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararAvance(resultadosExt, estructurasExt, options = {}) {
    const resultados = resultadosExt || this.resultados;
    const estructuras = estructurasExt || this._estructuras;
    const { maxIntentos = 10, intervalo = 5000 } = options;

    if (!estructuras) {
      throw new Error('No hay estructuras. Ejecutar obtenerSets() primero.');
    }

    const fecha = this._getFechaHoy();
    const sets = {};

    const mapping = {
      basico: 'setBasico',
      guia: 'setGuiaDespacho',
      exenta: 'setFacturaExenta',
      compra: 'setFacturaCompra',
    };

    for (const [resKey, setKey] of Object.entries(mapping)) {
      if (resultados[resKey]?.trackId) {
        sets[setKey] = {
          trackId: resultados[resKey].trackId,
          fecha,
          numeroAtencion: estructuras[setKey]?.numeroAtencion,
        };
      }
    }

    if (Object.keys(sets).length === 0) {
      return { success: false, error: 'No hay sets para declarar' };
    }

    const result = await this._declararConReintentos(sets, 'declaracion-response', { maxIntentos, intervalo, label: 'avance de sets' });
    if (result?.success) console.log('   ✓ Declaración de sets enviada');
    return result;
  }

  /**
   * Espera a que los sets sean aprobados
   * @param {string[]} [sets] - Sets a esperar (default: todos los ejecutados)
   * @param {Object} [options] - { maxIntentos, intervalo, onProgress }
   * @returns {Promise<Object>} Resultado del polling
   */
  async esperarAprobacion(sets, options = {}) {
    const setsAEsperar = sets || Object.entries(this.resultados)
      .filter(([_, r]) => r?.trackId)
      .map(([k]) => {
        const mapping = { basico: 'setBasico', guia: 'setGuiaDespacho', exenta: 'setFacturaExenta', compra: 'setFacturaCompra' };
        return mapping[k];
      })
      .filter(Boolean);

    return this.siiCert.waitForApproval(setsAEsperar, options);
  }

  /**
   * Consulta el estado actual de avance
   * @returns {Promise<Object>} Estados parseados
   */
  async consultarAvance() {
    return this.siiCert.verAvanceParsed();
  }

  // ═══════════════════════════════════════════════════════════════
  // LIBROS (Fase 4)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ejecuta toda la Fase 4: Envío y declaración de libros
   * NOTA: Cada libro decrementa su propio período para evitar "LNC - Libro Cerrado"
   * @param {Object} [options] - Opciones
   * @param {Object} [options.setBasicoResult] - Resultado del SetBasico
   * @param {Object} [options.setGuiaResult] - Resultado del SetGuia
   * @returns {Promise<Object>} Resultado con todos los libros
   */
  async ejecutarFase4Libros(options = {}) {
    // NOTA: Ya NO decrementamos aquí - cada libro decrementa su propio período
    console.log('\n' + '═'.repeat(60));
    console.log(`📚 FASE 4: LIBROS (cada libro usará período diferente)`);
    console.log('═'.repeat(60) + '\n');

    const resultados = {};
    const errores = [];

    try {
      // 1. Libro de Compras (usa datos del SII)
      console.log('\n📖 Enviando Libro de Compras...');
      resultados.libroCompras = await this.ejecutarLibroCompras(options);
      if (!resultados.libroCompras.success) {
        errores.push(`Libro Compras: ${resultados.libroCompras.error}`);
      }
    } catch (e) {
      errores.push(`Libro Compras: ${e.message}`);
    }

    try {
      // 2. Libro de Ventas (usa SetBasico)
      console.log('\n📖 Enviando Libro de Ventas...');
      resultados.libroVentas = await this.ejecutarLibroVentas(options);
      if (!resultados.libroVentas.success) {
        errores.push(`Libro Ventas: ${resultados.libroVentas.error}`);
      }
    } catch (e) {
      errores.push(`Libro Ventas: ${e.message}`);
    }

    try {
      // 3. Libro de Guías (usa SetGuia)
      console.log('\n📖 Enviando Libro de Guías...');
      resultados.libroGuias = await this.ejecutarLibroGuias(options);
      if (!resultados.libroGuias.success) {
        errores.push(`Libro Guías: ${resultados.libroGuias.error}`);
      }
    } catch (e) {
      errores.push(`Libro Guías: ${e.message}`);
    }

    // 4. Libro de Compras para Exentos (solo si el SII lo entregó)
    if (this._estructuras?.libroComprasExentos) {
      try {
        console.log('\n📖 Enviando Libro de Compras para Exentos...');
        resultados.libroComprasExentos = await this.ejecutarLibroComprasExentos(options);
        if (!resultados.libroComprasExentos.success) {
          errores.push(`Libro Compras Exentos: ${resultados.libroComprasExentos.error}`);
        }
      } catch (e) {
        errores.push(`Libro Compras Exentos: ${e.message}`);
      }
    }

    // Contar libros obligatorios (ventas + compras + guías)
    const librosObligatorios = ['libroVentas', 'libroCompras', 'libroGuias'];
    const librosEnviados = librosObligatorios.filter(k => resultados[k]?.success).length;
    
    if (librosEnviados === 3) {
      // 4. Declarar los libros
      console.log('\n📝 Declarando libros...');
      try {
        const declaracion = await this.declararLibros();
        resultados.declaracion = declaracion;
        
        if (declaracion.success) {
          console.log('\n✅ FASE 4 COMPLETADA: Todos los libros enviados y declarados');
        } else {
          console.log(`\n⚠️ Libros enviados pero declaración con error: ${declaracion.error}`);
        }
      } catch (e) {
        console.log(`\n⚠️ Error declarando libros: ${e.message}`);
        resultados.declaracion = { success: false, error: e.message };
      }
    } else {
      console.log(`\n⚠️ Solo ${librosEnviados}/3 libros enviados. Errores: ${errores.join('; ')}`);
    }

    return {
      success: librosEnviados === 3,
      librosEnviados,
      resultados,
      errores,
    };
  }

  /**
   * Declara avance de los libros ejecutados con reintentos automáticos
   * @param {Object} [resultadosExt] - Resultados externos (usa this.resultados si no se pasa)
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararLibros(resultadosExt, options = {}) {
    const resultados = resultadosExt || this.resultados;
    const { maxIntentos = 10, intervalo = 5000 } = options;

    const fecha = this._getFechaHoy();
    const sets = {};

    const mapping = {
      libroVentas: 'libroVentas',
      libroCompras: 'libroCompras',
      libroGuias: 'libroGuias',
      libroComprasExentos: 'libroComprasExentos',
    };

    for (const [resKey, setKey] of Object.entries(mapping)) {
      if (resultados[resKey]?.trackId) {
        sets[setKey] = { trackId: resultados[resKey].trackId, fecha };
      }
    }

    if (Object.keys(sets).length === 0) {
      return { success: false, error: 'No hay libros para declarar' };
    }

    const result = await this._declararConReintentos(sets, 'declaracion-libros-response', { maxIntentos, intervalo, label: 'libros' });
    if (result?.success) {
      const declarados = result.setsDeclarados || [];
      console.log(`   ✅ Libros declarados: ${declarados.join(', ')}`);
    }
    return result;
  }

  /**
   * Obtiene el período para libros (período fijo para certificación)
   * El período se decrementa cada vez que el SII rechaza con "LNC - Libro Cerrado"
   * Se guarda el período en un archivo de estado para persistir entre ejecuciones
   * @returns {string} Período en formato YYYY-MM
   */
  _getPeriodoLibros() {
    const stateFile = path.join(this.debugDir, 'periodo-libros.json');
    
    // Cargar estado existente o crear nuevo
    let state = { periodo: null, lastRun: null };
    try {
      if (fs.existsSync(stateFile)) {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      }
    } catch (e) {
      // Usar default
    }
    
    // Si no hay período guardado, usar el mes anterior al actual
    if (!state.periodo) {
      const now = new Date();
      let year = now.getFullYear();
      let month = now.getMonth(); // 0-indexed, así que es el mes anterior
      
      if (month < 1) {
        month = 12;
        year -= 1;
      }
      
      state.periodo = `${year}-${String(month).padStart(2, '0')}`;
    }
    
    return state.periodo;
  }

  /**
   * Decrementa el período de libros (llamar cuando falla con LNC)
   * @returns {string} Nuevo período
   */
  _decrementarPeriodoLibros() {
    const stateFile = path.join(this.debugDir, 'periodo-libros.json');
    const currentPeriodo = this._getPeriodoLibros();
    
    const [year, month] = currentPeriodo.split('-').map(Number);
    let newMonth = month - 1;
    let newYear = year;
    
    if (newMonth < 1) {
      newMonth = 12;
      newYear -= 1;
    }
    
    const newPeriodo = `${newYear}-${String(newMonth).padStart(2, '0')}`;
    
    const state = {
      periodo: newPeriodo,
      lastRun: new Date().toISOString(),
      previousPeriodo: currentPeriodo,
    };
    
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`   📅 Período decrementado: ${currentPeriodo} → ${newPeriodo}`);
    } catch (e) {
      console.warn(`   ⚠️ No se pudo guardar período: ${e.message}`);
    }
    
    return newPeriodo;
  }

  /**
   * Resetea el período de libros a un valor específico
   * @param {string} periodo - Período en formato YYYY-MM
   */
  resetPeriodoLibros(periodo) {
    const stateFile = path.join(this.debugDir, 'periodo-libros.json');
    const state = { periodo, lastRun: new Date().toISOString() };
    
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`   📅 Período reseteado a: ${periodo}`);
    } catch (e) {
      console.warn(`   ⚠️ No se pudo guardar período: ${e.message}`);
    }
  }

  /**
   * Crea un enviador de libros
   * @private
   */
  _createLibroEnviador() {
    return new EnviadorSII(this.certificado, this.ambiente);
  }

  /**
   * Ejecuta el Libro de Ventas
   * @param {Object} [options] - Opciones
   * @param {Object} [options.setBasicoResult] - Resultado del SetBasico (usa this.resultados.basico si no se pasa)
   * @param {string} [options.signoNC='POSITIVO'] - Signo para NC
   * @returns {Promise<Object>} Resultado con trackId
   */
  async ejecutarLibroVentas(options = {}) {
    const setBasicoResult = options.setBasicoResult || this.resultados.basico;
    
    if (!setBasicoResult?.documentos) {
      throw new Error('No hay resultado del SetBasico. Ejecutar ejecutarSetBasico() primero.');
    }

    // IMPORTANTE: Decrementar período ANTES de usar para evitar "LNC - Libro Cerrado"
    this._decrementarPeriodoLibros();
    const periodo = this._getPeriodoLibros();
    console.log(`   📚 Generando Libro de Ventas para período ${periodo}...`);

    const libroVentas = new LibroVentas({
      emisor: this.config.emisor,
      receptor: this.config.receptor,
      periodo,
      certificado: this.certificado,
      signoNC: options.signoNC || 'POSITIVO',
    });

    const { libro, xml, detalle, resumen } = libroVentas.generar(setBasicoResult);

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-ventas.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`   XML guardado: ${outPath}`);

    // Enviar al SII
    const enviador = this._createLibroEnviador();
    const resultado = await enviador.enviarLibro(libro, 'LibroCV.xml');

    const result = {
      success: !!resultado?.trackId,
      trackId: resultado?.trackId,
      error: resultado?.error,
      periodo,
      totalDetalle: detalle.length,
    };

    this.resultados.libroVentas = result;
    
    if (result.success) {
      console.log(`   ✅ Libro de Ventas enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(`   ❌ Error enviando Libro de Ventas: ${result.error}`);
    }

    return result;
  }

  /**
   * Ejecuta el Libro de Compras
   * @param {Object} [options] - Opciones
   * @param {Object} [options.libroComprasData] - Datos del libro (usa this._estructuras.libroCompras si no se pasa)
   * @returns {Promise<Object>} Resultado con trackId
   */
  async ejecutarLibroCompras(options = {}) {
    const libroComprasData = options.libroComprasData || this._estructuras?.libroCompras;

    // IMPORTANTE: Decrementar período ANTES de usar para evitar "LNC - Libro Cerrado"
    this._decrementarPeriodoLibros();
    const periodo = this._getPeriodoLibros();

    const libroCompras = new LibroCompras({
      emisor: this.config.emisor,
      periodo,
      certificado: this.certificado,
    });

    if (!libroComprasData?.detalle) {
      throw new Error('No hay datos del libro de compras. El SII no entregó el set LIBRO_COMPRAS al obtener las estructuras.');
    }

    console.log(`   📚 Generando Libro de Compras para período ${periodo} (${libroComprasData.detalle.length} documentos del SII)...`);
    const { libro, xml, detalle, resumen } = libroCompras.generarDesdeEstructuras(libroComprasData, periodo);

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-compras.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`   XML guardado: ${outPath}`);

    // Enviar al SII
    const enviador = this._createLibroEnviador();
    const resultado = await enviador.enviarLibro(libro, 'LibroCV.xml');

    const result = {
      success: !!resultado?.trackId,
      trackId: resultado?.trackId,
      error: resultado?.error,
      periodo,
      totalDetalle: detalle.length,
    };

    this.resultados.libroCompras = result;
    
    if (result.success) {
      console.log(`   ✅ Libro de Compras enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(`   ❌ Error enviando Libro de Compras: ${result.error}`);
    }

    return result;
  }

  /**
   * Ejecuta el Libro de Compras para Exentos (SET15)
   * Misma lógica que ejecutarLibroCompras pero usando estructuras.libroComprasExentos
   */
  async ejecutarLibroComprasExentos(options = {}) {
    const libroData = options.libroComprasExentosData || this._estructuras?.libroComprasExentos;

    if (!libroData?.detalle) {
      throw new Error('No hay datos del libro de compras para exentos. El SII no entregó el set LIBRO_COMPRAS_EXENTOS.');
    }

    this._decrementarPeriodoLibros();
    const periodo = this._getPeriodoLibros();

    const libroCompras = new LibroCompras({
      emisor: this.config.emisor,
      periodo,
      certificado: this.certificado,
    });

    console.log(`   📚 Generando Libro de Compras para Exentos para período ${periodo} (${libroData.detalle.length} documentos del SII)...`);
    const { libro, xml, detalle } = libroCompras.generarDesdeEstructuras(libroData, periodo);

    const outPath = path.join(this.debugDir, 'libro-compras-exentos.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`   XML guardado: ${outPath}`);

    const enviador = this._createLibroEnviador();
    const resultado = await enviador.enviarLibro(libro, 'LibroCVExentos.xml');

    const result = {
      success: !!resultado?.trackId,
      trackId: resultado?.trackId,
      error: resultado?.error,
      periodo,
      totalDetalle: detalle.length,
    };

    this.resultados.libroComprasExentos = result;

    if (result.success) {
      console.log(`   ✅ Libro de Compras para Exentos enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(`   ❌ Error enviando Libro de Compras para Exentos: ${result.error}`);
    }

    return result;
  }

  /**
   * Ejecuta el Libro de Guías
   * @param {Object} [options] - Opciones
   * @param {Object} [options.setGuiaResult] - Resultado del SetGuia (usa this.resultados.guia si no se pasa)
   * @param {number} [options.folioNotificacion=3] - Folio de notificación
   * @returns {Promise<Object>} Resultado con trackId
   */
  async ejecutarLibroGuias(options = {}) {
    const setGuiaResult = options.setGuiaResult || this.resultados.guia;
    
    if (!setGuiaResult?.documentos) {
      throw new Error('No hay resultado del SetGuia. Ejecutar ejecutarSetGuia() primero.');
    }

    // IMPORTANTE: Decrementar período ANTES de usar para evitar "LNC - Libro Cerrado"
    this._decrementarPeriodoLibros();
    const periodo = this._getPeriodoLibros();
    console.log(`   📚 Generando Libro de Guías para período ${periodo}...`);

    const libroGuias = new LibroGuias({
      emisor: this.config.emisor,
      receptor: this.config.receptor,
      periodo,
      certificado: this.certificado,
      folioNotificacion: options.folioNotificacion || 3,
    });

    const { libro, xml, detalle } = libroGuias.generar(setGuiaResult, {
      casosLibro: options.casosLibro,
    });

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-guias.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`   XML guardado: ${outPath}`);

    // Enviar al SII
    const enviador = this._createLibroEnviador();
    const resultado = await enviador.enviarLibro(libro, 'LibroGuia.xml');

    const result = {
      success: !!resultado?.trackId,
      trackId: resultado?.trackId,
      error: resultado?.error,
      periodo,
      totalDetalle: detalle.length,
    };

    this.resultados.libroGuias = result;
    
    if (result.success) {
      console.log(`   ✅ Libro de Guías enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(`   ❌ Error enviando Libro de Guías: ${result.error}`);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // AVANZAR SIGUIENTE PASO (Fase 5)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Avanza al siguiente paso de certificación cuando todos los ítems están REVISADO CONFORME
   * @returns {Promise<Object>} Resultado del avance
   */
  async avanzarSiguientePaso() {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 AVANZAR SIGUIENTE PASO');
    console.log('═'.repeat(60) + '\n');

    try {
      console.log('   📋 Enviando solicitud de avance...');
      const result = await this.siiCert.avanzarSiguientePaso();

      if (result.rawHtml) {
        fs.writeFileSync(
          path.join(this.debugDir, 'avanzar-siguiente-paso-response.html'),
          result.rawHtml,
          'utf8'
        );
        console.log(`   📄 Respuesta guardada en: ${path.join(this.debugDir, 'avanzar-siguiente-paso-response.html')}`);
      }

      if (result.success) {
        console.log('   ✅ Avance al siguiente paso exitoso');
        this.resultados.avanceSiguientePaso = { success: true };
      } else {
        console.log(`   ❌ Error en avance: ${result.error || 'Error desconocido'}`);
        this.resultados.avanceSiguientePaso = { success: false, error: result.error };
      }

      return result;
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      this.resultados.avanceSiguientePaso = { success: false, error: error.message };
      return { success: false, error: error.message };
    }
  }

  /**
   * Espera a que los libros sean aprobados y luego avanza al siguiente paso
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado del avance
   */
  async esperarLibrosYAvanzar(options = {}) {
    const { maxIntentos = 30, intervalo = 10000 } = options;

    console.log('\n⏳ Esperando aprobación de libros...');

    for (let i = 1; i <= maxIntentos; i++) {
      console.log(`\n   🔄 Intento ${i}/${maxIntentos}...`);
      
      const avance = await this.siiCert.verAvanceParsed();
      
      if (!avance.success) {
        console.log(`   ⚠️ Error consultando avance: ${avance.error}`);
        await sleep(intervalo);
        continue;
      }

      const libros = ['LIBRO DE VENTAS', 'LIBRO DE COMPRAS', 'LIBRO DE GUIAS'];
      const estados = avance.sets || [];
      
      let todosAprobados = true;
      let hayRechazados = false;

      for (const libro of libros) {
        const estado = estados.find(s => s.nombre?.toUpperCase().includes(libro.replace('DE ', '')));
        if (!estado) continue;
        
        const esAprobado = estado.estado?.toUpperCase().includes('REVISADO CONFORME');
        const esRechazado = estado.estado?.toUpperCase().includes('RECHAZADO') || 
                           estado.estado?.toUpperCase().includes('REPARO');
        
        if (esAprobado) {
          console.log(`      ✅ ${libro}: REVISADO CONFORME`);
        } else if (esRechazado) {
          console.log(`      ❌ ${libro}: ${estado.estado}`);
          hayRechazados = true;
        } else {
          console.log(`      🔄 ${libro}: ${estado.estado || 'EN REVISION'}`);
          todosAprobados = false;
        }
      }

      if (hayRechazados) {
        console.log('\n   ❌ Hay libros rechazados. No se puede avanzar.');
        return { success: false, error: 'Hay libros rechazados' };
      }

      if (todosAprobados) {
        console.log('\n   🎉 ¡Todos los libros aprobados!');
        return await this.avanzarSiguientePaso();
      }

      await sleep(intervalo);
    }

    console.log('\n   ⚠️ Timeout esperando aprobación de libros');
    return { success: false, error: 'Timeout esperando aprobación' };
  }

  // ═══════════════════════════════════════════════════════════════
  // SIMULACIÓN (Fase 6)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ejecuta el Set de Simulación (Fase 6)
   * Genera un envío con todos los DTEs de las estructuras
   * @param {Object} [options] - Opciones
   * @param {Object} [options.estructuras] - Estructuras (usa this._estructuras si no se pasa)
   * @returns {Promise<Object>} Resultado con trackId
   */
  async ejecutarSimulacion(options = {}) {
    const estructuras = options.estructuras || this._estructuras;
    if (!estructuras) {
      throw new Error('No hay estructuras para simulación. Ejecutar obtenerSets() primero.');
    }

    console.log('\n' + '═'.repeat(60));
    console.log('🧪 FASE 6: SIMULACIÓN');
    console.log('═'.repeat(60) + '\n');

    // Calcular CAFs necesarios
    const cafRequired = this._calcularCafsSimulacion(estructuras);
    console.log('   Solicitando CAFs para simulación...');
    
    // Solicitar CAFs frescos
    const cafs = await this.solicitarCafs(cafRequired);
    
    // Cargar objetos CAF
    const cafObjects = {};
    const { CAF } = require('../index');
    for (const [tipo, cafPath] of Object.entries(cafs)) {
      const cafXml = fs.readFileSync(cafPath, 'utf8');
      cafObjects[tipo] = new CAF(cafXml);
    }

    // Crear simulación
    const simulacion = new Simulacion({
      emisor: this.config.emisor,
      receptor: this.config.receptor,
      certificado: this.certificado,
      resolucion: {
        fecha: this.config.emisor.fch_resol,
        numero: this.config.emisor.nro_resol,
      },
    });

    // Generar
    console.log('   Generando DTEs de simulación...');
    const { envioDte, dtes, xml, plan, tiposUsados } = simulacion.generar(
      estructuras,
      cafObjects,
      this.folioHelper,
    );

    console.log(`   📦 Plan de simulación: ${plan.length} documentos`);
    console.log(`   📄 Tipos usados: ${tiposUsados.join(', ')}`);

    // Guardar XML de debug
    const runDir = path.join(this.debugDir, 'simulacion');
    fs.mkdirSync(runDir, { recursive: true });
    const outPath = path.join(runDir, 'envio-simulacion.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`   XML guardado: ${outPath}`);

    // Guardar DTEs individuales
    const dtesDir = path.join(runDir, 'dtes');
    fs.mkdirSync(dtesDir, { recursive: true });
    dtes.forEach((dteItem) => {
      const filename = `dte-${String(dteItem.tipoDte).padStart(2, '0')}-${String(dteItem.folio).padStart(6, '0')}.xml`;
      fs.writeFileSync(path.join(dtesDir, filename), dteItem.xml, 'utf8');
    });

    // Enviar al SII
    console.log('\n   📤 Enviando al SII...');
    const enviador = this._createEnviador();
    const resultado = await enviador.enviar(envioDte);

    const result = {
      success: !!resultado?.trackId,
      trackId: resultado?.trackId,
      error: resultado?.error,
      documentos: plan.length,
      tiposUsados,
    };

    this.resultados.simulacion = result;

    // Guardar info
    const infoPath = path.join(runDir, 'envio-simulacion-info.json');
    fs.writeFileSync(infoPath, JSON.stringify({
      ...result,
      dtes: dtes.map(d => ({ tipoDte: d.tipoDte, folio: d.folio })),
    }, null, 2), 'utf8');

    if (result.success) {
      console.log(`\n✅ Simulación enviada - TrackId: ${result.trackId}`);
    } else {
      console.log(`\n❌ Error en simulación: ${result.error}`);
    }

    return result;
  }

  /**
   * Calcula los CAFs necesarios para simulación
   * @private
   */
  _calcularCafsSimulacion(estructuras) {
    const cafRequired = {};
    
    const contarTipo = (tipo) => {
      cafRequired[tipo] = (cafRequired[tipo] || 0) + 1;
    };

    // Set Básico
    const sb = estructuras?.setBasico;
    if (sb) {
      (sb.casosFactura || []).forEach(() => contarTipo(33));
      (sb.casosNC || []).forEach(() => contarTipo(61));
      (sb.casosND || []).forEach(() => contarTipo(56));
    }

    // Set Exenta
    const se = estructuras?.setFacturaExenta;
    if (se) {
      (se.casosFactura || []).forEach(() => contarTipo(34));
      (se.casosNC || []).forEach(() => contarTipo(61));
      (se.casosND || []).forEach(() => contarTipo(56));
    }

    // Set Guía
    const sg = estructuras?.setGuiaDespacho;
    if (sg) {
      (sg.casos || []).forEach(() => contarTipo(52));
    }

    // Set Compra
    const sc = estructuras?.setFacturaCompra;
    if (sc) {
      if (sc.casoFactura) contarTipo(46);
      if (sc.casoNC) contarTipo(61);
      if (sc.casoND) contarTipo(56);
    }

    return cafRequired;
  }

  /**
   * Declara avance del set de simulación con reintentos automáticos
   * @param {Object} [resultadosExt] - Resultados externos
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararSimulacion(resultadosExt, options = {}) {
    const resultados = resultadosExt || this.resultados;
    const { maxIntentos = 10, intervalo = 5000 } = options;
    
    if (!resultados.simulacion?.trackId) {
      return { success: false, error: 'No hay TrackId de simulación para declarar' };
    }

    // Verificar si ya pasamos a INTERCAMBIO (simulación ya aprobada)
    console.log('   🔍 Verificando etapa actual...');
    const avance = await this.siiCert.verAvanceParsed();
    if (avance.rawHtml && /paso\s*<b>\s*INTERCAMBIO/i.test(avance.rawHtml)) {
      console.log('   ✅ Simulación ya aprobada - empresa en etapa INTERCAMBIO');
      return { success: true, skipped: true, message: 'Ya en etapa INTERCAMBIO' };
    }

    const fecha = this._getFechaHoy();
    const sets = {
      setSimulacion: {
        trackId: resultados.simulacion.trackId,
        fecha,
      },
    };

    const result = await this._declararConReintentos(sets, 'declaracion-simulacion-response', { maxIntentos, intervalo, label: 'simulación' });
    if (result?.success) console.log('   ✅ Simulación declarada exitosamente');
    return result;
  }

  /**
   * Espera a que la simulación sea aprobada
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado del polling
   */
  async esperarSimulacionAprobada(options = {}) {
    const { maxIntentos = 30, intervalo = 10000 } = options;

    console.log('\n⏳ Esperando aprobación de simulación...');

    for (let i = 1; i <= maxIntentos; i++) {
      console.log(`\n   🔄 Intento ${i}/${maxIntentos}...`);
      
      const avance = await this.siiCert.verAvanceParsed();
      
      if (!avance.success) {
        console.log(`   ⚠️ Error consultando avance: ${avance.error}`);
        await sleep(intervalo);
        continue;
      }

      // ✅ PRIMERO: Verificar si ya pasó a INTERCAMBIO (significa que simulación fue aprobada)
      if (avance.etapaActual && avance.etapaActual.includes('INTERCAMBIO')) {
        console.log(`      ✅ Etapa actual: ${avance.etapaActual}`);
        console.log('\n   🎉 ¡SIMULACIÓN APROBADA! Empresa pasó a etapa INTERCAMBIO.');
        return { success: true, etapa: 'INTERCAMBIO' };
      }

      // ✅ TAMBIÉN: Etapas que vienen DESPUÉS de INTERCAMBIO (simulación + intercambio ya completos)
      const ETAPAS_POST_INTERCAMBIO = ['DOCUMENTOS IMPRESOS', 'MUESTRAS IMPRESAS', 'BOLETA', 'AUTORIZADO', 'COMPLETADO'];
      if (avance.etapaActual && ETAPAS_POST_INTERCAMBIO.some(e => avance.etapaActual.toUpperCase().includes(e))) {
        console.log(`      📍 Etapa actual: ${avance.etapaActual}`);
        console.log('\n   🎉 ¡SIMULACIÓN + INTERCAMBIO COMPLETADOS! Empresa en etapa: ' + avance.etapaActual);
        return { success: true, etapa: avance.etapaActual, postIntercambio: true };
      }

      // ✅ SEGUNDO: Verificar indicador de formulario de confirmación (simulación aprobada pendiente confirmar)
      if (avance.simulacionAprobadaIndicador) {
        console.log(`      ✅ Formulario de confirmación detectado`);
        
        // Confirmar automáticamente la simulación
        if (this.resultados.simulacion?.trackId) {
          console.log(`\n   📝 Confirmando revisión de simulación (TrackId: ${this.resultados.simulacion.trackId})...`);
          
          const fecha = this._getFechaHoy();
          const confirmResult = await this.siiCert.declararAvance({
            sets: {
              setSimulacion: {
                trackId: this.resultados.simulacion.trackId,
                fecha,
              },
            },
          });
          
          if (confirmResult.success) {
            console.log('   ✅ Confirmación enviada exitosamente');

            // Revalidar contra SII para evitar falso positivo de confirmación
            const verificacion = await this.siiCert.verAvanceParsed();
            const estadoSim = verificacion?.estados?.setSimulacion;
            const sigueFormulario = Boolean(verificacion?.simulacionAprobadaIndicador);
            const yaIntercambio = Boolean(verificacion?.etapaActual?.includes('INTERCAMBIO'));
            const simConforme = Boolean(estadoSim?.esConforme || estadoSim?.estado?.toUpperCase()?.includes('REVISADO CONFORME'));

            if (yaIntercambio || simConforme || !sigueFormulario) {
              console.log('\n   🎉 ¡SIMULACIÓN CONFIRMADA! Certificación completa.');
              return { success: true, confirmada: true };
            }

            console.log('   ⚠️ SII aún mantiene formulario de simulación pendiente; se reintentará...');
            await sleep(intervalo);
            continue;
          } else {
            console.log(`   ⚠️ Error en confirmación: ${confirmResult.error}`);
            // Continuar el loop para reintentar
          }
        } else {
          console.log('\n   🎉 ¡SIMULACIÓN APROBADA! Lista para confirmar revisión.');
          return { success: true, pendienteConfirmar: true };
        }
      }

      // Buscar estado de simulación en los estados parseados
      const estados = avance.estados || {};
      const simKey = Object.keys(estados).find(k => 
        k.toLowerCase().includes('simulacion') || 
        estados[k]?.nombre?.toUpperCase().includes('SIMULACION') ||
        estados[k]?.nombre?.toUpperCase().includes('SIMULACIÓN')
      );

      if (simKey && estados[simKey]) {
        const simEstado = estados[simKey];
        const esAprobado = simEstado.esConforme || simEstado.estado?.toUpperCase().includes('REVISADO CONFORME');
        const esRechazado = simEstado.esRechazado || 
                           simEstado.estado?.toUpperCase().includes('RECHAZADO') || 
                           simEstado.estado?.toUpperCase().includes('REPARO');
        
        if (esAprobado) {
          console.log(`      ✅ SIMULACIÓN: REVISADO CONFORME`);
          console.log('\n   🎉 ¡SIMULACIÓN APROBADA! Certificación completa.');
          return { success: true };
        } else if (esRechazado) {
          console.log(`      ❌ SIMULACIÓN: ${simEstado.estado}`);
          return { success: false, error: 'Simulación rechazada' };
        } else {
          console.log(`      🔄 SIMULACIÓN: ${simEstado.estado || 'EN REVISION'}`);
        }
      } else {
        // No hay estado de simulación, pero verificar etapa actual
        if (avance.etapaActual) {
          console.log(`      📍 Etapa actual: ${avance.etapaActual}`);
        } else {
          console.log('      ⏳ Simulación aún no registrada...');
        }
      }

      await sleep(intervalo);
    }

    console.log('\n   ⚠️ Timeout esperando aprobación de simulación');
    return { success: false, error: 'Timeout esperando aprobación' };
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers privados
  // ═══════════════════════════════════════════════════════════════

  _getFechaHoy() {
    const now = new Date();
    return `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // FASE 7: INTERCAMBIO DE INFORMACIÓN
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ejecuta el proceso completo de intercambio de información DTE.
   * 1. Descarga el SET de intercambio desde www4.sii.cl/pfeInternet (auto o manual)
   * 2. Genera los 3 XMLs de respuesta firmados
   * 3. Sube las respuestas al portal
   * @param {Object} [options]
   * @param {string} [options.inputPath] - Ruta manual al XML del SET de intercambio
   * @returns {Promise<Object>}
   */
  async ejecutarFase7Intercambio(options = {}) {
    const intercambioDir = path.join(this.debugDir, 'intercambio');
    fs.mkdirSync(intercambioDir, { recursive: true });

    console.log('\n' + '═'.repeat(60));
    console.log('📬 FASE 7: INTERCAMBIO DE INFORMACIÓN');
    console.log('═'.repeat(60));

    // ── PASO 1: Obtener el SET XML ─────────────────────────────
    const setInputPath = options.inputPath ||
      path.join(intercambioDir, 'set-intercambio.xml');

    let setXml = null;

    // Ruta persistente donde siempre guardamos el XML (independiente de options.inputPath)
    const setDownloadPath = path.join(intercambioDir, 'set-intercambio.xml');

    if (setInputPath && fs.existsSync(setInputPath)) {
      console.log(`\n📂 Leyendo SET desde: ${setInputPath}`);
      setXml = fs.readFileSync(setInputPath, 'utf8');
      console.log(`   ✓ ${setXml.length} bytes`);
    } else if (fs.existsSync(setDownloadPath)) {
      console.log(`\n📂 Leyendo SET guardado: ${setDownloadPath}`);
      setXml = fs.readFileSync(setDownloadPath, 'utf8');
      console.log(`   ✓ ${setXml.length} bytes`);
    } else {
      console.log('\n📡 Descargando SET desde www4.sii.cl/pfeInternet...');
      const dl = await this._descargarSetPfeInternet(intercambioDir);
      if (dl.success) {
        setXml = dl.xml;
        fs.writeFileSync(setDownloadPath, setXml, 'utf8');
        console.log(`   ✅ SET descargado (${setXml.length} bytes) → ${setDownloadPath}`);
      } else {
        console.log(`   ⚠️  No se pudo descargar: ${dl.error}`);
        console.log('\n' + '─'.repeat(60));
        console.log('📋 DESCARGA MANUAL REQUERIDA:');
        console.log('   1. Si aparece error de sesiones: ingresa a https://www4.sii.cl/ → Cerrar Sesión');
        console.log('   2. Ir a: https://www4.sii.cl/pfeInternet/ y descargar el SET XML');
        console.log(`   3. Guardarlo en: ${setDownloadPath}`);
        console.log('   4. Volver a ejecutar el runner');
        console.log('─'.repeat(60));
        return { success: false, error: 'SET no disponible - descarga manual requerida', requiresManual: true, manualPath: setInputPath };
      }
    }

    // ── PASO 2: Generar XMLs de respuesta ─────────────────────
    console.log('\n📝 Generando respuestas firmadas...');
    const intercambioCert = new IntercambioCert({
      certificado: this.certificado,
      emisor: {
        rut: this.config.emisor.rut,
        razonSocial: this.config.emisor.razon_social || this.config.emisor.razonSocial || '',
      },
      contacto: this.config.contacto || {},
      debugDir: intercambioDir,
    });

    const genResult = await intercambioCert.generarIntercambio(setXml, { outDir: intercambioDir });
    if (!genResult.success) {
      return { success: false, error: genResult.error || 'Error generando XMLs' };
    }

    // ── PASO 3: Subir respuestas ───────────────────────────────
    console.log('\n📤 Subiendo respuestas a www4.sii.cl/pfeInternet...');
    const uploadResult = await this._subirRespuestasPfeInternet({
      recepcionXml:  fs.readFileSync(genResult.files.recepcion, 'utf8'),
      aprobacionXml: fs.readFileSync(genResult.files.aprobacion, 'utf8'),
      recibosXml:    fs.readFileSync(genResult.files.recibos, 'utf8'),
      debugDir: intercambioDir,
    });

    if (uploadResult.success) {
      console.log('\n' + '═'.repeat(60));
      console.log('✅ INTERCAMBIO COMPLETADO');
      console.log('═'.repeat(60));
      if (uploadResult.resultado) console.log(`   Resultado SII: ${uploadResult.resultado}`);
    } else {
      console.log(`   ⚠️  No se pudo subir automáticamente: ${uploadResult.error}`);
      console.log('\n' + '─'.repeat(60));
      console.log('📋 SUBIDA MANUAL REQUERIDA:');
      console.log('   1. Ir a: https://www4.sii.cl/pfeInternet/ → "Subir archivos"');
      console.log(`   2. Subir: ${genResult.files.recepcion}`);
      console.log(`   3. Subir: ${genResult.files.aprobacion}`);
      console.log(`   4. Subir: ${genResult.files.recibos}`);
      console.log('─'.repeat(60));
    }

    return {
      success: true,
      files: genResult.files,
      meta: genResult.meta,
      uploaded: uploadResult.success,
      requiresManual: !uploadResult.success,
    };
  }

  /**
   * Obtiene el cookieJar de sesión SII reutilizando caché en memoria primero,
   * luego caché en disco (TTL 25 min) gestionada por SiiPortalAuth.
   * Evita crear múltiples sesiones simultáneas (el SII limita a ~3).
   * @private
   * @returns {Promise<Object>} cookieJar con cookies NETSCAPE_LIVEWIRE.*
   */
  async _obtenerCookiesSII() {
    if (this._siiCookieJar) {
      console.log('[SII Auth] ♻️  Reutilizando sesión SII en memoria');
      return this._siiCookieJar;
    }
    const SiiPortalAuth = require('../SiiPortalAuth');
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const password  = this.config.certificado.password;
    const siiAuth   = new SiiPortalAuth({ pfxBuffer, pfxPassword: password });
    this._siiCookieJar = await siiAuth.autenticar();
    const nSession = Object.keys(this._siiCookieJar).filter(k => k.startsWith('NETSCAPE')).length;
    console.log(`[SII Auth] ✅ Sesión SII activa (cookies NETSCAPE: ${nSession})`);
    return this._siiCookieJar;
  }

  /**
   * Autentica contra pfeInternet reutilizando la sesión cacheada por SiiPortalAuth.
   * Tras obtener las cookies, hace un GET inicial a www4.sii.cl/pfeInternet/ para
   * inicializar el contexto del portal GWT del lado del servidor (igual que el browser).
   * @private
   */
  async _autenticarPfeInternet() {
    const https  = require('https');
    const crypto = require('crypto');
    const { URL } = require('url');

    const tlsOpts = {
      rejectUnauthorized: false,
      maxVersion: 'TLSv1.2',
      secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                   | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };

    // makeReq: helper HTTP para requests pfeInternet — solo lleva las cookies, no hace auth
    const makeReq = (urlStr, { method = 'GET', body = null, headers = {}, cookies: reqCookies = '' }) =>
      new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const agent = new https.Agent(tlsOpts);
        const opts = {
          hostname: u.hostname, port: u.port || 443,
          path: u.pathname + u.search, method, agent,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Connection': 'keep-alive',
            ...(reqCookies ? { 'Cookie': reqCookies } : {}),
            ...headers,
          },
        };
        if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
        const req = https.request(opts, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });

    const collectNewCookies = (headers, existing) => {
      const merged = {};
      existing.split(';').forEach(c => { const [k, v] = c.trim().split('='); if (k) merged[k.trim()] = (v||'').trim(); });
      for (const c of (headers['set-cookie'] || [])) {
        const [kv] = c.split(';');
        const eq = kv.indexOf('=');
        if (eq > 0) merged[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
      return Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ');
    };

    // Reutiliza sesión en memoria o disco via _obtenerCookiesSII()
    const cookieJar = await this._obtenerCookiesSII();
    let cookies     = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');  

    // Warm-up: visitar www4.sii.cl/pfeInternet/ para inicializar contexto del portal GWT
    // en el servidor, exactamente como haría el browser al navegar a la página.
    try {
      const warmup = await makeReq('https://www4.sii.cl/pfeInternet/', { cookies });
      cookies = collectNewCookies(warmup.headers, cookies);
      // Si redirige (302), seguir el redirect una vez más
      if ((warmup.status === 301 || warmup.status === 302) && warmup.headers?.location) {
        const loc = warmup.headers.location;
        const absLoc = loc.startsWith('http') ? loc : `https://www4.sii.cl${loc}`;
        const warmup2 = await makeReq(absLoc, { cookies });
        cookies = collectNewCookies(warmup2.headers, cookies);
      }
      console.log(`[pfeInternet Auth] warm-up → HTTP ${warmup.status}`);
    } catch (e) {
      console.log(`[pfeInternet Auth] warm-up falló (no crítico): ${e.message}`);
    }

    return { cookies, makeReq };
  }

  /**
   * Descarga el SET de intercambio desde www4.sii.cl/pfeInternet
   * @private
   */
  async _descargarSetPfeInternet(debugDir) {
    try {
      const { cookies, makeReq } = await this._autenticarPfeInternet();
      const [rutNum, dv] = this.config.emisor.rut.split('-');

      // Endpoint real capturado via F12:
      // POST https://www4.sii.cl/pfeInternet/downloadFile?re={rutSinDv}&dve={dv}
      // Body: multipart vacío (solo el closing boundary, sin campos de formulario)
      const boundary = `----WebKitFormBoundary${Date.now()}`;
      const emptyMultipartBody = `--${boundary}--\r\n`;

      console.log(`   → Descargando SET desde pfeInternet/downloadFile (RUT ${rutNum}-${dv})...`);

      const r = await makeReq(
        `https://www4.sii.cl/pfeInternet/downloadFile?re=${rutNum}&dve=${dv}`,
        {
          method: 'POST',
          body: emptyMultipartBody,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Referer': 'https://www4.sii.cl/pfeInternet/',
            'Origin': 'https://www4.sii.cl',
          },
          cookies,
        }
      );

      // Guardar respuesta raw para debugging
      fs.writeFileSync(path.join(debugDir, `pfe-download-${Date.now()}.xml`), r.body, 'utf8');

      if (r.status === 200 && (
        r.body.includes('<EnvioDTE') ||
        r.body.includes('<SetDTE') ||
        r.body.includes('<?xml')
      )) {
        console.log(`   ✓ SET descargado correctamente (${r.body.length} bytes)`);
        return { success: true, xml: r.body };
      }

      const errMsg = `pfeInternet/downloadFile respondió HTTP ${r.status} sin XML válido`;
      console.log(`   ✗ ${errMsg}`);
      fs.writeFileSync(path.join(debugDir, `pfe-download-error-${Date.now()}.html`), r.body, 'utf8');
      return { success: false, error: errMsg };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Sube las 3 respuestas de intercambio a www4.sii.cl/pfeInternet usando Puppeteer.
   * El portal GWT requiere que el JavaScript inicialice la sesión antes de aceptar uploads.
   * Con Puppeteer el browser real ejecuta el JS del portal y los uploads quedan registrados.
   * @private
   */
  async _subirRespuestasPfeInternet({ recepcionXml, aprobacionXml, recibosXml, debugDir }) {
    const puppeteer = require('puppeteer');
    const os = require('os');

    // Guardar XMLs en archivos temporales para que Puppeteer pueda subirlos
    const tmpDir = debugDir || path.join(os.tmpdir(), 'pfe-intercambio');
    fs.mkdirSync(tmpDir, { recursive: true });
    // Los labels deben coincidir con el texto del portal GWT (Archivo N: ...)
    const archivos = [
      { label: 'Respuesta de Intercambio',                         filename: 'respuesta-recepcion-envio.xml',     content: recepcionXml,  uploadN: 1 },
      { label: 'Recibo de Mercaderias',                            filename: 'envio-recibos.xml',                  content: recibosXml,    uploadN: 2 },
      { label: 'Resultado Aprobaci\u00f3n Comercial de Documento', filename: 'respuesta-aprobacion-comercial.xml', content: aprobacionXml, uploadN: 3 },
    ];
    for (const a of archivos) {
      fs.writeFileSync(path.join(tmpDir, a.filename), a.content, 'utf8');
    }

    // Obtener cookies de sesión SII (reutiliza caché en memoria/disco)
    const cookieJar = await this._obtenerCookiesSII();

    // Convertir cookieJar a formato Puppeteer para dominio .sii.cl
    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });

      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);

      // Navegar al portal pfeInternet
      console.log('   → Cargando portal pfeInternet...');
      await page.goto('https://www4.sii.cl/pfeInternet/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Dar 3 segundos extra para que GWT renderice el menú inicial
      await new Promise(r => setTimeout(r, 3000));

      // Hacer click en el enlace "Subir archivos XML de respuesta de Intercambio"
      // El href es javascript:openForm('opt-ingresoEmpresaUp') — necesita click real para GWT
      console.log('   → Clickeando "Subir archivos XML de respuesta de Intercambio"...');
      const linkClicked = await page.click('a[href*="ingresoEmpresaUp"]').then(() => true).catch(() => false);
      if (!linkClicked) {
        // Fallback: evaluar click con dispatchEvent
        await page.evaluate(() => {
          const link = document.querySelector('a[href*="ingresoEmpresaUp"]');
          if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
      }

      // Esperar a que GWT complete el RPC y re-renderice la vista de upload
      await page.waitForNetworkIdle({ timeout: 15000, idleTime: 1000 }).catch(() => {});

      // === PASO INTERMEDIO: ingresar RUT y confirmar empresa ===
      // GWT muestra "Ingrese el RUT de la empresa" antes de mostrar el formulario de upload
      const rutInput = await page.$('input.gwt-TextBox[maxlength="10"]');
      if (rutInput) {
        const [rutNum, dv] = this.config.emisor.rut.split('-');
        const rutConDv = `${rutNum}-${dv}`;
        console.log(`   → Ingresando RUT empresa: ${rutConDv}`);
        await rutInput.click({ clickCount: 3 }); // seleccionar todo
        await rutInput.type(rutConDv);

        // Click en "Confirmar Empresa"
        const confirmBtn = await page.evaluateHandle(() => {
          return Array.from(document.querySelectorAll('button.gwt-Button'))
            .find(b => b.textContent.trim() === 'Confirmar Empresa');
        });
        if (confirmBtn) {
          await confirmBtn.asElement().click();
          console.log('   → Click "Confirmar Empresa", esperando formulario de upload...');
          await page.waitForNetworkIdle({ timeout: 15000, idleTime: 1000 }).catch(() => {});
        }
      }

      // Esperar que GWT renderice el formulario con los 3 inputs de upload
      const inputFound = await page.waitForSelector('input[name="uploadFormElement"]', { timeout: 30000 }).catch(() => null);
      if (!inputFound) {
        if (debugDir) {
          await page.screenshot({ path: path.join(debugDir, 'pfeInternet-error.png'), fullPage: true }).catch(() => {});
          fs.writeFileSync(path.join(debugDir, 'pfeInternet-error.html'), await page.content().catch(() => ''), 'utf8');
        }
        const pageText = await page.$eval('body', el => el.textContent).catch(() => '');
        if (pageText.includes('DOCUMENTOS IMPRESOS') || pageText.includes('fue cargado exitosamente')) {
          throw new Error('PASO_YA_COMPLETADO');
        }
        throw new Error('pfeInternet no mostró formulario de upload tras openForm — ver pfeInternet-error.png/.html');
      }
      console.log('   → Formulario de upload listo');

      // ── DEBUG: screenshot del formulario con los inputs listos ──
      if (debugDir) {
        await page.screenshot({ path: path.join(debugDir, 'pfeInternet-form-listo.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(debugDir, 'pfeInternet-form-listo.html'), await page.content().catch(() => ''), 'utf8');
      }

      // Subir cada archivo en secuencia.
      // GWT mantiene solo los inputs de archivos pendientes: "procesado con exito anteriormente"
      // reemplaza al input. Así que iteramos solo los archivos pendientes en orden.
      for (const archivo of archivos) {
        const filePath = path.join(tmpDir, archivo.filename);

        // Asegurarse de que no haya diálogo abierto del upload anterior
        await page.waitForFunction(
          () => !document.querySelector('.gwt-DialogBox'),
          { timeout: 10000 }
        ).catch(() => {});

        // Verificar si este archivo ya fue procesado (GWT reemplaza el input con texto)
        // Estructura DOM: <td class="filter-label">Archivo N: Label</td> en una <tr>
        // La siguiente <tr> tiene <td class="filter-widget"> con el input O el texto "procesado"
        const yaProcessado = await page.evaluate((labelText) => {
          const allTds = Array.from(document.querySelectorAll('td.filter-label'));
          const labelTd = allTds.find(el => el.textContent.includes(labelText));
          if (!labelTd) return false;
          // Subir al <tr> padre y tomar el siguiente <tr>
          const tr = labelTd.closest('tr');
          if (!tr) return false;
          const nextTr = tr.nextElementSibling;
          if (!nextTr) return false;
          return nextTr.textContent.includes('procesado con exito anteriormente');
        }, archivo.label);

        if (yaProcessado) {
          console.log(`   → ${archivo.filename}: ya procesado anteriormente, saltando...`);
          continue;
        }

        console.log(`   → Subiendo ${archivo.filename}...`);

        // Cada archivo tiene su propio form con action uploadFile1/2/3
        // Usamos el selector específico para no confundir entre los 3 inputs que pueden
        // estar presentes simultáneamente en el DOM
        const formSel = `form[action*="uploadFile${archivo.uploadN}"]`;
        await page.waitForSelector(`${formSel} input[name="uploadFormElement"]`, { timeout: 15000 });

        const input = await page.$(`${formSel} input[name="uploadFormElement"]`);
        if (!input) throw new Error(`No se encontró input uploadFile${archivo.uploadN}`);
        await input.uploadFile(filePath);

        const submitBtn = await page.$(`${formSel} button.button-little`);
        if (!submitBtn) throw new Error(`No se encontró botón Subir para uploadFile${archivo.uploadN}`);
        await submitBtn.click();

        // Esperar el diálogo GWT de confirmación
        await page.waitForSelector('.gwt-DialogBox .msgeDialogBox', { timeout: 30000 });
        const msgText = await page.$eval('.gwt-DialogBox .msgeDialogBox', el => el.textContent.trim());
        console.log(`      ✓ ${msgText}`);

        if (debugDir) {
          fs.writeFileSync(
            path.join(debugDir, `upload-resp-${archivo.filename}.txt`),
            `Puppeteer: ${msgText}`, 'utf8'
          );
        }

        if (msgText.toLowerCase().includes('error') || msgText.toLowerCase().includes('rechaz')) {
          throw new Error(`Error en archivo ${archivo.filename}: ${msgText}`);
        }

        // Cerrar el diálogo usando el botón "Cerrar" dentro del gwt-DialogBox
        await page.evaluate(() => {
          const dlg = document.querySelector('.gwt-DialogBox');
          if (!dlg) return;
          const btn = Array.from(dlg.querySelectorAll('button')).find(
            b => b.textContent.trim() === 'Cerrar'
          );
          if (btn) btn.click();
        });

        // Esperar que el diálogo desaparezca antes del siguiente archivo
        await page.waitForFunction(
          () => !document.querySelector('.gwt-DialogBox'),
          { timeout: 10000 }
        ).catch(() => {});

        // Esperar que GWT termine de actualizar el estado (RPC post-upload)
        await page.waitForNetworkIdle({ timeout: 10000, idleTime: 500 }).catch(() => {});
      }

      return { success: true, resultado: 'Los 3 archivos subidos y registrados correctamente' };

    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browser) await browser.close();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FASE 8: MUESTRAS IMPRESAS — subir PDFs a pe_avance5
  // ═══════════════════════════════════════════════════════════════

  /**
   * Consulta el estado actual del portal pdfdteInternet sin subir nada.
   * Útil para saltarse la generación de PDFs si ya están enviados.
   * @returns {Promise<{estado: string|null, error?: string}>}
   */
  async verificarEstadoPortalMuestras() {
    const puppeteer = require('puppeteer');
    const cookieJar = await this._obtenerCookiesSII();
    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));
    const [rutNum, dvChar] = this.config.emisor.rut.split('-');
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });
      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);
      await page.goto('https://www4.sii.cl/pdfdteInternet/', { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));

      const rutInputs = await page.$$('input[name="rut"]');
      const dvInputs  = await page.$$('input[name="dv"]');
      if (!rutInputs.length) return { estado: null, error: 'sin campos RUT (¿sesión expirada?)' };

      // Solo RUT empresa → "Rut": el portal ya muestra "Estado de la Revisión" en el DOM
      await rutInputs[0].click({ clickCount: 3 }); await rutInputs[0].type(rutNum);
      await dvInputs[0].click({ clickCount: 3 });  await dvInputs[0].type(dvChar);
      await page.evaluate((t) => {
        const btn = Array.from(document.querySelectorAll('button.x-btn-text'))
          .find(b => b.textContent.trim() === t && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        if (btn) btn.click();
      }, 'Rut');

      // Descartar diálogo "ya existe revisión" si aparece
      await new Promise(r => setTimeout(r, 1500));
      await page.evaluate(() => {
        const si = Array.from(document.querySelectorAll('button.x-btn-text'))
          .find(b => /^s[ií]$/i.test(b.textContent.trim()));
        if (si) si.click();
      }).catch(() => {});

      // Esperar hasta 8s a que aparezca el estado en el DOM
      await page.waitForFunction(() => {
        const t = (document.body.textContent || '').toUpperCase();
        return t.includes('ESTADO DE LA REVISI') ||
               t.includes('POR REVISAR') || t.includes('APROBADO') ||
               t.includes('EN REVISI')   || t.includes('RECHAZADO');
      }, { timeout: 8000, polling: 500 }).catch(() => {});

      const estado = await page.evaluate(() => {
        const t = (document.body.textContent || '').toUpperCase();
        if (t.includes('APROBADO'))        return 'APROBADO';
        if (t.includes('POR REVISAR'))     return 'POR REVISAR';
        if (t.includes('EN REVISI'))       return 'EN REVISIÓN';
        if (t.includes('RECHAZADO'))       return 'RECHAZADO';
        if (t.includes('ENVIADO AL SII'))  return 'ENVIADO AL SII';
        return null;
      }).catch(() => null);

      return { estado };
    } catch (err) {
      return { estado: null, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Sube los PDFs de muestras impresas al portal pe_avance5 via Puppeteer.
   * @param {Object} opts
   * @param {string} opts.pdfDir - Directorio con los PDFs generados
   * @returns {Promise<Object>} { success, error? }
   */
  async ejecutarFase8Muestras({ pdfDir }) {
    const _collectPdfs = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).flatMap(f => {
        const full = path.join(dir, f);
        return fs.statSync(full).isDirectory() ? _collectPdfs(full) : f.endsWith('.pdf') ? [full] : [];
      });
    };
    const pdfPaths = _collectPdfs(pdfDir);

    if (!pdfPaths.length) throw new Error(`No se encontraron PDFs en: ${pdfDir}`);

    console.log('\n' + '═'.repeat(60));
    console.log(`📄 FASE 8: MUESTRAS IMPRESAS (${pdfPaths.length} PDFs)`);
    console.log('═'.repeat(60));

    return this._subirMuestrasImpresasPortal({ pdfPaths, debugDir: pdfDir });
  }

  /**
   * Sube PDFs al portal https://www4.sii.cl/pdfdteInternet/ via Puppeteer.
   * El portal usa ExtJS 3 — botones buscados por texto, no por ID dinámico.
   * @private
   */
  async _subirMuestrasImpresasPortal({ pdfPaths, debugDir }) {
    const puppeteer = require('puppeteer');

    // Reutiliza sesión SII en memoria/disco (misma sesión que intercambio u otros pasos)
    const cookieJar = await this._obtenerCookiesSII();
    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));

    const [rutNum, dvChar] = this.config.emisor.rut.split('-');

    // Helper: click botón ExtJS por texto
    const clickBoton = (page, texto) => page.evaluate((t) => {
      const btn = Array.from(document.querySelectorAll('button.x-btn-text'))
        .find(b => b.textContent.trim() === t && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (btn) { btn.click(); return true; }
      return false;
    }, texto);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });
      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);

      // Navegar directamente a www4.sii.cl/pdfdteInternet/ con las cookies de sesión SII
      console.log('   → Cargando portal pdfdteInternet...');
      await page.goto('https://www4.sii.cl/pdfdteInternet/', {
        waitUntil: 'networkidle2', timeout: 60000,
      });
      await new Promise(r => setTimeout(r, 3000));
      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-01-loaded.png'), fullPage: true }).catch(() => {});

      // Paso 1: RUT Empresa
      const rutInputs = await page.$$('input[name="rut"]');
      const dvInputs  = await page.$$('input[name="dv"]');
      if (!rutInputs.length) {
        if (debugDir) {
          await page.screenshot({ path: path.join(debugDir, 'pdfte-error-no-rut.png'), fullPage: true }).catch(() => {});
          fs.writeFileSync(path.join(debugDir, 'pdfte-error.html'), await page.content(), 'utf8');
        }
        throw new Error('pdfdteInternet: no se encontraron campos de RUT (¿sesión expirada?)');
      }
      console.log(`   → Ingresando RUT empresa: ${rutNum}-${dvChar}`);
      await rutInputs[0].click({ clickCount: 3 }); await rutInputs[0].type(rutNum);
      await dvInputs[0].click({ clickCount: 3 });  await dvInputs[0].type(dvChar);
      await clickBoton(page, 'Rut');
      await new Promise(r => setTimeout(r, 2500));
      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-02-after-rut.png'), fullPage: true }).catch(() => {});

      // Paso 2: Diálogo "ya existe revisión" → click "Sí"
      const hayDialog = await page.evaluate(() => {
        const dlg = document.querySelector('.x-window');
        return !!(dlg && dlg.offsetParent !== null);
      });
      if (hayDialog) {
        console.log('   → Diálogo de revisión existente → haciendo click en "Sí"');
        const clicked = await page.evaluate(() => {
          const si = Array.from(document.querySelectorAll('button.x-btn-text'))
            .find(b => /^s[ií]$/i.test(b.textContent.trim()));
          if (si) { si.click(); return true; }
          return false;
        });
        if (!clicked) await page.evaluate(() => { const b = document.querySelector('.x-window button'); if (b) b.click(); });
        await new Promise(r => setTimeout(r, 2500));
      }

      // Paso 3: RUT Proveedor (mismo RUT empresa)
      await page.waitForFunction(() => {
        const ins = document.querySelectorAll('input[name="rut"]');
        return ins.length >= 2 && !ins[1].disabled;
      }, { timeout: 15000 }).catch(() => {});

      const rutNow = await page.$$('input[name="rut"]');
      const dvNow  = await page.$$('input[name="dv"]');
      const pRut = rutNow.length >= 2 ? rutNow[1] : rutNow[0];
      const pDv  = dvNow.length  >= 2 ? dvNow[1]  : dvNow[0];
      console.log(`   → Ingresando RUT proveedor: ${rutNum}-${dvChar}`);
      await pRut.click({ clickCount: 3 }); await pRut.type(rutNum);
      await pDv.click({ clickCount: 3 });  await pDv.type(dvChar);
      await clickBoton(page, 'Consultar');
      await new Promise(r => setTimeout(r, 2500));
      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-03-after-consultar.png'), fullPage: true }).catch(() => {});

      // ── Re-ejecución: detectar estado terminal antes de proceder ──
      const _estadoYaSubido = await page.evaluate(() => {
        const t = (document.body.textContent || '').toUpperCase();
        if (t.includes('APROBADO'))      return 'APROBADO';
        if (t.includes('POR REVISAR'))   return 'POR REVISAR';
        if (t.includes('EN REVISI'))     return 'EN REVISIÓN';
        if (t.includes('RECHAZADO'))     return 'RECHAZADO';
        if (t.includes('ENVIADO AL SII')) return 'ENVIADO AL SII';
        return null;
      }).catch(() => null);
      if (_estadoYaSubido) {
        console.log(`   ✅ Portal ya muestra estado "${_estadoYaSubido}" — muestras subidas previamente. Proceso completado.`);
        return { success: true, alreadyCompleted: true, estado: _estadoYaSubido };
      }

      // Paso 4: "Crear" → habilita el input de archivo
      console.log('   → Click "Crear"...');
      await clickBoton(page, 'Crear');
      await new Promise(r => setTimeout(r, 2500));
      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-04-after-crear.png'), fullPage: true }).catch(() => {});

      // Paso 5: Verificar que el input de archivo existe antes de empezar
      const inputCheck = await page.waitForSelector('input.gwt-FileUpload', { timeout: 30000 }).catch(() => null);
      if (!inputCheck) {
        if (debugDir) {
          await page.screenshot({ path: path.join(debugDir, 'pdfte-error-no-fileinput.png'), fullPage: true }).catch(() => {});
          fs.writeFileSync(path.join(debugDir, 'pdfte-error.html'), await page.content(), 'utf8');
        }
        throw new Error('pdfdteInternet: no apareció el input de archivo tras "Crear"');
      }

      // El portal sólo acepta un PDF a la vez (input sin atributo "multiple").
      // Tras el submit GWT no recrea el input dentro de la misma carga de página.
      // Solución: re-navegar al portal antes de cada archivo ≥ 2 (misma revisión,
      // misma sesión con cookies); el diálogo "ya existe revisión → Sí" la abre.
      const navegarAlFormulario = async () => {
        await page.goto('https://www4.sii.cl/pdfdteInternet/', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
        const _ruts = await page.$$('input[name="rut"]');
        const _dvs  = await page.$$('input[name="dv"]');
        if (!_ruts.length) throw new Error('pdfdteInternet: sin campos RUT en re-navegación (¿sesión expirada?)');
        await _ruts[0].click({ clickCount: 3 }); await _ruts[0].type(rutNum);
        await _dvs[0].click({ clickCount: 3 });  await _dvs[0].type(dvChar);
        await clickBoton(page, 'Rut');
        await new Promise(r => setTimeout(r, 2000));
        // Diálogo "ya existe revisión" → click "Sí" para abrirla
        const _dlg = await page.evaluate(() => { const d = document.querySelector('.x-window'); return !!(d && d.offsetParent !== null); });
        if (_dlg) {
          const _ok = await page.evaluate(() => {
            const si = Array.from(document.querySelectorAll('button.x-btn-text')).find(b => /^s[ií]$/i.test(b.textContent.trim()));
            if (si) { si.click(); return true; }
            return false;
          });
          if (!_ok) await page.evaluate(() => { const b = document.querySelector('.x-window button'); if (b) b.click(); });
          await new Promise(r => setTimeout(r, 2000));
        }
        // RUT proveedor (mismo que empresa)
        await page.waitForFunction(() => { const ins = document.querySelectorAll('input[name="rut"]'); return ins.length >= 2 && !ins[1].disabled; }, { timeout: 10000 }).catch(() => {});
        const _rutsN = await page.$$('input[name="rut"]');
        const _dvsN  = await page.$$('input[name="dv"]');
        const _pRut  = _rutsN.length >= 2 ? _rutsN[1] : _rutsN[0];
        const _pDv   = _dvsN.length  >= 2 ? _dvsN[1]  : _dvsN[0];
        await _pRut.click({ clickCount: 3 }); await _pRut.type(rutNum);
        await _pDv.click({ clickCount: 3 });  await _pDv.type(dvChar);
        await clickBoton(page, 'Consultar');
        await new Promise(r => setTimeout(r, 2500));
        // Si aún no hay formulario de subida (primera vez), crear revisión
        const _hayInp = await page.$('input.gwt-FileUpload').catch(() => null);
        if (!_hayInp) { await clickBoton(page, 'Crear'); await new Promise(r => setTimeout(r, 2500)); }
      };

      // Cargar todos los PDFs como base64 en Node.js y soltarlos en el drop zone de GWT
      // de una sola vez via DataTransfer. GWT los procesa en secuencia internamente:
      //   drop → por cada file: submit form al iframe → respuesta → leeImpresoById → tick verde
      // Esto evita la re-navegación entre archivos y garantiza que la validación
      // (Timbre/CAF/TED) ocurra antes de salir de la página.
      console.log(`   → Cargando ${pdfPaths.length} PDFs para drop en el portal...`);
      const _fileDataList = pdfPaths.map(p => ({
        name: path.basename(p),
        b64:  fs.readFileSync(p).toString('base64'),
      }));

      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-04b-antes-drop.png'), fullPage: true }).catch(() => {});

      console.log(`   → Ejecutando drop de ${pdfPaths.length} PDFs sobre el portal...`);
      const _dropped = await page.evaluate((files) => {
        const dt = new DataTransfer();
        for (const f of files) {
          const bin = atob(f.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          dt.items.add(new File([arr], f.name, { type: 'application/pdf' }));
        }
        const dz = document.querySelector('.dropFilesLabel');
        if (!dz) return 0;
        dz.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        dz.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
        dz.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
        return dt.files.length;
      }, _fileDataList);

      if (_dropped === 0) throw new Error('pdfdteInternet: drop zone no encontrado (.dropFilesLabel)');
      console.log(`   → Drop ejecutado (${_dropped} archivos). Esperando procesamiento...`);

      // ── Fase 1: esperar hasta 45s por primera señal de progreso o estado terminal ──
      // Si el portal ya está en "POR REVISAR" (re-ejecución), lo detectamos aquí inmediatamente.
      // Si el drop inició normalmente, "Procesados 1" aparece en pocos segundos.
      await page.waitForFunction(() => {
        for (const el of document.querySelectorAll('.x-progress-text')) {
          const m = el.textContent.match(/Procesados\s+(\d+)/);
          if (m && +m[1] > 0) return true;
        }
        const t = (document.body.textContent || '').toUpperCase();
        if (t.includes('APROBADO') || t.includes('POR REVISAR') || t.includes('EN REVISI') || t.includes('RECHAZADO')) return true;
        return false;
      }, { timeout: 45000, polling: 1000 }).catch(() => {});

      // Leer estado real tras la fase 1
      const _fase1 = await page.evaluate(() => {
        let procesados = 0;
        for (const el of document.querySelectorAll('.x-progress-text')) {
          const m = el.textContent.match(/Procesados\s+(\d+)/);
          if (m) { procesados = +m[1]; break; }
        }
        const t = (document.body.textContent || '').toUpperCase();
        let estado = null;
        if (t.includes('APROBADO'))         estado = 'APROBADO';
        else if (t.includes('POR REVISAR')) estado = 'POR REVISAR';
        else if (t.includes('EN REVISI'))   estado = 'EN REVISIÓN';
        else if (t.includes('RECHAZADO'))   estado = 'RECHAZADO';
        return { procesados, estado };
      }).catch(() => ({ procesados: 0, estado: null }));

      if (_fase1.estado) {
        console.log(`   ✅ Portal en estado "${_fase1.estado}" — muestras ya procesadas previamente.`);
        return { success: true, alreadyCompleted: true, estado: _fase1.estado };
      }

      if (_fase1.procesados === 0) {
        // Sin progreso y sin estado terminal: el portal puede no estar procesando
        console.warn('   ⚠ Sin progreso en 45s y sin estado terminal. Continuando al paso siguiente...');
      } else {
        // ── Fase 2: progreso iniciado — esperar al total ──
        await page.waitForFunction((total) => {
          for (const el of document.querySelectorAll('.x-progress-text')) {
            const m = el.textContent.match(/Procesados\s+(\d+)/);
            if (m && +m[1] >= total) return true;
          }
          return false;
        }, { timeout: pdfPaths.length * 15000, polling: 1000 }, pdfPaths.length).catch(async () => {
          const procesados = await page.evaluate(() => {
            for (const el of document.querySelectorAll('.x-progress-text')) {
              const m = el.textContent.match(/Procesados\s+(\d+)/);
              if (m) return +m[1];
            }
            return 0;
          }).catch(() => 0);
          console.warn(`   ⚠ Timeout: solo se procesaron ${procesados}/${pdfPaths.length} antes del timeout`);
        });
      }

      // Esperar que todos los requests de leeImpresoById (validación) terminen
      await page.waitForNetworkIdle({ timeout: 60000, idleTime: 2000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-05-archivos-listos.png'), fullPage: true }).catch(() => {});

      // Paso 6: re-navegar al estado limpio y Enviar al SII
      console.log('   → Re-navegando para "Enviar al SII"...');
      await navegarAlFormulario();

      // Esperar a que el botón esté habilitado (aria-disabled="false")
      await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll('button.x-btn-text'))
          .find(b => b.textContent.trim() === 'Enviar al SII' && b.getAttribute('aria-disabled') !== 'true');
        return !!btn;
      }, { timeout: 15000 }).catch(() => {});

      if (debugDir) await page.screenshot({ path: path.join(debugDir, 'pdfte-05b-antes-enviar.png'), fullPage: true }).catch(() => {});

      console.log('   → Click "Enviar al SII"...');
      const enviado = await clickBoton(page, 'Enviar al SII');
      if (!enviado) throw new Error('pdfdteInternet: botón "Enviar al SII" no disponible o deshabilitado');

      await page.waitForNetworkIdle({ timeout: 30000, idleTime: 1000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      if (debugDir) {
        await page.screenshot({ path: path.join(debugDir, 'pdfte-06-enviado.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(debugDir, 'pdfte-06-enviado.html'), await page.content(), 'utf8');
      }

      const pageText = await page.$eval('body', el => el.textContent).catch(() => '');
      const exitoso  = /revision.*creada|solicitud.*enviada|documentos.*enviados|fue.*enviado|[eé]xito/i.test(pageText);
      console.log(`   → Resultado: ${exitoso ? '✅ enviado correctamente' : '⚠️ sin confirmación explícita'}`);
      return { success: exitoso, pageText: pageText.substring(0, 800) };

    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BOLETA ELECTRÓNICA — automatización portal certBolElectDteInternet
  // ═══════════════════════════════════════════════════════════════

  /**
   * Descarga el Set de Pruebas de Boleta Electrónica desde el portal SII.
   * Flujo real portal:
   *   1. Ingresa RUT empresa → click "Confirmar Empresa"
   *   2. Marca checkbox "SET DE BOLETA ELECTRÓNICA AFECTA"
   *   3. Rellena email proveedor
   *   4. Click "Bajar Nuevo Set" → descarga archivo .txt
   * @param {Object} opts
   * @param {string} [opts.setPath] - Ruta donde guardar el set
   * @param {string} [opts.correoSet='sii.certificacion@devlas.cl'] - Correo proveedor para el set
   * @returns {Promise<{success: boolean, setText?: string, error?: string}>}
   */
  async obtenerSetBoletaPortal({ setPath, correoSet = 'sii.certificacion@devlas.cl' } = {}) {
    const puppeteer = require('puppeteer');
    const cookieJar = await this._obtenerCookiesSII();
    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));
    const [rutNum, dvChar] = this.config.emisor.rut.split('-');

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });
      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);
      page.on('dialog', async dlg => { console.log(`   → [dialog SET=1] ${dlg.message()}`); await dlg.accept(); });

      console.log('   → Cargando portal certBolElectDteInternet (SET=1)...');
      await page.goto('https://www4.sii.cl/certBolElectDteInternet/?SET=1', {
        waitUntil: 'networkidle2', timeout: 60000,
      });
      await new Promise(r => setTimeout(r, 2000));

      // Paso 1: RUT empresa → "Confirmar Empresa"
      const rutInput = await page.$('input[maxlength="8"]');
      const dvInput  = await page.$('input[maxlength="1"]');
      if (!rutInput) throw new Error('certBolElectDteInternet/?SET=1: no se encontró campo RUT');
      console.log(`   → Ingresando RUT empresa: ${rutNum}-${dvChar}`);
      await rutInput.click({ clickCount: 3 }); await rutInput.type(rutNum);
      await dvInput.click({ clickCount: 3 });  await dvInput.type(dvChar);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /confirmar/i.test(b.textContent));
        if (btn) btn.click();
      });
      console.log('   → Click "Confirmar Empresa"');

      // Esperar checkboxes — GWT dispara ~8-10 POST /facade en paralelo
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 40000 }).catch(() => {});
      await page.waitForFunction(() => {
        return document.querySelector('input[type="checkbox"]') !== null;
      }, { timeout: 40000, polling: 500 }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      // Paso 2: Marcar todos los checkboxes
      const nCbs = await page.evaluate(() => {
        const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        cbs.forEach(cb => { if (!cb.checked) cb.click(); });
        return cbs.length;
      });
      console.log(`   → ${nCbs} checkbox(es) marcados`);
      await new Promise(r => setTimeout(r, 300));

      // Paso 3: Rellenar correo proveedor
      // El campo de email es el input visible que NO tiene maxlength pequeño
      const allInputs = await page.$$('input[type="text"].form-control');
      let emailInput = null;
      for (const inp of allInputs) {
        const ml = await page.evaluate(el => el.maxLength, inp);
        const visible = await page.evaluate(el => el.offsetParent !== null, inp);
        if (visible && (ml <= 0 || ml > 8)) { emailInput = inp; break; }
      }
      if (emailInput) {
        await emailInput.click({ clickCount: 3 });
        await emailInput.type(correoSet);
        console.log(`   → Correo proveedor: ${correoSet}`);
      } else {
        console.log('   ⚠️  No se encontró campo de correo — continuando sin él');
      }

      // Paso 4: Click "Bajar Nuevo Set" — esperar POST /facade (GWT RPC) y luego
      // construir la URL de DownloadFileServlet directamente con los parámetros conocidos.
      // La descarga real es un GET:
      //   DownloadFileServlet?rutEmpresa=X&dvEmpresa=X&rutRepre=X&dvRepre=X&mailProvSw=X
      // donde rutRepre/dvRepre vienen de las cookies NETSCAPE_LIVEWIRE.rut / .dv

      const rutRepreNum = cookieJar['NETSCAPE_LIVEWIRE.rut'] || cookieJar['RUT_NS'] || '';
      const dvRepreChar = cookieJar['NETSCAPE_LIVEWIRE.dv']  || cookieJar['DV_NS']  || '';
      if (!rutRepreNum) throw new Error('No se pudo obtener rutRepre de las cookies SII (NETSCAPE_LIVEWIRE.rut)');

      // Registrar listener de facade ANTES de hacer click
      const facadePromise = page.waitForResponse(
        resp => resp.url().includes('/certBolElectDteInternet/facade'),
        { timeout: 20000 }
      ).catch(() => null);

      console.log('   → Click "Bajar Nuevo Set" — esperando GWT facade...');
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /bajar/i.test(b.textContent));
        if (btn) btn.click();
      });

      // Esperar que el facade GWT procese la solicitud
      await facadePromise;
      await new Promise(r => setTimeout(r, 1000));

      // Construir URL de descarga e ir directo con https.get + cookies
      const https = require('https');
      const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
      const downloadUrl = `https://www4.sii.cl/certBolElectDteInternet/DownloadFileServlet` +
        `?rutEmpresa=${rutNum}&dvEmpresa=${dvChar}` +
        `&rutRepre=${rutRepreNum}&dvRepre=${dvRepreChar}` +
        `&mailProvSw=${encodeURIComponent(correoSet)}`;

      console.log(`   → Descargando set directamente: DownloadFileServlet?rutEmpresa=${rutNum}&dvEmpresa=${dvChar}&rutRepre=${rutRepreNum}&dvRepre=${dvRepreChar}&mailProvSw=${correoSet}`);

      const setText = await new Promise((resolve, reject) => {
        const req = https.get(downloadUrl, {
          headers: {
            'Cookie': cookieStr,
            'Referer': 'https://www4.sii.cl/certBolElectDteInternet/?SET=1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          rejectUnauthorized: false,
        }, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(body);
          });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout descargando DownloadFileServlet')); });
      });

      if (!setText || setText.trim().length < 10) {
        if (this.config.debugDir) {
          fs.mkdirSync(this.config.debugDir, { recursive: true });
          fs.writeFileSync(path.join(this.config.debugDir, 'boleta-set-debug.txt'), setText || '', 'utf-8');
        }
        throw new Error(`DownloadFileServlet devolvió contenido vacío (${setText?.length ?? 0} chars). Verificar cookies.`);
      }

      if (setPath) {
        const nodePath = require('path');
        fs.mkdirSync(nodePath.dirname(setPath), { recursive: true });
        fs.writeFileSync(setPath, setText, 'utf-8');
        console.log(`   ✓ Set guardado en: ${setPath}`);
      }

      console.log(`   ✓ Set de pruebas obtenido (${setText.length} chars)`);
      return { success: true, setText };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Solicita la validación del set de pruebas de Boleta Electrónica al SII (?SET=2).
   * Flujo real portal:
   *   1. Ingresa RUT empresa → click "Confirmar Empresa"
   *   2. Ingresa el TrackId del EnvioBOLETA en "Identificador de Envio"
   *   3. Click "Solicitar validación"
   * El SII procesa el set de forma asíncrona y notifica por correo (SOK/SRH).
   * @param {Object} opts
   * @param {string} opts.trackId - TrackId del EnvioBOLETA
   * @returns {Promise<{success: boolean, respuesta?: string, error?: string}>}
   */
  async solicitarValidacionBoletaPortal({ trackId } = {}) {
    if (!trackId) throw new Error('solicitarValidacionBoletaPortal: trackId es obligatorio');
    const puppeteer = require('puppeteer');
    const cookieJar = await this._obtenerCookiesSII();
    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));
    const [rutNum, dvChar] = this.config.emisor.rut.split('-');

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });
      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);
      page.on('dialog', async dlg => { console.log(`   → [dialog SET=2] ${dlg.message()}`); await dlg.accept(); });

      console.log('   → Cargando portal certBolElectDteInternet (SET=2)...');
      await page.goto('https://www4.sii.cl/certBolElectDteInternet/?SET=2', {
        waitUntil: 'networkidle2', timeout: 60000,
      });
      await new Promise(r => setTimeout(r, 2000));

      // Paso 1: RUT empresa → "Confirmar Empresa"
      const rutInput = await page.$('input[maxlength="8"]');
      const dvInput  = await page.$('input[maxlength="1"]');
      if (!rutInput) throw new Error('certBolElectDteInternet/?SET=2: no se encontró campo RUT');
      console.log(`   → Ingresando RUT empresa: ${rutNum}-${dvChar}`);
      await rutInput.click({ clickCount: 3 }); await rutInput.type(rutNum);
      await dvInput.click({ clickCount: 3 });  await dvInput.type(dvChar);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /confirmar/i.test(b.textContent));
        if (btn) btn.click();
      });
      console.log('   → Click "Confirmar Empresa"');

      // Esperar que aparezca el campo "Identificador de Envio" — GWT dispara ~8-10 POST /facade en paralelo
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 40000 }).catch(() => {});
      await page.waitForFunction(() => {
        return document.querySelector('input[maxlength="15"]') !== null;
      }, { timeout: 40000, polling: 500 }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      // Paso 2: Ingresar TrackId
      const trackInput = await page.$('input[maxlength="15"]');
      if (!trackInput) throw new Error('No se encontró campo "Identificador de Envio" en certBolElectDteInternet/?SET=2');
      console.log(`   → Ingresando TrackId: ${trackId}`);
      await trackInput.click({ clickCount: 3 });
      await trackInput.type(String(trackId));

      // Paso 3: Click "Solicitar validación"
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /solicitar/i.test(b.textContent));
        if (btn) btn.click();
      });
      console.log('   → Click "Solicitar validación" — esperando respuesta...');

      // Esperar respuesta del portal (puede ser confirmación o error)
      await page.waitForFunction(() => {
        const t = (document.body.textContent || '').toUpperCase();
        return t.includes('ENVI') || t.includes('CORREO') || t.includes('ERROR') ||
               t.includes('VALIDACI') || t.includes('SOLICITUD');
      }, { timeout: 15000, polling: 500 }).catch(() => {});

      const respuesta = await page.evaluate(() => (document.body.innerText || '').trim().substring(0, 500));
      console.log(`   ✓ Validación solicitada. Respuesta: ${respuesta.substring(0, 120)}`);

      return { success: true, respuesta };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Completa la declaración de cumplimiento de Boleta Electrónica en el portal SII.
   * Marca los checkboxes de requisitos y rellena el formulario de proveedor.
   * @param {Object} opts
   * @param {string} [opts.linkConsulta='www.sii.cl']
   * @param {string} [opts.rutProveedor='78206276-K']
   * @param {string} [opts.nombreProveedor='DEVLAS SPA']
   * @param {string} [opts.correoProveedor='certificacion.sii@devlas.cl']
   * @returns {Promise<{success: boolean, mensaje?: string, error?: string}>}
   */
  async completarDeclaracionBoletaPortal({
    linkConsulta    = 'www.sii.cl',
    rutProveedor    = '78206276-K',
    nombreProveedor = 'DEVLAS SPA',
    correoProveedor = 'certificacion.sii@devlas.cl',
  } = {}) {
    const puppeteer = require('puppeteer');
    const cookieJar = await this._obtenerCookiesSII();

    // RUT empresa desde config (ej: "78206276-K")
    const rutEmpresaRaw = (this.config.emisor?.rut || '').replace(/\./g, '');
    const [rutEmpNum, rutEmpDvRaw = 'K'] = rutEmpresaRaw.split('-');
    const rutEmpDv = rutEmpDvRaw.toUpperCase();

    const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
      name, value, domain: '.sii.cl', path: '/', httpOnly: false, secure: true,
    }));

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
      });
      const page = await browser.newPage();
      await page.setCookie(...puppeteerCookies);

      // Capturar alerts/confirms de GWT — sin handler quedan bloqueados
      let dialogMsg = null;
      page.on('dialog', async dlg => {
        dialogMsg = dlg.message();
        console.log(`   → [dialog] ${dialogMsg}`);
        await dlg.accept();
      });

      // ── PASOS 1+2: Confirmar Empresa → esperar formulario (con retry) ──
      // El portal GWT a veces responde con error transitorio ("empresa no autorizada")
      // que se resuelve recargando la página y reintentando.
      const MAX_INTENTOS = 3;
      let checkboxOk = false;
      let lastDialogMsg = null;
      for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        dialogMsg = null; // resetear entre intentos

        console.log(`   → Navegando a certBolElectDteInternet (declaración) [intento ${intento}/${MAX_INTENTOS}]...`);
        await page.goto('https://www4.sii.cl/certBolElectDteInternet/', {
          waitUntil: 'networkidle2', timeout: 60000,
        });
        await new Promise(r => setTimeout(r, 2500));

        // GWT requiere eventos de teclado reales — NO funciona con .value = ...
        const rutInput = await page.$('input[maxlength="8"]');
        const dvInput  = await page.$('input[maxlength="1"]');
        if (!rutInput) throw new Error('certBolElectDteInternet/: no se encontró campo RUT empresa');
        console.log(`   → Ingresando RUT empresa: ${rutEmpresaRaw}`);
        await rutInput.click({ clickCount: 3 }); await rutInput.type(rutEmpNum);
        await dvInput.click({ clickCount: 3 });  await dvInput.type(rutEmpDv);

        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => /confirmar empresa/i.test(b.textContent));
          if (btn) btn.click();
        });
        console.log('   → Click "Confirmar Empresa"...');

        // GWT dispara ~8-10 POST /facade EN PARALELO al confirmar.
        // Esperar red inactiva y luego DOM con checkboxes.
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 40000 }).catch(() => {});
        await page.waitForFunction(() => {
          return document.querySelector('input[type="checkbox"]') !== null;
        }, { timeout: 40000, polling: 500 }).catch(() => {});

        if (dialogMsg) {
          // Portal lanzó alert — puede ser transitorio. Guardar y reintentar.
          lastDialogMsg = dialogMsg;
          console.log(`   ⚠️  Portal respondió con alerta en intento ${intento}: ${dialogMsg.substring(0, 100)}`);
          if (intento < MAX_INTENTOS) {
            console.log('   → Recargando y reintentando en 3s...');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          // Agotados los intentos con alerta — el SII puede requerir esperar SOK
          return { success: false, pendingSok: true, error: lastDialogMsg };
        }

        if (await page.$('input[type="checkbox"]')) {
          checkboxOk = true;
          break;
        }

        console.log(`   ⚠️  Formulario no cargó en intento ${intento}${intento < MAX_INTENTOS ? ` — reintentando...` : ''}`);
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!checkboxOk) {
        throw new Error('Formulario de declaración no cargó tras confirmar empresa (3 intentos)');
      }

      const totalCbs = await page.evaluate(() => {
        const todos = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        todos.forEach(cb => { if (!cb.checked) cb.click(); });
        return todos.length;
      });
      console.log(`   → ${totalCbs} checkbox(es) marcados`);
      await new Promise(r => setTimeout(r, 500));

      // ── PASO 3: Rellenar campos proveedor software ────────────────
      // GWT requiere page.type() real — NOT funciona con .value + dispatchEvent
      const fillByLabel = async (labelFragment, value) => {
        const handle = await page.evaluateHandle((frag) => {
          for (const td of document.querySelectorAll('td')) {
            if (!td.textContent.includes(frag)) continue;
            const next = td.nextElementSibling;
            if (!next) continue;
            const inp = next.querySelector('input[type="text"]');
            if (inp) return inp;
          }
          return null;
        }, labelFragment);
        const elem = handle && await handle.asElement();
        if (!elem) return false;
        await elem.click({ clickCount: 3 });
        await elem.type(value);
        return true;
      };

      // Link de Consulta  (maxlength=100)
      const linkOk = await fillByLabel('Link de Consulta', linkConsulta);
      if (!linkOk) {
        const inp = await page.$('input[type="text"][maxlength="100"]');
        if (inp) { await inp.click({ clickCount: 3 }); await inp.type(linkConsulta); }
      }

      // RUT Proveedor — dos inputs (num + DV) en la fila "Rut Proveedor"
      const [rutProvNum, rutProvDvRaw] = rutProveedor.replace(/\./g, '').split('-');
      const rutProvDv = (rutProvDvRaw || 'K').toUpperCase();
      const rutProvH = await page.evaluateHandle(() => {
        for (const td of document.querySelectorAll('td')) {
          if (!td.textContent.includes('Rut Proveedor')) continue;
          const next = td.nextElementSibling;
          if (next) { const ins = next.querySelectorAll('input[type="text"]'); if (ins[0]) return ins[0]; }
        }
        return null;
      });
      const dvProvH = await page.evaluateHandle(() => {
        for (const td of document.querySelectorAll('td')) {
          if (!td.textContent.includes('Rut Proveedor')) continue;
          const next = td.nextElementSibling;
          if (next) { const ins = next.querySelectorAll('input[type="text"]'); if (ins[1]) return ins[1]; }
        }
        return null;
      });
      if (rutProvH && await rutProvH.asElement()) { const e = rutProvH.asElement(); await e.click({ clickCount: 3 }); await e.type(rutProvNum); }
      if (dvProvH  && await dvProvH.asElement())  { const e = dvProvH.asElement();  await e.click({ clickCount: 3 }); await e.type(rutProvDv);  }

      // Nombre Proveedor
      await fillByLabel('Nombre Proveedor', nombreProveedor);

      // Correo Proveedor Software
      await fillByLabel('Correo electrónico Proveedor', correoProveedor);

      // Captura pre-submit
      if (this.config.debugDir) {
        await page.screenshot({ path: path.join(this.config.debugDir, 'boleta-declaracion-pre-submit.png'), fullPage: true }).catch(() => {});
      }

      // ── PASO 4: Click "Grabar Declaración" ───────────────────────
      const submitOk = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /grabar declaraci/i.test(b.textContent));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!submitOk) throw new Error('No se encontró botón "Grabar Declaración" en certBolElectDteInternet/');
      console.log('   → Click "Grabar Declaración"...');

      // Esperar confirmación del SII
      await page.waitForFunction(() => {
        const t = (document.body.textContent || '').toUpperCase();
        return t.includes('GRABADA') || t.includes('GRABADO') || t.includes('COMPLETADA') ||
               t.includes('EXITOSA') || t.includes('GUARDADA') || t.includes('REGISTRADA');
      }, { timeout: 20000, polling: 1000 }).catch(() => {});

      const msgFinal = await page.evaluate(() => (document.body.textContent || '').trim().substring(0, 300));
      console.log(`   ✓ Declaración completada. Respuesta: ${msgFinal.substring(0, 150)}`);

      if (this.config.debugDir) {
        await page.screenshot({ path: path.join(this.config.debugDir, 'boleta-declaracion-post-submit.png'), fullPage: true }).catch(() => {});
      }

      return { success: true, mensaje: msgFinal };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers privados
  // ═══════════════════════════════════════════════════════════════

  _getFechaHoy() {
    const now = new Date();
    return `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
  }
}

module.exports = CertRunner;
