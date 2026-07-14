# Plan — Fix SESSION_EXPIRED en CafSolicitor.solicitar()

Fecha: 2026-07-13
Bug report base: `/private/tmp/cafsolicitor-bug-report.md`

## 1. Diagnóstico confirmado

`CafSolicitor.solicitar()` (CafSolicitor.js:220) hace un POST "al aire" a
`of_solicita_folios` **antes** de haber hecho ningún GET en esa sesión concreta:

```js
let response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios', fields); // POST directo, sin GET previo
if (this._requiresAuthentication(response.body)) {
  const authResult = await this.session.ensureSession(...);   // ahora sí GET + login
  if (authResult.body) {
    response = await this.session.submitForm(...);            // POST de nuevo — pero sigue fallando
  }
}
```

El SII (Tivoli/F5 load balancer) liga la cookie de sesión al *flujo de navegación*
que la generó: GET (con redirect a login si hace falta) → **POST al mismo path
dentro de esa misma cadena de requests**. Un POST que no fue precedido de un GET
"fresco" a ese path en la misma sesión es tratado como fuera de contexto y
redirigido a auth, sin importar que las cookies sean válidas para otros paths.

Esto ya está resuelto correctamente en el resto del archivo: `_processMultiStepFlow`,
`_processStep3`, `_processConfirmFolio`, etc. **nunca** hacen un POST ciego — siempre
parten del HTML devuelto por el paso anterior, extraen `<form action>` + hidden
inputs (`SiiSession.extractFormAction` / `extractInputValues`) y arman el submit
sobre eso. `FolioService.consultarFolios` hace exactamente lo mismo: `ensureSession()`
primero, parsea el form del body devuelto, y recién ahí hace `submitForm`.
El primer paso de `solicitar()` es el único lugar de todo el flujo que rompe ese patrón.

**Confirmación adicional:** `BoletaCert`/`FolioService` funcionan con el mismo
certificado porque nunca hacen ese POST-sin-GET-previo; el puente de cookies
`SiiPortalAuth` ↔ `SiiSession` (CafSolicitor.js:83-106) es una pista falsa — las
cookies que llegan son válidas, el problema es el *orden de requests*, no el
*formato de cookie*.

## 2. Opciones evaluadas

### Opción A — Fix mínimo y quirúrgico (recomendada para este fix)
Solo en `CafSolicitor.solicitar()`:
1. `ensureSession('/cvc_cgi/dte/of_solicita_folios')` **primero**, siempre (no como fallback tras un fallo).
2. Extraer `formAction` + hidden inputs del HTML que devuelve (mismas utilidades ya usadas en `_processMultiStepFlow`).
3. `submitForm(formAction, { ...hiddenFields, ...fields })` — un submit real, no un POST ciego.
4. Si `ensureSession` ya deja detectada una autenticación fallida real (cookie inválida tras login), reportar `SESSION_EXPIRED` igual que hoy.

Alcance: ~15-20 líneas en un solo método de un solo archivo. No toca `SiiSession.js`,
`SiiPortalAuth.js`, `SiiSessionStore.js`, ni la forma en que otros consumidores llaman
a la librería. Es un cambio de comportamiento **puramente correctivo**: hoy ese primer
POST nunca tiene éxito (siempre cae al branch de auth), así que remover el POST ciego
inicial no puede romper ningún caso que hoy funcione.

### Opción B — Session manager unificado (refactor completo)
Unificar `SiiSession` + `SiiPortalAuth` + `SiiSessionStore` en un solo manager:
formato de cookie único, un solo auth, persistencia configurable, `submitForm` que
siempre hace GET previo internamente. Usado por `CafSolicitor`, `SiiPortalAuth`,
`FolioService`, `CertRunner`.

Correcto en el papel, pero:
- Toca **4+ clases públicas** consumidas hoy por varios consumidores en producción
  (todos en `^2.12.8`) — este paquete es público en npm y no hay forma de saber
  cuántos consumidores externos dependen de estas clases.
