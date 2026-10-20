---
name: release-dte-sii
description: Cómo se publica una versión de @devlas/dte-sii (elegir número, commit de release, tag, npm publish y subir el pin en el consumidor). Usar SIEMPRE que se pida publicar, cortar una versión o "llevar a producción" un cambio de esta librería. Nunca se hace tag ni npm publish a mano sin seguirla.
---

# Publicar una versión de dte-sii

Mergear un PR a `master` **no publica nada**: no hay workflow de publicación. Los consumidores
reciben un cambio recién cuando existe una versión nueva en npm y ellos suben su pin. Por eso
"está en master" y "está en producción" son cosas distintas acá.

Publicar a npm es irreversible (una versión publicada no se puede reemplazar) y la hace quien
mantiene el repo con su sesión de npm. **Un agente prepara el release y nunca ejecuta
`npm publish` ni crea el tag sin la orden expresa del usuario en ese momento.**

## 0. Antes de empezar

```bash
git fetch --tags origin
npm view @devlas/dte-sii version      # lo que hay publicado hoy
git show origin/master:package.json | grep '"version"'
git tag --sort=-creatordate | head -3
gh pr list --state open                # que no haya otro release en vuelo
```

- Si la versión de `master` ya es mayor que la de npm, alguien preparó un release que no se
  publicó: no prepares otro, pregunta.
- Si otra sesión ya abrió un PR `chore(release)`, no dupliques.
- Los PRs de cambios ya deben estar mergeados, con CI verde. El release no mezcla cambios de código.

## 1. Elegir el número (semver)

Se decide leyendo `## [Unreleased]` del `CHANGELOG.md`, y la decide el usuario si hay duda:

| Lo que trae Unreleased | Sube |
|---|---|
| Solo correcciones sin cambio visible para quien instala | patch |
| Función nueva, valor nuevo en una unión de tipos, campo nuevo, o un campo que cambia de contenido | minor |
| Firma o contrato que rompe a un consumidor existente | major (anunciar antes en el CHANGELOG) |

Una entrada que dice "cambio de comportamiento visible" o "valor nuevo en la unión" es al menos minor.

## 2. El commit de release (un PR propio)

Rama `chore/release-X.Y.Z` desde `origin/master`. Un solo commit, `chore(release): X.Y.Z`, que toca:

1. `package.json`: `version`.
2. `package-lock.json`: `version` (las dos líneas de la raíz). Usa `npm version X.Y.Z --no-git-tag-version`.
3. `CHANGELOG.md`: debajo de `## [Unreleased]` deja la sección vacía y mueve las entradas a
   `## [X.Y.Z] - AAAA-MM-DD`. No reescribas el texto de las entradas.

Nada más: sin código, sin tests, sin README. Antes de abrir el PR:

```bash
npm test && npm run scan && npm run types
npm pack --dry-run                      # que el contenido publicado sea el esperado
```

Mergea cuando el CI esté verde (el merge puede quedar bloqueado unos segundos tras un push
mientras corren los checks: espera, no uses `--admin`).

## 3. Publicar (solo con orden expresa, lo ejecuta el usuario)

Desde un checkout limpio de `master` con la versión ya mergeada:

```bash
git switch master && git pull
npm view @devlas/dte-sii version        # debe seguir siendo la anterior
npm publish                             # requiere sesión de npm del mantenedor
git tag vX.Y.Z && git push origin vX.Y.Z
gh release create vX.Y.Z --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

El agente le da estos comandos al usuario para que los corra con `! <comando>`. Si el usuario
ordena expresamente que el agente publique y hay sesión de npm, se ejecutan en este orden.
Después verifica: `npm view @devlas/dte-sii version` debe mostrar X.Y.Z.

## 4. Subir el pin en el consumidor

Cada consumidor fija la versión exacta. Hoy: `devlas-services/services/dte` (`@devlas/dte-sii`
en su `package.json`, y el lockfile de pnpm). Se hace en el repo del consumidor, en su propio PR:

1. Cambiar el pin a X.Y.Z y regenerar el lockfile.
2. Correr las pruebas del servicio.
3. Si el consumidor tenía un arreglo provisional para el mismo problema, quitarlo en ese PR.
4. Ese merge sí despliega a producción: requiere orden expresa.

## Qué NO hacer

- No elegir número de versión dentro de un PR de cambios (eso es de este proceso).
- No `git tag` ni `git push --tags` sin haber publicado: un tag sin versión en npm engaña.
- No publicar desde una rama que no sea `master` actualizado.
- No republicar el mismo número: si algo salió mal, se publica un patch nuevo.
- Este repo es público: ni el CHANGELOG ni las notas llevan RUTs, nombres de clientes ni rutas locales.
