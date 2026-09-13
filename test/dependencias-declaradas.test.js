// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Lo que el codigo publicado requiere esta declarado, y lo declarado se usa.
 *
 * Dos defectos reales, uno de cada lado, encontrados el 11/09/2026:
 *
 * 1. `EnviadorSII.js` hacia `require('form-data')` y `form-data` no estaba en
 *    `dependencies`. Llegaba de prestado por `soap` -> `axios` -> `form-data`.
 *    Funcionaba por accidente: sacar `soap` rompia `require('@devlas/dte-sii')`
 *    en todo consumidor, porque `index.js` carga `EnviadorSII.js`.
 *
 * 2. `soap` y `xml-c14n` estaban declaradas y ningun archivo las requeria. La
 *    libreria arma los sobres SOAP a mano y hace su propia canonicalizacion. Se
 *    instalaban en cada consumidor sin proposito (22 paquetes).
 *
 * Las dos cosas pasan desapercibidas en local porque node_modules tiene todo lo
 * transitivo. Solo se ven instalando el paquete en limpio.
 *
 * Se revisan los archivos que se publican (campo `files` de package.json): los
 * .js de la raiz, utils/ y cert/.
 *
 * Se ejecuta con `node test/dependencias-declaradas.test.js`, sin red.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const RAIZ = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const declaradas = new Set(Object.keys(pkg.dependencies || {}));
const nativos = new Set(builtinModules);

function archivosPublicados() {
  const salida = [];
  for (const e of fs.readdirSync(RAIZ, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js')) salida.push(path.join(RAIZ, e.name));
  }
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) salida.push(p);
    }
  })(path.join(RAIZ, 'utils'));
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) salida.push(p);
    }
  })(path.join(RAIZ, 'cert'));
  return salida;
}

/** 'form-data' -> 'form-data', '@xmldom/xmldom/lib/dom' -> '@xmldom/xmldom', 'a/b' -> 'a'. */
function nombrePaquete(especificador) {
  const partes = especificador.split('/');
  return especificador.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0];
}

const requeridas = new Map(); // paquete -> [archivos]
for (const archivo of archivosPublicados()) {
  const codigo = fs.readFileSync(archivo, 'utf8');
  for (const m of codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const esp = m[1];
    if (esp.startsWith('.') || esp.startsWith('/')) continue;
    const nombre = nombrePaquete(esp.replace(/^node:/, ''));
    if (nativos.has(nombre)) continue;
    // El propio paquete: cert/ se referencia a si mismo por nombre en algunos ejemplos.
    if (nombre === pkg.name) continue;
    if (!requeridas.has(nombre)) requeridas.set(nombre, []);
    requeridas.get(nombre).push(path.relative(RAIZ, archivo));
  }
}

// ── 1. Todo lo requerido esta declarado ──────────────────────────────────────
{
  const faltan = [...requeridas.keys()].filter((n) => !declaradas.has(n));
  assert.deepStrictEqual(
    faltan, [],
    'Requeridas y no declaradas en dependencies (funcionan de prestado por otra dependencia): '
      + faltan.map((n) => `${n} (${requeridas.get(n)[0]})`).join(', '),
  );
  console.log(`✓ Las ${requeridas.size} dependencias que el codigo requiere estan declaradas`);
}

// ── 2. Todo lo declarado se usa ──────────────────────────────────────────────
{
  const sobran = [...declaradas].filter((n) => !requeridas.has(n));
  assert.deepStrictEqual(
    sobran, [],
    'Declaradas en dependencies y ningun archivo publicado las requiere: ' + sobran.join(', '),
  );
  console.log(`✓ Las ${declaradas.size} dependencias declaradas se usan en el codigo publicado`);
}

console.log('\nTodos los checks de dependencias pasaron.');