- **Cero tests automatizados** existen hoy para ninguna de las 5 clases (solo
  `test/session-sharing.js`, sin wiring a `npm test`, sin CI). Un refactor de esta
  magnitud sin red de seguridad es alto riesgo para una librería que interactúa con
  el SII (autoridad tributaria) en producción.
- `SiiPortalAuth` tiene un patrón singleton-en-constructor (retorna la instancia
  cacheada, `SiiPortalAuth.js:94-96`) que decenas de call sites en los consumidores
  asumen implícitamente. Cambiar esa forma es un cambio de contrato.
- Blast radius incluye a consumidores externos que no están en esta conversación
  y que tendrían que validar el cambio en su propio flujo.

### Opción C — Usar solo SiiPortalAuth en CafSolicitor (sin tocar SiiSession)
Intermedia: elimina la duplicidad de auth pero sigue siendo un cambio estructural en
`CafSolicitor` (nueva capa de request manual con `got` + cookies-string, reimplementando
lo que `FolioService` ya hace). Concentra riesgo en un archivo pero sigue siendo más
invasivo que A sin resolver el problema real más rápido.

## 3. Recomendación

**Aplicar Opción A ahora** como fix de patch version (2.12.9), acotado a
`CafSolicitor.solicitar()`. Es el cambio de menor blast radius que ataca la causa
raíz real (orden GET→POST dentro de la misma sesión), reutiliza utilidades que ya
existen y están probadas en el resto del mismo archivo, y no cambia ningún contrato
público de `SiiSession`/`SiiPortalAuth`/`FolioService`.

**Tratar la Opción B como iniciativa separada**, con prerequisito explícito: agregar
tests de unidad (mockeando `got`/`https`) para el comportamiento actual de
`_sessionRegistry`, `_instanceRegistry` y `SiiSessionStore` *antes* de tocarlos, y
tener en cuenta que hay otros consumidores externos de esta dependencia pública.
No se hace en este cambio.

## 4. Cómo se usa hoy en producción (consumidores reales)

| Consumidor | Tipo de proceso | Uso de CafSolicitor/FolioService |
|---|---|---|
| `devlas-cloud-api-node` (Railway, 1 instancia) | Servidor persistente (Hono) | `src/routes/sii.ts::solicitarCafParaEmpresa()` instancia `CafSolicitor` con `pfxBuffer` desde BD; job pg-boss `replenish-caf` (`jobs.ts:510-609`, singletonKey por comercio+tipo) lo dispara automáticamente cuando quedan <20 folios |
| Otros consumidores externos del paquete público | Servidor persistente | Cada consumidor externo integra `CafSolicitor`/`FolioService` según su propia arquitectura; al ser un paquete npm público no hay visibilidad completa de todos los usos |
| Scripts CLI (`scripts/cert-v2/*`) | Proceso de un solo uso | Certificación SII manual, no afecta producción |

**Impacto de este bug hoy:** cualquier comercio cuyo CAF se agote dispara
`replenish-caf` → `CafSolicitor.solicitar()` → falla siempre con `SESSION_EXPIRED` →
el comercio se queda sin folios para timbrar boletas/facturas hasta intervención manual.
Es el mismo código que usan otros consumidores del paquete, así que cualquiera en
`^2.12.8` con este `CafSolicitor.js` está expuesto al mismo bug.

## 5. Riesgos del fix propuesto (Opción A)

- **Riesgo bajo de regresión**: el primer POST hoy *nunca* tiene éxito (por diseño
  actual siempre cae al branch `_requiresAuthentication` → retry). Quitar ese POST
  ciego inicial y reemplazarlo por `ensureSession` + submit real no puede romper un
  camino feliz que no existe hoy.
- **Riesgo de reintroducir el bug de "demasiadas sesiones"**: `ensureSession` ya
  maneja `_tryForceCloseSessions` — no hay cambio ahí, se reutiliza tal cual.
- **Riesgo de que el form real no tenga los hidden fields esperados**: mitigado
  porque `{ ...hiddenFields, ...fields }` prioriza los campos explícitos del caller
  sobre lo que venga del HTML — mismo patrón usado en `_processMultiStepFlow`.
