# Plan de mejoras — CafSolicitor / SiiSession

Basado en análisis normativo SII + revisión de código actual (junio 2026).

## Estado del código actual — qué YA está hecho

Antes de implementar, confirmar que esto NO se toca (ya funciona):

### En `dte-sii` (librería)
- ✅ **Session reuse** — `_sessionRegistry` singleton por `ambiente::rut` en `CafSolicitor.js`
- ✅ **Logout** — `SiiSession.logout()` y `CafSolicitor.closeAllSessions()` existen
- ✅ **Demasiadas sesiones** — `_tryForceCloseSessions()` detecta y cierra sesiones anteriores automáticamente
- ✅ **DTE-OFGA retry** — 3 reintentos con delay 3s/6s/9s en `_processGeneraArchivo()`
- ✅ **MAX_AUTOR handling** — ajusta `cantReal = Math.min(cantidad, maxAutor)` y reintenta con 1
- ✅ **Rango ya autorizado** — intenta recuperar XML via `of_genera_archivo`
- ✅ **ISO-8859-1** — encoding correcto para respuestas del SII
- ✅ **pfxBuffer en memoria** — prioridad sobre pfxPath (no escribe cert a disco)
- ✅ **Retry en FolioService** — configurable via `retries` y `retryDelayMs` (default 1500ms)
- ✅ **Session persistence** — `loadSession()`/`saveSession()` con TTL 90 min
- ✅ **`TIMBRAJE_BLOQUEADO` detection** — early return en `_processMultiStepFlow` antes del check `COD_DOCTO`; `errorCode` en todos los returns de error (`TIMBRAJE_BLOQUEADO`, `SESSION_EXPIRED`, `MAX_AUTOR_EXCEEDED`, `RANGO_YA_AUTORIZADO`, `UNKNOWN`, `NETWORK_ERROR`) — *implementado 10/06/2026*
- ✅ **Rate limiting 1001ms** — `CafSolicitor._lastSolicitudAt` estático; espera al inicio de `solicitar()` — *implementado 10/06/2026*

### En `devlas-cloud-api-node` (API) — arquitectura ya resuelta
- ✅ **Job pg-boss `replenish-caf`** — existe completo en `jobs.ts:510-609`
  - Threshold: 20 folios restantes → solicita 200 al SII
  - `singletonKey: 'caf-${comercioId}-${tipoDte}'` en transacciones.ts, emitir-dte-batch.ts y startup
  - `retryLimit: 3`, `retryBackoff: true`
  - Slot `sii_caf_xml_next` para tipo 39: pre-carga el siguiente CAF sin gap de folios
  - Warm-up en startup: encola replenish para empresas sin CAF antes de la primera venta
- ✅ **Folio assignment con `SELECT FOR UPDATE`** — previene duplicados en multi-instancia Railway
- ✅ **PFX password cifrada** — `pfx-crypto.ts` con AES-256-GCM en columna `sii_pfx_pass`
- ✅ **SIGTERM/SIGINT logout hook** — `index.ts` llama `CafSolicitor.closeAllSessions()` en shutdown — *ya existía*
- ✅ **`replenish-caf` no reintenta en `TIMBRAJE_BLOQUEADO`** — los tres puntos de `throw` verifican `errorCode` primero; `solicitarCafParaEmpresa` pasa `errorCode` al caller — *implementado 10/06/2026*
- ✅ **Vigencia CAF runtime** — `isCafExpired` / `isCafExpiringSoon` en `transacciones.ts` + `jobs.ts`; CAF expirado → folio=0; expiración próxima (<30d) → replenish proactivo; `_next` no se promueve si expirado — *implementado 10/06/2026*

---

## Comportamiento del SII observado en los HARs — ground truth

> **Fuentes:**
> - `docs/obtencionfolios.har` — sesión multi-tipo exitosa, palena.sii.cl, 10/06/2026
> - `docs/noseautorizatimbrajeFACTURA.har` — bloqueo inmediato tipo 33 (HAR limpio)
> - `docs/obtencionfolio_boleta_exito.har` — boleta tipo 39 exitosa (folio 6415)
> - `docs/obtencionfolios_hastamaxautorizado.har` — 5 sesiones tipo 33 exitosas + bloqueo al 6.º intento
> - `docs/obtencionfolios_hastamaxautorizado_28.har` — 6 bloqueos iniciales, anulación (folio 69), debloqueo en FOLIOS_DISP=22, 6 sesiones exitosas, 2.º bloqueo
> - `docs/obtencionfolios_hastamaxautorizado_.har` — **HAR definitivo del ciclo completo**: 5 bloqueos → 6 anulaciones controladas (70, 71, 72 + 3 más) → debloqueo → 6 sesiones exitosas (folios 84–89) → bloqueo. Confirma aritmética +1/−1 y umbral debloqueo=22
>
> RUT 78206276-K — Devlas SpA (Luciano Alberto Saavedra Reyes, representante legal)

### FOLIOS_DISP — umbral de advertencia y bloqueo duro (confirmado HAR)

`FOLIOS_DISP` = folios autorizados (timbrados) por el SII para este tipo de documento
que aún **no han sido utilizados en ningún DTE emitido**. El SII lo calcula serverside;
disminuye solo cuando se emiten y envían DTEs al SII.

