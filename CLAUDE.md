# @devlas/dte-sii

## What is this repo?

**CJS Node.js library** for Chilean electronic invoicing (DTE — Documento Tributario Electrónico).
Handles XML generation, digital signing, SII SOAP web services, CAF management and full SII certification.

Published as `@devlas/dte-sii` (MIT). Used internally by `devlas-cloud-api-node` via `createRequire`.

---

## Stack

- **Node.js 18+** — CommonJS (`"main": "index.js"`), NOT ESM
- **Plain JavaScript** — no TypeScript source, types in `dte-sii.d.ts`
- No build step — source files ARE the distributable

---

## Project Structure

```
├── index.js              ← Main export (re-exports all public classes)
├── dte-sii.d.ts          ← TypeScript type definitions for consumers
├── DTE.js                ← Document builder (generates XML payload)
├── Signer.js             ← XML digital signing with PFX certificate
├── Certificado.js        ← PFX certificate loader/wrapper
├── CAF.js                ← CAF (Código de Autorización de Folios) parser
├── FolioRegistry.js      ← Folio tracking and assignment
├── FolioService.js       ← High-level folio management
├── EnviadorSII.js        ← SOAP sender to SII endpoints
├── Envio.js              ← EnvioDTE/EnvioBOLETA XML envelope builder
├── BoletaService.js      ← Electronic boleta workflow
├── SiiCertificacion.js   ← Full SII certification automation
├── SiiPortalAuth.js      ← Portal SII authentication (PFX-based)
├── SiiSession.js         ← SII session / cookie management
├── CafSolicitor.js       ← Automated CAF request to SII
├── LibroBase.js          ← Base class for electronic books
├── LibroCompraVenta.js   ← Libro de Compras y Ventas
├── LibroGuia.js          ← Libro de Guías de Despacho
├── ConsumoFolio.js       ← RCOF (Resumen Consumo de Folios) for boletas
├── WsReclamo.js          ← WSRECLAMO — ACD/ERM/RCD/RFP/RFT acceptance
├── utils.js              ← Shared helpers (RUT, date formatting, etc.)
├── cert/                 ← SII certification helpers
├── utils/                ← Additional utility modules
└── docs/                 ← SII documentation references
```

---

## Architecture Rules

### Module format
- **CJS only** — do NOT convert to ESM. Consumers use `createRequire` to import.
- No default export — all classes/functions exported as named CommonJS exports via `module.exports`.
- `index.js` re-exports everything: when adding a new class, add it to `index.js`.

### Classes
- One class per file. File name matches the class name exactly.
- Constructor receives all required dependencies — no hidden global state.
- Async methods return Promises — no callback API.

### Type definitions (`dte-sii.d.ts`)
- When adding a new public class or modifying signatures, update `dte-sii.d.ts`.
- Consumers (TypeScript projects) rely entirely on this file — keep it accurate.

---

## Rules

### Integrity
- This library directly interfaces with the Chilean SII (Tax Authority). Any bug can cause invalid DTE submission or failed certification.
- Test changes manually before updating the version used by `devlas-cloud-api-node`.
- The `cert/` folder contains SII-specific certification flows — treat changes there with extra care.

### Versioning
- Follow semver: patch for bugfixes, minor for new features, major for breaking changes.
- Breaking changes affect all consumers — coordinate with `devlas-cloud-api-node` before bumping major.

### Clean Code
- No `console.log` left in production paths — use structured error returns or thrown errors.
- Validate RUT format and required fields at the entry point of each public method.
- Error messages must be descriptive enough to debug SII rejections.

### Maintainability
- SII specs change periodically — when the SII updates a web service, update the corresponding class only.
- Keep `docs/` up to date with relevant SII documentation page references.

---

## Commands

```bash
node -e "const { DTE } = require('.')"   # quick smoke test
```

## Integration in devlas-cloud-api-node

