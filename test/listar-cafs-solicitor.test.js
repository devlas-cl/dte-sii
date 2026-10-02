/**
 * `FolioService.listarCafs()` encuentra los CAF donde CafSolicitor los guarda.
 *
 * CafSolicitor guarda en `baseDir/debug/caf/<ambiente>/<rut>/<tipo>/<corrida>/`, pero
 * `listarCafs` solo miraba `cafDir` y `debugDir/caf/...`. Con un `debugDir` distinto de
 * `baseDir/debug` (el caso de un consumidor con directorio temporal por etapa) los CAF
 * recién timbrados no se veían y el reintento volvía a timbrar.
 *
 * Se ejecuta con `node test/listar-cafs-solicitor.test.js`, sin red ni SII.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FolioService = require('../FolioService');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'listar-cafs-'));
const svc = Object.create(FolioService.prototype);
svc.baseDir = base;
svc.cafDir = path.join(base, 'debug', 'auto-caf');
svc.debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listar-cafs-debug-'));
svc.ambiente = 'certificacion';
svc.rutEmisor = '76.543.210-3';

const caf = (rut, td) => `<AUTORIZACION><CAF><DA><RE>${rut}</RE><TD>${td}</TD><RNG><D>1</D><H>3</H></RNG></DA></CAF></AUTORIZACION>`;
const dir = path.join(base, 'debug', 'caf', 'certificacion', '76543210-3', '61', 'corrida-1');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'caf-61-1-3.xml'), caf('76543210-3', 61));
fs.writeFileSync(path.join(dir, 'caf-33-1-3.xml'), caf('76543210-3', 33));

assert.deepStrictEqual(svc.listarCafs(61), [path.join(dir, 'caf-61-1-3.xml')], 've lo que timbró CafSolicitor');
assert.deepStrictEqual(svc.listarCafs(56), [], 'filtra por tipo');

console.log('listar-cafs-solicitor: 2 casos OK');