**Progresión confirmada en TRES HARs independientes (tipo 33, MAX_AUTOR=1):**

> El SII escala FOLIOS_DISP y MAX_AUTOR según historial de cada empresa. Los umbrales
> numéricos son los observados para Devlas SpA (78206276-K). Para empresas con mayor
> volumen los valores de corte serán distintos, pero el mecanismo es idéntico.

| FOLIOS_DISP al intentar | Resultado | Tamaño tipo-selección |
|-------------------------|-----------|----------------------|
| 22–23 | ✅ éxito, **sin advertencia** | ~7.621 bytes (baseline) |
| 24, 25, 26, 27 | ✅ éxito, **advertencia soft** | ~8.109 bytes (+487 bytes) |
| 28 | ❌ **BLOQUEO DURO** | ~3.690 bytes (sin `<form>` ni `<input>`) |

**La aritmética es simple:**
- Cada solicitud exitosa: FOLIOS_DISP **+1**
- Cada anulación de folio: FOLIOS_DISP **−1**
- No hay recálculo complejo — el SII opera con suma/resta directa

**Ciclo completo confirmado** (folios 73–77, 78–83, 84–89 — tres HARs):
- Debloqueo en FOLIOS_DISP = **22**
- 2 solicitudes sin advertencia (FOLIOS_DISP 22 y 23)
- 4 solicitudes con advertencia soft (FOLIOS_DISP 24, 25, 26, 27)
- Intento cuando FOLIOS_DISP interno = **28** → **BLOQUEO DURO** inmediato
- Para desbloquear: **6 anulaciones** (28 − 6 = 22)

**`of_confirma_folio` nunca muestra advertencia** — constante 5.864–5.867 bytes en los tres HARs.

**El bloqueo ocurre en el TERCER paso** (`of_solicita_folios_dcto` con `{COD_DOCTO, CANT_DOCTOS:''}`), nunca en `of_confirma_folio`.

**La autorización se registra en `of_genera_folio`**, no en `of_genera_archivo`.

**Reintentos mientras bloqueado — observado:** hasta 5 intentos consecutivos, todos rechazados.
El código **no debe reintentar** tras recibir `TIMBRAJE_BLOQUEADO`.

### Texto exacto de la página de rechazo (HTML capturado)

```html
<b>NO SE AUTORIZA TIMBRAJE ELECTR&Oacute;NICO</b> <br><br>
Sr. Contribuyente: de acuerdo a nuestros registros, usted posee situaciones pendientes
con el SII que restringen el timbraje electrónico, o tiene disponible una cantidad de
folios suficiente para emitir documentos electrónicos. Cabe señalar que en sus
solicitudes previas se le informó dicha situación.
<br><br>
Para habilitar nuevamente el timbraje de documentos electrónicos, debe:<br><br>
<li>Solucionar sus situaciones pendientes con el SII, si corresponde, y/o</li>
<li>Emitir y enviar documentos electrónicos al SII o anular folios electrónicos,
en una cantidad equivalente a los timbrajes electrónicos en que se le advirtió
dicha situación.</li>
```

**Implicancias clave:**
- "en sus solicitudes previas se le informó" → las advertencias soft del ciclo actual son las "advertencias previas" referenciadas
- "en una cantidad equivalente a los timbrajes en que se le advirtió" → consistente con los datos: 4 sesiones con advertencia (FOLIOS_DISP 24–27), pero se necesitan 6 anulaciones para desbloquear (la diferencia block/deblock es 6, no 4)
- La página de rechazo NO tiene `<form>` ni `<input>` — `extractInputValues` retorna `{}`
- La página SÍ contiene `"COD_DOCTO"` en su JavaScript (`form.COD_DOCTO.value='-1'`) — esto es el bug actual

**Variante de 3234 bytes — confirmada:**
Algunos rechazos en los HARs miden ~3234 bytes en lugar de ~3690. Es la misma página con el mismo texto `"NO SE AUTORIZA"`, pero sin el script de monitoreo Dynatrace (`ruxitagentjs`), que el SII inyecta solo en algunos requests según su sampler. La detección por substring `"NO SE AUTORIZA"` funciona para ambas variantes. ✅

### La advertencia suave — implicación para el código

La advertencia (+487 bytes) aparece en la respuesta HTML pero **no impide la continuación del flujo**. Los `<input>` del formulario siguen presentes y `extractInputValues` los captura correctamente.

**No es necesario detener la solicitud si se detecta la advertencia soft** — pero sí conviene loguearla. `FOLIOS_DISP` ya está disponible en los POST params que el código construye en cada paso; se puede leer directamente desde ahí sin parsear HTML.

**Texto exacto del warning soft** (capturado en `obtencionfolios_SOFTWARNING.har`, FOLIOS_DISP=24):

```html
ADVERTENCIA - Sr. Contribuyente: de acuerdo a nuestros registros, usted tiene disponible
una cantidad de folios suficiente para emitir documentos electrónicos. Si no los utiliza,
sus futuras solicitudes de timbraje podrían ser denegadas, para solucionar esta situación
deberá emitir y enviar documentos electrónicos al SII.
```

