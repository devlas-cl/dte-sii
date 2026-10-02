// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * artefactos.js
 *
 * Sincroniza los archivos que una etapa de la certificación deja y la siguiente lee (estructuras,
 * resultados, XML de los envíos) entre un ALMACÉN y un directorio de trabajo local.
 *
 * Para qué: la certificación es una cadena de etapas que se pasan archivos por disco. Si cada etapa
 * corre en un proceso o una réplica distinta, o el disco no persiste entre despliegues, esos archivos
 * se pierden. Con esto, antes de cada etapa se HIDRATA un directorio temporal desde el almacén y,
 * al terminar, se VUELCA lo nuevo o cambiado. El runner de la etapa no cambia: sigue leyendo y
 * escribiendo archivos en su directorio.
 *
 * La librería no sabe dónde viven los datos. Define el puerto `ArtefactosStore` y cada consumidor
 * aporta el suyo (una tabla de Postgres, Redis, S3, un directorio compartido). Tampoco sabe qué
 * archivos le importan a cada consumidor: eso lo decide el predicado `aceptar` que se pasa a `volcar`.
 *
 *   ArtefactosStore
 *     listar()                       → Promise<Array<{ clave, mtimeMs, huella }>>
 *     leer(clave)                    → Promise<string | null>
 *     escribir(clave, contenido, m)  → Promise<void>      m = { mtimeMs, huella }
 *     borrar(claves)                 → Promise<void>      (opcional)
 *
 * Una `clave` es una ruta relativa con `/`, sin `..` ni rutas absolutas.
 *
 * Detalles que importan:
 *  - Se preserva la fecha de modificación (`mtime`). Hay consumidores que eligen "la corrida más
 *    reciente" por mtime; si al hidratar todo quedara con la hora de hoy, se perdería el orden.
 *  - Nunca se escribe fuera del directorio de trabajo, aunque el almacén devuelva claves hostiles.
 *  - Solo texto (por defecto `.xml` y `.json`), con un tope por archivo.
 *
 * @module dte-sii/utils/artefactos
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Tope por archivo. Los XML de los sets pesan decenas de KB; esto evita guardar basura enorme. */
const MAX_BYTES_POR_DEFECTO = 4 * 1024 * 1024;
const EXTENSIONES_POR_DEFECTO = ['.xml', '.json'];

/** Huella del contenido, para no volver a guardar lo que no cambió. */
const huellaDe = (contenido) => crypto.createHash('sha1').update(contenido).digest('hex');

/**
 * Valida una clave de artefacto: ruta relativa con `/`, sin vacíos, sin `.` ni `..`, sin rutas
 * absolutas ni barras invertidas. Lanza TypeError si no cumple.
 * @param {string} clave
 * @returns {string[]} los segmentos de la ruta
 */
function segmentosSeguros(clave) {
  if (typeof clave !== 'string' || !clave) throw new TypeError('artefactos: clave vacía');
  if (clave.includes('\\') || clave.includes('\0') || clave.startsWith('/') || /^[A-Za-z]:/.test(clave)) {
    throw new TypeError(`artefactos: clave inválida "${clave}"`);
  }
  const segs = clave.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new TypeError(`artefactos: clave inválida "${clave}"`);
  }
  return segs;
}

/** Valida que un objeto cumpla el puerto ArtefactosStore. */
function validarStore(store, donde = 'ArtefactosStore') {
  if (!store || typeof store.listar !== 'function' || typeof store.leer !== 'function' || typeof store.escribir !== 'function') {
    throw new TypeError(`${donde}: \`store\` debe implementar listar, leer y escribir`);
  }
  return store;
}

