// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiSession.js - Manejo de sesiones HTTP con el SII
 * 
 * Proporciona autenticación con certificado digital y manejo de cookies
 * para interactuar con los servicios web del SII.
 * 
 * @module SiiSession
 */

const got = require('got');
const {
  loadPfxFromBuffer,
  loadPfxFromFile,
  createTlsOptions,
  createTlsAgent,
  createTlsAgentFromPem,
  validateAmbiente,
  getHost,
  createScopedLogger,
} = require('./utils');
const { resolveDebugDir, saveDebugFile } = require('./utils/paths');
const { registrarHttpDebug } = require('./utils/httpDebug');

const log = createScopedLogger('SiiSession');

/**
 * Clase para manejar sesiones HTTP con el SII
 */
class SiiSession {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.ambiente - 'certificacion' o 'produccion' (OBLIGATORIO)
   * @param {Buffer|string} [options.pfxBuffer] - Buffer del archivo PFX
   * @param {string} [options.pfxPath] - Ruta al archivo PFX
   * @param {string} [options.pfxPassword] - Contraseña del PFX
   * @param {Object} [options.certificado] - Instancia de Certificado
   * @param {string} [options.debugDir] - Dónde escribir HTML de diagnóstico. Si no se
   *   provee cae a `SII_DEBUG_DIR`; si tampoco existe, no se escribe nada.
   */
  constructor(options = {}) {
    // Validar parámetros obligatorios usando validador centralizado
    if (!options.ambiente) {
      throw new Error('SiiSession: options.ambiente es obligatorio');
    }
    this.ambiente = validateAmbiente(options.ambiente);

    // Usar host centralizado desde endpoints
    this.baseHost = getHost(this.ambiente);
    this.debugDir = options.debugDir || null;
    this.cookieJar = '';
    this.tlsOptions = null;
    // Agent nativo con el certificado + flags TLS legacy del SII. got no reenvía
    // secureOptions/maxVersion a través de su opción `https` bajo ningún nombre de
    // clave, así que estos flags solo se pueden aplicar vía un https.Agent nativo.
    this.tlsAgent = null;

    // Configurar TLS desde certificado
    if (options.certificado) {
      this._configureTlsFromCertificado(options.certificado);
    } else if (options.pfxBuffer && options.pfxPassword) {
      this._configureTlsFromBuffer(options.pfxBuffer, options.pfxPassword);
    } else if (options.pfxPath && options.pfxPassword) {
      this._configureTlsFromFile(options.pfxPath, options.pfxPassword);
    }
  }

  /**
   * Configura TLS desde una instancia de Certificado
   * @private
   */
  _configureTlsFromCertificado(certificado) {
    try {
      const keyPem = certificado.getPrivateKeyPEM();
      const certPem = certificado.getCertificatePEM();
      this.tlsOptions = {
        key: keyPem,
        cert: certPem,
        certificate: certPem,
        rejectUnauthorized: false,
      };
      this.tlsAgent = createTlsAgentFromPem(keyPem, certPem);
    } catch (error) {
      log.error('Error configurando TLS desde certificado:', error.message);
      this.tlsOptions = null;
      this.tlsAgent = null;
    }
  }

  /**
   * Configura TLS desde un buffer PFX usando utilidad centralizada
   * @private
   */
  _configureTlsFromBuffer(pfxBuffer, password) {
    try {
      const pfxData = loadPfxFromBuffer(pfxBuffer, password);
      this.tlsOptions = createTlsOptions(pfxData);
      this.tlsAgent = createTlsAgent(pfxData);
    } catch (error) {
      log.error('Error configurando TLS desde PFX:', error.message);
      this.tlsOptions = null;
      this.tlsAgent = null;
    }
  }

  /**
   * Configura TLS desde un archivo PFX usando utilidad centralizada
   * @private
   */
  _configureTlsFromFile(pfxPath, password) {
    try {
      const pfxData = loadPfxFromFile(pfxPath, password);
      this.tlsOptions = createTlsOptions(pfxData);
      this.tlsAgent = createTlsAgent(pfxData);
    } catch (error) {
      log.error('Error configurando TLS desde archivo PFX:', error.message);
      this.tlsOptions = null;
      this.tlsAgent = null;
    }
  }

