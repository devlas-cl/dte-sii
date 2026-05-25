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
