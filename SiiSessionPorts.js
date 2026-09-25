// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiSessionPorts.js
 *
 * La sesión del portal SII es un recurso escaso por certificado: el SII limita las
 * sesiones autenticadas simultáneas por RUT (error "máximo de sesiones autenticadas"), y las
 * cookies Tivoli se rompen si dos requests concurrentes comparten la misma sesión.
 *
 * Este módulo define los dos puertos con los que la librería garantiza, sin importar cuántos
 * procesos la usen: **una sola sesión por certificado, usada por un solo llamador a la vez**.
 *
 *   SessionStore  dónde vive la sesión.
 *     load(certHash)          → Promise<{ ts, cookies } | null>
 *     save(certHash, cookies) → Promise<void>          (el store sella `ts`)
 *     remove(certHash?)       → Promise<void>          (sin argumento borra todas)
 *
 *   SessionLock   quién la usa ahora.
 *     withLock(key, fn)       → Promise<T>   exclusión mutua por `key`; `fn` corre solo cuando
 *                                            se obtuvo el lock y se libera al terminar, aun si falla.
 *
 *   StateStore    dónde vive el resto del estado que debe sobrevivir entre corridas y verse entre
 *                 réplicas (folios anulados, período de libros, folios usados en certificación).
 *     load(clave)           → Promise<object | Array | null>
 *     save(clave, valor)    → Promise<void>
 *     remove(clave)         → Promise<void>
 *   Es un almacén de documentos JSON por clave, sin semántica de sesión ni de lock.
 *
 * Los adaptadores por defecto (archivo + mutex en proceso) reproducen el comportamiento de
 * siempre para un solo proceso. Un consumidor con varias réplicas inyecta los suyos (por
 * ejemplo Redis) con `SiiPortalAuth.configurarSesion({ store, lock })`.
 *
 * `SessionBroker` es el único punto de entrada: agrega la reentrancia (un `withSession`
 * anidado para el mismo certificado no se bloquea a sí mismo), que por eso no tienen que
 * implementar los adaptadores.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Mutex en memoria del proceso, por clave. Válido para una sola réplica.
 * @implements {SessionLock}
 */
class MemorySessionLock {
  constructor() {
    /** @type {Map<string, Promise<void>>} cola de espera por clave */
    this._colas = new Map();
  }

  async withLock(key, fn) {
    const anterior = this._colas.get(key) || Promise.resolve();
    let liberar;
    const turno = new Promise((resolve) => { liberar = resolve; });
    const cola = anterior.then(() => turno);
    this._colas.set(key, cola);

    await anterior;
    try {
      return await fn();
    } finally {
      liberar();
      if (this._colas.get(key) === cola) this._colas.delete(key);
    }
  }
}

/**
 * Store en memoria del proceso. Sirve para tests y para consumidores que no quieran
 * persistir la sesión en disco.
 * @implements {SessionStore}
 */
class MemorySessionStore {
  constructor() {
    this._sesiones = new Map();
  }

  // Se copia al guardar y al leer: `SiiPortalAuth._request` muta el cookieJar, y con un store
  // por referencia esa mutación se filtraría a la sesión guardada (con archivo o Redis no pasa).
  async load(certHash) {
    const entrada = this._sesiones.get(certHash);
    return entrada ? { ts: entrada.ts, cookies: { ...entrada.cookies } } : null;
  }

  async save(certHash, cookies) {
    this._sesiones.set(certHash, { ts: Date.now(), cookies: { ...cookies } });
  }

  async remove(certHash) {
    if (certHash === undefined) this._sesiones.clear();
    else this._sesiones.delete(certHash);
  }
}

/**
 * Verifica que `estado` cumpla el puerto StateStore. Lanza TypeError con el nombre del que
 * llama para que el error diga dónde se pasó el objeto equivocado.
 */
function validarStateStore(estado, donde = 'StateStore') {
  if (!estado || typeof estado.load !== 'function' || typeof estado.save !== 'function' || typeof estado.remove !== 'function') {
    throw new TypeError(`${donde}: \`estado\` debe implementar load, save y remove`);
  }
  return estado;
}

