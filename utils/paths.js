// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * paths.js — Resolución centralizada de los directorios donde escribe la librería.
 *
 * REGLA DE FRONTERA: esta librería es un paquete público y **no conoce a sus
 * consumidores**. Nunca debe adivinar dónde escribir ni asumir un layout de
 * directorios, un sistema operativo o el nombre de un proyecto que la usa.
 * El directorio siempre lo inyecta quien la consume: por parámetro (preferido)
 * o por variable de entorno.
 *
 * Antes de este módulo convivían cinco convenciones distintas —`process.cwd()`,
 * `__dirname/../..`, rutas relativas, una ruta con el nombre de un repo consumidor
 * y una ruta de `AppData` de Windows— lo que hacía imposible saber dónde iba a
 * quedar un archivo de diagnóstico.
 *
 * @module dte-sii/utils/paths
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Directorio para archivos de diagnóstico (HTML del portal, XML, dumps).
 *
 * Orden de resolución: el que inyecta el consumidor → `SII_DEBUG_DIR` → `null`.
 * Devolver `null` es una respuesta válida y significa **no escribir nada**: el
 * diagnóstico es opcional y jamás debe crear directorios en ubicaciones que el
 * consumidor no eligió.
 *
 * @param {string} [dirInyectado] - Directorio provisto por el consumidor.
 * @returns {string|null} Ruta absoluta, o null si nadie definió dónde escribir.
 */
function resolveDebugDir(dirInyectado) {
  const dir = dirInyectado || process.env.SII_DEBUG_DIR || null;
  return dir ? path.resolve(dir) : null;
}

/**
 * Directorio para datos que deben sobrevivir entre ejecuciones (caché de sesión
 * SII, por ejemplo).
 *
 * A diferencia del debug, acá sí hay un fallback: perder la caché de sesión
 * dispara el error "máximo de sesiones autenticadas" del SII, así que conviene
 * escribir en algún lado antes que en ninguno. El fallback es `os.tmpdir()`,
 * que es neutral respecto del sistema operativo.
 *
 * ⚠️ En un contenedor con filesystem efímero, `DATADIR` debe apuntar a un volumen
 * persistente o la caché se pierde en cada redeploy.
 *
 * @param {string} [dirInyectado] - Directorio provisto por el consumidor.
 * @returns {string} Ruta absoluta (siempre devuelve algo).
 */
function resolveDataDir(dirInyectado) {
  return path.resolve(dirInyectado || process.env.DATADIR || path.join(os.tmpdir(), 'dte-sii'));
}

/**
 * Directorio para **artefactos funcionales**: archivos que la propia librería vuelve
 * a leer después (`estructuras.json`, `session.json`, `periodo-libros.json`, CAFs).
 *
 * Se distingue de `resolveDebugDir` porque acá no se puede devolver `null`: si no
 * hay dónde escribir, el flujo se rompe más adelante al intentar leerlos. Por eso
 * hay fallback, pero neutral (`resolveDataDir`) en vez de las adivinanzas que había
 * antes — `process.cwd()` (depende de desde dónde se lanzó el proceso) y
 * `__dirname/../..` (que en una instalación normal apunta dentro de `node_modules`).
 *
 * @param {string} [dirInyectado] - Directorio provisto por el consumidor.
 * @param {string} [subdir] - Subdirectorio opcional bajo el base resuelto.
 * @returns {string} Ruta absoluta (siempre devuelve algo).
 */
function resolveArtifactDir(dirInyectado, subdir = '') {
  const base = path.resolve(
    dirInyectado || process.env.SII_DEBUG_DIR || path.join(resolveDataDir(), 'debug'),
  );
  return subdir ? path.join(base, subdir) : base;
}

/**
 * Escribe un archivo de diagnóstico. Best-effort: si no hay directorio definido
 * o falla la escritura, no hace nada y **nunca lanza** — el diagnóstico no puede
 * tumbar una operación real contra el SII.
 *
 * @param {string|null} dir - Directorio ya resuelto (ver resolveDebugDir).
 * @param {string} filename - Nombre del archivo.
 * @param {string|Buffer} content - Contenido.
 * @returns {string|null} Ruta escrita, o null si no se escribió.
 */
function saveDebugFile(dir, filename, content) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content ?? '', 'utf-8');
    return filePath;
  } catch (_e) {
    return null;
  }
}

/** Stamp de tiempo apto para nombres de archivo y directorio. Convención ya usada en todo el repo. */
function runStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Normaliza un RUT para usarlo como nombre de directorio: sin puntos, en mayúsculas. */
function rutSlug(rut) {
  return String(rut || 'sin-rut').replace(/\./g, '').trim().toUpperCase();
}

/**
 * Directorio de UNA ejecución, clasificado para poder encontrarlo después.
 *
 *     {base}/{RUT}/{YYYY-MM-DD}/{HH-MM-SS}_{operacion}/
 *
 * Tres niveles con un porqué cada uno:
 *  - **RUT** primero: al depurar siempre se parte de "qué contribuyente".
 *  - **Fecha** después: agrupa el día completo; es el filtro natural cuando el
 *    usuario dice "esto pasó ayer" y hay muchas corridas acumuladas.
 *  - **Hora + operación**: dentro del día, las corridas quedan ordenadas
 *    cronológicamente por nombre y se lee de un vistazo qué hizo cada una
 *    (`14-32-07_generar-sets`) sin tener que abrirlas.
 *
 * Reemplaza cinco layouts distintos que convivían (`debug/auto-caf/{RUT}/{stamp}/{tipo}`,
 * `debug/cert-v2/{rut}/{stamp}`, `debug/caf/{ambiente}/{RUT}/...`, archivos sueltos en
 * la raíz de `debug/cert-v2`, y rutas relativas al cwd).
 *
 * @param {Object} opts
 * @param {string} [opts.baseDir] - Base inyectada por el consumidor.
 * @param {string} opts.rut - RUT del contribuyente.
 * @param {string} opts.operacion - Qué se está ejecutando (ej. 'generar-sets', 'caf-39').
 * @param {Date} [opts.date] - Momento de la corrida (default: ahora).
 * @returns {string} Ruta absoluta del directorio de la corrida.
 */
function resolveRunDir({ baseDir, rut, operacion, date = new Date() }) {
  const iso = date.toISOString();               // 2026-08-11T22:46:35.123Z
  const fecha = iso.slice(0, 10);               // 2026-08-11
  const hora = iso.slice(11, 19).replace(/:/g, '-'); // 22-46-35
  const nombre = operacion ? `${hora}_${operacion}` : hora;
  return path.join(resolveArtifactDir(baseDir), rutSlug(rut), fecha, nombre);
}

module.exports = {
  resolveDebugDir,
  resolveDataDir,
  resolveArtifactDir,
  resolveRunDir,
  saveDebugFile,
  runStamp,
  rutSlug,
};