**Estructura de la página soft warning — confirma que el código no necesita cambios:**
- Tiene `<FORM NAME="form1" METHOD="POST" ACTION="/cvc_cgi/dte/of_confirma_folio">` ✅
- `FOLIOS_DISP` es un `<INPUT type=text readonly value="24">` DENTRO del form → `extractInputValues` lo captura ✅
- `MAX_AUTOR` es un `<INPUT type=text readonly value="1">` DENTRO del form ✅
- `COD_DOCTO` es un `<SELECT>` (no `<input>`) — no lo captura `extractInputValues`, pero el código lo pasa explícitamente ✅
- Todos los campos ocultos necesarios están presentes ✅

**Strings de detección confirmados:**
- Soft warning: `"ADVERTENCIA"` (o más específico: `"ADVERTENCIA - Sr. Contribuyente"`)
- Hard block: `"NO SE AUTORIZA"`
- Ambas son mutuamente excluyentes — no se puede confundir una con la otra

**El código NO necesita cambio de comportamiento para el soft warning** — la estructura del form es completa y correcta. Solo añadir logging opcional con FOLIOS_DISP cuando se detecte `"ADVERTENCIA"` en la respuesta.

### La advertencia del SII sobre folios acumulados

Cuando `FOLIOS_DISP` supera cierto umbral, el SII muestra (texto confirmado en `obtencionfolios_SOFTWARNING.har`):

> "ADVERTENCIA - Sr. Contribuyente: de acuerdo a nuestros registros, usted tiene disponible
> una cantidad de folios suficiente para emitir documentos electrónicos. Si no los utiliza,
> sus futuras solicitudes de timbraje podrían ser denegadas, para solucionar esta situación
> deberá emitir y enviar documentos electrónicos al SII."

Y define (sección GLOSARIO al pie del mismo formulario):
> "Rango máximo autorizado a timbrar: es el número máximo de folios que el SII autoriza al
> contribuyente, en función de la emisión de documentos, folios anulados de los últimos 6
> meses y los folios disponibles del contribuyente."

**Implicancias para la arquitectura:**
1. **No pedir más de lo necesario** — solicitar 200 folios si MAX_AUTOR=1 no tiene sentido;
   `CafSolicitor` ya maneja `cantReal = Math.min(cantidad, maxAutor)` ✅
2. **El threshold proporcional (ítem 9) es INCORRECTO** — ver sección de corrección abajo
3. **`FOLIOS_DISP` no lo controla el código cliente** — el SII lo calcula serverside basado
   en los CAFs autorizados previos; solo disminuye cuando se emiten y envían DTE al SII
4. **El formulario varía por tipo de DTE:**

   Comparando los campos de `of_solicita_folios_dcto` por tipo de DTE:

   | Tipos | FOLIOS_DISP / MAX_AUTOR / CONTROL presentes |
   |-------|----------------------------------------------|
   | 34, 52 | ✅ SÍ — desde el primer POST |
   | 33 | Aparecen en la respuesta del SII al seleccionar el tipo, y se reenvían en `of_confirma_folio` |
   | 39, 41, 46, 56, 61 | ❌ NO — formulario simple sin estos campos |

   Para tipo 39 (boleta), el form solo tiene: `RUT_EMP`, `DV_EMP`, `FOLIO_INICIAL`, `COD_DOCTO`,
   `AFECTO_IVA`, `ANOTACION`, `CON_CREDITO`, `CON_AJUSTE`, `FACTOR`, `CANT_DOCTOS`.

   **Diferencias adicionales confirmadas tipo 39 vs tipo 33** (HTML capturado 10/06/2026):
   - `CON_CREDITO = "0"` (tipo 33 usa `"1"`)
   - `FACTOR = ""` vacío (tipo 33 usa `"1.00"`)
   - `onSubmit="return validapag(0)"` (tipo 33 usa `validapag(1)`)
   - La función `Limpieza(form)` del JS referencia `form.FOLIOS_DISP` y `form.MAX_AUTOR`
     aunque NO existan como inputs → tiraría `TypeError` si se llamara en tipo 39
     (no es nuestro problema, es JS compartido del SII)
   - Action del form: `of_confirma_folio` directo — **no hay paso intermedio con FOLIOS_DISP**

   **Conclusión:** `FOLIOS_DISP` y `MAX_AUTOR=1` son restricciones del SII para facturas y
   liquidaciones — no para boletas. Boletas tienen un flujo más simple.

   **CONFIRMADO: tipo 39 NO tiene bloqueo por FOLIOS_DISP** — dos evidencias directas (11/06/2026):
   - Devlas SpA tiene ~100 folios de boleta en DB locales sin asignar a ventas, y el portal
     devuelve el form normal sin ningún bloqueo ni advertencia.
   - `obtencionfolios_boleta.har`: `of_confirma_folio` response para tipo 39 muestra
     `Disponible: 0` y `Máximo Autorizado: 0` en la tabla de confirmación, y el request
     **igual es exitoso** (autoriza folio 6416). Esto confirma que el SII no aplica el
     mecanismo FOLIOS_DISP a boletas — con Disponible=0 el sistema igual autoriza.

   El bloqueo por FOLIOS_DISP es exclusivo de **tipo 33 (factura)**. Los demás tipos que
   tampoco muestran FOLIOS_DISP en el form (39, 41, 46, 52, 56, 61) probablemente tampoco
   tienen este mecanismo. Tiene sentido: un POS puede emitir 200+ boletas por día — el SII
   no puede aplicar el mismo throttle que para facturas de bajo volumen.

   **Nota:** Los "folios disponibles" en el DB (sii_caf_xml remaining) son distintos de
   FOLIOS_DISP en el SII. El SII ve Disponible=0 para boleta aunque en el DB local haya
   folios sin usar — esos folios locales aún no han sido "emitidos y enviados" al SII,
   por eso el contador del SII no los refleja todavía.

   **Campos confirmados del `of_confirma_folio` response (tipo 39)** — inputs que el código
   envía a `of_genera_folio`:
   `NOMUSU` (nombre mandatario), `CON_CREDITO=0`, `CON_AJUSTE=0`, `FOLIO_INI`, `FOLIO_FIN`,
   `DIA`, `MES`, `ANO`, `HORA`, `MINUTO`, `RUT_EMP`, `DV_EMP`, `COD_DOCTO=39`, `CANT_DOCTOS=1`.
   El `extractInputValues` captura todos automáticamente — ningún campo hardcodeado faltante.

   **No hay bug en `CafSolicitor.js`:** usa `SiiSession.extractInputValues` + spread `...inputs`
   en cada paso — captura automáticamente los campos que el SII inyecta según tipo, sin hardcodear.

