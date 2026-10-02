// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Sincronización de artefactos de certificación entre un almacén y un directorio local
 * (`utils/artefactos.js`).
 *
 * Lo que se garantiza, sin red ni SII:
 *  1. Ida y vuelta: lo que una "etapa" vuelca, otra "réplica" con su propio directorio lo recibe.
 *  2. Se preserva la fecha de modificación de archivos Y de carpetas (quien elige "la corrida más
 *     reciente" por mtime no pierde el orden).
 *  3. Lo que no cambió no se vuelve a guardar.
 *  4. Solo se guardan las extensiones permitidas, hasta el tope por archivo, y solo lo que `aceptar`
 *     deja pasar.
 *  5. Un almacén con claves hostiles (`..`, rutas absolutas, barras invertidas) no puede hacer que se
 *     escriba fuera del directorio de trabajo.
 *  6. `transformar` y `restaurar` permiten guardar el contenido cifrado y recuperarlo.
 *  7. El puerto se valida y un almacén en memoria sirve de referencia.
 *
 * Se ejecuta con `node test/artefactos.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hidratar, volcar, segmentosSeguros, validarStore, MemoryArtefactosStore } = require('../utils/artefactos');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-artefactos-'));
const escribir = (dir, rel, contenido, fecha) => {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contenido, 'utf8');
  if (fecha) fs.utimesSync(abs, fecha, fecha);
};

(async () => {
  // ── 1 y 2. Ida y vuelta preservando fechas ─────────────────────────────────
  {
    const store = new MemoryArtefactosStore();
    const etapa1 = path.join(tmp, 'etapa1');
    const vieja = new Date('2026-08-13T10:00:00Z');
    const nueva = new Date('2026-08-24T15:30:00Z');
    escribir(etapa1, 'estable/estructuras.json', '{"a":1}', nueva);
    escribir(etapa1, 'corridas/2026-08-13/10-00-00_enviar-sets/sets-prueba/dtes/envio-set-basico.xml', '<EnvioDTE>viejo</EnvioDTE>', vieja);
    escribir(etapa1, 'corridas/2026-08-24/15-30-00_simulacion/envio-simulacion.xml', '<EnvioDTE>nuevo</EnvioDTE>', nueva);

    const r = await volcar({ store, dir: etapa1, aceptar: () => true });
    assert.strictEqual(r.guardados, 3);

    const etapa2 = path.join(tmp, 'etapa2'); // otra réplica, otro directorio
    const previos = await hidratar({ store, dir: etapa2 });
    assert.strictEqual(previos.size, 3);
    assert.strictEqual(fs.readFileSync(path.join(etapa2, 'estable/estructuras.json'), 'utf8'), '{"a":1}');

    const mt = (rel) => fs.statSync(path.join(etapa2, ...rel.split('/'))).mtimeMs;
    assert.strictEqual(Math.round(mt('estable/estructuras.json')), nueva.getTime(), 'archivo con su fecha original');
    assert.strictEqual(Math.round(mt('corridas/2026-08-13/10-00-00_enviar-sets/sets-prueba/dtes/envio-set-basico.xml')), vieja.getTime());
    // las carpetas toman la fecha del archivo más reciente que contienen
    assert.strictEqual(Math.round(mt('corridas/2026-08-13/10-00-00_enviar-sets')), vieja.getTime(), 'carpeta vieja sigue siendo vieja');
    assert.strictEqual(Math.round(mt('corridas/2026-08-24/15-30-00_simulacion')), nueva.getTime());
    assert.ok(mt('corridas/2026-08-24/15-30-00_simulacion') > mt('corridas/2026-08-13/10-00-00_enviar-sets'),
      'el orden por fecha entre corridas se conserva');
    console.log('✓ 1-2. ida y vuelta entre directorios distintos, con fechas de archivos y carpetas');

    // ── 3. Lo que no cambió no se reescribe ──────────────────────────────────
    escribir(etapa2, 'estable/resultados.json', '{"nuevo":true}');
    const r2 = await volcar({ store, dir: etapa2, aceptar: () => true, previos });
    assert.strictEqual(r2.guardados, 1, 'solo el archivo nuevo');
    assert.strictEqual(r2.sinCambios, 3);
    escribir(etapa2, 'estable/estructuras.json', '{"a":2}');
    const r3 = await volcar({ store, dir: etapa2, aceptar: () => true, previos });
    assert.strictEqual(r3.guardados, 2, 'el modificado y el nuevo que no estaba en previos');
    assert.strictEqual(await store.leer('estable/estructuras.json'), '{"a":2}');
    console.log('✓ 3. lo que no cambió no se reescribe');
  }

  // ── 4. Extensiones, tope y predicado ───────────────────────────────────────
  {
    const store = new MemoryArtefactosStore();
    const dir = path.join(tmp, 'filtros');
    escribir(dir, 'a.xml', '<a/>');
    escribir(dir, 'b.json', '{}');
    escribir(dir, 'c.html', '<html/>');
    escribir(dir, 'd.pdf', 'binario');
    escribir(dir, 'http/e.xml', '<capturado/>');
    escribir(dir, 'grande.xml', 'x'.repeat(2000));
    const r = await volcar({ store, dir, aceptar: (c) => !c.startsWith('http/'), maxBytes: 1000 });
    const claves = (await store.listar()).map((m) => m.clave).sort();
    assert.deepStrictEqual(claves, ['a.xml', 'b.json'], 'solo .xml/.json, sin lo que el predicado rechaza');
    assert.deepStrictEqual(r.omitidos.map((o) => o.clave), ['grande.xml'], 'el que supera el tope se informa');

    const r2 = await volcar({ store, dir, aceptar: () => true, extensiones: ['.html'], maxBytes: 1000 });
    assert.ok((await store.listar()).some((m) => m.clave === 'c.html'), 'las extensiones son configurables');
    assert.strictEqual(r2.guardados, 1);
    await assert.rejects(volcar({ store, dir }), /aceptar|obligatorio/, 'sin predicado no se vuelca nada por defecto');
    console.log('✓ 4. extensiones, tope por archivo y predicado');
  }

  // ── 5. Claves hostiles ─────────────────────────────────────────────────────
  {
    const store = new MemoryArtefactosStore();
    for (const clave of ['../fuera.xml', 'a/../../fuera.xml', '/abs/fuera.xml', 'a\\..\\fuera.xml', 'C:/fuera.xml', 'a//b.xml', './x.xml', 'vacio/']) {
      await store.escribir(clave, '<hostil/>');
    }
    await store.escribir('ok/bueno.xml', '<ok/>');
    const dir = path.join(tmp, 'hostil', 'trabajo');
    await hidratar({ store, dir });
    assert.ok(fs.existsSync(path.join(dir, 'ok/bueno.xml')), 'la clave válida sí se escribe');
    assert.ok(!fs.existsSync(path.join(tmp, 'hostil', 'fuera.xml')), 'nada fuera del directorio de trabajo');
    assert.ok(!fs.existsSync(path.join(tmp, 'fuera.xml')));
    assert.deepStrictEqual(fs.readdirSync(dir), ['ok'], 'solo la clave válida dejó rastro');
    for (const mala of ['', '..', 'a/../b', '/a', 'a\\b', 'a//b', 'a\0b']) assert.throws(() => segmentosSeguros(mala), TypeError, `rechaza "${mala}"`);
    assert.deepStrictEqual(segmentosSeguros('a/b/c.xml'), ['a', 'b', 'c.xml']);
    console.log('✓ 5. claves hostiles no escriben fuera del directorio');
  }

  // ── 6. transformar y restaurar (cifrado) ───────────────────────────────────
  {
    const store = new MemoryArtefactosStore();
    const dir = path.join(tmp, 'cifrado');
    escribir(dir, 'session.json', '{"cookie":"secreto"}');
    escribir(dir, 'publico.json', '{"x":1}');
    const cifrar = (clave, c) => (clave === 'session.json' ? `ENC:${Buffer.from(c).toString('base64')}` : c);
    const descifrar = (clave, c) => (clave === 'session.json' ? Buffer.from(c.slice(4), 'base64').toString() : c);
    await volcar({ store, dir, aceptar: () => true, transformar: cifrar });
    assert.ok(!(await store.leer('session.json')).includes('secreto'), 'el almacén no ve el contenido en claro');
    assert.strictEqual(await store.leer('publico.json'), '{"x":1}');
    const otro = path.join(tmp, 'cifrado-2');
    await hidratar({ store, dir: otro, restaurar: descifrar });
    assert.strictEqual(fs.readFileSync(path.join(otro, 'session.json'), 'utf8'), '{"cookie":"secreto"}');
    // la huella es del contenido original: re-volcar lo mismo no lo reescribe
    const previos = await hidratar({ store, dir: path.join(tmp, 'cifrado-3'), restaurar: descifrar });
    const r = await volcar({ store, dir: path.join(tmp, 'cifrado-3'), aceptar: () => true, transformar: cifrar, previos });
    assert.strictEqual(r.guardados, 0, 'sin cambios: nada que guardar');
    console.log('✓ 6. transformar/restaurar permiten guardar cifrado');
  }

  // ── 7. Puerto ──────────────────────────────────────────────────────────────
  {
    assert.throws(() => validarStore({}), /listar/);
    assert.throws(() => validarStore(null), TypeError);
    assert.ok(validarStore(new MemoryArtefactosStore()));
    await assert.rejects(hidratar({ store: {}, dir: tmp }), /listar/);
    console.log('✓ 7. el puerto se valida');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nartefactos OK');
})().catch((e) => { console.error(e); process.exit(1); });
