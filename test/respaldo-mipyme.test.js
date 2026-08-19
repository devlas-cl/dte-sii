/**
 * `SiiPortalAuth.descargarRespaldoMipyme()`.
 *
 * Lo que protege este archivo es el troceo: el SII corta en 20 documentos por descarga y con
 * 21 devuelve una página de error, NO un XML recortado (medido contra el portal el 18/08/2026:
 * 20 → OK, 21 → error). Si el troceo se rompe, el síntoma no es un fallo ruidoso sino una
 * descarga incompleta que parece exitosa.
 *
 * Sin red: se sustituye `_request`.
 */
const assert = require('assert');
const SiiPortalAuth = require('../SiiPortalAuth');

/** Portal simulado con `docsPorDia` documentos cada día del rango pedido. */
function portalFalso({ docsPorDia = 1, captcha = false, sinEmpresa = false, alerta = null, fallasIniciales = 0 } = {}) {
  const auth = Object.create(SiiPortalAuth.prototype);
  auth.autenticar = async () => ({});
  const dias = (d, h) => Math.round((new Date(h + 'T00:00:00Z') - new Date(d + 'T00:00:00Z')) / 86400000) + 1;
  let fallas = 0;
  auth.descargas = [];
  auth._request = async (url, opts = {}) => {
    if (fallas < fallasIniciales) { fallas++; throw new Error('SII lento'); }
    if (url.includes('lista_documentos')) {
      // El portal viejo responde con <title>Seleccionar empresa</title> y el motivo real
      // metido en un alert() de JS. Se replica el HTML tal cual para que el test proteja
      // justamente el caso que se leyó mal en producción.
      if (alerta) {
        const lista = Array.isArray(alerta) ? alerta : [alerta];
        const js = lista.map((t) => `alert('${t}');`).join('\n');
        return { body: `<html><head><title>Seleccionar empresa</title></head><body><script language="JavaScript">${js}history.back();</script></body></html>` };
      }
      if (sinEmpresa) return { body: '<title>Seleccionar empresa</title>' };
      const p = new URLSearchParams(opts.body || '');
      const n = dias(p.get('FEC_DESDE'), p.get('FEC_HASTA')) * docsPorDia;
      return { body: `<html>Número total de documentos : ${n} </html>` };
    }
    const q = new URLSearchParams(url.split('?')[1]);
    if (captcha) return { body: '<html>recaptcha requerido</html>' };
    auth.descargas.push({ desde: q.get('FEC_DESDE'), hasta: q.get('FEC_HASTA') });
    const n = dias(q.get('FEC_DESDE'), q.get('FEC_HASTA')) * docsPorDia;
    return { body: '<?xml version="1.0"?><SetDTE>' + '<TipoDTE>33</TipoDTE>'.repeat(n) + '</SetDTE>' };
  };
  return auth;
}

const RANGO = { desde: '2026-01-01', hasta: '2026-01-10' };

