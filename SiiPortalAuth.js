// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiPortalAuth.js
 *
 * Autenticación con certificado digital en el portal del SII (herculesr.sii.cl).
 * Permite obtener datos del contribuyente (fch_resol, nro_resol, razón social)
 * directamente desde el portal sin login manual.
 *
 * Flujo (confirmado por análisis del portal):
 *  1. GET  zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoCertificado.html?TARGET
 *          → obtiene cookie F5 BIG-IP de sesión
 *  2. POST herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?TARGET   body: referencia=TARGET
 *          → herculesr SÍ solicita cert en el TLS handshake inicial (a diferencia de zeusr)
 *          → SII extrae el RUT del campo serialNumber del certificado
 *          → responde con set-cookie: NETSCAPE_LIVEWIRE.* (sesión activa)
 *  3. POST maullin.sii.cl/cvc_cgi/dte/ad_empresa2   body: RUT_EMP=XXXXX&DV_EMP=X
 *          → devuelve tabla HTML con datos del contribuyente
 *
 * @module SiiPortalAuth
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { URL } = require('url');
const forge  = require('node-forge');
const crypto = require('crypto');
const SiiSessionStore = require('./SiiSessionStore');

function _cookieObjToStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

function _parseCookieStr(str) {
  const obj = {};
  for (const pair of (str || '').split('; ')) {
    const eq = pair.indexOf('=');
    if (eq > 0) obj[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return obj;
}

// ─── Opciones TLS comunes para SII ────────────────────────────────────────────
const SII_TLS_OPTS = {
  rejectUnauthorized: false,
  maxVersion: 'TLSv1.2',
  secureOptions:
    crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION |
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
};

// ─── Ruta del caché de sesión ─────────────────────────────────────────────────
// Guarda las cookies NETSCAPE_LIVEWIRE.* para reusar entre ejecuciones y evitar
// el error "máximo de sesiones autenticadas" del SII.
const SESSION_CACHE_PATH = path.join(
  process.env.DATADIR || path.join(os.homedir(), 'AppData', 'Roaming', 'POS'),
  'sii_session_cache.json'
);

/**
 * Registro global de instancias SiiPortalAuth por certHash (singleton por certificado).
 * Evita abrir múltiples sesiones concurrentes en el portal SII para el mismo certificado.
 * Mismo patrón que CafSolicitor._sessionRegistry.
 * @type {Map<string, SiiPortalAuth>}
 */
const _instanceRegistry = new Map();

/**
 * Clase principal de autenticación con el portal SII
 */
class SiiPortalAuth {
  /**
   * @param {Object} options
   * @param {Buffer}  options.pfxBuffer   - Buffer del archivo PFX
   * @param {string}  options.pfxPassword - Contraseña del PFX
   */
  constructor({ pfxBuffer, pfxPassword }) {
    if (!pfxBuffer) throw new Error('SiiPortalAuth: pfxBuffer es obligatorio');
    if (pfxPassword === undefined) throw new Error('SiiPortalAuth: pfxPassword es obligatorio');

    const { certPem, keyPem, chainPem } = SiiPortalAuth._extractPems(pfxBuffer, pfxPassword);
    this._certPem = certPem;
    this._keyPem  = keyPem;
    // Huella para identificar de qué cert es la sesión cacheada
    this._certHash = crypto.createHash('sha1').update(certPem).digest('hex').slice(0, 12);

    // Reutilizar instancia existente en memoria si ya existe para este certificado.
    // Esto evita abrir múltiples sesiones paralelas en el portal SII.
    if (_instanceRegistry.has(this._certHash)) {
      return _instanceRegistry.get(this._certHash);
    }

    this._agentePlano = new https.Agent(SII_TLS_OPTS);
    // chainPem incluye hoja + intermedios + raíz extraídos por forge.
    // Necesario para PFX con cadena completa (ej. IDOK) — SII necesita los
    // intermedios para verificar la firma. tls.createSecureContext({ pfx }) no se
    // usa porque OpenSSL 3 (Node 24) rechaza ciertos formatos PKCS12 modernos.
    this._agenteCert  = new https.Agent({ ...SII_TLS_OPTS, cert: chainPem, key: keyPem });

    _instanceRegistry.set(this._certHash, this);
  }

  /**
   * Extrae cert + key PEM desde un PFX usando node-forge
   * (node-forge soporta PKCS12 moderno AES-256 que Node nativo rechaza)
   * @private
   */
  /**
   * Extrae clave privada y cadena de certificados de un PFX/PKCS12.
   * Soporta: RSA y EC, 1 a N certificados, cadenas desordenadas,
   * pkcs8ShroudedKeyBag y keyBag, algoritmos legacy (RC2, 3DES) y modernos.
   * Usa forge (no tls.createSecureContext) para ser compatible con formatos
   * PKCS12 que OpenSSL 3 rechaza (ej. IDOK con SHA-1 MAC o AES-256 encryption).
   *
   * @returns {{ certPem: string, keyPem: string, chainPem: string }}
   *   certPem  - solo el certificado hoja (para _certHash)
   *   keyPem   - clave privada PEM
   *   chainPem - cadena completa ordenada: hoja → intermedios → raíz
   */
  static _extractPems(pfxBuffer, password) {
    // ── 1. Parsear PKCS12 ────────────────────────────────────────────────────
    let p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfxBuffer.toString('binary')), password);
    } catch (e) {
      throw new Error(`SiiPortalAuth: no se pudo parsear el PFX — ${e.message}`);
    }

    // ── 2. Clave privada: probar todos los tipos de key bag ──────────────────
    let keyObj = null;
    for (const oid of [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag]) {
      const bags = p12.getBags({ bagType: oid })[oid] || [];
      const found = bags.find(b => b.key);
      if (found) { keyObj = found.key; break; }
    }
    if (!keyObj) throw new Error('SiiPortalAuth: no se encontró clave privada en el PFX');
    const keyPem = forge.pki.privateKeyToPem(keyObj);

    // ── 3. Certificados: recopilar todos ─────────────────────────────────────
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const allCerts = certBags.map(b => b.cert).filter(Boolean);
    if (!allCerts.length) throw new Error('SiiPortalAuth: no se encontró certificado en el PFX');

    // ── 4. Identificar el certificado hoja ───────────────────────────────────
    // Estrategia 1: el cert cuya clave pública coincide con la clave privada
    let leafCert = null;
    try {
      // Funciona para RSA y EC mientras forge pueda derivar la clave pública
      const pubFromKey = forge.pki.setRsaPublicKey
        ? forge.pki.setRsaPublicKey(keyObj.n, keyObj.e)   // RSA
        : null;
      if (pubFromKey) {
        const pubPem = forge.pki.publicKeyToPem(pubFromKey);
        leafCert = allCerts.find(c => forge.pki.publicKeyToPem(c.publicKey) === pubPem) ?? null;
      }
    } catch (_) { /* EC u otro — caer a estrategia 2 */ }

    // Estrategia 2: el primer cert que NO sea CA (basicConstraints.cA = false/absent)
    if (!leafCert) {
      leafCert = allCerts.find(c => {
        const bc = c.getExtension('basicConstraints');
        return !bc || bc.cA !== true;
      }) ?? allCerts[0];
    }

    // ── 5. Ordenar cadena: hoja → intermedios → raíz ─────────────────────────
    // Construir la cadena siguiendo relaciones issuer→subject
    const remaining = allCerts.filter(c => c !== leafCert);
    const chain = [leafCert];
    let current = leafCert;

    while (remaining.length > 0) {
      // El siguiente eslabón es el cert cuyo subject coincide con el issuer del actual
      const issuerHash = current.issuer.hash;
      const idx = remaining.findIndex(c => c.subject.hash === issuerHash);
      if (idx < 0) break;                              // fin de cadena conocida
      current = remaining.splice(idx, 1)[0];
      if (chain.includes(current)) break;             // ciclo (self-signed raíz)
      chain.push(current);
    }
    // Appender cualquier cert restante que no pudimos encadenar
    chain.push(...remaining);

    const certPem  = forge.pki.certificateToPem(leafCert);
    const chainPem = chain.map(c => forge.pki.certificateToPem(c)).join('');

    return { certPem, keyPem, chainPem };
  }

  // ─── HTTP helpers ────────────────────────────────────────────────────────────

  _request(urlStr, { method = 'GET', cookieJar = {}, body = null, headers = {}, usarCert = false } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-CL,es;q=0.9',
          'Connection': 'keep-alive',
          ...headers,
        },
      };

      const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieStr) options.headers['Cookie'] = cookieStr;

      if (body) {
        if (!options.headers['Content-Type']) {
          options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      if (isHttps) options.agent = usarCert ? this._agenteCert : this._agentePlano;

      const req = (isHttps ? https : http).request(options, (res) => {
        // Capturar cookies
        for (const cookieHeader of (res.headers['set-cookie'] || [])) {
          const [pair] = cookieHeader.split(';');
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            const name = pair.slice(0, eqIdx).trim();
            const val  = pair.slice(eqIdx + 1).trim();
            cookieJar[name] = val;
          }
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          // Todos los hosts *.sii.cl sirven páginas ISO-8859-1; a veces no incluyen charset en Content-Type.
          const isSiiHost = url.hostname.endsWith('.sii.cl');
          const encoding = (isSiiHost || /iso-8859|latin-1|windows-1252/i.test(ct)) ? 'latin1' : 'utf8';
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(encoding), cookieJar });
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  /**
   * Autenticar con certificado en el portal SII y obtener cookies de sesión.
   * Retorna el cookieJar con NETSCAPE_LIVEWIRE.* si tuvo éxito.
   *
   * @returns {Promise<Object>} cookieJar con sesión SII activa
   * @throws {Error} Si la autenticación falla
   */
  async autenticar() {
    const TARGET = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';

    // ── 1a. Store compartido (cubre sesiones de CafSolicitor/SiiSession) ────────
    const storedStr = SiiSessionStore.get(this._certHash);
    if (storedStr) {
      const cookieObj = _parseCookieStr(storedStr);
      const validaStore = await this._validarSesion(cookieObj);
      if (validaStore) {
        console.log('[SiiPortalAuth] Reutilizando sesión SII desde store compartido');
        this._cachedCookieJar = cookieObj;
        SiiPortalAuth._guardarSesionCache(this._certHash, cookieObj);
        return cookieObj;
      }
      SiiSessionStore.delete(this._certHash);
      console.warn('[SiiPortalAuth] Sesión del store compartido expirada, borrando...');
    }

    // ── 1b. Caché en disco ───────────────────────────────────────────────────
    const cached = SiiPortalAuth._cargarSesionCache(this._certHash);
    if (cached) {
      const valida = await this._validarSesion(cached);
      if (valida) {
        console.log('[SiiPortalAuth] Reutilizando sesión SII cacheada');
        this._cachedCookieJar = cached;
        SiiSessionStore.set(this._certHash, _cookieObjToStr(cached));
        return cached;
      }
      console.warn('[SiiPortalAuth] Sesión cacheada expirada, re-autenticando...');
    }

    // ── 2. Nueva autenticación ────────────────────────────────────────────────
    const cookieJar = {};

    await this._request(
      `https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoCertificado.html?${TARGET}`,
      { cookieJar }
    );

    console.log('[SiiPortalAuth] Autenticando con certificado en herculesr.sii.cl...');
    const r2 = await this._request(
      `https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${TARGET}`,
      {
        method: 'POST',
        body: `referencia=${encodeURIComponent(TARGET)}`,
        cookieJar,
        usarCert: true,
      }
    );
    console.log(`[SiiPortalAuth] Respuesta herculesr: status=${r2.status}`);

    // Verificar mensaje de límite de sesiones
    if (r2.body.includes('m\u00e1ximo de sesiones') || r2.body.includes('maximo de sesiones') ||
        r2.body.includes('01.01.215.500.709')) {
      throw new Error(
        'SiiPortalAuth: límite de sesiones SII alcanzado.\n' +
        'Cierra sesión en sii.cl y espera ~30 min, o las sesiones anteriores expirarán solas.'
      );
    }

    const autenticado = Object.keys(cookieJar).some(k => k.startsWith('NETSCAPE_LIVEWIRE'));
    if (!autenticado) {
      throw new Error('SiiPortalAuth: autenticación fallida — no se recibieron cookies de sesión NETSCAPE_LIVEWIRE.*');
    }

    SiiPortalAuth._guardarSesionCache(this._certHash, cookieJar);
    SiiSessionStore.set(this._certHash, _cookieObjToStr(cookieJar));
    this._cachedCookieJar = cookieJar;
    return cookieJar;
  }

  /**
   * Verifica si una sesión cacheada sigue activa haciendo un GET liviano.
   * Si el SII redirige al login → sesión expirada.
   * @private
   */
  async _validarSesion(cookieJar) {
    try {
      console.log('[SiiPortalAuth] Validando sesión cacheada en SII...');
      const res = await this._request(
        'https://maullin.sii.cl/cvc_cgi/dte/ad_empresa1',
        { cookieJar: { ...cookieJar } } // copia para no contaminar
      );
      // Si redirige al login SII → expirada
      const loc = res.headers['location'] || '';
      if (loc.includes('InicioAutenticacion') || loc.includes('IngresoRutClave')) {
        console.warn('[SiiPortalAuth] Validación: SII redirigió al login → sesión expirada');
        return false;
      }
      // Si el body contiene formulario de empresa → válida
      const valida = res.status === 200 && (res.body.includes('RUT_EMP') || res.body.includes('ad_empresa'));
      console.log(`[SiiPortalAuth] Validación: status=${res.status} → sesión ${valida ? 'VÁLIDA ✓' : 'INVÁLIDA ✗'}`);
      // Refrescar timestamp del caché para extender TTL mientras la sesión se usa activamente
      if (valida) SiiPortalAuth._guardarSesionCache(this._certHash, cookieJar);
      return valida;
    } catch (err) {
      console.warn('[SiiPortalAuth] Validación: error de red →', err.message);
      return false;
    }
  }

  /** Lee sesión cacheada del disco para el cert dado. @private */
  static _cargarSesionCache(certHash) {
    try {
if (!fs.existsSync(SESSION_CACHE_PATH)) {
        console.log('[SiiPortalAuth] Cache: archivo no existe →', SESSION_CACHE_PATH);
        return null;
      }
      const data = JSON.parse(fs.readFileSync(SESSION_CACHE_PATH, 'utf8'));
      if (data.certHash !== certHash) {
        console.log(`[SiiPortalAuth] Cache: cert no coincide (guardado=${data.certHash} actual=${certHash})`);
        return null;
      }
      const edadMin = Math.round((Date.now() - data.ts) / 60000);
      // TTL: 90 minutos (SII permite ~2h de inactividad; se refresca en cada validación)
      if (Date.now() - data.ts > 90 * 60 * 1000) {
        console.log(`[SiiPortalAuth] Cache: sesión expirada (edad=${edadMin} min, TTL=90 min)`);
        return null;
      }
      console.log(`[SiiPortalAuth] Cache: sesión encontrada`);
      return data.cookies;
    } catch (err) {
      console.warn('[SiiPortalAuth] Cache: error leyendo caché →', err.message);
      return null;
    }
  }

  /** Guarda sesión en disco. @private */
  static _guardarSesionCache(certHash, cookieJar) {
    try {
      fs.mkdirSync(path.dirname(SESSION_CACHE_PATH), { recursive: true });
      fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify({
        certHash,
        ts: Date.now(),
        cookies: cookieJar,
      }), 'utf8');
      const cookieKeys = Object.keys(cookieJar);
      console.log(`[SiiPortalAuth] Cache: sesión guardada`);
    } catch (err) {
      console.warn('[SiiPortalAuth] Cache: error guardando caché →', err.message);
    }
  }

  /** Borra la sesión cacheada (útil para forzar re-login). */
  static limpiarSesionCache() {
    try { fs.unlinkSync(SESSION_CACHE_PATH); } catch { /* ignorar */ }
  }

  /**
   * Obtiene datos del contribuyente desde ad_empresa2.
   * Incluye fch_resol, nro_resol, razón social, etc.
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "12345678")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @param {Object} [cookieJar] - Sesión ya autenticada (opcional; si omite, autenticará)
   * @returns {Promise<Object>} { rut, razonSocial, fch_resol, nro_resol, fecha_autorizacion }
   */
  async obtenerDatosEmpresa(rutEmpresa, dvEmpresa, cookieJar = null) {
    const jar = cookieJar || await this.autenticar();

    // ad_empresa1 → mostrar el form de ingreso de RUT (obtiene cookie de sesión maullin)
    await this._request('https://maullin.sii.cl/cvc_cgi/dte/ad_empresa1', { cookieJar: jar });

    // ad_empresa2 → POST con RUT empresa → devuelve tabla con datos
    const res = await this._request(
      'https://maullin.sii.cl/cvc_cgi/dte/ad_empresa2',
      {
        method: 'POST',
        body: `RUT_EMP=${encodeURIComponent(rutEmpresa)}&DV_EMP=${encodeURIComponent(dvEmpresa)}&ACEPTAR=Ingresar`,
        cookieJar: jar,
      }
    );

    return SiiPortalAuth._parsearTablaEmpresa(res.body);
  }

  /**
   * Método de conveniencia: autentica y obtiene TODOS los datos del emisor en un solo paso:
   * - fch_resol / nro_resol   (desde ad_empresa2)
   * - rut, razonSocial, giro, dirección, comuna, acteco  (desde pe_construccion_dte)
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "12345678")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @returns {Promise<Object>} Datos completos del emisor
   */
  async fetchDatosEmpresa(rutEmpresa, dvEmpresa) {
    const cookieJar = await this.autenticar();
    const [resolucion, contribuyente] = await Promise.all([
      this.obtenerDatosEmpresa(rutEmpresa, dvEmpresa, cookieJar),
      this.obtenerDatosContribuyente(rutEmpresa, dvEmpresa, cookieJar).catch(() => null),
    ]);
    return { ...contribuyente, ...resolucion };
  }

  /**
   * Obtiene datos fidedignos del contribuyente para construcción DTE.
   * Flujo:
   *   1. POST pe_construccion_dte con RUT_EMP + DV_EMP
   *      → redirige a ce_consulta_muestra_e con la tabla de datos
   *   2. Parsea la tabla: nombre, dirección, actividades económicas, glosa
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "12345678")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @param {Object} [cookieJar] - Sesión autenticada (si omite, autenticará)
   * @returns {Promise<Object>} { rut, razonSocial, direccion, comuna, dirReg, acteco, glosa }
   */
  async obtenerDatosContribuyente(rutEmpresa, dvEmpresa, cookieJar = null) {
    const jar = cookieJar || await this.autenticar();

    // POST directo al action del form: ce_consulta_muestra_e
    // (pe_construccion_dte solo devuelve el formulario, no los datos)
    const res = await this._request(
      'https://maullin.sii.cl/cvc_cgi/dte/ce_consulta_muestra_e',
      {
        method: 'POST',
        body: `RUT_EMP=${encodeURIComponent(rutEmpresa)}&DV_EMP=${encodeURIComponent(dvEmpresa)}&ACEPTAR=CONSULTAR`,
        cookieJar: jar,
      }
    );

    return SiiPortalAuth._parsearCeConsultaMuestra(res.body);
  }

  /**
   * Parsea el HTML de ce_consulta_muestra_e.
   *
   * Estructura real del SII:
   *   <td>DATOS DEL CONTRIBUYENTE RUT</td><td>12345678-9</td>
   *   <td>NOMBRE O RAZÓN SOCIAL</td><td>EMPRESA EJEMPLO SPA</td>
   *   <td>DIRECCIÓN DE LA EMPRESA</td><td>AV. EJEMPLO 123, Comuna Santiago</td>
   *   <td>DIRECCIÓN REGIONAL DEL CONTRIBUYENTE</td><td>SANTIAGO</td>
   *   + tabla actividades: <td>620100</td><td>ACTIVIDADES DE PROGRAMACION...</td><td>SI</td>
   *   + tabla glosa: <td>GLOSA DESCRIPTIVA</td><td>Desarrollo de software...</td>
   * @private
   */
  static _parsearCeConsultaMuestra(html) {
    const clean = (s) => s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&oacute;/g, 'ó').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
      .replace(/&Oacute;/g, 'Ó').replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É')
      .replace(/&Iacute;/g, 'Í').replace(/&Ntilde;/g, 'Ñ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    const datos = {};
    const actividades = [];

    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const celdas = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
      if (celdas.length === 2 && celdas[0]) {
        datos[celdas[0].toUpperCase()] = celdas[1];
      } else if (celdas.length === 3) {
        // Filas de actividades económicas: código, descripción, afecto IVA
        const codigo = celdas[0].replace(/\s/g, '');
        if (/^\d{4,6}$/.test(codigo)) {
          actividades.push({ codigo, descripcion: celdas[1], afectoIva: celdas[2] });
        }
      }
    }

    // Extraer dirección y comuna (la dirección incluye "Comuna XXXX" al final)
    const dirRaw = datos['DIRECCIÓN DE LA EMPRESA'] || datos['DIRECCION DE LA EMPRESA'] || null;
    let direccion = dirRaw;
    let comuna = null;
    if (dirRaw) {
      const comunaMatch = dirRaw.match(/,?\s*Comuna\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑA-Z ]+)$/i);
      if (comunaMatch) {
        comuna = comunaMatch[1].trim();
        direccion = dirRaw.slice(0, comunaMatch.index).replace(/,\s*$/, '').trim();
      }
    }

    const dirReg = datos['DIRECCIÓN REGIONAL DEL CONTRIBUYENTE'] || datos['DIRECCION REGIONAL DEL CONTRIBUYENTE'] || null;
    const glosa  = datos['GLOSA DESCRIPTIVA'] || null;

    return {
      rut:          datos['DATOS DEL CONTRIBUYENTE RUT'] || null,
      razonSocial:  datos['NOMBRE O RAZÓN SOCIAL'] || datos['NOMBRE O RAZON SOCIAL'] || null,
      giro:         actividades[0]?.descripcion || null,  // descripción de la primera actividad económica
      direccion,
      comuna,
      dirReg,
      sucursal_sii: dirReg ? `S.I.I. - ${dirReg}` : null,
      acteco:       actividades[0]?.codigo || null,
      actividades:  actividades.length ? actividades : null,
      glosa,
    };
  }

  // ─── Parser interno ──────────────────────────────────────────────────────────

  /**
   * Parsea la tabla HTML de ad_empresa2.
   * El HTML tiene filas <tr><td>Label</td><td>&nbsp;Valor</td></tr>
   * @private
   */
  static _parsearTablaEmpresa(html) {
    const datos = {};
    const decode = s => s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, '')
      .replace(/&oacute;/g, 'ó')
      .replace(/&aacute;/g, 'á')
      .replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í')
      .replace(/&uacute;/g, 'ú')
      .replace(/&ntilde;/g, 'ñ')
      .replace(/&amp;/g, '&')
      .trim();

    // Dividir por apertura <TR> — HTML 4.01 no exige tags </TR> de cierre
    for (const seg of html.split(/<tr[^>]*>/i)) {
      const celdas = [...seg.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => decode(m[1]));
      if (celdas.length >= 2 && celdas[0]) datos[celdas[0]] = celdas[1];
    }

    // Buscar por regex para ser resiliente ante variaciones de encoding / tildes
    const fechaKey  = Object.keys(datos).find(k => /fecha.*resol/i.test(k)) || null;
    const nroKey    = Object.keys(datos).find(k => /^resoluci/i.test(k) && !/fecha/i.test(k)) || null;
    const fechaResol = fechaKey ? datos[fechaKey] : null;
    const nroResol   = nroKey   ? datos[nroKey]   : null;

    if (fechaResol === null && nroResol === null) {
      // Loguear los campos encontrados para diagnóstico
      const camposEncontrados = Object.keys(datos);
      console.warn('[SiiPortalAuth] ad_empresa2 campos encontrados:', camposEncontrados.length ? camposEncontrados.join(', ') : '(ninguno)');
      if (!camposEncontrados.length) {
        // Puede ser una página de login o error — loguear inicio del HTML
        console.warn('[SiiPortalAuth] HTML ad_empresa2 (primeros 500 chars):', html.slice(0, 500).replace(/\s+/g, ' '));
      }
      throw new Error('SiiPortalAuth: no se encontraron datos de resolución en la respuesta del SII');
    }

    // Convertir fecha DD-MM-YYYY → YYYY-MM-DD
    const fchResolIso = fechaResol
      ? fechaResol.replace(/^(\d{2})-(\d{2})-(\d{4})$/, '$3-$2-$1')
      : null;

    return {
      rut:               datos['Rut']               || null,
      razonSocial:       datos['Razón Social']       || null,
      fch_resol:         fchResolIso,
      nro_resol:         nroResol !== null ? parseInt(nroResol, 10) : null,
      fecha_autorizacion: datos['Fecha Autorización'] || null,
    };
  }

  // ─── Consemitidos (www4.sii.cl/consemitidosinternetui) ───────────────────────

  /**
   * Navega a consemitidosinternetui para obtener el TOKEN de sesión.
   * El TOKEN es el mismo valor que CSESSIONID y va como conversationId en el body.
   * @private
   */
  async _obtenerTokenConsemitidos(cookieJar) {
    await this._request('https://www4.sii.cl/consemitidosinternetui/', { cookieJar });
    const token = cookieJar['TOKEN'] || cookieJar['CSESSIONID'];
    if (!token) {
      throw new Error('SiiPortalAuth: no se pudo obtener TOKEN de sesión de consemitidosinternetui');
    }
    return token;
  }

  /**
   * Llama a un endpoint JSON de la API consemitidosinternetui.
   * @private
   */
  async _callConsemitidos(method, data, token, cookieJar) {
    const body = JSON.stringify({
      metaData: {
        namespace:      `cl.sii.sdi.lob.diii.consemitidos.data.api.interfaces.FacadeService/${method}`,
        conversationId: token,
        transactionId:  crypto.randomUUID(),
        page:           null,
      },
      data,
    });
    const res = await this._request(
      `https://www4.sii.cl/consemitidosinternetui/services/data/facadeService/${method}`,
      {
        method:  'POST',
        body,
        cookieJar,
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json, text/plain, */*',
          'Origin':       'https://www4.sii.cl',
          'Referer':      'https://www4.sii.cl/consemitidosinternetui/',
        },
      }
    );
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`SiiPortalAuth: respuesta no-JSON de ${method}: ${res.body.slice(0, 300)}`);
    }
  }

  /**
   * Obtiene el detalle de DTEs emitidos o recibidos desde www4.sii.cl.
   *
   * @param {string} rut       - RUT sin DV (ej: "12345678")
   * @param {string} dv        - DV (ej: "K")
   * @param {string} periodo   - Período YYYY-MM (ej: "2026-05")
   * @param {number} operacion - 1 = compras / recibidos, 2 = ventas / emitidos
   * @param {Object} [cookieJar] - Sesión ya autenticada (opcional)
   * @returns {Promise<{ resumen: Array, detalles: Array }>}
   */
  async obtenerDetalleDtes(rut, dv, periodo, operacion = 2, cookieJar = null) {
    const jar   = cookieJar || await this.autenticar();
    const token = await this._obtenerTokenConsemitidos(jar);

    // Mapeo de convención interna → convención SII:
    //   interno: 1 = compras/recibidos,  2 = ventas/emitidos
    //   SII:     1 = emitidos,            2 = recibidos
    const siiOperacion = operacion === 2 ? 1 : 2;
    const esEmitidos   = siiOperacion === 1;

    // 1. Resumen mensual — saber qué tipos de DTE hay en el período
    const resumenResp = await this._callConsemitidos('getResumen', {
      periodo,
      rutContribuyente: rut,
      dvContribuyente:  dv,
      operacion: siiOperacion,
    }, token, jar);

    const resumen = resumenResp.data?.resumenDte ?? [];
    if (resumen.length === 0) return { resumen: [], detalles: [] };

    // 2. Detalle por cada tipo DTE encontrado en el resumen
    const detallesArr = await Promise.all(
      resumen.map(async (t) => {
        // Para emitidos tipo 33/34, el SII expone un método específico
        const metodo = esEmitidos && (t.tipoDoc === 33 || t.tipoDoc === 34)
          ? 'getDetalleEmitidos3334'
          : 'getDetalleRecibidos';
        const resp = await this._callConsemitidos(metodo, {
          tipoDoc:    String(t.tipoDoc),
          rut,
          dv,
          periodo,
          operacion:  siiOperacion,
          derrCodigo: String(t.tipoDoc),
          refNCD:     '0',
        }, token, jar);
        const items = resp.dataResp?.detalles ?? [];
        // Completar tipoDoc y tipoDocDesc desde el resumen si no vienen en el detalle
        return items.map((d) => ({
          ...d,
          tipoDoc:     t.tipoDoc,
          tipoDocDesc: d.descTipoDoc || t.tipoDocDesc,
        }));
      })
    );

    return { resumen, detalles: detallesArr.flat() };
  }

  /**
   * Retorna las cookies de sesión activas para un PFX dado, en formato string para SiiSession.
   * Busca primero en el registry en memoria, luego en el caché a disco.
   * Retorna null si no hay sesión previa (no hace auth nueva).
   *
   * Usado por CafSolicitor para reutilizar la sesión de SiiPortalAuth y evitar
   * abrir una segunda sesión paralela en el portal SII para el mismo certificado.
   *
   * @param {Buffer} pfxBuffer - Buffer del archivo PFX
   * @param {string} pfxPassword - Contraseña del PFX
   * @returns {string|null} Cookies en formato "KEY=val; KEY2=val2" o null
   */
  static getCookieStringForPfx(pfxBuffer, pfxPassword) {
    try {
      const { certPem } = SiiPortalAuth._extractPems(pfxBuffer, pfxPassword);
      const certHash = crypto.createHash('sha1').update(certPem).digest('hex').slice(0, 12);

      // 0. Store compartido (cubre tanto SiiPortalAuth como SiiSession/CafSolicitor)
      const storedStr = SiiSessionStore.get(certHash);
      if (storedStr) {
        console.log('[SiiPortalAuth] 🔗 getCookieStringForPfx: cookies desde store compartido (hash=' + certHash + ')');
        return storedStr;
      }

      // 1. Registry en memoria (más rápido, no hace I/O)
      const instance = _instanceRegistry.get(certHash);
      if (instance?._cachedCookieJar) {
        const str = Object.entries(instance._cachedCookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
        console.log('[SiiPortalAuth] 🔗 getCookieStringForPfx: cookies desde registry en memoria (hash=' + certHash + ')');
        return str;
      }

      // 2. Caché en disco (sobrevive reinicios dentro del mismo deploy)
      const fileCookies = SiiPortalAuth._cargarSesionCache(certHash);
      if (fileCookies) {
        const str = Object.entries(fileCookies).map(([k, v]) => `${k}=${v}`).join('; ');
        console.log('[SiiPortalAuth] 🔗 getCookieStringForPfx: cookies desde caché en disco (hash=' + certHash + ')');
        return str;
      }

      console.log('[SiiPortalAuth] getCookieStringForPfx: sin sesión previa para hash=' + certHash);
    } catch (_e) {
      console.warn('[SiiPortalAuth] getCookieStringForPfx: error leyendo PFX —', _e.message);
    }
    return null;
  }

  /**
   * Cierra todas las instancias SiiPortalAuth en caché (logout en el portal SII).
   * Llamar durante el shutdown del proceso junto a CafSolicitor.closeAllSessions().
   */
  static async closeAllSessions() {
    for (const [hash, instance] of _instanceRegistry) {
      try {
        const logoutUrls = [
          'https://herculesr.sii.cl/cgi_AUT2000/autLogout.cgi',
          'https://www.sii.cl/AUT2000/autLogout.cgi',
        ];
        for (const url of logoutUrls) {
          await instance._request(url, { method: 'GET' }).catch(() => {});
        }
      } catch (_e) { /* ignorar errores de red al apagar */ }
      _instanceRegistry.delete(hash);
      SiiSessionStore.delete(hash);
    }
  }
}

module.exports = SiiPortalAuth;
