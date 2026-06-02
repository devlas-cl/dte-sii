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
const { STEPS, emitProgress } = require('../utils/progress');

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
        sessionPath: this.sessionPath,
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
      emitProgress(STEPS.CAF_REQUESTING, { tipo: Number(tipoDte) });
      console.log(` Tipo ${tipoDte}: ${cantidad} folios...`);
      
      // Usar solicitarCafConFallback que solicita y retorna el path
      const cafPath = await this.folioService.solicitarCafConFallback({
        tipoDte: Number(tipoDte),
        cantidad: Number(cantidad),
      });
      
      if (!cafPath) {
        throw new Error(`No se pudo obtener CAF para tipo ${tipoDte}`);
      }
      
      cafs[tipoDte] = cafPath;
      emitProgress(STEPS.CAF_OK, { tipo: Number(tipoDte) });
      console.log(` ✓ CAF tipo ${tipoDte}`);
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
    emitProgress(STEPS.SET_START, { set: 'basico' });
    const r = await this._ejecutarSet(SetBasico, 'setBasico', 'basico', { 33: 4, 56: 1, 61: 3 }, 'basico', casos);
    if (r.success) emitProgress(STEPS.SET_OK, { set: 'basico', trackId: r.trackId });
    else emitProgress(STEPS.SET_ERROR, { set: 'basico', error: r.error });
    return r;
  }

  async ejecutarSetGuia(casos) {
    emitProgress(STEPS.SET_START, { set: 'guia' });
    const r = await this._ejecutarSet(SetGuia, 'setGuiaDespacho', 'guia',
      (setData) => ({ 52: setData.casos?.length || 1 }), 'guia', casos);
    if (r.success) emitProgress(STEPS.SET_OK, { set: 'guia', trackId: r.trackId });
    else emitProgress(STEPS.SET_ERROR, { set: 'guia', error: r.error });
    return r;
  }

  async ejecutarSetExenta(casos) {
    emitProgress(STEPS.SET_START, { set: 'exenta' });
    const r = await this._ejecutarSet(SetExenta, 'setFacturaExenta', 'exenta', { 34: 3, 56: 1, 61: 4 }, 'exenta', casos);
    if (r.success) emitProgress(STEPS.SET_OK, { set: 'exenta', trackId: r.trackId });
    else emitProgress(STEPS.SET_ERROR, { set: 'exenta', error: r.error });
    return r;
  }

  async ejecutarSetCompra(casos) {
    emitProgress(STEPS.SET_START, { set: 'compra' });
    const r = await this._ejecutarSet(SetCompra, 'setFacturaCompra', 'compra', { 46: 1, 56: 1, 61: 1 }, 'compra', casos);
    if (r.success) emitProgress(STEPS.SET_OK, { set: 'compra', trackId: r.trackId });
    else emitProgress(STEPS.SET_ERROR, { set: 'compra', error: r.error });
    return r;
  }

  /**
   * Bucle de reintentos común para declarar avance/libros/simulación.
   * @private
   * @param {Object} sets - Sets a declarar (pasados a siiCert.declararAvance)
   * @param {string} debugPrefix - Prefijo del archivo HTML de debug (ej: 'declaracion-response')
   * @param {Object} [options] - { maxIntentos, intervalo, label }
   */
  async _declararConReintentos(sets, debugPrefix, options = {}) {
    const { maxIntentos = 10, intervalo = 5000, label = 'avance', retryOnAllRejected = false } = options;

    console.log(` Esperando 10s para que SII procese los envios...`);
    await sleep(10000);

    let lastResult = null;
    for (let intento = 1; intento <= maxIntentos; intento++) {
      emitProgress(STEPS.POLLING, { intento, max: maxIntentos, label });
      console.log(` Declarando ${label} (intento ${intento}/${maxIntentos})...`);

      const result = await this.siiCert.declararAvance({ sets });
      lastResult = result;

      // Guardar el form pe_avance2 (antes del POST) para debug
      if (result.formHtml) {
        fs.writeFileSync(
          path.join(this.debugDir, `${debugPrefix}-pe_avance2-${intento}.html`),
          result.formHtml,
          'utf8'
        );
      }

      // Guardar la respuesta pe_avance3 (despues del POST) para debug
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
        console.log(` [...] SII aún procesando, reintentando en ${intervalo / 1000}s...`);
        await sleep(intervalo);
      } else if (result.conErrores) {
        // SII reporta errores de contenido.
        // Si verificado === false (campos vacíos), los TrackIds aún no están en el portal → reintentar.
        // Si los campos sí aparecieron, es un error real de contenido → no reintentar.
        if (result.verificado === false && intento < maxIntentos) {
          console.log(` [!] ENVIO CON ERRORES pero campos vacíos — TrackIds aún no disponibles. Reintentando en ${intervalo / 1000}s...`);
          await sleep(intervalo);
        } else {
          console.log(` [ERR] Contenido rechazado por SII (ENVIO CON ERRORES O REPAROS): ${(result.nombresConError || []).join(', ')}`);
          break;
        }
      } else if (result.allRejected) {
        // SII rechazó todos los sets/libros — período incorrecto, no tiene sentido reintentar
        if (retryOnAllRejected && intento < maxIntentos) {
          console.log(` [!] S21 — SII aún procesando TrackID, reintentando en ${intervalo / 1000}s...`);
          await sleep(intervalo);
        } else {
          console.log(` [ERR] SII rechazó todos los envíos (campos vacíos en portal) — período incorrecto. Corregir período y reenviar.`);
          break;
        }
      } else if (result.verificado === false && intento < maxIntentos) {
        // Verificación post-declaración falló: los campos quedaron vacíos en el portal
        console.log(` [!] Verificación fallida: ${result.error}`);
        console.log(` [...] Reintentando declaración en ${intervalo / 1000}s...`);
        await sleep(intervalo);
      } else if (!result.success) {
        console.log(` [!] Error declarando ${label}: ${result.error || 'desconocido'}`);
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

    emitProgress(STEPS.SETS_DECLARING);
    const result = await this._declararConReintentos(sets, 'declaracion-response', { maxIntentos, intervalo, label: 'avance de sets' });
    if (result?.success) { emitProgress(STEPS.SETS_DECLARED); console.log(' ✓ Declaracion de sets enviada'); }
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
   * @param {Object} [options.setsResultados] - Track IDs de los sets (basico/guia/exenta/compra) para incluirlos en la declaración conjunta
   * @returns {Promise<Object>} Resultado con todos los libros
   */
  async ejecutarFase4Libros(options = {}) {
    // NOTA: Ya NO decrementamos aquí - cada libro decrementa su propio período
    emitProgress(STEPS.BOOKS_START);
    console.log('\n' + '═'.repeat(60));
    console.log('FASE 4: LIBROS (todos usan el mismo periodo)');
    console.log('═'.repeat(60) + '\n');

    const resultados = {};
    const errores = [];

    // Consultar QEstLibro hacia atrás hasta encontrar 2 años consecutivos sin entradas.
    // En entornos con historial extenso (ej: pruebas desde 2003) esto cubre todo el rango.
    const _nowFase4 = new Date();
    const _añoActual = _nowFase4.getFullYear();
    const _ocupados = new Set();
    let _librosPortal = {};
    // QEstLibro siempre devuelve "Recibido" como estado — no hay distinción entre LTC/LRH.
    // Cualquier período con entrada existente se considera ocupado (hay un libro previo enviado).
    const _esConforme = (_estadoStr) => true; // toda entrada en QEstLibro = período ocupado
    {
      let _yq = _añoActual;
      let _añosSinEntradas = 0;
      while (_yq >= 1990) {
        const _yStr = String(_yq);
        let _nPeriodos = 0;
        try {
          // Timeout de 12s por petición para evitar colgarse en años sin datos del SII.
          const _timeoutProm = new Promise((_, r) => setTimeout(() => r(new Error('timeout QEstLibro')), 12000));
          const _data = await Promise.race([this.siiCert.consultarLibrosExistentes(_yStr), _timeoutProm]);
          _nPeriodos = Object.keys(_data).length;
          let _conformes = 0;
          for (const [_p, _libros] of Object.entries(_data)) {
            if (Object.values(_libros).some(l => _esConforme(l.estado))) {
              _ocupados.add(_p);
              _conformes++;
            }
          }
          if (_yq === _añoActual) _librosPortal = _data;
          if (_nPeriodos > 0) console.log(`[INFO] QEstLibro ${_yStr}: ${_nPeriodos} períodos (${_conformes} bloqueados)`);
        } catch (_e) {
          console.warn(`[!] No se pudo consultar QEstLibro ${_yStr}: ${_e.message}`);
        }
        // Early exit: 2 años consecutivos sin entradas → no hay más historial que leer.
        if (_nPeriodos === 0) {
          _añosSinEntradas++;
          if (_añosSinEntradas >= 2) {
            console.log(`[INFO] QEstLibro: 2 años consecutivos sin datos (${_yStr}) — fin de escaneo.`);
            break;
          }
        } else {
          _añosSinEntradas = 0;
        }
        _yq--;
      }
    }
    console.log(`[INFO] Períodos bloqueados (QEstLibro): ${_ocupados.size} — rango ${[..._ocupados].sort()[0] ?? '-'} a ${[..._ocupados].sort().at(-1) ?? '-'}`);

    // Período = derivado del FchDoc real de los documentos del SET.
    // El SII genera el SET con fecha = hoy, por lo que PeriodoTributario debe coincidir
    // con el mes de esas fechas. Usar currentMonth-1 causa "ENVIO CON ERRORES O REPAROS".
    let _periodoBase = null;
    const _fchDocMuestra =
      this._estructuras?.libroCompras?.detalle?.[0]?.FchDoc ||
      this._estructuras?.libroComprasExentos?.detalle?.[0]?.FchDoc;
    if (_fchDocMuestra) {
      const _dt = new Date(_fchDocMuestra);
      if (!isNaN(_dt.getTime())) {
        // Usar UTC para evitar que el offset de zona horaria local (ej: UTC-3 en Chile)
        // desplace la fecha al mes anterior (ej: '2026-06-01' → 2026-05-31 local → mes 5).
        _periodoBase = `${_dt.getUTCFullYear()}-${String(_dt.getUTCMonth() + 1).padStart(2, '0')}`;
        console.log(`[INFO] Período derivado de FchDoc en estructuras (${_fchDocMuestra}): ${_periodoBase}`);
      }
    }
    if (!_periodoBase) {
      // Fallback: mes actual UTC
      _periodoBase = `${_nowFase4.getUTCFullYear()}-${String(_nowFase4.getUTCMonth() + 1).padStart(2, '0')}`;
      console.log(`[INFO] Período por fallback (mes actual UTC): ${_periodoBase}`);
    }

    // Helper: salta períodos conocidos en QEstLibro (ocupados) al buscar uno libre.
    // Usa el set _ocupados ya construido. Siempre llama a _decrementarPeriodoLibros al menos una vez
    // antes de entrar, así que solo sirve para saltar DESPUÉS de haber decrementado.
    const _saltarOcupados = (tag = '') => {
      let _saltos = 0;
      while (_ocupados.has(this._getPeriodoLibros()) && _saltos < 400) {
        console.log(` [skip${tag}] ${this._getPeriodoLibros()} está en QEstLibro — saltando...`);
        this._decrementarPeriodoLibros();
        _saltos++;
      }
      return _saltos;
    };

    // Usar siempre el período derivado de FchDoc como punto de partida.
    // En entornos de certificación con historial de años, QEstLibro está lleno de
    // entradas antiguas y saltar sobre ellas lleva a períodos LTC inesperados.
    // Con _ocupados completo (todos los años hasta 1990), el skip inicial es seguro:
    // salta directamente al primer período genuinamente libre.
    this.resetPeriodoLibros(_periodoBase);
    const _busquedaHuecos = _saltarOcupados();
    const _periodoComunLibros = this._getPeriodoLibros();
    console.log(` Período inicial: ${_periodoComunLibros}${_busquedaHuecos > 0 ? ` (saltados ${_busquedaHuecos} períodos ocupados desde ${_periodoBase})` : ''}`);

    // Verificar cuáles libros ya están REVISADO CONFORME en el portal (no re-enviar)
    let _estadoActual = {};
    try {
      const _consultaPrevia = await this.siiCert.consultarEstadoSets();
      if (_consultaPrevia.success) _estadoActual = _consultaPrevia.estadoSets || {};
      const _yaConformes = Object.entries(_estadoActual)
        .filter(([k, v]) => k.toUpperCase().includes('LIBRO') && v === 'REVISADO CONFORME')
        .map(([k]) => k);
      if (_yaConformes.length) {
        console.log(` Ya en REVISADO CONFORME (se omitirán): ${_yaConformes.join(', ')}`);
      }
    } catch (_e) { /* ignorar error de consulta previa */ }

    const _estaConforme = (nombre) => {
      const nombreUpper = nombre.toUpperCase();
      const e = Object.entries(_estadoActual).find(([k]) => {
        const ku = k.toUpperCase();
        if (nombreUpper === 'LIBRO DE COMPRAS') return ku.includes('LIBRO DE COMPRAS') && !ku.includes('EXENTOS');
        return ku.includes(nombreUpper);
      });
      return e && e[1] === 'REVISADO CONFORME';
    };

    // Helper: guardar resultados parciales a disco tras cada envío exitoso
    const _resultadosLibrosPath = path.join(this.debugDir, 'resultados-libros.json');
    const _guardarResultadosParciales = () => {
      try {
        fs.writeFileSync(_resultadosLibrosPath, JSON.stringify(resultados, null, 2));
      } catch (_e) { /* ignorar */ }
    };

    try {
      // 1. Libro de Compras (usa datos del SII)
      if (_estaConforme('LIBRO DE COMPRAS')) {
        emitProgress(STEPS.BOOK_SKIPPED, { book: 'libroCompras' });
        resultados.libroCompras = { success: true, conforme: true };
        console.log('\n[OK] Libro de Compras ya esta REVISADO CONFORME — omitiendo');
      } else {
        emitProgress(STEPS.BOOK_SENDING, { book: 'libroCompras' });
        console.log('\nEnviando Libro de Compras...');
        resultados.libroCompras = await this.ejecutarLibroCompras({ ...options, periodo: _periodoComunLibros });
        if (!resultados.libroCompras.success) {
          const _errLC = resultados.libroCompras.error || '';
          if (/duplicado|cvc-/i.test(_errLC)) {
            console.log('\n[!] LibroCompras: SII ya tiene envío TOTAL para este período — reintentando con AJUSTE...');
            emitProgress(STEPS.BOOK_SENDING, { book: 'libroCompras' });
            resultados.libroCompras = await this.ejecutarLibroCompras({ ...options, periodo: _periodoComunLibros, tipoEnvio: 'AJUSTE' });
          }
          if (!resultados.libroCompras.success) {
            emitProgress(STEPS.BOOK_ERROR, { book: 'libroCompras', error: resultados.libroCompras.error });
            errores.push(`Libro Compras: ${resultados.libroCompras.error}`);
          } else {
            emitProgress(STEPS.BOOK_OK, { book: 'libroCompras', trackId: resultados.libroCompras.trackId });
            _guardarResultadosParciales();
          }
        } else {
          emitProgress(STEPS.BOOK_OK, { book: 'libroCompras', trackId: resultados.libroCompras.trackId });
          _guardarResultadosParciales();
        }
      }
    } catch (e) {
      errores.push(`Libro Compras: ${e.message}`);
    }

    try {
      // 2. Libro de Ventas (usa SetBasico)
      if (_estaConforme('LIBRO DE VENTAS')) {
        emitProgress(STEPS.BOOK_SKIPPED, { book: 'libroVentas' });
        resultados.libroVentas = { success: true, conforme: true };
        console.log('\n[OK] Libro de Ventas ya esta REVISADO CONFORME — omitiendo');
      } else {
        emitProgress(STEPS.BOOK_SENDING, { book: 'libroVentas' });
        console.log('\nEnviando Libro de Ventas...');
        resultados.libroVentas = await this.ejecutarLibroVentas({ ...options, periodo: _periodoComunLibros });
        if (!resultados.libroVentas.success) {
          emitProgress(STEPS.BOOK_ERROR, { book: 'libroVentas', error: resultados.libroVentas.error });
          errores.push(`Libro Ventas: ${resultados.libroVentas.error}`);
        } else {
          emitProgress(STEPS.BOOK_OK, { book: 'libroVentas', trackId: resultados.libroVentas.trackId });
          _guardarResultadosParciales();
        }
      }
    } catch (e) {
      errores.push(`Libro Ventas: ${e.message}`);
    }

    try {
      // 3. Libro de Guías (usa SetGuia)
      if (_estaConforme('LIBRO DE GUIAS')) {
        emitProgress(STEPS.BOOK_SKIPPED, { book: 'libroGuias' });
        resultados.libroGuias = { success: true, conforme: true };
        console.log('\n[OK] Libro de Guias ya esta REVISADO CONFORME — omitiendo');
      } else {
        emitProgress(STEPS.BOOK_SENDING, { book: 'libroGuias' });
        console.log('\nEnviando Libro de Guias...');
        resultados.libroGuias = await this.ejecutarLibroGuias({ ...options, periodo: _periodoComunLibros });
        if (!resultados.libroGuias.success) {
          emitProgress(STEPS.BOOK_ERROR, { book: 'libroGuias', error: resultados.libroGuias.error });
          errores.push(`Libro Guias: ${resultados.libroGuias.error}`);
        } else {
          emitProgress(STEPS.BOOK_OK, { book: 'libroGuias', trackId: resultados.libroGuias.trackId });
          _guardarResultadosParciales();
        }
      }
    } catch (e) {
      errores.push(`Libro Guías: ${e.message}`);
    }

    // 4. Libro de Compras para Exentos (solo si el SII lo entregó y no está ya aprobado)
    if (this._estructuras?.libroComprasExentos) {
      try {
        if (_estaConforme('LIBRO DE COMPRAS PARA EXENTOS')) {
          emitProgress(STEPS.BOOK_SKIPPED, { book: 'libroComprasExentos' });
          resultados.libroComprasExentos = { success: true, conforme: true };
          console.log('\n[OK] Libro Compras Exentos ya esta REVISADO CONFORME — omitiendo');
        } else {
          emitProgress(STEPS.BOOK_SENDING, { book: 'libroComprasExentos' });
          console.log('\nEnviando Libro de Compras para Exentos...');
          resultados.libroComprasExentos = await this.ejecutarLibroComprasExentos({ ...options, periodo: _periodoComunLibros });
          if (!resultados.libroComprasExentos.success) {
            emitProgress(STEPS.BOOK_ERROR, { book: 'libroComprasExentos', error: resultados.libroComprasExentos.error });
            errores.push(`Libro Compras Exentos: ${resultados.libroComprasExentos.error}`);
          } else {
            emitProgress(STEPS.BOOK_OK, { book: 'libroComprasExentos', trackId: resultados.libroComprasExentos.trackId });
            _guardarResultadosParciales();
          }
        }
      } catch (e) {
        errores.push(`Libro Compras Exentos: ${e.message}`);
      }
    }

    // Contar libros obligatorios (ventas + compras + guías)
    // Un libro cuenta como OK si fue enviado exitosamente O si ya era REVISADO CONFORME (omitido)
    const librosObligatorios = ['libroVentas', 'libroCompras', 'libroGuias'];
    const librosEnviados = librosObligatorios.filter(k => {
      if (resultados[k]?.success) return true;
      // Mapeo clave→nombre para consultar _estaConforme
      const nombreMap = { libroVentas: 'LIBRO DE VENTAS', libroCompras: 'LIBRO DE COMPRAS', libroGuias: 'LIBRO DE GUIAS' };
      return _estaConforme(nombreMap[k]);
    }).length;
    
    if (librosEnviados === 3) {
      // Mapeo entre nombre SII y clave interna
      const _SII_NOMBRE_A_KEY = {
        'LIBRO DE VENTAS': 'libroVentas',
        'LIBRO DE COMPRAS': 'libroCompras',
        'LIBRO DE GUIAS': 'libroGuias',
        'LIBRO DE COMPRAS PARA EXENTOS': 'libroComprasExentos',
      };
      const _KEY_A_SII_NOMBRE = Object.fromEntries(Object.entries(_SII_NOMBRE_A_KEY).map(([n, k]) => [k, n]));

      // Busca el entry de _ss para un nombre SII (COMPRAS sin EXENTOS, etc.)
      const _findEntry = (ss, nombre) => Object.entries(ss).find(([k]) => {
        const ku = k.toUpperCase();
        if (nombre === 'LIBRO DE COMPRAS') return ku.includes('LIBRO DE COMPRAS') && !ku.includes('EXENTOS');
        return ku.includes(nombre);
      });

      // Retorna claves internas que están en S21 en ss, de entre los especificados
      const _getS21Keys = (ss, nombres) =>
        nombres
          .filter(n => { const e = _findEntry(ss, n); return e && e[1] === 'S21'; })
          .map(n => _SII_NOMBRE_A_KEY[n])
          .filter(Boolean);

      // Helper para re-enviar los libros no conformes con un nuevo período
      // keysAReenviar: Set opcional — si se pasa, solo re-envía las claves del Set
      // tipoEnvio: 'TOTAL' (default) o 'AJUSTE' (fallback cuando todos los períodos están agotados)
      const _reenviarLibros = async (nuevoPeriodo, keysAReenviar, tipoEnvio) => {
        const _orden = [
          { key: 'libroCompras', fn: (p, te) => this.ejecutarLibroCompras({ ...options, periodo: p, tipoEnvio: te }) },
          { key: 'libroVentas', fn: (p, te) => this.ejecutarLibroVentas({ ...options, periodo: p, tipoEnvio: te }) },
          { key: 'libroGuias', fn: (p, te) => this.ejecutarLibroGuias({ ...options, periodo: p, tipoEnvio: te }) },
          { key: 'libroComprasExentos', fn: (p, te) => this.ejecutarLibroComprasExentos({ ...options, periodo: p, tipoEnvio: te }) },
        ];
        for (const { key, fn } of _orden) {
          if (resultados[key]?.conforme) continue; // ya conforme en SII
          if (keysAReenviar && !keysAReenviar.has(key)) continue; // filtro por S21
          emitProgress(STEPS.BOOK_SENDING, { book: key });
          try {
            resultados[key] = await fn(nuevoPeriodo, tipoEnvio);
            if (!resultados[key].success) {
              emitProgress(STEPS.BOOK_ERROR, { book: key, error: resultados[key].error });
            } else {
              emitProgress(STEPS.BOOK_OK, { book: key, trackId: resultados[key].trackId });
            }
          } catch (e) {
            resultados[key] = { success: false, error: e.message };
          }
        }

        // Polling SOAP para detectar LNC antes de intentar declarar.
        // Si el SII rechaza el envío (LNC), limpiamos el trackId para que declararLibros
        // no incluya ese libro, y marcamos el período como ocupado para no reintentarlo.
        const _reenvTids = _orden.filter(({ key }) =>
          !resultados[key]?.conforme &&
          (!keysAReenviar || keysAReenviar.has(key)) &&
          resultados[key]?.trackId
        );
        if (_reenvTids.length > 0) {
          const _nombresReenv = _reenvTids.map(({ key }) => _KEY_A_SII_NOMBRE[key] || key);
          console.log(`\n[SOAP-retry] Verificando estado de libros re-enviados (${_nombresReenv.join(', ')})...`);
          await sleep(15000);
          const _sRPend = new Set(_reenvTids.map(b => b.key));
          const _sRErr = {};
          for (let _ri = 0; _ri < 20 && _sRPend.size > 0; _ri++) {
            for (const { key } of _reenvTids) {
              if (!_sRPend.has(key)) continue;
              const _tid = resultados[key].trackId;
              const _nom = _KEY_A_SII_NOMBRE[key] || key;
              try {
                const _est = await _enviadorSoap.consultarEstadoSoap(_tid, _rutEmisor);
                if (_est.ok === false) {
                  _sRErr[key] = (_sRErr[key] || 0) + 1;
                  if (_sRErr[key] >= 5) _sRPend.delete(key);
                } else {
                  _sRErr[key] = 0;
                  if (!_est.esIntermedio) {
                    _sRPend.delete(key);
                    const _glosa = _est.glosa || _est.estado || '?';
                    if (_est.esRechazado) {
                      console.log(` [SOAP-retry] ${_nom} (${_tid}): [LNC] ${_glosa} — período ${nuevoPeriodo} ocupado`);
                      _ocupados.add(nuevoPeriodo);
                      resultados[key] = { success: false, error: `LNC: ${_glosa}`, periodo: nuevoPeriodo };
                    } else {
                      console.log(` [SOAP-retry] ${_nom} (${_tid}): [LOK] ${_glosa}`);
                    }
                  }
                }
              } catch (_e) {
                _sRErr[key] = (_sRErr[key] || 0) + 1;
                if (_sRErr[key] >= 5) _sRPend.delete(key);
              }
            }
            if (_sRPend.size > 0) await sleep(15000);
          }
        }
      };

      // Polling de aprobación (reutilizable)
      // librosAVerificar: array de nombres SII a esperar. Si se omite, usa todos los no-conformes.
      // Devuelve { ok, estadosFinal }
      // S21 = libro enviado al portal, PENDIENTE DE REVISIÓN — estado normal de espera.
      // NO es un error de período. Solo LNC/LRH son errores reales que requieren acción.
      const _esperarAprobacion = async (librosAVerificar) => {
        const _todosCandidatos = ['LIBRO DE VENTAS', 'LIBRO DE COMPRAS', 'LIBRO DE GUIAS'];
        if (this._estructuras?.libroComprasExentos) _todosCandidatos.push('LIBRO DE COMPRAS PARA EXENTOS');
        const _librosAVerif = librosAVerificar || _todosCandidatos.filter(n => !_estaConforme(n));
        console.log(`\nEsperando aprobacion del SII para: ${_librosAVerif.join(', ')}`);
        let _ss = {};
        for (let _i = 0; _i < 40; _i++) {
          await sleep(15000);
          emitProgress(STEPS.POLLING, { intento: _i + 1, max: 40, label: 'libros' });
          const _poll = await this.siiCert.consultarEstadoSets();
          if (!_poll.success) continue;
          _ss = _poll.estadoSets || {};
          const _info = Object.entries(_ss).filter(([k]) => k.toUpperCase().includes('LIBRO')).map(([k, v]) => `${k.trim()}: ${v}`);
          if (_info.length) console.log(` [...] Intento ${_i + 1}/40: ${_info.join(' | ')}`);
          const _librosObs = ['LIBRO DE VENTAS', 'LIBRO DE COMPRAS', 'LIBRO DE GUIAS'];
          const _todosObligatoriosOk = _librosObs.every(n => {
            const e = _findEntry(_ss, n);
            return e && (e[1] === 'REVISADO CONFORME' || e[1] === 'S25');
          });
          const _todosOk = _librosAVerif.every(n => {
            const e = _findEntry(_ss, n);
            return e && (e[1] === 'REVISADO CONFORME' || e[1] === 'S25');
          });
          const _algunError = _librosAVerif.some(n => {
            const e = _findEntry(_ss, n);
            return e && (e[1] === 'LNC' || e[1] === 'LRH' || e[1].includes('RECHAZADO') || e[1].includes('ERROR'));
          });
          if (_todosOk) {
            // Marcar conforme en resultados para que el RESUMEN final sea correcto.
            for (const n of _librosAVerif) {
              const _cKey = _SII_NOMBRE_A_KEY[n];
              if (_cKey && resultados[_cKey]) resultados[_cKey].conforme = true;
            }
            emitProgress(STEPS.BOOKS_DONE);
            console.log('\n[OK] LIBROS APROBADOS POR EL SII!');
            return { ok: true, estadosFinal: _ss };
          }
          if (_algunError) {
            console.log('\n[ERR] Hay libros rechazados. Revisar emails del SII.');
            return { ok: false, estadosFinal: _ss };
          }
          // S21 = procesando. Informar pero seguir esperando (no bail-out).
          const _pendientesAun = _librosAVerif.filter(n => {
            const e = _findEntry(_ss, n);
            return !e || (e[1] !== 'REVISADO CONFORME' && e[1] !== 'S25');
          });
          if (_pendientesAun.length > 0 && (_i + 1) % 4 === 0) {
            console.log(` [...] Aún esperando (${Math.round((_i + 1) * 15 / 60)} min): ${_pendientesAun.join(', ')}`);
          }
        }
        console.log('\n[!] Timeout (10 min). El SII aún no responde. Verifica con --avance más tarde.');
        return { ok: false, estadosFinal: _ss };
      };

      // Polling SOAP: esperar que el SII procese los XMLs antes de declarar.
      // Solo se sigue esperando mientras esIntermedio === true (REC, SOK, FOK, PRD, CRT, DNK...).
      // Estados como LSO (no catalogado) no tienen esIntermedio = true → se consideran "listos".
      const _librosParaConsultar = [
        { key: 'libroCompras',        nombre: 'Libro Compras' },
        { key: 'libroVentas',         nombre: 'Libro Ventas' },
        { key: 'libroGuias',          nombre: 'Libro Guias' },
        { key: 'libroComprasExentos', nombre: 'Libro Compras Exentos' },
      ].filter(({ key }) => resultados[key]?.trackId);

      const _enviadorSoap = this._createLibroEnviador();
      const _rutEmisor = this.config.emisor.rut;

      // Polling hasta 30 minutos (120 intentos × 15s).
      // LSO (schema OK, procesando contenido) y otros intermedios esperan hasta LOK o rechazo.
      const _MAX_SOAP_POLLS = 120;
      const _SOAP_INTERVAL_MS = 15000;
      let _soapPendientes = new Set(_librosParaConsultar.map(l => l.key));
      const _soapFinalStates = {}; // key → resultado SOAP terminal (LOK/LNC/LRH/etc.)
      const _soapErrCount = {};    // key → contador de errores SOAP consecutivos (ok:false o throw)
      const _MAX_SOAP_ERR = 10;    // reintentos antes de desistir por errores transitorios

      console.log('\n[SOAP] Consultando estado de envíos (espera hasta 15 min)...');
      await sleep(15000); // espera inicial — SII tarda al menos 15s en validar schema
      for (let _pi = 0; _pi < _MAX_SOAP_POLLS && _soapPendientes.size > 0; _pi++) {
        for (const { key, nombre } of _librosParaConsultar) {
          if (!_soapPendientes.has(key)) continue;
          const _tid = resultados[key].trackId;
          try {
            const _est = await _enviadorSoap.consultarEstadoSoap(_tid, _rutEmisor);
            const _estado = _est.estado || '?';
            const _detalle = _est.glosa || _est.mensaje || _est.error || 'sin detalle';
            if (_est.ok === false) {
              // Sin tag <ESTADO> en respuesta — error de parseo/red, no un rechazo real.
              // Reintentar hasta _MAX_SOAP_ERR veces consecutivas antes de desistir.
              _soapErrCount[key] = (_soapErrCount[key] || 0) + 1;
              if (_soapErrCount[key] >= _MAX_SOAP_ERR) {
                _soapPendientes.delete(key);
                console.log(` [SOAP] ${nombre} (${_tid}): [?] demasiados errores — desistiendo`);
              } else {
                console.log(` [SOAP] ${nombre} (${_tid}): [?] error transitorio (${_soapErrCount[key]}/${_MAX_SOAP_ERR}) — reintentando...`);
              }
            } else {
              _soapErrCount[key] = 0; // reset en cualquier respuesta válida
              if (!_est.esIntermedio) {
                // Estado terminal: LOK (exitoso), LNC/LRH (rechazado), u otro no catalogado
                _soapPendientes.delete(key);
                _soapFinalStates[key] = _est;
                const _tag = _est.esExitoso ? '[OK]' : _est.esRechazado ? '[ERR]' : '[->]';
                console.log(` [SOAP] ${nombre} (${_tid}): ${_tag} ${_estado} — ${_detalle}`);
              } else {
                const _elapsed = Math.round((_pi * _SOAP_INTERVAL_MS + 15000) / 1000);
                console.log(` [SOAP] ${nombre} (${_tid}): [...] ${_estado} — aún procesando (${_elapsed}s / ${_pi + 1}/${_MAX_SOAP_POLLS})`);
              }
            }
          } catch (_e) {
            _soapErrCount[key] = (_soapErrCount[key] || 0) + 1;
            if (_soapErrCount[key] >= _MAX_SOAP_ERR) {
              _soapPendientes.delete(key);
              console.log(` [SOAP] ${nombre} (${_tid}): error — máx reintentos: ${_e.message}`);
            } else {
              console.log(` [SOAP] ${nombre} (${_tid}): error (${_soapErrCount[key]}/${_MAX_SOAP_ERR}) — reintentando: ${_e.message}`);
            }
          }
        }
        if (_soapPendientes.size > 0) await sleep(_SOAP_INTERVAL_MS);
      }
      if (_soapPendientes.size > 0) {
        const _nombresTimeout = _librosParaConsultar.filter(l => _soapPendientes.has(l.key)).map(l => l.nombre);
        console.log(` [SOAP] ${_nombresTimeout.join(', ')} siguen en proceso tras 15 min. Declarando igual — verifica correos del SII.`);
      }

      // 4. Declarar + retry automático:
      //    a) si allRejected al declarar → decrementar período y re-enviar TOTAL
      //       (el período ya fue procesado en otra sesión → buscar uno libre)
      //    b) si libros quedan en S21 tras polling → decrementar y re-enviar solo los S21
      emitProgress(STEPS.BOOKS_DECLARING);
      console.log('\nDeclarando libros...');
      // 24 = ~2 años de meses. En entorno cert con histórico extenso puede haber
      // muchos períodos LTC consecutivos antes de encontrar uno libre.
      const MAX_PERIOD_RETRIES = 24;

      // _librosPortal ya fue consultado arriba (antes de fijar período inicial)

      try {
        let declaracion = await this.declararLibros({ ...resultados, ...(options.setsResultados || {}) });
        resultados.declaracion = declaracion;

        // Fase a: allRejected → el período ya tiene data en el portal.
        // Estrategia: decrementar uno a uno desde el período actual.
        //   - Si tenemos LTC guardado localmente → AJUSTE una vez antes de decrementar.
        //   - Si no hay LTC o AJUSTE también falló → decrementar y probar TOTAL.
        // No hacemos saltos basados en el portal: QEstLibro solo cubre el año actual
        // y puede haber entradas en años anteriores que no conocemos.
        const _intentadoAjuste = new Set();

        for (let _pRetry = 0; _pRetry < MAX_PERIOD_RETRIES && declaracion.allRejected; _pRetry++) {
          const _periodoActual = this._getPeriodoLibros();
          const _tenemoLtc = !!this._leerLtcTotales(_periodoActual, 'COMPRA') || !!this._leerLtcTotales(_periodoActual, 'VENTA');
          const _yaIntentadoAjuste = _intentadoAjuste.has(_periodoActual);

          if (_tenemoLtc && !_yaIntentadoAjuste) {
            console.log(`\n[!] ${_periodoActual}: LTC guardado — re-enviando con AJUSTE (intento ${_pRetry + 1})...`);
            emitProgress(STEPS.BOOK_PERIOD_RETRY, { periodo: _periodoActual, intento: String(_pRetry + 1) });
            _intentadoAjuste.add(_periodoActual);
            await _reenviarLibros(_periodoActual, undefined, 'AJUSTE');
          } else {
            // Marcar este período como ocupado dinámicamente y saltar al siguiente libre.
            _ocupados.add(_periodoActual);
            this._decrementarPeriodoLibros();
            _saltarOcupados('a'); // salta períodos conocidos (QEstLibro + descubiertos en tiempo real)
            const _nuevoPeriodo = this._getPeriodoLibros();
            const _razon = _yaIntentadoAjuste ? 'AJUSTE falló' : 'sin LTC local';
            console.log(`\n[!] ${_periodoActual} (${_razon}) — probando TOTAL con ${_nuevoPeriodo} (intento ${_pRetry + 1})...`);
            emitProgress(STEPS.BOOK_PERIOD_RETRY, { periodo: _nuevoPeriodo, intento: String(_pRetry + 1) });
            await _reenviarLibros(_nuevoPeriodo, undefined, undefined);
          }
          declaracion = await this.declararLibros({ ...resultados, ...(options.setsResultados || {}) });
          resultados.declaracion = declaracion;
        }

        if (declaracion.success) {
          console.log('\n[OK] Libros declarados — esperando revisión del SII...');

          // Construir la lista inicial de libros a verificar
          const _todosLibrosNombres = ['LIBRO DE VENTAS', 'LIBRO DE COMPRAS', 'LIBRO DE GUIAS'];
          if (this._estructuras?.libroComprasExentos) _todosLibrosNombres.push('LIBRO DE COMPRAS PARA EXENTOS');
          let _librosAVerificar = _todosLibrosNombres.filter(n => !_estaConforme(n));

          // Si SOAP detectó LNC/LRH para algún libro → excluirlos de la espera portal.
          // El portal mostrará S21 para ellos (nunca resolverá) → phase b los maneja directamente.
          const _soapLncNombres = Object.entries(_soapFinalStates)
            .filter(([, est]) => est?.esRechazado)
            .map(([k]) => _KEY_A_SII_NOMBRE[k])
            .filter(Boolean);
          // Si la declaración reportó errores de contenido para algún libro → también excluirlos.
          // Esos libros tienen S21 en portal pero nunca resolverán a REVISADO CONFORME desde
          // esta declaración → phase b los maneja directamente con nuevo período.
          const _declaracionConErrorNombres = (declaracion.nombresConError || []);
          const _excluirDeEspera = [...new Set([..._soapLncNombres, ..._declaracionConErrorNombres])];
          const _librosAEsperar = _librosAVerificar.filter(n => !_excluirDeEspera.includes(n));
          if (_soapLncNombres.length > 0) {
            console.log(`\n[!] LNC vía SOAP en: ${_soapLncNombres.join(', ')} — esperando portal solo para: ${_librosAEsperar.join(', ') || 'ninguno'}`);
          }
          if (_declaracionConErrorNombres.length > 0) {
            console.log(`\n[!] Errores de contenido en declaración: ${_declaracionConErrorNombres.join(', ')} — no esperando portal para ellos`);
          }

          let ok, estadosFinal;
          if (_librosAEsperar.length > 0) {
            ({ ok, estadosFinal } = await _esperarAprobacion(_librosAEsperar));
          } else {
            ok = false;
            estadosFinal = {};
          }
          // Inyectar LNC de SOAP y errores de contenido de declaración en estadosFinal
          for (const n of _soapLncNombres) estadosFinal[n] = 'LNC';
          // Libros con errores de contenido en declaración = mismo tratamiento que LNC: period incorrecto
          for (const n of _declaracionConErrorNombres) if (!estadosFinal[n]) estadosFinal[n] = 'LNC';
          if (_excluirDeEspera.length > 0) ok = false;

          // Fase b: libros con LNC/LRH/S21-timeout → reintentar con AJUSTE (si tenemos LTC) o nuevo período.
          // - LNC/LRH = período tiene LTC → intentar AJUSTE si hay datos, sino decrementar.
          // - S21 después de timeout = upload probablemente rechazado (SOAP LNC no reflejado en pe_avance2)
          //   → mismo tratamiento que LNC.
          const _intentadoAjusteB = new Set();
          for (let _pRetry = 0; !ok && _pRetry < MAX_PERIOD_RETRIES; _pRetry++) {
            // Libros con LNC/LRH o S21-timeout (no resuelto → asumimos error de período)
            const _fallidos = Object.entries(estadosFinal)
              .filter(([k, v]) => {
                const ku = k.toUpperCase();
                const esLibro = ku.includes('LIBRO');
                const esFallido = (v === 'LNC' || v === 'LRH' || String(v).includes('RECHAZADO') || v === 'S21');
                return esLibro && esFallido;
              });
            const _fallidosKeys = _fallidos.map(([k]) => _SII_NOMBRE_A_KEY[k]).filter(Boolean);
            if (_fallidosKeys.length === 0) break; // todos conformes → salir

            const _periodoFase = this._getPeriodoLibros();
            // Solo AJUSTE para libros que tienen su propio LTC guardado.
            // LibroGuias y LibroComprasExentos nunca tienen LTC → van siempre a TOTAL en período nuevo.
            const _LTC_TIPO_POR_LIBRO_B = { libroCompras: 'COMPRA', libroVentas: 'VENTA' };
            const _hayLtcB = _fallidosKeys.some(k => {
              const tipo = _LTC_TIPO_POR_LIBRO_B[k];
              return tipo && !!this._leerLtcTotales(_periodoFase, tipo);
            });
            const _yaAjusteB = _intentadoAjusteB.has(_periodoFase);
            const _fallidosNombres = _fallidosKeys.map(k => _KEY_A_SII_NOMBRE[k]).filter(Boolean);

            if (_hayLtcB && !_yaAjusteB) {
              // Tenemos LTC guardado para este período → intentar AJUSTE antes de cambiar período
              console.log(`\n[!] ${_fallidosNombres.join(', ')} fallidos en ${_periodoFase} — LTC local existe, probando AJUSTE (intento ${_pRetry + 1})...`);
              emitProgress(STEPS.BOOK_PERIOD_RETRY, { periodo: _periodoFase, intento: String(_pRetry + 1) });
              _intentadoAjusteB.add(_periodoFase);
              await _reenviarLibros(_periodoFase, new Set(_fallidosKeys), 'AJUSTE');
            } else {
              // Sin LTC o AJUSTE ya intentado → marcar como ocupado y buscar período libre
              _ocupados.add(_periodoFase);
              this._decrementarPeriodoLibros();
              _saltarOcupados('b');
              const _nuevoPeriodo = this._getPeriodoLibros();
              const _razonB = _yaAjusteB ? 'AJUSTE falló' : 'sin LTC local';
              console.log(`\n[!] ${_fallidosNombres.join(', ')} (${_razonB}) — probando TOTAL en ${_nuevoPeriodo} (intento ${_pRetry + 1})...`);
              emitProgress(STEPS.BOOK_PERIOD_RETRY, { periodo: _nuevoPeriodo, intento: String(_pRetry + 1) });
              await _reenviarLibros(_nuevoPeriodo, new Set(_fallidosKeys), undefined);
            }
            declaracion = await this.declararLibros({ ...resultados, ...(options.setsResultados || {}) });
            resultados.declaracion = declaracion;

            if (!declaracion.success && !declaracion.allRejected) {
              // Casos en que NO se debe cortar el loop:
              // 1. Tras intentar AJUSTE → la siguiente iteración buscará período libre.
              // 2. 'No hay libros para declarar' → todos los re-enviados tuvieron LNC en SOAP → continuar.
              const _todosSoapLnc = (declaracion.error || '').includes('No hay libros para declarar');
              if (_intentadoAjusteB.size > 0 || _todosSoapLnc) {
                const _msg = _todosSoapLnc ? 'todos LNC en SOAP' : `AJUSTE falló (${declaracion.error})`;
                console.log(`\n[!] Declaración fallida (${_msg}) — buscando período libre...`);
              } else {
                console.log(`\n[ERR] Declaración fallida: ${declaracion.error}`);
                break;
              }
            }
            if (declaracion.success) {
              _librosAVerificar = _fallidosNombres;
              ;({ ok, estadosFinal } = await _esperarAprobacion(_librosAVerificar));
            }
          }

          if (!ok) {
            console.log('\n[!] No se pudo obtener aprobación del SII para todos los libros.');
          }
        } else {
          const _errorDeclaracion = declaracion.error || 'Declaración rechazada por SII';
          console.log(`\n[ERR] Declaración de libros fallida: ${_errorDeclaracion}`);
          for (const k of ['libroVentas', 'libroCompras', 'libroGuias', 'libroComprasExentos']) {
            if (resultados[k]?.success && !resultados[k]?.conforme) {
              resultados[k] = { ...resultados[k], success: false, error: _errorDeclaracion };
            }
          }
        }
      } catch (e) {
        console.log(`\n[!] Error declarando libros: ${e.message}`);
        resultados.declaracion = { success: false, error: e.message };
      }
    } else {
      console.log(`\n[!] Solo ${librosEnviados}/3 libros enviados. Errores: ${errores.join('; ')}`);
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
      // Sets — incluirlos para que pe_avance3 no los resetee a S01
      basico: 'setBasico',
      guia: 'setGuiaDespacho',
      exenta: 'setFacturaExenta',
      compra: 'setFacturaCompra',
      // Libros
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
      console.log(` [OK] Libros declarados: ${declarados.join(', ')}`);
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
      console.log(` Período decrementado: ${currentPeriodo} → ${newPeriodo}`);
    } catch (e) {
      console.warn(` [!] No se pudo guardar período: ${e.message}`);
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
      console.log(` Período reseteado a: ${periodo}`);
    } catch (e) {
      console.warn(` [!] No se pudo guardar período: ${e.message}`);
    }
  }

  /**
   * Guarda los totales del LTC (envío TOTAL/MENSUAL) para usar en futuros AJUSTE.
   * @param {string} periodo - Período YYYY-MM
   * @param {string} tipo - 'COMPRA' | 'VENTA'
   * @param {Array} resumen - Array de totales por TpoDoc (igual estructura que setResumen)
   * @private
   */
  _guardarLtcTotales(periodo, tipo, resumen) {
    const ltcFile = path.join(this.debugDir, 'ltc-totales.json');
    let data = {};
    try {
      if (fs.existsSync(ltcFile)) data = JSON.parse(fs.readFileSync(ltcFile, 'utf8'));
    } catch (e) { /* usar vacío */ }
    if (!data[periodo]) data[periodo] = {};
    data[periodo][tipo] = resumen;
    try {
      fs.writeFileSync(ltcFile, JSON.stringify(data, null, 2));
      console.log(` [LTC] Totales guardados: ${periodo}/${tipo} (${resumen.length} tipos doc)`);
    } catch (e) {
      console.warn(` [!] No se pudo guardar ltcTotales: ${e.message}`);
    }
  }

  /**
   * Lee los totales LTC guardados para un período y tipo.
   * @param {string} periodo - Período YYYY-MM
   * @param {string} tipo - 'COMPRA' | 'VENTA'
   * @returns {Array|null} Array de totales o null si no hay datos
   * @private
   */
  _leerLtcTotales(periodo, tipo) {
    const ltcFile = path.join(this.debugDir, 'ltc-totales.json');
    try {
      if (fs.existsSync(ltcFile)) {
        const data = JSON.parse(fs.readFileSync(ltcFile, 'utf8'));
        return data[periodo]?.[tipo] || null;
      }
    } catch (e) { /* ignorar */ }
    return null;
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

    // Usar período pasado por opción (fase4 lo decrementa una vez para todos) o decrementar individualmente
    const periodo = options.periodo || (this._decrementarPeriodoLibros(), this._getPeriodoLibros());
    console.log(` Generando Libro de Ventas para período ${periodo}...`);

    const libroVentas = new LibroVentas({
      emisor: this.config.emisor,
      receptor: this.config.receptor,
      periodo,
      certificado: this.certificado,
      signoNC: options.signoNC || 'POSITIVO',
      tipoEnvio: options.tipoEnvio || 'TOTAL',
    });

    const { libro, xml: _xmlVentas, detalle, resumen } = libroVentas.generar(setBasicoResult);

    // Si es AJUSTE, inyectar LTC para que TotalesPeriodo sea acumulado correcto
    const _tipoEnvioVentas = options.tipoEnvio || 'TOTAL';
    if (_tipoEnvioVentas === 'AJUSTE') {
      const _ltcVentas = this._leerLtcTotales(periodo, 'VENTA');
      if (_ltcVentas) {
        libro.setLtcTotales(_ltcVentas);
        libro.generar(); // re-firma con TotalesPeriodo correcto
      }
    }
    const xml = libro.getXML() || _xmlVentas;

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-ventas.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');

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
      console.log(` [OK] Libro de Ventas enviado - TrackId: ${result.trackId}`);
      // Persistir totales LTC para futuros AJUSTE de este período
      if (_tipoEnvioVentas === 'TOTAL') {
        this._guardarLtcTotales(periodo, 'VENTA', resumen);
      }
    } else {
      console.log(` [ERR] Error enviando Libro de Ventas: ${result.error}`);
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

    const periodo = options.periodo || (this._decrementarPeriodoLibros(), this._getPeriodoLibros());

    const libroCompras = new LibroCompras({
      emisor: this.config.emisor,
      periodo,
      certificado: this.certificado,
      tipoEnvio: options.tipoEnvio || 'TOTAL',
    });

    if (!libroComprasData?.detalle) {
      throw new Error('No hay datos del libro de compras. El SII no entregó el set LIBRO_COMPRAS al obtener las estructuras.');
    }

    console.log(` Generando Libro de Compras para período ${periodo} (${libroComprasData.detalle.length} documentos del SII)...`);
    const { libro, xml: _xmlCompras, detalle, resumen } = libroCompras.generarDesdeEstructuras(libroComprasData, periodo);

    // Si es AJUSTE, inyectar LTC para que TotalesPeriodo sea acumulado correcto
    const _tipoEnvioCompras = options.tipoEnvio || 'TOTAL';
    if (_tipoEnvioCompras === 'AJUSTE') {
      const _ltcCompras = this._leerLtcTotales(periodo, 'COMPRA');
      if (_ltcCompras) {
        libro.setLtcTotales(_ltcCompras);
        libro.generar(); // re-firma con TotalesPeriodo correcto
      }
    }
    const xml = libro.getXML() || _xmlCompras;

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-compras.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');

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
      console.log(` [OK] Libro de Compras enviado - TrackId: ${result.trackId}`);
      // Persistir totales LTC para futuros AJUSTE de este período
      if (_tipoEnvioCompras === 'TOTAL') {
        this._guardarLtcTotales(periodo, 'COMPRA', resumen);
      }
    } else {
      console.log(` [ERR] Error enviando Libro de Compras: ${result.error}`);
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

    const periodo = options.periodo || (this._decrementarPeriodoLibros(), this._getPeriodoLibros());

    const libroCompras = new LibroCompras({
      emisor: this.config.emisor,
      periodo,
      certificado: this.certificado,
      tipoEnvio: options.tipoEnvio || 'TOTAL',
    });

    console.log(` Generando Libro de Compras para Exentos para período ${periodo} (${libroData.detalle.length} documentos del SII)...`);
    const { libro, xml, detalle } = libroCompras.generarDesdeEstructuras(libroData, periodo);

    const outPath = path.join(this.debugDir, 'libro-compras-exentos.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');

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
      console.log(` [OK] Libro de Compras para Exentos enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(` [ERR] Error enviando Libro de Compras para Exentos: ${result.error}`);
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

    const periodo = options.periodo || (this._decrementarPeriodoLibros(), this._getPeriodoLibros());
    console.log(` Generando Libro de Guías para período ${periodo}...`);

    const libroGuias = new LibroGuias({
      emisor: this.config.emisor,
      receptor: this.config.receptor,
      periodo,
      certificado: this.certificado,
      folioNotificacion: options.folioNotificacion || 3,
      tipoEnvio: options.tipoEnvio || 'TOTAL',
    });

    const { libro, xml, detalle } = libroGuias.generar(setGuiaResult, {
      casosLibro: options.casosLibro,
    });

    // Guardar XML de debug
    const outPath = path.join(this.debugDir, 'libro-guias.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');

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
      console.log(` [OK] Libro de Guías enviado - TrackId: ${result.trackId}`);
    } else {
      console.log(` [ERR] Error enviando Libro de Guías: ${result.error}`);
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
    console.log('AVANZAR SIGUIENTE PASO');
    console.log('═'.repeat(60) + '\n');

    try {
      console.log(' Enviando solicitud de avance...');
      const result = await this.siiCert.avanzarSiguientePaso();

      if (result.rawHtml) {
        fs.writeFileSync(
          path.join(this.debugDir, 'avanzar-siguiente-paso-response.html'),
          result.rawHtml,
          'utf8'
        );
        console.log(` Respuesta guardada en: ${path.join(this.debugDir, 'avanzar-siguiente-paso-response.html')}`);
      }

      if (result.success) {
        console.log(' [OK] Avance al siguiente paso exitoso');
        this.resultados.avanceSiguientePaso = { success: true };
      } else {
        console.log(` [ERR] Error en avance: ${result.error || 'Error desconocido'}`);
        this.resultados.avanceSiguientePaso = { success: false, error: result.error };
      }

      return result;
    } catch (error) {
      console.log(` [ERR] Error: ${error.message}`);
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

    console.log('\n[...] Esperando aprobación de libros...');

    for (let i = 1; i <= maxIntentos; i++) {
      console.log(`\n [...] Intento ${i}/${maxIntentos}...`);
      
      const avance = await this.siiCert.verAvanceParsed();
      
      if (!avance.success) {
        console.log(` [!] Error consultando avance: ${avance.error}`);
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
          console.log(` [OK] ${libro}: REVISADO CONFORME`);
        } else if (esRechazado) {
          console.log(` [ERR] ${libro}: ${estado.estado}`);
          hayRechazados = true;
        } else {
          console.log(` [...] ${libro}: ${estado.estado || 'EN REVISION'}`);
          todosAprobados = false;
        }
      }

      if (hayRechazados) {
        console.log('\n [ERR] Hay libros rechazados. No se puede avanzar.');
        return { success: false, error: 'Hay libros rechazados' };
      }

      if (todosAprobados) {
        console.log('\n ¡Todos los libros aprobados!');
        return await this.avanzarSiguientePaso();
      }

      await sleep(intervalo);
    }

    console.log('\n [!] Timeout esperando aprobación de libros');
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
    console.log('FASE 6: SIMULACIÓN');
    console.log('═'.repeat(60) + '\n');

    // Calcular CAFs necesarios
    const cafRequired = this._calcularCafsSimulacion(estructuras);
    console.log(' Solicitando CAFs para simulación...');
    
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
    console.log(' Generando DTEs de simulación...');
    const { envioDte, dtes, xml, plan, tiposUsados } = simulacion.generar(
      estructuras,
      cafObjects,
      this.folioHelper,
    );

    console.log(` Plan de simulación: ${plan.length} documentos`);
    console.log(` Tipos usados: ${tiposUsados.join(', ')}`);

    // Guardar XML de debug
    const runDir = path.join(this.debugDir, 'simulacion');
    fs.mkdirSync(runDir, { recursive: true });
    const outPath = path.join(runDir, 'envio-simulacion.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');

    // Guardar DTEs individuales
    const dtesDir = path.join(runDir, 'dtes');
    fs.mkdirSync(dtesDir, { recursive: true });
    dtes.forEach((dteItem) => {
      const filename = `dte-${String(dteItem.tipoDte).padStart(2, '0')}-${String(dteItem.folio).padStart(6, '0')}.xml`;
      fs.writeFileSync(path.join(dtesDir, filename), dteItem.xml, 'utf8');
    });

    // Enviar al SII
    console.log('\n Enviando al SII...');
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
      console.log(`\n[OK] Simulación enviada - TrackId: ${result.trackId}`);
    } else {
      console.log(`\n[ERR] Error en simulación: ${result.error}`);
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
    console.log(' Verificando etapa actual...');
    const avance = await this.siiCert.verAvanceParsed();
    if (avance.rawHtml && /paso\s*<b>\s*INTERCAMBIO/i.test(avance.rawHtml)) {
      console.log(' [OK] Simulación ya aprobada - empresa en etapa INTERCAMBIO');
      return { success: true, skipped: true, message: 'Ya en etapa INTERCAMBIO' };
    }

    const fecha = this._getFechaHoy();
    const sets = {
      setSimulacion: {
        trackId: resultados.simulacion.trackId,
        fecha,
      },
    };

    const result = await this._declararConReintentos(sets, 'declaracion-simulacion-response', { maxIntentos, intervalo, label: 'simulación', retryOnAllRejected: true });
    if (result?.success) console.log(' [OK] Simulación declarada exitosamente');
    return result;
  }

  /**
   * Espera a que la simulación sea aprobada
   * @param {Object} [options] - { maxIntentos, intervalo }
   * @returns {Promise<Object>} Resultado del polling
   */
  async esperarSimulacionAprobada(options = {}) {
    const { maxIntentos = 30, intervalo = 10000 } = options;

    console.log('\n[...] Esperando aprobación de simulación...');

    for (let i = 1; i <= maxIntentos; i++) {
      console.log(`\n [...] Intento ${i}/${maxIntentos}...`);
      
      const avance = await this.siiCert.verAvanceParsed();
      
      if (!avance.success) {
        console.log(` [!] Error consultando avance: ${avance.error}`);
        await sleep(intervalo);
        continue;
      }

      // [OK] PRIMERO: Verificar si ya pasó a INTERCAMBIO (significa que simulación fue aprobada)
      if (avance.etapaActual && avance.etapaActual.includes('INTERCAMBIO')) {
        console.log(` [OK] Etapa actual: ${avance.etapaActual}`);
        console.log('\n ¡SIMULACIÓN APROBADA! Empresa pasó a etapa INTERCAMBIO.');
        return { success: true, etapa: 'INTERCAMBIO' };
      }

      // [OK] TAMBIÉN: Etapas que vienen DESPUÉS de INTERCAMBIO (simulación + intercambio ya completos)
      const ETAPAS_POST_INTERCAMBIO = ['DOCUMENTOS IMPRESOS', 'MUESTRAS IMPRESAS', 'BOLETA', 'AUTORIZADO', 'COMPLETADO'];
      if (avance.etapaActual && ETAPAS_POST_INTERCAMBIO.some(e => avance.etapaActual.toUpperCase().includes(e))) {
        console.log(`   Etapa actual: ${avance.etapaActual}`);
        console.log('\n ¡SIMULACIÓN + INTERCAMBIO COMPLETADOS! Empresa en etapa: ' + avance.etapaActual);
        return { success: true, etapa: avance.etapaActual, postIntercambio: true };
      }

      // [OK] SEGUNDO: Verificar indicador de formulario de confirmación (simulación aprobada pendiente confirmar)
      if (avance.simulacionAprobadaIndicador) {
        console.log(` [OK] Formulario de confirmación detectado`);
        
        // Confirmar automáticamente la simulación
        if (this.resultados.simulacion?.trackId) {
          console.log(`\n Confirmando revisión de simulación (TrackId: ${this.resultados.simulacion.trackId})...`);
          
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
            console.log(' [OK] Confirmación enviada exitosamente');

            // Revalidar contra SII para evitar falso positivo de confirmación
            const verificacion = await this.siiCert.verAvanceParsed();
            const estadoSim = verificacion?.estados?.setSimulacion;
            const sigueFormulario = Boolean(verificacion?.simulacionAprobadaIndicador);
            const yaIntercambio = Boolean(verificacion?.etapaActual?.includes('INTERCAMBIO'));
            const simConforme = Boolean(estadoSim?.esConforme || estadoSim?.estado?.toUpperCase()?.includes('REVISADO CONFORME'));

            if (yaIntercambio) {
              console.log('\n ¡SIMULACIÓN CONFIRMADA! Empresa ya en etapa INTERCAMBIO.');
              return { success: true, confirmada: true, etapa: 'INTERCAMBIO' };
            }

            if (simConforme || !sigueFormulario) {
              // La empresa pasó a la siguiente etapa automáticamente (INTERCAMBIO → DOCUMENTOS IMPRESOS → DECLARAR CUMPLIMIENTO)
              const etapaActual = verificacion?.etapaActual || 'INTERCAMBIO';
              console.log(`\n ¡SIMULACIÓN APROBADA! Etapa actual: ${etapaActual}`);
              return { success: true, confirmada: true, etapa: etapaActual };
            }

            console.log(' [!] SII aún mantiene formulario de simulación pendiente; se reintentará...');
            await sleep(intervalo);
            continue;
          } else {
            console.log(` [!] Error en confirmación: ${confirmResult.error}`);
            // Continuar el loop para reintentar
          }
        } else {
          console.log('\n ¡SIMULACIÓN APROBADA! Lista para confirmar revisión.');
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
          console.log(` [OK] SIMULACIÓN: REVISADO CONFORME`);
          // Consultar etapa actual (INTERCAMBIO es el siguiente paso tras simulación)
          const postSimAvance = await this.siiCert.verAvanceParsed().catch(() => null);
          const etapaActual = postSimAvance?.etapaActual || 'INTERCAMBIO';
          console.log(`\n ¡SIMULACIÓN APROBADA! Etapa actual: ${etapaActual}`);
          return { success: true, etapa: etapaActual };
        } else if (esRechazado) {
          console.log(` [ERR] SIMULACIÓN: ${simEstado.estado}`);
          return { success: false, error: 'Simulación rechazada' };
        } else {
          console.log(` [...] SIMULACIÓN: ${simEstado.estado || 'EN REVISION'}`);
        }
      } else {
        // No hay estado de simulación, pero verificar etapa actual
        if (avance.etapaActual) {
          console.log(`   Etapa actual: ${avance.etapaActual}`);
        } else {
          console.log(' [...] Simulación aún no registrada...');
        }
      }

      await sleep(intervalo);
    }

    console.log('\n [!] Timeout esperando aprobación de simulación');
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
    console.log('FASE 7: INTERCAMBIO DE INFORMACIÓN');
    console.log('═'.repeat(60));

    // ── PASO 1: Obtener el SET XML ─────────────────────────────
    const setInputPath = options.inputPath ||
      path.join(intercambioDir, 'set-intercambio.xml');

    let setXml = null;

    // Ruta persistente donde siempre guardamos el XML (independiente de options.inputPath)
    const setDownloadPath = path.join(intercambioDir, 'set-intercambio.xml');

    if (setInputPath && fs.existsSync(setInputPath)) {
      console.log(`\nLeyendo SET desde: ${setInputPath}`);
      setXml = fs.readFileSync(setInputPath, 'utf8');
      console.log(` ✓ ${setXml.length} bytes`);
    } else if (fs.existsSync(setDownloadPath)) {
      console.log(`\nLeyendo SET guardado: ${setDownloadPath}`);
      setXml = fs.readFileSync(setDownloadPath, 'utf8');
      console.log(` ✓ ${setXml.length} bytes`);
    } else {
      console.log('\nDescargando SET desde www4.sii.cl/pfeInternet...');
      const dl = await this._descargarSetPfeInternet(intercambioDir);
      if (dl.success) {
        setXml = dl.xml;
        fs.writeFileSync(setDownloadPath, setXml, 'utf8');
        console.log(` [OK] SET descargado (${setXml.length} bytes) → ${setDownloadPath}`);
      } else {
        console.log(` [!] No se pudo descargar: ${dl.error}`);
        console.log('\n' + '─'.repeat(60));
        console.log('DESCARGA MANUAL REQUERIDA:');
        console.log(' 1. Si aparece error de sesiones: ingresa a https://www4.sii.cl/ → Cerrar Sesión');
        console.log(' 2. Ir a: https://www4.sii.cl/pfeInternet/ y descargar el SET XML');
        console.log(` 3. Guardarlo en: ${setDownloadPath}`);
        console.log(' 4. Volver a ejecutar el runner');
        console.log('─'.repeat(60));
        return { success: false, error: 'SET no disponible - descarga manual requerida', requiresManual: true, manualPath: setInputPath };
      }
    }

    // ── PASO 2: Generar XMLs de respuesta ─────────────────────
    console.log('\nGenerando respuestas firmadas...');
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
    console.log('\nSubiendo respuestas a www4.sii.cl/pfeInternet...');
    const uploadResult = await this._subirRespuestasPfeInternet({
      recepcionXml:  fs.readFileSync(genResult.files.recepcion, 'utf8'),
      aprobacionXml: fs.readFileSync(genResult.files.aprobacion, 'utf8'),
      recibosXml:    fs.readFileSync(genResult.files.recibos, 'utf8'),
      debugDir: intercambioDir,
    });

    if (uploadResult.success) {
      console.log('\n' + '═'.repeat(60));
      console.log('[OK] INTERCAMBIO COMPLETADO');
      console.log('═'.repeat(60));
      if (uploadResult.resultado) console.log(` Resultado SII: ${uploadResult.resultado}`);
    } else {
      console.log(` [!] No se pudo subir automáticamente: ${uploadResult.error}`);
      console.log('\n' + '─'.repeat(60));
      console.log('SUBIDA MANUAL REQUERIDA:');
      console.log(' 1. Ir a: https://www4.sii.cl/pfeInternet/ → "Subir archivos"');
      console.log(` 2. Subir: ${genResult.files.recepcion}`);
      console.log(` 3. Subir: ${genResult.files.aprobacion}`);
      console.log(` 4. Subir: ${genResult.files.recibos}`);
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
      console.log('[SII Auth] Reutilizando sesión SII en memoria');
      return this._siiCookieJar;
    }
    const SiiPortalAuth = require('../SiiPortalAuth');
    const pfxBuffer = fs.readFileSync(this.config.certificado.path);
    const password  = this.config.certificado.password;
    const siiAuth   = new SiiPortalAuth({ pfxBuffer, pfxPassword: password });
    this._siiCookieJar = await siiAuth.autenticar();
    const nSession = Object.keys(this._siiCookieJar).filter(k => k.startsWith('NETSCAPE')).length;
    console.log(`[SII Auth] [OK] Sesión SII activa (cookies NETSCAPE: ${nSession})`);
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

      console.log(` → Descargando SET desde pfeInternet/downloadFile (RUT ${rutNum}-${dv})...`);

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
        console.log(` ✓ SET descargado correctamente (${r.body.length} bytes)`);
        return { success: true, xml: r.body };
      }

      const errMsg = `pfeInternet/downloadFile respondió HTTP ${r.status} sin XML válido`;
      console.log(` [ERR] ${errMsg}`);
      fs.writeFileSync(path.join(debugDir, `pfe-download-error-${Date.now()}.html`), r.body, 'utf8');
      return { success: false, error: errMsg };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Sube las 3 respuestas de intercambio a www4.sii.cl/pfeInternet vía HTTP puro (sin Puppeteer).
   * Flujo: warm-up → validarUsuario (GWT RPC) → uploadFile1/2/3 (multipart POST).
   * Hashes GWT capturados 2026-06-01 desde INTERCAMBIO_SET.har.
   * @private
   */
  async _subirRespuestasPfeInternet({ recepcionXml, aprobacionXml, recibosXml, debugDir }) {
    const PFE_BASE    = 'https://www4.sii.cl/pfeInternet/';
    const PFE_PERM    = 'E487C7488217509D4EDCE9D341782C20'; // pfe.nocache.js 2026-06-01
    const PFE_POLICY  = '4EB230A83E74980F353E4FCC209543CB'; // capturado 2026-06-01
    const PFE_SVC     = 'cl.sii.sdi.dim.pfe.web.client.service.Facade';

    const { cookies, makeReq } = await this._autenticarPfeInternet();

    const [empRut, empDv] = this.config.emisor.rut.replace(/\./g, '').split('-');
    // Extraer RUT del certificado desde la ruta del PFX (e.g. "19925444-8.pfx")
    const certBase = path.basename(this.config.certificado.path, '.pfx');
    const [certRut, certDv = '0'] = certBase.includes('-') ? certBase.split('-') : [certBase, '0'];

    const gwtHeaders = {
      'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
      'X-GWT-Module-Base': PFE_BASE,
      'X-GWT-Permutation': PFE_PERM,
      'Origin': 'https://www4.sii.cl',
      'Referer': PFE_BASE,
    };

    // Parsear string table GWT (igual que pdfdteInternet)
    const parseGwtTable = (body) => {
      const stIdx = body.lastIndexOf(',["');
      const stEnd = body.lastIndexOf('],');
      if (stIdx === -1 || stEnd <= stIdx) return null;
      try {
        const raw = body.substring(stIdx + 1, stEnd + 1);
        return JSON.parse(raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => `\\u00${h}`));
      } catch (_) { return null; }
    };

    // === PASO 1: validarUsuario — verifica que empresa esté en estado P06 ===
    // Payload GWT RPC de validarUsuario(UsuarioTo{empRut,empDv,certRut,certDv})
    // String table: [base, policy, svc, method, UsuarioTo type, certDv, empDv, Integer type]
    const validPayload = [
      '7|0|8',
      PFE_BASE, PFE_POLICY, PFE_SVC, 'validarUsuario',
      'cl.sii.sdi.dim.pfe.to.UsuarioTo/3723336533',
      certDv, empDv, 'java.lang.Integer/3438268394',
      '1|2|3|4|1|5|5|0|0|0|0|6|7|8', empRut,
      '0|0|0|0|0|8', certRut, '',
    ].join('|');

    console.log(' → pfeInternet: validarUsuario...');
    const validResp = await makeReq(`${PFE_BASE}facade`, {
      method: 'POST', body: validPayload, headers: gwtHeaders, cookies,
    });

    if (debugDir) fs.writeFileSync(path.join(debugDir, 'pfe-validar-resp.txt'), validResp.body.substring(0, 1000), 'utf8');

    const validTable = parseGwtTable(validResp.body);
    // MensajeTo con mensaje de error → empresa no está en P06
    const errorMsg = validTable?.find(s => typeof s === 'string' && s.length > 5 && !/^(cl\.|java\.)/.test(s));
    if (errorMsg && /no esta en estado|error/i.test(errorMsg)) {
      const estadoMatch = errorMsg.match(/estado:\s*(\w+)/i);
      const estadoActual = estadoMatch ? estadoMatch[1] : 'desconocido';
      console.log(` → pfeInternet: empresa NO en P06 (${estadoActual}) — ${errorMsg}`);
      return {
        success: false,
        estadoPortal: estadoActual,
        error: errorMsg,
        hint: estadoActual === 'P90'
          ? 'Fase de intercambio ya completada (empresa en P90)'
          : `Estado SII pfeInternet: ${estadoActual}`,
      };
    }
    console.log(' ✓ pfeInternet: empresa en P06, subiendo archivos XML...');

    // === PASO 2: Upload de los 3 XMLs vía multipart/form-data ===
    const archivos = [
      { filename: 'respuesta-recepcion-envio.xml',        content: recepcionXml,  uploadN: 1 },
      { filename: 'envio-recibos.xml',                    content: recibosXml,    uploadN: 2 },
      { filename: 'respuesta-aprobacion-comercial.xml',   content: aprobacionXml, uploadN: 3 },
    ];

    for (const archivo of archivos) {
      const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
      const CRLF = '\r\n';
      const multipartBody = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="uploadFormElement"; filename="${archivo.filename}"`,
        'Content-Type: text/xml',
        '',
        archivo.content,
        `--${boundary}--`,
        '',
      ].join(CRLF);

      console.log(` → Subiendo ${archivo.filename}...`);
      const uploadResp = await makeReq(`${PFE_BASE}uploadFile${archivo.uploadN}`, {
        method: 'POST',
        body: multipartBody,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Origin': 'https://www4.sii.cl',
          'Referer': PFE_BASE,
        },
        cookies,
      });

      const respBody = uploadResp.body || '';
      if (debugDir) {
        fs.writeFileSync(path.join(debugDir, `pfe-upload${archivo.uploadN}-resp.txt`), respBody.substring(0, 2000), 'utf8');
      }

      const respLow = respBody.toLowerCase();
      const hasError = uploadResp.status >= 400
        || (respLow.includes('error') && !respLow.includes('procesado'))
        || respLow.includes('rechaz');
      const hasSuccess = respLow.includes('procesado') || respLow.includes('exitosamente')
        || respLow.includes('cargado') || uploadResp.status === 200;

      if (hasError && !hasSuccess) {
        throw new Error(`Error al subir ${archivo.filename}: HTTP ${uploadResp.status} — ${respBody.substring(0, 200)}`);
      }
      console.log(` ✓ ${archivo.filename} subido (HTTP ${uploadResp.status})`);
    }

    return { success: true, resultado: 'Los 3 archivos XML de intercambio subidos correctamente' };
  }

  // ═══════════════════════════════════════════════════════════════
  // FASE 8: MUESTRAS IMPRESAS — subir PDFs a pe_avance5
  // ═══════════════════════════════════════════════════════════════

  /**
   * Autentica contra pdfdteInternet reutilizando la sesión SII cacheada.
   * Hace warm-up GET, obtiene el hash de política GWT desde nocache.js + cache.html
   * y retorna los utilitarios HTTP listos para hacer llamadas GWT RPC.
   * @private
   * @returns {Promise<{cookies: string, makeReq: Function, permHash: string, policyHash: string}>}
   */
  async _autenticarPdfDteInternet() {
    const https  = require('https');
    const crypto = require('crypto');
    const { URL } = require('url');

    const tlsOpts = {
      rejectUnauthorized: false,
      maxVersion: 'TLSv1.2',
      secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                   | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

    const makeReq = (urlStr, { method = 'GET', body = null, headers = {}, cookies: reqCookies = '' }) =>
      new Promise((resolve, reject) => {
        const u     = new URL(urlStr);
        const agent = new https.Agent(tlsOpts);
        const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')) : null;
        const opts = {
          hostname: u.hostname, port: u.port || 443,
          path: u.pathname + u.search, method, agent,
          headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Connection': 'keep-alive',
            'Origin': 'https://www4.sii.cl',
            'Referer': 'https://www4.sii.cl/pdfdteInternet/',
            ...(reqCookies ? { 'Cookie': reqCookies } : {}),
            ...headers,
          },
        };
        if (bodyBuf) opts.headers['Content-Length'] = bodyBuf.length;
        const req = https.request(opts, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
        });
        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
      });

    const collectNewCookies = (headers, existing) => {
      const merged = {};
      existing.split(';').forEach(c => { const [k, v] = c.trim().split('='); if (k) merged[k.trim()] = (v || '').trim(); });
      for (const c of (headers['set-cookie'] || [])) {
        const [kv] = c.split(';');
        const eq = kv.indexOf('=');
        if (eq > 0) merged[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
      return Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ');
    };

    const cookieJar = await this._obtenerCookiesSII();
    let cookies = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');

    // Hashes GWT conocidos del portal pdfdteInternet (capturados 2026-06-01 vía HAR).
    // permHash   = nombre del .cache.html cargado por el browser (permutation del GWT module)
    // policyHash = hash de política de serialización GWT embebido dentro del cache.html
    // Si el SII redespliega el portal se deben actualizar estos valores.
    const KNOWN_PERM_HASH   = 'D86ACF99AE5C17F0B0F673A9872EF6CB';
    const KNOWN_POLICY_HASH = '5459B93B9D030A67564300FBD346270F';

    // Warm-up: GET /pdfdteInternet/ para inicializar contexto del portal en el servidor.
    // Aprovechamos para intentar descubrir el permHash dinámicamente desde el HTML.
    let permHash   = KNOWN_PERM_HASH;
    let policyHash = KNOWN_POLICY_HASH;
    try {
      const warmup = await makeReq('https://www4.sii.cl/pdfdteInternet/', { cookies });
      cookies = collectNewCookies(warmup.headers, cookies);
      if ((warmup.status === 301 || warmup.status === 302) && warmup.headers?.location) {
        const loc = warmup.headers.location;
        const absLoc = loc.startsWith('http') ? loc : `https://www4.sii.cl${loc}`;
        const warmup2 = await makeReq(absLoc, { cookies });
        cookies = collectNewCookies(warmup2.headers, cookies);
      }
      console.log(`[pdfdteInternet Auth] warm-up → HTTP ${warmup.status}`);

      // Descubrir permHash dinámicamente desde pdfdte.nocache.js
      // (El módulo GWT se llama 'pdfdte', no 'pdfdteInternet' como podría esperarse)
      try {
        const ncResp = await makeReq('https://www4.sii.cl/pdfdteInternet/pdfdte.nocache.js', { cookies });
        if (ncResp.status === 200 && ncResp.body) {
          const ncHashes = [...new Set(
            [...ncResp.body.matchAll(/[=',]([0-9A-Fa-f]{32})[',]/g)].map(m => m[1].toUpperCase())
          )];
          if (ncHashes.includes(KNOWN_PERM_HASH)) {
            // Hash conocido sigue vigente
            console.log(`[pdfdteInternet Auth] pdfdte.nocache.js confirma hash conocido (${ncHashes.length} permutaciones)`);
          } else if (ncHashes.length > 0) {
            // Portal redesplegado — actualizar hashes
            const newPerm = ncHashes[0];
            console.log(`[pdfdteInternet Auth] Nuevo permHash detectado: ${newPerm.substring(0, 8)}... (portal redesplegado)`);
            try {
              const cacheResp = await makeReq(`https://www4.sii.cl/pdfdteInternet/${newPerm}.cache.html`, {
                cookies, headers: { 'Referer': 'https://www4.sii.cl/pdfdteInternet/' },
              });
              const hexInCache = [...new Set([...cacheResp.body.matchAll(/["']([0-9A-Fa-f]{32})["']/g)].map(m => m[1].toUpperCase()))];
              const newPolicy = hexInCache.find(h => h !== newPerm);
              if (newPolicy) {
                permHash   = newPerm;
                policyHash = newPolicy;
                console.log(`[pdfdteInternet Auth] Hashes actualizados correctamente.`);
              }
            } catch (e2) {
              console.log(`[pdfdteInternet Auth] No se pudo obtener nuevo cache.html: ${e2.message}. Usando hashes conocidos.`);
            }
          }
        }
      } catch (eNc) {
        console.log(`[pdfdteInternet Auth] pdfdte.nocache.js no accesible: ${eNc.message}. Usando hashes conocidos.`);
      }
    } catch (e) {
      console.log(`[pdfdteInternet Auth] warm-up falló (no crítico): ${e.message}`);
    }

    console.log(`[pdfdteInternet Auth] permHash=${permHash.substring(0, 8)}... policyHash=${policyHash.substring(0, 8)}...`);
    return { cookies, makeReq, permHash, policyHash };
  }

  /**
   * Consulta el estado actual del portal pdfdteInternet sin subir nada.
   * Útil para saltarse la generación de PDFs si ya están enviados.
   * Implementación HTTP pura — llama a leeImpreso() via GWT RPC.
   * @returns {Promise<{estado: string|null, error?: string}>}
   */
  async verificarEstadoPortalMuestras() {
    try {
      const { cookies, makeReq, permHash, policyHash } = await this._autenticarPdfDteInternet();
      const [rutNum, dvChar] = this.config.emisor.rut.split('-');

      const body =
        `7|0|6|https://www4.sii.cl/pdfdteInternet/|${policyHash}|` +
        `cl.sii.sdi.dim.validaPdfDte.web.client.service.ServicePdfDte|leeImpreso|` +
        `java.lang.String/2004016611|${rutNum}-${dvChar}|1|2|3|4|1|5|6|`;

      const resp = await makeReq('https://www4.sii.cl/pdfdteInternet/ServicePdfDte', {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
          'X-GWT-Module-Base': 'https://www4.sii.cl/pdfdteInternet/',
          'X-GWT-Permutation': permHash,
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        cookies,
      });

      if (resp.status !== 200 || !resp.body.startsWith('//OK')) {
        return { estado: null, error: `GWT leeImpreso HTTP ${resp.status}: ${resp.body.substring(0, 150)}` };
      }

      // Parsear string table GWT: siempre el penúltimo elemento (antes de flags,version)
      // GWT usa \x27 etc. (no válido en JSON) → normalizar antes de parsear
      const stIdx2 = resp.body.lastIndexOf(',["');
      const stEnd  = stIdx2 !== -1 ? resp.body.lastIndexOf('],') : -1;
      let table = null;
      if (stIdx2 !== -1 && stEnd > stIdx2) {
        try {
          const raw = resp.body.substring(stIdx2 + 1, stEnd + 1);
          const normalized = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => `\\u00${h}`);
          table = JSON.parse(normalized);
        } catch (_) {}
      }

      let estado = null, numImpresos = null, fechaEnvio = null, revId = null;
      if (table) {
        const estadoStr = table.find(s => typeof s === 'string' && /APROBADO|POR REVISAR|RECHAZADO|INGRESO|EN REVISI/i.test(s));
        const errorStr  = table.find(s => typeof s === 'string' && /El estado de la postulacion/i.test(s));
        const fechaStr  = table.find(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s));
        const nStr      = table.find(s => typeof s === 'string' && /^\d+$/.test(s) && +s > 0 && +s < 500);
        estado      = estadoStr ? estadoStr.toUpperCase() : (errorStr ? 'BLOQUEADO' : null);
        fechaEnvio  = fechaStr || null;
        numImpresos = nStr ? parseInt(nStr, 10) : null;
      }
      // Fallback: regex directo en el body
      if (!estado) {
        const m = resp.body.match(/"(APROBADO|POR REVISAR|EN REVISI[OÓ]N|RECHAZADO|INGRESO|ENVIADO AL SII)"/i);
        if (m) estado = m[1].toUpperCase();
        else if (/El estado de la postulacion/i.test(resp.body)) estado = 'BLOQUEADO';
      }
      // Extraer revId (Long GWT-base64 en rango plausible de IDs de revisión)
      const GWT_B64_V = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';
      for (const m of resp.body.matchAll(/'([A-Za-z0-9$_]{3,7})'/g)) {
        let n = 0; for (const c of m[1]) n = n * 64 + GWT_B64_V.indexOf(c);
        if (n >= 100000 && n <= 9999999) { revId = n; break; }
      }
      return { estado, revId, numImpresos, fechaEnvio };
    } catch (err) {
      return { estado: null, error: err.message };
    }
  }

  /**
   * Sube los PDFs de muestras impresas al portal pe_avance5 via HTTP puro.
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
    console.log(`FASE 8: MUESTRAS IMPRESAS (${pdfPaths.length} PDFs)`);
    console.log('═'.repeat(60));

    return this._subirMuestrasImpresasPortal({ pdfPaths, debugDir: pdfDir });
  }

  /**
   * Sube PDFs al portal https://www4.sii.cl/pdfdteInternet/ via HTTP puro (sin Puppeteer).
   * Flujo GWT RPC: leeImpreso → creaLista → upload×N → solicitaRevisionSII.
   * @private
   */
  async _subirMuestrasImpresasPortal({ pdfPaths, debugDir }) {
    // ── Helpers GWT base64 para codificar/decodificar java.lang.Long ──────────
    const GWT_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';
    const decodeGwtLong = (s) => { let n = 0; for (const c of s) n = n * 64 + GWT_B64.indexOf(c); return n; };
    const encodeGwtLong = (n) => {
      const chars = []; let r = n;
      while (r > 0) { chars.unshift(GWT_B64[r & 63]); r = Math.floor(r / 64); }
      while (chars.length < 4) chars.unshift('A');
      return chars.join('');
    };

    // ── Auth + obtención de hashes GWT ────────────────────────────────────────
    const { cookies, makeReq, permHash, policyHash } = await this._autenticarPdfDteInternet();
    const [rutNum, dvChar] = this.config.emisor.rut.split('-');

    const GWT_SVC = 'cl.sii.sdi.dim.validaPdfDte.web.client.service.ServicePdfDte';
    const GWT_BASE = 'https://www4.sii.cl/pdfdteInternet/';
    const SVC_URL  = `${GWT_BASE}ServicePdfDte`;

    const gwtPost = (body) => makeReq(SVC_URL, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
        'X-GWT-Module-Base': GWT_BASE,
        'X-GWT-Permutation': permHash,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      cookies,
    });

    // ── Paso 1: verificar si existe revisión previa (leeImpreso) ─────────────
    const leeBody =
      `7|0|6|${GWT_BASE}|${policyHash}|${GWT_SVC}|leeImpreso|` +
      `java.lang.String/2004016611|${rutNum}-${dvChar}|1|2|3|4|1|5|6|`;
    const leeResp = await gwtPost(leeBody);
    if (leeResp.status !== 200) throw new Error(`pdfdteInternet leeImpreso HTTP ${leeResp.status}`);

    // ── Parsear string table GWT (siempre antes de flags/version al final) ─────
    const _parseGwtStringTable = (body) => {
      const stIdx = body.lastIndexOf(',["');
      if (stIdx === -1) return null;
      const stEnd = body.lastIndexOf('],');   // ÚLTIMO ], = cierre del string table
      if (stEnd <= stIdx) return null;
      try {
        // GWT usa \x27 etc. (no válido en JSON) → convertir a \uXXXX
        const raw = body.substring(stIdx + 1, stEnd + 1);
        const normalized = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => `\\u00${h}`);
        return JSON.parse(normalized);
      } catch (_) { return null; }
    };

    const leeTable = _parseGwtStringTable(leeResp.body);
    const estadoMatch = leeResp.body.match(/"(APROBADO|POR REVISAR|EN REVISI[OÓ]N|RECHAZADO|INGRESO|ENVIADO AL SII)"/i);
    const estadoActual = estadoMatch ? estadoMatch[1].toUpperCase() : null;

    // Detectar mensaje de error del SII: tabla parseada o regex directo en body (por si \x27 falla)
    const errorEstadoMsg = !estadoActual && (
      (leeTable && leeTable.find(s => typeof s === 'string' && /El estado de la postulacion/i.test(s))) ||
      (() => { const m = leeResp.body.match(/"(El estado de la postulacion[^"\\]*(?:\\.[^"\\]*)*)"/i); return m ? m[1].replace(/\\x27/g, "'").replace(/\\x22/g, '"') : null; })()
    );
    if (errorEstadoMsg) {
      console.log(` → Portal SII bloqueado: ${errorEstadoMsg}`);
      return {
        success: false, blocked: true, estado: 'BLOQUEADO',
        error: errorEstadoMsg,
        hint: 'Espere a que el SII procese la revisión en curso (APROBADO/RECHAZADO) antes de re-subir.',
      };
    }

    // Si ya hay una revisión activa (no rechazada ni aprobada), no se puede re-subir.
    // El SII sólo permite crear nueva revisión cuando el estado es RECHAZADO o APROBADO.
    if (estadoActual && estadoActual !== 'RECHAZADO' && estadoActual !== 'APROBADO') {
      // Extraer detalles adicionales de la respuesta leeImpreso para diagnóstico
      let numImpresos = null, fechaEnvio = null, revId = null;
      if (leeTable) {
        const fechaStr = leeTable.find(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s));
        const nStr     = leeTable.find(s => typeof s === 'string' && /^\d+$/.test(s) && +s > 0 && +s < 500);
        fechaEnvio  = fechaStr || null;
        numImpresos = nStr ? parseInt(nStr, 10) : null;
      }
      for (const m of leeResp.body.matchAll(/'([A-Za-z0-9$_]{3,7})'/g)) {
        let n = 0; for (const c of m[1]) n = n * 64 + GWT_B64.indexOf(c);
        if (n >= 100000 && n <= 9999999) { revId = n; break; }
      }
      console.log(` → Estado: ${estadoActual}${revId ? ` | Revisión #${revId}` : ''}${fechaEnvio ? ` | Enviado: ${fechaEnvio}` : ''}${numImpresos ? ` | ${numImpresos} documentos` : ''} — ya enviadas, no se requiere re-subida`);
      return { success: true, alreadyCompleted: true, estado: estadoActual, revId, numImpresos, fechaEnvio };
    }
    if (estadoActual) {
      console.log(` → Estado previo: ${estadoActual} — creando nueva revisión`);
    } else {
      console.log(` → No hay revisión previa — creando primera revisión`);
    }

    // ── Paso 2: crear nueva lista/revisión (creaLista) ────────────────────────
    // Params (6): amb=Z, rutNum, dv, proveedor=rutNum, provDv=dv, provNomre=""
    // String table (9): module, policy, svc, method, String type, Z, rutNum, dv, ""
    const creaBody =
      `7|0|9|${GWT_BASE}|${policyHash}|${GWT_SVC}|creaLista|` +
      `java.lang.String/2004016611|Z|${rutNum}|${dvChar}||` +
      `1|2|3|4|6|5|5|5|5|5|6|7|8|9|7|8|0|`;
    const creaResp = await gwtPost(creaBody);
    if (creaResp.status !== 200 || !creaResp.body.startsWith('//OK')) {
      throw new Error(`pdfdteInternet creaLista falló HTTP ${creaResp.status}: ${creaResp.body.substring(0, 200)}`);
    }
    // Detectar error de SII dentro del //OK (e.g. revisión en curso bloqueando)
    const creaTable = _parseGwtStringTable(creaResp.body);
    const creaErrorMsg = creaTable && creaTable.find(s => typeof s === 'string' && /El estado de la postulacion/i.test(s));
    if (creaErrorMsg) {
      throw new Error(`pdfdteInternet creaLista: ${creaErrorMsg} — Espere a que el SII procese la revisión en curso.`);
    }

    // Extraer ID de revisión (Long codificado en GWT base64, ej: 'BAqo' = 264872)
    let revId = null;
    let revIdEncoded = null;
    for (const m of creaResp.body.matchAll(/'([A-Za-z0-9$_]{3,7})'/g)) {
      const n = decodeGwtLong(m[1]);
      if (n >= 10000 && n <= 9999999) { revId = n; revIdEncoded = m[1]; break; }
    }
    if (!revId) throw new Error(`pdfdteInternet: no se pudo extraer ID de revisión de: ${creaResp.body.substring(0, 300)}`);
    console.log(` → ID de revisión: ${revId} (GWT: ${revIdEncoded})`);

    if (debugDir) {
      fs.writeFileSync(path.join(debugDir, `pdfte-crea-lista-resp.txt`), creaResp.body, 'utf8');
    }

    // ── Paso 3: subir cada PDF ────────────────────────────────────────────────
    const uploadUrl = `${GWT_BASE}upload`;
    let uploadedCount = 0;
    for (const pdfPath of pdfPaths) {
      const filename  = path.basename(pdfPath);
      const pdfData   = fs.readFileSync(pdfPath);
      const boundary  = `----WebKitFormBoundary${Date.now().toString(16)}`;

      // Construir multipart/form-data manualmente para soportar datos binarios
      const partFile = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="Filedata"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        pdfData,
        Buffer.from('\r\n'),
      ]);
      const partId  = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${revId}\r\n`);
      const partAmb = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ambiente"\r\n\r\nfalse\r\n`);
      const closing = Buffer.from(`--${boundary}--\r\n`);
      const formBody = Buffer.concat([partFile, partId, partAmb, closing]);

      const upResp = await makeReq(uploadUrl, {
        method: 'POST',
        body: formBody,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Referer': `${GWT_BASE}${permHash}.cache.html`,
          'x-dtreferer': GWT_BASE,
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        cookies,
      });

      if (upResp.status !== 200) {
        throw new Error(`pdfdteInternet upload ${filename} → HTTP ${upResp.status}: ${upResp.body.substring(0, 150)}`);
      }
      uploadedCount++;
      console.log(` ✓ [${uploadedCount}/${pdfPaths.length}] ${filename} → ${upResp.body.trim()}`);
    }

    // ── Paso 4: enviar al SII (solicitaRevisionSII) ────────────────────────
    // Params: Long id (revIdEncoded), String amb=Z
    const enviarBody =
      `7|0|6|${GWT_BASE}|${policyHash}|${GWT_SVC}|solicitaRevisionSII|` +
      `java.lang.Long/4227064769|Z|1|2|3|4|2|5|6|5|${revIdEncoded}|0|`;
    const enviarResp = await gwtPost(enviarBody);
    if (enviarResp.status !== 200 || !enviarResp.body.startsWith('//OK')) {
      throw new Error(`pdfdteInternet solicitaRevisionSII falló HTTP ${enviarResp.status}: ${enviarResp.body.substring(0, 200)}`);
    }

    if (debugDir) {
      fs.writeFileSync(path.join(debugDir, `pdfte-enviar-sii-resp.txt`), enviarResp.body, 'utf8');
    }

    console.log(` ✓ Solicitud enviada al SII correctamente (${pdfPaths.length} PDFs, revisión ${revId})`);
    process.stdout.write('\nMUESTRAS SUBIDAS EXITOSAMENTE\n');
    return { success: true, revId };
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
   * @param {string} [opts.correoSet=''] - Correo proveedor para el set
   * @returns {Promise<{success: boolean, setText?: string, error?: string}>}
   */
  async obtenerSetBoletaPortal({ setPath, correoSet = '' } = {}) {
    const https  = require('https');
    const crypto = require('crypto');
    const CBE_BASE   = 'https://www4.sii.cl/certBolElectDteInternet/';
    const CBE_PERM   = '0FC3D987613537E6E13E9BB93A406F13';
    const CBE_POLICY = '082D0AC4BC4D75A5DF38F116C53877D4';
    const CBE_SVC    = 'cl.sii.sdi.diii.certBolElectDte.web.client.service.Facade';

    const cookieJar = await this._obtenerCookiesSII();
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    const [rutNum, dvChar] = this.config.emisor.rut.replace(/\./g, '').split('-');
    const dvUp = dvChar.toUpperCase();

    const tlsOpts = {
      rejectUnauthorized: false, maxVersion: 'TLSv1.2',
      secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                   | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };
    const gwtPost = (bodyStr) => new Promise((resolve, reject) => {
      const buf = Buffer.from(bodyStr, 'utf-8');
      const req = https.request({
        hostname: 'www4.sii.cl', port: 443, path: '/certBolElectDteInternet/facade', method: 'POST',
        headers: {
          'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
          'X-GWT-Permutation': CBE_PERM,
          'X-GWT-Module-Base': CBE_BASE,
          'Cookie': cookieStr,
          'Content-Length': buf.length,
        },
        ...tlsOpts,
      }, (res) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString('utf-8'))); });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout gwtPost CBE')); });
      req.write(buf); req.end();
    });

    // recuperarRepresentantesVigentesUsuariosAutorizados -> obtener rutRepre/dvRepre
    const reprResp = await gwtPost(
      `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|recuperarRepresentantesVigentesUsuariosAutorizados|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|2|5|6|5|${rutNum}|7|`
    );
    // Response: //OK[...,["...","...RepreTo/...","<dv>","<rut>"],0,7]
    const reprMatch = reprResp.match(/"(d{1,2})","(d{7,8})"],0/);
    const dvRepreChar = reprMatch ? reprMatch[1] : (cookieJar['NETSCAPE_LIVEWIRE.dv']  || cookieJar['DV_NS']  || '');
    const rutRepreNum = reprMatch ? reprMatch[2] : (cookieJar['NETSCAPE_LIVEWIRE.rut'] || cookieJar['RUT_NS'] || '');
    if (!rutRepreNum) throw new Error('No se pudo obtener rutRepre (facade + cookies fallaron)');

    // obtenerPostulacionSeg -> requerido por portal antes de descarga
    await gwtPost(
      `7|0|9|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|obtenerPostulacionSeg|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|90|P90|1|2|3|4|4|5|6|6|6|5|${rutNum}|7|8|9|`
    );

    // DownloadFileServlet GET
    const dlUrl = `${CBE_BASE}DownloadFileServlet?rutEmpresa=${rutNum}&dvEmpresa=${dvUp}&rutRepre=${rutRepreNum}&dvRepre=${dvRepreChar}&mailProvSw=${encodeURIComponent(correoSet)}`;
    console.log(` -> Descargando set boleta: DownloadFileServlet?rutEmpresa=${rutNum}&dvEmpresa=${dvUp}...`);

    const setText = await new Promise((resolve, reject) => {
      const req = https.get(dlUrl, {
        headers: {
          'Cookie': cookieStr,
          'Referer': `${CBE_BASE}?SET=1`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/plain,text/html,*/*',
        },
        ...tlsOpts,
      }, (res) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString('utf-8'))); });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout DownloadFileServlet boleta')); });
    });

    if (!setText || setText.trim().length < 10)
      throw new Error(`DownloadFileServlet boleta vacio (${setText?.length ?? 0} chars). Verificar sesion SII.`);

    if (setPath) {
      const nodePath = require('path');
      fs.mkdirSync(nodePath.dirname(setPath), { recursive: true });
      fs.writeFileSync(setPath, setText, 'utf-8');
      console.log(` OK Set boleta guardado en: ${setPath}`);
    }
    console.log(` OK Set de pruebas boleta obtenido (${setText.length} chars)`);
    return { success: true, setText };
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
    const https  = require('https');
    const crypto = require('crypto');
    const CBE_BASE   = 'https://www4.sii.cl/certBolElectDteInternet/';
    const CBE_PERM   = '0FC3D987613537E6E13E9BB93A406F13';
    const CBE_POLICY = '082D0AC4BC4D75A5DF38F116C53877D4';
    const CBE_SVC    = 'cl.sii.sdi.diii.certBolElectDte.web.client.service.Facade';

    const cookieJar = await this._obtenerCookiesSII();
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    const [rutNum, dvChar] = this.config.emisor.rut.replace(/\./g, '').split('-');
    const dvUp       = dvChar.toUpperCase();
    const trackIdStr = String(trackId);

    const tlsOpts = {
      rejectUnauthorized: false, maxVersion: 'TLSv1.2',
      secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                   | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };
    const gwtPost = (bodyStr) => new Promise((resolve, reject) => {
      const buf = Buffer.from(bodyStr, 'utf-8');
      const req = https.request({
        hostname: 'www4.sii.cl', port: 443, path: '/certBolElectDteInternet/facade', method: 'POST',
        headers: {
          'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
          'X-GWT-Permutation': CBE_PERM,
          'X-GWT-Module-Base': CBE_BASE,
          'Cookie': cookieStr,
          'Content-Length': buf.length,
        },
        ...tlsOpts,
      }, (res) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString('utf-8'))); });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout gwtPost CBE')); });
      req.write(buf); req.end();
    });

    // ingresarTrackId — GWT body format from BOLETA_SET2.har
    // 7 params: (Integer rutNum, String dvChar, String null, String "90", Integer 0, String null, String trackId)
    const body = `7|0|9|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|ingresarTrackId|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|90|${trackIdStr}|1|2|3|4|7|5|6|6|6|5|6|6|5|${rutNum}|7|0|8|0|0|9|`;
    console.log(` -> certBolElectDteInternet/?SET=2: ingresarTrackId trackId=${trackIdStr}...`);
    const resp = await gwtPost(body);
    console.log(` OK ingresarTrackId respuesta: ${resp.substring(0, 120)}`);

    if (!resp.startsWith('//OK'))
      return { success: false, error: `ingresarTrackId fallo: ${resp.substring(0, 200)}` };

    return { success: true, respuesta: resp };
  }

  /**
   * Completa la declaración de cumplimiento de Boleta Electrónica en el portal SII.
   * Marca los checkboxes de requisitos y rellena el formulario de proveedor.
   * @param {Object} opts
   * @param {string} [opts.linkConsulta='www.sii.cl']
   * @param {string} opts.rutProveedor
   * @param {string} opts.nombreProveedor
   * @param {string} opts.correoProveedor
   * @returns {Promise<{success: boolean, mensaje?: string, error?: string}>}
   */
  async completarDeclaracionBoletaPortal({
    linkConsulta    = 'www.sii.cl',
    rutProveedor    = '',
    nombreProveedor = '',
    correoProveedor = '',
  } = {}) {
    const https  = require('https');
    const crypto = require('crypto');
    const CBE_BASE   = 'https://www4.sii.cl/certBolElectDteInternet/';
    const CBE_PERM   = '0FC3D987613537E6E13E9BB93A406F13';
    const CBE_POLICY = '082D0AC4BC4D75A5DF38F116C53877D4';
    const CBE_SVC    = 'cl.sii.sdi.diii.certBolElectDte.web.client.service.Facade';

    const cookieJar = await this._obtenerCookiesSII();
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    const [rutNum, dvChar] = this.config.emisor.rut.replace(/\./g, '').split('-');
    const dvUp       = dvChar.toUpperCase();
    const razonSocial = this.config.emisor.razon_social || this.config.emisor.razonSocial || '';

    const tlsOpts = {
      rejectUnauthorized: false,
      maxVersion: 'TLSv1.2',
      secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                   | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    };
    const gwtPost = (bodyStr) => new Promise((resolve, reject) => {
      const buf = Buffer.from(bodyStr, 'utf-8');
      const req = https.request({
        hostname: 'www4.sii.cl', port: 443, path: '/certBolElectDteInternet/facade', method: 'POST',
        headers: {
          'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
          'X-GWT-Permutation': CBE_PERM,
          'X-GWT-Module-Base': CBE_BASE,
          'Cookie': cookieStr,
          'Content-Length': buf.length,
        },
        ...tlsOpts,
      }, (res) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString('utf-8'))); });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout gwtPost CBE declaracion')); });
      req.write(buf); req.end();
    });

    // 1. Obtener representante legal vigente
    const reprResp = await gwtPost(
      `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|recuperarRepresentantesVigentesUsuariosAutorizados|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|2|5|6|5|${rutNum}|7|`
    );
    const reprTableStr = reprResp.substring(reprResp.lastIndexOf(',[') + 1, reprResp.lastIndexOf('],0,7]') + 1);
    let rutRepreNum = '';
    try {
      const reprTable = JSON.parse(reprTableStr);
      rutRepreNum = reprTable.filter(s => /^\d{7,8}$/.test(s)).pop() || '';
    } catch {}
    if (!rutRepreNum) return { success: false, error: 'No se pudo obtener representante vigente (facade CBE)' };

    // 2. Verificar estado portal — debe ser P90 (SOK recibido, listo para declarar)
    const estadoResp = await gwtPost(
      `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|obtenerEstadoAutorizaEmp|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|4|5|6|5|6|5|${rutNum}|7|5|90|0|`
    );
    if (!estadoResp.includes('P90')) {
      const estadoMatch = estadoResp.match(/"(P\d+)"/);
      const estado = estadoMatch ? estadoMatch[1] : '(desconocido)';
      return { success: false, pendingSok: true, error: `Estado portal no es P90 (es ${estado}) — espere SOK del SII` };
    }

    // 3. Obtener datos de postulacion: fchAutorizacion y longCharValue
    const postulResp = await gwtPost(
      `7|0|9|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|obtenerPostulacionSeg|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|90|P90|1|2|3|4|4|5|6|6|6|5|${rutNum}|7|8|9|`
    );
    const postulTableStr = postulResp.substring(postulResp.lastIndexOf(',[') + 1, postulResp.lastIndexOf('],0,7]') + 1);
    let fchAutorizacion = '';
    try {
      const postulTable = JSON.parse(postulTableStr);
      fchAutorizacion = postulTable.find(s => /^\d{2}\/\d{2}\/\d{4}$/.test(s)) || '';
    } catch {}
    const longMatch = /'([^']+)'/.exec(postulResp);
    const longCharValue = longMatch ? longMatch[1] : '0';

    // 4. Autorizar empresa boleta produccion
    const fechaHoy = this._getFechaHoy();
    const authBody =
      `7|0|23|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|autorizarEmpresaBolProd|` +
      `cl.sii.sdi.diii.certBolElectDte.to.PostulSegHistInsUpdTo/138688689|P91|BVE|` +
      `java.lang.Integer/3438268394|${dvUp}|` +
      `cl.sii.sdi.diii.certBolElectDte.to.TdtEmpresaAutorizadaTo/2240026086|8|SII|` +
      `${fechaHoy}|${correoProveedor}|${nombreProveedor}|19|S|${linkConsulta}|` +
      `java.util.ArrayList/4159755760|cl.sii.sdi.diii.certBolElectDte.to.DocumentoAutorizadoTo/493967287|` +
      `${fchAutorizacion}|java.lang.Long/4227064769|${razonSocial}|` +
      `1|2|3|4|1|5|5|6|0|7|8|90|0|0|0|0|9|0|10|0|7|9|9|11|12|13|13|13|14|15|16|17|8|` +
      `${rutNum}|8|${rutNum}|8|${rutRepreNum}|18|13|13|0|19|2|20|0|0|9|11|21|0|0|0|0|0|0|8|` +
      `${rutNum}|8|${rutRepreNum}|22|${longCharValue}|-11|8|39|0|20|0|0|9|11|21|0|0|0|0|0|0|8|` +
      `${rutNum}|8|${rutRepreNum}|-11|-11|8|41|0|0|23|-11|0|8|${rutNum}|0|0|`;

    console.log(` -> autorizarEmpresaBolProd rutNum=${rutNum} rutRepreNum=${rutRepreNum} fchAutorizacion=${fchAutorizacion} longCharValue=${longCharValue}`);
    const authResp = await gwtPost(authBody);
    console.log(` OK autorizarEmpresaBolProd respuesta: ${authResp.substring(0, 200)}`);

    if (!authResp.startsWith('//OK') || !authResp.includes('DECLARACION EFECTUADA')) {
      return { success: false, error: `autorizarEmpresaBolProd respuesta inesperada: ${authResp.substring(0, 300)}` };
    }
    return { success: true, mensaje: 'DECLARACION EFECTUADA' };
  }

  /**
   * Verifica si la empresa ya está autorizada para emitir Boletas Electrónicas tipo 39
   * en PRODUCCIÓN (palena.sii.cl). Si el tipo 39 aparece en el select de
   * of_solicita_folios_dcto significa que el SII ya certificó la empresa.
   *
   * También consulta el avance en certificación (maullin) como dato adicional.
   *
   * @returns {Promise<{
   *   autorizadaProduccion: boolean,
   *   autorizadaCertificacion: boolean,
   *   mensaje: string,
   *   tiposDisponiblesProduccion: number[],
   *   estadoCertificacion: string|null
   * }>}
   */
  async verificarAutorizacionBoleta() {
    const https     = require('https');
    const cookieJar = await this._obtenerCookiesSII();
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');

    const fetchHtml = (url) => new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'text/html,*/*',
        },
        rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    });

    const result = {
      autorizadaProduccion:       false,
      autorizadaCertificacion:    false,
      mensaje:                    '',
      tiposDisponiblesProduccion: [],
      estadoCertificacion:        null,
    };

    // ── 1. Verificar producción: of_solicita_folios_dcto en palena ─────────
    try {
      const htmlProd = await fetchHtml('https://palena.sii.cl/cvc_cgi/dte/of_solicita_folios_dcto');
      if (this.config.debugDir) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(this.config.debugDir, `verificar-boleta-produccion-${ts}.html`),
          htmlProd, 'utf-8'
        );
      }
      const matches = [...htmlProd.matchAll(/<option[^>]+value="(\d+)"[^>]*>/gi)];
      result.tiposDisponiblesProduccion = matches.map(m => parseInt(m[1], 10)).filter(n => n > 0);
      result.autorizadaProduccion = result.tiposDisponiblesProduccion.includes(39);
      console.log(` ✓ Producción — tipos disponibles: [${result.tiposDisponiblesProduccion.join(', ')}] | Boleta 39: ${result.autorizadaProduccion ? '✅ SÍ' : '❌ NO'}`);
    } catch (e) {
      console.log(` [!] No se pudo verificar producción: ${e.message}`);
    }

    // ── 2. Verificar certificación: pe_avance6 en maullin ─────────────────
    try {
      const htmlCert = await fetchHtml('https://maullin.sii.cl/cvc_cgi/dte/pe_avance6');
      if (this.config.debugDir) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(this.config.debugDir, `verificar-boleta-certificacion-${ts}.html`),
          htmlCert, 'utf-8'
        );
      }
      // Buscar fila de boleta en tabla de avance
      const boletaRow = htmlCert.match(/BOLETA[^<]*<\/[^>]+>\s*<[^>]+><b>([^<]+)<\/b>/i);
      if (boletaRow) {
        result.estadoCertificacion = boletaRow[1].trim();
        result.autorizadaCertificacion = /conform|aprobad|autoriz/i.test(result.estadoCertificacion);
      }
      if (!result.estadoCertificacion && /autorizada.*boleta|boleta.*autorizada/i.test(htmlCert)) {
        result.autorizadaCertificacion = true;
        result.estadoCertificacion = 'AUTORIZADA';
      }
      console.log(` ✓ Certificación — estado boleta: ${result.estadoCertificacion || '(no encontrado)'} | Autorizada: ${result.autorizadaCertificacion ? '✅ SÍ' : '❌ NO'}`);
    } catch (e) {
      console.log(` [!] No se pudo verificar certificación: ${e.message}`);
    }

    result.mensaje = result.autorizadaProduccion
      ? '✅ Empresa autorizada para emitir Boleta Electrónica (tipo 39) en producción'
      : result.autorizadaCertificacion
        ? '⏳ Boleta certificada en SII pero aún no disponible en producción'
        : '❌ Boleta NO autorizada — certificación incompleta';

    return result;
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
