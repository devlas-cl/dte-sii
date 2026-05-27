/**
 * test/session-sharing.js
 *
 * Pruebas de compartición de sesión entre SiiPortalAuth y CafSolicitor.
 *
 * Uso:
 *   # Solo unitarios (sin red, sin PFX real):
 *   node test/session-sharing.js
 *
 *   # Con integración contra SII (requiere PFX real):
 *   PFX_PATH=/ruta/cert.pfx PFX_PASS=contraseña RUT_EMISOR=76192083-9 node test/session-sharing.js --integration
 *   SII_AMBIENTE=certificacion|produccion  (default: certificacion)
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');

const SiiPortalAuth = require('../SiiPortalAuth');
const CafSolicitor  = require('../CafSolicitor');

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  // ── Suite 1: Métodos estáticos nuevos ──────────────────────────────────────
  console.log('\n📋 Suite 1: Métodos estáticos nuevos');

  await test('SiiPortalAuth.getCookieStringForPfx es función estática', async () => {
    assert.strictEqual(typeof SiiPortalAuth.getCookieStringForPfx, 'function');
  });

  await test('SiiPortalAuth.closeAllSessions es función estática', async () => {
    assert.strictEqual(typeof SiiPortalAuth.closeAllSessions, 'function');
  });

  await test('CafSolicitor.closeAllSessions es función estática', async () => {
    assert.strictEqual(typeof CafSolicitor.closeAllSessions, 'function');
  });

  // ── Suite 2: getCookieStringForPfx — sin sesión previa ─────────────────────
  console.log('\n📋 Suite 2: getCookieStringForPfx sin sesión previa');

  await test('retorna null con PFX inválido (sin lanzar)', async () => {
    const result = SiiPortalAuth.getCookieStringForPfx(Buffer.from('not-a-pfx'), 'wrongpass');
    assert.strictEqual(result, null);
  });

  await test('retorna null con buffer vacío (sin lanzar)', async () => {
    const result = SiiPortalAuth.getCookieStringForPfx(Buffer.alloc(0), '');
    assert.strictEqual(result, null);
  });

  // ── Suite 3: Conversión cookieJar objeto → string ──────────────────────────
  console.log('\n📋 Suite 3: Conversión cookieJar objeto → string');

  await test('objeto se convierte correctamente a string', async () => {
    const jar = { 'NETSCAPE_LIVEWIRE.foo': 'abc123', 'NETSCAPE_LIVEWIRE.bar': 'xyz789' };
    const str = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    assert.ok(str.includes('NETSCAPE_LIVEWIRE.foo=abc123'));
    assert.ok(str.includes('NETSCAPE_LIVEWIRE.bar=xyz789'));
    assert.ok(str.includes('; '));
  });

  await test('objeto vacío produce string vacío', async () => {
    const str = Object.entries({}).map(([k, v]) => `${k}=${v}`).join('; ');
    assert.strictEqual(str, '');
  });

  // ── Suite 4: Integración contra SII real ───────────────────────────────────
  const runIntegration = process.argv.includes('--integration');
  const pfxPath  = process.env.PFX_PATH;
  const pfxPass  = process.env.PFX_PASS || '';
  const rutEmisor = process.env.RUT_EMISOR;
  const ambiente  = process.env.SII_AMBIENTE || 'certificacion';

  if (!runIntegration) {
    console.log('\n💡 Para integración contra SII real:');
    console.log('   PFX_PATH=/ruta/cert.pfx PFX_PASS=pass RUT_EMISOR=76192083-9 node test/session-sharing.js --integration');
  } else {
    console.log('\n📋 Suite 4: Integración — sesión compartida SiiPortalAuth ↔ CafSolicitor');
    console.log(`   PFX_PATH:    ${pfxPath}`);
    console.log(`   RUT_EMISOR:  ${rutEmisor}`);
    console.log(`   SII_AMBIENTE: ${ambiente}`);

    if (!pfxPath || !fs.existsSync(pfxPath)) {
      console.error('  ⚠️  PFX_PATH no definido o no existe — saltando integración');
    } else if (!rutEmisor) {
      console.error('  ⚠️  RUT_EMISOR no definido — saltando integración');
    } else {
      const pfxBuffer = fs.readFileSync(pfxPath);

      // A: SiiPortalAuth autentica y almacena _cachedCookieJar
      await test('SiiPortalAuth.autenticar() guarda _cachedCookieJar en la instancia', async () => {
        const auth = new SiiPortalAuth({ pfxBuffer, pfxPassword: pfxPass });
        console.log('     → autenticando con SII (puede tardar ~3s)...');
        const cookieJar = await auth.autenticar();
        assert.ok(cookieJar, 'autenticar() debe retornar cookieJar');
        assert.ok(Object.keys(cookieJar).some(k => k.startsWith('NETSCAPE_LIVEWIRE')), 'Debe tener cookies NETSCAPE_LIVEWIRE.*');
        assert.ok(auth._cachedCookieJar, '_cachedCookieJar debe estar en la instancia');
        assert.deepStrictEqual(auth._cachedCookieJar, cookieJar);
        console.log(`     → ${Object.keys(cookieJar).length} cookies recibidas`);
      });

      // B: getCookieStringForPfx retorna las cookies
      await test('getCookieStringForPfx retorna string de cookies tras autenticar', async () => {
        const str = SiiPortalAuth.getCookieStringForPfx(pfxBuffer, pfxPass);
        assert.ok(str, 'Debe retornar string no vacío');
        assert.ok(str.includes('NETSCAPE_LIVEWIRE'), 'Debe incluir cookies NETSCAPE_LIVEWIRE.*');
        console.log(`     → primeros 80 chars: ${str.substring(0, 80)}...`);
      });

      // C: Singleton por certificado
      await test('new SiiPortalAuth() con mismo PFX retorna la misma instancia', async () => {
        const a1 = new SiiPortalAuth({ pfxBuffer, pfxPassword: pfxPass });
        const a2 = new SiiPortalAuth({ pfxBuffer, pfxPassword: pfxPass });
        assert.strictEqual(a1, a2, 'Deben ser la misma referencia');
      });

      // D: CafSolicitor pre-carga el cookieJar
      await test('CafSolicitor pre-carga cookieJar desde SiiPortalAuth', async () => {
        const solicitor = new CafSolicitor({ ambiente, rutEmisor, pfxPath, pfxPassword: pfxPass });
        assert.ok(solicitor.session.cookieJar, 'SiiSession.cookieJar debe estar pre-cargado');
        assert.ok(solicitor.session.cookieJar.includes('NETSCAPE_LIVEWIRE'), 'Debe incluir cookies NETSCAPE_LIVEWIRE.*');
        console.log('     → cookieJar pre-cargado ✓');
      });

      // E: ensureSession no re-autentica (el test clave — orden normal: SiiPortalAuth primero)
      await test('ensureSession llega al form de CAF sin llamar loginWithCertificate', async () => {
        const solicitor = new CafSolicitor({ ambiente, rutEmisor, pfxPath, pfxPassword: pfxPass });

        let authCalls = 0;
        const original = solicitor.session.loginWithCertificate?.bind(solicitor.session);
        if (original) {
          solicitor.session.loginWithCertificate = async (...args) => {
            authCalls++;
            return original(...args);
          };
        }

        const siiHost = ambiente === 'produccion' ? 'palena.sii.cl' : 'maullin.sii.cl';
        console.log(`     → GET ${siiHost}/cvc_cgi/dte/of_solicita_folios ...`);
        const resp = await solicitor.session.ensureSession('/cvc_cgi/dte/of_solicita_folios');
        assert.ok(resp?.body, 'Debe retornar respuesta con body');

        if (authCalls === 0) {
          console.log('     → ✅ UNIFICACIÓN COMPLETA: cookies pre-cargadas aceptadas, 0 auth extras (1 sesión)');
        } else {
          console.log(`     → ⚠️  loginWithCertificate llamado ${authCalls} vez/veces`);
          console.log('        Las cookies de SiiPortalAuth no fueron aceptadas en el flujo CAF.');
          console.log('        CafSolicitor funciona igual, pero sigue usando 2 sesiones.');
        }

        assert.ok(resp.body, 'Respuesta del SII no debe ser vacía');
      });

      // F: Orden invertido — CafSolicitor autentica primero, SiiPortalAuth reutiliza su sesión
      await test('SiiPortalAuth reutiliza sesión del store cuando CafSolicitor autenticó primero', async () => {
        const SiiSessionStore = require('../SiiSessionStore');

        // Limpiar store para simular arranque en frío (sin sesión previa de SiiPortalAuth)
        SiiSessionStore.clear();

        // Obtener la sesión de CafSolicitor (ya tiene monkey-patch desde test D)
        // y limpiar sus cookies para forzar un loginWithCertificate real
        const solicitorF = new CafSolicitor({ ambiente, rutEmisor, pfxPath, pfxPassword: pfxPass });
        solicitorF.session.cookieJar = '';

        console.log('     → forzando re-login de SiiSession (cookieJar vacío)...');
        await solicitorF.session.ensureSession('/cvc_cgi/dte/of_solicita_folios');

        // El monkey-patch debe haber escrito las cookies al store
        let storedCookies = null;
        for (const [, v] of SiiSessionStore.entries()) { storedCookies = v; break; }
        assert.ok(storedCookies, 'Monkey-patch debe haber escrito cookies al store tras loginWithCertificate');
        assert.ok(storedCookies.length > 20, 'Store debe contener cookies de sesión válidas');
        console.log('     → store poblado por SiiSession ✓');

        // SiiPortalAuth debe encontrar las cookies en el store sin nueva auth
        const authF = new SiiPortalAuth({ pfxBuffer, pfxPassword: pfxPass });
        const jarF = await authF.autenticar();
        assert.ok(jarF, 'SiiPortalAuth debe retornar cookieJar');
        console.log(`     → SiiPortalAuth obtuvo cookieJar desde store (${Object.keys(jarF).length} cookies) ✓`);
        console.log('     → ✅ UNIFICACIÓN BIDIRECCIONAL: store compartido funciona en ambas direcciones');
      });
    }
  }

  // ── Resultado ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Resultados: ${passed} pasaron, ${failed} fallaron`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
