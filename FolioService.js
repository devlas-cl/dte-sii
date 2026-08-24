// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * FolioService.js - Servicio de gestión de folios
 * 
 * Servicio principal para obtener, consultar y anular folios del SII.
 * Integra SiiSession para la comunicación y FolioRegistry para el control local.
 * 
 * @module FolioService
 */

const fs = require('fs');
const path = require('path');
const SiiSession = require('./SiiSession');
const FolioRegistry = require('./FolioRegistry');
const CAF = require('./CAF');
const CafSolicitor = require('./CafSolicitor');
const { resolveDataDir } = require('./utils/paths');

/**
 * Clase para gestión integral de folios
 */
class FolioService {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.ambiente - 'certificacion' o 'produccion' (OBLIGATORIO)
   * @param {string} options.rutEmisor - RUT del emisor (OBLIGATORIO)
   * @param {Object} [options.certificado] - Instancia de Certificado
   * @param {string} [options.pfxPath] - Ruta al archivo PFX
   * @param {string} [options.pfxPassword] - Contraseña del PFX
   * @param {string} [options.baseDir] - Directorio base del proyecto
   * @param {string} [options.cafDir] - Directorio de CAFs
   * @param {string} [options.debugDir] - Directorio de debug
   * @param {string} [options.registryPath] - Ruta al registro de folios
   * @param {string} [options.solicitarScript] - Script para solicitar CAFs
   * @param {number} [options.retries=2] - Número de reintentos para solicitar CAF
   * @param {number} [options.retryDelayMs=1500] - Delay entre reintentos en ms
   * @param {boolean} [options.useRegistry=true] - Usar registro de folios
   * @param {boolean} [options.singleRequest=false] - Solicitar CAFs uno a uno
   */
  constructor(options = {}) {
    // Validar parámetros obligatorios (multi-tenant: nunca usar defaults de .env)
    if (!options.ambiente) {
      throw new Error('FolioService: options.ambiente es obligatorio');
    }
    if (!options.rutEmisor) {
      throw new Error('FolioService: options.rutEmisor es obligatorio');
    }
    if (!['certificacion', 'produccion'].includes(options.ambiente)) {
      throw new Error(`FolioService: ambiente inválido "${options.ambiente}", debe ser 'certificacion' o 'produccion'`);
    }

    this.ambiente = options.ambiente;
    this.rutEmisor = options.rutEmisor;
    // Fallback neutral: antes era `__dirname/../..`, que en una instalación normal
    // apunta dentro de node_modules — se escribían artefactos dentro de la propia
    // carpeta de dependencias.
    this.baseDir = options.baseDir || resolveDataDir();
    
    // Directorios
    this.cafDir = options.cafDir || path.join(this.baseDir, 'debug', 'auto-caf');
    this.debugDir = options.debugDir || path.join(this.baseDir, 'debug');
    /**
     * Estado que debe SOBREVIVIR a la corrida, separado de `debugDir`.
     *
     * Acá vive el registro de folios que el SII ya reportó como anulados
     * (`folios-anulados-{rut}-{tipo}.json`). Guardarlo en `debugDir` — que es por
     * corrida — lo volvía inútil: nacía vacío en cada ejecución y se volvían a
     * intentar anular los mismos folios una y otra vez.
     *
     * Medido el 11/08/2026 en una empresa con muchas pruebas encima: 87 intentos de
     * anulación en una sola etapa, **0 anulados y 87 rechazados por "ya anulado"**.
     * Como el camino bulk falla y cae a folio-a-folio, cada intento cuesta 2 requests
     * al SII: varios minutos de la corrida gastados en no hacer nada.
     */
    this.stateDir = options.stateDir || this.debugDir;
    
    // Sesión SII — priorizar reutilización para evitar bans del SII
    // Orden: (1) sesión explícita, (2) registro de CafSolicitor, (3) nueva sesión
    const cachedSession = CafSolicitor.getSession(this.ambiente, this.rutEmisor);
    if (options.session) {
      this.session = options.session;
    } else if (cachedSession) {
      this.session = cachedSession;
    } else {
      this.session = new SiiSession({
        ambiente: this.ambiente,
        certificado: options.certificado,
        pfxPath: options.pfxPath,
        pfxBuffer: options.pfxBuffer,
        pfxPassword: options.pfxPassword,
      });
    }

    // Cargar sesión compartida si está disponible
    this.sessionPath = options.sessionPath || process.env.SII_SESSION_PATH;
    if (this.sessionPath) {
      const loaded = this.session.loadSession(this.sessionPath);
      if (loaded) {
        console.log('[FolioService] ✓ Usando sesión compartida');
      }
    }

    // Registro de folios
    this.registry = new FolioRegistry({
      registryPath: options.registryPath,
      baseDir: this.baseDir,
    });

    // Solicitador de CAF interno (migrado de test-caf-solicitar.js)
    this.cafSolicitor = null;
    // `pfxBuffer` también sirve: el constructor pedía `pfxPath` sí o sí, aunque la propia
    // clase ya acepta buffer para la sesión y CafSolicitor lo soporta. Un consumidor que
    // tiene el certificado en memoria (leído de la BD, sin escribirlo a disco) quedaba con
    // `cafSolicitor: null` y todo lo que depende de él —solicitar, consultar tope,
    // reobtener— fallaba con "CafSolicitor no inicializado".
    if ((options.pfxPath || options.pfxBuffer) && options.pfxPassword) {
      this.cafSolicitor = new CafSolicitor({
        ambiente: this.ambiente,
        rutEmisor: this.rutEmisor,
        pfxPath: options.pfxPath,
        pfxBuffer: options.pfxBuffer,
        pfxPassword: options.pfxPassword,
        baseDir: this.baseDir,
        sessionPath: this.sessionPath,
      });
    }

    // Configuración (parámetros explícitos, sin process.env para multi-tenant)
    this.config = {
      retries: Number(options.retries ?? 2),
      retryDelayMs: Number(options.retryDelayMs ?? 1500),
      useRegistry: options.useRegistry !== false,
      singleRequest: options.singleRequest === true,
    };
  }

  /**
   * Busca el CAF más reciente para un tipo de DTE
   * Busca recursivamente en cafDir y también en debug/caf/{ambiente}/{rut}/{tipo}/
   * @param {number} tipoDte - Tipo de DTE
   * @returns {string|null} - Ruta al CAF o null
   */
  findLatestCaf(tipoDte) {
    return this.listarCafs(tipoDte)[0] ?? null;
  }