  /**
   * Parsea un RUT en sus componentes
   * @param {string} rutCompleto - RUT con formato XX.XXX.XXX-X o XXXXXXXX-X
   * @returns {{rut: string, dv: string}}
   */
  static parseRut(rutCompleto) {
    const clean = String(rutCompleto || '').replace(/\./g, '').toUpperCase();
    const [rut, dv] = clean.split('-');
    return { rut, dv };
  }

  /**
   * Codifica campos para form-urlencoded
   * @param {Object} fields - Campos a codificar
   * @returns {string}
   */
  static formEncode(fields) {
    return Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
      .join('&');
  }

  /**
   * Combina cookies existentes con nuevas del header Set-Cookie
   * @private
   */
  _mergeCookies(current, setCookieHeader) {
    const jar = new Map();
    const addCookie = (cookieStr) => {
      const [pair] = cookieStr.split(';');
      const [name, value] = pair.split('=');
      if (name) jar.set(name.trim(), (value || '').trim());
    };

    if (current) {
      current.split(';').forEach((c) => addCookie(c));
    }

    if (Array.isArray(setCookieHeader)) {
      setCookieHeader.forEach((c) => addCookie(c));
    } else if (setCookieHeader) {
      addCookie(setCookieHeader);
    }

    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * Realiza una petición HTTP
   * @param {string} url - URL de destino
   * @param {Object} options - Opciones de la petición
   * @returns {Promise<Object>}
   */
  async request(url, options = {}) {
    const isPost = (options.method || 'GET').toUpperCase() === 'POST';
    const RETRY_DELAYS = [2000, 4000, 8000];
    const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'TimeoutError']);
    const RETRYABLE_STATUS = new Set([502, 503, 504]);

    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        log.warn(`[SiiSession] request timeout/5xx — reintentando en ${delay / 1000}s (intento ${attempt}/${RETRY_DELAYS.length})...`);
        await new Promise(r => setTimeout(r, delay));
      }
      try {
        const result = await this._doRequest(url, options, isPost);
        if (RETRYABLE_STATUS.has(result.status)) {
          lastErr = new Error(`HTTP ${result.status}`);
          continue;
        }
        return result;
      } catch (err) {
        const code = err.code || err.constructor?.name || '';
        if (RETRYABLE_CODES.has(code)) { lastErr = err; continue; }
        throw err; // error no retriable — propagar inmediatamente
      }
    }
    throw lastErr;
  }

  /**
   * Realiza la petición HTTP sin retry. Llamado desde request().
   * @private
   */
  async _doRequest(url, options, isPost) {
    const _t0 = Date.now();
    const res = await got(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'es-419,es-US;q=0.9,es;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...(isPost ? {
          'Cache-Control': 'max-age=0',
          'Origin': `https://${this.baseHost}`,
        } : {}),
        ...(this.cookieJar ? { Cookie: this.cookieJar } : {}),
        ...(options.headers || {}),
      },
      body: options.body,
      followRedirect: false,
      throwHttpErrors: false,
      https: this.tlsOptions || { rejectUnauthorized: false },
      // got remapea `https` a un set fijo de claves y NO reenvía secureOptions/
      // maxVersion bajo ningún nombre — sin el Agent nativo aquí, el certificado
      // cliente se autentica con handshake TLS incompleto contra el SII (ver
      // utils/pfx.js createTlsAgent).
      ...(this.tlsAgent ? { agent: { https: this.tlsAgent } } : {}),
      responseType: 'buffer',
      timeout: { request: options.timeoutMs ?? 20000 },
    });

    this.cookieJar = this._mergeCookies(this.cookieJar, res.headers['set-cookie']);

    const contentType = res.headers['content-type'] || '';
    const buffer = res.body;
    const isSiiUrl = url.includes('sii.cl');
    const hasUtf8 = contentType.toLowerCase().includes('utf-8');
    const forceIso = contentType.toLowerCase().includes('iso-8859-1') ||
                     contentType.toLowerCase().includes('latin1');

    let bodyStr;
    if (forceIso || (isSiiUrl && !hasUtf8)) {
      bodyStr = '';
      for (let i = 0; i < buffer.length; i++) {
        bodyStr += String.fromCharCode(buffer[i]);
      }
    } else {
      bodyStr = buffer.toString('utf8');
    }

    // Punto único por el que pasa TODO el tráfico de SiiSession: cada salto de
    // redirect, cada submit de formulario y cada reintento. Enganchar acá cubre a
    // SiiCertificacion, CertRunner, CafSolicitor, FolioService, BoletaCert y
    // SetsProvider sin tocar ninguno.
    registrarHttpDebug({
      url,
      method: options.method || 'GET',
      status: res.statusCode,
      headers: res.headers,
      body: bodyStr,
      reqBody: options.body,
      ms: Date.now() - _t0,
      cliente: 'SiiSession',
    });

    return {
      status: res.statusCode,
      headers: res.headers,
      body: bodyStr,
      rawBody: res.body,
      url: res.url,
      cookieJar: this.cookieJar,
    };
  }

  /**
   * Sigue redirecciones HTTP
   * @param {Object} initial - Respuesta inicial
   * @param {number} maxRedirects - Máximo de redirecciones
   * @returns {Promise<Object>}
   */
  async followRedirects(initial, maxRedirects = 8) {
    let response = initial;
    let redirects = 0;
    let lastLocationUrl = null;
    
    while ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && redirects < maxRedirects) {
      const nextUrl = new URL(response.headers.location, response.url).toString();
      lastLocationUrl = nextUrl;
      response = await this.request(nextUrl, { method: 'GET' });
      redirects += 1;
    }
    
    return { response, lastLocationUrl };
  }

  /**
   * Realiza login con certificado digital
   * @param {string} lastLocationUrl - URL de redirección del login
   * @returns {Promise<Object>}
   */
  async loginWithCertificate(lastLocationUrl) {
    if (!lastLocationUrl || !this.tlsOptions) {
      return { success: false, response: null };
    }

    const locationUrl = new URL(lastLocationUrl);
    const referencia = locationUrl.search ? decodeURIComponent(locationUrl.search.slice(1)) : '';
    
    if (!referencia) {
      return { success: false, response: null };
    }

    const loginUrl = `https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${referencia}`;
    const loginBody = SiiSession.formEncode({ referencia });
    
    const loginResponse = await this.request(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginBody),
        Referer: loginUrl,
      },
      body: loginBody,
    });

    const redirected = await this.followRedirects(loginResponse);
    return { success: true, response: redirected.response };
  }

  /**
   * Cierra la sesión activa en el SII para liberar el cupo de sesiones.
   * Es seguro llamar aunque no haya sesión activa.
   */
  async logout() {
    if (!this.cookieJar) return;
    // El SII usa estos endpoints según el tipo de autenticación.
    // Intentamos ambos; ignoramos errores.
    const logoutUrls = [
      `https://${this.baseHost}/cgi_AUT2000/autLogout.cgi`,
      'https://www.sii.cl/AUT2000/autLogout.cgi',
      'https://herculesr.sii.cl/cgi_AUT2000/autLogout.cgi',
    ];
    for (const url of logoutUrls) {
      try {
        await this.request(url, { method: 'GET' });
      } catch (_) {}
    }
    this.cookieJar = '';
  }

  /**
   * Detecta la página de "demasiadas sesiones" y, si el SII ofrece un form
   * para cerrar las sesiones anteriores, lo envía automáticamente.
   * Devuelve true si se envió el form de cierre (hay que reintentar la sesión).
   * @private
   */
  async _tryForceCloseSessions(body) {
    if (!body || !body.includes('superado el m')) return false;

    // Guardar HTML para diagnóstico — solo si el consumidor definió dónde.
    // Antes esto apuntaba a `../el consumidor/debug/sii-sessions`: la librería
    // nombraba a un repo consumidor y asumía que estaba como carpeta hermana, así que
    // en cualquier otra instalación escribía en un lugar inesperado o fallaba en silencio.
    saveDebugFile(resolveDebugDir(this.debugDir), `demasiadas-sesiones-${Date.now()}.html`, body);

    // El SII a veces incluye un form o link para cerrar sesiones anteriores
    // Buscamos: action con "CierraAnt", "cerrar", "logout" o "Anular"
    const formActionMatch = body.match(/<form[^>]+action=["']([^"']*(?:CierraAnt|cerrar|Logout|anular)[^"']*)/i);
    if (formActionMatch) {
      const closeUrl = formActionMatch[1];
      const inputs = SiiSession.extractInputValues(body);
      console.warn(`[SiiSession] Detectadas demasiadas sesiones — cerrando sesiones anteriores en ${closeUrl}...`);
      try {
        await this.submitForm(closeUrl, { ...inputs, ACEPTAR: 'Aceptar' });
        return true;
      } catch (e) {
        console.warn(`[SiiSession] No se pudo cerrar sesiones anteriores: ${e.message}`);
      }
    }

    // Alternativa: link directo (href) a CierraAnt o similar
    const linkMatch = body.match(/href=["']([^"']*CierraAnt[^"']*)/i);
    if (linkMatch) {
      const closeUrl = new URL(linkMatch[1], `https://${this.baseHost}`).toString();
      console.warn(`[SiiSession] Cerrando sesiones anteriores via GET ${closeUrl}...`);
      try {
        await this.request(closeUrl, { method: 'GET' });
        return true;
      } catch (e) {
        console.warn(`[SiiSession] No se pudo cerrar sesiones anteriores: ${e.message}`);
      }
    }

    return false;
  }

  /**
   * Asegura una sesión autenticada para acceder a una página
   * @param {string} targetPath - Ruta del recurso
   * @returns {Promise<Object>}
   */
  async ensureSession(targetPath) {
    const targetUrl = `https://${this.baseHost}${targetPath}`;
    let response = await this.request(targetUrl, { method: 'GET' });
    
    const redirected = await this.followRedirects(response);
    response = redirected.response;

    // Detectar bloqueo por demasiadas sesiones
    if (response.body && response.body.includes('superado el m')) {
      // Intentar cerrar sesiones anteriores automáticamente si el SII lo ofrece
      const closed = await this._tryForceCloseSessions(response.body);
      if (closed) {
        // Reintentar la sesión después de cerrar las anteriores
        console.warn('[SiiSession] Sesiones anteriores cerradas — reintentando autenticación...');
        response = await this.request(targetUrl, { method: 'GET' });
        const redirected2 = await this.followRedirects(response);
        response = redirected2.response;
        // Si sigue con demasiadas sesiones, lanzar error
        if (response.body && response.body.includes('superado el m')) {
          const errorMsg = 'SII: Demasiadas sesiones abiertas. Espera ~30 min o cierra sesión manualmente en el portal SII.';
          console.error(`\n[ERR] ${errorMsg}\n`);
          throw new Error(errorMsg);
        }
      } else {
        const errorMsg = 'SII: Demasiadas sesiones abiertas. Espera ~30 min o cierra sesión manualmente en el portal SII.';
        console.error(`\n[ERR] ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
    }

    // Si requiere autenticación
    if (response.body && response.body.includes('Autenticaci')) {
      const certLogin = await this.loginWithCertificate(redirected.lastLocationUrl);
      if (certLogin.success && certLogin.response) {
        response = certLogin.response;
        
        // Verificar si el login resultó en bloqueo por sesiones
        if (response.body && response.body.includes('superado el m')) {
          // Intentar cerrar sesiones anteriores automáticamente
          const closed = await this._tryForceCloseSessions(response.body);
          if (closed) {
            console.warn('[SiiSession] Sesiones anteriores cerradas post-login — reintentando...');
            const retry = await this.request(targetUrl, { method: 'GET' });
            const redirected3 = await this.followRedirects(retry);
            response = redirected3.response;
            if (response.body && response.body.includes('superado el m')) {
              const errorMsg = 'SII: Demasiadas sesiones abiertas. Espera ~30 min o cierra sesión manualmente en el portal SII.';
              console.error(`\n[ERR] ${errorMsg}\n`);
              throw new Error(errorMsg);
            }
          } else {
            const errorMsg = 'SII: Demasiadas sesiones abiertas. Espera ~30 min o cierra sesión manualmente en el portal SII.';
            console.error(`\n[ERR] ${errorMsg}\n`);
            throw new Error(errorMsg);
          }
        }
      }
    }

    // Pantalla "ESCOJA COMO DESEA INGRESAR" — aparece cuando el certificado está
    // habilitado para representación electrónica de otros RUT. No es un fallo de
    // autenticación (aunque su <title> genérico "Autenticación" coincida con el
    // check de más arriba y por eso el caller podría malinterpretarlo como tal):
    // hay que seguir el link "Continuar" (GET al mismo recurso) para llegar al
    // formulario real.
    if (response.body && response.body.includes('ESCOJA COMO DESEA INGRESAR')) {
      const continuarMatch = response.body.match(/<a\s+href="([^"]+)"[^>]*>\s*Continuar\s*<\/a>/i);
      if (continuarMatch) {
        const continuarUrl = new URL(continuarMatch[1], targetUrl).toString();
        const continuado = await this.request(continuarUrl, { method: 'GET' });
        const continuadoResult = await this.followRedirects(continuado);
        response = continuadoResult.response;
      }
    }

    // Si hay redirección a af_anular1
    if (response.body && response.body.includes('/cvc_cgi/dte/af_anular1')) {
      const continued = await this.request(targetUrl, { method: 'GET' });
      const continuedResult = await this.followRedirects(continued);
      return continuedResult.response;
    }

    return response;
  }

  /**
   * Envía un formulario HTTP
   * @param {string} action - URL o path de acción
   * @param {Object} fields - Campos del formulario
   * @param {string} [referer] - URL de referencia
   * @returns {Promise<Object>}
   */
  async submitForm(action, fields, referer = null) {
    const url = new URL(action, `https://${this.baseHost}`).toString();
    const body = SiiSession.formEncode(fields);
    
    return this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...(referer ? { Referer: referer } : {}),
      },
      body,
    });
  }

  /**
   * Resetea la sesión
   */
  reset() {
    this.cookieJar = '';
  }

  /**
   * Retorna el host base según ambiente
   * @returns {string}
   */
  getBaseHost() {
    return this.baseHost;
  }

  /**
   * Guarda la sesión actual en un archivo JSON.
   *
   * Crea el directorio contenedor si no existe: `filePath` suele apuntar a un
   * volumen persistente o a una carpeta de debug que en el primer arranque
   * todavía no está creada, y sin esto `writeFileSync` lanza ENOENT. Perder la
   * sesión obliga a re-loguearse contra el SII en cada operación, que es el
   * camino directo al bloqueo por "máximo de sesiones autenticadas" del RUT.
   *
   * @param {string} filePath - Ruta del archivo donde guardar
   */
  /**
   * Huella del certificado con el que se configuró el TLS de esta sesión.
   *
   * Identifica de QUIÉN es la sesión. Sin esto, `SII_SESSION_PATH` —que en producción es
   * un archivo ÚNICO para todos los comercios (`/data/sii/session.json`)— hacía que la
   * sesión de un contribuyente se cargara para las operaciones de otro.
   * @private
   */
  _huellaCert() {
    const pem = this.tlsOptions?.cert;
    if (!pem) return null;
    return require('crypto').createHash('sha256').update(String(pem)).digest('hex').slice(0, 16);
  }

  saveSession(filePath) {
    const fs = require('fs');
    const path = require('path');
    const sessionData = {
      cookieJar: this.cookieJar,
      baseHost: this.baseHost,
      certHash: this._huellaCert(),
      savedAt: Date.now(),
      expiresAt: Date.now() + (90 * 60 * 1000), // 90 minutos de validez
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
  }

  /**
   * Carga una sesión desde un archivo JSON
   * @param {string} filePath - Ruta del archivo de sesión
   * @returns {boolean} - true si la sesión fue cargada exitosamente y es válida
   */
  loadSession(filePath) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Verificar que la sesión no haya expirado
      if (data.expiresAt && Date.now() > data.expiresAt) {
        console.log('Sesión SII (maullin) expirada, se requiere nuevo login');
        return false;
      }
      
      // Verificar que el host coincida
      if (data.baseHost && data.baseHost !== this.baseHost) {
        console.log('Host SII no coincide, se requiere nuevo login');
        return false;
      }

      // ⚠️ Y que la sesión sea de ESTE certificado.
      //
      // `SII_SESSION_PATH` es un archivo único para todo el proceso (en producción
      // `/data/sii/session.json`), así que en un servidor multi-tenant la sesión del
      // último comercio que operó queda ahí para el siguiente. Cargarla significa actuar
      // ante el SII como el usuario de OTRO contribuyente.
      //
      // Caso real (14/08/2026): una corrida del RUT 77111222-3 reusó la sesión del
      // certificado de otra empresa y el portal respondió "usted no está autorizado por la
      // empresa para ingresar a esta opción" al pedir el set de pruebas. El mismo pedido
      // con autenticación fresca funcionó. El síntoma no dice "sesión equivocada", dice
      // "sin permisos", que manda a buscar el problema donde no está.
      //
      // Las sesiones viejas no traen `certHash`: se descartan, que es lo seguro.
      const huella = this._huellaCert();
      if (huella && data.certHash !== huella) {
        console.log('[SessionSii] Sesión de otro certificado — se ignora y se hace login propio');
        return false;
      }
      
      this.cookieJar = data.cookieJar || '';
      console.log('[SessionSii] Sesión SII cargada desde archivo');
      return true;
    } catch (err) {
      console.log('[SessionSii] Error cargando sesión SII:', err.message);
      return false;
    }
  }

  /**
   * Verifica si existe una sesión guardada y es válida
   * @param {string} filePath - Ruta del archivo de sesión
   * @returns {boolean}
   */
  static isSessionValid(filePath) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data.expiresAt && Date.now() < data.expiresAt;
    } catch {
      return false;
    }
  }

  /**
   * Elimina el archivo de sesión
   * @param {string} filePath - Ruta del archivo de sesión
   */
  static clearSession(filePath) {
    const fs = require('fs');
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignorar errores
    }
  }
}