### Timing real del flujo

- Flujo completo tipo 33: **~5-8 segundos** (operación manual); ~2s en automatizado (HAR multi-tipo anterior)
- Cada paso individual: 150–750ms (variable según carga del servidor SII)
- Total de los 5 sesiones exitosas + 1 bloqueo en HAR: ~1 minuto 47 segundos
- El delay de 1001ms NO debe aplicarse dentro del flujo — solo entre sesiones distintas

### Tipos de DTE y MAX_AUTOR/FOLIOS_DISP — mapa por tipo

Confirmado desde los dos HARs:

| Tipo | Descripción | MAX_AUTOR en `<input>` | Confirmado |
|------|-------------|------------------------|------------|
| 33 | Factura Afecta | ✅ SÍ | ✅ Confirmado por usuario (inspeccionando HTML) |
| 34 | Factura Exenta | ❌ NO | ✅ Confirmado por usuario ("tampoco tiene el input") |
| 39 | Boleta Electrónica | ❌ NO | ✅ Confirmado (HAR) |
| 41 | Boleta No Afecta | ❌ NO | Probable (misma familia) |
| 46 | Factura de Compra | ❌ NO | HAR previo (sin MAX_AUTOR en POST) |
| 52 | Guía de Despacho | ❓ Incierto | HAR previo puede ser contaminado de sesión anterior |
| 56 | Nota de Débito | ❌ NO | HAR previo |
| 61 | Nota de Crédito | ❌ NO | HAR previo |

**Conclusión para el código:** Solo tipo 33 tiene `MAX_AUTOR` como `<input>` en el form Y tiene
el bloqueo duro por FOLIOS_DISP. Para todos los demás tipos, `inputs3.MAX_AUTOR` es `undefined`
→ el código defaultea a `maxAutor = cantidad`. Esto es correcto.

**La detección de `TIMBRAJE_BLOQUEADO` en el ítem 6 aplica en la práctica solo a tipo 33.**
No se necesita lógica especial para tipo 39 — el SII no bloquea boletas por acumulación.

**Campo `CANT_TIMBRAJES`** (confirmado en `validadte.js`):
- Presente como hidden input solo en tipo 33 (`credito_fiscal > 0`)
- El browser previene el POST si `CANT_TIMBRAJES > 6` — pero el código lo bypasea
- En el form capturado (FOLIOS_DISP=24), `CANT_TIMBRAJES=""` — no se llena durante el soft warning
- En la práctica el server bloquea en `of_solicita_folios_dcto` antes de mostrar el form, así que `CANT_TIMBRAJES > 6` es inalcanzable en el flujo normal
- El código pasa este campo tal cual via `extractInputValues` → `of_confirma_folio` ✅

**`validapag(0)` vs `validapag(1)` — confirmación definitiva tipo 33 vs 39:**
- `validapag(1)` (tipo 33): valida MAX_AUTOR, CANT_TIMBRAJES — tiene las dos restricciones
- `validapag(0)` (tipo 39): solo valida CON_AJUSTE (siempre=0 → nunca bloquea)
- Tipos 39 y 41 sin límite máximo de cantidad en client-side (`> 9999999` solo aplica a otros tipos)

### Vigencia de CAF — 180 días (6 meses)

Los CAF tienen vigencia exacta de **180 días** desde la fecha de autorización (`<FA>` en el XML).
Después de ese plazo el SII rechaza la emisión de DTEs con ese folio.

**Impacto en la arquitectura:**

1. **`sii_caf_xml_next` puede expirar antes de activarse.** Si una empresa nueva recibe MAX_AUTOR=1
   hoy y el slot `_next` se carga hoy, pero la empresa no consume los folios del CAF activo hasta
   6 meses después, el `_next` expira antes de activarse. El `replenish-caf` worker debería
   verificar la fecha de expiración del slot `_next` antes de usarlo.

2. **CAF activo puede tener folios disponibles pero estar expirado.** `foliosRestantes > 0`
   no implica que el CAF sea válido. Hay que comparar `fechaAutorizacion + 180 días vs NOW`.