```ts
// ESM → CJS interop pattern (required in every file that uses this lib)
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Certificado, CAF, DTE } = _require('@devlas/dte-sii') as Record<string, new (...a: any[]) => any>
```

> WsReclamo is not re-exported from the main `index.js` — import directly:
> `_require('@devlas/dte-sii/WsReclamo')`

---

## Notas para deploy en producción (cualquier consumidor de esta librería)

Dos variables de entorno del **proceso Node que corre esta librería** son necesarias en
producción — no son de la librería en sí, pero su ausencia rompe la certificación/emisión
silenciosamente. Aplican a cualquier consumidor, sin importar dónde/cómo se hostee.

### 1. `TZ=America/Santiago` obligatorio

`CertRunner._getFechaHoy()` (usada por `declararAvance`/`declararLibros`/`ejecutarSimulacion`,
duplicada en dos lugares del archivo — está pendiente deduplicarla) construye la fecha con
`new Date().getDate()/getMonth()/getFullYear()`, dependientes del timezone del **proceso**, sin
ninguna conversión explícita a Chile.

Si el contenedor corre en UTC (default de la mayoría de plataformas cloud si no se configura
`TZ`), hay una ventana real todas las noches — aprox. 20:00 a 00:00 hora Chile (UTC-3/-4) — en
la que `new Date()` ya reporta el día siguiente en UTC mientras en Chile sigue siendo el día
anterior. El SII puede rechazar la declaración de avance por fecha inconsistente durante esa
ventana. Fix: setear `TZ=America/Santiago` en las variables de entorno del proceso — no requiere
Docker ni orquestador de por medio, alcanza con la variable de entorno del servicio que sea.

### 2. Persistencia de sesión SII (`DATADIR` / `SII_SESSION_PATH`)

`SiiPortalAuth` cachea las cookies de sesión en disco para evitar el error "máximo de sesiones
autenticadas" del SII:

```js
// SiiPortalAuth.js
const SESSION_CACHE_PATH = path.join(
  process.env.DATADIR || path.join(os.homedir(), 'AppData', 'Roaming', 'POS'),
  'sii_session_cache.json'
);
```

El fallback (`AppData/Roaming/POS`) es una convención de Windows — tiene sentido para el POS
Electron (que sí corre en Windows), **no** para un servidor Linux. Si `DATADIR` no está seteado
en un servidor Linux, igual se crea esa ruta (Node no valida el formato), pero:

- Si el filesystem del contenedor es efímero (se resetea en cada redeploy/restart, como es
  default en la mayoría de PaaS), la sesión se pierde en cada deploy → cada redeploy fuerza un
  re-login completo contra el SII. Deploys frecuentes pueden disparar el bloqueo de "máximo de
  sesiones autenticadas" para el RUT.
- **Nota aparte, incluso con `DATADIR` persistente**: el cache guarda **una sola sesión a la
  vez** (compara `certHash` contra lo guardado — `SiiPortalAuth.js` método `_cargarSesionCache`).
  En un servidor multi-tenant (muchos comercios, cada uno con su propio certificado), el cache
  se pisa cada vez que se usa un certificado distinto al último guardado. El beneficio real de
  persistirlo en un volumen no es "evitar todo re-login" (eso ya no aplica con múltiples
  certificados activos) — es evitar perderlo **en cada redeploy** para el comercio que más lo usa.

`FolioService`/`CafSolicitor` tienen un mecanismo relacionado pero separado vía
`process.env.SII_SESSION_PATH` (ruta a un archivo, no a un directorio) — mismo riesgo de
persistencia si el proceso corre en un filesystem efímero.

**Fix conceptual** (genérico — adaptar a la infraestructura real de cada consumidor, sea cual sea):
1. Montar un volumen/disco persistente en la plataforma de hosting que corresponda.
2. Apuntar `DATADIR` (y `SII_SESSION_PATH` si se usa) a una ruta dentro de ese volumen.
3. Confirmar que el volumen sobrevive redeploys, no solo restarts.