- **Riesgo de coordinación con otros consumidores**: al ser `^2.12.8` (caret), un
  patch 2.12.9 se auto-adopta en el próximo install de cualquier consumidor externo
  sin que lo pida explícitamente. El fix es estrictamente corrector (arregla un
  flujo 100% roto), pero de todas formas conviene documentarlo bien en el
  changelog antes de publicar.
- **Sin tests de regresión automatizados**: no existen para este flujo. La validación
  será manual contra el SII real (certificación y/o producción) — como ya se hace
  hoy para todo cambio en esta librería (ver `CLAUDE.md`: "Test changes manually
  before updating the version used by devlas-cloud-api-node").

## 6. Plan de implementación (Opción A)

1. En `CafSolicitor.solicitar()` (CafSolicitor.js:211-235), reemplazar:
   - POST ciego inicial → por `ensureSession('/cvc_cgi/dte/of_solicita_folios')` primero.
   - Parsear `formAction` (`SiiSession.extractFormAction`, fallback al path fijo) y
     `hiddenFields` (`SiiSession.extractInputValues`) del body devuelto por `ensureSession`.
   - `submitForm(formAction, { ...hiddenFields, ...fields })`.
   - Si el body de `ensureSession` sigue mostrando autenticación tras el login interno
     (ya lo detecta `ensureSession`/`loginWithCertificate`), seguir devolviendo
     `SESSION_EXPIRED` con limpieza de `_sessionRegistry` (comportamiento ya existente,
     sin cambios).
2. Dejar intacto todo lo demás: `_processMultiStepFlow`, `_processStep3`,
   `_processConfirmFolio`, `_processGeneraFolio`, `_processGeneraArchivo`, rate
   limiting, manejo de `MAX_AUTOR`, `RANGO_YA_AUTORIZADO`, `WAAP_BLOCKED`, etc.
3. No tocar `SiiSession.js`, `SiiPortalAuth.js`, `SiiSessionStore.js`, `FolioService.js`.
4. Bump `package.json` de `dte-sii` a `2.12.9` (patch — bugfix, sin cambio de API).
5. Actualizar `CHANGELOG`/notas de versión si el repo las mantiene.

## 7. Plan de validación

1. Test manual contra **certificación** (maullin.sii.cl) con el mismo certificado
   RUT 78206276-K usado en el bug report — reproducir exactamente el caso que
   fallaba y confirmar CAF obtenido.
2. Repetir para al menos 2 tipos de documento (ej. 39 boleta, 33 factura) y para
   una cantidad que dispare el flujo de `MAX_AUTOR` reducido, para confirmar que
   el resto del flujo multi-paso sigue intacto.
3. Si es posible, repetir contra **producción** (palena.sii.cl) con un comercio real
   de bajo riesgo, fuera de horario pico.
4. Verificar en logs que `_sessionRegistry`/`SiiSessionStore` siguen compartiendo
   sesión correctamente con `SiiPortalAuth` (que otros flujos como `BoletaCert`
   sigan funcionando sin regresión — no debería verse afectado porque no se tocó
   ese puente).
5. Solo después de validar manualmente, actualizar la versión consumida en
   `devlas-cloud-api-node` (`package.json` → `^2.12.9`) y probar `replenish-caf`
   end-to-end contra certificación antes de deployar a producción.

## 8. Seguimiento fuera de este fix

- Documentar el bug y el fix disponible en `2.12.9` en el changelog público del
  paquete, dado que hay consumidores externos de esta dependencia.
- Agregar el punto "registries en memoria de `dte-sii` no cubiertos por la migración
  a Redis" al checklist de `devlas-cloud-api-node/docs/ESCALAMIENTO.md` antes de
  escalar a 2+ réplicas Railway (hallazgo colateral de esta investigación, no
  bloqueante para este fix).
- Evaluar agregar tests de unidad a `dte-sii` (mock de `got`) como prerequisito
  de cualquier futura Opción B.