3. **No hay expiry tracking en el DB actualmente.** La columna `sii_caf_xml` guarda el XML
   completo — la fecha `<FA>` está en el XML pero no hay columna `sii_caf_xml_expira_at`.
   Para validar hay que parsear el XML o agregar la columna.

4. **Estrategia recomendada:** Cuando `replenish-caf` carga un CAF (activo o `_next`),
   extraer `<FA>` del XML y calcular `expira_at = FA + 180 días`. Guardar en columna
   `sii_caf_xml_expira_at` (y equivalente `_next_expira_at`). El job también debe dispararse
   cuando `expira_at < NOW + 30 días` (aunque aún haya folios restantes).

**Columnas DB sugeridas (Drizzle migration):**
```ts
sii_caf_xml_expira_at:     timestamp  // FA + 180d del CAF activo
sii_caf_xml_next_expira_at: timestamp // FA + 180d del CAF next
```

**Extracción de FA (ya existe en el código):**
```js
const faMatch = xml.match(/<FA>(\d{4}-\d{2}-\d{2})<\/FA>/i); // en _extractCafInfo
```

---

## Lo que FALTA implementar

### P0 — Crítico

#### 1. Rate limiting — 1001ms ENTRE sesiones CAF distintas, NO entre pasos internos

El SII recomienda máximo 1 TPS. El delay debe aplicarse a nivel de `CafSolicitor` —
entre llamadas `solicitar()` distintas — **no dentro del multi-step flow de una sesión**.

**Por qué importa el scope:** El HAR real muestra que el flujo completo tarda ~2 segundos
(6 pasos × ~320ms avg). Si se agrega 1001ms entre cada paso interno, el flow tarda 8s+
siendo que un humano lo hace en 2s. El WAAP no se dispara dentro de una sesión activa.

**Dónde aplicar:** `CafSolicitor` — llevar `CafSolicitor._lastSolicitudAt` (timestamp
estático compartido entre instancias) y esperar al inicio de `solicitar()`:

```js
// En CafSolicitor.solicitar() — al principio del método
const now = Date.now();
const elapsed = now - (CafSolicitor._lastSolicitudAt || 0);
const delay = this._options.interSolicitudDelayMs ?? 1001;
if (elapsed < delay) {
  await new Promise(r => setTimeout(r, delay - elapsed));
}
CafSolicitor._lastSolicitudAt = Date.now();
```

Esto serializa las solicitudes de distintos comercios/tipos que puedan correr en paralelo
en Railway, respetando el 1 TPS global del SII.

> ⚠️ Verificar que esto no rompa los tests de certificación (`cert/`) que encadenan
> muchas peticiones seguidas — el delay los hará más lentos pero no debería romperlos.

---

#### 2. SIGTERM/exit hook para logout garantizado

`closeAllSessions()` existe pero nadie lo llama si el proceso muere. El SII tiene
límite dinámico de sesiones concurrentes por RUT — las sesiones huérfanas acumulan
y eventualmente bloquean al contribuyente.

**Dónde:** En el primer `new CafSolicitor(...)`, registrar los handlers una sola vez.

```js
// Solo registrar una vez globalmente
if (!CafSolicitor._shutdownRegistered) {
  const shutdown = () => CafSolicitor.closeAllSessions().finally(() => {});
  process.once('exit', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  CafSolicitor._shutdownRegistered = true;
}
```

> ⚠️ Usar `once` no `on` para no acumular listeners en tests o instanciaciones repetidas.
> `closeAllSessions()` ya es seguro de llamar múltiples veces.

---

#### 3. Errores tipados con `errorCode`

Actualmente todos los errores devuelven `{ success: false, error: string }`.
El caller (API) no puede distinguir qué pasó sin parsear strings.

**Dónde:** `CafSolicitor.solicitar()` — agregar `errorCode` a todos los returns `success: false`.

Códigos mínimos a implementar:

| errorCode | Retriable | Cuándo |
|-----------|-----------|--------|
| `AUTH_FAILED` | Sí | Sesión expiró o certificado rechazado |
| `WAAP_BLOCKED` | Sí (delay) | 403 o página de acceso restringido del SII |
| `TIMBRAJE_BLOQUEADO` | **NO** | "NO SE AUTORIZA TIMBRAJE ELECTRÓNICO" — folios acumulados o situaciones pendientes |
| `MAX_AUTOR_EXCEEDED` | Sí (con cantidad=1) | ya existe pero solo en texto, formalizarlo |
| `RANGE_ALREADY_AUTHORIZED` | No | ya existe pero solo en texto, formalizarlo |
| `SII_UNAVAILABLE` | Sí | timeout, 502, 504 |
| `UNKNOWN` | Sí | todo lo demás |

> ⚠️ No cambiar la forma del objeto de retorno — solo agregar `errorCode`.
> El caller actual que solo chequea `result.success` no se rompe.
>
> El `replenish-caf` worker en jobs.ts debe leer `errorCode` y NO reintentar si es
> `TIMBRAJE_BLOQUEADO` — pg-boss lo marcaría como failed permanente para no acumular
> más sesiones SII y ahorrar tiempo de espera.

---

### P1 — Importante

#### 4. Headers completos de Chrome — extraídos del HAR real

