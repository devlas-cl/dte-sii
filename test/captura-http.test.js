// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Captura HTTP del SII (`utils/httpDebug.js`) y archivo de envíos (`saveEnvioArtifacts`).
 *
 * Lo que se garantiza, sin red ni SII:
 *  1. Sin configurar nada, los nombres de archivo y el índice son los de siempre (más dos campos
 *     nuevos en cada línea del índice: `fallo` y `proceso`).
 *  2. El índice marca como `fallo` las llamadas con estado 400 o superior y las que no tienen estado
 *     (error de red), y no marca las 2xx y 3xx.
 *  3. Con `SII_HTTP_DEBUG_PREFIJO`, dos procesos que reinician el contador `NNN` en el mismo
 *     directorio NO se sobrescriben los archivos.
 *  4. El prefijo se sanea: no deja salir del directorio ni meter separadores de ruta.
 *  5. `SII_ARCHIVAR_ENVIOS=0` evita escribir `historicos/` y la copia de depuración; sin definirla
 *     se archiva igual que antes.
 *
 * Se ejecuta con `node test/captura-http.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-captura-'));
process.env.DATADIR = path.join(tmp, 'data');
delete process.env.SII_HTTP_DEBUG_PREFIJO;
delete process.env.SII_ARCHIVAR_ENVIOS;

const httpDebug = require('../utils/httpDebug');
const { saveEnvioArtifacts } = require('../utils/xml');

const leerIndice = (dir) => fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const archivos = (dir) => fs.readdirSync(dir).filter((f) => f !== 'index.jsonl').sort();

// ── 1 y 2. Nombres por defecto e índice con `fallo` y `proceso` ───────────────────────────────
{
  const dir = path.join(tmp, 'http-1');
  process.env.SII_HTTP_DEBUG_DIR = dir;
  httpDebug.registrarHttpDebug({ url: 'https://sii.example/cgi/Recurso.cgi', method: 'post', status: 200, body: 'ok' });
  httpDebug.registrarHttpDebug({ url: 'https://sii.example/cgi/Recurso.cgi', method: 'get', status: 302, body: '' });
  httpDebug.registrarHttpDebug({ url: 'https://sii.example/cgi/Recurso.cgi', method: 'get', status: 500, body: 'error' });
  httpDebug.registrarHttpDebug({ url: 'https://sii.example/cgi/Recurso.cgi', method: 'get', status: 0, body: '' });

  const nombres = archivos(dir);
  assert.ok(/^\d{3}-POST-Recurso\.cgi-200\.html$/.test(nombres[0]), `nombre por defecto sin prefijo: ${nombres[0]}`);
  const idx = leerIndice(dir);
  assert.deepStrictEqual(idx.map((l) => l.fallo), [false, false, true, true], '200 y 302 no son fallo; 500 y sin estado sí');
  for (const l of idx) {
    assert.strictEqual(l.proceso, httpDebug.ID_PROCESO, 'cada línea del índice lleva el id del proceso');
    for (const campo of ['n', 'ts', 'method', 'url', 'status', 'ms', 'bytes', 'archivo']) assert.ok(campo in l, `se conserva el campo ${campo}`);
  }
  assert.strictEqual(httpDebug.esFallo(399), false);
  assert.strictEqual(httpDebug.esFallo(400), true);
  assert.strictEqual(httpDebug.esFallo(undefined), true);
  console.log('✓ 1-2. nombres por defecto, e índice con `fallo` y `proceso`');
}

// ── 3. Dos arranques en el mismo directorio no se sobrescriben con prefijo ────────────────────
{
  const dir = path.join(tmp, 'http-2');
  process.env.SII_HTTP_DEBUG_DIR = dir;
  const llamada = () => httpDebug.registrarHttpDebug({ url: 'https://sii.example/a/Pagina.html', method: 'get', status: 200, body: 'x' });

  // Sin prefijo: el segundo "arranque" (contador reiniciado) pisa el archivo del primero. Es el problema.
  llamada();
  const antes = archivos(dir).length;
  httpDebug._reiniciarContadoresParaTest();
  llamada();
  assert.strictEqual(archivos(dir).length, antes, 'sin prefijo, el segundo arranque reutiliza el mismo nombre (se sobrescribe)');

  // Con prefijo distinto por proceso: dos archivos.
  process.env.SII_HTTP_DEBUG_PREFIJO = 'replica-a';
  httpDebug._reiniciarContadoresParaTest();
  llamada();
  process.env.SII_HTTP_DEBUG_PREFIJO = 'replica-b';
  httpDebug._reiniciarContadoresParaTest();
  llamada();
  const nombres = archivos(dir);
  assert.ok(nombres.some((f) => f.startsWith('replica-a-001-')), 'archivo de la réplica A');
  assert.ok(nombres.some((f) => f.startsWith('replica-b-001-')), 'archivo de la réplica B');
  assert.strictEqual(nombres.length, antes + 2, 'con prefijo distinto no hay sobrescritura');
  console.log('✓ 3. con prefijo, dos arranques o réplicas no se sobrescriben');
}

// ── 4. El prefijo se sanea ────────────────────────────────────────────────────────────────────
{
  const dir = path.join(tmp, 'http-3');
  process.env.SII_HTTP_DEBUG_DIR = dir;
  process.env.SII_HTTP_DEBUG_PREFIJO = '../../etc/pa sswd/x';
  httpDebug._reiniciarContadoresParaTest();
  httpDebug.registrarHttpDebug({ url: 'https://sii.example/a/P.html', method: 'get', status: 200, body: 'x' });
  const nombres = archivos(dir);
  assert.strictEqual(nombres.length, 1);
  assert.ok(!nombres[0].includes('/'), `el prefijo no mete separadores: ${nombres[0]}`);
  assert.ok(fs.existsSync(path.join(dir, nombres[0])), 'el archivo quedó dentro del directorio de captura');
  assert.ok(!fs.existsSync(path.join(tmp, 'etc')), 'no se creó nada fuera del directorio de captura');
  delete process.env.SII_HTTP_DEBUG_PREFIJO;
  console.log('✓ 4. el prefijo se sanea (no sale del directorio)');
}

// ── 5. saveEnvioArtifacts y la opción para no archivar ────────────────────────────────────────
{
  const xml = `<EnvioDTE><SetDTE ID="SetDoc"><Caratula><RutEmisor>77111222-3</RutEmisor><RutEnvia>77111222-3</RutEnvia></Caratula>` +
    `<DTE><Documento><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>10</Folio><FchEmis>2026-01-15</FchEmis></IdDoc></Encabezado></Documento></DTE></SetDTE></EnvioDTE>`;
  const baseDir = path.join(tmp, 'archivo-1');
  saveEnvioArtifacts({ xml, responseText: '<r/>', responseOk: true, responseStatus: 200, trackId: '123456', ambiente: 'certificacion', tipoEnvio: 'EnvioDTE', baseDir });
  assert.ok(fs.existsSync(path.join(baseDir, 'historicos')), 'por defecto se archiva en historicos/');
  assert.ok(fs.existsSync(path.join(baseDir, 'debug')), 'por defecto se escribe la copia de depuración');

  for (const valor of ['0', 'false', 'OFF']) {
    process.env.SII_ARCHIVAR_ENVIOS = valor;
    const dir = path.join(tmp, `archivo-off-${valor}`);
    saveEnvioArtifacts({ xml, responseText: '<r/>', responseOk: true, responseStatus: 200, trackId: '123456', ambiente: 'certificacion', tipoEnvio: 'EnvioDTE', baseDir: dir });
    assert.ok(!fs.existsSync(dir), `con SII_ARCHIVAR_ENVIOS=${valor} no se escribe nada`);
  }
  process.env.SII_ARCHIVAR_ENVIOS = '1';
  const dir1 = path.join(tmp, 'archivo-on-1');
  saveEnvioArtifacts({ xml, trackId: '123456', ambiente: 'certificacion', tipoEnvio: 'EnvioDTE', baseDir: dir1 });
  assert.ok(fs.existsSync(path.join(dir1, 'historicos')), 'con SII_ARCHIVAR_ENVIOS=1 sí se archiva');
  delete process.env.SII_ARCHIVAR_ENVIOS;
  console.log('✓ 5. SII_ARCHIVAR_ENVIOS=0 evita archivar; por defecto se archiva');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\ncaptura-http OK');
