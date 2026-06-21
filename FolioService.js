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
    this.baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
    
    // Directorios
    this.cafDir = options.cafDir || path.join(this.baseDir, 'debug', 'auto-caf');
    this.debugDir = options.debugDir || path.join(this.baseDir, 'debug');
    
    // Sesión SII
    this.session = new SiiSession({
      ambiente: this.ambiente,
      certificado: options.certificado,
      pfxPath: options.pfxPath,
      pfxBuffer: options.pfxBuffer,
      pfxPassword: options.pfxPassword,
    });

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
    if (options.pfxPath && options.pfxPassword) {
      this.cafSolicitor = new CafSolicitor({
        ambiente: this.ambiente,
        rutEmisor: this.rutEmisor,
        pfxPath: options.pfxPath,
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
              if (tdMatch && Number(tdMatch[1]) === Number(tipoDte)) {
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

    if (!matches.length) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].filePath;
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
      // Continuar con fallback
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
  async anularFolios({ tipoDte, folioDesde = null, folioHasta = null, motivo = 'Folios no utilizados' }) {
    const debugStampA = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDirA = path.join(this.debugDir, 'auto-caf', 'anulacion', debugStampA);
    fs.mkdirSync(debugDirA, { recursive: true });

    const { rut, dv } = SiiSession.parseRut(this.rutEmisor);
    const anulados   = [];
    const rechazados = [];
    const vistos     = new Set(); // claves "folioDesde-folioHasta" ya procesadas en esta ejecución

    const maxPasadas = 4;

    for (let pasada = 0; pasada < maxPasadas; pasada++) {
      const consulta = await this.consultarFolios({ tipoDte });

      // Filtrar rangos dentro del rango solicitado y que no hayamos intentado aún
      let rangos = consulta.ranges.filter(r => {
        if (Number.isFinite(folioDesde) && Number.isFinite(folioHasta)) {
          if (r.folioDesde > folioHasta || r.folioHasta < folioDesde) return false;
        }
        return !vistos.has(`${r.folioDesde}-${r.folioHasta}`);
      });

      if (rangos.length === 0) {
        console.log(`[FolioService] Pasada ${pasada + 1}: sin rangos nuevos, finalizando`);
        break;
      }

      console.log(`[FolioService] Pasada ${pasada + 1}: ${rangos.length} rango(s) a procesar`);
      const host = this.session.getBaseHost();

      for (const range of rangos) {
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
          continue;
        }

        if (body3.includes('ya ha sido efectuado') || body3.includes('ya fue anulado') ||
            body3.includes('efectuado anteriormente')) {
          rechazados.push({ folioDesde: iniA, folioHasta: finA, count, reason: 'ya-anulado' });
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
          continue;
        }

        const exitoBulk = bodyBulk.includes('ha autorizado la anulaci') ||
                          bodyBulk.includes('SOLICITUD ANULACION DE FOLIOS');
        if (exitoBulk) {
          anulados.push({ folioDesde: iniA, folioHasta: finA, count });
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
          } else {
            const razon = this._parseAnulacionResult(bs).reason || 'error';
            rechazados.push({ folioDesde: folio, folioHasta: folio, count: 1, reason: razon });
          }
        }
        console.log('');
      }

      // Pausa breve entre pasadas para no saturar el SII
      if (pasada < maxPasadas - 1) await this._sleep(1500);
    }

    const totalAnulados   = anulados.reduce((s, r) => s + r.count, 0);
    const totalRechazados = rechazados.reduce((s, r) => s + r.count, 0);
    console.log(`[FolioService] Completado: ${totalAnulados} anulados, ${totalRechazados} rechazados`);

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