> **Fuente de verdad:** `docs/obtencionfolios.har` — sesión real de Luciano Saavedra Reyes
> en palena.sii.cl el 10/06/2026 con Chrome 122 en Windows 10.

Diferencias con el código actual:
- Chrome version: código dice v124 → real es **v122**
- Accept: falta `image/apng` y `application/signed-exchange;v=b3;q=0.7`
- Accept-Language: código dice `es-CL` → real es **`es-419,es-US;q=0.9,es;q=0.8,en;q=0.7`**
- Accept-Encoding: falta **`zstd`**
- Falta **`Sec-Fetch-User: ?1`**
- `sec-ch-ua`: código tiene `Not-A.Brand` → real tiene **`Not(A:Brand`**
- `Cache-Control: max-age=0` — solo en POSTs (form submit), no en GETs
- `Origin: https://palena.sii.cl` — solo en POSTs, no en GETs

**Dónde:** `SiiSession.request()` línea 162.

Reemplazar el bloque de headers por los exactos del HAR:

```js
// Headers base — aplican a GET y POST
const baseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'es-419,es-US;q=0.9,es;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// Headers adicionales solo para POSTs (form submit)
const postOnlyHeaders = isPost ? {
  'Cache-Control': 'max-age=0',
  'Origin': `https://${this._host}`,  // palena.sii.cl o maullin.sii.cl
} : {};

// Merge final
headers: {
  ...baseHeaders,
  ...postOnlyHeaders,
  ...(this.cookieJar ? { Cookie: this.cookieJar } : {}),
  ...(options.headers || {}),  // permite override por caller (Content-Type, Referer)
}
```

> ⚠️ El orden de headers importa para los WAF. Mantener este orden exacto.
> `got` no garantiza orden de headers por default — puede necesitarse un interceptor.

---

#### 5. Timeout explícito en `got`

`got` no tiene timeout configurado — en fechas críticas (días 12–20 del mes,
abril Operación Renta) el SII puede tardar 45s o no responder nunca.

**Dónde:** `SiiSession.request()` — agregar `timeout` a la llamada `got()`.

```js
timeout: {
  request: this.timeoutMs || 20000,  // default 20s
},
```

Exponer como `options.timeoutMs` en constructor de `SiiSession` y pasarlo
como `options.timeoutMs` en `CafSolicitor`.

---

#### 6. Detección de errores de negocio faltantes

Ya se detectan: `MAX_AUTOR`, `ya fue autorizado`, `Autenticaci`, `menor o igual al m`.

**Detectado en `noseautorizatimbrajeFACTURA.har` (HAR limpio, un solo intento de tipo 33):**

```js
// Dónde: en _processMultiStepFlow(), INMEDIATAMENTE después del POST a of_solicita_folios_dcto
// (es decir, después de recibir currentHtml del paso de selección de tipo).
// Antes de cualquier check de COD_DOCTO o _processStep3.

// BLOQUEO DURO — "NO SE AUTORIZA TIMBRAJE ELECTRÓNICO"
// El SII devuelve esta página en respuesta a of_solicita_folios_dcto cuando la empresa
// tiene demasiados folios acumulados sin usar o situaciones tributarias pendientes.
// NO RETRIABLE: el SII lleva un contador de intentos con advertencia previa.
// La página contiene COD_DOCTO en su JavaScript (función Limpieza), lo que haría que
// el código actual intente parsear y reenviar — generando 3-4 requests extra en vano.
if (currentHtml.includes('NO SE AUTORIZA')) {
  return { success: false, errorCode: 'TIMBRAJE_BLOQUEADO', error: 'SII: No se autoriza timbraje. Folios acumulados o situaciones tributarias pendientes. Emitir y enviar DTEs al SII o anular folios antes de volver a solicitar.' };
}

