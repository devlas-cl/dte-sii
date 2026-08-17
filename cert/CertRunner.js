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
const { resolveArtifactDir } = require('../utils/paths');
const { registrarHttpDebug } = require('../utils/httpDebug');

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
 * @property {string} [stateDir] - Estado que persiste entre corridas (periodo-libros, ltc-totales). Default: debugDir.
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
    // El consumidor inyecta el directorio (ver utils/paths.resolveRunDir para el layout
    // recomendado). El fallback ya no depende de process.cwd(), que cambiaba según desde
    // dónde se lanzara el proceso y hacía impredecible dónde quedaban los artefactos.
    this.debugDir = resolveArtifactDir(config.debugDir, config.debugDir ? '' : 'cert-v2');
    /**
     * Directorio del estado que SOBREVIVE a la corrida, separado de `debugDir`.
     *
     * `debugDir` es por corrida (y por etapa, cuando lo inyecta un orquestador): sirve
     * para el rastro, que justamente se quiere aislado. Pero hay estado que NO es rastro
     * y cuyo valor está en acumularse entre corridas — sobre todo `periodo-libros.json`,
     * que guarda hasta qué período retrocedió la búsqueda de un mes contable abierto.
     *
     * Guardarlo en `debugDir` lo hacía frágil: si el proceso moría (timeout, SIGKILL)
     * antes del volcado final al directorio estable, se perdía TODA la búsqueda y el
     * intento siguiente arrancaba desde el mismo período de siempre. En una empresa con
     * muchas pruebas encima, donde el SII rechaza decenas de períodos seguidos con "LNC
     * - Libro Cerrado", eso significa no avanzar nunca por más que se reintente.
     *
     * Por defecto es `debugDir`, así que el comportamiento no cambia para quien no lo
     * inyecte.
     */
    this.stateDir = config.stateDir || this.debugDir;
    this.sessionPath = config.sessionPath || path.join(this.debugDir, 'session.json');
    
    // Componentes (lazy init)
    this._certificado = null;
    this._folioService = null;
    this._folioHelper = null;
    this._siiCert = null;
    this._setsProvider = null;
    this._estructuras = null;
    // CAF timbrados por adelantado para toda la corrida (ver precargarCafsDeSets).
    // Mientras sea null, cada set pide los suyos como antes.
    this._cafsPrecargados = null;
    this._planPrecargado  = null;

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
        // El registro de folios ya anulados debe sobrevivir a la corrida, o cada
        // ejecución vuelve a intentar anular los mismos folios y los pierde igual.
        stateDir: this.stateDir,
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
    if (options.hydrateOnly) {
      // Solo hidrata this._estructuras desde memoria o disco — NUNCA llama al SII. Necesario
      // como modo aparte porque el resto de esta función SIEMPRE pide un set nuevo al SII
      // (forceRefresh: true, ver abajo), lo que REINICIA la postulación real completa. Un
      // llamado pensado solo para "popular estado" no puede arriesgarse a tocar esa rama.
      if (!this._estructuras) {
        const estructurasPath = path.join(this.debugDir, 'estructuras.json');
        if (fs.existsSync(estructurasPath)) {
          this._estructuras = JSON.parse(fs.readFileSync(estructurasPath, 'utf8'));
        }
      }
      return { success: !!this._estructuras, estructuras: this._estructuras, hydrated: true };
    }

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
   * Inyecta estructuras ya descargadas (desde BD/caché) sin pedirlas al SII. Formaliza lo que
   * hoy hacen los callers a mano (`runner._estructuras = JSON.parse(...)`) con acceso directo
   * a un campo "privado". Útil para reanudar en una fase posterior (libros, simulación) sin
   * volver a llamar obtenerSets() — que SIEMPRE resetea la postulación real (forceRefresh).
   * @param {Object} estructurasJson
   */
  setEstructuras(estructurasJson) {
    this._estructuras = estructurasJson;
  }

  /**
   * Inyecta resultados previos (trackIds de sets ya enviados) en this.resultados sin
   * re-ejecutar los envíos. Hace merge — no borra resultados ya presentes que no vengan en
   * resultadosJson. Formaliza `runner.resultados[k] = {...}` (acceso directo hoy en
   * run-certificacion.js) con un método explícito.
   * @param {Object} resultadosJson
   */
  setResultados(resultadosJson) {
    Object.assign(this.resultados, resultadosJson);
  }

  /**
   * Timbra de una sola vez TODOS los folios que la corrida va a necesitar, sumados por
   * tipo entre los cuatro sets. Llamar antes de ejecutar el primer set.
   *
   * El problema que resuelve (medido el 13/08/2026, RUT 79888999-0): cada set pedía sus
   * propios folios cuando le tocaba, así que del tipo 56 se pedían tres tandas separadas
   * —básico 1, exenta 2, compra 1— en la misma corrida. El SII raciona el timbraje según
   * cuántos folios tengas autorizados sin usar, así que la primera tanda le bajaba el tope
   * de 100 a 1 y la segunda se estrellaba con `MAX_AUTOR=1 < 2`. La corrida moría a mitad,
   * y lo único que la destrababa era esperar a que el SII procesara lo ya emitido.
   *
   * Pedir el total junto no rompe el orden de emisión, que sí es obligatorio: las notas de
   * crédito y débito llevan `Referencia` al documento que corrigen (ver SetBasico), o sea
   * que se emiten después de sus facturas, set por set. Pero el timbraje es independiente
   * de la emisión — se pueden tener folios en mano sin haber emitido nada — así que es lo
   * único de la secuencia que sí se puede consolidar.
   *
   * @param {Object[]} planes - cafRequired de cada set, ej. [{33:4,56:1}, {34:3,56:2}]
   * @returns {Promise<Object>} { 33: cafPath, 56: cafPath, ... }
   */
  async precargarCafsDeSets(planes) {
    const total = {};
    for (const plan of planes) {
      for (const [tipoDte, cantidad] of Object.entries(plan || {})) {
        total[tipoDte] = (total[tipoDte] || 0) + Number(cantidad || 0);
      }
    }

    const resumen = Object.entries(total).map(([t, c]) => `${t}x${c}`).join(', ');
    console.log(`\n Timbrando el total de la corrida de una vez: ${resumen}`);

    this._cafsPrecargados = await this.solicitarCafs(total);
    this._planPrecargado  = total;
    return this._cafsPrecargados;
  }

  /**
   * Devuelve los CAF precargados que le tocan a un set.
   *
   * No vuelve a limpiar `folioHelper.counters`: con un CAF por tipo compartido entre sets,
   * el contador tiene que seguir avanzando donde lo dejó el set anterior. Reiniciarlo haría
   * que dos sets emitieran el MISMO folio, que el SII rechaza como duplicado.
   * @private
   */
  _cafsDelPlan(cafRequired, nombreSet) {
    const cafs = {};
    for (const tipoDte of Object.keys(cafRequired)) {
      const cafPath = this._cafsPrecargados[tipoDte];
      if (!cafPath) {
        throw new Error(
          `${nombreSet} necesita folios del tipo ${tipoDte} pero no se timbraron en la ` +
          `precarga (se timbró: ${Object.keys(this._cafsPrecargados).join(', ') || 'nada'}). ` +
          `Es un error de programación: el plan de precarga quedó desalineado con los sets.`
        );
      }
      cafs[tipoDte] = cafPath;
    }
    return cafs;
  }

  /**
   * Busca en disco un CAF de este tipo, timbrado por una corrida anterior, que todavía
   * tenga folios suficientes sin usar. Devuelve null si no hay ninguno servible.
   *
   * Solo mira CAF del ambiente y RUT actuales (`findLatestCaf` ya acota por eso) y exige
   * que el rango alcance para lo que se necesita: un CAF corto no sirve, porque la
   * simulación arma un plan fijo de documentos y muere si falta un folio.
   * @private
   */
  /**
   * Registro de rangos de folios ya emitidos, por RUT.
   *
   * ⚠️ Va por RANGO y no por ruta de archivo, y eso no es un detalle de implementación.
   * El mismo CAF se guarda en DOS árboles distintos con el mismo contenido:
   *
   *   debug/auto-caf/{rut}/{ts}/{tipo}/archivo.xml
   *   debug/caf/{ambiente}/{rut}/{tipo}/{ts}/caf-{tipo}-{desde}-{hasta}.xml
   *
   * `findLatestCaf` puede devolver cualquiera de las dos. Marcar la copia que se usó deja
   * la otra intacta, y la etapa siguiente la encuentra "sin usar" y repite los folios.
   * Pasó el 14/08/2026: ENVIAR_SETS marcó `caf-33-4523-4526.xml` a las 03:53:00 y
   * SIMULACION reusó `auto-caf/.../33/archivo.xml` a las 03:53:5x — los mismos folios.
   *
   * Lo que identifica a un folio es (RUT, tipo, número), no dónde quedó el archivo.
   * @private
   */
  _foliosUsadosPath() {
    const rutLimpio = String(this.config.emisor.rut || '').replace(/[^0-9kK]/g, '');
    return path.join(this.stateDir, `folios-usados-${rutLimpio}.json`);
  }

  /** @returns {Record<string, Array<[number, number]>>} rangos consumidos por tipo de DTE */
  _cargarFoliosUsados() {
    try {
      const p = this._foliosUsadosPath();
      if (!fs.existsSync(p)) return {};
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (data && typeof data === 'object') ? data : {};
    } catch { return {}; }
  }

  /** Lee (tipo, desde, hasta) de un CAF en disco. `null` si no se pudo. */
  _rangoDelCaf(cafPath) {
    try {
      const { CAF } = require('../index');
      const caf = new CAF(fs.readFileSync(cafPath, 'utf8'));
      const tipo = Number(caf.da?.TD);
      const desde = caf.getFolioDesde();
      const hasta = caf.getFolioHasta();
      if (!Number.isFinite(tipo) || !Number.isFinite(desde) || !Number.isFinite(hasta)) return null;
      return { tipo, desde, hasta };
    } catch { return null; }
  }

  /**
   * Marca los folios de estos CAF como emitidos, para que no se reusen nunca.
   *
   * Se llama en un `finally`, apenas se intentó el envío y sin mirar si salió bien: si
   * el envío viajó, el SII ya vio esos folios aunque después lo rechace. Quemar un folio
   * de más es barato; repetirlo cuesta la etapa entera.
   * @private
   */
  _marcarCafsConsumidos(cafs) {
    const registro = this._cargarFoliosUsados();
    let cambio = false;

    for (const ruta of Object.values(cafs || {})) {
      for (const p of (Array.isArray(ruta) ? ruta : [ruta])) {
        // El `.usado` se mantiene: no es la fuente de verdad, pero deja el estado a la
        // vista de quien mire el directorio.
        try { fs.writeFileSync(`${p}.usado`, new Date().toISOString(), 'utf8'); }
        catch (e) { console.warn(`[CertRunner] No se pudo marcar ${p} como usado: ${e.message}`); }

        const r = this._rangoDelCaf(p);
        if (!r) continue;
        const clave = String(r.tipo);
        registro[clave] = registro[clave] || [];
        if (!registro[clave].some(([d, h]) => d === r.desde && h === r.hasta)) {
          registro[clave].push([r.desde, r.hasta]);
          cambio = true;
        }
      }
    }

    if (!cambio) return;
    try {
      fs.mkdirSync(path.dirname(this._foliosUsadosPath()), { recursive: true });
      fs.writeFileSync(this._foliosUsadosPath(), JSON.stringify(registro, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[CertRunner] No se pudo guardar el registro de folios usados: ${e.message}`);
    }
  }

  /** ¿Algún folio de [desde, hasta] ya se emitió? */
  _rangoYaConsumido(tipoDte, desde, hasta) {
    const rangos = this._cargarFoliosUsados()[String(tipoDte)] || [];
    return rangos.some(([d, h]) => desde <= h && hasta >= d);
  }

  _cafReusable(tipoDte, cantidad) {
    try {
      const cafPath = this.folioService.findLatestCaf(tipoDte);
      if (!cafPath || !fs.existsSync(cafPath)) return null;
      // Ya se emitió con él: reusarlo repetiría folios y el SII rechaza el envío entero.
      if (fs.existsSync(`${cafPath}.usado`)) {
        console.log(` Tipo ${tipoDte}: el CAF previo ya se usó para emitir — se pedirá uno nuevo`);
        return null;
      }
      const rango = this._rangoDelCaf(cafPath);
      if (rango && this._rangoYaConsumido(tipoDte, rango.desde, rango.hasta)) {
        console.log(` Tipo ${tipoDte}: los folios ${rango.desde}-${rango.hasta} ya se emitieron `
          + '(otra copia del mismo CAF) — se pedirá uno nuevo');
        return null;
      }

      // Require local, igual que en _construirCafObjects (línea ~2110): `../index` cierra
      // el ciclo con este archivo, así que importarlo arriba deja CAF sin definir.
      const { CAF } = require('../index');
      const caf = new CAF(fs.readFileSync(cafPath, 'utf8'));

      // Doble chequeo del RUT, aunque findLatestCaf ya filtre. Firmar un timbre con el CAF
      // de otro contribuyente hace que el SII rechace el envío ENTERO con `RFR - Rechazado
      // por Error en Firma`, y el síntoma aparece etapas más adelante (la declaración de
      // simulación se traba porque el envío tiene rechazos). Un fallo así de caro no puede
      // depender de que una función de otro archivo siga filtrando bien.
      const rutCaf = String(caf.da?.RE ?? '').replace(/\./g, '').trim().toUpperCase();
      const rutMio = String(this.config.emisor.rut).replace(/\./g, '').trim().toUpperCase();
      if (rutCaf !== rutMio) {
        console.warn(
          `[CertRunner] CAF previo del tipo ${tipoDte} DESCARTADO: es del RUT ${rutCaf}, ` +
          `no del emisor ${rutMio} (${cafPath})`
        );
        return null;
      }

      const desde = caf.getFolioDesde();
      const hasta = caf.getFolioHasta();
      if (!Number.isFinite(desde) || !Number.isFinite(hasta)) return null;

      // Cuántos folios de ese rango quedan libres según el contador de ESTA corrida.
      // Si el helper ya consumió parte del rango, lo que queda es lo que sirve.
      const yaUsados = this.folioHelper.usedFolios.get(tipoDte)?.size ?? 0;
      const disponibles = (hasta - desde + 1) - yaUsados;
      if (disponibles < cantidad) return null;

      return { path: cafPath, desde, hasta };
    } catch (err) {
      // Un CAF ilegible no puede tumbar la corrida: se pide uno nuevo y listo.
      console.warn(`[CertRunner] No se pudo evaluar el CAF previo del tipo ${tipoDte}: ${err.message}`);
      return null;
    }
  }

  /**
   * Solicita CAFs frescos para los tipos especificados
   * @param {Object} cafRequired - { 33: 4, 56: 1, 61: 3 }
   * @returns {Promise<Object>} { 33: cafPath, 56: cafPath, ... }
   */
  async solicitarCafs(cafRequired) {
    const cafs = {};
    // Lo que el sondeo vio en ESTA llamada. Se reinicia para no arrastrar el estado del
    // SII de una corrida anterior: el bloqueo de timbraje se destraba y se vuelve a
    // trabar, así que un dato viejo mandaría a reobtener cuando ya no hace falta.
    this._topeConsultado = {};

    // Limpiar contadores para nuevos CAFs
    this.folioHelper.counters.clear();
    this.folioHelper.usedFolios.clear();
    
    // Limpieza previa de folios timbrados y nunca utilizados.
    //
    // Cada corrida de simulación regenera su plan de documentos completo, así que
    // los folios que quedaron de un intento fallido NO se reutilizan jamás: son
    // basura garantizada. Pero el SII los cuenta como "disponibles sin utilizar"
    // (FOLIOS_DISP) y baja el tope de timbraje (MAX_AUTOR) hasta bloquearlo del
    // todo. Observado 2026-07-22 en un RUT de certificación: 7 intentos fallidos
    // dejaron 21 folios muertos en los tipos 34 y 52, y llevaron a los tipos 56 y
    // 61 a bloqueo duro irreversible (sin folios anulables restantes).
    //
    // Limpiar ANTES de pedir rompe ese espiral. Es seguro: solo se anulan folios
    // que el SII reporta como no recepcionados, y los que ya fueron anulados o
    // usados se rechazan sin efecto.
    //
    // Pero se limpia SOLO SI HACE FALTA (ver el sondeo dentro del loop). Hacerlo
    // siempre era caro y casi nunca útil, y "se rechazan sin efecto" es engañoso: sin
    // efecto en el SII, sí, pero cada rechazo cuesta requests y minutos de corrida.
    for (const tipoDte of Object.keys(cafRequired)) {
      try {
        // ── ¿Hace falta limpiar? ────────────────────────────────────────────────
        // Antes esto se ejecutaba SIEMPRE, y casi nunca servía. Medido el 11/08/2026
        // en una corrida real: 87 intentos de anulación, 0 anulados, todos rechazados
        // por "ya anulado" — mientras el SII autorizaba 73 folios de factura y solo
        // hacían falta 4. Minutos de corrida y ~180 requests al SII para nada.
        //
        // El sondeo cuesta ~3 requests, no emite nada y responde la única pregunta
        // que importa: ¿el SII está racionando este tipo?
        const tope = await this.folioService.consultarTope({ tipoDte: Number(tipoDte) });
        // Se guarda para el bucle de abajo: ahí se decide si conviene intentar la
        // reobtención (solo tiene sentido con el timbraje bloqueado) y sondear de nuevo
        // sería otro viaje al portal para saber algo que ya sabemos.
        this._topeConsultado = { ...(this._topeConsultado ?? {}), [tipoDte]: tope };
        const necesarios = cafRequired[tipoDte];

        // `sinTope` = el SII ni siquiera publica MAX_AUTOR, o sea no está limitando
        // este tipo. Limpiar ahí es puro costo.
        //
        // Con tope publicado alcanza con que el cupo CUBRA lo necesario. Antes se exigía
        // un margen de 3x para "actuar antes de quedar contra la pared", pero medido el
        // 13/08/2026 (RUT 79888999-0) ese margen disparaba la limpieza teniendo cupo de
        // sobra —tipo 61 con MAX_AUTOR=6 para 3 folios, tipo 33 con 4 para 4— y en los
        // tres tipos el resultado fue `0 anulados`: el SII rechazó cada anulación.
        //
        // O sea que la limpieza preventiva no compra nada. Y si algún día funcionara sería
        // peor: el SII cuenta los folios anulados de los últimos 6 meses EN CONTRA del cupo
        // (ver el comentario largo más abajo), así que anular de más acerca el bloqueo en
        // vez de alejarlo. Se limpia solo cuando el cupo realmente no da.
        // `bloqueado` gana sobre todo lo demás: el SII no autoriza nada para este tipo y
        // no publica MAX_AUTOR, así que sin este chequeo `sinTope` daba true y se saltaba
        // la limpieza — que es lo único que puede destrabarlo.
        const holgado = !tope.bloqueado
          && (tope.sinTope || (tope.maxAutor !== null && tope.maxAutor >= necesarios));
        if (holgado) {
          console.log(
            ` Tipo ${tipoDte}: sin limpieza previa — ` +
            (tope.sinTope
              ? 'el SII no está racionando este tipo'
              : `MAX_AUTOR=${tope.maxAutor} para ${necesarios} folio(s) necesarios`)
          );
          continue;
        }
        // Un solo mensaje según el motivo: con el timbraje bloqueado el SII no publica
        // MAX_AUTOR ni FOLIOS_DISP, así que el texto de racionamiento saldría con `null`
        // en los dos números y confundiría a quien lea el log.
        console.warn(
          tope.bloqueado
            ? `[CertRunner] Tipo ${tipoDte}: el SII tiene el timbraje BLOQUEADO para este tipo ` +
              `(no autoriza folios nuevos) — limpiando folios sin usar antes de pedir...`
            : `[CertRunner] Tipo ${tipoDte}: MAX_AUTOR=${tope.maxAutor} ajustado para ${necesarios} ` +
              `folio(s) (FOLIOS_DISP=${tope.foliosDisp}) — limpiando folios sin usar...`
        );

        // ACOTADA a propósito. Sin corte por antigüedad la limpieza barre el historial
        // completo de la empresa: en un RUT con volumen real eso son cientos de
        // anulaciones contra el SII y, peor, el SII cuenta los folios anulados de los
        // últimos 6 meses EN CONTRA del cupo de timbraje — la limpieza terminaría
        // provocando el bloqueo que intenta evitar. Verificado 2026-07-22: sin acotar
        // anuló 296 folios de un RUT (rango 1851–2909) antes de detenerla a mano.
        //
        // Pero la ventana no puede ser la misma en los dos ambientes:
        //
        //   producción  — el historial son documentos reales del comercio. Anular ahí es
        //                 destructivo y el riesgo de arriba es el que manda: 1 día.
        //   maullin     — TODO el historial es de pruebas, propias o de corridas viejas.
        //                 Con 1 día quedaba un callejón sin salida: los folios que
        //                 bloquean el timbraje suelen ser de semanas atrás, el filtro los
        //                 descartaba antes de intentarlos, y la corrida se quedaba
        //                 reintentando para siempre contra algo que nunca iba a cambiar.
        //                 Caso real (14/08/2026, RUT 76543210-K): tipo 56 bloqueado por
        //                 folios del 22-07, seis intentos idénticos, cero anulados.
        //
        // Ojo: esto es el ÚLTIMO recurso. Antes de llegar acá se intenta reusar el CAF
        // previo (ver _cafReusable), que resuelve el mismo bloqueo sin anular nada y sin
        // gastar el cupo de timbraje. Anular es para cuando el folio quedó autorizado
        // pero su CAF ya no está en disco.
        const DIAS_LIMPIEZA = this.ambiente === 'produccion' ? 1 : 180;
        const limpieza = await this.folioService.anularFolios({
          tipoDte: Number(tipoDte),
          soloUltimosDias: DIAS_LIMPIEZA,
          maxRangos: 10,
        });
        if (limpieza.totalAnulados > 0) {
          console.log(
            ` Tipo ${tipoDte}: ${limpieza.totalAnulados} folio(s) sin usar de intentos previos anulados`
          );
        }
      } catch (err) {
        // No es fatal: si la limpieza falla, la solicitud de abajo igual puede
        // funcionar, y si no, solicitarCafExacto reintenta anulando.
        console.warn(`[CertRunner] Limpieza previa tipo ${tipoDte} falló: ${err.message}`);
      }
    }

    for (const [tipoDte, cantidad] of Object.entries(cafRequired)) {
      emitProgress(STEPS.CAF_REQUESTING, { tipo: Number(tipoDte) });

      // ── ¿Ya tenemos folios de un intento anterior? ──────────────────────────
      //
      // Cuando una etapa falla DESPUÉS de haber timbrado algunos tipos (típico: se cae en
      // el último y se pierde todo), el reintento volvía a pedir todo de cero. Los folios
      // del intento anterior quedaban timbrados y sin usar, y el SII cuenta exactamente eso
      // para negar el timbraje: "usted tiene disponible una cantidad de folios suficiente".
      //
      // O sea que cada reintento empeoraba el bloqueo que intentaba superar. Medido el
      // 14/08/2026 (RUT 76543210-K): 6 reintentos de ENVIAR_SETS quemaron 66 folios
      // —tipos 33, 34, 46 y 52, seis rangos cada uno— sin emitir un solo documento,
      // mientras el tipo 56 seguía bloqueado.
      //
      // Reusarlos es seguro: los sets se envían recién cuando TODOS los CAF están en mano,
      // así que si el intento anterior falló, esos folios nunca se emitieron.
      const previo = this._cafReusable(Number(tipoDte), Number(cantidad));
      if (previo) {
        cafs[tipoDte] = previo.path;
        emitProgress(STEPS.CAF_OK, { tipo: Number(tipoDte) });
        console.log(` ✓ CAF tipo ${tipoDte} reusado del intento anterior (folios ${previo.desde}-${previo.hasta})`);
        continue;
      }

      console.log(` Tipo ${tipoDte}: ${cantidad} folios...`);

      // ── Con el timbraje bloqueado, recuperar antes que pedir ────────────────
      //
      // El SII bloquea el timbraje cuando el contribuyente ya tiene folios sin usar, y su
      // propio mensaje da la salida: "debe emitir y enviar documentos electrónicos al SII
      // o anular folios". Emitir es lo que levanta el bloqueo; anular lo AGRAVA, porque
      // los folios anulados pesan 6 meses en contra del cupo.
      //
      // Para emitir hace falta el CAF de esos folios, y la reobtención del portal lo
      // devuelve sin gastar cupo. Por eso va acá: después de reusar lo que hay en disco y
      // antes de `solicitarCafExacto`, que pide folios nuevos y, si falla, anula.
      //
      // Solo se intenta con el timbraje bloqueado. Con cupo disponible pedir es más simple
      // y no cuesta nada; la reobtención implica un request por rango para descartar los
      // anulados, que el listado del SII no distingue.
      if (this._topeConsultado?.[tipoDte]?.bloqueado) {
        const reob = await this.folioService.reobtenerCaf({
          tipoDte: Number(tipoDte), cantidad: Number(cantidad),
        });
        if (reob.ok) {
          // Puede ser más de uno: el SII entrega los folios reobtenidos de a uno y cada
          // CAF firma con su propia llave, así que se pasan todos y el set toma de cada
          // uno según el folio (ver SetBase._tomarFolio).
          cafs[tipoDte] = reob.cafPaths.length > 1 ? reob.cafPaths : reob.cafPaths[0];
          emitProgress(STEPS.CAF_OK, { tipo: Number(tipoDte) });
          console.log(
            ` ✓ CAF tipo ${tipoDte} recuperado del SII: ${reob.cafPaths.length} CAF ` +
            `de folios ya autorizados, sin gastar cupo`
          );
          continue;
        }
        console.warn(`[CertRunner] Tipo ${tipoDte}: reobtención no sirvió — ${reob.motivo}`);
      }

      // solicitarCafExacto (no ConFallback): la simulación genera un plan fijo de
      // documentos y muere si falta un folio, así que un CAF corto no sirve. El
      // método aborta antes de emitir si el SII no autoriza lo suficiente, anula
      // folios sin utilizar para destrabar el tope, y reintenta.
      const res = await this.folioService.solicitarCafExacto({
        tipoDte: Number(tipoDte),
        cantidad: Number(cantidad),
      });

      if (!res.ok) {
        const detalle = [
          res.maxAutor != null ? `MAX_AUTOR=${res.maxAutor}` : null,
          res.foliosDisp != null ? `FOLIOS_DISP=${res.foliosDisp}` : null,
        ].filter(Boolean).join(', ');
        throw new Error(
          `Folios insuficientes para tipo ${tipoDte}: se requieren ${cantidad} y el SII ` +
          `otorgó ${res.otorgados}${detalle ? ` (${detalle})` : ''}. ` +
          `El SII limita el timbraje cuando hay folios ya autorizados sin utilizar; ` +
          `emite o anula documentos electrónicos de este tipo y reintenta. ` +
          `[${res.errorCode}] ${res.error || ''}`.trim()
        );
      }

      cafs[tipoDte] = res.cafPath;
      emitProgress(STEPS.CAF_OK, { tipo: Number(tipoDte) });
      console.log(` ✓ CAF tipo ${tipoDte} (${res.otorgados} folios)`);
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

    // Si ya se timbró el total de la corrida por adelantado (ver precargarCafsDeSets),
    // este set reusa esos CAF en vez de pedir los suyos. Pedir acá volvería a partir el
    // timbraje en tandas, que es justamente lo que gatilla el racionamiento del SII.
    const cafs = this._cafsPrecargados
      ? this._cafsDelPlan(cafRequired, ClaseSet.name)
      : await this.solicitarCafs(cafRequired);

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

    // Un folio NO se reutiliza nunca. Se marca el CAF apenas se intentó enviar, sin mirar
    // si salió bien: si el envío viajó, el SII ya vio esos folios aunque después lo
    // rechace, y reemitirlos invalida el envío entero.
    //
    // Hace falta marcarlo en DISCO porque el contador de folios vive en memoria y cada
    // etapa corre en un proceso aparte. Sin esto, la etapa siguiente reusa el mismo CAF y
    // empieza el rango de nuevo. Pasó el 14/08/2026: ENVIAR_SETS emitió los folios
    // 4519-4522 del tipo 33 y SIMULACION reusó ese CAF reemitiéndolos — el SII devolvió
    // `RFR - Rechazado por Error en Firma` para todo el envío de simulación.
    //
    // Quemar un folio de más es barato; repetirlo cuesta la etapa completa.
    let resultado;
    try {
      resultado = await set.ejecutar(setData, cafs);
    } finally {
      this._marcarCafsConsumidos(cafs);
    }
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
   * @param {Object} [options] - { maxIntentos, intervalo, ignorarVacio }
   * @param {boolean} [options.ignorarVacio] - Si this.resultados no tiene trackIds (runner
   *   recién creado, sin hidratar), en vez de devolver el error genérico "No hay sets para
   *   declarar" consulta el estado real del portal: si la etapa ya avanzó más allá de SET DE
   *   PRUEBAS, los sets YA fueron declarados y aprobados en una ejecución anterior — no hay
   *   nada que hacer y no es un error. Default false — comportamiento previo sin cambios.
   * @returns {Promise<Object>} Resultado de la declaración
   */
  async declararAvance(resultadosExt, estructurasExt, options = {}) {
    const resultados = resultadosExt || this.resultados;
    const estructuras = estructurasExt || this._estructuras;
    const { maxIntentos = 10, intervalo = 5000, ignorarVacio = false } = options;

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
      if (ignorarVacio) {
        const avance = await this.consultarAvance().catch(() => null);
        const etapa = avance?.etapaActual;
        if (etapa && etapa !== 'SET DE PRUEBAS') {
          return { success: true, yaDeclarado: true, etapaActual: etapa };
        }
      }
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
    // Permite pasar las estructuras explícitamente (ej. runner recién creado, hidratado desde
    // BD/caché en vez de obtenerSets()) — igual que ejecutarSimulacion(). Si no vienen, cae al
    // estado interno (comportamiento previo, sin cambios para callers existentes).
    const estructuras = options.estructuras || this._estructuras;

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
      estructuras?.libroCompras?.detalle?.[0]?.FchDoc ||
      estructuras?.libroComprasExentos?.detalle?.[0]?.FchDoc;
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
    if (estructuras?.libroComprasExentos) {
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
        if (estructuras?.libroComprasExentos) _todosCandidatos.push('LIBRO DE COMPRAS PARA EXENTOS');
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
          // Cross-check SOAP: el portal se queda en S21 ("declarado") para un envío que el
          // SOAP ya reporta RECHAZADO (LNC = período ocupado → "ENVIO CON ERRORES O REPAROS"
          // en pe_avance3). Ese estado NUNCA pasa a REVISADO CONFORME; sin este chequeo se
          // espera el timeout completo (10 min) al pedo. Consultar SOAP cada 2 intentos (~30s):
          // si algún pendiente está rechazado, cortar y dejar que phase b reintente período.
          // Solo se corta ante un rechazo POSITIVO (ok && esRechazado); errores de red/503 se
          // ignoran para no cortar una espera legítima.
          if (_enviadorSoap && _pendientesAun.length > 0 && (_i + 1) % 2 === 0) {
            for (const _n of _pendientesAun) {
              const _k = _SII_NOMBRE_A_KEY[_n];
              const _tid = _k && resultados[_k]?.trackId;
              if (!_tid) continue;
              try {
                const _soap = await _enviadorSoap.consultarEstadoSoap(_tid, _rutEmisor);
                if (_soap.ok && _soap.esRechazado) {
                  console.log(`\n [SOAP] ${_n} (${_tid}): ${_soap.estado} — ${_soap.glosa || 'rechazado'}. No llegará a CONFORME → reintentando período.`);
                  return { ok: false, estadosFinal: _ss };
                }
              } catch { /* SOAP inestable (503) — ignorar y seguir con el portal */ }
            }
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

      // Polling corto (3 intentos × 15s = 45s). Se declara igual después sin importar cómo
      // termine este poll (ver más abajo "Declarando igual") — nunca bloquea. Evidencia real
      // de hoy: en NINGUNA corrida este poll llegó a ver LOK ni LNC antes de agotarse, ni con
      // 20 intentos (5 min) ni con 120 (30 min, el valor original) — maullín deja los libros
      // en LSO mucho más tiempo del que tiene sentido esperar acá. El único caso que este poll
      // puede capturar a tiempo es un rechazo de schema INMEDIATO (rápido por naturaleza); el
      // LNC por período ocupado se detecta más tarde, en el retry de _reenviarLibros (poll
      // aparte, sin cambios). Se deja en 3 intentos en vez de 0 por si ese caso rápido ocurre.
      const _MAX_SOAP_POLLS = 3;
      const _SOAP_INTERVAL_MS = 15000;
      let _soapPendientes = new Set(_librosParaConsultar.map(l => l.key));
      const _soapFinalStates = {}; // key → resultado SOAP terminal (LOK/LNC/LRH/etc.)
      const _soapErrCount = {};    // key → contador de errores SOAP consecutivos (ok:false o throw)
      const _MAX_SOAP_ERR = 10;    // reintentos antes de desistir por errores transitorios

      console.log('\n[SOAP] Consultando estado de envíos (espera hasta 45s)...');
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
                console.log(` [SOAP] ${nombre} (${_tid}): [?] demasiados errores — desistiendo (${_detalle})`);
              } else {
                console.log(` [SOAP] ${nombre} (${_tid}): [?] error transitorio (${_soapErrCount[key]}/${_MAX_SOAP_ERR}) — reintentando... (${_detalle})`);
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
        console.log(` [SOAP] ${_nombresTimeout.join(', ')} siguen en proceso tras 45s. Declarando igual — verifica correos del SII.`);
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
          if (estructuras?.libroComprasExentos) _todosLibrosNombres.push('LIBRO DE COMPRAS PARA EXENTOS');
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

    const _librosProcesados = Object.keys(resultados)
      .filter(k => k.startsWith('libro'))
      .map(k => k.slice('libro'.length).replace(/^./, c => c.toLowerCase()));
    emitProgress(STEPS.BOOKS_DONE, { libros: _librosProcesados, success: librosEnviados === 3 });

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
    const stateFile = path.join(this.stateDir, 'periodo-libros.json');
    
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
    const stateFile = path.join(this.stateDir, 'periodo-libros.json');
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
    const stateFile = path.join(this.stateDir, 'periodo-libros.json');
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
    const ltcFile = path.join(this.stateDir, 'ltc-totales.json');
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
    const ltcFile = path.join(this.stateDir, 'ltc-totales.json');
    try {
      if (fs.existsSync(ltcFile)) {
        const data = JSON.parse(fs.readFileSync(ltcFile, 'utf8'));
        return data[periodo]?.[tipo] || null;
      }
    } catch (e) { /* ignorar */ }
    return null;
  }

  /**
   * Pregunta al SII en qué estado quedó un envío, por su trackId.
   *
   * Es la única forma de distinguir "el SII todavía lo está procesando" de "el SII lo
   * rechazó": mirando el avance de la postulación los dos casos se ven igual, la etapa
   * simplemente no se mueve. Devuelve `null` si no se pudo consultar, para que quien
   * llama decida sin quedarse colgado de una consulta que falló.
   *
   * @param {string} trackId
   * @returns {Promise<{estado: string, glosa?: string, esRechazado: boolean, esExitoso: boolean} | null>}
   */
  async consultarEstadoEnvio(trackId) {
    if (!trackId) return null;
    try {
      const enviador = new EnviadorSII(this.certificado, this.ambiente);
      const r = await enviador.consultarEstadoSoap(trackId, this.config.emisor.rut);
      return r && r.estado ? r : null;
    } catch (e) {
      console.log(` [!] No se pudo consultar el estado del envío ${trackId}: ${e.message}`);
      return null;
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
   * Cierre final de la certificación DTE, en un solo paso:
   *   1. "Avanzar Siguiente Paso" (pe_avance4) — solo funciona si el SII ya APROBÓ las muestras
   *      impresas. Mientras estén "Por revisar" el portal responde "ya se encuentra en el paso
   *      DOCUMENTOS IMPRESOS" y no avanza (no es un error: hay que esperar al SII).
   *   2. "Declaración de Cumplimiento de Requisitos" (pe_avance7 → pe_avance8).
   *
   * Reemplaza los 3 pasos manuales que el usuario debía hacer a mano en el portal del SII.
   * @returns {Promise<Object>} { success, bloqueado, mensaje, avance, declaracion }
   */
  async declararCumplimientoFinal() {
    console.log('\n' + '═'.repeat(60));
    console.log('CIERRE FINAL: AVANZAR PASO + DECLARAR CUMPLIMIENTO');
    console.log('═'.repeat(60));

    console.log('\n → Avanzando al siguiente paso (pe_avance4)...');
    const avance = await this.avanzarSiguientePaso().catch(e => ({ success: false, error: e.message }));
    console.log(avance?.success ? ' ✓ Avance enviado' : ` [!] Avance no aplicado: ${avance?.error || 'sin cambios'}`);

    console.log('\n → Declarando cumplimiento de requisitos (pe_avance7 → pe_avance8)...');
    const declaracion = await this.siiCert.declararCumplimiento();

    if (declaracion.bloqueado) {
      console.log(`\n [!] El SII NO permite declarar todavía: ${declaracion.mensaje || 'certificación no finalizada'}`);
      console.log('     Las muestras impresas siguen pendientes de revisión del SII.');
      return { success: false, bloqueado: true, mensaje: declaracion.mensaje, avance, declaracion };
    }
    if (!declaracion.success) {
      console.log(`\n [ERR] Error declarando cumplimiento: ${declaracion.error || 'desconocido'}`);
      return { success: false, bloqueado: false, mensaje: declaracion.error, avance, declaracion };
    }

    console.log('\n [OK] DECLARACIÓN DE CUMPLIMIENTO EFECTUADA');
    return { success: true, bloqueado: false, mensaje: declaracion.mensaje, avance, declaracion };
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
        const resultadoAvance = await this.avanzarSiguientePaso();
        const avanceActual = await this.consultarAvance().catch(() => null);
        emitProgress(STEPS.LIBROS_AVANZADOS, { etapaActual: avanceActual?.etapaActual ?? null });
        return resultadoAvance;
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
    let resultado;
    try {
      resultado = await enviador.enviar(envioDte);
    } finally {
      // Mismo criterio que en los sets: los folios de la simulación quedan quemados.
      this._marcarCafsConsumidos(cafs);
    }

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
          // `rechazado` distingue "el SII dijo que no" de "el SII todavía no dijo nada".
          // Sin esa marca, quien clasifica la etapa lo lee como espera y la reintenta en
          // loop, cuando lo que hay que hacer es corregir y reenviar.
          console.log(` [ERR] SIMULACIÓN: ${simEstado.estado}`);
          return { success: false, rechazado: true, error: `Simulación rechazada por el SII: ${simEstado.estado}` };
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

    // ⚠️ Que se agoten los intentos NO significa "el SII se está tomando su tiempo".
    // El portal tampoco avanza cuando el envío fue RECHAZADO, y ahí esperar más no
    // sirve de nada: hay que corregir y reenviar. Distinguir los dos casos mirando el
    // avance es imposible — en ambos la etapa se queda quieta. La única fuente de
    // verdad es el estado del envío, así que se le pregunta al SII por el trackId.
    //
    // Caso real (14/08/2026, RUT 77111222-3): la simulación quedó `RFR - Rechazado por
    // Error en Firma` y este método devolvió "Timeout esperando aprobación". Quien lo
    // llamaba lo leyó como "sigue en revisión", siguió adelante y marcó la etapa como
    // completada sobre un envío que el SII había rechazado.
    const trackIdSim = this.resultados.simulacion?.trackId;
    const envio = await this.consultarEstadoEnvio(trackIdSim);
    if (envio?.esRechazado) {
      const glosa = envio.glosa || envio.descripcion || envio.mensaje || envio.estado;
      console.log(`\n [ERR] El SII RECHAZÓ el envío de simulación (${envio.estado}): ${glosa}`);
      return {
        success: false,
        rechazado: true,
        estadoEnvio: envio.estado,
        error: `El SII rechazó el envío de simulación (${envio.estado}): ${glosa}`,
      };
    }
    if (envio?.estado) {
      console.log(`\n [...] Envío de simulación ${trackIdSim} en estado ${envio.estado} — el SII sigue procesando`);
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

    emitProgress(STEPS.INTERCAMBIO_START);
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

    emitProgress(STEPS.INTERCAMBIO_DESCARGADO);

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
      emitProgress(STEPS.INTERCAMBIO_DONE, { uploaded: true });
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
        const _t0 = Date.now();
        const req = https.request(opts, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            registrarHttpDebug({
              url: urlStr, method, status: res.statusCode, headers: res.headers,
              body: data, reqBody: body, ms: Date.now() - _t0, cliente: 'pfeInternet',
            });
            resolve({ status: res.statusCode, body: data, headers: res.headers });
          });
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
    // RUT del titular del certificado — desde el objeto Certificado (parsea el PFX), NO del
    // nombre de archivo: cuando la API inyecta un PFX temporal (p.ej. "1-<ts>-cert.pfx") el
    // nombre no contiene el RUT → certRut salía basura → validarUsuario "No hay usuario a validar".
    const certRutFull = (this.certificado?.rut || path.basename(this.config.certificado.path, '.pfx')).replace(/\./g, '');
    const [certRut, certDv = '0'] = certRutFull.includes('-') ? certRutFull.split('-') : [certRutFull, '0'];

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
      // El portal SII exige el RUT de la empresa como query params (?re={rut}&dve={dv}),
      // igual que downloadFile. Sin ellos responde HTTP 200 con "no vienen los parametros
      // necesarios" y el envío no se registra → la etapa nunca avanza a DOCUMENTOS IMPRESOS.
      const uploadResp = await makeReq(`${PFE_BASE}uploadFile${archivo.uploadN}?re=${empRut}&dve=${empDv}`, {
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
      // La página de error del portal GWT devuelve HTTP 200 con "no vienen los parametros
      // necesarios" / <title>ERROR</title> → NO es éxito aunque el status sea 200. Antes se
      // tomaba status===200 como éxito y se marcaba el intercambio confirmado en falso.
      const esPaginaError = respLow.includes('no vienen los parametros')
        || respLow.includes('<title>error')
        || respLow.includes('rechaz');
      const hasError = uploadResp.status >= 400 || esPaginaError;

      if (hasError) {
        throw new Error(`Error al subir ${archivo.filename}: HTTP ${uploadResp.status} — ${respBody.substring(0, 200)}`);
      }
      console.log(` ✓ ${archivo.filename} subido (HTTP ${uploadResp.status})`);
    }

    // === PASO 3: Confirmar el intercambio (GWT RPC) — el "commit" que avanza a DOCUMENTOS
    // IMPRESOS. Sin esto los 3 XML quedan subidos pero la postulación NO avanza. Secuencia
    // capturada del portal real (F12): validarSetContriPostSeguimiento + updatePostulacion-
    // Seguimiento ×3 (una por cada documento subido, ids 40/41/43). Antes hacíamos solo una
    // (43) → por eso no avanzaba: faltaban las otras dos + la validación previa.
    console.log(' → pfeInternet: validarSetContriPostSeguimiento...');
    const validSetPayload =
      `7|0|7|${PFE_BASE}|${PFE_POLICY}|${PFE_SVC}|validarSetContriPostSeguimiento|` +
      `java.lang.Integer/3438268394|java.lang.String/2004016611|${empDv}|` +
      `1|2|3|4|2|5|6|5|${empRut}|7|`;
    const validSetResp = await makeReq(`${PFE_BASE}facade`, {
      method: 'POST', body: validSetPayload, headers: gwtHeaders, cookies,
    });
    if (debugDir) fs.writeFileSync(path.join(debugDir, 'pfe-validarset-resp.txt'), (validSetResp.body || '').substring(0, 800), 'utf8');

    // updatePostulacionSeguimiento × 3 (ids 40, 41, 43 — uno por documento de intercambio)
    const SEGUIMIENTO_IDS = [40, 41, 43];
    for (const seguimientoId of SEGUIMIENTO_IDS) {
      console.log(` → pfeInternet: updatePostulacionSeguimiento (id=${seguimientoId})...`);
      const segPayload =
        `7|0|7|${PFE_BASE}|${PFE_POLICY}|${PFE_SVC}|updatePostulacionSeguimiento|` +
        `cl.sii.sdi.dim.pfe.to.PostulacionSeguimientoTo/3921005560|java.lang.Integer/3438268394|${empDv}|` +
        `1|2|3|4|1|5|5|6|${seguimientoId}|0|0|0|0|7|6|${empRut}|`;
      const segResp = await makeReq(`${PFE_BASE}facade`, {
        method: 'POST', body: segPayload, headers: gwtHeaders, cookies,
      });
      if (debugDir) fs.writeFileSync(path.join(debugDir, `pfe-seguimiento-${seguimientoId}-resp.txt`), (segResp.body || '').substring(0, 500), 'utf8');
      if (!/\/\/OK/.test(segResp.body || '')) {
        throw new Error(`updatePostulacionSeguimiento(${seguimientoId}) no confirmó: ${(segResp.body || '').substring(0, 200)}`);
      }
    }
    console.log(' ✓ Intercambio confirmado (3 seguimientos) — postulación avanza a DOCUMENTOS IMPRESOS');

    return { success: true, resultado: 'Los 3 archivos XML de intercambio subidos y confirmados (avanza a DOCUMENTOS IMPRESOS)' };
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
        const _t0 = Date.now();
        const req = https.request(opts, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            const _body = Buffer.concat(chunks).toString('utf8');
            // pdfdteInternet es un TERCER cliente HTTP, aparte de SiiSession y
            // SiiPortalAuth: no pasa por ninguno de los dos hooks, así que todo el flujo
            // de muestras impresas era invisible en el debug. Se notó el 11/08/2026, al
            // quedar bloqueada la subida con un mensaje del SII que no aparecía en
            // ninguna captura porque estas llamadas simplemente no se registraban.
            registrarHttpDebug({
              url: urlStr, method, status: res.statusCode, headers: res.headers,
              body: _body, reqBody: body, ms: Date.now() - _t0, cliente: 'pdfdteInternet',
            });
            resolve({ status: res.statusCode, body: _body, headers: res.headers });
          });
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

      // ⚠️ No se deduce la cantidad de documentos de la tabla: el string numérico corto
      // que se tomaba como contador es en realidad el dígito verificador del RUT del
      // usuario. Reportaba "8 documentos" con 41 subidos. Ver el mismo caso en
      // _subirMuestrasImpresasPortal.
      let estado = null, fechaEnvio = null, revId = null;
      if (table) {
        const estadoStr = table.find(s => typeof s === 'string' && /APROBADO|POR REVISAR|RECHAZADO|INGRESO|EN REVISI/i.test(s));
        const errorStr  = table.find(s => typeof s === 'string' && /El estado de la postulacion/i.test(s));
        const fechaStr  = table.find(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s));
        estado      = estadoStr ? estadoStr.toUpperCase() : (errorStr ? 'BLOQUEADO' : null);
        fechaEnvio  = fechaStr || null;
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
      return { estado, revId, fechaEnvio };
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

    emitProgress(STEPS.MUESTRAS_UPLOADING, { count: pdfPaths.length });
    const result = await this._subirMuestrasImpresasPortal({ pdfPaths, debugDir: pdfDir });
    emitProgress(STEPS.MUESTRAS_DONE, { success: result.success });
    return result;
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
    /**
     * Extrae el mensaje de error que el SII mete en la tabla de strings de GWT.
     *
     * ⚠️ El portal contesta HTTP 200 y `//OK` incluso cuando rechaza: el motivo viaja
     * como una frase en castellano dentro de la tabla. Antes se buscaba UNA frase fija
     * ("El estado de la postulacion"), así que cualquier otro rechazo pasaba de largo:
     * `leeImpreso` lo leía como "no hay revisión previa" y seguía, y `creaLista` moría
     * después con "no se pudo extraer ID de revisión de: //OK[0,0,2,...".
     * Caso real (11/08/2026): "El contribuyente ... no ha solicitado Set de pruebas."
     * venía en AMBAS respuestas y no se reportó en ninguna.
     *
     * El criterio es amplio a propósito: es preferible cortar mostrando el texto literal
     * del SII que seguir a ciegas y fallar más adelante sin él.
     */
    const _mensajeErrorGwt = (body) => {
      const tabla = _parseGwtStringTable(body);
      if (!tabla) return null;
      return tabla.find(x =>
        typeof x === 'string' &&
        x.length > 15 &&
        // El resto de la tabla son nombres de clase Java y tipos GWT.
        !/^[\w.$]+\/\d+$/.test(x) && !x.includes('cl.sii.sdi') &&
        /\s/.test(x) &&
        /(no ha|no est|no se|no corresp|debe |error|inv[aá]lid|rechaz|El estado|El contribuyente)/i.test(x)
      ) || null;
    };

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
    // Sin estado, cualquier frase de error de la tabla es el motivo real. Antes solo se
    // reconocía "El estado de la postulacion", así que "El contribuyente ... no ha
    // solicitado Set de pruebas." se leía como "no hay revisión previa" y el flujo
    // seguía hasta reventar en creaLista sin ese texto.
    const errorEstadoMsg = !estadoActual && _mensajeErrorGwt(leeResp.body);
    if (errorEstadoMsg) {
      // OJO: el SII devuelve "El estado de la postulacion NO es: 'DOCUMENTOS IMPRESOS'" en DOS
      // situaciones distintas, y el mensaje no las distingue:
      //   a) la postulación TODAVÍA NO llegó a DOCUMENTOS IMPRESOS (falta completar intercambio)
      //   b) la postulación YA PASÓ esa etapa (p.ej. DECLARACION EFECTUADA = certificación
      //      terminada) → subir muestras de nuevo ya no aplica, no hay nada que esperar.
      // Por eso el hint sugiere verificar la etapa con --avance en vez de asumir que hay una
      // revisión en curso.
      console.log(` → Portal SII bloqueado: ${errorEstadoMsg}`);
      return {
        success: false, blocked: true, estado: 'BLOQUEADO',
        error: errorEstadoMsg,
        hint: 'La postulación no está en DOCUMENTOS IMPRESOS: puede que aún no haya llegado a esa etapa, o que YA la haya superado (certificación terminada). Verifica la etapa real con --avance.',
      };
    }

    // Si ya hay una revisión activa (no rechazada ni aprobada), no se puede re-subir.
    // El SII sólo permite crear nueva revisión cuando el estado es RECHAZADO o APROBADO.
    if (estadoActual && estadoActual !== 'RECHAZADO' && estadoActual !== 'APROBADO') {
      // Extraer detalles adicionales de la respuesta leeImpreso para diagnóstico.
      //
      // ⚠️ NO se intenta sacar de acá la cantidad de documentos. La tabla de strings trae
      // el RUT del usuario partido en número y dígito verificador, y "buscar el primer
      // string numérico menor a 500" agarraba ese DV: reportaba 8 documentos cuando se
      // habían subido 41. Un dato inventado es peor que ninguno, así que se omite.
      let fechaEnvio = null, revId = null;
      if (leeTable) {
        const fechaStr = leeTable.find(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s));
        fechaEnvio = fechaStr || null;
      }
      for (const m of leeResp.body.matchAll(/'([A-Za-z0-9$_]{3,7})'/g)) {
        let n = 0; for (const c of m[1]) n = n * 64 + GWT_B64.indexOf(c);
        if (n >= 100000 && n <= 9999999) { revId = n; break; }
      }
      console.log(` → Estado: ${estadoActual}${revId ? ` | Revisión #${revId}` : ''}${fechaEnvio ? ` | Enviado: ${fechaEnvio}` : ''} — ya enviadas, no se requiere re-subida`);
      return { success: true, alreadyCompleted: true, estado: estadoActual, revId, fechaEnvio };
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
    // Detectar error de SII dentro del //OK.
    //
    // ⚠️ El portal contesta HTTP 200 y `//OK` incluso cuando rechaza: el motivo viaja
    // como una frase en castellano dentro de la tabla de strings de GWT. Antes acá se
    // buscaba UNA sola frase ("El estado de la postulacion"), así que cualquier otro
    // rechazo pasaba de largo, no se encontraba el ID de revisión y el usuario recibía
    // "no se pudo extraer ID de revisión de: //OK[0,0,2,...".
    // Caso real (11/08/2026): "El contribuyente 77111222-3 no ha solicitado Set de
    // pruebas." quedó completamente oculto detrás de ese mensaje.
    //
    // Ahora se reconoce cualquier frase con pinta de mensaje al usuario. Es deliberado
    // que el criterio sea amplio: es preferible cortar con el texto literal del SII que
    // seguir a ciegas y fallar más adelante sin él.
    const creaErrorMsg = _mensajeErrorGwt(creaResp.body);
    if (creaErrorMsg) {
      throw new Error(`El SII rechazó la subida de muestras: ${creaErrorMsg}`);
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

    // ── Paso 5: verificar en qué quedó la revisión ─────────────────────────
    //
    // ⚠️ `solicitaRevisionSII` devuelve `//OK[0,[],0,7]` (lista vacía) tanto si el SII
    // acepta como si rechaza. Dar por buena la subida con solo ese OK es exactamente el
    // error que se venía arrastrando: `pdfdteInternet` es el servicio **validaPdfDte**,
    // un validador AUTOMÁTICO de formato, no una bandeja de revisores. Puede pasar la
    // revisión a RECHAZADO en minutos.
    //
    // Caso real (11/08/2026): la revisión 271384 se creó 21:53, se subieron 41 PDFs, el
    // envío devolvió OK, la etapa se marcó completada... y el portal ya la tenía
    // RECHAZADO. El usuario quedó esperando "3 a 7 días hábiles" por algo que ya había
    // fallado. Por eso se relee el estado y se devuelve tal cual.
    let estadoPost = null;
    try {
      const verifResp = await gwtPost(leeBody);
      const m = verifResp.body.match(/"(APROBADO|POR REVISAR|EN REVISI[OÓ]N|RECHAZADO|INGRESO|ENVIADO AL SII)"/i);
      estadoPost = m ? m[1].toUpperCase() : null;
      if (debugDir) {
        fs.writeFileSync(path.join(debugDir, 'pdfte-estado-post-envio.txt'), verifResp.body, 'utf8');
      }
    } catch (e) {
      // No poder confirmar no invalida el envío: se reporta como desconocido.
      console.warn(` [!] No se pudo confirmar el estado tras el envío: ${e.message}`);
    }

    if (estadoPost === 'RECHAZADO') {
      console.error(` [ERR] El SII RECHAZÓ la revisión ${revId} de muestras impresas.`);
      return {
        success: false,
        rechazado: true,
        revId,
        estado: estadoPost,
        error: `El SII rechazó las muestras impresas (revisión ${revId}). Revisa el detalle en el portal ` +
               `de Muestras Impresas y corrige el formato de los documentos antes de volver a subirlos.`,
      };
    }

    console.log(` ✓ Solicitud enviada al SII correctamente (${pdfPaths.length} PDFs, revisión ${revId})` +
      (estadoPost ? ` — estado: ${estadoPost}` : ''));
    process.stdout.write('\nMUESTRAS SUBIDAS EXITOSAMENTE\n');
    return { success: true, revId, estado: estadoPost };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOLETA ELECTRÓNICA — automatización portal certBolElectDteInternet
  // ═══════════════════════════════════════════════════════════════
  //
  // Métodos que se usan para la CERTIFICACIÓN DE BOLETAS (flujo, en orden):
  //   1. obtenerSetBoletaPortal          → descarga el Set de Pruebas (?SET=1)
  //   2. (BoletaCert.ejecutarCertificacion emite EnvioBOLETA + RCOF → devuelve trackId)
  //   3. solicitarValidacionBoletaPortal → declara el trackId del envío (?SET=2)
  //   4. completarDeclaracionBoletaPortal→ declara cumplimiento y autoriza producción
  //
  // Apoyo (solo lectura / recuperación de estado):
  //   - consultarEstadoBoletaPortal      → estado en el portal GWT de boleta
  //   - verificarAutorizacionBoleta      → confirma si la empresa ya emite tipo 39
  //
  // El portal de boleta usa GWT-RPC (certBolElectDteInternet), distinto del portal
  // pe_avance usado para facturas/DTE. La certificación de boletas NO usa las fases
  // de sets/libros/simulación/intercambio/muestras; esas son solo del track DTE.

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
      }, (res) => {
        const ch = []; const _t0 = Date.now();
        res.on('data', c => ch.push(c));
        res.on('end', () => {
          const _body = Buffer.concat(ch).toString('utf-8');
          registrarHttpDebug({
            url: `${CBE_BASE}facade`, method: 'POST', status: res.statusCode,
            headers: res.headers, body: _body, reqBody: bodyStr,
            ms: Date.now() - _t0, cliente: 'certBolElectDte',
          });
          resolve(_body);
        });
      });
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
      }, (res) => {
        const ch = []; const _t0 = Date.now();
        res.on('data', c => ch.push(c));
        res.on('end', () => {
          const _body = Buffer.concat(ch).toString('utf-8');
          // GET sin cuerpo: acá NO hay `bodyStr` (eso es de los gwtPost de más arriba).
          registrarHttpDebug({
            url: dlUrl, method: 'GET', status: res.statusCode,
            headers: res.headers, body: _body,
            ms: Date.now() - _t0, cliente: 'certBolElectDte',
          });
          resolve(_body);
        });
      });
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
      }, (res) => {
        const ch = []; const _t0 = Date.now();
        res.on('data', c => ch.push(c));
        res.on('end', () => {
          const _body = Buffer.concat(ch).toString('utf-8');
          registrarHttpDebug({
            url: `${CBE_BASE}facade`, method: 'POST', status: res.statusCode,
            headers: res.headers, body: _body, reqBody: bodyStr,
            ms: Date.now() - _t0, cliente: 'certBolElectDte',
          });
          resolve(_body);
        });
      });
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
  /**
   * Constantes y helper GWT compartidos por las llamadas al portal de Certificación
   * de Boleta Electrónica (certBolElectDteInternet — GWT-RPC, distinto de pe_avance
   * que es HTML). Factorizado para no duplicar la construcción del request entre
   * el chequeo de solo-lectura y la declaración real.
   */
  _gwtBoletaClient(cookieJar) {
    const https  = require('https');
    const crypto = require('crypto');
    const CBE_BASE   = 'https://www4.sii.cl/certBolElectDteInternet/';
    const CBE_PERM   = '0FC3D987613537E6E13E9BB93A406F13';
    const CBE_POLICY = '082D0AC4BC4D75A5DF38F116C53877D4';
    const CBE_SVC    = 'cl.sii.sdi.diii.certBolElectDte.web.client.service.Facade';
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
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
      }, (res) => {
        const ch = []; const _t0 = Date.now();
        res.on('data', c => ch.push(c));
        res.on('end', () => {
          const _body = Buffer.concat(ch).toString('utf-8');
          registrarHttpDebug({
            url: `${CBE_BASE}facade`, method: 'POST', status: res.statusCode,
            headers: res.headers, body: _body, reqBody: bodyStr,
            ms: Date.now() - _t0, cliente: 'certBolElectDte',
          });
          resolve(_body);
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout gwtPost CBE')); });
      req.write(buf); req.end();
    });
    return { CBE_BASE, CBE_POLICY, CBE_SVC, gwtPost };
  }

  /**
   * Chequeo de SOLO LECTURA del estado de la certificación de Boleta en el portal
   * certBolElectDteInternet. No declara nada — sirve para:
   *  - gatear el botón "Declarar cumplimiento" (evita el viaje fallido si aún no hay P90)
   *  - recuperar el estado de boleta cuando las banderas locales se resetearon (ese
   *    portal NO aparece en pe_avance, así que consultarEstadoAvance no lo cubre)
   *
   * Verificado 2026-07-24 contra 79555666-7 con curl crudo (independiente de este
   * código) — misma respuesta `//OK[0,[],0,7]` cuando no hay P90 todavía.
   *
   * @returns {Promise<{success: boolean, inscrita: boolean, listaParaDeclarar: boolean, estado: string|null, error?: string}>}
   */
  async consultarEstadoBoletaPortal() {
    const cookieJar = await this._obtenerCookiesSII();
    const [rutNum, dvChar] = this.config.emisor.rut.replace(/\./g, '').split('-');
    const dvUp = dvChar.toUpperCase();
    const { CBE_BASE, CBE_POLICY, CBE_SVC, gwtPost } = this._gwtBoletaClient(cookieJar);

    // 1. Representante legal vigente ⇒ si hay uno, la empresa está postulada/inscrita
    //    en el portal de boleta (aunque aún no tenga P90).
    const reprResp = await gwtPost(
      `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|recuperarRepresentantesVigentesUsuariosAutorizados|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|2|5|6|5|${rutNum}|7|`
    );
    const reprTableStr = reprResp.substring(reprResp.lastIndexOf(',[') + 1, reprResp.lastIndexOf('],0,7]') + 1);
    let rutRepreNum = '';
    try {
      const reprTable = JSON.parse(reprTableStr);
      rutRepreNum = reprTable.filter(s => /^\d{7,8}$/.test(s)).pop() || '';
    } catch {}
    const inscrita = !!rutRepreNum;
    if (!inscrita) {
      return { success: true, inscrita: false, listaParaDeclarar: false, estado: null };
    }

    // 2. Estado — P90 = SOK recibido, lista para declarar. Lista vacía = SII aún no
    //    creó el registro (SOK pendiente). Cualquier otro P\d+ = otro estado del flujo.
    const estadoResp = await gwtPost(
      `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|obtenerEstadoAutorizaEmp|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|4|5|6|5|6|5|${rutNum}|7|5|90|0|`
    );
    const listaParaDeclarar = estadoResp.includes('P90');
    const estadoMatch = estadoResp.match(/"(P\d+)"/);
    const listaVacia = /\/\/OK\[0,\[\]/.test(estadoResp);

    // ⚠️ La consulta pregunta puntualmente por el estado 90, así que una lista vacía
    // significa "no está en P90" — y eso pasa en DOS situaciones opuestas:
    //   a) todavía no llegó (el SII no emitió el SOK del set), o
    //   b) YA lo pasó: declaró cumplimiento y avanzó a P91.
    //
    // Darlas por (a) siempre hacía que, después de una declaración exitosa, se
    // informara "esperando aprobación del SII (SOK)". La pantalla le pedía al usuario
    // esperar una etapa que ya había superado (visto el 17/08/2026, RUT 79555666-7:
    // declaró a las 14:01 con DECLARACION EFECTUADA y a las 14:5x seguía diciendo que
    // faltaba el SOK).
    //
    // Se desempata preguntando por el 91, que es el estado al que mueve
    // `autorizarEmpresaBolProd`.
    let estado = listaParaDeclarar ? 'P90'
               : estadoMatch ? estadoMatch[1]
               : listaVacia ? 'sin_estado_sok_pendiente'
               : 'desconocido';
    let yaDeclarada = false;

    if (estado === 'sin_estado_sok_pendiente') {
      try {
        const resp91 = await gwtPost(
          `7|0|7|${CBE_BASE}|${CBE_POLICY}|${CBE_SVC}|obtenerEstadoAutorizaEmp|java.lang.Integer/3438268394|java.lang.String/2004016611|${dvUp}|1|2|3|4|4|5|6|5|6|5|${rutNum}|7|5|91|0|`
        );
        if (resp91.includes('P91')) {
          estado = 'P91';
          yaDeclarada = true;
        }
      } catch (e) {
        // Si la segunda consulta falla se conserva la lectura original: es un dato de
        // más, no una dependencia.
        console.log(` [!] No se pudo desempatar el estado con P91: ${e.message}`);
      }
    }

    return { success: true, inscrita: true, listaParaDeclarar, estado, yaDeclarada };
  }

  async completarDeclaracionBoletaPortal({
    linkConsulta    = 'www.sii.cl',
    rutProveedor    = '',
    nombreProveedor = '',
    correoProveedor = '',
  } = {}) {
    const cookieJar = await this._obtenerCookiesSII();
    const [rutNum, dvChar] = this.config.emisor.rut.replace(/\./g, '').split('-');
    const dvUp       = dvChar.toUpperCase();
    const razonSocial = this.config.emisor.razon_social || this.config.emisor.razonSocial || '';
    const { CBE_BASE, CBE_POLICY, CBE_SVC, gwtPost } = this._gwtBoletaClient(cookieJar);

    // Chequeo de solo-lectura primero: evita el viaje de autorizarEmpresaBolProd
    // (que escribe en el SII) cuando ya sabemos que no va a poder completarse.
    const estadoActual = await this.consultarEstadoBoletaPortal();
    if (!estadoActual.success) {
      return { success: false, error: 'No se pudo consultar el estado en el portal de boleta.' };
    }
    if (!estadoActual.inscrita) {
      return { success: false, error: 'No se pudo obtener representante vigente (facade CBE)' };
    }
    // Ya declaró y avanzó a P91: la etapa está cumplida, no pendiente. Sin este caso,
    // reintentar la declaración sobre una empresa ya declarada devolvía `pendingSok` y
    // la etapa quedaba "esperando" para siempre, esperando un SOK que ya había llegado
    // y ya se había usado.
    if (estadoActual.yaDeclarada) {
      return { success: true, yaDeclarada: true, mensaje: 'La declaración de cumplimiento ya estaba efectuada (P91)' };
    }
    if (!estadoActual.listaParaDeclarar) {
      const legible = estadoActual.estado === 'sin_estado_sok_pendiente'
        ? 'sin estado registrado (SOK aún no emitido)'
        : (estadoActual.estado ?? '(desconocido)');
      return { success: false, pendingSok: true, error: `El SII aún no habilita la declaración: ${legible}. Espere el SOK del set de boleta enviado.` };
    }
    // Representante legal vigente. Se vuelve a pedir (no se reusa el de
    // consultarEstadoBoletaPortal) porque autorizarEmpresaBolProd necesita el dato
    // fresco justo antes de escribir, sin depender de estado interno de otra llamada.
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

    // ⚠️ Este era el ÚNICO cliente HTTP de la librería que no dejaba rastro, y es
    // precisamente el que responde "¿el SII ya habilitó el timbraje?": consulta
    // of_solicita_folios_dcto en palena y mira si el tipo 39 aparece en el select.
    // Cuando la respuesta es "todavía no", sin la captura no queda forma de saber si el
    // SII contestó eso de verdad o si la consulta salió mal.
    const fetchHtml = (url) => new Promise((resolve, reject) => {
      const _t0 = Date.now();
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
        res.on('end', () => {
          const _body = Buffer.concat(chunks).toString('utf-8');
          registrarHttpDebug({
            url, method: 'GET', status: res.statusCode, headers: res.headers,
            body: _body, ms: Date.now() - _t0, cliente: 'verificarAutorizacionBoleta',
          });
          resolve(_body);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    });

    const [rutNum, dvChar] = String(this.config.emisor.rut).replace(/\./g, '').split('-');

    /** POST de formulario, para el segundo paso del timbraje. Se captura igual que el GET. */
    const postForm = (url, campos) => new Promise((resolve, reject) => {
      const cuerpo = Object.entries(campos)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&');
      const u = new URL(url);
      const _t0 = Date.now();
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(cuerpo),
        },
        rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const _body = Buffer.concat(chunks).toString('utf-8');
          registrarHttpDebug({
            url, method: 'POST', status: res.statusCode, headers: res.headers,
            body: _body, reqBody: cuerpo, ms: Date.now() - _t0,
            cliente: 'verificarAutorizacionBoleta',
          });
          resolve(_body);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(cuerpo); req.end();
    });

    const result = {
      autorizadaProduccion:       false,
      autorizadaCertificacion:    false,
      mensaje:                    '',
      tiposDisponiblesProduccion: [],
      estadoCertificacion:        null,
    };

    // ── 1. Verificar producción: of_solicita_folios_dcto en palena ─────────
    //
    // ⚠️ Son DOS pasos, no uno. `of_solicita_folios_dcto` es la segunda pantalla del
    // formulario de timbraje: entrar con un GET pelado, sin el POST previo que lleva
    // RUT_EMP/DV_EMP, hace que el SII responda 200 con una página de error genérica
    // ("No ha sido posible completar su solicitud... LIBRUD-OFSF-DTE-3-1-02") que no
    // trae ningún <select>.
    //
    // Como el parser buscaba <option value="39">, esa página vacía se leía como "no
    // autorizada". Es la secuencia que ya usa CafSolicitor._processMultiStepFlow() para
    // pedir folios de verdad, y por eso ESE camino sí funciona.
    //
    // Caso real (17/08/2026, RUT 79555666-7): el flujo reportaba "Boleta NO autorizada"
    // mientras el SII tenía a la empresa como FACTURADOR ELECTRONICO con BOLETA
    // ELECTRONICA autorizada hasta el folio 103009 desde el 12/07/2026, y palena le
    // entregaba folios reales de factura por el camino bien armado. Un comercio ya
    // habilitado quedaba viendo "esperando al SII" para siempre.
    try {
      const SiiSession = require('../SiiSession');
      const htmlPaso1 = await fetchHtml('https://palena.sii.cl/cvc_cgi/dte/of_solicita_folios');
      const accion = SiiSession.extractFormAction(htmlPaso1) || '/cvc_cgi/dte/of_solicita_folios_dcto';
      const campos = {
        ...SiiSession.extractInputValues(htmlPaso1),
        RUT_EMP: rutNum,
        DV_EMP:  dvChar,
      };
      // El `action` del form puede venir absoluto, con barra inicial, o relativo.
      const BASE_PALENA = 'https://palena.sii.cl';
      const urlPaso2 = accion.startsWith('http') ? accion
        : accion.startsWith('/')                 ? `${BASE_PALENA}${accion}`
                                                 : `${BASE_PALENA}/cvc_cgi/dte/${accion}`;
      const htmlProd = await postForm(urlPaso2, campos);
      if (this.config.debugDir) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(this.config.debugDir, `verificar-boleta-produccion-${ts}.html`),
          htmlProd, 'utf-8'
        );
      }
      // ⚠️ "No hay <option> con el 39" NO significa "no está autorizada". El SII también
      // responde 200 con una página de error que no trae ningún select, y ahí el parser
      // veía cero tipos y concluía "no autorizada" — un dato inventado, indistinguible
      // de la respuesta real.
      //
      // Visto el 17/08/2026 (RUT 79555666-7): palena devolvió 3377 bytes con
      // "No ha sido posible completar su solicitud... código LIBRUD-OFSF-DTE-3-1-02" y
      // el flujo venía reportando "certificación incompleta" desde hacía días.
      //
      // Se distingue por la ausencia de select, no por el texto del error: cualquier
      // fallo del portal que no pinte el formulario cae acá.
      const hayFormulario = /<select[^>]*>/i.test(htmlProd);
      if (!hayFormulario) {
        const codigo = (htmlProd.match(/([A-Z]{4,}-[A-Z]{3,}-[A-Z0-9-]{4,})/) || [])[1] || null;
        result.consultaFallida = true;
        result.errorConsultaProduccion = codigo
          ? `El portal del SII no entregó el formulario de timbraje (código ${codigo})`
          : 'El portal del SII no entregó el formulario de timbraje';
        console.log(` [!] Producción — ${result.errorConsultaProduccion}. NO se puede afirmar si está autorizada.`);
      } else {
        const matches = [...htmlProd.matchAll(/<option[^>]+value="(\d+)"[^>]*>/gi)];
        result.tiposDisponiblesProduccion = matches.map(m => parseInt(m[1], 10)).filter(n => n > 0);
        result.autorizadaProduccion = result.tiposDisponiblesProduccion.includes(39);
        console.log(` ✓ Producción — tipos disponibles: [${result.tiposDisponiblesProduccion.join(', ')}] | Boleta 39: ${result.autorizadaProduccion ? '✅ SÍ' : '❌ NO'}`);
      }
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
