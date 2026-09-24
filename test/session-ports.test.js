// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Puertos de sesión del portal SII (SessionStore / SessionLock / SessionBroker) y su
 * integración con `SiiPortalAuth`.
 *
 * Lo que se garantiza, sin red ni SII:
 *  1. El lock excluye por clave, deja pasar en paralelo claves distintas y se libera si `fn` falla.
 *  2. El broker es reentrante: un `withSession` anidado no se bloquea a sí mismo.
 *  3. `SiiPortalAuth` guarda y lee la sesión por el store configurado (no por el archivo), aplica
 *     el TTL en un solo lugar y borra solo el certificado pedido, nunca los de otros negocios.
 *  4. `conSesion` serializa dos usos del mismo certificado aunque vengan de "procesos" distintos
 *     (dos instancias de lock que comparten un store), que es lo que hacen dos réplicas con Redis.
 *
 * Se ejecuta con `node test/session-ports.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-ports-'));
const SiiPortalAuth = require('../SiiPortalAuth');
const { MemorySessionLock, MemorySessionStore, SessionBroker } = require('../SiiSessionPorts');
const SiiSessionStore = require('../SiiSessionStore');
const crypto = require('crypto');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lock que simula Redis: exclusión por clave compartida entre varias "réplicas". */
class LockCompartido {
  constructor(estado) { this.estado = estado; }
  async withLock(key, fn) {
    while (this.estado.tomados.has(key)) await dormir(2);
    this.estado.tomados.add(key);
    try { return await fn(); } finally { this.estado.tomados.delete(key); }
  }
}

/** Instancia que ejecuta el `autenticar()` real pero sin tocar el portal. */
let _seq = 0;
function authConSesionValida(cookies = { 'NETSCAPE_LIVEWIRE.rutm': '1', TOKEN: 'x' }) {
  const a = Object.create(SiiPortalAuth.prototype);
  a._certHash = `p${++_seq}`;
  a._cachedCookieJar = null;
  a._validarSesion = async () => true;
  return { a, cookies };
}

(async () => {
  // ── 1. MemorySessionLock ───────────────────────────────────────────────────
  {
    const lock = new MemorySessionLock();
    const orden = [];
    await Promise.all([
      lock.withLock('k', async () => { orden.push('a+'); await dormir(20); orden.push('a-'); }),
      lock.withLock('k', async () => { orden.push('b+'); orden.push('b-'); }),
    ]);
    assert.deepStrictEqual(orden, ['a+', 'a-', 'b+', 'b-'], 'misma clave: no se solapan y respetan el orden');

    const o2 = [];
    await Promise.all([
      lock.withLock('x', async () => { o2.push('x+'); await dormir(20); o2.push('x-'); }),
      lock.withLock('y', async () => { o2.push('y+'); o2.push('y-'); }),
    ]);
    assert.ok(o2.indexOf('y-') < o2.indexOf('x-'), 'claves distintas: corren en paralelo');

    await assert.rejects(lock.withLock('z', async () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(await lock.withLock('z', async () => 'libre'), 'libre', 'el lock se libera si fn falla');
  }

  // ── 2. SessionBroker: validación y reentrancia ─────────────────────────────
  {
    assert.throws(() => new SessionBroker({ store: {}, lock: new MemorySessionLock() }), /store/);
    assert.throws(() => new SessionBroker({ store: new MemorySessionStore(), lock: {} }), /lock/);

    const broker = new SessionBroker({ store: new MemorySessionStore(), lock: new MemorySessionLock() });
    const r = await broker.withSession('c', async () => broker.withSession('c', async () => 'anidado'));
    assert.strictEqual(r, 'anidado', 'un withSession anidado del mismo cert no se bloquea a sí mismo');

    const orden = [];
    await Promise.all([
      broker.withSession('c', async () => { orden.push('1+'); await dormir(15); orden.push('1-'); }),
      broker.withSession('c', async () => { orden.push('2+'); orden.push('2-'); }),
    ]);
    assert.deepStrictEqual(orden, ['1+', '1-', '2+', '2-'], 'flujos independientes sí se excluyen');
  }

  // ── 3. SiiPortalAuth usa el store configurado ─────────────────────────────
  {
    const store = new MemorySessionStore();
    SiiPortalAuth.configurarSesion({ store });

    await SiiPortalAuth._guardarSesion('cert1', { TOKEN: 'a' });
    assert.deepStrictEqual(await SiiPortalAuth._cargarSesion('cert1'), { TOKEN: 'a' });
    assert.ok(await store.load('cert1'), 'quedó en el store inyectado');
    assert.strictEqual(fs.existsSync(path.join(process.env.DATADIR, 'sii_session_cache.json')), false,
      'con otro store no se escribe el archivo');

    await SiiPortalAuth._guardarSesion('cert2', { TOKEN: 'b' });
    await SiiPortalAuth._borrarSesion('cert1');
    assert.strictEqual(await SiiPortalAuth._cargarSesion('cert1'), null);
    assert.deepStrictEqual(await SiiPortalAuth._cargarSesion('cert2'), { TOKEN: 'b' },
      'borrar un certificado no toca los de otros negocios');

    // TTL de 90 min aplicado sobre la entrada, sea cual sea el store
    store._sesiones.set('vieja', { ts: Date.now() - 91 * 60 * 1000, cookies: { T: 'v' } });
    assert.strictEqual(await SiiPortalAuth._cargarSesion('vieja'), null, 'a los 91 min expira');
    store._sesiones.set('fresca', { ts: Date.now() - 80 * 60 * 1000, cookies: { T: 'f' } });
    assert.deepStrictEqual(await SiiPortalAuth._cargarSesion('fresca'), { T: 'f' }, 'a los 80 min sigue vigente');

    // Un store que falla degrada a "sin sesión" en vez de romper la autenticación
    SiiPortalAuth.configurarSesion({ store: {
      load: async () => { throw new Error('redis caído'); },
      save: async () => { throw new Error('redis caído'); },
      remove: async () => { throw new Error('redis caído'); },
    } });
    assert.strictEqual(await SiiPortalAuth._cargarSesion('x'), null);
    await SiiPortalAuth._guardarSesion('x', { T: '1' }); // no lanza
    await SiiPortalAuth._borrarSesion('x');              // no lanza

    SiiPortalAuth.restablecerSesion();
  }

  // ── 4. autenticar() reutiliza la sesión del store en vez de hacer login ───
  {
    const store = new MemorySessionStore();
    SiiPortalAuth.configurarSesion({ store });
    const { a, cookies } = authConSesionValida();
    await store.save(a._certHash, cookies);

    const jar = await a.autenticar();
    assert.deepStrictEqual(jar, cookies, 'devuelve la sesión guardada sin autenticar de nuevo');
    SiiPortalAuth.restablecerSesion();
  }

  // ── 5. conSesion serializa entre "réplicas" que comparten store y lock ────
  {
    const store = new MemorySessionStore();
    const estado = { tomados: new Set() };
    const { a, cookies } = authConSesionValida();
    await store.save(a._certHash, cookies);

    // Réplica A y réplica B: cada una con su broker, pero mismo store y mismo lock lógico.
    const usar = async (nombre, orden) => {
      SiiPortalAuth.configurarSesion({ store, lock: new LockCompartido(estado) });
      SiiSessionStore.delete(a._certHash); // una réplica nueva no tiene la sesión en su memoria
      await a.conSesion(async (jar) => {
        assert.deepStrictEqual(jar, cookies);
        orden.push(`${nombre}+`); await dormir(15); orden.push(`${nombre}-`);
      });
    };
    const orden = [];
    await Promise.all([usar('A', orden), usar('B', orden)]);
    assert.strictEqual(orden.length, 4);
    assert.ok(orden[0].endsWith('+') && orden[1].endsWith('-') && orden[0][0] === orden[1][0],
      `no se solapan: ${orden.join(' ')}`);
    SiiPortalAuth.restablecerSesion();
  }

  // ── 6. limpiarSesion descarta solo este certificado ───────────────────────
  {
    const store = new MemorySessionStore();
    SiiPortalAuth.configurarSesion({ store });
    const { a } = authConSesionValida();
    await store.save(a._certHash, { T: '1' });
    await store.save('otro', { T: '2' });

    await a.limpiarSesion();
    assert.strictEqual(await store.load(a._certHash), null);
    assert.ok(await store.load('otro'), 'la sesión de otro negocio queda intacta');
    SiiPortalAuth.restablecerSesion();
  }

  // ── 7. Casos que la primera versión no cubría ─────────────────────────────
  {
    // conSesion anidado para el mismo certificado no se bloquea a sí mismo
    const store = new MemorySessionStore();
    SiiPortalAuth.configurarSesion({ store });
    const { a, cookies } = authConSesionValida();
    await store.save(a._certHash, cookies);
    const r = await a.conSesion(async () => a.conSesion(async (jar) => jar.TOKEN));
    assert.strictEqual(r, 'x', 'conSesion anidado corre directo');

    // configurarSesion solo con `lock` conserva el store; solo con `store` conserva el lock
    const lockPropio = new MemorySessionLock();
    SiiPortalAuth.configurarSesion({ lock: lockPropio });
    await SiiPortalAuth._guardarSesion('parcial', { T: '1' });
    assert.ok(await store.load('parcial'), 'el store anterior se conservó');

    // Reconfigurar en vuelo no rompe la reentrancia del flujo que ya tenía el lock
    const dentro = await a.conSesion(async () => {
      SiiPortalAuth.configurarSesion({ store });
      return a.conSesion(async () => 'sigue reentrante');
    });
    assert.strictEqual(dentro, 'sigue reentrante');

    // Un lock que rechaza propaga el error y no deja el broker inservible
    SiiPortalAuth.configurarSesion({ lock: { withLock: async () => { throw new Error('lock caído'); } } });
    await assert.rejects(a.conSesion(async () => 1), /lock caído/);
    SiiPortalAuth.configurarSesion({ lock: new MemorySessionLock() });
    assert.strictEqual(await a.conSesion(async () => 'recuperado'), 'recuperado');

    // Un store inválido no cambia la configuración
    assert.throws(() => SiiPortalAuth.configurarSesion({ store: {} }), /store/);
    assert.strictEqual(await a.conSesion(async () => 'igual'), 'igual');
    SiiPortalAuth.restablecerSesion();
  }
  {
    // MemorySessionStore no filtra mutaciones del cookieJar hacia la sesión guardada
    const store = new MemorySessionStore();
    const original = { TOKEN: 'a' };
    await store.save('m', original);
    original.TOKEN = 'mutado';
    const leido = await store.load('m');
    assert.strictEqual(leido.cookies.TOKEN, 'a', 'guardar copia');
    leido.cookies.TOKEN = 'otro';
    assert.strictEqual((await store.load('m')).cookies.TOKEN, 'a', 'leer devuelve copia');
  }
  {
    // Store por defecto (archivo) a través del broker: guarda, lee y borra un solo certificado
    SiiPortalAuth.restablecerSesion();
    await SiiPortalAuth._guardarSesion('f1', { T: '1' });
    await SiiPortalAuth._guardarSesion('f2', { T: '2' });
    assert.deepStrictEqual(await SiiPortalAuth._cargarSesion('f1'), { T: '1' });
    await SiiPortalAuth._borrarSesion('f1');
    assert.strictEqual(await SiiPortalAuth._cargarSesion('f1'), null);
    assert.deepStrictEqual(await SiiPortalAuth._cargarSesion('f2'), { T: '2' }, 'no toca otros certificados');
    SiiPortalAuth.limpiarSesionCache();
  }
  {
    // hidratarSesion + getCookieStringForPfx con un store inyectado
    const extractOriginal = SiiPortalAuth._extractPems;
    SiiPortalAuth._extractPems = () => ({ certPem: 'CERT-DE-PRUEBA' });
    const certHash = crypto.createHash('sha1').update('CERT-DE-PRUEBA').digest('hex').slice(0, 12);
    try {
      // Un archivo local viejo con OTRA sesión para el mismo certificado
      SiiPortalAuth.restablecerSesion();
      await SiiPortalAuth._guardarSesion(certHash, { T: 'VIEJA-DE-ARCHIVO' });
      SiiSessionStore.delete(certHash);

      const store = new MemorySessionStore();
      await store.save(certHash, { T: 'VIGENTE-EN-STORE' });
      SiiPortalAuth.configurarSesion({ store });

      assert.strictEqual(SiiPortalAuth.getCookieStringForPfx(Buffer.from('x'), 'p'), null,
        'con store inyectado no se lee el archivo local, que puede estar viejo');

      assert.strictEqual(await SiiPortalAuth.hidratarSesion(Buffer.from('x'), 'p'), true);
      assert.strictEqual(SiiPortalAuth.getCookieStringForPfx(Buffer.from('x'), 'p'), 'T=VIGENTE-EN-STORE',
        'tras hidratar, la sesión del store queda disponible para CafSolicitor');

      SiiSessionStore.delete(certHash);
      await store.remove(certHash);
      assert.strictEqual(await SiiPortalAuth.hidratarSesion(Buffer.from('x'), 'p'), false, 'sin sesión vigente devuelve false');
    } finally {
      SiiPortalAuth._extractPems = extractOriginal;
      SiiSessionStore.delete(certHash);
      SiiPortalAuth.restablecerSesion();
      SiiPortalAuth.limpiarSesionCache();
    }
  }

  {
    // persistirSesion: lleva al store la sesión abierta en memoria (la de CafSolicitor)
    const extractOriginal = SiiPortalAuth._extractPems;
    SiiPortalAuth._extractPems = () => ({ certPem: 'CERT-PERSISTIR' });
    const certHash = crypto.createHash('sha1').update('CERT-PERSISTIR').digest('hex').slice(0, 12);
    try {
      const store = new MemorySessionStore();
      SiiPortalAuth.configurarSesion({ store });
      SiiSessionStore.delete(certHash);
      assert.strictEqual(await SiiPortalAuth.persistirSesion(Buffer.from('x'), 'p'), false, 'sin sesión en memoria devuelve false');
      assert.strictEqual(await store.load(certHash), null);

      SiiSessionStore.set(certHash, 'A=1; B=2');
      assert.strictEqual(await SiiPortalAuth.persistirSesion(Buffer.from('x'), 'p'), true);
      assert.deepStrictEqual((await store.load(certHash)).cookies, { A: '1', B: '2' });

      // Ida y vuelta: otra réplica hidrata lo que esta persistió
      SiiSessionStore.delete(certHash);
      assert.strictEqual(await SiiPortalAuth.hidratarSesion(Buffer.from('x'), 'p'), true);
      assert.strictEqual(SiiSessionStore.get(certHash), 'A=1; B=2');
    } finally {
      SiiPortalAuth._extractPems = extractOriginal;
      SiiSessionStore.delete(certHash);
      SiiPortalAuth.restablecerSesion();
    }
  }

  console.log('session-ports OK');
})().catch((e) => { console.error(e); process.exit(1); });
