/**
 * Cache de sesiones de `SiiPortalAuth`.
 *
 * Lo que protege este archivo es que **un certificado no pise la sesión de otro**. El formato
 * viejo guardaba una sola sesión y comparaba `certHash`: con N comercios, cada uno invalidaba
 * la sesión del anterior y todos re-autenticaban en cada pasada. Un login contra `zeusr.sii.cl`
 * es caro y contado por el SII, que bloquea por "máximo de sesiones autenticadas".
 *
 * Sin red: solo toca disco, en un DATADIR temporal.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DATADIR tiene que estar seteado ANTES de requerir el módulo: la ruta del cache se
// resuelve una sola vez, al cargar.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-cache-'));
process.env.DATADIR = DIR;
const SiiPortalAuth = require('../SiiPortalAuth');
const RUTA = path.join(DIR, 'sii_session_cache.json');

function leer() {
  return JSON.parse(fs.readFileSync(RUTA, 'utf8'));
}

async function main() {
  // ── Dos certificados distintos conviven ────────────────────────────────────
  {
    SiiPortalAuth.limpiarSesionCache();
    SiiPortalAuth._guardarSesionCache('aaa111', { TOKEN: 'a', S2: 'x' });
    SiiPortalAuth._guardarSesionCache('bbb222', { TOKEN: 'b' });

    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('aaa111'), { TOKEN: 'a', S2: 'x' },
      'guardar el segundo certificado no puede borrar el primero');
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('bbb222'), { TOKEN: 'b' });
    assert.strictEqual(SiiPortalAuth._cargarSesionCache('ccc333'), null,
      'un certificado sin sesión devuelve null, no la de otro');
  }

  // ── Formato v1 (una sola sesión) se migra, no se descarta ──────────────────
  {
    SiiPortalAuth.limpiarSesionCache();
    fs.writeFileSync(RUTA, JSON.stringify({ certHash: 'viejo1', ts: Date.now(), cookies: { TOKEN: 'v1' } }));
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('viejo1'), { TOKEN: 'v1' },
      'la sesión v1 vigente tiene que sobrevivir al upgrade');

    SiiPortalAuth._guardarSesionCache('nuevo1', { TOKEN: 'n' });
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('viejo1'), { TOKEN: 'v1' },
      'migrar y luego escribir no puede perder la sesión migrada');
    assert.strictEqual(leer().v, 2, 'el archivo queda en formato v2');
  }

  // ── TTL: una sesión vieja no se devuelve ───────────────────────────────────
  {
    SiiPortalAuth.limpiarSesionCache();
    SiiPortalAuth._guardarSesionCache('viejo2', { TOKEN: 'z' });
    const a = leer();
    a.sesiones['viejo2'].ts = Date.now() - 91 * 60 * 1000;
    fs.writeFileSync(RUTA, JSON.stringify(a));
    assert.strictEqual(SiiPortalAuth._cargarSesionCache('viejo2'), null, 'a los 91 min ya expiró');
  }

  // ── Poda: el archivo no crece sin límite ───────────────────────────────────
  {
    SiiPortalAuth.limpiarSesionCache();
    const a = { v: 2, sesiones: {} };
    for (let i = 0; i < 260; i++) a.sesiones[`c${i}`] = { ts: Date.now() - i * 1000, cookies: { T: i } };
    fs.writeFileSync(RUTA, JSON.stringify(a));
    SiiPortalAuth._guardarSesionCache('reciente', { T: 'r' });

    const n = Object.keys(leer().sesiones).length;
    assert.ok(n <= 200, `quedaron ${n} sesiones, el tope es 200`);
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('reciente'), { T: 'r' },
      'la poda nunca puede sacar la sesión recién guardada');
    assert.strictEqual(SiiPortalAuth._cargarSesionCache('c259'), null,
      'se descarta la más vieja, no una al azar');
  }

  // ── Limpiar uno no arrastra a los demás ────────────────────────────────────
  {
    SiiPortalAuth.limpiarSesionCache();
    SiiPortalAuth._guardarSesionCache('uno', { T: 1 });
    SiiPortalAuth._guardarSesionCache('dos', { T: 2 });
    SiiPortalAuth.limpiarSesionCache('uno');
    assert.strictEqual(SiiPortalAuth._cargarSesionCache('uno'), null);
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('dos'), { T: 2 },
      'limpiar un certificado no puede desloguear a los otros comercios');
  }

  // ── Archivo corrupto no rompe ni borra en silencio ─────────────────────────
  {
    fs.writeFileSync(RUTA, '{esto no es json');
    assert.strictEqual(SiiPortalAuth._cargarSesionCache('x'), null, 'un archivo corrupto devuelve null');
    SiiPortalAuth._guardarSesionCache('recuperado', { T: 'ok' });
    assert.deepStrictEqual(SiiPortalAuth._cargarSesionCache('recuperado'), { T: 'ok' },
      'después de un archivo corrupto el cache vuelve a funcionar');
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('session-cache: 6 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
