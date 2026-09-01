#!/usr/bin/env node
// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Barrido de datos reales antes de pushear.
 *
 * Este repositorio es PUBLICO (ver CLAUDE.md). Un RUT real, un certificado o una
 * ruta local que llegue a un commit queda en el historial y en los forks:
 * limpiar el archivo despues no limpia nada. Por eso esta revision va ANTES del
 * push, no despues.
 *
 * Corre igual en local y en CI. Sale con codigo 1 si encuentra algo.
 *
 *   npm run scan
 *   node scripts/scan-datos-reales.js
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Valores permitidos.
//
// Agregar aca es una decision consciente, no un tramite: si un valor nuevo
// aparece en el barrido, la pregunta es de quien es antes de silenciarlo.
// ─────────────────────────────────────────────────────────────────────────────
const RUTS_PERMITIDOS = new Set([
  // RUTs sinteticos de ejemplo, formato valido y sin dueno real
  '76543210-K', '77111222-3', '79555666-7', '79888999-0', '76123456-7',
  '12345678-9', '12345678-K', '11111111-1', '22222222-2',
  '9876543-2', '7654321-6',
  // '76543210-3': mismo cuerpo que el primero de la lista, con el digito verificador
  // REAL (calculado por modulo 11). Se agrega sin sacar el otro porque ya esta citado
  // en CLAUDE.md y textos externos; usar este para cualquier ejemplo que necesite pasar
  // una validacion real de RUT.
  '76543210-3',
  // Formas rellenadas con ceros de los anteriores. Son fixtures de
  // test/rut.test.js, que prueba justamente que el relleno se quita, asi que
  // tienen que poder escribirse literales.
  '07654321-6', '00000010-0', '00000010-K', '00000000-0',
  // El RUT del propio SII
  '60803000-K',
  // RUT generico de consumidor final en boletas. No es un ejemplo: es un valor
  // del dominio, el que lleva una boleta sin receptor identificado. Vive en
  // utils/constants.js como RUT_CONSUMIDOR_FINAL y es el default de DTE.js.
  '66666666-6',
  // IDs de caso de los sets de certificacion: coinciden con el patron de RUT
  // sin serlo. El SII los numera "CASO 4668070-1".
  '4668070-1', '4670590-1',
]);

// Archivos que hablan DE estos patrones y por eso los contienen legitimamente.
const ES_DOC_META = (f) =>
  f === 'CLAUDE.md' ||
  f === 'CONTRIBUTING.md' ||
  f === 'scripts/scan-datos-reales.js' ||
  f.startsWith('.github/') ||
  f.startsWith('.claude/skills/');

const RE_RUT = /\b\d{7,8}-[0-9kK]\b/g;
const RE_RUTA_LOCAL = /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|C:\\Users\\)/;

/**
 * Archivos que podrian terminar en un commit: los ya versionados MAS los nuevos
 * que no esten ignorados por .gitignore.
 *
 * `--others --exclude-standard` es lo que hace la diferencia. Sin eso solo se ven
 * los archivos ya rastreados, y un archivo nuevo con un RUT real pasaria el
 * barrido justamente en el momento en que mas importa: antes del primer commit.
 */
function archivosCandidatos(...globs) {
  try {
    const salida = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', ...globs],
      { cwd: RAIZ, encoding: 'utf8' },
    );
    return [...new Set(salida.split('\n').filter(Boolean))];
  } catch {
    return [];
  }
}

function lineas(archivo) {
  try {
    return fs.readFileSync(path.join(RAIZ, archivo), 'utf8').split('\n');
  } catch {
    return [];
  }
}

const problemas = [];

// ── 1. RUTs fuera de la lista de permitidos ──────────────────────────────────
function revisarRuts(archivos) {
  const hallazgos = [];
  for (const archivo of archivos) {
    if (ES_DOC_META(archivo)) continue;
    lineas(archivo).forEach((linea, i) => {
      for (const encontrado of linea.match(RE_RUT) || []) {
        if (!RUTS_PERMITIDOS.has(encontrado.toUpperCase())) {
          hallazgos.push(`${archivo}:${i + 1}  ->  ${encontrado}`);
        }
      }
    });
  }
  return hallazgos;
}

// ── 2. Rutas locales de una maquina ──────────────────────────────────────────
function revisarRutasLocales(archivos) {
  const hallazgos = [];
  for (const archivo of archivos) {
    if (ES_DOC_META(archivo)) continue;
    lineas(archivo).forEach((linea, i) => {
      const m = linea.match(RE_RUTA_LOCAL);
      if (m) hallazgos.push(`${archivo}:${i + 1}  ->  ${m[0]}`);
    });
  }
  return hallazgos;
}

// ── 3. Certificados, llaves y entornos versionados ───────────────────────────
function revisarSecretos() {
  return archivosCandidatos(
    '*.pfx', '*.p12', '*.pem', '*.key', '*.crt', '.env', '.env.*', '*.har',
  );
}

function reportar(titulo, hallazgos, ayuda) {
  if (hallazgos.length === 0) {
    console.log(`  ok  ${titulo}`);
    return;
  }
  console.log(`  FALLA  ${titulo}`);
  for (const h of hallazgos) console.log(`         ${h}`);
  console.log(`         ${ayuda}`);
  problemas.push(titulo);
}

const archivos = archivosCandidatos('*.js', '*.md', '*.json', '*.ts', '*.yml', '*.yaml');

console.log(`Barrido de datos reales sobre ${archivos.length} archivos (versionados y nuevos sin ignorar)\n`);

reportar(
  'RUTs fuera de la lista de permitidos',
  revisarRuts(archivos),
  'Si es inventado, agregalo a RUTS_PERMITIDOS en este script.',
);
reportar(
  'Rutas locales de una maquina',
  revisarRutasLocales(archivos),
  'Usar rutas relativas o genericas.',
);
reportar(
  'Certificados, llaves y entornos versionados',
  revisarSecretos(),
  'Estos archivos no pueden estar versionados. Ver .gitignore.',
);

console.log();

if (problemas.length > 0) {
  console.error(`FALLA: ${problemas.length} comprobacion(es) con hallazgos.`);
  console.error('Limpiar el archivo no limpia el historial: la revision va antes del push.');
  process.exit(1);
}

console.log('Limpio.');
