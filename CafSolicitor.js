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
   * Solicita un CAF al SII
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE (33, 34, 39, 56, 61, etc.)
   * @param {number} [params.cantidad=1] - Cantidad de folios a solicitar
   * @returns {Promise<Object>} - { success, cafPath, xml, error }
   */
  async solicitar({ tipoDte, cantidad = 1 }) {
    const { numero: rut, dv } = splitRut(this.rutEmisor);
    const debugDir = this._getDebugDir(tipoDte);

    // Rate limiting: mínimo 1001ms entre solicitudes para no saturar el portal SII.
    const _now = Date.now();
    const _elapsed = _now - CafSolicitor._lastSolicitudAt;
    if (_elapsed < 1001) await new Promise(r => setTimeout(r, 1001 - _elapsed));
    CafSolicitor._lastSolicitudAt = Date.now();

    console.log('─'.repeat(60));
    console.log(`[CafSolicitor] Solicitando CAF tipo ${tipoDte} x${cantidad}`);
    console.log(` RUT: ${this.rutEmisor} | Ambiente: ${this.ambiente}`);

    try {
      // Paso 1: POST inicial a of_solicita_folios
      const fields = {
        RUT_EMP: rut,
        DV_EMP: dv,
        COD_DOCTO: tipoDte,
        CANTIDAD: cantidad,
      };

      let response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios', fields);

      // Manejar autenticación si es necesaria (incluye 302 a autInicioDTE)
      if (this._requiresAuthentication(response.body)) {
        const authResult = await this.session.ensureSession('/cvc_cgi/dte/of_solicita_folios');
        if (authResult.body) {
          // Reintentar después de autenticación
          response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios', fields);
        }
        
        // Guardar sesión para reutilización
        if (this.sessionPath) {
          this.session.saveSession(this.sessionPath);
        }
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

      // Verificar si obtuvimos el CAF
      if (response.body && response.body.includes('<AUTORIZACION')) {
        const cafPath = this._saveCafOrganized(response.body, tipoDte);
        return { success: true, cafPath, xml: response.body, maxAutor: this._lastMaxAutor ?? cantidad };
      }

      if (response.body && response.body.includes('NO SE AUTORIZA')) {
        return { success: false, errorCode: 'TIMBRAJE_BLOQUEADO', error: 'SII: No se autoriza timbraje. Folios acumulados excesivos o situaciones tributarias pendientes. Revisa el portal SII → Factura Electrónica → Solicitud de Timbraje.' };
      }

      if (response.body && response.body.includes('Autenticaci')) {
        return { success: false, errorCode: 'SESSION_EXPIRED', error: 'El SII devolvió página de autenticación' };
      }

      // Detectar error de MAX_AUTOR: "La cantidad de documentos a timbrar debe ser menor o igual al máximo autorizado"
      // Puede ocurrir cuando el MAX_AUTOR efectivo del SII es menor al mostrado en el formulario
      // (ej: ya hay un timbraje del mismo día que consume parte del cupo diario).
      // Solución: reintentar con cantidad=1 para garantizar obtener al menos 1 folio.
      if (response.body && response.body.includes('menor o igual al m')) {
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
      if (currentHtml.includes('NO SE AUTORIZA')) {
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

        if (currentHtml.includes('NO SE AUTORIZA')) {
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
    
    const formAction3 = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_confirma_folio';
    const inputs3 = SiiSession.extractInputValues(currentHtml);

    // CANT_DOCTOS debe enviarse con un valor <= MAX_AUTOR.
    // Si se omite o excede MAX_AUTOR, el SII rechaza devolviendo la página de inicio (rechazo silencioso).
    const maxAutor = parseInt(inputs3.MAX_AUTOR || String(cantidad), 10);
    const cantReal = Math.min(cantidad, maxAutor);
    this._lastMaxAutor = maxAutor; // guardado para retornarlo desde solicitar()

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
