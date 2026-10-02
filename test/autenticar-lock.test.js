// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * `autenticar()` toma el lock del certificado.
 *
 * Problema que cubre: los métodos del portal (`obtenerDetalleDtes`, `obtenerResumenRegistro`, ...)
 * llaman a `this.autenticar()` directamente. Antes, `autenticar()` no tomaba el lock (solo lo
 * tomaban `conSesion` y `SiiSession.ensureSession`), así que con la sesión vacía dos llamadores
 * concurrentes abrían dos sesiones contra el SII. Medido contra el portal con 3 procesos y un store
 * compartido: 3 logins y uno falló.
 *
 * Lo que se garantiza, sin red ni SII (el login se reemplaza por un doble):
 *  1. Con la sesión vacía, N llamadores concurrentes a `autenticar()` hacen UN solo login.
 *  2. Lo mismo entre "réplicas" distintas que comparten store y lock.
 *  3. `conSesion` y `autenticar()` anidados no se bloquean a sí mismos (reentrancia).
 *  4. Si el login falla, el lock se libera y el siguiente llamador reintenta.
 *  5. Certificados distintos no se bloquean entre sí.
 *
 * Se ejecuta con `node test/autenticar-lock.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-autlock-'));
const SiiPortalAuth = require('../SiiPortalAuth');
const { MemorySessionLock, MemorySessionStore } = require('../SiiSessionPorts');
const SiiSessionStore = require('../SiiSessionStore');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lock que simula una exclusión compartida entre varias "réplicas" (por ejemplo Redis o Postgres). */
class LockCompartido {
  constructor(estado) { this.estado = estado; }
  async withLock(key, fn) {
    while (this.estado.tomados.has(key)) await dormir(2);
    this.estado.tomados.add(key);
    try { return await fn(); } finally { this.estado.tomados.delete(key); }
  }
}

let _seq = 0;
/** Instancia con el `autenticar()` real y un login falso que cuenta cuántas veces se ejecuta. */
function authConLoginFalso(certHash, { falla = false, demoraMs = 30 } = {}) {
  const a = Object.create(SiiPortalAuth.prototype);
  a._certHash = certHash || `a${++_seq}`;
  a._cachedCookieJar = null;
  a.logins = 0;
  a._validarSesion = async () => true;
  a._autenticarNuevo = async function () {
    this.logins++;
    await dormir(demoraMs);
    if (falla) throw new Error('login fallido');
    const cookies = { 'NETSCAPE_LIVEWIRE.rutm': '1', TOKEN: `t${this.logins}` };
    await SiiPortalAuth._guardarSesion(this._certHash, cookies);
    return cookies;
  };
  return a;
}

(async () => {
  SiiPortalAuth.restablecerSesion();

  // ── 1. Mismo proceso: 5 llamadores concurrentes, sesión vacía ──────────────
  {
    SiiPortalAuth.configurarSesion({ store: new MemorySessionStore(), lock: new MemorySessionLock() });
    SiiSessionStore.clear();
    const hash = 'mismo-proceso';
    const auths = Array.from({ length: 5 }, () => authConLoginFalso(hash));
    const res = await Promise.all(auths.map((a) => a.autenticar()));
    const total = auths.reduce((n, a) => n + a.logins, 0);
    assert.strictEqual(total, 1, `un solo login con 5 llamadores concurrentes (hubo ${total})`);
    for (const r of res) assert.strictEqual(r.TOKEN, 't1', 'todos reciben la sesión del único login');
    console.log('✓ 1. cinco llamadores concurrentes en un proceso hacen un solo login');
  }

  // ── 2. Réplicas distintas: instancias y caché en memoria separados, store y lock compartidos ──
  {
    const store = new MemorySessionStore();
    const estado = { tomados: new Set() };
    SiiPortalAuth.configurarSesion({ store, lock: new LockCompartido(estado) });
    const hash = 'dos-replicas';
    const a = authConLoginFalso(hash);
    const b = authConLoginFalso(hash);
    const c = authConLoginFalso(hash);
    SiiSessionStore.clear(); // sin caché en memoria: como arrancan dos procesos distintos
    await Promise.all([a.autenticar(), b.autenticar(), c.autenticar()]);
    assert.strictEqual(a.logins + b.logins + c.logins, 1, 'tres "réplicas" con la sesión vacía hacen un solo login');
    console.log('✓ 2. tres réplicas con store y lock compartidos hacen un solo login');
  }

  // ── 3. Reentrancia ─────────────────────────────────────────────────────────
  {
    SiiPortalAuth.configurarSesion({ store: new MemorySessionStore(), lock: new MemorySessionLock() });
    SiiSessionStore.clear();
    const a = authConLoginFalso('reentrante');
    const r = await a.conSesion(async (jar) => {
      const otra = await a.autenticar(); // anidado: no debe bloquearse
      return { jar, otra };
    });
    assert.strictEqual(r.jar.TOKEN, r.otra.TOKEN, 'conSesion y autenticar() anidado devuelven la misma sesión');
    assert.strictEqual(a.logins, 1, 'un solo login con la llamada anidada');
    console.log('✓ 3. conSesion y autenticar() anidados no se bloquean');
  }

  // ── 4. Falla del login: el lock se libera y el siguiente reintenta ─────────
  {
    SiiPortalAuth.configurarSesion({ store: new MemorySessionStore(), lock: new MemorySessionLock() });
    SiiSessionStore.clear();
    const mala = authConLoginFalso('falla', { falla: true });
    await assert.rejects(mala.autenticar(), /login fallido/);
    const buena = authConLoginFalso('falla');
    const r = await Promise.race([buena.autenticar(), dormir(2000).then(() => 'colgado')]);
    assert.notStrictEqual(r, 'colgado', 'tras un login fallido el lock quedó libre');
    assert.strictEqual(buena.logins, 1);
    console.log('✓ 4. un login fallido libera el lock');
  }

  // ── 5. Certificados distintos no se bloquean entre sí ──────────────────────
  {
    SiiPortalAuth.configurarSesion({ store: new MemorySessionStore(), lock: new MemorySessionLock() });
    SiiSessionStore.clear();
    const lenta = authConLoginFalso('cert-lento', { demoraMs: 300 });
    const rapida = authConLoginFalso('cert-rapido', { demoraMs: 10 });
    const t0 = Date.now();
    const p1 = lenta.autenticar();
    await rapida.autenticar();
    const tRapida = Date.now() - t0;
    await p1;
    assert.ok(tRapida < 250, `otro certificado no espera al lento (tardó ${tRapida} ms)`);
    console.log('✓ 5. certificados distintos corren en paralelo');
  }

  SiiPortalAuth.restablecerSesion();
  console.log('\nautenticar-lock OK');
})().catch((e) => { console.error(e); process.exit(1); });