// Utilidades de parsing HTML
SiiSession.extractFormAction = function(html) {
  const match = html.match(/<form[^>]*action="([^"]+)"/i);
  return match ? match[1] : null;
};

SiiSession.extractFormActionByName = function(html, formName) {
  if (!formName) return SiiSession.extractFormAction(html);
  const regex = new RegExp(`<form[^>]*name="${formName}"[^>]*action="([^"]+)"`, 'i');
  const match = String(html || '').match(regex);
  return match ? match[1] : null;
};

SiiSession.extractInputValues = function(html) {
  const inputs = {};
  const regex = /<input[^>]+>/gi;
  const matches = html.match(regex) || [];
  matches.forEach((tag) => {
    // El SII mezcla estilos en el mismo formulario: unos atributos van con
    // comillas y otros sin ellas (`value = 1`). Con solo el patrón entrecomillado,
    // esos campos se enviaban vacíos y el SII rebotaba a la misma página sin
    // explicar por qué — observado 2026-07-22 en pe_datos_empresa, donde
    // EXISTE_PROD/EXISTE_CERT vienen sin comillas y trababan la postulación.
    // El fallback sin comillas exige un separador antes del atributo: sin eso
    // captura el `value=` que aparece DENTRO de handlers JS
    // (`onblur="this.value=this.value.toUpperCase()"`), devolviendo basura
    // como valor del campo.
    const nameMatch =
      tag.match(/name\s*=\s*"([^"]+)"/i) ||
      tag.match(/name\s*=\s*'([^']+)'/i) ||
      tag.match(/(?:^|[\s<])name\s*=\s*([^\s>"']+)/i);
    const valueMatch =
      tag.match(/value\s*=\s*"([^"]*)"/i) ||
      tag.match(/value\s*=\s*'([^']*)'/i) ||
      tag.match(/(?:^|[\s<])value\s*=\s*([^\s>"']+)/i);
    if (nameMatch) {
      inputs[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  });
  return inputs;
};

SiiSession.extractFormInputsByName = function(html, formName = null) {
  const formRegex = formName
    ? new RegExp(`<form[^>]*name="${formName}"[^>]*>[\\s\\S]*?<\\/form>`, 'i')
    : /<form[^>]*>[\s\S]*?<\/form>/i;
  const match = String(html || '').match(formRegex);
  if (!match) return {};
  return SiiSession.extractInputValues(match[0]);
};

SiiSession.extractInputTags = function(html) {
  const tags = [];
  const regex = /<input[^>]+>/gi;
  const matches = html.match(regex) || [];
  matches.forEach((tag) => {
    const nameMatch = tag.match(/name\s*=\s*"([^"]+)"/i);
    const valueMatch = tag.match(/value\s*=\s*"([^"]*)"/i);
    const typeMatch = tag.match(/type\s*=\s*"([^"]+)"/i);
    const onClickMatch = tag.match(/onClick\s*=\s*"([^"]+)"/i);
    tags.push({
      name: nameMatch ? nameMatch[1] : null,
      value: valueMatch ? valueMatch[1] : null,
      type: typeMatch ? typeMatch[1] : null,
      onClick: onClickMatch ? onClickMatch[1] : null,
    });
  });
  return tags;
};

SiiSession.stripHtml = function(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

SiiSession.parseIntFromText = function(value) {
  const match = String(value || '').match(/(\d{1,})/);
  return match ? Number(match[1]) : null;
};

module.exports = SiiSession;