/**
 * StateStore en memoria del proceso. Copia al guardar y al leer, por la misma razón que
 * MemorySessionStore: un store por referencia filtraría mutaciones del llamador.
 * @implements {StateStore}
 */
class MemoryStateStore {
  constructor() {
    this._docs = new Map();
  }

  async load(clave) {
    return this._docs.has(clave) ? JSON.parse(this._docs.get(clave)) : null;
  }

  async save(clave, valor) {
    this._docs.set(clave, JSON.stringify(valor));
  }

  async remove(clave) {
    this._docs.delete(clave);
  }
}

/**
 * StateStore en archivos: un `<clave>.json` por documento dentro de `dir`. Es el adaptador por
 * defecto y conserva los nombres de archivo de siempre (`folios-anulados-<rut>-<tipo>.json`,
 * `periodo-libros.json`, ...), así que un consumidor que no configure nada sigue leyendo y
 * escribiendo los mismos archivos. Lo que ya estaba guardado sin sangría se sigue leyendo.
 * @implements {StateStore}
 */
class FileStateStore {
  /** @param {string} dir directorio donde viven los archivos de estado */
  constructor(dir) {
    if (!dir) throw new TypeError('FileStateStore: `dir` es obligatorio');
    this.dir = dir;
  }

  _ruta(clave) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(clave))) {
      throw new TypeError(`FileStateStore: clave inválida "${clave}"`);
    }
    return path.join(this.dir, `${clave}.json`);
  }

  async load(clave) {
    try {
      return JSON.parse(fs.readFileSync(this._ruta(clave), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  async save(clave, valor) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._ruta(clave), JSON.stringify(valor, null, 2), 'utf8');
  }

  async remove(clave) {
    try {
      fs.unlinkSync(this._ruta(clave));
    } catch (_) {
      // ya no existe
    }
  }
}

/**
 * Punto único de acceso a la sesión: `withSession(certHash, fn)` ejecuta `fn` con el lock del
 * certificado tomado. Es reentrante por flujo asíncrono: si dentro de `fn` se vuelve a llamar
 * a `withSession` con el mismo certificado, corre directo en vez de esperarse a sí mismo.
 */
class SessionBroker {
  /**
   * @param {{ store: SessionStore, lock: SessionLock }} puertos
   */
  constructor({ store, lock }) {
    /** @type {AsyncLocalStorage<Set<string>>} certificados cuyo lock ya tiene este flujo */
    this._tomados = new AsyncLocalStorage();
    this.reconfigurar({ store, lock });
  }

  /**
   * Cambia los puertos SIN crear otro broker, para no perder la reentrancia de los flujos en
   * vuelo (el contexto de cada flujo vive en este broker). Valida antes de asignar.
   */
  reconfigurar({ store, lock }) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.remove !== 'function') {
      throw new TypeError('SessionBroker: `store` debe implementar load, save y remove');
    }
    if (!lock || typeof lock.withLock !== 'function') {
      throw new TypeError('SessionBroker: `lock` debe implementar withLock');
    }
    this.store = store;
    this.lock = lock;
  }

  /**
   * Ojo: el contexto de reentrancia se hereda por flujo asíncrono. Trabajo lanzado dentro de
   * `fn` SIN esperarlo y que corra después de liberar el lock se vería como "ya tomado" y se
   * saltaría la exclusión. `fn` debe esperar todo lo que lance (como hace `conSesion`).
   */
  async withSession(certHash, fn) {
    const tomados = this._tomados.getStore();
    if (tomados && tomados.has(certHash)) return fn();

    return this.lock.withLock(certHash, () => {
      const ahora = new Set(tomados || []);
      ahora.add(certHash);
      return this._tomados.run(ahora, fn);
    });
  }
}

module.exports = {
  MemorySessionLock,
  MemorySessionStore,
  SessionBroker,
  MemoryStateStore,
  FileStateStore,
  validarStateStore,
};