  /**
   * Todos los CAF de un tipo que hay en disco para este RUT y ambiente, del más
   * reciente al más viejo.
   *
   * `findLatestCaf` devuelve solo el primero, que alcanza mientras un CAF cubra
   * la cantidad completa. Cuando el SII raciona el timbraje eso deja de valer: un
   * pedido de 4 folios puede haber quedado repartido en un CAF de 3 y otro de 1, y
   * mirando solo el último se concluye "no alcanza" y se vuelven a pedir folios
   * nuevos, dejando los anteriores timbrados y sin usar (que es justo lo que el SII
   * cuenta en contra del cupo).
   *
   * @param {number} tipoDte
   * @returns {string[]} rutas ordenadas por mtime descendente
   */
  listarCafs(tipoDte) {
    const matches = [];
    
    // Helper para buscar recursivamente
    const searchRecursive = (dir, depth = 0) => {
      if (!fs.existsSync(dir) || depth > 5) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchRecursive(fullPath, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith('.xml')) {
            try {
              const xml = fs.readFileSync(fullPath, 'utf8');
              const tdMatch = xml.match(/<TD>(\d+)<\/TD>/i);
              // ⚠️ El RUT se valida acá, contra el <RE> del propio CAF, y NO se da por
              // supuesto por la ruta.
              //
              // `cafDir` (debug/auto-caf) es COMPARTIDO entre todos los comercios del
              // servidor: sus subcarpetas llevan el RUT, pero la búsqueda es recursiva y
              // antes solo comparaba el tipo de DTE. Un CAF de otra empresa con el mismo
              // tipo entraba como candidato válido.
              //
              // Pasó de verdad (14/08/2026): al reusar CAF previos, los tipos 56 y 61 del
              // RUT 76543210-K resolvieron a CAF de 77111222-3. El timbre quedó firmado con
              // la llave de otro contribuyente y el SII devolvió `RFR - Rechazado por Error
              // en Firma` para todo el envío, lo que a su vez trababa la declaración de
              // simulación ("no debe contener documentos con reparos o rechazos").
              const reMatch = xml.match(/<RE>([^<]+)<\/RE>/i);
              const rutCaf  = (reMatch?.[1] ?? '').replace(/\./g, '').trim().toUpperCase();
              const rutMio  = String(this.rutEmisor).replace(/\./g, '').trim().toUpperCase();
              if (tdMatch && Number(tdMatch[1]) === Number(tipoDte) && rutCaf === rutMio) {
                const stat = fs.statSync(fullPath);
                matches.push({ filePath: fullPath, mtime: stat.mtimeMs });
              }
            } catch (_) {
              // ignore
            }
          }
        }
      } catch (_) {
        // ignore
      }
    };
    
    // Buscar en cafDir (auto-caf)
    searchRecursive(this.cafDir);
    
    // También buscar en el directorio de CAFs canónicos
    const canonicalDir = path.join(this.debugDir, 'caf', this.ambiente, this.rutEmisor, String(tipoDte));
    searchRecursive(canonicalDir);

    matches.sort((a, b) => b.mtime - a.mtime);
    return matches.map(m => m.filePath);
  }

  /**
   * Solicita un nuevo CAF al SII
   * @param {Object} params - Parámetros
   * @returns {Promise<boolean>} - true si fue exitoso
   */
  async solicitarCaf({ tipoDte, cantidad = 1 }) {
    if (!this.cafSolicitor) {
      throw new Error('FolioService: CafSolicitor no inicializado (se requiere pfxPath y pfxPassword)');
    }

    let attempt = 0;
    
    while (attempt <= this.config.retries) {
      try {
        const result = await this.cafSolicitor.solicitar({ tipoDte, cantidad });
        
        if (result.success) {
          return true;
        }

        console.log(`[FolioService] Intento ${attempt + 1} fallido: ${result.error}`);
      } catch (err) {
        console.log(`[FolioService] Error en intento ${attempt + 1}: ${err.message}`);
      }

      if (attempt >= this.config.retries) {
        throw new Error(`Fallo auto-CAF para tipo ${tipoDte}`);
      }

      await this._sleep(this.config.retryDelayMs);
      attempt += 1;
    }
    
    return false;
  }

  /**
   * Sleep asíncrono
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Solicita CAF con fallback a cantidad menor
   * @param {Object} params - Parámetros
   * @returns {Promise<string|null>} - Ruta al CAF obtenido
   */
  async solicitarCafConFallback({ tipoDte, cantidad, previousPath = null }) {
    try {
      await this.solicitarCaf({ tipoDte, cantidad });
    } catch (error) {
      // Continuar con fallback, pero dejar rastro: sin este log era imposible
      // diagnosticar por qué aparecían CAFs de 1 folio (el fallback de más abajo)
      // en vez del rango pedido.
      console.warn(`[FolioService] solicitarCaf tipo ${tipoDte} x${cantidad} falló: ${error.message} — probando fallback`);
    }
    
    let resolvedPath = this.findLatestCaf(tipoDte);

    if (this.config.singleRequest) {
      return resolvedPath;
    }

    // Si no hay CAF nuevo, intentar anular folios pendientes y pedir de nuevo
    if (!resolvedPath || resolvedPath === previousPath) {
      try {
        await this.anularFolios({ tipoDte });
        await this.solicitarCaf({ tipoDte, cantidad: 1 });
        resolvedPath = this.findLatestCaf(tipoDte);
      } catch (_) {
        // ignore
      }
    }

    // Fallback a cantidad 1
    const shouldFallback = (!resolvedPath || resolvedPath === previousPath) && Number(cantidad) > 1;
    if (shouldFallback) {
      try {
        await this.solicitarCaf({ tipoDte, cantidad: 1 });
        resolvedPath = this.findLatestCaf(tipoDte);
      } catch (_) {
        // ignore
      }
    }

    return resolvedPath;
  }

  /**
   * Cuenta los folios de un CAF leyendo su rango <D>/<H>.
   * @private
   * @returns {number} Cantidad de folios, o 0 si no se pudo parsear
   */
  _contarFoliosCaf(cafPath) {
    try {
      const xml = fs.readFileSync(cafPath, 'utf8');
      const d = xml.match(/<D>(\d+)<\/D>/);
      const h = xml.match(/<H>(\d+)<\/H>/);
      if (!d || !h) return 0;
      return Number(h[1]) - Number(d[1]) + 1;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Solicita un CAF garantizando una cantidad EXACTA de folios.
   *
   * A diferencia de `solicitarCafConFallback` — que acepta lo que el SII dé y
   * cae a 1 folio como último recurso, algo razonable para reponer folios de
   * emisión en runtime — este método sirve a flujos que necesitan N folios
   * exactos en una sola pasada (ej. la simulación de certificación, que genera
   * un plan fijo de documentos y muere si falta un folio).
   *
   * El SII raciona vía MAX_AUTOR según los folios timbrados sin utilizar
   * (FOLIOS_DISP), y si se acumulan pasa a bloqueo duro. Anularlos revierte
   * ambos estados — verificado contra maullin el 2026-07-22: anular 6 folios
   * llevó FOLIOS_DISP 6→0 y MAX_AUTOR 1→5, y levantó los bloqueos duros de los
   * tipos 56 y 61. Por eso acá se anula y se reintenta una vez.
   *
   * @param {Object} params
   * @param {number} params.tipoDte - Tipo de DTE
   * @param {number} params.cantidad - Folios requeridos (mínimo aceptable)
   * @param {boolean} [params.permitirAnular=true] - Si puede anular folios sin
   *   usar para destrabar el tope. Ponerlo en false lo deja en modo consulta.
   * @returns {Promise<Object>} { ok, cafPath, otorgados, maxAutor, foliosDisp, errorCode, error }
   */
  /**
   * Intenta cubrir `cantidad` folios recuperando un CAF ya autorizado, sin pedirle folios
   * nuevos al SII.
   *
   * Es el paso que va ANTES de pedir y muy antes de anular. Cuando el SII bloquea el
   * timbraje lo hace porque el contribuyente ya tiene folios sin usar; recuperarlos y
   * emitir con ellos es justo lo que el SII pide para levantar el bloqueo, mientras que
   * anular lo empeora (los folios anulados pesan 6 meses en contra del cupo).
   *
   * ⚠️ Solo sirve un rango que por sí solo alcance: el generador de sets recibe UN CAF por
   * tipo (`cafManager.ensureCaf({ tipoDte })` en CertRunner), así que no se pueden juntar
   * dos rangos sueltos para el mismo tipo. El SII suele entregarlos de a un folio, así que
   * esto no siempre alcanza — y cuando no alcanza, se devuelve el motivo en vez de fingir.
   *
   * @returns {Promise<{ ok: boolean, cafPath?: string, motivo?: string, disponibles?: number }>}
   */
  async reobtenerCaf({ tipoDte, cantidad, yaEmitido = null }) {
    if (!this.cafSolicitor) {
      return { ok: false, motivo: 'CafSolicitor no inicializado' };
    }
    let rangos;
    try {
      rangos = await this.cafSolicitor.listarReobtenibles(Number(tipoDte));
    } catch (err) {
      // Nunca fatal: si la reobtención falla, el flujo sigue por el camino normal.
      console.warn(`[FolioService] Tipo ${tipoDte}: no se pudo consultar reobtención — ${err.message}`);
      return { ok: false, motivo: err.message };
    }

    // ⚠️ El listado del portal NO dice si un folio ya se emitió.
    //
    // `anulado` es lo único que marca, y eso deja pasar los folios que ya viajaron al SII
    // dentro de un envío. Emitir de nuevo con ellos hace que el SII rechace cada documento
    // con `(DTE-3-101) Folio para este Tipo de documento ya fue recibido en el SII`.
    //
    // Pasó de verdad (24/08/2026): la corrida descartó los CAF en disco por tener folios
    // ya emitidos y, tres líneas después, la reobtención trajo esos mismos folios del
    // portal y los usó. Los 7 documentos del tipo 61 fueron rechazados.
    //
    // Por eso el llamador puede pasar `yaEmitido`: es el mismo registro con el que descarta
    // los CAF de disco (`CertRunner._rangoYaConsumido`), aplicado también acá. Sin ese dato
    // la reobtención no puede saberlo, porque el SII no lo publica.
    const emitidos = yaEmitido
      ? rangos.filter(r => yaEmitido({ folioDesde: r.folioDesde, folioHasta: r.folioHasta }))
      : [];
    const emitidosSet = new Set(emitidos);
    const usables = rangos.filter(r => !r.anulado && !emitidosSet.has(r));
    const anulados = rangos.filter(r => r.anulado).length;
    console.log(
      `[FolioService] Tipo ${tipoDte}: ${rangos.length} rango(s) reobtenible(s), ` +
      `${usables.length} usable(s)` +
      `${anulados ? `, ${anulados} anulado(s) descartado(s)` : ''}` +
      `${emitidos.length ? `, ${emitidos.length} ya emitido(s) descartado(s)` : ''}`
    );

    const total = usables.reduce((n, r) => n + r.cantidad, 0);
    if (total < cantidad) {
      return {
        ok: false,
        disponibles: total,
        motivo: `los rangos usables no alcanzan (se necesitan ${cantidad}, hay ${total})`,
      };
    }

    // En orden de folio ascendente: los documentos del set quedan numerados de menor a
    // mayor, como si vinieran de un rango contiguo.
    const elegidos = [];
    let acumulado = 0;
    for (const r of usables.sort((a, b) => a.folioDesde - b.folioDesde)) {
      if (acumulado >= cantidad) break;
      elegidos.push(r);
      acumulado += r.cantidad;
    }

    // Se descargan TODOS los que hagan falta: el SII entrega los folios reobtenidos de a
    // uno, así que cubrir 4 folios puede requerir 4 CAF distintos. Los sets los aceptan
    // como lista (ver SetBase._tomarFolio) porque cada uno firma con su propia llave.
    const cafPaths = [];
    for (const rango of elegidos) {
      const res = await this.cafSolicitor.reobtenerCaf(Number(tipoDte), rango);
      if (!res.success) {
        // Si uno falla a mitad, lo ya descargado igual sirve mientras alcance.
        console.warn(`[FolioService] Tipo ${tipoDte}: falló reobtener ${rango.folioDesde}-${rango.folioHasta} — ${res.error}`);
        continue;
      }
      cafPaths.push(res.cafPath);
      console.log(`[FolioService] Tipo ${tipoDte}: CAF REOBTENIDO (folios ${res.folioDesde}-${res.folioHasta}) — sin gastar cupo`);
    }

    const cubiertos = elegidos
      .filter((_, i) => i < cafPaths.length)
      .reduce((n, r) => n + r.cantidad, 0);
    if (cubiertos < cantidad) {
      return { ok: false, disponibles: cubiertos,
        motivo: `se reobtuvieron ${cubiertos} folio(s) de los ${cantidad} necesarios` };
    }
    return { ok: true, cafPaths, cafPath: cafPaths[0] };
  }

  /**
   * Consulta cuánto autoriza el SII para un tipo, SIN emitir nada.
   *
   * Recorre el flujo de timbraje solo hasta el formulario que expone MAX_AUTOR y
   * FOLIOS_DISP, y corta ahí. Sirve para decidir si hace falta anular folios antes de
   * pedir, en vez de anular siempre por las dudas.
   *
   * ⚠️ Ausencia de MAX_AUTOR no es cero: el SII **solo publica esos campos cuando está
   * racionando** ese tipo de documento (verificado 2026-07-22: tras anular folios, los
   * tipos 56 y 61 dejaron de exponerlos). Por eso se devuelve `sinTope: true`, que
   * significa "el SII no está limitando", no "no se pudo leer".
   *
   * @returns {Promise<{ sinTope: boolean, maxAutor: number|null, foliosDisp: number|null }>}
   */
  async consultarTope({ tipoDte }) {
    if (!this.cafSolicitor) {
      throw new Error('FolioService: CafSolicitor no inicializado (se requiere pfxPath y pfxPassword)');
    }
    this.cafSolicitor._lastBloqueoTimbraje = false;
    await this.cafSolicitor.solicitar({ tipoDte, cantidad: 1, soloConsultarTope: true });
    const maxAutor   = this.cafSolicitor._lastMaxAutor ?? null;
    const foliosDisp = this.cafSolicitor._lastFoliosDisp ?? null;
    const bloqueado  = this.cafSolicitor._lastBloqueoTimbraje === true;
    // `_lastFoliosDisp` queda en null en DOS casos opuestos: cuando el SII no está
    // limitando este tipo, y cuando lo tiene bloqueado del todo (ahí tampoco publica los
    // campos, muestra "NO AUTORIZA TIMBRAJE"). Sin `bloqueado`, el segundo se leía como el
    // primero y el llamador se saltaba la limpieza que era justo lo que hacía falta.
    return { sinTope: foliosDisp === null && !bloqueado, maxAutor, foliosDisp, bloqueado };
  }

  async solicitarCafExacto({ tipoDte, cantidad, permitirAnular = true }) {
    if (!this.cafSolicitor) {
      throw new Error('FolioService: CafSolicitor no inicializado (se requiere pfxPath y pfxPassword)');
    }

    const pedir = () =>
      this.cafSolicitor.solicitar({ tipoDte, cantidad, minCantidad: cantidad });

    let result = await pedir();

    // Ambos códigos tienen la misma causa raíz (folios sin utilizar acumulados)
    // y el mismo remedio. MAX_AUTOR_INSUFICIENTE aborta antes de emitir;
    // TIMBRAJE_BLOQUEADO es el estado terminal al que se llega si se ignora.
    const recuperable =
      result.errorCode === 'MAX_AUTOR_INSUFICIENTE' ||
      result.errorCode === 'TIMBRAJE_BLOQUEADO';

    // ⚠️ `!== 0` estricto. FOLIOS_DISP es el total de folios timbrados y sin utilizar,
    // que es exactamente el conjunto anulable (el SII solo anula folios "que no han sido
    // recepcionados"). Con 0 la anulación no puede prosperar y solo gasta requests: el
    // 19/08/2026 una corrida intentó anular 4 folios ya emitidos, uno por uno, para
    // terminar en `SIN_FOLIOS_ANULABLES` y un mensaje que culpaba a folios inexistentes.
    // Con el timbraje BLOQUEADO el SII no publica el campo y queda `null`, y ese caso sí
    // necesita intentarlo.
    const hayQueAnular = result.foliosDisp !== 0;

    if (!result.success && recuperable && permitirAnular && hayQueAnular) {
      console.warn(
        `[FolioService] Tipo ${tipoDte}: ${result.errorCode} — anulando folios sin utilizar y reintentando...`
      );
      try {
        // Acotado: acá sí interesan los folios viejos (son los que inflan
        // FOLIOS_DISP), pero sin barrer el historial entero — anular de a
        // cientos satura al SII y suma al contador de "anulados últimos 6
        // meses", que también juega en contra del cupo.
        const anul = await this.anularFolios({ tipoDte, maxRangos: 20 });

        // Desglosar los motivos reales del rechazo: no todos son "ya recepcionado"
        // (folio consumido en un DTE enviado). También caen acá los folios ya
        // anulados en una pasada anterior, que el SII sigue listando como
        // candidatos pero rechaza al reintentar.
        const motivos = (anul.rechazados || []).reduce((acc, r) => {
          const k = r.reason || 'sin motivo';
          acc[k] = (acc[k] || 0) + (r.count || 1);
          return acc;
        }, {});
        const detalleMotivos = Object.entries(motivos)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
        console.log(
          `[FolioService] Tipo ${tipoDte}: ${anul.totalAnulados} folio(s) anulado(s), ` +
          `${anul.totalRechazados} rechazado(s)${detalleMotivos ? ` (${detalleMotivos})` : ''}`
        );

        if (anul.totalAnulados === 0) {
          // Sin folios liberados, el tope del SII no se movió: reintentar es un
          // request garantizado a fallar. Se corta acá con un diagnóstico preciso.
          return {
            ok: false,
            cafPath: null,
            otorgados: 0,
            maxAutor: result.maxAutor ?? null,
            foliosDisp: result.foliosDisp ?? null,
            errorCode: 'SIN_FOLIOS_ANULABLES',
            error:
              `El SII tiene bloqueado el timbraje del tipo ${tipoDte} y no quedan folios anulables ` +
              `(${anul.totalRechazados} rechazado(s)${detalleMotivos ? `: ${detalleMotivos}` : ''}). ` +
              `Para destrabarlo hay que emitir y enviar al SII documentos de este tipo con los folios ya timbrados, ` +
              `o esperar: el SII recalcula el tope según la emisión y las anulaciones de los últimos 6 meses.`,
          };
        }

        result = await pedir();
      } catch (err) {
        console.warn(`[FolioService] Tipo ${tipoDte}: anulación falló: ${err.message}`);
      }
    }

    const base = {
      maxAutor: result.maxAutor ?? null,
      foliosDisp: result.foliosDisp ?? null,
    };

    if (!result.success) {
      return {
        ok: false,
        cafPath: null,
        otorgados: 0,
        ...base,
        errorCode: result.errorCode || 'UNKNOWN',
        error: result.error || `No se pudo obtener CAF para tipo ${tipoDte}`,
      };
    }

    // Defensa final: aunque MAX_AUTOR haya dado el visto bueno, verificar que el
    // rango realmente alcance antes de dárselo por bueno al llamador.
    const otorgados = this._contarFoliosCaf(result.cafPath);
    if (otorgados < Number(cantidad)) {
      return {
        ok: false,
        cafPath: result.cafPath,
        otorgados,
        ...base,
        errorCode: 'FOLIOS_INSUFICIENTES',
        error: `SII otorgó ${otorgados} folio(s) de ${cantidad} requeridos para el tipo ${tipoDte}.`,
      };
    }

    return { ok: true, cafPath: result.cafPath, otorgados, ...base };
  }

  /**
   * Cubre `cantidad` folios en varios timbrajes cuando el SII no autoriza tantos de
   * una vez.
   *
   * `solicitarCafExacto` exige que UN CAF cubra todo y aborta si `MAX_AUTOR` no da.
   * Eso es correcto para no agravar el racionamiento cuando hay folios sin usar
   * (anular/reobtener sí destraba ese caso), pero deja sin salida el caso contrario:
   * `FOLIOS_DISP=0` y `MAX_AUTOR` chico porque el SII raciona por historial. Ahí no
   * hay nada que anular ni que reobtener, y la única vía es pedir de a tandas.
   *
   * Medido el 19/08/2026 (RUT 76543210-K, maullin): el set de simulación necesita 4
   * folios de tipo 33, el SII autorizaba 3 con FOLIOS_DISP=0, y el tope siguió en 3
   * durante 24 h. Esperar no lo mueve.
   *
   * Los sets aceptan varios CAF por tipo (`SetBase._tomarFolio` recorre la lista y
   * salta al siguiente cuando se agota un rango), así que juntar tandas es
   * transparente para quien genera los documentos.
   *
   * ⚠️ Cada tanda sube `FOLIOS_DISP` y puede bajar el `MAX_AUTOR` de la siguiente. Por
   * eso se corta apenas una tanda no aporta folios nuevos, en vez de insistir: cada
   * pedido inútil deja folios timbrados que después juegan en contra.
   *
   * @param {Object} params
   * @param {number} params.tipoDte
   * @param {number} params.cantidad - folios a cubrir en total
   * @param {number} [params.maxTandas=4] - tope duro de viajes al portal
   * @param {Object} [params.topeInicial] - resultado de `consultarTope` ya en mano, para
   *   no repetir el sondeo de la primera tanda (cuesta ~3 requests al portal).
   * @returns {Promise<{ ok: boolean, cafPaths: string[], otorgados: number,
   *   maxAutor: number|null, foliosDisp: number|null, errorCode?: string, error?: string }>}
   */
  async solicitarCafPorTandas({ tipoDte, cantidad, maxTandas = 4, topeInicial = null }) {
    if (!this.cafSolicitor) {
      throw new Error('FolioService: CafSolicitor no inicializado (se requiere pfxPath y pfxPassword)');
    }

    const objetivo = Number(cantidad);
    const cafPaths = [];
    let cubiertos = 0;
    let tope = null;

    for (let tanda = 1; tanda <= maxTandas && cubiertos < objetivo; tanda++) {
      tope = (tanda === 1 && topeInicial) ? topeInicial : await this.consultarTope({ tipoDte });
      const faltan = objetivo - cubiertos;

      // `sinTope` = el SII no publica MAX_AUTOR, o sea no está racionando este tipo:
      // se pide todo lo que falta de una.
      const pedir = tope.sinTope ? faltan : Math.min(tope.maxAutor ?? 0, faltan);
      if (pedir <= 0) {
        console.warn(
          `[FolioService] Tipo ${tipoDte}: tanda ${tanda} sin cupo ` +
          `(MAX_AUTOR=${tope.maxAutor}, FOLIOS_DISP=${tope.foliosDisp}) — se corta con ${cubiertos}/${objetivo}`
        );
        break;
      }

      console.log(
        `[FolioService] Tipo ${tipoDte}: tanda ${tanda} pide ${pedir} folio(s) ` +
        `(faltan ${faltan}; MAX_AUTOR=${tope.maxAutor ?? 'sin tope'}, FOLIOS_DISP=${tope.foliosDisp ?? 'sin dato'})`
      );

      const res = await this.cafSolicitor.solicitar({ tipoDte, cantidad: pedir, minCantidad: 1 });
      const otorgados = res.success ? this._contarFoliosCaf(res.cafPath) : 0;
      if (!otorgados) {
        console.warn(
          `[FolioService] Tipo ${tipoDte}: tanda ${tanda} no entregó folios ` +
          `(${res.errorCode || 'sin código'}: ${res.error || 'sin detalle'}) — se corta`
        );
        break;
      }

      cafPaths.push(res.cafPath);
      cubiertos += otorgados;
      console.log(`[FolioService] Tipo ${tipoDte}: tanda ${tanda} entregó ${otorgados} folio(s) — ${cubiertos}/${objetivo}`);
    }

    const base = { maxAutor: tope?.maxAutor ?? null, foliosDisp: tope?.foliosDisp ?? null };
    if (cubiertos < objetivo) {
      return {
        ok: false, cafPaths, otorgados: cubiertos, ...base,
        errorCode: 'TOPE_SII_INSUFICIENTE',
        error:
          `El SII autorizó ${cubiertos} folio(s) de los ${objetivo} que necesita el tipo ${tipoDte}, ` +
          `repartidos en ${cafPaths.length} timbraje(s). No hay folios sin utilizar que anular ni recuperar ` +
          `(FOLIOS_DISP=${base.foliosDisp}): el tope lo fija el SII según el historial de timbraje y emisión.`,
      };
    }
    return { ok: true, cafPaths, otorgados: cubiertos, ...base };
  }

  /**
   * Consulta el estado de folios en el SII
   * @param {Object} params - Parámetros
   * @returns {Promise<Object>}
   */
  async consultarFolios({ tipoDte }) {
    const { rut, dv } = SiiSession.parseRut(this.rutEmisor);
    const debugStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDir = path.join(this.debugDir, 'auto-caf', 'anulacion', debugStamp);
    fs.mkdirSync(debugDir, { recursive: true });

    // Asegurar sesión — sin reset() para reutilizar cookieJar cargado del caché
    const page = await this.session.ensureSession('/cvc_cgi/dte/af_anular1');

    // Persistir sesión para reutilizar en llamadas posteriores (evita abrir sesiones SII extra)
    if (this.sessionPath) {
      try { this.session.saveSession(this.sessionPath); } catch (_) {}
    }

    if (!page.body || !page.body.includes('ANULACION DE FOLIOS')) {
      fs.writeFileSync(path.join(debugDir, 'error.html'), page.body || '', 'utf8');
      throw new Error('No se pudo acceder a la página de anulación.');
    }

    // Consultar folios
    const hiddenInputs = SiiSession.extractInputValues(page.body);
    const fields = {
      ...hiddenInputs,
      RUT_EMP: rut,
      DV_EMP: dv,
      PAGINA: '1',
      COD_DOCTO: String(tipoDte),
      ACEPTAR: 'Consultar',
    };

    const consulta = await this._withRetry('af_anular2', () =>
      this.session.submitForm(
        '/cvc_cgi/dte/af_anular2',
        fields,
        `https://${this.session.getBaseHost()}/cvc_cgi/dte/af_anular1`
      )
    );

    let currentHtml = consulta.body || '';
    try { fs.writeFileSync(path.join(debugDir, 'page-1.html'), currentHtml, 'utf8'); } catch (_) {}
    let info = this._parseAnulacionTable(currentHtml);
    let action = SiiSession.extractFormActionByName(currentHtml, 'frm') || '/cvc_cgi/dte/af_anular2';
    let hiddenInputsConsulta = SiiSession.extractInputValues(currentHtml);

    // Paginar resultados
    let nextButton = this._findNextButton(currentHtml);
    let safety = 0;
    
    while (nextButton && safety < 20) {
      const formInputs = SiiSession.extractFormInputsByName(currentHtml, 'frm');
      const nextFields = { ...formInputs };
      
      if (Number.isFinite(nextButton.page)) {
        nextFields.PAGINA = String(nextButton.page);
      }
      
      const nextRes = await this._withRetry(`af_anular2 pág ${nextButton.page || safety + 2}`, () =>
        this.session.submitForm(
          action,
          nextFields,
          `https://${this.session.getBaseHost()}/cvc_cgi/dte/af_anular2`
        )
      );

      currentHtml = nextRes.body || '';
      
      try {
        const pageStamp = nextButton.page ? `page-${nextButton.page}` : `page-${safety + 2}`;
        fs.writeFileSync(path.join(debugDir, `${pageStamp}.html`), currentHtml, 'utf8');
      } catch (_) {
        // ignore
      }
      
      const nextInfo = this._parseAnulacionTable(currentHtml);
      info = {
        ranges: this._mergeRanges(info.ranges, nextInfo.ranges),
        ultimoFolioFinal: Math.max(info.ultimoFolioFinal || 0, nextInfo.ultimoFolioFinal || 0) || null,
      };

      action = SiiSession.extractFormActionByName(currentHtml, 'frm') || action;
      hiddenInputsConsulta = SiiSession.extractInputValues(currentHtml);
      nextButton = this._findNextButton(currentHtml);
      safety += 1;
    }

    console.log(`[FolioService] consultarFolios tipoDte=${tipoDte}: ${info.ranges.length} rango(s) encontrado(s)`);
    return {
      ok: true,
      tipoDte,
      baseHost: this.session.getBaseHost(),
      html: consulta.body || '',
      action,
      hiddenInputs: hiddenInputsConsulta,
      ...info,
    };
  }

  /**
   * Anula folios en el SII usando el flujo bulk: af_anular3 → af_anular.
   * Un request por rango CAF en lugar de un request por folio individual.
   *
   * @param {Object} params
   * @param {number} params.tipoDte
   * @param {number|null} [params.folioDesde]  - Si se omite, anula todos los rangos pendientes
   * @param {number|null} [params.folioHasta]
   * @param {string} [params.motivo]
   * @returns {Promise<{ok:boolean, anulados:Array, rechazados:Array, totalAnulados:number, totalRechazados:number}>}
   */
  /**
   * @param {number} [params.soloUltimosDias] - Si se indica, solo se anulan los
   *   rangos timbrados dentro de esos días. Sirve para limpiar los sobrantes de
   *   una corrida reciente sin tocar el historial de la empresa: sin este filtro
   *   la función barre TODOS los rangos sin utilizar, lo que en un RUT con
   *   volumen real significa cientos de anulaciones contra el SII — y, peor, el
   *   propio SII cuenta los folios anulados de los últimos 6 meses en contra del
   *   cupo de timbraje. Verificado 2026-07-22: una limpieza sin acotar anuló 296
   *   folios de un RUT antes de detenerla.
   */
  /**
   * Ruta del registro de rangos ya anulados, por RUT y tipo de DTE.
   *
   * El SII sigue listando un folio anulado como "sin utilizar" —anulado es, en
   * efecto, sin usar— así que `consultarFolios` lo devuelve para siempre y cada
   * limpieza vuelve a intentarlo. Sin memoria entre corridas eso son
   * round-trips al SII que solo pueden fallar, y peor: van comiendo el cupo de
   * `maxRangos`, hasta dejar fuera a los sobrantes que sí hay que anular.
   */
  _anuladosPath(tipoDte) {
    const rutLimpio = String(this.rutEmisor || '').replace(/[^0-9kK]/g, '');
    return path.join(this.stateDir, `folios-anulados-${rutLimpio}-${tipoDte}.json`);
  }

  /** Set de claves "desde-hasta" que el SII ya reportó como anuladas. */
  _cargarAnulados(tipoDte) {
    try {
      const raw = fs.readFileSync(this._anuladosPath(tipoDte), 'utf8');
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
      // Sin registro previo (o ilegible): se parte de cero. Nunca es fatal —
      // como mucho se repite el intento una vez más.
      return new Set();
    }
  }

  _guardarAnulados(tipoDte, set) {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this._anuladosPath(tipoDte), JSON.stringify([...set]), 'utf8');
    } catch (err) {
      console.warn(`[FolioService] No se pudo persistir registro de anulados: ${err.message}`);
    }
  }

  async anularFolios({ tipoDte, folioDesde = null, folioHasta = null, motivo = 'Folios no utilizados', maxRangos = 50, soloUltimosDias = null }) {
    const debugStampA = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDirA = path.join(this.debugDir, 'auto-caf', 'anulacion', debugStampA);
    fs.mkdirSync(debugDirA, { recursive: true });

    const { rut, dv } = SiiSession.parseRut(this.rutEmisor);
    const anulados   = [];
    const rechazados = [];
    const vistos     = new Set(); // claves "folioDesde-folioHasta" ya procesadas en esta ejecución
    // Rangos que el SII ya reportó como anulados en corridas anteriores: se
    // saltan de entrada para no gastar el cupo de `maxRangos` en reintentos
    // que solo pueden volver a fallar. Ver `_anuladosPath`.
    const yaAnulados = this._cargarAnulados(tipoDte);
    const yaAnuladosInicial = yaAnulados.size;

    const maxPasadas = 4;

    for (let pasada = 0; pasada < maxPasadas; pasada++) {
      const consulta = await this.consultarFolios({ tipoDte });

      // Corte por antigüedad: `fecha` viene como DD-MM-AAAA en cada rango.
      // Un rango sin fecha parseable se descarta cuando el filtro está activo —
      // ante la duda, no anular.
      const limiteMs = Number.isFinite(soloUltimosDias)
        ? Date.now() - soloUltimosDias * 24 * 60 * 60 * 1000
        : null;

      // Filtrar rangos dentro del rango solicitado y que no hayamos intentado aún
      let rangos = consulta.ranges.filter(r => {
        if (Number.isFinite(folioDesde) && Number.isFinite(folioHasta)) {
          if (r.folioDesde > folioHasta || r.folioHasta < folioDesde) return false;
        }
        if (limiteMs !== null) {
          const { dia, mes, ano } = this._parseFecha(r.fecha);
          if (!dia || !mes || !ano) return false;
          const t = new Date(`${ano}-${mes}-${dia}T00:00:00`).getTime();
          if (!Number.isFinite(t) || t < limiteMs) return false;
        }
        const clave = `${r.folioDesde}-${r.folioHasta}`;
        if (yaAnulados.has(clave)) return false;
        return !vistos.has(clave);
      });

      // Limitar a los más recientes para evitar operaciones masivas
      if (rangos.length > maxRangos) rangos = rangos.slice(-maxRangos);

      if (rangos.length === 0) {
        console.log(`[FolioService] Pasada ${pasada + 1}: sin rangos nuevos, finalizando`);
        break;
      }

      console.log(`[FolioService] Pasada ${pasada + 1}: ${rangos.length} rango(s) a procesar`);
      const host = this.session.getBaseHost();

      // Corte cuando el SII deja de permitir anular, para no gastar requests confirmando
      // lo mismo rango tras rango.
      //
      // ⚠️ Solo cuentan las negativas REALES. `ya-anulado` y `recepcionado` no son
      // negativas: son resultados esperados (ese rango ya estaba anulado, o sus folios ya
      // se usaron) y aparecen mezclados con anulaciones exitosas.
      //
      // Contarlos rompía la limpieza (medido el 13/08/2026, RUT 76543210-K, tipo 33):
      //     20 rangos a procesar
      //     ✓ 47-49 anulado   ✓ 43-46 anulado
      //     ✗ 31-34 ya anulado ✗ 27-30 ya anulado  → CORTE, 8 rangos sin intentar
      // Los éxitos y los "ya anulado" se intercalan, así que cortar ahí abandona rangos
      // todavía anulables y deja el racionamiento puesto: la corrida quedó esperando por
      // folios que se podrían haber liberado en esa misma pasada.
      const NO_SON_NEGATIVA = new Set(['ya-anulado', 'recepcionado']);
      const esNegativaDelSii = (razon) => !NO_SON_NEGATIVA.has(razon);
      const MAX_RECHAZOS_SEGUIDOS = 2;
      let rechazosSeguidos = 0;

      let procesados = 0;
      for (const range of rangos) {
        if (rechazosSeguidos >= MAX_RECHAZOS_SEGUIDOS) {
          console.warn(
            `[FolioService] Tipo ${tipoDte}: ${rechazosSeguidos} rangos rechazados seguidos — ` +
            `el SII no está permitiendo anular, se abandona la limpieza ` +
            // Se cuenta contra los rangos de ESTA pasada, no contra `vistos`, que acumula
            // entre pasadas y hacía que el número saliera negativo (visto el 13/08/2026:
            // "se abandona la limpieza (-16 rango(s) sin intentar)").
            `(${rangos.length - procesados} rango(s) sin intentar).`
          );
          break;
        }
        procesados++;
        const anuladosAntes = anulados.length;
        vistos.add(`${range.folioDesde}-${range.folioHasta}`);
        const iniA = folioDesde != null ? Math.max(range.folioDesde, folioDesde) : range.folioDesde;
        const finA = folioHasta != null ? Math.min(range.folioHasta, folioHasta) : range.folioHasta;
        const count = finA - iniA + 1;
        const { dia, mes, ano } = this._parseFecha(range.fecha);

        // Paso 1: af_anular3 — obtener el formulario con campos ocultos del SII
        let body3;
        try {
          const r3 = await this._withRetry(`af_anular3 rango ${iniA}-${finA}`, () =>
            this.session.submitForm(
              '/cvc_cgi/dte/af_anular3',
              {
                RUT_EMP: rut, DV_EMP: dv,
                DIA: dia, MES: mes, ANO: ano,
                COD_DOCTO: String(tipoDte),
                FOLIO_INI: String(range.folioDesde),
                FOLIO_FIN: String(range.folioHasta),
                CANT_DOCTOS: String(range.cantidad ?? (range.folioHasta - range.folioDesde + 1)),
              },
              `https://${host}/cvc_cgi/dte/af_anular2`
            )
          );
          body3 = r3.body || '';
        } catch (err) {
          console.error(`[FolioService] af_anular3 falló rango ${iniA}-${finA}: ${err.message}`);
          rechazados.push({ folioDesde: iniA, folioHasta: finA, count, reason: 'error-red' });
          rechazosSeguidos = rechazosSeguidos + 1;
          continue;
        }

        // El SII responde "ha sido anulado anteriormente" (no "efectuado"), variante
        // que las tres cadenas originales no cubrían: el rango caía al POST de
        // af_anular con inputs vacíos y volvía una página de error con "Error 500",
        // registrándose como fallo genérico en vez de "ya anulado". Verificado
        // 2026-07-22 contra maullin, tipo 56 folios 2/4/5/6.
        if (body3.includes('ya ha sido efectuado') || body3.includes('ya fue anulado') ||
            body3.includes('efectuado anteriormente') ||
            /anulad[oa]\s+anteriormente/i.test(body3)) {
          rechazados.push({ folioDesde: iniA, folioHasta: finA, count, reason: 'ya-anulado' });
          // 'ya anulado' NO cuenta: es un no-op, no una negativa del SII.
          // Se recuerda para que la próxima corrida no lo reintente.
          yaAnulados.add(`${iniA}-${finA}`);
          console.warn(`[FolioService] ✗ Rango ${iniA}-${finA}: ya anulado (af_anular3)`);
          try { fs.writeFileSync(path.join(debugDirA, `rango-${iniA}-${finA}-af_anular3-error.html`), body3, 'utf8'); } catch (_) {}
          continue;
        }
        try { fs.writeFileSync(path.join(debugDirA, `rango-${iniA}-${finA}-af_anular3.html`), body3, 'utf8'); } catch (_) {}

        // Extraer campos ocultos del formulario devuelto por SII
        const formFields = SiiSession.extractInputValues(body3);
        formFields.FOLIO_INI_A = String(iniA);
        formFields.FOLIO_FIN_A = String(finA);
        formFields.MOTIVO = motivo;

        // Paso 2: af_anular — intentar anulación bulk del rango completo
        let bodyBulk;
        try {
          const rBulk = await this._withRetry(`af_anular bulk ${iniA}-${finA}`, () =>
            this.session.submitForm('/cvc_cgi/dte/af_anular', formFields, `https://${host}/cvc_cgi/dte/af_anular3`)
          );
          bodyBulk = rBulk.body || '';
        } catch (err) {
          console.error(`[FolioService] af_anular bulk falló rango ${iniA}-${finA}: ${err.message}`);
          rechazados.push({ folioDesde: iniA, folioHasta: finA, count, reason: 'error-red' });
          rechazosSeguidos = rechazosSeguidos + 1;
          continue;
        }

        const exitoBulk = bodyBulk.includes('ha autorizado la anulaci') ||
                          bodyBulk.includes('SOLICITUD ANULACION DE FOLIOS');
        if (exitoBulk) {
          anulados.push({ folioDesde: iniA, folioHasta: finA, count });
          rechazosSeguidos = 0;
          // Un rango recién anulado sigue apareciendo en `consultarFolios` como
          // "sin utilizar": si no se recuerda acá, la próxima corrida lo
          // reintenta y el SII contesta "ya anulado". Ésta es la fuente
          // principal de los rangos zombis.
          yaAnulados.add(`${iniA}-${finA}`);
          try { fs.writeFileSync(path.join(debugDirA, `rango-${iniA}-${finA}-af_anular-ok.html`), bodyBulk, 'utf8'); } catch (_) {}
          console.log(`[FolioService] ✓ Rango ${iniA}-${finA} (${count} folios) anulado en bulk`);
          continue;
        }

        try { fs.writeFileSync(path.join(debugDirA, `rango-${iniA}-${finA}-af_anular-fail.html`), bodyBulk, 'utf8'); } catch (_) {}
        console.warn(`[FolioService] bulk falló rango ${iniA}-${finA}: ${bodyBulk.slice(0, 300).replace(/\s+/g, ' ')}`);

        const yaConflicto = bodyBulk.includes('ya ha sido efectuado') ||
                            bodyBulk.includes('ya fue anulado') ||
                            bodyBulk.includes('efectuado anteriormente') ||
                            bodyBulk.includes('recepcionad');
        if (!yaConflicto) {
          const razon = this._parseAnulacionResult(bodyBulk).reason || 'error';
          rechazados.push({ folioDesde: iniA, folioHasta: finA, count, reason: razon });
          if (esNegativaDelSii(razon)) rechazosSeguidos = rechazosSeguidos + 1;
          // Mismo criterio que en el camino folio-a-folio: solo se recuerdan los
          // rechazos definitivos, no los transitorios.
          if (razon === 'ya-anulado' || razon === 'recepcionado') {
            yaAnulados.add(`${iniA}-${finA}`);
          }
          console.warn(`[FolioService] ✗ Rango ${iniA}-${finA} rechazado: ${razon}`);
          continue;
        }

        // Fallback: algunos folios del rango ya fueron anulados/receptados.
        // Reutilizar la sesión de af_anular3 y anular folio a folio.
        console.log(`[FolioService] Rango ${iniA}-${finA}: conflicto bulk, fallback folio-a-folio...`);
        let i = 0;
        for (let folio = iniA; folio <= finA; folio++) {
          i++;
          process.stdout.write(`\r[FolioService] ${iniA}-${finA}: folio ${folio} (${i}/${count})  `);
          const singleFields = { ...formFields, FOLIO_INI_A: String(folio), FOLIO_FIN_A: String(folio) };
          let bs;
          try {
            const rSingle = await this._withRetry(`af_anular folio ${folio}`, () =>
              this.session.submitForm('/cvc_cgi/dte/af_anular', singleFields, `https://${host}/cvc_cgi/dte/af_anular3`)
            );
            bs = rSingle.body || '';
          } catch (err) {
            rechazados.push({ folioDesde: folio, folioHasta: folio, count: 1, reason: 'error-red' });
            continue;
          }
          const ok = bs.includes('ha autorizado la anulaci') || bs.includes('SOLICITUD ANULACION DE FOLIOS');
          if (ok) {
            anulados.push({ folioDesde: folio, folioHasta: folio, count: 1 });
            yaAnulados.add(`${folio}-${folio}`);
          } else {
            const razon = this._parseAnulacionResult(bs).reason || 'error';
            rechazados.push({ folioDesde: folio, folioHasta: folio, count: 1, reason: razon });
            // Un folio ya anulado, o ya recepcionado en un DTE enviado, NO va a volver
            // a ser anulable nunca. Recordarlo es lo único que evita reintentarlo en
            // cada corrida. Faltaba justo acá, en el camino folio-a-folio, que es donde
            // caen casi todos los rechazos porque el bulk conflictúa siempre: en una
            // etapa medida el 11/08/2026 se registró 1 rango de 33 rechazos, y los 32
            // restantes se reintentaron desde cero en la corrida siguiente.
            // `error-red`, `error-sii-500` y `desconocido` quedan fuera a propósito:
            // son transitorios y sí conviene reintentarlos.
            if (razon === 'ya-anulado' || razon === 'recepcionado') {
              yaAnulados.add(`${folio}-${folio}`);
            }
          }
        }
        console.log('');
      }

      // Pausa breve entre pasadas para no saturar el SII
      if (pasada < maxPasadas - 1) await this._sleep(1500);
    }

    if (yaAnulados.size !== yaAnuladosInicial) {
      this._guardarAnulados(tipoDte, yaAnulados);
    }

    const totalAnulados   = anulados.reduce((s, r) => s + r.count, 0);
    const totalRechazados = rechazados.reduce((s, r) => s + r.count, 0);
    console.log(
      `[FolioService] Completado: ${totalAnulados} anulados, ${totalRechazados} rechazados` +
      (yaAnulados.size ? ` (${yaAnulados.size} rango(s) en memoria, se omiten en la próxima corrida)` : '')
    );

    return { ok: true, anulados, rechazados, totalAnulados, totalRechazados };
  }

  /**
   * Parsea una fecha "DD-MM-YYYY" o "DD/MM/YYYY" en sus componentes.
   * @private
   */
  _parseFecha(fecha) {
    const clean = String(fecha || '').replace(/[\s ]/g, '').trim();
    const m = clean.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m) return { dia: m[1].padStart(2, '0'), mes: m[2].padStart(2, '0'), ano: m[3] };
    // Si no tiene fecha válida, dejar vacío (el SII puede no requerirla siempre)
    return { dia: '', mes: '', ano: '' };
  }

  /**
   * Resuelve la ruta de un CAF, solicitando uno nuevo si es necesario
   * @param {Object} params - Parámetros
   * @returns {Promise<string|null>}
   */
  async resolveCafPath({ tipoDte, cafPath = null, autoCaf = true, requiredCount = 1 }) {
    let resolvedPath = cafPath;

    // Si no existe, buscar o solicitar
    if (autoCaf && (!resolvedPath || !fs.existsSync(resolvedPath))) {
      resolvedPath = await this.solicitarCafConFallback({
        tipoDte,
        cantidad: requiredCount,
      });
    }

    // Validar si hay folios suficientes
    if (autoCaf && resolvedPath && fs.existsSync(resolvedPath)) {
      const cafXml = fs.readFileSync(resolvedPath, 'utf8');
      const caf = new CAF(cafXml);
      const cafFingerprint = FolioRegistry.createCafFingerprint(cafXml);

      // Verificar con consulta al SII si está disponible
      if (this.config.useRegistry) {
        try {
          const siiInfo = await this.consultarFolios({ tipoDte: caf.getTipoDTE() });
          if (siiInfo && Number.isFinite(Number(siiInfo.ultimoFolioFinal))) {
            const last = Number(siiInfo.ultimoFolioFinal);
            if (Number(caf.getFolioHasta()) <= last) {
              resolvedPath = await this.solicitarCafConFallback({
                tipoDte,
                cantidad: requiredCount,
                previousPath: resolvedPath,
              });
            }
          }
        } catch (_) {
          // Continuar sin validación SII
        }
      }

      // Verificar folios restantes en registro local
      const remaining = this.registry.getRemainingFolios({
        rutEmisor: this.rutEmisor,
        tipoDte: caf.getTipoDTE(),
        folioDesde: caf.getFolioDesde(),
        folioHasta: caf.getFolioHasta(),
        ambiente: this.ambiente,
        cafFingerprint,
      });

      if (remaining < requiredCount) {
        resolvedPath = await this.solicitarCafConFallback({
          tipoDte,
          cantidad: requiredCount,
          previousPath: resolvedPath,
        });
      }
    }

    return resolvedPath;
  }

  /**
   * Reserva el siguiente folio disponible
   * @param {Object} params - Parámetros del CAF
   * @returns {number}
   */
  reserveNextFolio({ tipoDte, folioDesde, folioHasta, cafFingerprint }) {
    return this.registry.reserveNextFolio({
      rutEmisor: this.rutEmisor,
      tipoDte,
      folioDesde,
      folioHasta,
      ambiente: this.ambiente,
      cafFingerprint,
    });
  }

  /**
   * Marca un folio como enviado
   * @param {Object} params - Parámetros
   */
  markFolioSent(params) {
    this.registry.markFolioSent({
      rutEmisor: this.rutEmisor,
      ambiente: this.ambiente,
      ...params,
    });
  }

  /**
   * Libera folios del registro
   * @param {Object} params - Parámetros
   */
  releaseFolios(params) {
    this.registry.releaseFolios({
      rutEmisor: this.rutEmisor,
      ambiente: this.ambiente,
      ...params,
    });
  }

  // ============================================
  // MÉTODOS PRIVADOS DE PARSING
  // ============================================

  /**
   * @private
   */
  _parseAnulacionTable(html) {
    // Primario: extraer desde formularios (no depende de posición de columnas, más robusto
    // ante tablas anidadas que cortan el regex de filas)
    const formRanges = this._extractRangesFromForms(html);
    if (formRanges.length > 0) {
      const ultimoFolioFinal = formRanges.reduce((acc, r) => r.folioHasta > acc ? r.folioHasta : acc, 0);
      return { ranges: formRanges, ultimoFolioFinal: ultimoFolioFinal || null };
    }

    // Fallback: parsing por columnas de tabla (backup si no hay forms con FOLIO_INI/FOLIO_FIN)
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const ranges = [];

    rows.forEach((row) => {
      const cols = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (cols.length < 4) return;

      const selectionTag = SiiSession.extractInputTags(row).find((tag) => {
        const name = String(tag.name || '');
        const value = String(tag.value || '');
        return /selecc/i.test(name) || /selecc/i.test(value);
      });

      const formFields = SiiSession.extractFormInputsByName(row);
      const formAction = SiiSession.extractFormAction(row);

      const values = cols.map((c) => SiiSession.stripHtml(c));
      const folioDesde = SiiSession.parseIntFromText(values[2]);
      const folioHasta = SiiSession.parseIntFromText(values[3]);
      const cantidad = SiiSession.parseIntFromText(values[1]);
      const fecha = values[0] || null;
      const efectuadoPor = values[4] || null;

      if (!Number.isFinite(folioDesde) || !Number.isFinite(folioHasta)) return;

      ranges.push({
        fecha,
        cantidad: Number.isFinite(cantidad) ? cantidad : null,
        folioDesde,
        folioHasta,
        efectuadoPor,
        selection: selectionTag && selectionTag.name ? { name: selectionTag.name, value: selectionTag.value || '' } : null,
        formFields,
        formAction,
      });
    });

    const ultimoFolioFinal = ranges.reduce((acc, r) => (r.folioHasta > acc ? r.folioHasta : acc), 0);
    return { ranges, ultimoFolioFinal: ultimoFolioFinal || null };
  }

  /**
   * Extrae rangos de folios directamente de los <form> de la página af_anular2.
   * Cada fila de la tabla tiene un form con inputs ocultos FOLIO_INI, FOLIO_FIN,
   * CANT_DOCTOS, DIA, MES, ANO. Este método es más confiable que parsear columnas
   * porque no se ve afectado por tablas anidadas ni por variaciones en el orden de columnas.
   * @private
   */
  _extractRangesFromForms(html) {
    const ranges = [];
    const formRegex = /<form[^>]*>[\s\S]*?<\/form>/gi;
    const forms = String(html || '').match(formRegex) || [];

    forms.forEach(formHtml => {
      const fields = SiiSession.extractInputValues(formHtml);
      const folioDesde = SiiSession.parseIntFromText(fields.FOLIO_INI);
      const folioHasta = SiiSession.parseIntFromText(fields.FOLIO_FIN);
      if (!Number.isFinite(folioDesde) || !Number.isFinite(folioHasta)) return;

      const cantidadRaw = SiiSession.parseIntFromText(fields.CANT_DOCTOS);
      const cantidad = Number.isFinite(cantidadRaw) ? cantidadRaw : (folioHasta - folioDesde + 1);
      const dia = String(fields.DIA || '').padStart(2, '0');
      const mes = String(fields.MES || '').padStart(2, '0');
      const ano = fields.ANO || '';
      const fecha = (dia !== '00' && mes !== '00' && ano) ? `${dia}-${mes}-${ano}` : null;

      ranges.push({
        fecha,
        cantidad,
        folioDesde,
        folioHasta,
        efectuadoPor: null,
        selection: null,
        formFields: fields,
        formAction: SiiSession.extractFormAction(formHtml) || '',
      });
    });

    // Deduplicar por folioDesde+folioHasta (el SII puede repetir el mismo form)
    const seen = new Set();
    return ranges.filter(r => {
      const key = `${r.folioDesde}-${r.folioHasta}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * @private
   */
  _findNextButton(html) {
    const inputs = SiiSession.extractInputTags(html);
    const next = inputs.find((tag) => {
      const value = String(tag.value || '').toLowerCase();
      const name = String(tag.name || '').toLowerCase();
      return value.includes('ver siguiente') || value.includes('siguiente') || name.includes('siguiente') || name.includes('next');
    });
    
    if (!next || !next.name) return null;
    
    let page = null;
    if (next.onClick) {
      const match = String(next.onClick).match(/cambiapag\((\d+)\)/i);
      if (match) page = Number(match[1]);
    }
    
    return { name: next.name, value: next.value || '', page };
  }

  /**
   * @private
   */
  _mergeRanges(base, extra) {
    const out = [...base];
    extra.forEach((range) => {
      if (!out.some((r) => r.folioDesde === range.folioDesde && r.folioHasta === range.folioHasta)) {
        out.push(range);
      }
    });
    out.sort((a, b) => b.folioHasta - a.folioHasta);
    return out;
  }

  /**
   * @private
   */
  _setFolioFields(fields, folioDesde, folioHasta) {
    let setDesde = false;
    let setHasta = false;
    
    Object.keys(fields).forEach((key) => {
      if (/folio.*(ini|desde)/i.test(key)) {
        fields[key] = String(folioDesde);
        setDesde = true;
      }
      if (/folio.*(fin|hasta)/i.test(key)) {
        fields[key] = String(folioHasta);
        setHasta = true;
      }
    });
    
    if (!setDesde) fields.FOLIO_INICIAL = String(folioDesde);
    if (!setHasta) fields.FOLIO_FINAL = String(folioHasta);
  }

  /**
   * @private
   */
  _setMotivoField(fields, motivo) {
    let set = false;
    
    Object.keys(fields).forEach((key) => {
      if (/motivo|glosa|razon|coment/i.test(key)) {
        fields[key] = motivo;
        set = true;
      }
    });
    
    if (!set) fields.MOTIVO = motivo;
  }

  /**
   * @private
   */
  _parseAnulacionResult(html) {
    const text = String(html || '').toLowerCase();
    
    if (text.includes('recepcionad')) {
      return { ok: false, reason: 'recepcionado' };
    }
    
    if (
      text.includes('ya fue anulado') ||
      text.includes('anulado anteriormente') ||
      text.includes('ya ha sido efectuado anteriormente') ||
      (text.includes('anulad') && text.includes('ya'))
    ) {
      return { ok: false, reason: 'ya-anulado' };
    }
    
    if (
      text.includes('ha autorizado la anulaci') ||
      text.includes('ha autorizado la anulacion') ||
      text.includes('solicitud anulacion de folios')
    ) {
      return { ok: true, reason: 'anulado' };
    }
    
    if (text.includes('anulaci') && (text.includes('exit') || text.includes('realiz') || text.includes('correct'))) {
      return { ok: true, reason: 'anulado' };
    }
    
    if (text.includes('anulaci') && text.includes('no')) {
      return { ok: false, reason: 'rechazado' };
    }

    if (text.trim() === 'error 500' || text.includes('error 500') || text.includes('internal server error')) {
      return { ok: false, reason: 'error-sii-500' };
    }
    
    return { ok: null, reason: 'desconocido' };
  }

  /**
   * Reintenta una función async ante errores de red.
   * No reintenta en errores de lógica (respuestas HTML del SII con error).
   * @private
   */
  async _withRetry(label, fn) {
    const retries = this.config.retries ?? 2;
    const delayMs = this.config.retryDelayMs ?? 1500;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < retries) {
          console.warn(`[FolioService] ${label}: error "${err.message}", reintentando (${i + 1}/${retries})...`);
          await this._sleep(delayMs);
        }
      }
    }
    throw lastErr;
  }

  /** @private */
  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = FolioService;