// WAAP / IP bloqueada
if (response.status === 403 || body.includes('acceso restringido') || body.includes('reCaptcha')) {
  return { success: false, errorCode: 'WAAP_BLOCKED', error: 'IP bloqueada por el firewall del SII. Espera antes de reintentar.' };
}
```

**Strings exactos del bloqueo confirmados del HTML (ISO-8859-1):**
- En el body visible: `NO SE AUTORIZA TIMBRAJE ELECTR&Oacute;NICO`
- Detección segura con substring: `"NO SE AUTORIZA"` — no hay falso positivo con este texto

**Punto exacto de detección en el código:**
- El rechazo llega en la respuesta al POST `of_solicita_folios_dcto` con `{COD_DOCTO, CANT_DOCTOS:''}`
- Esto ocurre dentro de `_processMultiStepFlow()`, en el bloque `if (currentHtml.includes('COD_DOCTO'))`
- **Bug actual:** la página de rechazo SÍ contiene `"COD_DOCTO"` en su JavaScript (`form.COD_DOCTO.value='-1'`), por eso el código actual cae en el selectStep y hace requests extra innecesarios
- **Fix:** verificar `"NO SE AUTORIZA"` ANTES de `includes('COD_DOCTO')`

**El HAR limpio confirma:** el rechazo es inmediato desde el primer POST al seleccionar tipo de documento — no es "después de múltiples intentos". El SII ya tiene el estado de la empresa bloqueado desde sesiones previas.

**Para tipo 39 (boleta) en este estado de bloqueo:** No hay HAR limpio disponible, pero es razonable asumir el mismo comportamiento — el SII bloquea en `of_solicita_folios_dcto` con el mismo mensaje.

> ⚠️ Validar el string `"NO SE AUTORIZA"` en producción para confirmar que aplica igual a tipo 39.

**Cómo desbloquear — mecanismo confirmado con experimento controlado (`obtencionfolios_hastamaxautorizado_.har`):**

- **Bloqueado** en FOLIOS_DISP = 28
- Anuló folios de uno en uno: 70, 71, 72 + 3 más = **6 anulaciones** → FOLIOS_DISP = 22 → **desbloqueó**
- Cada anulación reduce FOLIOS_DISP en exactamente **1** (aritmética directa, no hay recálculo complejo)
- **Umbral de debloqueo para Devlas SpA: FOLIOS_DISP ≤ 22**
- Histéresis entre bloqueo y debloqueo = **6 unidades** (block=28, deblock=22)

**Corrección al análisis anterior** ("episodio 2", drop de 6 con 1 anulación):
- El FOLIOS_DISP=22 que mostraba el portal al momento de anotar la anulación del folio 69 era el estado **ya existente** — había bajado de 28 a ~23 por el paso del tiempo (DTEs procesados por el SII). La anulación de folio 69 solo aportó el último −1 para cruzar el umbral. No fue un "drop de 6 por 1 anulación".

- ⚠️ **Corrección al ítem 9:** el threshold proporcional al 50% del CAF es INCORRECTO — ver ítem 9 revisado.

---

#### 7. Backoff exponencial para timeouts y errores 5xx

El DTE-OFGA ya tiene retry con delay fijo. Los errores de timeout y 502/504
no tienen retry — simplemente lanzan excepción.

**Dónde:** `SiiSession.request()` — envolver el `got()` con retry:

```js
// delays: [2000, 4000, 8000] ms
// solo para: timeout, ECONNRESET, status 502/503/504
```

> ⚠️ NO reintentar en errores 4xx (400, 403, 404) ni en respuestas 200 con error
> de negocio — esos son errores definitivos, no transitorios.

---

### P2 — Arquitectura (cambios en `devlas-cloud-api-node`, no en la librería)

#### 8. ~~Job asíncrono con pg-boss~~ — YA IMPLEMENTADO ✅

Ver sección "YA está hecho". El `replenish-caf` worker con `singletonKey` y slot `_next`
ya existe y es completo. No implementar de nuevo.

#### 9. CAF_REPLENISH_THRESHOLD — el valor fijo de 20 es CORRECTO; el proporcional era INCORRECTO

> **Corrección post-análisis HAR `obtencionfolios_hastamaxautorizado.har`** (10/06/2026)

**El HAR confirma los umbrales exactos del SII para Devlas SpA (78206276-K):**
- `FOLIOS_DISP = 24` → advertencia suave (el SII informa pero permite continuar)
- `FOLIOS_DISP = 28` → **BLOQUEO DURO** (el SII rechaza el timbraje)

> ⚠️ Estos valores son específicos de Devlas SpA. Otras empresas tendrán umbrales distintos según su historial de emisión. El mecanismo (soft warning → hard block) es universal; los números no.

**Por qué el threshold proporcional al 50% del CAF es innecesario:**

El SII ya tiene su propio mecanismo de proporcionalidad: **MAX_AUTOR**.
- Empresa nueva/pequeña → MAX_AUTOR=1 → aunque pidamos 200 folios, solo conseguimos 1
- Empresa establecida/grande → MAX_AUTOR=200 → conseguimos 200 de golpe

La fórmula `Math.max(20, cafTotalFolios * 0.5)` intenta resolver un problema que el SII ya resuelve internamente. Además añade complejidad:
- Para una empresa con historial bajo: `max(20, 2) = 20` → dispara replenish antes de usar el 1.er folio del CAF de 5
- Para una empresa grande: `max(20, 100) = 100` → los FOLIOS_DISP en el SII son también altos → riesgo de acercarse a la zona de advertencia del SII (proporcional a esa empresa)

**Conclusión: mantener `CAF_REPLENISH_THRESHOLD = 20` (valor fijo actual).**

- Es un número pequeño y seguro para CUALQUIER empresa (siempre < 20 FOLIOS_DISP de margen)
- No intenta duplicar la lógica del SII; deja que MAX_AUTOR sea el throttle natural
- El `singletonKey` en pg-boss evita encolar múltiples replenish

**Para empresas con CAFs grandes y muchas cajas:** el riesgo de burst sin folios
se mitiga con el slot `_next` (tipo 39 ya lo tiene). Para tipo 33 con alto volumen,
extender `_next` a factura (ítem 14) — no manipular el threshold.

**No requiere cambio de código.** El threshold de 20 ya está implementado correctamente en `jobs.ts`.

#### 10. `_next` slot solo existe para tipo 39 (boleta)

Tipos 33 (factura), 34 (factura exenta), 41 (boleta no afecta) reemplazan el CAF
directamente sin pre-carga. Si un cliente FULL emite muchas facturas en hora punta
y el CAF se agota, hay un gap entre el agotamiento y el nuevo CAF.

Para la mayoría de restaurantes (solo boletas tipo 39) esto no aplica. Pero para
comercios que emiten facturas frecuentemente, considerar extender el patrón `_next`
a tipo 33 con columna `sii_caf_xml_factura_next`.

#### 11. ✅ Vigencia CAF — runtime parsing `<FA>` (sin migración DB) — *Implementado 10/06/2026*

Los CAF expiran 180 días desde `<FA>`. Implementado sin migración: se parsea `<FA>` del XML en runtime.

**Helpers (en `jobs.ts` y `transacciones.ts`):**
```ts
function isCafExpired(xml): boolean        // expira < NOW
function isCafExpiringSoon(xml, days): boolean  // expira < NOW + days
```

**En `transacciones.ts`:**
- Si `isCafExpired(cafXml)` → `cafXml = null` → folio=0 → replenish-caf se encola
- `_next` promotion: guarda `!isCafExpired(nextXml)` para no promover _next expirado
- Trigger proactivo: `foliosRestantes < threshold || isCafExpiringSoon(cafXml, 30)` → replenish-caf

**En `jobs.ts` replenish-caf worker:**
- tipo-39: `cafAgotado = (folio agotado) || cafExpiraSoon` → solicita nuevo CAF antes de que expire
- tipos 33/34/41: mismo patrón

#### 12. PFX bytes en DB no están cifrados (solo la contraseña lo está)

`pfx-crypto.ts` cifra `sii_pfx_pass` (AES-256-GCM) ✅ pero `sii_pfx_bytes` se guarda
como base64 sin cifrar en la tabla `empresa`.

Adicionalmente, el CLAUDE.md indica que el PFX se escribe a `/tmp/devlas-sii/` antes
de usarse y luego se elimina. En Railway (efímero) eso es aceptable, pero:
- Si hay un error antes del delete → el archivo queda en disco
- Railway puede tener múltiples instancias con `/tmp` compartida (depende del plan)

**Opciones:**
- Cifrar `sii_pfx_bytes` con la misma clave AES-256-GCM (migración de columna)
- O continuar con el enfoque actual si Railway garantiza `/tmp` privada por instancia
  y el delete está en un `finally` block

Verificar que el delete del PFX temporal esté en `finally`, no en el happy path.

#### 12. Fallback de carga manual de CAF

Cuando el scraping falla (cambio en HTML del SII, IP bloqueada), el usuario
debe poder subir el XML del CAF descargado manualmente desde el portal SII.

- Endpoint `POST /caf/upload` que reciba el XML y lo procese igual que un CAF automático
- Sin cambios en la librería — solo en API y frontend

---

---

## Orden de implementación (revisado post-auditoría + HARs)

| Prioridad | Item | Archivo | Estado |
|-----------|------|---------|--------|
| 1 | **Detectar "NO SE AUTORIZA"** → `TIMBRAJE_BLOQUEADO` (no retriable) | `CafSolicitor.js` | ✅ Implementado 10/06/2026 |
| 2 | Errores tipados `errorCode` + `replenish-caf` respeta no-retriable | `CafSolicitor.js` + `sii.ts` + `jobs.ts` | ✅ Implementado 10/06/2026 |
| 3 | Rate limiting 1001ms entre sesiones (no entre pasos internos) | `CafSolicitor.js` | ✅ Implementado 10/06/2026 |
| 4 | SIGTERM hook logout | `index.ts` (API) | ✅ Ya existía en API |
| 5 | Headers Chrome completos (del HAR real) | `SiiSession.js` | ✅ Implementado 10/06/2026 |
| 6 | Timeout explícito en `got` | `SiiSession.js` | ✅ Implementado 10/06/2026 |
| 7 | Errores de negocio adicionales (WAAP) | `CafSolicitor.js` | ✅ Implementado 10/06/2026 |
| 8 | Backoff exponencial timeouts/5xx | `SiiSession.js` | ✅ Implementado 10/06/2026 |
| 9 | ~~Threshold proporcional al CAF~~ — **DESCARTADO** | — | 🚫 Descartado |
| 10 | **Vigencia CAF — runtime parsing `<FA>` (sin migración DB)** | `jobs.ts` + `transacciones.ts` | ✅ Implementado 10/06/2026 |
| 11 | Auditar delete PFX temporal en `finally` | `sii.ts` / API | ✅ Ya correcto — `withPfxTmp` y `_tmpPfxMuestras` tienen `finally` |
| 12 | Fallback manual CAF upload | API + frontend | ✅ Implementado 10/06/2026 |
| 13 | Cifrar `sii_pfx_bytes` en DB | Migración Drizzle | ✅ Implementado 10/06/2026 |
| 14 | Slot `_next` para tipo 33 (factura) | `jobs.ts` + schema | ✅ Implementado 11/06/2026 |

---

## Notas legales

- La automatización del CAF **no está prohibida** por ninguna resolución exenta del SII
- La Res. Exenta N°45/2003 regula quién solicita (firmante autorizado + cert digital), no el mecanismo
- La Ley 19.799 valida el acto si el cliente autoriza el uso de su PFX — documentar esto contractualmente
- Winner POS obliga carga manual por decisión de arquitectura, no por impedimento legal
- El SII publica guías técnicas de convivencia (1 TPS, logout, sin sesiones paralelas) — no prohibiciones
