// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * CafSolicitor.js - Solicitador de CAFs al SII
 * 
 * Módulo interno del core para solicitar Códigos de Autorización de Folios (CAF)
 * directamente al SII. Usa SiiSession para evitar duplicación de código.
 * 
 * Migrado desde: scripts/cert/test-caf-solicitar.js
 * Refactorizado: Usa SiiSession para HTTP y utilidades
 * 
 * @module CafSolicitor
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SiiSession = require('./SiiSession');
const SiiPortalAuth = require('./SiiPortalAuth');
const SiiSessionStore = require('./SiiSessionStore');
const { splitRut } = require('./utils/rut');

/**
 * Registro global de sesiones SII (singleton por ambiente+rut).
 * Permite reutilizar la misma sesión HTTP entre múltiples llamadas a CafSolicitor
 * sin abrir una nueva sesión en el portal del SII cada vez.
 * Clave: `${ambiente}::${rutEmisor}`
 * @type {Map<string, SiiSession>}
 */
const _sessionRegistry = new Map();

/**
 * Clase para solicitar CAFs al SII
 */
class CafSolicitor {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.ambiente - 'certificacion' o 'produccion'
   * @param {string} options.rutEmisor - RUT del emisor (ej: 76192083-9)
   * @param {string} options.pfxPath - Ruta absoluta al certificado PFX
   * @param {string} options.pfxPassword - Contraseña del certificado
   * @param {string} [options.baseDir] - Directorio base para guardar archivos
   * @param {string} [options.runStamp] - Timestamp de la ejecución
   */
  constructor(options = {}) {
    if (!options.ambiente) {
      throw new Error('CafSolicitor: options.ambiente es obligatorio');
    }
    if (!options.rutEmisor) {
      throw new Error('CafSolicitor: options.rutEmisor es obligatorio');
    }
    if (!options.pfxPath && !options.pfxBuffer) {
      throw new Error('CafSolicitor: options.pfxPath o options.pfxBuffer es obligatorio');
    }
    if (!options.pfxPassword) {
      throw new Error('CafSolicitor: options.pfxPassword es obligatorio');
    }

    this.ambiente = options.ambiente.toLowerCase();
    this.rutEmisor = options.rutEmisor;
    this.baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
    this.runStamp = options.runStamp || new Date().toISOString().replace(/[:.]/g, '-');

    // pfxBuffer tiene prioridad sobre pfxPath para evitar I/O a disco
    const _pfxBuffer = options.pfxBuffer || fs.readFileSync(options.pfxPath);

    const sessionKey = `${this.ambiente}::${this.rutEmisor}`;
    if (_sessionRegistry.has(sessionKey)) {
      this.session = _sessionRegistry.get(sessionKey);
      console.log('[CafSolicitor] ♻️ Reutilizando sesión SII en memoria');
    } else {
      this.session = new SiiSession({
        ambiente: this.ambiente,
        pfxBuffer: _pfxBuffer,
        pfxPassword: options.pfxPassword,
      });

      let certHash = null;
      try {
        const { certPem } = SiiPortalAuth._extractPems(_pfxBuffer, options.pfxPassword);
        certHash = crypto.createHash('sha1').update(certPem).digest('hex').slice(0, 12);

        const existingCookies = SiiPortalAuth.getCookieStringForPfx(_pfxBuffer, options.pfxPassword);
        if (existingCookies) {
          this.session.cookieJar = existingCookies;
          console.log('[CafSolicitor] 🔗 Sesión SII pre-cargada desde store compartido — sin auth extra');
        } else {
          console.log('[CafSolicitor] 🔑 Sin sesión previa — SiiSession hará su propio auth');
        }
      } catch (_e) {
        console.warn('[CafSolicitor] No se pudo leer PFX para seed de cookies:', _e.message);
      }

      // Monkey-patch: al autenticar, escribe las cookies al store compartido
      // para que SiiPortalAuth pueda reutilizarlas (dirección inversa de la unificación).
      if (certHash && typeof this.session.loginWithCertificate === 'function') {
        const _origLogin = this.session.loginWithCertificate.bind(this.session);
        this.session.loginWithCertificate = async (...args) => {
          const result = await _origLogin(...args);
          if (this.session.cookieJar && certHash) {
            SiiSessionStore.set(certHash, this.session.cookieJar);
            console.log('[CafSolicitor] 🔗 Sesión post-login escrita al store compartido (hash=' + certHash + ')');
          }
          return result;
        };
      }

      _sessionRegistry.set(sessionKey, this.session);
      console.log('[CafSolicitor] 🔑 Nueva sesión SII registrada para', sessionKey);
    }
  }