/** Recorre un directorio y devuelve las rutas relativas (con `/`) de todos sus archivos. */
function recorrer(dir, base = dir, acc = []) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(abs, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * Escribe en `dir` los artefactos del almacén que acepte `aceptar`, conservando su fecha de
 * modificación (también la de las carpetas: la de una carpeta pasa a ser la del archivo más reciente
 * que contiene, que es lo que habría pasado si la hubiera escrito el runner).
 *
 * @param {Object} p
 * @param {ArtefactosStore} p.store
 * @param {string} p.dir Directorio de trabajo local (se crea si no existe).
 * @param {(clave: string) => boolean} [p.aceptar] Qué claves traer. Por defecto, todas.
 * @param {(clave: string, contenido: string) => string} [p.restaurar] Transforma el contenido antes de
 *   escribirlo (por ejemplo, descifrar).
 * @returns {Promise<Map<string, string>>} clave → huella de lo escrito, para pasárselo a `volcar`.
 */
async function hidratar({ store, dir, aceptar = () => true, restaurar }) {
  validarStore(store, 'hidratar');
  if (!dir) throw new TypeError('hidratar: `dir` es obligatorio');
  fs.mkdirSync(dir, { recursive: true });

  const escritos = new Map();
  const mtimePorDir = new Map();

  for (const meta of await store.listar()) {
    let segs;
    try { segs = segmentosSeguros(meta.clave); } catch { continue; } // clave hostil o dañada: se ignora
    if (!aceptar(meta.clave)) continue;

    let contenido = await store.leer(meta.clave);
    if (contenido == null) continue;
    if (restaurar) contenido = restaurar(meta.clave, contenido);

    const destino = path.join(dir, ...segs);
    // Defensa en profundidad: la ruta resuelta tiene que seguir dentro de `dir`.
    const rel = path.relative(path.resolve(dir), path.resolve(destino));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido, 'utf8');
    const mtimeMs = Number(meta.mtimeMs) || Date.now();
    const t = new Date(mtimeMs);
    fs.utimesSync(destino, t, t);
    escritos.set(meta.clave, meta.huella || huellaDe(typeof contenido === 'string' ? contenido : String(contenido)));

    // Anota la fecha más reciente de cada carpeta ancestro.
    for (let i = segs.length - 1; i >= 1; i--) {
      const carpeta = path.join(dir, ...segs.slice(0, i));
      if (mtimeMs > (mtimePorDir.get(carpeta) ?? 0)) mtimePorDir.set(carpeta, mtimeMs);
    }
  }

  for (const [carpeta, mtimeMs] of mtimePorDir) {
    const t = new Date(mtimeMs);
    try { fs.utimesSync(carpeta, t, t); } catch { /* best-effort */ }
  }
  return escritos;
}

/**
 * Guarda en el almacén los archivos nuevos o cambiados de `dir`.
 *
 * @param {Object} p
 * @param {ArtefactosStore} p.store
 * @param {string} p.dir
 * @param {(clave: string) => boolean} p.aceptar Qué archivos guardar (ruta relativa con `/`). Es
 *   obligatorio: la librería no decide por el consumidor qué vale la pena conservar.
 * @param {Map<string, string>} [p.previos] Lo que devolvió `hidratar`: lo que no cambió no se reescribe.
 * @param {string[]} [p.extensiones] Extensiones permitidas. Por defecto `.xml` y `.json`.
 * @param {number} [p.maxBytes] Tope por archivo. Por defecto 4 MB.
 * @param {(clave: string, contenido: string) => string} [p.transformar] Transforma el contenido antes de
 *   guardarlo (por ejemplo, cifrarlo). La huella se calcula sobre el contenido ORIGINAL.
 * @returns {Promise<{ guardados: number, sinCambios: number, omitidos: Array<{ clave: string, motivo: string }> }>}
 */
async function volcar({ store, dir, aceptar, previos = new Map(), extensiones = EXTENSIONES_POR_DEFECTO, maxBytes = MAX_BYTES_POR_DEFECTO, transformar }) {
  validarStore(store, 'volcar');
  if (!dir) throw new TypeError('volcar: `dir` es obligatorio');
  if (typeof aceptar !== 'function') throw new TypeError('volcar: `aceptar` es obligatorio');
  const exts = extensiones.map((e) => e.toLowerCase());

  let guardados = 0;
  let sinCambios = 0;
  const omitidos = [];

  for (const clave of recorrer(dir)) {
    if (!aceptar(clave)) continue;
    try { segmentosSeguros(clave); } catch { omitidos.push({ clave, motivo: 'clave inválida' }); continue; }
    if (!exts.some((e) => clave.toLowerCase().endsWith(e))) continue;

    const abs = path.join(dir, ...clave.split('/'));
    const st = fs.statSync(abs);
    if (st.size > maxBytes) { omitidos.push({ clave, motivo: `supera ${maxBytes} bytes` }); continue; }

    const contenido = fs.readFileSync(abs, 'utf8');
    const huella = huellaDe(contenido);
    if (previos.get(clave) === huella) { sinCambios++; continue; }

    await store.escribir(clave, transformar ? transformar(clave, contenido) : contenido, { mtimeMs: st.mtimeMs, huella });
    guardados++;
  }
  return { guardados, sinCambios, omitidos };
}

/**
 * Almacén en memoria del proceso. Sirve para tests y como referencia de cómo implementar el puerto.
 * @implements {ArtefactosStore}
 */
class MemoryArtefactosStore {
  constructor() { this._docs = new Map(); }
  async listar() { return [...this._docs].map(([clave, d]) => ({ clave, mtimeMs: d.mtimeMs, huella: d.huella })); }
  async leer(clave) { return this._docs.has(clave) ? this._docs.get(clave).contenido : null; }
  async escribir(clave, contenido, meta = {}) {
    this._docs.set(clave, { contenido, mtimeMs: meta.mtimeMs ?? Date.now(), huella: meta.huella ?? huellaDe(contenido) });
  }
  async borrar(claves) { for (const c of claves) this._docs.delete(c); }
}

module.exports = {
  hidratar,
  volcar,
  huellaDe,
  segmentosSeguros,
  validarStore,
  MemoryArtefactosStore,
  EXTENSIONES_POR_DEFECTO,
  MAX_BYTES_POR_DEFECTO,
};
