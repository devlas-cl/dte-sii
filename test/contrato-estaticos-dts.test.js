// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Lo que el .js ofrece esta declarado en el .d.ts, y lo que el .d.ts promete existe.
 *
 * Tres huecos encontrados el 11/09/2026, ninguno detectable con `npm run types`,
 * que solo valida que el .d.ts sea TypeScript correcto:
 *
 * 1. `CafSolicitor` tenia 9 metodos estaticos publicos (entre ellos
 *    `extraerMotivoBloqueoTimbraje`, agregado en 2.21.0) y el .d.ts no declaraba
 *    ninguno. Un consumidor en TypeScript no los podia llamar sin castear.
 *
 * 2. `WsReclamo` se exporta desde index.js desde mayo de 2026 y no estaba declarada.
 *
 * 3. `CafSolicitarResult.errorCode` era `string`. Ahora es una union cerrada de los
 *    codigos que emite `solicitar()`. Una union cerrada es mejor para el consumidor
 *    solo si no miente: por eso aca se compara contra los literales del .js en las dos
 *    direcciones. Si alguien agrega un codigo sin declararlo, o declara uno que el
 *    codigo ya no emite, falla.
 *
 * No es un tipo que miente como el de reobtencion en 2.19.1 (ver
 * contrato-reobtencion.test.js); es el mismo hueco de fondo visto desde otro lado.
 *
 * Se ejecuta con `node test/contrato-estaticos-dts.test.js`, sin red ni SII.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const dts = fs.readFileSync(path.join(RAIZ, 'dte-sii.d.ts'), 'utf8');
const leer = (archivo) => fs.readFileSync(path.join(RAIZ, archivo), 'utf8');

/** Bloque `export class Nombre { ... }` del .d.ts, o null si la clase no esta declarada. */
function bloqueClase(nombre) {
  const inicio = dts.indexOf(`export class ${nombre} {`);
  if (inicio === -1) return null;
  return dts.slice(inicio, dts.indexOf('\n}\n', inicio));
}

/** Cuerpo de un metodo de clase: desde su firma hasta la llave que lo cierra a 2 espacios. */
function cuerpoMetodo(codigo, firma) {
  const inicio = codigo.indexOf(firma);
  assert.notStrictEqual(inicio, -1, `no encontre \`${firma}\``);
  return codigo.slice(inicio, codigo.indexOf('\n  }\n', inicio));
}

// ── 1. Estaticos publicos de CafSolicitor ────────────────────────────────────
{
  const bloque = bloqueClase('CafSolicitor');
  assert.ok(bloque, 'CafSolicitor no esta declarada en dte-sii.d.ts');

  const estaticos = [...leer('CafSolicitor.js').matchAll(/^\s+static\s+(?:async\s+)?([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)]
    .map((m) => m[1]);
  const faltan = estaticos.filter((n) => !new RegExp(`\\bstatic\\s+${n}\\s*\\(`).test(bloque));
  assert.deepStrictEqual(faltan, [],
    `CafSolicitor define estaticos que el .d.ts no declara: ${faltan.join(', ')}`);
  console.log(`✓ CafSolicitor: los ${estaticos.length} estaticos publicos estan declarados`);
}

// ── 2. Metodos publicos de WsReclamo ─────────────────────────────────────────
{
  const bloque = bloqueClase('WsReclamo');
  assert.ok(bloque, 'WsReclamo se exporta desde index.js y no esta declarada en dte-sii.d.ts');

  const publicos = [...leer('WsReclamo.js').matchAll(/^  (?:async\s+)?([a-zA-Z][a-zA-Z0-9]*)\s*\([^)]*\)\s*\{/gm)]
    .map((m) => m[1])
    .filter((n) => n !== 'constructor');
  const faltan = publicos.filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(bloque));
  assert.deepStrictEqual(faltan, [],
    `WsReclamo define metodos publicos que el .d.ts no declara: ${faltan.join(', ')}`);
  console.log(`✓ WsReclamo: los ${publicos.length} metodos publicos estan declarados`);
}

// ── 3. errorCode de solicitar(): union cerrada, en las dos direcciones ──────
{
  const cuerpo = cuerpoMetodo(leer('CafSolicitor.js'), '  async solicitar(');
  const emitidos = new Set([...cuerpo.matchAll(/errorCode:\s*'([A-Z_]+)'/g)].map((m) => m[1]));
  assert.ok(!/errorCode:\s*[^'\s]/.test(cuerpo),
    'solicitar() arma un errorCode que no es literal: la union cerrada no lo puede verificar');

  const inicio = dts.indexOf('export type CafSolicitarErrorCode =');
  assert.notStrictEqual(inicio, -1, 'falta `export type CafSolicitarErrorCode` en el .d.ts');
  const declarados = new Set([...dts.slice(inicio, dts.indexOf(';', inicio)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));

  const sinDeclarar = [...emitidos].filter((c) => !declarados.has(c));
  const inventados = [...declarados].filter((c) => !emitidos.has(c));
  assert.deepStrictEqual(sinDeclarar, [], `solicitar() emite codigos que el .d.ts no declara: ${sinDeclarar.join(', ')}`);
  assert.deepStrictEqual(inventados, [], `el .d.ts declara codigos que solicitar() ya no emite: ${inventados.join(', ')}`);

  assert.ok(/errorCode\?:\s*CafSolicitarErrorCode/.test(bloqueInterfaz('CafSolicitarResult')),
    'CafSolicitarResult.errorCode tiene que usar CafSolicitarErrorCode');
  console.log(`✓ CafSolicitarErrorCode: los ${emitidos.size} codigos coinciden con lo que emite solicitar()`);
}

function bloqueInterfaz(nombre) {
  const inicio = dts.indexOf(`export interface ${nombre} {`);
  assert.notStrictEqual(inicio, -1, `falta la interfaz ${nombre}`);
  return dts.slice(inicio, dts.indexOf('\n}\n', inicio));
}

console.log('\nTodos los checks de contrato del .d.ts pasaron.');