  /**
   * Crea directorio para debug de esta solicitud
   * @private
   */
  _getDebugDir(tipoDte) {
    const rutClean = String(this.rutEmisor).replace(/\./g, '').toUpperCase();
    const runDir = path.join(this.baseDir, 'debug', 'auto-caf', rutClean, this.runStamp, String(tipoDte));
    fs.mkdirSync(runDir, { recursive: true });
    return runDir;
  }

  /**
   * Guarda respuesta de debug
   * @private
   */
  _saveDebug(debugDir, filename, content) {
    const filePath = path.join(debugDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Extrae información del CAF desde XML
   * @private
   */
  _extractCafInfo(xml, tipoDte) {
    const tdMatch = xml.match(/<TD>(\d+)<\/TD>/i);
    const dMatch = xml.match(/<D>(\d+)<\/D>/i);
    const hMatch = xml.match(/<H>(\d+)<\/H>/i);
    const faMatch = xml.match(/<FA>(\d{4}-\d{2}-\d{2})<\/FA>/i);
    
    return {
      tipoDte: tdMatch ? tdMatch[1] : tipoDte,
      folioDesde: dMatch ? dMatch[1] : 'unknown',
      folioHasta: hMatch ? hMatch[1] : 'unknown',
      fechaAutorizacion: faMatch ? faMatch[1] : new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * Guarda el CAF en ubicación organizada
   * @private
   */
  _saveCafOrganized(xml, tipoDte) {
    const info = this._extractCafInfo(xml, tipoDte);
    const rutClean = this.rutEmisor.replace(/\./g, '').toUpperCase();
    
    const cafDir = path.join(
      this.baseDir, 'debug', 'caf', this.ambiente,
      rutClean, String(info.tipoDte), this.runStamp
    );
    fs.mkdirSync(cafDir, { recursive: true });
    
    const cafFileName = `caf-${info.tipoDte}-${info.folioDesde}-${info.folioHasta}.xml`;
    const cafPath = path.join(cafDir, cafFileName);
    fs.writeFileSync(cafPath, xml, 'utf-8');
    
    console.log(`[OK] CAF guardado: ${cafFileName}`);
    console.log(` Ruta: ${cafPath}`);
    
    return cafPath;
  }

  /**
   * Detecta si la respuesta del SII requiere autenticación con certificado.
   * @private
   */
  _requiresAuthentication(responseBody = '') {
    if (!responseBody || typeof responseBody !== 'string') return false;

    return (
      responseBody.includes('Autenticaci') ||
      responseBody.includes('autInicioDTE.cgi') ||
      responseBody.includes('cgi_AUT2000') ||
      responseBody.includes('302 Found')
    );
  }

  /**
   * Detecta la página de bloqueo duro de timbraje del SII.
   *
   * El SII usa al menos DOS redacciones para la misma página de rechazo:
   *   - "NO SE AUTORIZA TIMBRAJE ELECTRÓNICO"  (la documentada en PLAN-MEJORAS-CAF.md)
   *   - "NO AUTORIZA TIMBRAJE ELECTRÓNICA"     (observada 2026-07-22 en tipo 56)
   *
   * Detectar solo la primera hacía que la segunda cayera al genérico
   * `UNKNOWN: No se obtuvo CAF en la respuesta`, sin disparar el remedio de
   * anular folios — que es justamente lo que la página pide hacer. Ambas
   * variantes carecen de <form> e <input>, así que sin esta detección el flujo
   * sigue de largo hasta fallar sin diagnóstico.
   *
   * @param {string} html - Cuerpo de la respuesta del SII
   * @returns {boolean}
   */
  /**
   * Campos de tipo de documento del formulario de postulación (`pe_confirma`),
   * verificados contra el form real del SII el 2026-07-22.
   *
   * El listado original omitía `CONIVA`, `SET11`, `BOLELE` y `BOLEXE`, que el
   * SII sí incluye. Se exportan acá para que el consumidor no tenga que
   * mantener la lista duplicada.
   */
  static get CAMPOS_POSTULACION() {
    return {
      // Factura electrónica
      ESFAC: 'S',   // habilita la sección factura
      FACT: 'S',    // Facturas
      CONIVA: 'S',  // con IVA
      NC: 'S',      // Notas de crédito
      ND: 'S',      // Notas de débito
      SET03: 'S',   // Guías de despacho
      SET06: 'S',   // Facturas exentas
      SET72: 'S',   // Factura de compra
      // Boleta electrónica
      ESBOL: 'S',   // habilita la sección boleta
      BOLELE: 'S',
      BOLELEC: 'S', // Boleta electrónica
      BOLEXE: 'S',
      BOLEXEN: 'S', // Boleta exenta electrónica
      // NO se marcan por defecto:
      //   SET11 → Documentos de exportación (requiere trámite aduanero aparte)
      //   SET84 → Liquidación factura electrónica (caso de uso específico)
    };
  }

  static esBloqueoTimbraje(html) {
    return /NO\s+(SE\s+)?AUTORIZA\s+TIMBRAJE/i.test(String(html || ''));
  }

  /**
   * Solicita un CAF al SII
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE (33, 34, 39, 56, 61, etc.)
   * @param {number} [params.cantidad=1] - Cantidad de folios a solicitar
   * @param {number} [params.minCantidad] - Mínimo aceptable. Si el SII declara un
   *   MAX_AUTOR menor, se aborta ANTES de emitir en vez de aceptar un rango corto
   *   (ver `_processStep3`). Útil para flujos que necesitan N folios exactos, como
   *   la simulación de certificación.
   * @returns {Promise<Object>} - { success, cafPath, xml, maxAutor, foliosDisp, error, errorCode }
   */
  async solicitar({ tipoDte, cantidad = 1, minCantidad = null }) {
    const { numero: rut, dv } = splitRut(this.rutEmisor);
    const debugDir = this._getDebugDir(tipoDte);

    // Estado por-solicitud leído desde el form del SII en _processStep3
    this._lastMaxAutor = null;
    this._lastFoliosDisp = null;
    this._maxAutorInsuficiente = false;
    this._minCantidad = minCantidad;

    // Rate limiting: mínimo 1001ms entre solicitudes para no saturar el portal SII.
    const _now = Date.now();
    const _elapsed = _now - CafSolicitor._lastSolicitudAt;
    if (_elapsed < 1001) await new Promise(r => setTimeout(r, 1001 - _elapsed));
    CafSolicitor._lastSolicitudAt = Date.now();

    console.log('─'.repeat(60));
    console.log(`[CafSolicitor] Solicitando CAF tipo ${tipoDte} x${cantidad}`);
    console.log(` RUT: ${this.rutEmisor} | Ambiente: ${this.ambiente}`);

    try {
      const fields = {
        RUT_EMP: rut,
        DV_EMP: dv,
        COD_DOCTO: tipoDte,
        CANTIDAD: cantidad,
      };

      // Paso 1: asegurar sesión con un GET real ANTES de cualquier POST.
      // El SII liga la cookie de sesión al GET que la originó (Tivoli/F5); un POST
      // que no fue precedido de un GET fresco al mismo path en la misma sesión es
      // tratado como fuera de contexto y redirige a autInicioDTE aunque las cookies
      // sean válidas. Replicamos el flujo real de un browser: GET formulario →
      // parsear <form action> + hidden fields → submit con esos campos + los propios.
      const authResponse = await this.session.ensureSession('/cvc_cgi/dte/of_solicita_folios');

      this._saveDebug(debugDir, 'step0-ensureSession.html', authResponse.body || '');

      let response;
      if (this._requiresAuthentication(authResponse.body)) {
        // Sesión sigue inválida tras ensureSession — el chequeo de más abajo
        // detectará esto sobre el body final y retornará SESSION_EXPIRED.
        response = authResponse;
      } else {
        const formAction = SiiSession.extractFormAction(authResponse.body) || '/cvc_cgi/dte/of_solicita_folios';
        const hiddenFields = SiiSession.extractInputValues(authResponse.body);
        response = await this.session.submitForm(formAction, { ...hiddenFields, ...fields });
      }

      this._saveDebug(debugDir, 'step1-submit.html', response.body || '');

      // Guardar sesión para reutilización
      if (this.sessionPath) {
        this.session.saveSession(this.sessionPath);
      }

      // Rechazo duro por falta de Verificación de Actividades: debe detectarse ANTES de
      // _processMultiStepFlow. La página de rechazo también contiene el string
      // "of_solicita_folios_dcto" dentro del JS changeRegregion(), lo que hace que
      // _processMultiStepFlow la confunda con el paso 2 normal y siga de largo el flujo
      // multi-paso en vez de detectar el rechazo aquí, terminando en errorCode UNKNOWN.
      if (response.body && response.body.includes('no registra Verificacion de Actividades')) {
        return {
          success: false,
          errorCode: 'VERIFICACION_ACTIVIDADES_PENDIENTE',
          error: 'SII: El RUT no tiene registrada la Verificación de Actividades para este tipo de documento. Solicítala en el sitio SII → Peticiones Administrativas → Verificación de actividad, o en oficinas del SII.',
        };
      }

      // Procesar flujo multi-paso del SII
      response = await this._processMultiStepFlow(response, rut, dv, tipoDte, cantidad, debugDir);

      // Guardar respuesta final
      this._saveDebug(debugDir, 'caf-final.html', response.body || '');

      // Detectar bloqueo WAAP/firewall del SII antes de cualquier check de negocio
      if (response.status === 403 ||
          (response.body && (
            response.body.includes('acceso restringido') ||
            response.body.toLowerCase().includes('recaptcha')
          ))) {
        return { success: false, errorCode: 'WAAP_BLOCKED', error: 'IP bloqueada por el firewall del SII. Espera antes de reintentar.' };
      }

      // Abort temprano por MAX_AUTOR insuficiente (ver _processStep3). Se chequea antes
      // que el resto porque en este caso no se llegó a emitir nada: el body es la página
      // del paso previo, sin <AUTORIZACION> ni marcador de error propio.
      if (this._maxAutorInsuficiente) {
        return {
          success: false,
          errorCode: 'MAX_AUTOR_INSUFICIENTE',
          maxAutor: this._lastMaxAutor,
          foliosDisp: this._lastFoliosDisp,
          error: `SII: autoriza como máximo ${this._lastMaxAutor} folio(s) para el tipo ${tipoDte} ` +
            `y se requieren ${minCantidad} (FOLIOS_DISP=${this._lastFoliosDisp}). ` +
            `Ocurre cuando hay folios timbrados sin utilizar — anúlalos o emite documentos de este tipo.`,
        };
      }

      // Verificar si obtuvimos el CAF
      if (response.body && response.body.includes('<AUTORIZACION')) {
        const cafPath = this._saveCafOrganized(response.body, tipoDte);
        return {
          success: true,
          cafPath,
          xml: response.body,
          maxAutor: this._lastMaxAutor ?? cantidad,
          foliosDisp: this._lastFoliosDisp,
        };
      }

      if (response.body && CafSolicitor.esBloqueoTimbraje(response.body)) {
        return { success: false, errorCode: 'TIMBRAJE_BLOQUEADO', error: 'SII: No se autoriza timbraje. Folios acumulados excesivos o situaciones tributarias pendientes. Revisa el portal SII → Factura Electrónica → Solicitud de Timbraje.' };
      }

      // Rechazo por Verificación de Actividades detectado en un paso posterior del flujo
      // multi-paso (ver guarda defensiva en _processMultiStepFlow).
      if (response.body && response.body.includes('no registra Verificacion de Actividades')) {
        return {
          success: false,
          errorCode: 'VERIFICACION_ACTIVIDADES_PENDIENTE',
          error: 'SII: El RUT no tiene registrada la Verificación de Actividades para este tipo de documento. Solicítala en el sitio SII → Peticiones Administrativas → Verificación de actividad, o en oficinas del SII.',
        };
      }

      if (response.body && response.body.includes('Autenticaci')) {
        return { success: false, errorCode: 'SESSION_EXPIRED', error: 'El SII devolvió página de autenticación' };
      }

      // Detectar error de MAX_AUTOR: "La cantidad de documentos a timbrar debe ser menor o igual al máximo autorizado"
      // Puede ocurrir cuando el MAX_AUTOR efectivo del SII es menor al mostrado en el formulario
      // (ej: ya hay un timbraje del mismo día que consume parte del cupo diario).
      // Solución: reintentar con cantidad=1 para garantizar obtener al menos 1 folio.
      if (response.body && response.body.includes('menor o igual al m')) {
        // Con `minCantidad` el llamador necesita N folios exactos: caer a 1 le
        // entrega un CAF inservible Y suma +1 a FOLIOS_DISP (el folio queda sin
        // usar), agravando el racionamiento en el próximo intento. Este retry
        // preexistente bypaseaba el chequeo temprano de _processStep3, que solo
        // cubre el MAX_AUTOR declarado en el formulario — no el efectivo, que el
        // SII recién aplica al recibir el submit.
        if (minCantidad && minCantidad > 1) {
          console.warn(
            `[CafSolicitor] Tipo ${tipoDte}: MAX_AUTOR efectivo insuficiente para ${cantidad} folios ` +
            `y se requieren al menos ${minCantidad} — no se cae a 1 folio.`
          );
          return {
            success: false,
            errorCode: 'MAX_AUTOR_INSUFICIENTE',
            maxAutor: this._lastMaxAutor,
            foliosDisp: this._lastFoliosDisp,
            error: `SII rechazó ${cantidad} folios para el tipo ${tipoDte} por exceder el máximo autorizado, ` +
              `y se requieren al menos ${minCantidad}. Ocurre cuando hay folios timbrados sin utilizar.`,
          };
        }
        if (cantidad > 1) {
          console.warn(`[CafSolicitor] MAX_AUTOR excedido para ${cantidad} folios — reintentando con 1 folio...`);
          // No limpiar cookieJar: el error es del formulario, no de la sesión.
          // Reutilizar la sesión activa evita abrir una nueva y acumular sesiones en el SII.
          this.runStamp = new Date().toISOString().replace(/[:.]/g, '-');
          return this.solicitar({ tipoDte, cantidad: 1 });
        }
        return { success: false, errorCode: 'MAX_AUTOR_EXCEEDED', error: 'Cantidad de folios excede el máximo que SII autoriza por solicitud para este tipo de documento (MAX_AUTOR). Verifica el estado de timbraje de tu empresa en el portal SII.' };
      }

      // Detectar rango ya autorizado — el CAF existe en SII pero no fue capturado
      // (ocurre cuando una solicitud previa tuvo éxito en SII pero falló en la red al devolver el XML,
      // o cuando of_genera_archivo devolvió DTE-OFGA y el SII registró el rango igualmente)
      const finalBody = response.body || '';
      if (finalBody.includes('ya fue autorizado el rango desde') || finalBody.includes('ya fue autorizado')) {
        const m = finalBody.match(/ya fue autorizado el rango desde\s+(\d+)\s+hasta\s+(\d+)/i);
        const desde = m ? parseInt(m[1]) : null;
        const hasta  = m ? parseInt(m[2]) : null;

        // Intentar recuperar el XML directamente enviando los datos del rango a of_genera_archivo.
        // El SII tiene el CAF autorizado en su sistema; si enviamos los campos correctos
        // puede devolver el XML aunque la sesión de timbraje original ya terminó.
        if (desde != null && hasta != null) {
          console.warn(`[CafSolicitor] Rango ${desde}-${hasta} ya autorizado — intentando recuperar XML desde of_genera_archivo...`);
          const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
          const recoveryFields = {
            RUT_EMP: rut,
            DV_EMP: dv,
            COD_DOCTO: String(tipoDte),
            FOLIO_INI: String(desde),
            FOLIO_FIN: String(hasta),
            FECHA: today,
            ACEPTAR: 'AQUI',
          };
          try {
            const recoveryResponse = await this.session.submitForm('/cvc_cgi/dte/of_genera_archivo', recoveryFields);
            const recoveryBody = recoveryResponse.body || '';
            this._saveDebug(debugDir, 'recovery.xml', recoveryBody);
            if (recoveryBody.includes('<AUTORIZACION')) {
              console.log(`[CafSolicitor] ✅ CAF recuperado exitosamente para rango ${desde}-${hasta}`);
              const cafPath = this._saveCafOrganized(recoveryBody, tipoDte);
              return { success: true, cafPath, xml: recoveryBody, maxAutor: hasta - desde + 1 };
            }
            console.warn(`[CafSolicitor] Recuperación de rango ${desde}-${hasta} no devolvió XML (${recoveryBody.substring(0, 80).replace(/\s+/g, ' ')})`);
          } catch (recoveryErr) {
            console.warn(`[CafSolicitor] Error al intentar recuperar rango: ${recoveryErr.message}`);
          }
        }

        const rangoStr = desde != null && hasta != null ? ` ${desde}-${hasta}` : '';
        return {
          success: false,
          errorCode: 'RANGO_YA_AUTORIZADO',
          rangoYaAutorizado: desde != null && hasta != null ? { folioDesde: desde, folioHasta: hasta } : null,
          error: `SII: Ya existe CAF autorizado para el rango${rangoStr}. El XML fue aprobado por SII en una solicitud previa pero no se pudo recuperar automáticamente. Descárgalo manualmente desde el portal SII (Factura Electrónica → Solicitud de Timbraje).`,
        };
      }

      // Si la respuesta final sigue siendo una redirección de auth, el cookieJar en memoria
      // está inválido (sesión stale en _sessionRegistry). Eliminar del registro y hacer logout
      // best-effort para que el próximo intento cree sesión fresca desde SiiPortalAuth.
      if (this._requiresAuthentication(finalBody)) {
        _sessionRegistry.delete(`${this.ambiente}::${this.rutEmisor}`);
        try { await this.session.logout() } catch (_) {}
        return { success: false, errorCode: 'SESSION_EXPIRED', error: 'Sesión SII inválida — registro limpiado, el próximo intento reautenticará.' };
      }

      return { success: false, errorCode: 'UNKNOWN', error: 'No se obtuvo CAF en la respuesta' };

    } catch (err) {
      const msg = err.message || '';
      const isUnknownCa = msg.includes('unknown ca') || msg.includes('CERT_UNTRUSTED') || msg.includes('unknown_ca');
      const isCertExpired = msg.includes('certificate has expired') || msg.includes('CERT_HAS_EXPIRED');
      const isSslError = isUnknownCa || isCertExpired || msg.includes('SSL') || msg.includes('TLS');

      const errorCode = isUnknownCa ? 'SSL_CERT_CHAIN'
        : isCertExpired ? 'SSL_CERT_EXPIRED'
        : isSslError ? 'SSL_ERROR'
        : 'NETWORK_ERROR';

      const friendlyError = isUnknownCa
        ? 'SII rechazó el certificado PFX (cadena de CA incompleta — falta certificado intermedio).'
        : isCertExpired
        ? 'El certificado digital PFX está vencido. El cliente debe renovarlo.'
        : msg;

      console.error(`[CafSolicitor] Error (${errorCode}): ${friendlyError}`);
      return { success: false, errorCode, error: friendlyError };
    }
  }

  /**
   * Procesa el flujo multi-paso del SII para obtener CAF
   * @private
   */
  async _processMultiStepFlow(response, rut, dv, tipoDte, cantidad, debugDir) {
    let currentHtml = response.body || '';

    // Defensivo: mismo rechazo por Verificación de Actividades puede aparecer si el SII
    // lo entrega recién en un paso posterior en vez del response inicial de solicitar().
    if (currentHtml.includes('no registra Verificacion de Actividades')) {
      return response; // solicitar() detectará el rechazo en response.body
    }

    const realFormAction = SiiSession.extractFormAction(currentHtml);

    // Si el <form> real ya apunta a of_confirma_folio, el SII preseleccionó
    // COD_DOCTO server-side (coincide con el tipoDte enviado en el paso 1) y no
    // hace falta pasar por of_solicita_folios_dcto. Ese endpoint solo se dispara
    // vía JS (changeRegregion) si el usuario cambia el <select> a mano — su sola
    // presencia como string dentro de un <script> no significa que sea el
    // próximo paso real. Ir directo a _processStep3, que ya arma COD_DOCTO/
    // CANT_DOCTOS explícitamente (extractInputValues no lee <select>, así que
    // dejarlo entrar a la rama de abajo pierde el tipo de documento).
    if (realFormAction && realFormAction.includes('of_confirma_folio')) {
      return this._processStep3(response, rut, dv, tipoDte, cantidad, debugDir);
    }

    // Paso 2: of_solicita_folios_dcto
    if (currentHtml.includes('of_solicita_folios_dcto')) {
      const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_solicita_folios_dcto';
      const hiddenInputs = SiiSession.extractInputValues(currentHtml);

      const step2Fields = {
        ...hiddenInputs,
        RUT_EMP: rut,
        DV_EMP: dv,
      };

      response = await this.session.submitForm(formAction, step2Fields);
      currentHtml = response.body || '';
      this._saveDebug(debugDir, 'step2.html', currentHtml);

      // Rechazo duro antes del check de COD_DOCTO: la página de rechazo también contiene
      // "COD_DOCTO" en su JavaScript, lo que causaría un POST innecesario con datos vacíos.
      if (CafSolicitor.esBloqueoTimbraje(currentHtml)) {
        return response; // solicitar() detectará el bloqueo en response.body
      }

      // Selección de tipo de documento
      if (currentHtml.includes('COD_DOCTO')) {
        const selectInputs = SiiSession.extractInputValues(currentHtml);
        // NO enviar CANT_DOCTOS aquí — el browser tampoco lo envía en este paso.
        // Si se envía un número, el SII no incluye MAX_AUTOR ni CONTROL="S" en la
        // respuesta, lo que causa rechazo silencioso en of_genera_folio más adelante.
        // El SII fija CANT_DOCTOS automáticamente según MAX_AUTOR al responder.
        const selectFields = {
          ...selectInputs,
          RUT_EMP: rut,
          DV_EMP: dv,
          COD_DOCTO: tipoDte,
          CANT_DOCTOS: '',
        };

        response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios_dcto', selectFields);
        currentHtml = response.body || '';
        this._saveDebug(debugDir, 'select.html', currentHtml);

        if (CafSolicitor.esBloqueoTimbraje(currentHtml)) {
          return response; // solicitar() detectará el bloqueo en response.body
        }
      }

      // Paso 3: Solicitar numeración
      response = await this._processStep3(response, rut, dv, tipoDte, cantidad, debugDir);
    }

    return response;
  }

  /**
   * Procesa paso 3 y siguientes
   * @private
   */
  async _processStep3(response, rut, dv, tipoDte, cantidad, debugDir) {
    let currentHtml = response.body || '';

    if (currentHtml.includes('no registra Verificacion de Actividades')) {
      return response; // solicitar() detectará el rechazo en response.body
    }

    const formAction3 = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_confirma_folio';
    const inputs3 = SiiSession.extractInputValues(currentHtml);

    // CANT_DOCTOS debe enviarse con un valor <= MAX_AUTOR.
    // Si se omite o excede MAX_AUTOR, el SII rechaza devolviendo la página de inicio (rechazo silencioso).
    //
    // MAX_AUTOR/FOLIOS_DISP solo aparecen cuando el SII está LIMITANDO este tipo de
    // documento (confirmado experimentalmente 2026-07-22: tras anular folios, los tipos
    // 56 y 61 dejaron de exponerlos). Su ausencia significa "sin tope" → no se recorta.
    const tieneMaxAutor =
      inputs3.MAX_AUTOR !== undefined && inputs3.MAX_AUTOR !== '';
    const maxAutor = parseInt(inputs3.MAX_AUTOR || String(cantidad), 10);
    const foliosDisp = parseInt(inputs3.FOLIOS_DISP || '0', 10);
    const cantReal = Math.min(cantidad, maxAutor);
    this._lastMaxAutor = maxAutor; // guardado para retornarlo desde solicitar()
    this._lastFoliosDisp = tieneMaxAutor ? foliosDisp : null;

    // El SII raciona MAX_AUTOR según los folios timbrados sin utilizar (FOLIOS_DISP):
    // con FOLIOS_DISP=0 autoriza 100, con 2 ya baja a 1, y si sigue subiendo pasa a
    // bloqueo duro ("NO SE AUTORIZA"). Aceptar un rango corto es contraproducente para
    // quien necesita N folios exactos (ej. simulación de certificación): el CAF chico
    // no se usa, suma +1 a FOLIOS_DISP y empeora el tope en el próximo intento.
    // Por eso, si el llamador declaró un mínimo, se aborta ANTES de emitir.
    if (tieneMaxAutor && this._minCantidad && maxAutor < this._minCantidad) {
      this._maxAutorInsuficiente = true;
      console.warn(
        `[CafSolicitor] Tipo ${tipoDte}: MAX_AUTOR=${maxAutor} < mínimo requerido ${this._minCantidad} ` +
        `(FOLIOS_DISP=${foliosDisp}) — abortando sin emitir para no agravar el racionamiento.`
      );
      return response;
    }

    const step3Fields = {
      ...inputs3,
      RUT_EMP: rut,
      DV_EMP: dv,
      COD_DOCTO: tipoDte,
      CANT_DOCTOS: String(cantReal),
      ACEPTAR: 'Solicitar Numeración',
    };

    response = await this.session.submitForm(formAction3, step3Fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, 'step3.html', currentHtml);

    // Confirmar folio inicial
    if (currentHtml.includes('of_confirma_folio')) {
      response = await this._processConfirmFolio(response, debugDir);
    } else if (currentHtml.includes('of_genera_folio')) {
      response = await this._processGeneraFolio(response, debugDir);
    }

    return response;
  }

  /**
   * Procesa confirmación de folio
   * @private
   */
  async _processConfirmFolio(response, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_confirma_folio';
    const inputs = SiiSession.extractInputValues(currentHtml);
    
    const fields = {
      ...inputs,
      FOLIO_INICIAL: inputs.FOLIO_INICIAL || '1',
      ACEPTAR: 'Confirmar Folio Inicial',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, 'confirm.html', currentHtml);

    if (currentHtml.includes('of_genera_folio')) {
      response = await this._processGeneraFolio(response, debugDir);
    }

    return response;
  }

  /**
   * Procesa generación de folio
   * @private
   */
  async _processGeneraFolio(response, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_folio';
    const inputs = SiiSession.extractInputValues(currentHtml);

    // Respetar el máximo autorizado por el SII (puede ser menor a lo solicitado)
    const maxAutor = parseInt(inputs.MAX_AUTOR || '999', 10);
    const folioIni = parseInt(inputs.FOLIO_INI || '1', 10);
    const cantOriginal = parseInt(inputs.CANT_DOCTOS || '1', 10);
    const cantReal = Math.min(cantOriginal, maxAutor);

    const fields = {
      ...inputs,
      CANT_DOCTOS: String(cantReal),
      FOLIO_FIN: String(folioIni + cantReal - 1),
      ACEPTAR: 'Obtener Folios',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, 'genera.html', currentHtml);

    // El SII rechaza el request si ese rango ya fue autorizado en una solicitud previa
    // (ocurre en reintentos cuando la primera solicitud llegó a SII pero falló la red al devolver el XML)
    if (currentHtml.includes('ya fue autorizado')) {
      const m = currentHtml.match(/ya fue autorizado el rango desde\s+(\d+)\s+hasta\s+(\d+)/i);
      console.warn(`[CafSolicitor] of_genera_folio: rango ya autorizado${m ? ' ' + m[1] + '-' + m[2] : ''} — el XML existe en SII pero no se obtuvo`);
      return response;
    }

    // Paso final: of_genera_archivo
    if (!currentHtml.includes('<AUTORIZACION') && currentHtml.includes('of_genera_archivo')) {
      // Guardar los inputs del genera.html para poder reintentar of_genera_archivo si falla con DTE-OFGA
      const generaInputs = SiiSession.extractInputValues(currentHtml);
      const generaFormAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_archivo';
      response = await this._processGeneraArchivo(response, debugDir, generaInputs, generaFormAction);
    }

    return response;
  }

  /**
   * Procesa generación de archivo CAF
   * @private
   * @param {Object} response - Respuesta previa
   * @param {string} debugDir - Directorio de debug
   * @param {Object} [retryInputs] - Inputs de genera.html para retry si falla con DTE-OFGA
   * @param {string} [retryFormAction] - URL de of_genera_archivo para retry
   */
  async _processGeneraArchivo(response, debugDir, retryInputs, retryFormAction) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_archivo';
    const inputs = SiiSession.extractInputValues(currentHtml);
    
    const fields = {
      ...inputs,
      ACEPTAR: 'AQUI',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, 'archivo.xml', currentHtml);

    // El SII a veces devuelve error interno DTE-OFGA (servidor sobrecargado o fallo transitorio).
    // En ese caso el rango ya fue registrado en SII pero el XML no se generó.
    // Reintentar el mismo POST hasta 3 veces con delay de 3s antes de rendirse.
    if (!currentHtml.includes('<AUTORIZACION') && currentHtml.includes('DTE-OFGA')) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const delaySecs = attempt * 3;
        console.warn(`[CafSolicitor] Error DTE-OFGA en of_genera_archivo — reintentando en ${delaySecs}s (intento ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, delaySecs * 1000));
        // Reintentar con los inputs originales del genera.html si están disponibles,
        // ya que los del archivo.xml (página de error) no tienen los campos necesarios.
        const retryFields = retryInputs ? { ...retryInputs, ACEPTAR: 'AQUI' } : fields;
        const retryAction = retryFormAction || formAction;
        response = await this.session.submitForm(retryAction, retryFields);
        currentHtml = response.body || '';
        this._saveDebug(debugDir, `archivo-retry${attempt}.xml`, currentHtml);
        if (currentHtml.includes('<AUTORIZACION')) {
          console.log(`[CafSolicitor] ✅ CAF obtenido en retry ${attempt} de of_genera_archivo`);
          return response;
        }
        if (!currentHtml.includes('DTE-OFGA')) {
          // Error diferente (ya fue autorizado, etc.) — salir del loop
          break;
        }
      }
    }

    // A veces hay un paso extra
    if (!currentHtml.includes('<AUTORIZACION') && currentHtml.includes('of_genera_archivo')) {
      const formAction2 = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_archivo';
      const inputs2 = SiiSession.extractInputValues(currentHtml);
      
      const fields2 = {
        ...inputs2,
        ACEPTAR: 'AQUI',
      };

      response = await this.session.submitForm(formAction2, fields2);
      this._saveDebug(debugDir, 'archivo2.xml', response.body || '');
    }

    return response;
  }

  /**
   * Cierra todas las sesiones SII en caché haciendo logout en el portal.
   * Llamar durante el shutdown del proceso para no dejar sesiones huérfanas
   * que acumulen el límite de sesiones concurrentes del SII.
   */
  static async closeAllSessions() {
    for (const [key, session] of _sessionRegistry) {
      try { await session.logout() } catch (_e) { /* ignorar errores de red al apagar */ }
      _sessionRegistry.delete(key)
    }
  }
}

CafSolicitor._lastSolicitudAt = 0; // ms timestamp of last solicitar() call — for rate limiting

/** Retorna la sesión SII cacheada para un ambiente+rut, o null si no existe. */
CafSolicitor.getSession = (ambiente, rutEmisor) =>
  _sessionRegistry.get(`${ambiente.toLowerCase()}::${rutEmisor}`) ?? null;

module.exports = CafSolicitor;