async function main() {
  // ── Cabe en el tope: un solo tramo, una sola descarga ──────────────────────
  {
    const a = portalFalso({ docsPorDia: 1 });               // 10 documentos
    const r = await a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO });
    assert.strictEqual(r.tramos.length, 1, 'con 10 docs no hace falta trocear');
    assert.strictEqual(r.total, 10);
  }

  // ── Excede el tope: trocea, y NINGÚN tramo supera 20 ───────────────────────
  {
    const a = portalFalso({ docsPorDia: 5 });               // 50 documentos
    const r = await a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO });
    assert.ok(r.tramos.length > 1, 'con 50 docs tiene que trocear');
    assert.strictEqual(r.total, 50, 'no se pierde ni se duplica ningún documento');
    for (const t of r.tramos) assert.ok(t.total <= 20, `tramo con ${t.total} docs supera el tope del SII`);
    const enXml = r.tramos.reduce((s, t) => s + (t.xml.match(/<TipoDTE>/g) || []).length, 0);
    assert.strictEqual(enXml, 50, 'los XML traen exactamente lo que dice el total');
  }

  // ── Los tramos no se solapan ni dejan huecos ───────────────────────────────
  {
    const a = portalFalso({ docsPorDia: 5 });
    const r = await a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO });
    const ord = [...r.tramos].sort((x, y) => x.desde.localeCompare(y.desde));
    assert.strictEqual(ord[0].desde, RANGO.desde, 'el primer tramo arranca donde el rango');
    assert.strictEqual(ord[ord.length - 1].hasta, RANGO.hasta, 'el último termina donde el rango');
    for (let i = 1; i < ord.length; i++) {
      const previo = new Date(ord[i - 1].hasta + 'T00:00:00Z');
      const actual = new Date(ord[i].desde + 'T00:00:00Z');
      assert.strictEqual(actual - previo, 86400000, `hueco o solapamiento entre ${ord[i-1].hasta} y ${ord[i].desde}`);
    }
  }

  // ── Un solo día con más de 20: no es divisible, tiene que avisar ───────────
  {
    const a = portalFalso({ docsPorDia: 30 });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', desde: '2026-01-01', hasta: '2026-01-01' }),
      /No es divisible por fecha/,
      'un día indivisible falla explícito en vez de bajar de menos'
    );
  }

  // ── Reintentos: el portal es lento, dos fallas seguidas no abortan ─────────
  {
    const a = portalFalso({ docsPorDia: 1, fallasIniciales: 2 });
    const r = await a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO, reintentos: 3 });
    assert.strictEqual(r.total, 10, 'se recupera tras fallas transitorias');
  }

  // ── Captcha encendido: error propio, NO se reintenta en loop ───────────────
  {
    const a = portalFalso({ docsPorDia: 1, captcha: true });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO }),
      (e) => e.code === 'RESPALDO_CAPTCHA',
      'el captcha da un código propio'
    );
  }

  // ── El motivo real viaja en un alert() de JS, NO en el <title> ─────────────
  // Caso medido en producción el 18/08/2026: la página decía "Seleccionar empresa" en el
  // título mientras el alert traía el motivo verdadero. Clasificar por título llevó a
  // afirmar tres causas equivocadas seguidas. El mensaje del portal se propaga tal cual.
  {
    const a = portalFalso({ alerta: 'No existe información en MIPYME para el rut ingresado' });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('79555666', '3', { origen: 'ENV', ...RANGO }),
      (e) => e.code === 'RESPALDO_SIN_DATOS'
          && /No existe informaci[oó]n en MIPYME/.test(e.mensajePortal)
          && /No existe informaci[oó]n en MIPYME/.test(e.message),
      'el alert gana sobre el título y el texto del SII llega intacto al consumidor'
    );
  }

  // ── Un alert COMENTADO no es un error ──────────────────────────────────────
  // La página normal del respaldo trae `//alert("Maximo numero de docmentos...")` comentado
  // dentro del template. Tomarlo por bueno hace creer que un listado válido falló, que fue
  // exactamente lo que pasó al medir Comercio C y Comercio B.
  {
    const a = portalFalso({ docsPorDia: 1 });
    const original = a._request;
    a._request = async (url, opts) => {
      const r = await original(url, opts);
      if (url.includes('lista_documentos')) {
        r.body += '<script> if (cant_reg>20) { //alert("Maximo numero de docmentos para respaldar: 20."); \n } </script>';
      }
      return r;
    };
    const r = await a.descargarRespaldoMipyme('79777888', '8', { origen: 'RCP', ...RANGO });
    assert.strictEqual(r.total, 10, 'un alert comentado no puede convertir un listado válido en error');
  }

  // ── 🔴 VARIOS alerts son el catálogo del template, NO un veredicto ─────────
  // Medido el 19/08/2026 con EMPRESA EJEMPLO: una respuesta trajo cinco mensajes encadenados y
  // contradictorios entre sí. Tomarlo por veredicto marcó al comercio como "sin datos" y
  // abortó un backfill que venía trayendo 24 documentos correctamente.
  {
    const a = portalFalso({ alerta: [
      'Rut empresa es mipyme vigente pero rut autenticado NO esta autorizado por la empresa.',
      'Ud. no esta autorizado para ingresar a esta opcion. Favor verificar en www.sii.cl',
      'No existe informacion en MIPYME para el rut indicado',
      'No existe informacion en MIPYME para el rut ingresado.',
    ] });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO }),
      (e) => e.code === 'RESPALDO_INDETERMINADO' && e.mensajesPortal.length === 4,
      'con varios mensajes no se puede concluir nada, y menos que el comercio no existe'
    );
  }

  // ── "Indeterminado" NO es "sin datos" ──────────────────────────────────────
  // Distinción que costó un mes cerrado en falso: el consumidor marca `sin_datos` como
  // veredicto DEFINITIVO. Un rechazo indeterminado significa "no se pudo concluir", no "no
  // hay nada", así que tiene un código propio para que no se confundan.
  {
    const a = portalFalso({ alerta: ['uno', 'dos', 'tres'] });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO }),
      (e) => e.code === 'RESPALDO_INDETERMINADO' && e.code !== 'RESPALDO_SIN_DATOS',
      'indeterminado y sin datos no pueden compartir código'
    );
  }

  // ── Un alert desconocido no se inventa una causa ───────────────────────────
  {
    const a = portalFalso({ alerta: 'Mensaje que el SII nunca nos mostró antes' });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO }),
      (e) => e.code === 'RESPALDO_RECHAZADO' && e.mensajePortal === 'Mensaje que el SII nunca nos mostró antes',
      'sin patrón conocido se reporta literal, no se adivina el motivo'
    );
  }

  // ── Página de ingreso SIN alert: no se afirma ninguna causa ────────────────
  {
    const a = portalFalso({ sinEmpresa: true });
    await assert.rejects(
      () => a.descargarRespaldoMipyme('76543210', '6', { origen: 'RCP', ...RANGO }),
      (e) => e.code === 'RESPALDO_SIN_EMPRESA' && /no determinada/i.test(e.message),
      'sin mensaje del portal, el error dice que la causa no se conoce'
    );
  }

  // ── Los tramos llegan del MÁS NUEVO al más viejo ───────────────────────────
  // Sin esto el usuario espera todas las descargas para ver los documentos recientes, que son
  // justo los que está mirando en pantalla.
  {
    const a = portalFalso({ docsPorDia: 5 });               // 50 documentos, varios tramos
    const orden = [];
    await a.descargarRespaldoMipyme('76543210', '6', {
      origen: 'RCP', ...RANGO,
      onTramo: async (t) => { orden.push(t.desde); },
    });
    assert.ok(orden.length > 1, 'el caso necesita varios tramos para tener sentido');
    const descendente = [...orden].sort((x, y) => y.localeCompare(x));
    assert.deepStrictEqual(orden, descendente, 'el primer tramo tiene que ser el más reciente');
  }

  // ── onTramo: streaming, sin acumular XML en memoria ────────────────────────
  // Sin esto un histórico grande queda entero en RAM (~6,4 KB por documento).
  {
    const a = portalFalso({ docsPorDia: 5 });               // 50 documentos, varios tramos
    const recibidos = [];
    const r = await a.descargarRespaldoMipyme('76543210', '6', {
      origen: 'RCP', ...RANGO,
      onTramo: async (t) => { recibidos.push(t); },
    });
    assert.strictEqual(r.total, 50, 'el total sigue siendo el real');
    assert.ok(recibidos.length > 1, 'se entregó tramo por tramo');
    assert.strictEqual(
      recibidos.reduce((s, t) => s + (t.xml.match(/<TipoDTE>/g) || []).length, 0), 50,
      'por el callback pasan todos los documentos, sin perder ninguno');
    assert.ok(r.tramos.every((t) => t.xml === undefined),
      'con onTramo el resultado NO retiene los XML: ese es el punto del modo streaming');
  }

  // ── Validación de entrada ──────────────────────────────────────────────────
  {
    const a = portalFalso();
    await assert.rejects(() => a.descargarRespaldoMipyme('76543210', '6', { origen: 'EMI', ...RANGO }), /ENV.*RCP/s);
    await assert.rejects(() => a.descargarRespaldoMipyme('76543210', '6', { origen: 'ENV' }), /desde.*hasta/s);
  }

  console.log('respaldo-mipyme: 16 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
