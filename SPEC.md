# Spec: Tareas + Carga de Horas Self-Service + Rol Colaborador

## Objective

Hoy la app (`gantt-app` / Zircon Planner) es administrada 100% por el admin: las horas se cargan por importación masiva (Clockify, Excel SCC, CSV) y no existe ningún concepto de "tarea" dentro de un proyecto.

Este spec abre la carga de horas a usuarios finales, al estilo Clockify, con dos modalidades (detallada por tarea vía matriz semanal, y bulk mensual para gente Time & Material), más un nuevo rol "colaborador" con acceso acotado a un puñado de pantallas. El admin mantiene control total: crea las tareas, conserva todos los flujos de importación masiva existentes, y gana un nuevo rol para asignar.

**Éxito** = un usuario cuyo email matchea un `Resource` puede loguearse, ver solo las pantallas permitidas, cargar horas de ambas formas, editar/borrar solo sus propias entradas, cargar sus propias vacaciones, cambiar su contraseña — y ningún endpoint de escritura acepta acciones fuera de su propio `resourceId` aunque se llame directo a la API.

Fuera de alcance de este spec (iniciativas separadas a planificar después): migración del repositorio a la organización de GitHub de Zircontech, y auditoría/reorganización de la estructura general del proyecto.

## Hallazgos clave de la exploración

- **`User` (login) y `Resource` (persona) son tablas separadas sin vínculo.** `Resource` no tiene campo `email`. Hay que agregarlo y vincular por igualdad exacta de email (no la heurística de iniciales que usa hoy el import de Clockify).
- **Permisos son por página, todo-o-nada** (`Role` → `PagePermission`, admin bypass total). No hay noción de "solo lectura" dentro de una página — hay que agregar chequeos de rol condicionales en el cliente **y** endurecer las rutas de escritura en el servidor.
- **`/api/projects/[id]` (PUT y DELETE) no tiene ningún check de autenticación/rol hoy** — cualquier sesión válida puede editar/borrar proyectos vía API directa, sin pasar por la UI. Esto se corrige como parte de este trabajo (no es opcional: si no, "colaborador no puede editar proyectos" sería una restricción cosmética).
- **No existe modelo `Task`.** Lo más cercano es `Assignment` (asignación % para el Gantt), que no sirve para carga de horas por tarea.
- `TimeEntry` ya tiene `entryType` (regular/extra) — se reutiliza tal cual, se le agrega `taskId` opcional.

## Decisiones confirmadas

1. **Vínculo User↔Resource**: por email exacto (`Resource.email` nuevo, único, nullable).
2. **Tareas**: solo el admin puede crear/editar/borrar `Task` por proyecto.
3. **Colaborador — acceso**:
   - `/projects`: solo lectura (ve listado, no crea/edita/borra).
   - `/holidays`: feriados en solo lectura; **vacaciones puede cargar las propias** (nueva auto-gestión, acotada a su propio `resourceId`).
   - Puede cambiar su propia contraseña (nueva pantalla de perfil, disponible para cualquier usuario autenticado, no solo colaboradores).
4. **Carga de horas** reutiliza los mismos datos que ya existen (`TimeEntry`: resourceId, projectId, date, hours, entryType) + `taskId` opcional nuevo.
5. **Modo detallado (día a día)**: permite **varias tareas distintas el mismo día** (estilo Clockify real) → el unique constraint de `TimeEntry` debe incluir `taskId`.
6. **Modo T&M (bulk mensual)**: para usuarios Time & Material que no discriminan por tarea. Autocompleta el mes salteando **solo fines de semana** (no cruza feriados/vacaciones — el usuario ajusta manualmente esos días). `taskId` queda `null` en estas entradas.
7. **Reporte propio**: el colaborador ve únicamente sus propias horas, filtrado server-side por su `resourceId` resuelto de sesión — nunca ve datos de otros recursos.
8. **UI de carga detallada = matriz semanal, no popups.** En vez de un modal por cada entrada, `/mis-horas` (modo detallado) muestra una grilla tipo Clockify: filas = tareas (del proyecto elegido), columnas = los 7 días de la semana seleccionada, celdas editables inline. Agregar una tarea a la grilla suma una fila nueva; cada celda es un input de horas que guarda al salir del campo (blur) o con autosave con debounce. Fila de "Total del día" al pie y "Total de la semana" por fila — mismo lenguaje visual que ya usa `admin/daily-report` (celdas fijas, sticky headers).

## Tech Stack

Sin cambios: Next.js 14.2 App Router, Prisma 5.22 + Turso/libSQL, NextAuth 4 (JWT, credentials + bcryptjs), TanStack Query v5, Tailwind, lucide-react. Sin librerías nuevas.

## Commands

```
Dev:    npm run dev
Build:  npm run build
Lint:   npm run lint
Types:  npx tsc --noEmit
Migrar: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/<nueva>.ts
```

## Project Structure

```
app/
  perfil/page.tsx              → cambio de contraseña (todos los usuarios)
  mis-horas/page.tsx           → selector semana + proyecto → grilla tareas×días (inline, sin popups) + toggle a modo bulk T&M
  mi-reporte/page.tsx          → pivot de solo-sus-horas (reutiliza lógica de admin/daily-report)
  api/tasks/route.ts           → GET (por projectId), POST (admin)
  api/tasks/[id]/route.ts      → PUT/DELETE (admin)
  api/me/resource/route.ts     → resuelve session → Resource propio
  api/me/time-entries/route.ts → GET (semana/mes), PUT upsert por celda (resourceId+projectId+taskId+date+entryType), POST bulk T&M, DELETE — todo acotado a resourceId propio
  api/me/password/route.ts     → PATCH, verifica currentPassword + hashea nueva
  api/me/vacations/route.ts    → POST/DELETE, acotado a resourceId propio
prisma/schema.prisma           → +Task, +TimeEntry.taskId, +Resource.email
scripts/add-task-and-email.ts  → migración Turso (idempotente, sigue el patrón de add-entry-type.ts)
```

Páginas existentes que se tocan: `app/projects/page.tsx`, `app/holidays/page.tsx` (render condicional por rol), `app/api/projects/[id]/route.ts` y `app/api/vacations/route.ts` (harden server-side), `lib/auth.ts` (nuevo helper `requireSelfOrAdmin`).

## Code Style

Seguir el patrón ya establecido en el repo (ver `app/api/time-entries/route.ts`, `app/admin/daily-report/page.tsx`): rutas API con `export const dynamic = 'force-dynamic'`, `NextResponse.json`, tipos compartidos en `types/index.ts`, componentes cliente con `'use client'` + TanStack Query, estilos Tailwind + algún inline style puntual para tablas pivot.

Nuevo helper en `lib/auth.ts`:

```typescript
export async function requireSelfOrAdmin(resourceId: number) {
  const session = await getSession()
  const roles = getUserRoles(session)
  if (roles.includes('admin')) return session!
  const resource = await prisma.resource.findUnique({ where: { email: session?.user?.email ?? '' } })
  if (!resource || resource.id !== resourceId) throw new Error('Forbidden')
  return session!
}
```

## Testing Strategy

No hay suite automatizada en el repo — se mantiene el patrón manual ya usado: `npx tsc --noEmit` + QA manual en navegador (login como colaborador de prueba, probar cada flujo). Dado que `/api/me/*` es la superficie de seguridad más sensible (un colaborador no debe poder tocar datos de otro resourceId), se recomienda verificación manual explícita de "llamar la API directo con un resourceId ajeno y confirmar 403" antes de mergear, aunque no haya tests automatizados formales.

## Boundaries

- **Always**: hashear contraseñas con bcryptjs (patrón existente); todo endpoint de escritura nuevo pasa por `requireAdmin()` o `requireSelfOrAdmin()`; resolver `resourceId` siempre server-side desde la sesión, nunca confiar en un `resourceId` que mande el cliente.
- **Ask first**: correr la migración de schema contra Turso de producción; crear el rol "colaborador" y sus `PagePermission` en datos de producción; cualquier cambio a los flujos de importación masiva existentes (Clockify/SCC/CSV) — no deberían tocarse en este trabajo.
- **Never**: permitir que una request con rol colaborador lea o escriba `TimeEntry`/`Vacation` de un `resourceId` que no sea el propio; exponer password hashes; remover o alterar las pantallas `/admin/*` existentes.

## Cambios de datos (`prisma/schema.prisma`)

```prisma
model Resource {
  // ...existente...
  email String? @unique
}

model Task {
  id        Int      @id @default(autoincrement())
  projectId Int
  name      String
  active    Boolean  @default(true)
  createdAt DateTime @default(now())

  project    Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  timeEntries TimeEntry[]
}

model TimeEntry {
  // ...existente...
  taskId Int?
  task   Task? @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@unique([resourceId, projectId, date, entryType, taskId])
}
```

**Nota técnica**: SQLite/Turso trata cada `NULL` como distinto en un índice único, así que el constraint no evita duplicados cuando `taskId` es `null` (caso T&M). El endpoint `/api/me/time-entries` para el modo T&M debe hacer "buscar entrada existente (resourceId+projectId+date+entryType+taskId IS NULL) y actualizar, si no existe insertar" en vez de confiar ciegamente en el `INSERT ... ON CONFLICT`.

Migración (`scripts/add-task-and-email.ts`): agrega columna `email` a `Resource`, crea tabla `Task`, agrega columna `taskId` a `TimeEntry`, recrea el índice único — todo idempotente, siguiendo el patrón de `scripts/add-entry-type.ts`.

## Success Criteria

1. Admin crea un `Resource` con email igual al de un `User` colaborador de prueba → el colaborador puede loguearse y el sistema resuelve su `resourceId`.
2. Admin crea 2-3 `Task` en un proyecto.
3. Colaborador entra a `/mis-horas`, elige proyecto y semana → aparece la grilla (filas = tareas, columnas = Lun-Dom). Agrega Tarea A y Tarea B como filas, escribe 3h y 2h en la misma columna (mismo día) → ambas celdas guardan sin popups, la fila "Total del día" refleja 5h.
4. Colaborador usa el modo T&M: elige proyecto + mes, autocompleta 8h en días hábiles (fines de semana salteados), edita un par de días manualmente, guarda → se crean/actualizan las filas correspondientes con `taskId = null`.
5. Colaborador ve `/mi-reporte` → solo sus propias horas, ningún otro recurso aparece.
6. Colaborador entra a `/projects` → ve el listado, no ve botones Nuevo/Editar/Eliminar; si llama `PUT /api/projects/1` directo con curl/fetch, recibe 403.
7. Colaborador entra a `/holidays` → ve feriados sin botón de agregar; puede cargar su propia vacación; si intenta borrar una vacación de otro `resourceId` vía API, recibe 403.
8. Colaborador entra a `/perfil`, cambia su contraseña, puede loguearse de nuevo con la nueva.
9. Flujos de admin existentes (import Clockify/SCC/CSV, control-horas, daily-report) siguen funcionando sin cambios.
10. `npx tsc --noEmit` pasa sin errores.

## Open Questions

- Campos de `Task` más allá de `name` y `active` (¿estimatedHours? ¿fechas?) — se propone mínimo viable, ampliable después.
- Alcance exacto de páginas vedadas al colaborador (`/gantt`, `/resources`, `/admin/*`, `/admin/control-horas`) se resuelve por el modelo default-deny de `PagePermission` ya existente — no requiere cambios de modelo, solo no otorgarle esos permisos al rol.

---

# Spec: Rediseño "Mis Horas" estilo Clockify + Mobile en toda la app

## Objective

El modo detallado de `/mis-horas` obliga hoy a elegir **un** proyecto arriba de la grilla antes de poder cargar nada, y agregar filas es un flujo de dos pasos separado de la tabla. El usuario adjuntó una captura de Clockify: ahí cada **fila** de la matriz es un proyecto+tarea elegido de forma independiente ("Internal Issues: Presales", "MOB Mantenimiento: Requerimientos Nicolas"), con una fila especial "+ Seleccionar proyecto" al pie para agregar más, y un botón `✕` a la derecha de cada fila para eliminarla.

Este spec tiene dos partes:
1. Rediseña el modo detallado de `/mis-horas` para igualar ese flujo de Clockify.
2. Adapta a mobile **todas las páginas de la app excepto Gantt y Control de Horas** — esas dos se excluyen a propósito porque son tablas/vistas anchas por naturaleza (grilla de fechas de meses/años, matriz de presupuesto por proyecto) donde forzar mobile degradaría la herramienta sin aportar valor real; se usan casi siempre desde escritorio.

**Éxito** = un colaborador puede, sin salir de la grilla semanal de `/mis-horas`: agregar una fila eligiendo proyecto y tarea, cargar horas de varios proyectos distintos en la misma semana, eliminar una fila (con confirmación si tiene horas cargadas) — y además, cualquier página de la app (salvo Gantt y Control de Horas) es usable desde un celular: se navega, se lee y se puede operar sin scroll horizontal de página completa ni elementos cortados. El modo Time & Material y el resto de la lógica de negocio no cambian.

## Hallazgos clave

- **No hace falta tocar el backend.** `GET /api/me/time-entries` sin `projectId` ya devuelve las entradas de toda la semana en cualquier proyecto; `GET /api/tasks` sin `projectId` ya devuelve todas las tareas. `Task.id` es un ID global (no reutilizado entre proyectos), así que las filas se pueden seguir indexando por `taskId` solo, sin necesitar una clave compuesta con `projectId`.
- No existe un endpoint de borrado masivo — `DELETE /api/me/time-entries?id=` borra una sola entrada. Para "eliminar fila" alcanza con disparar un `DELETE` por cada entrada de esa tarea en la semana visible (como mucho 7 llamadas), sin agregar endpoints nuevos.
- Las dimensiones de columna hoy son un objeto `style` fijo en píxeles (`NAME_W`, `CELL_W`), no clases de Tailwind — para achicarlas en mobile hace falta un breakpoint leído en JS (`window.matchMedia` / hook de resize), no alcanza con clases responsive directas sobre esos estilos inline.
- **El sidebar (`components/layout/Sidebar.tsx`) es fijo y ocupa 208px (o 64px colapsado) en TODAS las pantallas**, incluidas Gantt y Control de Horas. En un viewport de 375px eso deja ~165px para el contenido — ninguna página individual queda usable en mobile si esto no se resuelve primero. Es un cambio de shell, no de una página puntual, y beneficia a todas las páginas en alcance (incluida su versión mobile del propio Gantt/Control de Horas si el usuario los abre desde el celular, aunque esas dos no se rediseñen puertas adentro).
- Inventario de páginas de la app (`app/**/page.tsx`):

  | Página | En alcance mobile |
  |---|---|
  | `/mis-horas` | Sí — ya cubierta arriba (rediseño Clockify + mobile) |
  | `/mi-reporte` | Sí |
  | `/projects` | Sí |
  | `/resources` | Sí |
  | `/holidays` | Sí |
  | `/perfil` | Sí (ya es simple, ajustes menores) |
  | `/login` | Sí (ya es simple, ajustes menores) |
  | `/unauthorized` | Sí (ya es simple, ajustes menores) |
  | `/admin/users` | Sí |
  | `/admin/roles` | Sí |
  | `/admin/permissions` | Sí |
  | `/admin/daily-report` | Sí |
  | `/admin/hours` | Sí (tabs de import + tabla/resumen/gráficos) |
  | `/gantt` | **No** — excluida a pedido |
  | `/admin/control-horas` | **No** — excluida a pedido |

## Decisiones confirmadas

1. **Selector de proyecto único → picker por fila (`/mis-horas`).** Se saca el `<select>` de proyecto de arriba de la grilla. La fila "+ Seleccionar proyecto" al pie abre un picker de dos pasos (Proyecto → Tarea, reutilizando `<select>` simples como en el resto del repo) y agrega la fila a la grilla.
2. **Eliminar fila con horas cargadas**: pide confirmación (`confirm()`, mismo patrón que ya usa el resto de la app) y borra las entradas de esa fila para la semana visible. Sin horas, se quita directo sin confirmar.
3. **Modo Time & Material**: no se toca. Sigue en su pestaña separada, sin cambios de UI ni de comportamiento.
4. **Alcance de mobile: toda la app salvo Gantt y Control de Horas** (tabla de arriba). Esas dos quedan como están, en desktop, sin ningún ajuste.
5. **Sidebar → shell responsive.** Bajo un breakpoint (`< 768px`, mismo criterio que usa `resize_window` mobile del navegador de pruebas), el sidebar deja de ocupar espacio fijo: se colapsa a un drawer off-canvas que se abre con un botón hamburguesa en una barra superior nueva, y se cierra al elegir una página o tocar afuera. Arriba del breakpoint, el sidebar actual (expandible/colapsable) no cambia.
6. **Tratamiento por tipo de página** (aplicado a cada página en alcance):
   - **Tablas tipo pivot** (`/mi-reporte`, `/admin/daily-report`, la parte de feriados/vacaciones de `/holidays`): mismo patrón que ya se define para `/mis-horas` — scroll horizontal, primera columna `sticky`, columnas más angostas y texto ≥16px en inputs bajo el breakpoint mobile.
   - **Tablas de listado con acciones** (`/projects`, `/resources`, `/admin/users`, `/admin/roles`, `/admin/permissions`): scroll horizontal con la columna de nombre fija; si una tabla es angosta de por sí (pocas columnas, ej. `/admin/roles`), alcanza con que el contenedor no desborde el body.
   - **Pantallas de formulario/tabs** (`/admin/hours`): los tabs (Importar/Tabla/Resumen/Gráficos) y los controles de import (Clockify/CSV/SCC) pasan a apilarse verticalmente bajo el breakpoint en vez de quedar en fila.
   - **Pantallas simples** (`/perfil`, `/login`, `/unauthorized`): ya son angostas por diseño (`max-w-md` o similar) — solo se verifica que no haya overflow ni texto cortado.

## Tech Stack

Sin cambios — ver spec anterior. No se agregan librerías ni endpoints.

## Project Structure

Archivos que se tocan (todos ya existentes, ninguno nuevo):
```
components/layout/Sidebar.tsx      → drawer off-canvas + botón hamburguesa bajo el breakpoint
components/layout/AuthLayout.tsx   → barra superior mobile con el toggle del drawer
app/mis-horas/page.tsx             → reescritura del modo detallado (picker por fila) + mobile; modo T&M intacto
app/mi-reporte/page.tsx            → mobile
app/projects/page.tsx              → mobile
app/resources/page.tsx             → mobile
app/holidays/page.tsx              → mobile
app/perfil/page.tsx                → mobile (ajustes menores)
app/login/page.tsx                 → mobile (ajustes menores)
app/unauthorized/page.tsx          → mobile (ajustes menores)
app/admin/users/page.tsx           → mobile
app/admin/roles/page.tsx           → mobile
app/admin/permissions/page.tsx     → mobile
app/admin/daily-report/page.tsx    → mobile
app/admin/hours/page.tsx           → mobile
```
Explícitamente **no** se tocan: `app/gantt/page.tsx`, `app/admin/control-horas/page.tsx`.

## Code Style

Mismo patrón que ya usa cada archivo: componente cliente + TanStack Query, `<select>` planos para pickers (no autocomplete/combobox nuevo), estilos inline `style={{}}` para las celdas de tablas pivot (igual que `admin/daily-report`) + clases Tailwind para el resto. El hook de "es mobile" se resuelve una sola vez, compartido, con `useEffect` + `window.matchMedia('(max-width: 767px)')` (mismo corte que usa `resize_window` del navegador de pruebas), sin librerías nuevas — se puede extraer a `lib/use-is-mobile.ts` para no repetirlo en cada página.

## Testing Strategy

Igual que el resto del proyecto: sin suite automatizada, `npx tsc --noEmit` + QA manual en navegador. Para esta feature en particular, verificar manualmente:
- Cargar horas en 2 proyectos distintos la misma semana sin recargar la página.
- Eliminar una fila con horas → aparece confirmación → se borran las entradas de esa fila (verificar contra la DB o recargando la grilla).
- Eliminar una fila sin horas → se quita sin confirmación.
- `resize_window` a `mobile` (375×812) en **cada página en alcance** (ver tabla de arriba): el sidebar se colapsa a drawer con hamburguesa, ninguna página tiene scroll horizontal de body completo (solo scroll horizontal dentro del contenedor de tabla cuando corresponde), no hay texto cortado ni botones inalcanzables.
- `resize_window` a `mobile` en `/gantt` y `/admin/control-horas`: confirmar que siguen exactamente igual que antes (sin cambios), aparte de heredar el drawer del sidebar.

## Boundaries

- **Always**: mantener el estilo visual ya establecido (paleta `#0170B9`/`#005a94`/`#1e3a5f`, sticky headers, mismo lenguaje que `admin/daily-report`); resolver siempre `resourceId` server-side (sin cambios acá, ya está resuelto).
- **Ask first**: nada nuevo — no hay cambios de datos ni de permisos en este spec.
- **Never**: tocar el modo T&M, los endpoints de `/api/me/time-entries` o `/api/tasks`, el contenido/lógica de `/gantt` o `/admin/control-horas` (solo heredan el drawer del shell, nada más).

## Success Criteria

1. `/mis-horas` (modo detallado) ya no tiene selector de proyecto arriba de la grilla.
2. La fila "+ Seleccionar proyecto" al pie de la tabla permite elegir proyecto y tarea, y agrega una fila nueva rotulada "Proyecto: Tarea".
3. Se puede cargar horas en filas de 2 proyectos distintos la misma semana, ambas visibles en la misma grilla.
4. El botón `✕` de una fila con horas pide confirmación antes de borrar; una fila sin horas se quita directo.
5. El modo Time & Material sigue funcionando exactamente igual que antes.
6. En viewport mobile (375px), el sidebar se colapsa a un drawer con botón hamburguesa, en todas las páginas.
7. En viewport mobile, cada página de la tabla de alcance (todas menos `/gantt` y `/admin/control-horas`) es usable: sin scroll horizontal de body completo, sin texto cortado, sin botones inalcanzables.
8. `/gantt` y `/admin/control-horas` quedan sin cambios de contenido — solo heredan el drawer del sidebar.
9. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Combos de proyecto y persona ordenados + buscables

## Objective

Los `<select>` de proyecto en la app salen en un orden que no tiene sentido para el usuario (por fecha de inicio, no alfabético), y son selects nativos sin forma de escribir para filtrar — con 30+ proyectos hay que scrollear la lista entera para encontrar uno. Este spec ordena alfabéticamente y agrega búsqueda por texto a todos los combos de proyecto de la app (excepto Gantt, que queda afuera a pedido explícito), y agrega búsqueda al combo de "Persona" del Reporte Diario (ese ya viene ordenado alfabéticamente desde el backend).

**Éxito** = en cada combo en alcance, las opciones aparecen ordenadas A-Z, y escribir en el campo filtra la lista en tiempo real por coincidencia de texto (sin distinguir mayúsculas/minúsculas), con navegación por teclado (flechas + Enter + Escape) igual que un combobox estándar.

## Hallazgos clave

- **La causa raíz del desorden es una sola línea**: `GET /api/projects` usa `orderBy: { startDate: 'asc' }` en vez de `{ name: 'asc' }`. Cambiar esto ahí ordena automáticamente casi todos los combos de proyecto de la app, porque todos comparten ese mismo endpoint vía `useQuery(['projects'], ...)`.
- `GET /api/resources` ya ordena por `{ name: 'asc' }` — el combo de "Persona" del Reporte Diario ya está alfabético, solo le falta la búsqueda por texto.
- **Gantt y Control de Horas quedan afuera** (confirmado con el usuario): sus filtros de proyecto no son `<select>` sino widgets propios de multi-selección por checkboxes, alimentados por endpoints separados (`/api/gantt`, `/api/control-horas`), y ya habían quedado explícitamente excluidos de la tanda de cambios anterior.
- Inventario de combos de proyecto en alcance (todos `<select>` nativos hoy):

  | Archivo | Combo(s) |
  |---|---|
  | `app/mis-horas/page.tsx` | Proyecto (modo T&M) + Proyecto (picker de fila, modo detallado) |
  | `app/mi-reporte/page.tsx` | Proyecto (filtro) |
  | `app/admin/daily-report/page.tsx` | Proyecto (filtro) + **Persona (filtro)** |
  | `app/admin/hours/page.tsx` | Proyecto (import SCC), Proyecto (filtro tabla), Proyecto (alta inline), Proyecto (edición inline) |

  9 combos en total (8 de proyecto + 1 de persona) en 4 archivos.
- Un `<select>` nativo del navegador no soporta escribir-para-filtrar — hace falta reemplazarlo por un combobox propio (input de texto + lista desplegable filtrada), no hay forma de lograrlo con el elemento nativo.

## Decisiones

1. **Fix de orden**: `app/api/projects/route.ts` — `orderBy: { startDate: 'asc' }` → `orderBy: { name: 'asc' }`. Un solo cambio, beneficia a todos los consumidores del endpoint.
2. **Componente nuevo y reutilizable**: `components/ui/SearchableSelect.tsx` — combobox con input de texto + panel desplegable, mismo estilo visual (borde, radio, tamaño de fuente) que los `<select>` que reemplaza. Filtra por coincidencia de substring, sin distinguir mayúsculas/minúsculas. Soporta teclado (↑/↓ para navegar, Enter para elegir, Escape para cerrar sin cambiar) y cierre al hacer click afuera.
3. **Alcance confirmado**: los 9 combos de la tabla de arriba. Gantt (incluido el modal "Nueva Asignación") y Control de Horas quedan completamente afuera.

## Tech Stack

Sin cambios, sin librerías nuevas — se construye con React + Tailwind, mismo patrón que el resto de los componentes de la app.

## Project Structure

```
components/ui/SearchableSelect.tsx   → nuevo, componente reutilizable
app/api/projects/route.ts            → orderBy: name asc (1 línea)
app/mis-horas/page.tsx               → 2 combos reemplazados
app/mi-reporte/page.tsx              → 1 combo reemplazado
app/admin/daily-report/page.tsx      → 2 combos reemplazados (proyecto + persona)
app/admin/hours/page.tsx             → 4 combos reemplazados
```

## Code Style

`SearchableSelect` recibe `options: { value: string; label: string }[]`, `value`, `onChange`, y un `placeholder` — misma forma que ya arman todos los call sites hoy a partir de `projects.map(...)`, así que el reemplazo en cada página es mecánico: se arma el array de `options` una vez (con el `.sort()` ya innecesario para proyecto gracias al fix del punto 1, pero se aplica igual por si el consumidor cachea datos viejos) y se pasa al componente en vez de escribir el `<option>` a mano.

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + QA manual: escribir un par de letras en cada combo y confirmar que filtra, confirmar que las listas aparecen A-Z, navegar con teclado, confirmar que Gantt y Control de Horas no se tocaron (`git diff`).

## Boundaries

- **Always**: mantener el valor seleccionado como string (mismo tipo que ya usan los `value`/`onChange` existentes) para no romper la lógica de cada página.
- **Ask first**: nada nuevo.
- **Never**: tocar `components/gantt/GanttControls.tsx`, `app/admin/control-horas/page.tsx`, `components/modals/AssignmentModal.tsx`, ni ningún otro combo de persona fuera del de `admin/daily-report`.

## Success Criteria

1. `GET /api/projects` devuelve los proyectos ordenados por nombre.
2. Los 8 combos de proyecto listados arriba muestran las opciones A-Z y filtran al escribir.
3. El combo de Persona de `admin/daily-report` filtra al escribir (el orden ya estaba bien).
4. Navegación por teclado (↑/↓/Enter/Escape) funciona en el nuevo componente.
5. `git diff` confirma cero cambios en Gantt, Control de Horas y `AssignmentModal.tsx`.
6. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Dashboard inicial, fix acceso colaborador, y UX de Mis Horas

## Objective

Cuatro correcciones relacionadas de experiencia de usuario y un bug de acceso:

1. El mensaje "Acceso denegado" siempre ofrece "Ir al Gantt", aunque el rol del usuario no tenga acceso al Gantt (lo vuelve a mandar al mismo error).
2. `cuslenghi@zircon.tech` (rol colaborador) "no puede loguearse".
3. No existe una pagina de inicio neutral: hoy `/` redirige siempre a `/gantt`, y los roles sin acceso a esa pagina (como colaborador) quedan sin landing page valida.
4. En Mis Horas: el combo de proyecto del selector de fila no se expande (se corta), el boton de borrar fila queda visualmente fuera de la tabla, y usa una "X" en vez del icono de tacho de basura rojo que se usa en el resto de la app.

## Hallazgos clave de la exploracion

- **Los puntos 1, 2 y 3 son el mismo bug.** Confirmado contra la base real: el usuario `cuslenghi@zircon.tech` existe, esta activo, tiene el `Resource` vinculado correctamente por email, y su rol `colaborador` tiene `allowedPages = ['/projects', '/holidays', '/mis-horas', '/mi-reporte']` — **no incluye `/gantt`**. El login (NextAuth `authorize()`) funciona bien y si genera sesion. Pero `app/page.tsx` hace `redirect('/gantt')` incondicionalmente, y el middleware (`middleware.ts`) rebota cualquier ruta fuera de `allowedPages` a `/unauthorized`. Resultado: el colaborador entra con usuario/contrasena correctos y aterriza directo en la pantalla de "Acceso denegado" — indistinguible, desde su perspectiva, de "no puedo loguearme". Y esa misma pantalla de error lo manda de vuelta a `/gantt`, un loop.
- El unico mecanismo hoy para saltarse el matrix de `PagePermission` es la lista `ALWAYS_ALLOWED_AUTHENTICATED` en `middleware.ts` (hoy solo tiene `/perfil`).
- No existe ninguna pagina de inicio/resumen hoy. Los datos para armar una (cantidad de usuarios, proyectos, feriados) ya estan disponibles via `prisma.user.count()`, `prisma.project.count()` (o el `GET /api/projects` existente) y `GET /api/country-holidays` (ya devuelve feriados ordenados por pais y fecha).
- `Sidebar.tsx` filtra los items de nav por `allowedPages` para no-admins; el Dashboard debe listarse ahi para todos los roles sin depender de esa lista (mismo trato que `/perfil`, que ni siquiera esta en `NAV_ITEMS` — hay que agregar un item fijo, no condicionado).
- **Causa raiz del combo que "no se expande" en Mis Horas**: el picker de proyecto de la fila "Seleccionar proyecto" (`app/mis-horas/page.tsx`) vive dentro de un `<div className="overflow-x-auto">` que envuelve la tabla. Por la especificacion CSS, declarar `overflow-x: auto` sin `overflow-y` fuerza a que `overflow-y` compute como `auto` tambien (no quede en `visible`) — asi que el `<div>` de dropdown absoluto de `SearchableSelect` (que se renderiza dentro de esa misma jerarquia) queda recortado por los bordes de ese contenedor scrolleable en vez de flotar libremente. Es un problema del componente `SearchableSelect` en si (cualquier ancestro con overflow no-visible lo recorta), no solo de esta pantalla.
- **Causa raiz de "el boton de borrar fila queda afuera de la tabla" / cabecera mas corta**: la tabla usa `table-layout: fixed`. El `<thead>` tiene columnas para Proyectos + 7 dias + Total (9 columnas), pero cada `<tr>` del `<tbody>` tiene una decima celda extra de 28px para el boton de borrar que **no tiene equivalente en el `<thead>`**. Con `table-layout: fixed`, el ancho de las columnas lo define la primera fila (`<thead>`), asi que esa decima columna del body queda fuera del ancho que la tabla se calculo a si misma.
- El icono de borrar ya tiene un patron consistente en el resto de la app (`app/projects/page.tsx`, `app/holidays/page.tsx`, `app/resources/page.tsx`): `<Trash2 size={14} />` de `lucide-react`, clase `text-red-400 hover:text-red-600`. Mis Horas usa hoy un caracter "X" con `text-gray-300 hover:text-red-500`.
- Revise `Mi Reporte` (`app/mi-reporte/page.tsx`): su combo de proyecto vive en una barra de filtros separada, **fuera** de cualquier contenedor con `overflow` no-visible, asi que no sufre el mismo recorte. No tiene boton de borrar (es un reporte de solo lectura). El unico cambio que le aplica es el fix generico de `SearchableSelect` (portal), que lo hace mas robusto pero no cambia nada visible ahi hoy.

## Decisiones

1. **Nueva pagina `/dashboard`**: resumen visible para **todos** los roles autenticados (incluido colaborador), sin pasar por el matrix de `PagePermission` — mismo mecanismo que `/perfil` (se agrega a `ALWAYS_ALLOWED_AUTHENTICATED` en `middleware.ts`). Muestra: cantidad de usuarios activos, cantidad de proyectos, y los proximos feriados (`CountryHoliday`, ordenados por fecha, ej. los proximos 5-10 a partir de hoy). Se agrega como item fijo en el Sidebar (siempre visible, no filtrado por `allowedPages`), primero en la lista de navegacion.
2. **`/` pasa a redirigir a `/dashboard`** en vez de `/gantt` — asi cualquier rol aterriza en una pantalla valida al loguearse.
3. **"Acceso denegado" apunta a `/dashboard`** en vez de `/gantt` ("Ir al inicio" en vez de "Ir al Gantt") — coherente con el nuevo home universal.
4. **No se toca la logica de permisos de Gantt ni Control de Horas** — el colaborador `cuslenghi@zircon.tech` sigue sin poder entrar a `/gantt` (es el comportamiento esperado por el matrix de roles); lo que se corrige es que ya no quede varado ahi por accidente al loguearse.
5. **`SearchableSelect` se corrige para usar un portal** (`createPortal` a `document.body`), posicionado con `getBoundingClientRect()` del input, recalculado en scroll/resize mientras esta abierto. Esto lo hace inmune a cualquier ancestro con `overflow` recortado — corrige el combo de Mis Horas de raiz y refuerza (sin cambios visibles) los otros 8 combos ya migrados.
6. **Tabla de Mis Horas**: se agrega una celda vacia en el `<thead>` (28px, mismo color de fondo que el resto del header) para que la columna del boton de borrar tenga su contraparte y la tabla calcule su ancho real incluyendola.
7. **Icono de borrar fila** en Mis Horas pasa de "X" texto a `<Trash2 size={14} />`, clase `text-red-400 hover:text-red-600`, igual que Proyectos/Feriados/Recursos.
8. **Mi Reporte**: sin cambios estructurales — se beneficia solo del fix generico de `SearchableSelect` (punto 5).

## Tech Stack

Sin cambios: Next.js 14 App Router, Prisma 5 + Turso, NextAuth 4 (JWT), TanStack Query v5, Tailwind, lucide-react. Sin librerias nuevas — `createPortal` es parte de `react-dom`, ya presente.

## Project Structure

```
app/
  dashboard/page.tsx        -> NUEVO: resumen (usuarios, proyectos, proximos feriados)
  page.tsx                  -> cambia redirect('/gantt') a redirect('/dashboard')
  unauthorized/page.tsx     -> cambia el link/label de "Ir al Gantt" a "Ir al inicio" (/dashboard)
  mis-horas/page.tsx        -> header <th> spacer + icono Trash2 en vez de X
  api/dashboard/summary/route.ts -> NUEVO: GET, cuenta usuarios activos + proyectos, proximos N feriados
middleware.ts                -> agrega '/dashboard' a ALWAYS_ALLOWED_AUTHENTICATED
components/layout/Sidebar.tsx -> agrega item "Dashboard" fijo (no filtrado por allowedPages)
components/ui/SearchableSelect.tsx -> dropdown via createPortal + reposicionamiento en scroll/resize
```

## Code Style

Seguir los patrones ya establecidos: rutas API con `export const dynamic = 'force-dynamic'` + `NextResponse.json`; paginas cliente con `'use client'` + TanStack Query; iconos de `lucide-react`; mismo lenguaje visual de tarjetas/tablas que el resto de la app (fondo blanco, borde `border-gray-200`, rounded-lg). El nuevo endpoint de dashboard no requiere `requireAdmin()` — es de lectura agregada, visible para cualquier sesion valida (igual que el propio middleware ya permite `/dashboard` a cualquier autenticado).

## Testing Strategy

Sin suite automatizada — verificacion manual + `npx tsc --noEmit` + `npm run build`, patron ya usado en todo el repo. Casos a verificar explicitamente:
- Login con `cuslenghi@zircon.tech` aterriza en `/dashboard` (no en `/unauthorized`).
- `/dashboard` es alcanzable por admin y por colaborador, muestra numeros coherentes con la base.
- Un rol sin acceso a una pagina cualquiera, al chocar contra `/unauthorized`, el boton lleva a `/dashboard` y ese destino carga sin rebote.
- En Mis Horas: abrir el combo de proyecto del picker de fila muestra la lista completa (no recortada), aunque la tabla tenga scroll horizontal activo.
- La fila de la tabla y el header de Mis Horas quedan alineados (el boton de borrar ya no sobresale del borde de la tabla).
- El icono de borrar fila es el tacho rojo, visualmente consistente con Proyectos/Feriados/Recursos.
- Gantt y Control de Horas: sin cambios (confirmar con `git diff --stat`).

## Boundaries

- **Always**: resolver `/dashboard` como visible-para-todos via el mismo mecanismo que `/perfil` (`ALWAYS_ALLOWED_AUTHENTICATED`), no via nuevas `PagePermission` por rol (para no tener que acordarse de agregarlo a cada rol futuro).
- **Ask first**: cualquier cambio a que paginas ve cada rol hoy (el matrix de `PagePermission` en si) — este spec no cambia permisos, solo la landing page y el fallback de error.
- **Never**: tocar `app/gantt/page.tsx`, `app/admin/control-horas/page.tsx`, `components/gantt/*`, ni el flujo de permisos de `admin/permissions` — fuera de alcance, consistente con specs anteriores de esta sesion.

## Success Criteria

1. `cuslenghi@zircon.tech` puede loguearse y ve una pantalla de inicio valida (Dashboard), no "Acceso denegado".
2. `/dashboard` existe, es visible para todos los roles autenticados, y muestra cantidad de usuarios, cantidad de proyectos y proximos feriados.
3. `/` y la pantalla de "Acceso denegado" apuntan a `/dashboard`, no a `/gantt`.
4. El combo de proyecto en el picker de fila de Mis Horas se despliega completo, sin recortes.
5. El header y las filas de la tabla de Mis Horas quedan alineados; el boton de borrar ya no sobresale del borde de la tabla.
6. El boton de borrar fila en Mis Horas usa el tacho de basura rojo (`Trash2`), igual que en Proyectos/Feriados/Recursos.
7. `git diff --stat` confirma cero cambios en Gantt, Control de Horas y el matrix de permisos.
8. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Rediseno mobile de Mis Horas / Mi Reporte + borrado mensual en T&M

## Objective

Tres pedidos relacionados sobre las dos pantallas de autoservicio de horas:

1. **Mobile de Mis Horas y Mi Reporte no es amigable.** Ambas usan una grilla ancha (columnas por dia) pensada para desktop, que en mobile obliga a scrollear horizontalmente entre columnas angostas — dificil de usar para cargar o leer horas desde el celular.
2. **Mi Reporte en desktop se ve vacio con pocas filas.** Con 4-5 tareas la tabla es chica y queda mucho espacio en blanco entre el final de la tabla y el resto de la pagina; ademas, a diferencia del reporte admin (que compara muchos recursos), esta pantalla siempre muestra las horas de una sola persona, asi que el diseno "grilla densa" le queda grande.
3. **T&M no tiene forma de borrar todo el mes cargado** — hoy solo se puede sobreescribir dia por dia a mano.

## Hallazgos clave de la exploracion

- **Mis Horas (modo Detallado)**: la grilla tiene 7 columnas de dia + nombre + total + borrar, con scroll horizontal (`overflow-x-auto`) y columnas que se angostan en mobile (52px) pero siguen siendo una grilla ancha — el patron clasico de "tabla de escritorio embutida en mobile" que las guias de usabilidad mobile actuales (Nielsen Norman Group, Material Design, Apple HIG) desaconsejan: dificulta comparar "que dia es este" mientras se scrollea, y los inputs de hora quedan con un area de toque chica.
- **Mis Horas (modo T&M)**: ya usa una lista vertical (`divide-y`, un renglon por dia habil) — este modo **ya es mobile-friendly**, no necesita rediseno estructural.
- **Mi Reporte**: la tabla pivot (proyecto x dia) tiene el mismo problema de columnas angostas en mobile, agravado porque es de solo lectura — el usuario tiene que retener mentalmente "que dia es la columna 4" mientras compara valores.
- **La "gran zona en blanco" en Mi Reporte desktop no es un bug de altura forzada** — el contenedor usa `max-h-[700px]` con `overflow-auto`, que solo limita un maximo, no fuerza esa altura. Lo que realmente pasa es que la pagina no tiene mas contenido que una tabla chica: no hay ningun resumen/KPI arriba (a diferencia de `/dashboard`, que ya usa tarjetas de estadisticas), asi que con pocas filas la pagina se siente vacia. La solucion no es forzar que la tabla "llene" la pantalla, sino agregar contenido util (tarjetas de resumen) que le den sentido al espacio.
- Ya existe **prior art de borrado masivo por mes** en `app/api/time-entries/route.ts` (admin, `DELETE ?month=YYYY-MM`, borra por rango de fecha con `deleteMany`) y su UI en `app/admin/hours/page.tsx` (tarjeta con borde rojo, badge "Irreversible", `confirm()` antes de llamar). El endpoint de colaborador (`app/api/me/time-entries/route.ts`) hoy solo soporta `DELETE ?id=` (una fila). Se extiende siguiendo el mismo patron ya validado, pero acotado por `resourceId` (server-side, nunca confiar en un id que mande el cliente) + `projectId` + rango del mes.
- **Alcance del borrado**: "borrar todas las horas del mes" en T&M debe borrar solo las entradas de esa modalidad (`taskId: null`, `entryType: 'regular'`) para ese proyecto y mes — no las entradas del modo Detallado que el mismo usuario pudiera tener cargadas para el mismo proyecto en el mismo rango de fechas (son cosas distintas, aunque compartan `resourceId`+`projectId`+`date`).
- `useIsMobile()` ya existe y es el breakpoint compartido (`max-width: 767px`) usado en toda la app — se reutiliza tal cual, sin breakpoints nuevos.

## Decisiones

1. **Mis Horas, modo Detallado, mobile**: se reemplaza la grilla de 7 columnas por una vista de **un dia a la vez** (patron ya estandar en apps de time-tracking mobile como Toggl/Clockify): navegacion de semana (← →, ya existe) + selector de dia dentro de esa semana (7 pastillas Lun-Dom, resaltando el dia seleccionado/hoy), y debajo una lista vertical de tareas para ese dia — cada fila con nombre de tarea + un input de horas a ancho completo + boton de borrar con area de toque comoda. El picker "+ Agregar tarea" pasa de celda angosta a bloque apilado a ancho completo. Toda la logica de datos (query, `saveCell`, `removeRow`, `addRow`, `grid`) se reutiliza sin cambios — solo cambia el JSX que se renderiza cuando `isMobile` es true. **Desktop no cambia**, sigue siendo la grilla semanal completa.
2. **Mis Horas, modo T&M, mobile**: sin cambios estructurales (ya es una lista vertical). Se agrega ahi mismo el nuevo boton de borrado de mes (ver punto 4), con layout que se apila bien en mobile (ya usa `flex-wrap`).
3. **Mi Reporte, mobile**: se reemplaza la tabla pivot por una **lista de tarjetas por dia** (patron "historial cronologico", como el resto de las apps de reporte personal) — un dia por tarjeta, solo los dias con horas cargadas (se saltean los dias en cero para no obligar a scrollear un mes entero vacio), cada tarjeta con fecha + lista de proyecto/horas (+extra en naranja como hoy) + total del dia. Arriba de la lista, las tarjetas de resumen del punto 5 (mismas para mobile y desktop). **Desktop sigue usando la tabla pivot** (es la vista correcta para comparar muchos dias de un vistazo en una pantalla ancha) pero con el fix del punto 5.
4. **Mi Reporte, desktop**: se quita el `max-h-[700px]` fijo — la tabla pasa a ocupar su alto natural (con un tope razonable solo para rangos muy largos, `max-h-[60vh]`, que no se nota con pocas filas). Se agregan **tarjetas de resumen** arriba de la tabla (mismo lenguaje visual que las de `/dashboard`: icono en caja de color + numero grande + etiqueta): Total de horas, Promedio por dia con carga, Proyectos con horas, Dias con horas cargadas. Esto le da contenido real a la pagina en vez de forzar que una tabla chica "rellene" el espacio — soluciona la sensacion de vacio sin inventar altura artificial.
5. **T&M — borrar mes completo**: nuevo boton "Borrar mes" junto a "Guardar mes", estilo boton secundario destructivo (borde/texto rojo, no relleno — para no competir visualmente con la accion primaria de guardar), deshabilitado sin proyecto elegido. Al clickear, `confirm()` con el nombre del proyecto y el mes (mismo patron que ya usa `removeRow` en Mis Horas y el borrado por mes de `admin/hours`). Llama al DELETE extendido de `/api/me/time-entries`, invalida la query de T&M — el `useEffect` existente que siembra `tmDayValues` desde `tmEntries` ya maneja el caso "sin entradas guardadas" (vuelve a `tmDefaultHours` por dia), asi que no hace falta logica extra de limpieza en el cliente.
6. **No se toca el modo Detallado en desktop, ni Gantt, ni Control de Horas, ni ninguna pantalla de admin** — mismos limites que specs anteriores de esta sesion.
7. **Fuera de alcance (recomendacion para mas adelante, no se implementa en este spec)**: un grafico de barras de horas por dia en Mi Reporte. Ayudaria a reconocer patrones de un vistazo, pero es una pieza de UI nueva (sin libreria de charts en el stack — habria que construir un SVG a medida) que amerita su propia iteracion en vez de sumarse a este cambio ya grande. Se deja documentado como siguiente paso sugerido.

## Tech Stack

Sin cambios: Next.js 14 App Router, Prisma 5 + Turso, NextAuth 4 (JWT), TanStack Query v5, Tailwind, lucide-react, date-fns. Sin librerias nuevas — nada de chart libraries (ver punto 7 de Decisiones).

## Project Structure

```
app/
  mis-horas/page.tsx   -> vista mobile de un dia a la vez (modo Detallado); boton "Borrar mes" en T&M
  mi-reporte/page.tsx  -> tarjetas de resumen (desktop + mobile); tabla desktop sin max-height fijo; lista de tarjetas por dia en mobile
  api/me/time-entries/route.ts -> DELETE se extiende: soporta ?id= (existente, una fila) o ?projectId=&month=YYYY-MM (nuevo, borrado masivo T&M acotado a resourceId propio + taskId null)
```

## Code Style

Mismos patrones ya establecidos: `useIsMobile()` para branchear JSX por breakpoint (no CSS-only, ya que la reestructuracion mobile no es solo un reflow sino un layout distinto); tarjetas de resumen con el mismo markup que ya usa `app/dashboard/page.tsx` (icono en caja `#E6F2FA` + numero + label) para consistencia visual entre pantallas; confirmaciones destructivas con `confirm()` nativo (patron ya usado en `removeRow` y en `admin/hours`), sin modales nuevos. Ruta API: sigue `export const dynamic = 'force-dynamic'` + `NextResponse.json`, mismo `requireOwnResource()` para resolver el recurso del usuario.

## Testing Strategy

Sin suite automatizada — verificacion manual + `npx tsc --noEmit` + `npm run build`, patron ya usado en todo el repo. Casos a verificar explicitamente:
- Mis Horas mobile (viewport <768px), modo Detallado: se ve un dia a la vez, se puede cambiar de dia con las pastillas, cargar/editar/borrar horas funciona igual que en desktop.
- Mis Horas desktop: la grilla semanal de 7 columnas sigue igual que antes de este spec (sin regresiones).
- Mi Reporte mobile: lista de tarjetas por dia, sin scroll horizontal, dias en cero no aparecen.
- Mi Reporte desktop: tabla sin espacio en blanco forzado con pocas filas; tarjetas de resumen muestran numeros coherentes con la tabla.
- T&M: "Borrar mes" pide confirmacion, borra solo las entradas T&M de ese proyecto/mes (no toca entradas del modo Detallado del mismo usuario/proyecto/rango), y despues de borrar los dias vuelven a mostrar `tmDefaultHours` (comportamiento de "sin datos guardados", no ceros).
- Llamar el DELETE nuevo con un `projectId` de otro recurso (vía fetch directo) confirma que solo afecta al `resourceId` propio.
- Gantt, Control de Horas, admin: sin cambios (`git diff --stat`).

## Boundaries

- **Always**: resolver el `resourceId` del borrado masivo server-side vía `requireOwnResource()`, nunca confiar en un `resourceId` que mande el cliente; mantener el modo Detallado de escritorio sin cambios de comportamiento.
- **Ask first**: cualquier cambio al modelo de datos (`TimeEntry`, `Task`) — este spec es solo de UI/UX y un endpoint de borrado, no toca el schema.
- **Never**: tocar Gantt, Control de Horas, o pantallas `/admin/*`; agregar una libreria de charts sin acordarlo antes (ver punto 7 de Decisiones).

## Success Criteria

1. En un viewport mobile, Mis Horas (modo Detallado) muestra un dia a la vez con navegacion por pastillas, sin scroll horizontal de columnas.
2. En un viewport mobile, Mi Reporte muestra una lista de tarjetas por dia en vez de la tabla pivot, sin scroll horizontal.
3. En desktop, Mi Reporte muestra tarjetas de resumen (total, promedio, proyectos, dias con carga) y la tabla ya no deja una franja de espacio en blanco forzada cuando hay pocas filas.
4. T&M tiene un boton "Borrar mes" que, con confirmacion, elimina todas las entradas T&M (taskId null) de ese proyecto/mes para el usuario logueado, sin afectar entradas de otros proyectos, otros meses, u otros usuarios.
5. Mis Horas desktop (modo Detallado) y T&M mantienen su comportamiento actual sin regresiones.
6. Gantt, Control de Horas y las pantallas de admin quedan sin cambios (`git diff --stat` vacio).
7. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Fix rango de dias en Mi Reporte, tareas T&M visibles en Detallado, crear tareas desde Mis Horas, sidebar

## Objective

Cinco pedidos sobre las mismas dos pantallas de autoservicio, mas la marca en el sidebar:

1. **Mi Reporte solo muestra los dias con horas cargadas, no el rango filtrado.** Con "Desde 01/08" y "Hasta 31/08" seleccionado, la tabla solo mostro 5 columnas (17 al 21) porque esos fueron los unicos dias con datos esa semana — el resto del mes no aparece aunque este dentro del filtro.
2. **Mis Horas no deja crear tareas nuevas** — el picker de fila solo ofrece tareas que un admin ya haya cargado desde `/projects`. El usuario quiere poder agregar una tarea nueva ahi mismo.
3. **La tabla de Mis Horas se ve chica en pantallas anchas** — pedido abierto de mejora visual/UX.
4. **El nombre "ZirconTracker" se corta en el sidebar** (se ve "ZirconTrac...").
5. **Las horas cargadas en modo Time & Material no aparecen en modo Detallado.** El usuario quiere verlas y poder editarlas ahi tambien — que "sin tarea asignada" no sea motivo para ocultarlas.

## Hallazgos clave de la exploracion

- **Causa raiz del bug de Mi Reporte**: `lib/time-entries-pivot.ts` arma la lista de columnas (`days`) recorriendo las entradas encontradas y agregando cada fecha que aparece en al menos una (`daySet.add(dayKey)` dentro del loop de entries) — nunca a partir del rango pedido (`dateFrom`/`dateTo`). Si el usuario cargo horas solo 5 dias del mes, la tabla muestra exactamente esos 5 dias sin importar que el filtro diga "todo agosto". Esta funcion es compartida por `/api/me/time-entries` (Mi Reporte) y `/api/time-entries` (el pivot que usa `admin/daily-report`) — mismo bug latente ahi tambien, aunque no fue lo reportado.
- **"Agregar tareas" hoy es admin-only por diseno explicito** (`app/api/tasks/route.ts`, `POST` con `requireAdmin()`) — decision tomada en el spec original de este feature ("solo el admin puede crear/editar/borrar Task"). El pedido actual solo pide destrabar la creacion para el propio usuario, no edicion ni borrado — esas siguen siendo admin-only via `components/modals/ProjectModal.tsx` (sin cambios).
- **Por que las horas T&M no aparecen en Detallado**: `app/mis-horas/page.tsx` arma la grilla del modo Detallado con `if (e.taskId == null) continue` — descarta explicitamente cualquier entrada sin tarea. Las filas se identifican solo por `taskId` (`Map<number, ...>`), lo que ademas no alcanzaria para distinguir "sin tarea del Proyecto A" de "sin tarea del Proyecto B" si simplemente se dejara de filtrar — hace falta que la identidad de fila sea `(projectId, taskId | null)`, no solo `taskId`.
- **Por que el nombre se corta**: el header del sidebar pone logo + "ZirconTracker" en una fila (`flex items-center gap-2.5`) compartiendo ancho con el boton de colapsar/cerrar; a `w-52` (208px) menos padding, icono y boton, quedan ~100px para un texto bold de 16px — no entra. Poner el icono arriba y el nombre debajo (columna en vez de fila) le da al texto el ancho casi completo del sidebar para el mismo contenido.
- **Por que Mis Horas "se ve chica"**: la tarjeta de la tabla no tiene `w-full` — se achica al ancho de sus columnas fijas (~830px) y deja un area en blanco a la derecha en pantallas anchas, el mismo tipo de "espacio vacio" que ya se resolvio para Mi Reporte agregando contenido real (tarjetas de resumen) en el spec anterior.

## Decisiones

1. **`buildTimeEntriesPivot` arma `days` a partir del rango pedido cuando el llamador lo pasa completo** (`from` y `to` ambos definidos), generando cada dia del rango sin importar si tiene entradas o no; si el rango no viene completo (llamado sin filtro de fecha), se mantiene el comportamiento actual (dias derivados de los datos). Se actualizan **ambos** llamadores (`app/api/me/time-entries/route.ts` y `app/api/time-entries/route.ts`) para pasar su `from`/`to` ya calculado — arregla Mi Reporte y de paso el mismo bug latente en `admin/daily-report`, sin tocar ninguna pantalla de admin (el fix vive en la libreria compartida + una linea en la ruta API).
2. **Creacion de tareas desde Mis Horas**: en el picker de fila, el `<select>` de tarea suma una opcion "+ Crear tarea nueva..." que revela un input de texto + boton confirmar; al confirmar, `POST /api/tasks` con `{projectId, name}` y la tarea recien creada queda seleccionada. Se relaja el auth de `POST /api/tasks` de `requireAdmin()` a un nuevo helper `requireAdminOrOwnResource()` en `lib/auth.ts` (admin, o cualquier usuario con `Resource` propio vinculado por email) — mismo patron ya usado por `requireSelfOrAdmin`/`requireOwnResource`. PUT/DELETE de tareas siguen siendo admin-only (sin cambios) — este pedido es solo "agregar", no editar ni borrar.
3. **Mis Horas desktop, mas contenido util**: la tarjeta de la tabla pasa a `w-full`; se agregan tarjetas de resumen arriba (mismo lenguaje visual que Mi Reporte/Dashboard) — Total semana, Proyectos, Tareas activas. Con el punto 5 (T&M visible en Detallado) la tabla tambien va a tener naturalmente mas filas para quien usa ambos modos, lo que ayuda a la misma sensacion de "tabla chica".
4. **Sidebar**: el bloque de marca pasa de fila a columna (icono arriba, nombre debajo, ambos centrados) cuando `showLabels` es true; el boton de colapsar/cerrar se reposiciona como elemento independiente (esquina superior derecha) en vez de compartir la fila con el logo. En estado colapsado (desktop, icono-only) el comportamiento no cambia: sigue sin mostrar logo ni nombre, solo el boton de expandir (tal cual hoy).
5. **T&M visible y editable en Detallado**: se generaliza la identidad de fila de `taskId: number` a un par `(projectId, taskId | null)` — clave compuesta `"${projectId}:${taskId ?? 'none'}"`. Se deja de filtrar las entradas con `taskId == null` al armar la grilla; una fila sin tarea se etiqueta `"<Proyecto>: Sin tarea (T&M)"` y es editable celda por celda igual que cualquier otra fila (mismo `PUT` de siempre, que ya acepta `taskId: null`). El picker de fila suma una opcion "Sin tarea (Time & Material)" en el `<select>` de tarea para poder agregar una fila asi manualmente tambien desde Detallado. Edita los mismos registros que ve T&M (misma tabla `TimeEntry`), asi que cambios hechos desde una pestana se reflejan en la otra al volver a visitarla (TanStack Query ya refetchea al re-habilitarse la query, sin necesidad de invalidacion cruzada extra).
6. **No se toca Gantt, Control de Horas, ni ninguna pantalla `/admin/*`** — mismos limites que specs anteriores. El fix de `time-entries-pivot.ts` es una libreria compartida, no una pantalla; no implica cambios visibles en `admin/daily-report`.

## Tech Stack

Sin cambios: Next.js 14 App Router, Prisma 5 + Turso, NextAuth 4 (JWT), TanStack Query v5, Tailwind, lucide-react, date-fns. Sin librerias nuevas.

## Project Structure

```
lib/time-entries-pivot.ts        -> buildTimeEntriesPivot acepta un rango opcional {from, to} para generar `days`
lib/auth.ts                      -> + requireAdminOrOwnResource()
app/api/tasks/route.ts           -> POST usa requireAdminOrOwnResource() en vez de requireAdmin()
app/api/me/time-entries/route.ts -> pasa {from, to} a buildTimeEntriesPivot
app/api/time-entries/route.ts    -> pasa {from, to} a buildTimeEntriesPivot (mismo fix para admin/daily-report)
app/mis-horas/page.tsx           -> filas por (projectId, taskId|null); crear tarea inline; tarjetas de resumen; card w-full
components/layout/Sidebar.tsx    -> bloque de marca en columna (icono arriba, nombre debajo)
```

## Code Style

Mismos patrones ya establecidos: helpers de autorizacion en `lib/auth.ts` siguiendo el estilo de `requireSelfOrAdmin`/`requireOwnResource` (resuelven el `Resource` propio por email de sesion, nunca confian en un id que mande el cliente); tarjetas de resumen con el mismo markup que ya usan Mi Reporte/Dashboard; claves compuestas de fila como string simple (`"${projectId}:${taskId ?? 'none'}"`) con un par de funciones `rowKey`/`parseRowKey`, sin introducir un tipo/clase nueva para algo tan chico.

## Testing Strategy

Sin suite automatizada — verificacion manual + `npx tsc --noEmit` + `npm run build`. Casos a verificar explicitamente:
- Mi Reporte con el mes completo seleccionado y horas cargadas solo en 5 dias: la tabla muestra las 30/31 columnas del mes, con los dias sin carga en blanco (no ocultos).
- Mi Reporte con un rango de dias mas acotado (ej. una semana): muestra exactamente esos dias, ni mas ni menos.
- Mis Horas: crear una tarea nueva desde el picker de fila, confirmar que aparece disponible para seleccionar y que la fila se puede cargar con horas normalmente.
- Un usuario sin rol admin ni `Resource` vinculado que intente `POST /api/tasks` recibe 403.
- Mis Horas Detallado: una entrada cargada desde T&M (sin tarea) aparece como fila "Proyecto: Sin tarea (T&M)", editable celda por celda; el cambio se refleja si se vuelve a visitar la pestana T&M para ese proyecto/mes.
- Agregar una fila "Sin tarea (Time & Material)" manualmente desde el picker de Detallado y cargarle horas — se guarda igual que cualquier entrada T&M.
- Sidebar expandido: "ZirconTracker" se ve completo, sin truncar, con el icono arriba. Sidebar colapsado (desktop): comportamiento sin cambios (solo boton de expandir).
- Gantt, Control de Horas, admin: sin cambios (`git diff --stat`).

## Boundaries

- **Always**: resolver el `Resource` propio server-side por email de sesion para el nuevo helper de autorizacion, nunca confiar en datos que mande el cliente; mantener PUT/DELETE de tareas admin-only.
- **Ask first**: cualquier cambio al limite de cuantas tareas puede crear un colaborador, o a permitirles editar/borrar tareas (este spec es solo "crear").
- **Never**: tocar Gantt, Control de Horas, o pantallas `/admin/*`; agregar validacion de duplicados a nivel de base de datos para `Task.name` (fuera de alcance — un chequeo simple del lado cliente alcanza).

## Success Criteria

1. Mi Reporte muestra todos los dias del rango filtrado (por defecto el mes completo), no solo los dias con horas cargadas.
2. Se puede crear una tarea nueva desde el picker de fila de Mis Horas sin pasar por `/projects`.
3. Mis Horas desktop tiene tarjetas de resumen y la tabla ocupa el ancho completo de la tarjeta contenedora.
4. "ZirconTracker" se lee completo en el sidebar expandido.
5. Las entradas cargadas en modo T&M (sin tarea) son visibles y editables desde el modo Detallado, y se puede agregar una fila "sin tarea" manualmente ahi tambien.
6. Gantt, Control de Horas y pantallas de admin quedan sin cambios (`git diff --stat` vacio salvo `lib/time-entries-pivot.ts` y `app/api/time-entries/route.ts`, que son fix de libreria compartida, no UI).
7. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Ocultar proyectos finalizados en los combos de Mis Horas y Mi Reporte

## Objective

En los combos de proyecto de `Mis Horas` y `Mi Reporte`, no listar los proyectos con status "Finalizado" — el usuario no deberia poder elegir para cargar horas (o filtrar un reporte) un proyecto que ya termino.

## Hallazgos clave de la exploracion

- `Project.status` es un string libre (sin enum en el schema). El valor exacto usado en toda la app es `'Finalizado'` — confirmado en `components/modals/ProjectModal.tsx` (lista de opciones del select de status) y en `app/projects/page.tsx:70`, que ya tiene un filtro identico: `list = list.filter(p => p.status !== 'Finalizado')`.
- En ambas pantallas, `projectOptions` (el array que alimenta el combo `SearchableSelect`) ya esta separado de los datos usados para *mostrar* filas existentes:
  - `app/mis-horas/page.tsx`: `projectOptions` (linea 121) solo alimenta los dos combos de proyecto (el picker de fila en Detallado, y el selector de T&M); `projectById` (mapa completo, sin filtrar) sigue resolviendo nombre/color para filas ya cargadas — necesario para que una fila con horas en un proyecto ya finalizado siga mostrandose correctamente en la tabla.
  - `app/mi-reporte/page.tsx`: `projectOptions` (linea 67) solo alimenta el combo de filtro; las filas de la tabla vienen del pivot de la API (`projectRows`), no de esta lista, asi que no se ven afectadas.
- Consecuencia directa de lo anterior: **filtrar `projectOptions` no rompe nada existente** — un proyecto finalizado con horas ya cargadas sigue viendose en la tabla de Mis Horas o en el reporte, simplemente deja de ofrecerse como opcion nueva para elegir.

## Decisiones

1. En ambas pantallas, `projectOptions` pasa a excluir `p.status === 'Finalizado'` antes de mapear a `{value, label}` — un solo `.filter()` agregado a la memo existente, sin nuevo estado ni toggle (a diferencia de `/projects`, que si tiene un selector "activos/todos/finalizado"; aca no se pide eso, es un filtro fijo).
2. Sin cambios en `/projects` (que ya tiene su propio filtro, con toggle) ni en ninguna otra pantalla — el pedido es especificamente Mis Horas y Mi Reporte.

## Tech Stack

Sin cambios.

## Project Structure

```
app/mis-horas/page.tsx    -> projectOptions excluye status === 'Finalizado'
app/mi-reporte/page.tsx   -> projectOptions excluye status === 'Finalizado'
```

## Code Style

Un `.filter()` mas en la misma cadena que ya arma `projectOptions` (`.filter(...).map(...).sort(...)`), sin introducir helpers ni constantes nuevas — mismo patron que el filtro ya existente en `/projects`.

## Testing Strategy

Verificacion manual + `npx tsc --noEmit` + `npm run build`. Casos a verificar:
- Un proyecto con status "Finalizado" no aparece en el combo de proyecto de Mis Horas (ni en el picker de fila de Detallado, ni en el selector de T&M) ni en el combo de Mi Reporte.
- Una fila ya cargada en Mis Horas para un proyecto que despues paso a "Finalizado" sigue mostrandose en la tabla con nombre y color correctos (no desaparece ni rompe).
- El reporte de Mi Reporte sigue mostrando correctamente las horas de un proyecto finalizado si el usuario ya tiene horas cargadas ahi (el combo de filtro no lo ofrece para elegir, pero si eligio "Todos los proyectos" el dato sigue apareciendo).
- `/projects`, Gantt, Control de Horas, admin: sin cambios (`git diff --stat`).

## Boundaries

- **Never**: tocar `/projects`, Gantt, Control de Horas o pantallas de admin; agregar un enum/migracion para `Project.status` (fuera de alcance, sigue siendo string libre).

## Success Criteria

1. Los combos de proyecto de Mis Horas (picker de fila y T&M) y Mi Reporte no listan proyectos con status "Finalizado".
2. Filas/datos ya existentes de proyectos finalizados se siguen mostrando sin cambios en ambas pantallas.
3. `git diff --stat` confirma cambios unicamente en `app/mis-horas/page.tsx` y `app/mi-reporte/page.tsx`.
4. `npx tsc --noEmit` y `npm run build` pasan sin errores.

---

# Spec: Mejoras de diseno UI/UX — Mis Horas, Mi Reporte, Dashboard

## Objective

Revisar y mejorar el diseno visual de las tres pantallas de autoservicio (Mis Horas, Mi Reporte, Dashboard) usando el skill `ui-ux-pro-max`, y aplicar las mejoras encontradas al codigo — no solo dar recomendaciones.

## Hallazgos clave de la exploracion

Consultado el skill (design-system, typography, product, ux, stack nextjs) contra el codigo real:

1. **La app no tenia tipografia propia** — `body` en `globals.css` usaba el stack de fuentes del sistema a 15px. El skill recomienda **Plus Jakarta Sans** especificamente para "SaaS products, web apps, dashboards, B2B, productivity tools".
2. **Los tokens de color de marca ya existian pero no estaban conectados a Tailwind** — `globals.css` ya definia `--zircon-blue`/`--zircon-blue-dark`, pero el azul de marca se repetia como hex inline (`style={{color:'#0170B9'}}`) decenas de veces en vez de usar esas variables.
3. **Tarjetas de resumen duplicadas ~10 veces** con el mismo markup entre Dashboard, Mi Reporte y Mis Horas.
4. **Estados de carga eran solo texto plano** ("Cargando...") — el skill marca esto como severidad alta.
5. **Estados vacios sin jerarquia visual** (texto gris suelto).
6. **Numeros en tablas de horas sin cifras tabulares** (`tabular-nums`), causando que los digitos salten de ancho entre filas.
7. **Tap targets chicos en mobile** — el boton de borrar fila en Mis Horas mobile tenia ~24×24px, por debajo del minimo de 44×44px.

El producto ya tiene identidad de marca establecida (azul #0170B9) — no se reemplazo la paleta por la sugerida por defecto del skill (pensada para landing de marketing, no para un dashboard interno ya existente).

**Bug encontrado durante la implementacion**: `bg-primary/10` (modificador de opacidad de Tailwind) resolvia a transparente porque el color esta definido como `var(--zircon-blue)` crudo, no en el formato con canales RGB que Tailwind 3.4 necesita para aplicar opacidad via `color-mix()`. Se resolvio agregando un tercer token `--zircon-blue-light` (mismo hex `#E6F2FA` que ya se usaba a mano) en vez de depender del modificador de opacidad — verificado contra el DOM real que el color coincide exactamente con el original.

## Decisiones

1. **Plus Jakarta Sans vía `next/font/google`**, aplicada en `app/layout.tsx` (patron recomendado por Next.js, una sola vez en el layout raiz) — visible en toda la app, confirmado con el usuario dado que es un cambio puramente visual sin tocar logica de Gantt/admin.
2. **Tokens `primary`/`primary-dark`/`primary-light`** en `tailwind.config.ts`, mapeados a las variables `--zircon-*` ya existentes en `globals.css` — mismos hex, cero cambio visual, solo reemplaza el inline-hex disperso por clases Tailwind dentro de las 3 pantallas objetivo.
3. **Componentes compartidos nuevos** en `components/ui/`: `StatCard` (icono+numero+label, con variante `size='lg'` para Dashboard), `EmptyState` (icono+mensaje), `Skeleton` (`SkeletonCard`/`SkeletonRow`, `animate-pulse`).
4. **`tabular-nums`** aplicado a las tablas/inputs de horas y a los valores de las tarjetas de resumen.
5. **Tap target del boton de borrar fila en Mis Horas mobile** ampliado a 44×44px (`min-w-[44px] min-h-[44px]`) sin agrandar el icono visualmente.
6. Los estilos condicionales complejos de las celdas de la tabla pivot (colores por dia/hoy/fin de semana) se dejan como estan — no es el foco de esta pasada, y fragmentar esos `style={{}}` no aporta valor real.

## Tech Stack

Sin librerias nuevas — `next/font/google` ya es parte de Next 14.

## Project Structure

```
app/layout.tsx              -> next/font/google Plus Jakarta Sans
app/globals.css             -> +--zircon-blue-light, font-size base 15px->16px, limpia font-family (ahora via Tailwind)
tailwind.config.ts          -> +colors.primary/primary-dark/primary-light, +fontFamily.sans
components/ui/StatCard.tsx  -> nuevo
components/ui/EmptyState.tsx -> nuevo
components/ui/Skeleton.tsx  -> nuevo
app/dashboard/page.tsx      -> usa StatCard/EmptyState/Skeleton, tokens de color
app/mi-reporte/page.tsx     -> idem
app/mis-horas/page.tsx      -> idem + tap target del boton de borrar en mobile
```

## Code Style

Componentes compartidos chicos y sin estado, mismo patron que `SearchableSelect`. Tokens de color via CSS custom properties + Tailwind `theme.extend.colors`, no hardcodeados de nuevo.

## Testing Strategy

Verificacion manual contra DOM real (no solo visual) + `npx tsc --noEmit` + `npx next lint` + `npm run build`. Verificado: fuente cargada (`getComputedStyle(body).fontFamily`), color de los tokens (`getComputedStyle` de los icon-box, coincide exacto con el hex original), tamano real del boton de borrar en mobile (44×44px), `tabular-nums` aplicado, datos correctos en las 3 pantallas, Gantt sin romperse con la fuente nueva (fuera de alcance de codigo, pero afectado visualmente por el cambio global).

## Boundaries

- **Never**: tocar Gantt, Control de Horas, `/projects`, `/holidays`, `/resources`, pantallas `/admin/*`, `Sidebar.tsx`, ni ningun `useQuery`/endpoint/estado de las 3 pantallas (cambio puramente visual). No reemplazar la paleta de marca. No instalar librerias nuevas.

## Success Criteria

1. Tipografia Plus Jakarta Sans aplicada consistentemente en toda la app.
2. Tarjetas de resumen usan el componente compartido en las 3 pantallas, con los mismos valores/colores que antes.
3. Estados vacios y de carga tienen tratamiento visual (icono+mensaje / skeleton) en vez de texto plano.
4. Numeros de horas alinean con `tabular-nums`.
5. Boton de borrar fila en Mis Horas mobile mide 44×44px.
6. `git diff --stat` confirma cero cambios en Gantt, Control de Horas, admin y demas pantallas fuera de alcance (salvo `app/layout.tsx`, `app/globals.css`, `tailwind.config.ts`, la base compartida).
7. `npx tsc --noEmit`, `npx next lint` y `npm run build` pasan sin errores.

---

# Spec: Auditoría de diseño (skill frontend-design) sobre Mis Horas / Mi Reporte

## Objective

Auditar `/mis-horas` y `/mi-reporte` con la lente del skill `frontend-design` (disciplina de tipografía/color, restricción, estructura como información, piso de accesibilidad, calidad del copy) para encontrar mejoras puntuales aún abiertas — **no** un rediseño. El spec anterior ("UI/UX polish") ya cubrió tipografía (Plus Jakarta Sans), paleta de marca (`primary`/`primary-dark`/`primary-light`), `StatCard`/`EmptyState`/`Skeleton`, `tabular-nums` y tap targets de 44×44px en ambas pantallas — nada de eso se repite acá.

El enfoque "hero de marketing / riesgo estético" del skill no aplica: esto es una herramienta interna de carga de horas con identidad de marca ya establecida, no una landing. Lo que sí aplica y sigue abierto: dos bugs reales de contraste WCAG, nombres accesibles incompletos en botones de ícono, y `prefers-reduced-motion` no manejado en ningún lugar del proyecto.

**Éxito** = los dos bugs de contraste están corregidos y verificados por cálculo, los botones de ícono tienen nombre accesible robusto (no solo `title`), las animaciones (`Skeleton`) respetan `prefers-reduced-motion`, y los valores de color duplicados que causaban el bug de contraste quedan en un solo lugar en vez de repetidos en 2 archivos — sin tocar lógica de datos, sin agregar librerías, sin salir de estas 2 pantallas (salvo el componente compartido `Skeleton.tsx`, ya tocado por el spec anterior).

## Hallazgos clave de la auditoría

1. **Bug de contraste WCAG AA en encabezados de columna "hoy" y "fin de semana"** (`app/mis-horas/page.tsx:548`, `app/mi-reporte/page.tsx:261`, y sus footers de total en `:730`/`:354`): texto blanco bold 11px sobre `#f59e0b` (columna "hoy") da un contraste de **~2.1:1**, y sobre `#7a9cbf` (columnas de fin de semana) da **~2.9:1** — ambos muy por debajo del mínimo 4.5:1 que exige WCAG AA para texto normal (11px bold no califica como "texto grande", que requeriría solo 3:1). Es el único hallazgo de accesibilidad con severidad real encontrado en estas 2 pantallas.
2. **Botones de ícono sin nombre accesible robusto**: el botón de borrar fila (`Trash2`) en ambas pantallas y los botones "←"/"→" de navegación de semana en Mis Horas solo tienen `title`, que varios lectores de pantalla no anuncian de forma confiable y que no aparece hasta el hover (no ayuda a navegación por teclado). Falta `aria-label`.
3. **`prefers-reduced-motion` no está manejado en ningún lugar del proyecto** (confirmado: cero ocurrencias en `globals.css` y en toda la base). Afecta en particular `Skeleton.tsx` (`animate-pulse`), usado en ambas pantallas durante la carga.
4. **Los mismos 6 valores hex del hallazgo 1** (`#0170B9`, `#005a94`, `#f59e0b`, `#7a9cbf`, `#1e3a5f`, `#374151`) están **duplicados literalmente** en los `style={{}}` de `mis-horas/page.tsx` y `mi-reporte/page.tsx` — la corrección del bug de contraste tendría que aplicarse dos veces, en dos archivos, si se hace a mano. El spec anterior dejó explícitamente esta zona ("estilos condicionales de las celdas pivot") fuera de alcance por no haber una razón concreta para tocarla — ahora sí la hay: el bug de contraste.
5. El resto de la auditoría (jerarquía tipográfica, copy de `EmptyState`/errores, estructura de las tablas, foco visible en inputs y en `SearchableSelect`) está en buen estado y no requiere cambios: los mensajes de vacío/error ya son específicos y accionables ("Elegí un proyecto para cargar horas en bloque.", "Todavía no agregaste tareas esta semana."), los inputs de hora mantienen un indicador de foco visible (cambio de fondo/borde), y ninguna página reemplaza el outline nativo de botones sin sustituto.
6. `SearchableSelect` (usado en 9 combos de 4 pantallas, no solo estas 2) no expone roles ARIA de combobox/listbox — es un hallazgo real pero de alcance mayor al confirmado con el usuario para este spec (tocaría `admin/hours` y `admin/daily-report` también). Se documenta como hallazgo pero **no se implementa acá** (ver Open Questions).

## Decisiones confirmadas

1. **Fix de contraste**: oscurecer los dos colores de acento usados como fondo de header/footer con texto blanco encima — `#f59e0b` → `#b45309` (contraste >4.5:1 con blanco) y `#7a9cbf` → `#3d5a80` (contraste >4.5:1 con blanco) — sin cambiar el resto de la paleta ni el significado visual (sigue siendo "más oscuro/saturado = hoy o fin de semana").
2. **Extraer los 6 valores de color compartidos** a un módulo nuevo `lib/pivot-colors.ts` (constantes simples, no un sistema de theming nuevo), importado por ambos archivos — alcance acotado a los colores del hallazgo 1, no se tocan otros estilos inline de las tablas.
3. **`aria-label`** en los botones `Trash2` ("Eliminar fila") y en los botones de navegación de semana de Mis Horas ("Semana anterior" / "Semana siguiente"), manteniendo el `title` existente como tooltip visual.
4. **`prefers-reduced-motion`**: en `globals.css`, una regla que neutralice `animate-pulse` bajo `@media (prefers-reduced-motion: reduce)` — cambio global de una sola regla, beneficia a `Skeleton` en toda la app (no solo estas 2 pantallas) sin tocar ningún componente.
5. **No se toca `SearchableSelect`** (hallazgo 6) ni ninguna otra pantalla — ver Open Questions.

## Tech Stack

Sin cambios, sin librerías nuevas.

## Project Structure

```
lib/pivot-colors.ts       -> NUEVO: constantes de color compartidas (hoy/fin de semana/header/footer)
app/mis-horas/page.tsx    -> usa lib/pivot-colors.ts; aria-label en Trash2 (mobile y desktop) y en ← →
app/mi-reporte/page.tsx   -> usa lib/pivot-colors.ts (es de solo lectura, no tiene Trash2 ni ← →)
app/globals.css           -> regla prefers-reduced-motion para .animate-pulse
```

## Code Style

`lib/pivot-colors.ts` exporta constantes simples (`export const PIVOT_COLORS = { header: '#0170B9', headerToday: '#b45309', headerWeekend: '#3d5a80', ... }`), sin funciones ni clases — mismo nivel de abstracción que las constantes `CELL_W`/`NAME_W`/`TOTAL_W` que ya usa cada página. Los `style={{}}` siguen igual, solo referencian la constante en vez del hex literal.

## Testing Strategy

Sin suite automatizada — patrón ya usado en el repo: `npx tsc --noEmit` + `npm run build` + verificación manual. Para este spec en particular:
- Calcular contraste de los 2 colores corregidos contra blanco (>4.5:1) y confirmar visualmente que "hoy"/"fin de semana" siguen siendo distinguibles del header normal.
- Confirmar con el inspector de accesibilidad del navegador (o lector de pantalla) que los botones de ícono anuncian su nombre.
- Con "Reducir movimiento" activado en el SO, confirmar que el `Skeleton` ya no pulsa.
- `git diff --stat` confirma cero cambios fuera de los 4 archivos listados.

## Boundaries

- **Always**: mantener el significado visual actual (hoy = acento cálido, fin de semana = acento frío/apagado, ambos más oscuros que antes solo para pasar contraste); no tocar lógica de datos ni queries.
- **Ask first**: extender el fix de ARIA/contraste a otras pantallas que comparten componentes (`Skeleton` ya se resuelve acá por ser una sola regla global; `SearchableSelect` no).
- **Never**: tocar Gantt, Control de Horas, `/admin/*`, `/projects`, `/holidays`, `/resources`; agregar librerías nuevas; reemplazar la paleta de marca; tocar `SearchableSelect.tsx` (hallazgo 6, fuera de alcance de este spec).

## Success Criteria

1. Texto blanco sobre header/footer "hoy" y "fin de semana" en ambas tablas pivot pasa 4.5:1 de contraste (verificado por cálculo).
2. Botón de borrar fila (Mis Horas, mobile y desktop) y botones de navegación de semana tienen `aria-label` descriptivo.
3. Con `prefers-reduced-motion: reduce` activo, `Skeleton` no anima.
4. Los 6 valores de color duplicados viven en un solo archivo (`lib/pivot-colors.ts`), usado por ambas páginas.
5. Sin cambios visuales no intencionados: capturas antes/después de ambas tablas confirman que solo cambiaron los 2 tonos de acento corregidos.
6. `git diff --stat` confirma cero cambios en Gantt, Control de Horas, `/admin/*`, `/projects`, `/holidays`, `/resources`, `SearchableSelect.tsx`.
7. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

- El hallazgo 6 (`SearchableSelect` sin roles ARIA de combobox) queda documentado pero fuera de este spec porque afecta 4 pantallas, no 2 — si se quiere resolver, amerita su propio spec acotado a ese componente.

---

# Spec: Sistema de toasts + confirmaciones accesibles + fix de foco en Mis Horas

## Objective

Tres pedidos relacionados sobre feedback al usuario e interacción:

1. **Reemplazar `alert()` de JavaScript por toasts**, con buenas prácticas de color/duración/accesibilidad (verde=éxito, rojo=error, etc.).
2. **Bug de foco en Mis Horas**: al tabular entre celdas de la grilla semanal y cargar horas, la 3ra celda pierde el foco al escribir el número (las primeras 2 funcionan bien).
3. **(Ampliación de alcance, confirmada con el usuario)**: reemplazar los 11 `confirm()` nativos (todos guardan acciones destructivas — borrar fila, proyecto, usuario, etc.) por un modal de confirmación accesible.

**Éxito** = ningún flujo de la app usa `alert()`/`confirm()` nativos; los toasts tienen variante visual clara (éxito/error/advertencia) con buenas prácticas de duración y accesibilidad; las confirmaciones destructivas usan un modal accesible con foco atrapado y texto claro; y en Mis Horas se puede tabular por una fila completa cargando horas en cada celda sin que ninguna pierda el foco.

## Hallazgos clave de la exploración

**Bug de foco (causa raíz confirmada)**: `app/mis-horas/page.tsx` tiene un estado `refreshKey` global (`useState(0)`, línea 80) usado como sufijo del `key` de **cada celda de día de la tabla completa** (`key={`${key}-${day}-${refreshKey}`}`, tanto en la grilla desktop como en el input mobile). `saveCell()` es `async`, y tras el `await fetch` + `await invalidateQueries` incrementa `refreshKey` (línea 230) — ese incremento cambia el `key` de **todas** las celdas de día de **todas** las filas simultáneamente, forzando a React a desmontar y remontar cada `<input>` de la tabla. Si el usuario ya tabuló a una celda distinta mientras el guardado (async) de la celda anterior todavía está en vuelo, ese remount global le arranca el foco a la celda en la que el usuario está escribiendo en ese momento — coincide exactamente con "en la 2 anda bien, en la 3 se pierde": el round-trip de red de la celda 1 suele resolver justo cuando el usuario ya está escribiendo en la celda 3.

**Toasts**: `@radix-ui/react-toast` ya está en `package.json` (`^1.2.15`) pero **no se usa en ningún lado** — no hay `Toaster`, ni `ToastProvider`, ni ningún componente de toast en el repo. Se relevaron 7 `alert()` (validación/error/éxito puntual, repartidos en `admin/hours`, `admin/roles`, `admin/users`, `ResourceModal`) y 2 mensajes de éxito ad-hoc como texto plano (`tmSavedMsg` en Mis Horas, `success` en `/perfil`) — estos 9 sitios son los que se migran a toast (confirmado con el usuario: los ~19 errores de validación inline pegados a campos de formulario quedan como están, porque ahí el usuario necesita ver el error mientras corrige el campo, no en un toast que desaparece). No existen tokens de color semánticos (éxito/error/advertencia) en `globals.css`/`tailwind.config.ts` hoy — cada uso de verde/rojo/ámbar en la app es una clase Tailwind cruda puesta a mano, sin token compartido.

**Confirmaciones**: se relevaron 11 `confirm()` nativos, los 11 para acciones destructivas (borrar fila/mes T&M en Mis Horas, proyecto, recurso, usuario, rol, feriado, tarea, asignación de Gantt). `@radix-ui/react-alert-dialog` (el primitivo correcto para esto — semántica distinta a `react-dialog`, que ya está instalado y se usa en los modales existentes) **no está instalado**, hay que agregarlo.

## Decisiones confirmadas

1. **Toast sobre `@radix-ui/react-toast`** (no se instala `sonner` ni otra librería): ya está en `package.json` sin usar, es accesible por diseño (región `aria-live`, cierre con Escape, swipe-to-dismiss en mobile, pausa al pasar el mouse — todo esto viene gratis del primitivo de Radix), y mantiene consistencia con el resto de la app, que ya usa primitivos Radix sueltos (`Dialog`, `Popover`, `Select`, etc.) en vez de un framework de componentes. Se construye un wrapper delgado, patrón shadcn (`components/ui/toast.tsx` + `components/ui/Toaster.tsx`), sin dependencias de estado nuevas (`lib/toast.ts` expone `toast({ title, description, variant })` con un store simple de módulo + subscriptores, sin zustand ni context extra).
2. **3 variantes**: `success` (verde), `error` (rojo), `warning` (ámbar) — cubren los 9 sitios migrados. `variant` es obligatorio en el tipo (no hay default), para forzar a cada call site a elegir conscientemente el color en vez de heredar uno por accidente.
3. **Nuevos tokens de color semánticos** en `globals.css`/`tailwind.config.ts` (`--zircon-success*`, `--zircon-error*`, `--zircon-warning*` → `success`/`error`/`warning` en Tailwind), mismo patrón que los `--zircon-blue*` → `primary` ya existentes. Se reutilizan los mismos tonos que la app ya usa hoy a mano (green-600, red-600/700, amber-800) para que no cambie la paleta percibida, solo se centraliza.
4. **Duración y comportamiento** (buenas prácticas estándar de toast — Material Design / Nielsen Norman Group): `success`/`warning` se autodescartan a los 5s, `error` a los 7s (un error necesita más tiempo de lectura) — todos con botón de cierre manual (×) y pausa del timer al pasar el mouse (comportamiento nativo de Radix Toast). Posición: esquina inferior derecha (no compite con el sidebar, que está a la izquierda), apilados si hay más de uno activo.
5. **`confirmDialog()` sobre `@radix-ui/react-alert-dialog`** (dependencia nueva, única de este spec): mismo patrón de store simple que el toast, expone `confirmDialog({ title, description, confirmLabel?, variant? }): Promise<boolean>` — la firma imita a `confirm()` nativo (una función que se espera y devuelve true/false) para que migrar cada call site sea mecánico: `if (!confirm(msg)) return` → `if (!(await confirmDialog({ title, description }))) return`. `variant: 'destructive'` (default, ya que los 11 casos actuales son todos borrados) pinta el botón de confirmar en rojo; Escape/click afuera/Cancelar resuelven `false`.
6. **Fix del bug de foco**: se elimina el estado `refreshKey` (innecesario) y el `key` de cada celda pasa a depender **solo de su propio valor guardado** (`key={`${key}-${day}-${row[day] ?? 0}`}` en vez de `${refreshKey}`). Así el remount de una celda ocurre únicamente cuando **esa** celda puntual recibe un valor nuevo del servidor (lo cual ya pasa después de su propio blur, nunca mientras está enfocada) — nunca por el guardado de una celda distinta. Mismo fix en la vista mobile de un día a la vez (línea 452), que tiene el mismo patrón.
7. **No se toca** ningún endpoint, la lógica de negocio de ninguna pantalla, ni los ~19 errores de validación inline de formularios (quedan con su tratamiento actual).

## Tech Stack

Una dependencia nueva: `@radix-ui/react-alert-dialog` (mismo publisher que los Radix ya instalados). `@radix-ui/react-toast` ya estaba instalado. Sin otras librerías nuevas.

## Project Structure

```
lib/toast.ts                        -> NUEVO: store de toasts + función toast({ title, description, variant })
components/ui/toast.tsx             -> NUEVO: primitivos Radix Toast (Provider/Viewport/Root/Title/Description/Close) con estilos por variante
components/ui/Toaster.tsx           -> NUEVO: renderiza los toasts activos del store
lib/confirm-dialog.ts               -> NUEVO: store + función confirmDialog({ title, description, confirmLabel?, variant? }): Promise<boolean>
components/ui/ConfirmDialog.tsx     -> NUEVO: AlertDialog de Radix montado una vez, controlado por el store
app/layout.tsx                      -> monta <Toaster /> y <ConfirmDialog /> una sola vez
app/globals.css                     -> +tokens --zircon-success/error/warning
tailwind.config.ts                  -> +colors success/error/warning
package.json                        -> +@radix-ui/react-alert-dialog

-- alert() -> toast() (7 sitios):
app/admin/hours/page.tsx            (3)
app/admin/roles/page.tsx            (2)
app/admin/users/page.tsx            (1)
components/modals/ResourceModal.tsx (1)

-- mensaje ad-hoc -> toast() (2 sitios, se elimina el estado local):
app/mis-horas/page.tsx              (tmSavedMsg -> toast(); además fix del bug de foco en este mismo archivo)
app/perfil/page.tsx                 (success -> toast())

-- confirm() -> confirmDialog() (11 sitios):
app/admin/hours/page.tsx (2)   app/admin/roles/page.tsx (1)   app/admin/users/page.tsx (1)
app/holidays/page.tsx (1)      app/mis-horas/page.tsx (2)     app/projects/page.tsx (1)
app/resources/page.tsx (1)     components/gantt/GanttRow.tsx (1)
components/modals/ProjectModal.tsx (1)
```

## Code Style

`lib/toast.ts` y `lib/confirm-dialog.ts` siguen el mismo estilo minimalista (store de módulo + array de subscriptores, sin librería de estado nueva) — igual de livianos que los componentes `StatCard`/`EmptyState`/`Skeleton` ya existentes en `components/ui/`. Los call sites migrados cambian lo mínimo indispensable: `alert(msg)` → `toast({ title: msg, variant: '...' })`, `if (!confirm(msg)) return` → `if (!(await confirmDialog({ title: '...', description: msg }))) return` (la función contenedora ya es `async` en la mayoría de los 11 casos, al ser handlers que hacen `fetch` después).

## Testing Strategy

Sin suite automatizada — patrón ya usado en el repo: `npx tsc --noEmit` + `npm run build` + QA manual en navegador. Para este spec en particular:
- Disparar al menos un toast de cada variante (éxito/error/advertencia) y confirmar color, ícono, auto-descarte en el tiempo esperado, y que el botón de cierre manual funciona.
- Confirmar al menos 2 flujos de confirmación destructiva (ej. borrar fila en Mis Horas, borrar un proyecto): el modal atrapa el foco, Escape/Cancelar no ejecutan la acción, Confirmar sí la ejecuta.
- **Foco en Mis Horas**: tabular por una fila completa (7 celdas) cargando un valor distinto en cada una, sin usar el mouse — confirmar que el foco nunca salta a otra celda ni al body mientras el guardado anterior está en vuelo. Repetir en la vista mobile de un día.
- `git diff --stat` confirma que los únicos archivos tocados son los listados arriba (ningún cambio en Gantt, Control de Horas, ni en los ~19 sitios de error inline de formularios que quedan fuera de alcance).

## Boundaries

- **Always**: usar los tokens de color nuevos (`success`/`error`/`warning`) en vez de clases Tailwind crudas en los sitios migrados; mantener `variant` obligatorio en `toast()` (sin default).
- **Ask first**: extender la migración a los ~19 errores de validación inline de formularios (fuera de alcance, confirmado con el usuario); cualquier cambio de posición/duración de los toasts distinto a lo acordado acá.
- **Never**: tocar la lógica de negocio de los endpoints detrás de cada `alert()`/`confirm()` migrado — este spec es puramente de presentación/interacción; dejar `refreshKey` o un patrón equivalente reintroducido en Mis Horas.

## Success Criteria

1. Cero llamadas a `alert()` o `confirm()` nativos en todo el repo (`grep -rn "alert(\|confirm(" app components` solo encuentra los wrappers nuevos, si acaso).
2. Los 9 sitios de alert()/mensaje ad-hoc muestran un toast con la variante de color correcta (éxito=verde, error=rojo, advertencia=ámbar).
3. Los 11 sitios de `confirm()` usan el modal accesible; Cancelar/Escape no ejecutan la acción destructiva.
4. En Mis Horas, tabular por una fila completa cargando horas en cada celda no le hace perder el foco a ninguna celda (desktop y mobile).
5. `git diff --stat` confirma que los ~19 errores de validación inline de formularios no fueron tocados.
6. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

Ninguna — alcance confirmado con el usuario antes de escribir este spec.

---

# Spec: "Copiar la semana pasada" en Mis Horas (modo Detallado)

## Objective

Agregar a `/mis-horas` (modo Detallado) un botón "Copiar la semana pasada" equivalente al de Clockify (ver captura adjunta del usuario): un botón con menú desplegable de 2 opciones — **Copiar solo actividades** (trae las filas de proyecto/tarea de la semana anterior, sin horas) y **Copiar actividades y tiempo** (trae las filas *con* sus horas, día por día). El botón se deshabilita por completo si la semana actual ya tiene alguna hora cargada, para que nunca se use para pisar datos existentes.

**Éxito** = con la semana actual vacía, el usuario puede traer de un clic las mismas filas (y opcionalmente las mismas horas) que cargó la semana anterior, en vez de recrearlas a mano una por una; en cuanto la semana actual tiene alguna hora, el botón queda visiblemente deshabilitado; se ve y se usa bien en mobile (no se rompe el layout ni el menú queda cortado).

## Hallazgos clave de la exploración

- `weekTotal` (`app/mis-horas/page.tsx:175`) ya es exactamente la condición que hace falta para el estado deshabilitado — es `> 0` apenas hay una sola hora cargada esta semana, en cualquier fila.
- **Agregar una fila "solo actividad" ya es gratis hoy**: `addRow()` (línea 182) simplemente empuja un `rowKey` a `selectedRowKeys` — no pega al servidor. "Copiar solo actividades" es exactamente ese mismo mecanismo, aplicado en lote a los `rowKey` de la semana pasada.
- **`@radix-ui/react-dropdown-menu` ya está instalado (`^2.1.16`) pero no se usa en ningún lado del repo** — mismo patrón que encontramos con `@radix-ui/react-toast` y `@radix-ui/react-alert-dialog` antes de este spec: la dependencia ya estaba, solo faltaba construir el componente. No hace falta ningún paquete nuevo. Tampoco hay ningún menú desplegable hoy en toda la app (ni siquiera el de "Cerrar sesión" en el sidebar, que es un botón plano) — este es el primero, pero Radix ya trae manejo de foco/teclado/posicionamiento-vía-portal resuelto, evitando de raíz el bug de recorte por `overflow` que ya tuvimos que arreglar una vez en `SearchableSelect`.
- El endpoint `/api/me/time-entries` ya soporta todo lo necesario sin cambios: `GET` con `dateFrom`/`dateTo` para traer la semana pasada, y `PUT` upsert por celda (mismo que usa `saveCell` hoy) para escribir las horas copiadas.

## Decisiones confirmadas

1. **Alcance: solo modo Detallado.** El modo T&M ya tiene su propio mecanismo de "traer datos rápido" (Aplicar a todos los días + Guardar mes) — no se toca.
2. **Deshabilitado ⟺ `weekTotal > 0`.** Exactamente como pidió el usuario: apenas hay una hora cargada esta semana (sin importar en qué fila), el botón entero queda deshabilitado. Como consecuencia, "Copiar actividades y tiempo" **nunca puede pisar datos existentes** — solo corre cuando la semana está vacía — así que no hace falta ningún diálogo de confirmación antes de copiar.
3. **"Copiar solo actividades"**: junta los `(projectId, taskId)` distintos con horas > 0 en la semana pasada, y agrega los que falten a `selectedRowKeys` (igual que `addRow()`, en lote). No pega al servidor — las celdas quedan vacías, listas para tipear.
4. **"Copiar actividades y tiempo"**: mismas filas, más sus horas replicadas al mismo día de la semana (lunes pasado → este lunes, etc.). Esto sí escribe al servidor: un `PUT` por cada celda con horas > 0 (en paralelo, `Promise.all`, mismo patrón que ya usa `removeRow` para los borrados en lote), con una sola invalidación de la query al final — no una por celda, para no disparar N refetch en cadena.
5. **Si la semana pasada está vacía**: clickear cualquiera de las 2 opciones muestra `toast({ variant: 'warning', title: 'No hay actividades cargadas la semana pasada' })` y no hace nada más. Se eligió **no** precalcular esto para pre-deshabilitar el botón, porque implicaría traer la semana pasada en cada visita a una semana vacía (el caso más común, ej. lunes a la mañana) sin necesidad — el costo de una query extra no se justifica solo para decidir un estado visual; el toast al clickear ya comunica lo mismo con un costo de red bien acotado (solo se pide la semana pasada cuando el usuario efectivamente clickea).
6. **Fetch de "semana pasada" es perezoso**: nuevo `useQuery` con `dateFrom`/`dateTo` = semana actual − 7 días, `enabled: mode === 'detailed' && weekTotal === 0` — solo se dispara cuando el botón podría llegar a usarse, no en cada navegación de semana.
7. **Componente nuevo `components/ui/CopyLastWeekMenu.tsx`**: wrapper delgado sobre `@radix-ui/react-dropdown-menu` (Root/Trigger/Portal/Content/Item), mismo lenguaje visual que el resto de `components/ui/*` (borde gris, texto `text-sm`, hover `bg-gray-50`). Recibe `disabled`, `loading`, `onCopyActivitiesOnly`, `onCopyActivitiesAndTime`.
8. **Mobile**: el botón vive en su propia fila, debajo de la barra de navegación de semana (no se mete dentro del `flex-wrap` que ya tiene esa barra, para no competir por espacio con las flechas `←`/`→` y la fecha). La etiqueta se acorta a "Copiar semana" en mobile (vía `useIsMobile()`, mismo hook ya usado en toda la página) y a "Copiar la semana pasada" en desktop. El menú desplegable de Radix ya maneja colisión con los bordes del viewport automáticamente (vía Popper), así que no hace falta lógica de posicionamiento a mano.
9. **No se toca** ninguna otra pantalla, ni el modo T&M, ni la lógica de `saveCell`/`removeRow`/`addRow` existentes — son llamadas nuevas que reusan esas mismas piezas.

## Tech Stack

Sin dependencias nuevas — `@radix-ui/react-dropdown-menu` ya está en `package.json`.

## Project Structure

```
components/ui/CopyLastWeekMenu.tsx  -> NUEVO: split-button + menú (Radix DropdownMenu)
app/mis-horas/page.tsx              -> +useQuery semana pasada (lazy), +copyActivitiesOnly(), +copyActivitiesAndTime(), +fila de toolbar bajo el week-nav
```

## Code Style

Mismo patrón que el resto de `components/ui/*`: componente chico, sin estado propio más allá de lo que expone Radix, estilos Tailwind directos (sin CSS módulos). `copyActivitiesAndTime()` sigue el mismo estilo `async function` + `Promise.all` + una sola `invalidateQueries` al final que ya usa `removeRow()`.

## Testing Strategy

Sin suite automatizada — patrón ya usado en el repo: `npx tsc --noEmit` + `npm run build` + QA manual en navegador. Casos a verificar explícitamente:
- Semana actual vacía, semana pasada con 2 filas y horas: "Copiar solo actividades" trae las 2 filas sin horas; "Copiar actividades y tiempo" trae las 2 filas con las horas en los mismos días de esta semana.
- Semana actual con al menos 1 hora cargada: el botón entero aparece deshabilitado (ambas opciones inalcanzables).
- Semana pasada vacía: clickear cualquiera de las 2 opciones muestra el toast de advertencia, no rompe nada.
- Mobile (`resize_window` a 375×812): el botón no se corta ni tapa la barra de navegación de semana; el menú desplegable se ve completo, sin quedar recortado por ningún contenedor con `overflow`.
- `git diff --stat` confirma cero cambios fuera de los 2 archivos listados.

## Boundaries

- **Always**: mantener el guard `disabled={weekTotal > 0}` como única condición de habilitado — no agregar checks adicionales que puedan dejarlo habilitado con datos ya cargados.
- **Ask first**: cualquier cambio a `saveCell`/`removeRow`/`addRow` existentes, o extender esta función al modo T&M.
- **Never**: escribir al servidor si `weekTotal > 0` (aunque la UI ya lo previene deshabilitando el botón, la función de copia no debe asumir que nunca la van a llamar en ese estado — conviene un guard defensivo al principio de `copyActivitiesAndTime()` también).

## Success Criteria

1. Con la semana actual vacía, "Copiar solo actividades" agrega las filas de la semana pasada sin horas.
2. Con la semana actual vacía, "Copiar actividades y tiempo" agrega las filas *y* las horas, alineadas al mismo día de la semana.
3. Con la semana actual con alguna hora cargada, el botón completo aparece deshabilitado.
4. Con la semana pasada vacía, clickear cualquier opción muestra el toast de advertencia sin romper nada.
5. Se ve y se usa correctamente en mobile (375px): sin cortes, sin menú recortado.
6. `git diff --stat` confirma cambios solo en los 2 archivos listados.
7. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

Ninguna.

---

# Spec: Investigación bug "borrar horas no guarda" + filtro de mes en Mi Reporte

## Objective

Dos pedidos del usuario:
1. **Bug reportado**: en Mis Horas, modo Detallado, borrar las horas de una celda o ponerla en 0 "no guarda el cambio".
2. **Feature**: en Mi Reporte, agregar un filtro rápido para seleccionar el mes anterior — hoy la única forma de cambiar de mes es escribir a mano en los campos Desde/Hasta.

## Hallazgos clave de la investigación (bug #1)

Se investigó a fondo y **no se pudo reproducir el bug con el código actual**, verificado contra la base real (Turso de dev, misma que producción) con datos de prueba descartables:

- Se leyó el código completo de guardado (`onBlur` en ambas vistas — mobile y desktop — y el endpoint `PUT /api/me/time-entries`, que ya hace `hours <= 0` → borra la entrada, patrón correcto).
- Un primer intento de reproducir vía eventos sintéticos de foco (`.focus()`/`.blur()`) no disparó el handler `onBlur` — **pero esto resultó ser una limitación del entorno de pruebas** (el pane de este entorno no renderiza con compositing real), no un bug de la app: al disparar el evento `focusout` directamente (el que React 17+ usa para `onBlur`), el handler se ejecutó correctamente, llamó a `saveCell`, se hizo el `PUT`, y la entrada **se borró correctamente** en la base — confirmado con una consulta directa a la DB antes y después.
- La lógica es idéntica entre la vista desktop y mobile (mismo patrón `val === '' ? 0 : Number(...)`, mismo chequeo de "no cambió, no hagas nada", mismo `saveCell`) — no se encontró ninguna asimetría entre ambas.
- **Hipótesis más probable si el usuario vio esto en producción**: el bug de remount global (`refreshKey`) corregido en un spec anterior de esta misma sesión (el que le robaba el foco a las celdas al tabular) pudo causar exactamente este síntoma — "cargo algo, parece que no quedó" — antes de ser corregido y mergeado. Si el usuario probó esto antes de que ese fix llegara a producción, es consistente con lo que reportó.

**No se aplica ningún cambio de código para el bug #1 en este spec** — no hay nada concreto que arreglar sin poder reproducirlo, y tocar código de guardado a ciegas es más riesgoso que útil. Se deja como pregunta abierta (ver abajo) para pedir un repro más específico si el usuario lo sigue viendo en el sitio actual.

## Decisiones confirmadas (feature #2 — filtro de mes en Mi Reporte)

1. **2 botones rápidos** "Este mes" / "Mes anterior" en la barra de filtros existente, junto a los campos Desde/Hasta (que se mantienen intactos para rangos custom) — mismo lenguaje visual que el botón "Limpiar" ya existente (borde gris, texto chico).
2. Cada botón simplemente recalcula `dateFrom`/`dateTo` a los límites del mes correspondiente y los aplica con `setDateFrom`/`setDateTo` — reutiliza exactamente la misma lógica que ya usa `resetFilters()` para "este mes", generalizada para aceptar un offset de meses.
3. **No se agrega un `<input type="month">` nuevo** (aunque el patrón ya existe en el modo T&M de Mis Horas) — los botones rápidos resuelven el pedido concreto ("mes anterior") con menos superficie de UI nueva; los campos Desde/Hasta siguen ahí para cualquier rango que no sea "este mes" o "mes pasado".
4. Mobile: los botones entran en el mismo contenedor `flex-wrap` que ya tiene la barra de filtros — sin tratamiento especial, ya es responsive.

## Tech Stack

Sin cambios, sin dependencias nuevas.

## Project Structure

```
app/mi-reporte/page.tsx  -> +2 botones de mes rápido en la barra de filtros
```

## Code Style

Mismo patrón que `resetFilters()` ya usa (calcular `y`/`m`/`lastDay` con `Date` nativo, sin `date-fns` para esto en particular ya que el resto del archivo tampoco lo usa para estos cálculos puntuales).

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + `npm run build` + QA manual: clickear "Mes anterior" y confirmar que Desde/Hasta cambian al mes previo completo y la tabla se actualiza; clickear "Este mes" y confirmar que vuelve al mes actual.

## Boundaries

- **Always**: mantener los campos Desde/Hasta funcionando igual que hoy para rangos custom.
- **Ask first**: cualquier cambio a `PUT /api/me/time-entries` o a los handlers `onBlur` de Mis Horas, dado que no hay bug confirmado que justifique tocarlos en este spec.
- **Never**: modificar el guardado de horas de Mis Horas sin un repro confirmado.

## Success Criteria

1. Botón "Mes anterior" en Mi Reporte cambia Desde/Hasta al mes calendario previo completo.
2. Botón "Este mes" vuelve al mes actual.
3. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

- **Bug #1 sigue abierto**. El usuario confirmó que lo vio tanto en celular como en computadora, así que se probaron 2 hipótesis adicionales contra la base real, ninguna reprodujo el problema:
  - Borrado de una sola celda con evento de blur real (no sintético): funciona, la entrada se borra correctamente.
  - 3 borrados disparados en simultáneo (sin esperar uno a que termine, simulando tabular rápido entre celdas de días distintos de la misma fila): las 3 se guardan correctamente, sin ninguna perdida por carrera.
  - Sigue pendiente: reproducirlo una vez en el sitio real y revisar la pestaña Network del navegador en el momento exacto en que "no guarda" — como se hizo para el bug de importación de Clockify (esa captura fue clave para encontrar la causa real). Puntualmente interesa ver si sale una request `PUT /api/me/time-entries`, y si sale, qué responde.

---

# Spec: Tareas desde Clockify — import, unicidad por proyecto, y desglose por tarea en Mi Reporte

## Objective

Tres cambios relacionados, todos alrededor de que las tareas ("Task") ahora importan en el flujo de importación de Clockify (hasta ahora ignoradas — toda entrada importada quedaba con `taskId: null`, tratada como Time & Material):

1. La importación de CSV de Clockify lee la columna "Tarea" y resuelve/crea el `Task` correspondiente en cada `TimeEntry` importada.
2. `Task.name` pasa a ser único dentro de cada proyecto — ya no se pueden crear dos tareas con el mismo nombre en el mismo proyecto, ni por API ni por CSV.
3. Mi Reporte muestra el desglose de horas por tarea dentro de cada proyecto, además del total por proyecto que ya existe.

**Éxito** = importar un CSV real de Clockify crea/reutiliza las tareas correctas y les atribuye las horas correctamente (sin mezclar tareas distintas del mismo día); no se pueden crear tareas duplicadas por nombre en un proyecto; Mi Reporte muestra cuánto se cargó por tarea; nada de lo que ya funciona (Mis Horas, Reporte Diario admin, el pivot de Mi Reporte) se rompe.

## Hallazgos clave (verificado contra CSV real + producción)

- **CSV real analizado** (`Clockify_Informe_De_Tiempo_Detallado_01_08_2026-31_08_2026 (4).csv`, 407 filas): confirma que los índices ya usados por `parseClockifyCsv()` (Proyecto=0, Usuario=5, Email=7, Fecha=10, Duración=15) son correctos para el export real de esta cuenta. La columna **"Tarea" está en el índice 3**, hoy completamente ignorada. A veces viene vacía — sigue significando "sin tarea", igual que hoy.
- El agrupador actual del CSV suma filas por `email|proyecto|fecha` — **sin la tarea en esa clave, filas del mismo proyecto/persona/día pero de tareas DISTINTAS se sumarían incorrectamente en una sola entrada**. Se confirmó en el CSV real que este caso existe (mismo proyecto/persona/día, tareas distintas en filas separadas). Hay que agregar la tarea a esa clave de agrupación.
- `Task.name` no tiene ninguna restricción de unicidad hoy (documentado como decisión explícita de un spec anterior). Se revisó la base real: **solo 13 tareas cargadas en total, 0 duplicados** — se puede agregar la restricción directo, sin limpieza de datos previa.
- El endpoint de importación (`app/api/time-entries/import/route.ts`, reescrito en el spec anterior para el bug del 500) tiene su lógica de upsert **hard-codeada a `taskId: null`** en todos lados — el `identity` de búsqueda, el INSERT crudo. Es el único lugar que necesita reescritura real para el punto 1.
- El resto de la app (Mis Horas Detallado, `weekTotal`, el pivot de Mi Reporte) ya está diseñado para tolerar múltiples filas por `(resourceId, projectId, date)` diferenciadas solo por `taskId` (incluido `null`) — la suma siempre es por fila, nunca colapsando antes por `(resource,project,date)`. Introducir `taskId` reales en las entradas importadas **no rompe ningún total existente**.
- El pivot de Mi Reporte (`lib/time-entries-pivot.ts`) agrupa solo por `(resourceId, projectId)` — no tiene dimensión de tarea, ni siquiera trae la relación `task`. **La columna "Total" por proyecto que ya existe en Mi Reporte ya es la suma de todas las horas de ese proyecto**, tenga tarea o no — el pedido "el total tiene que ser la suma de todas las tareas" ya se cumple automáticamente, no requiere cambiar el cálculo del total.
- **Riesgo real para "no romper hacia atrás"**: si se reimporta un mes ya importado ANTES de este cambio (con `taskId: null` en todas sus filas), la nueva lógica busca una fila existente con el `taskId` recién resuelto, no la encuentra (la vieja es `taskId: null`, identidad distinta) y crea una fila NUEVA — duplicando horas ese día. La app ya tiene el flujo correcto para esto: **"Eliminar horas por mes"** en `admin/hours`, pensado exactamente para reimportar sin duplicar. Se documenta como comportamiento esperado; no se construye lógica de fusión automática de filas viejas sin tarea con las nuevas (evita over-engineering sobre un caso ya cubierto por un flujo existente).

## Decisiones confirmadas

1. **Columna del CSV**: `parseClockifyCsv()` lee `cols[3]` ("Tarea"), trimeada; vacía → sin tarea (igual que hoy). Se agrega `taskName` a `ParsedTimeEntry` (opcional) y a la clave de agrupación (`email|proyecto|tarea|fecha`) para no mezclar horas de tareas distintas en una misma entrada.
2. **Resolución de tarea en el import**: dentro del `projectId` ya resuelto, match case-insensitive contra `Task.name` existente; si no hay match, se crea la tarea con el nombre tal cual viene de Clockify. Mismo patrón que ya existe para recursos/proyectos (`Map<string, number>`), pero scopeado por proyecto (`Task.name` no es único globalmente). Las tareas creadas durante un mismo import se agregan al mapa en memoria para que filas siguientes del mismo archivo reusen el id recién creado.
3. **`Task.name` único por proyecto**: `@@unique([projectId, name])` en el schema + migración (segura, 0 duplicados hoy). Además, chequeo case-insensitive en `POST /api/tasks` y `PUT /api/tasks/[id]` (y en la resolución del import) para que "Testing" y "testing" no convivan como tareas distintas — el constraint de DB solo cubre duplicados exactos; la validación case-insensitive vive en la capa de aplicación. Crear una tarea duplicada desde la UI (Mis Horas o `ProjectModal`) muestra un toast de error en vez de fallar en silencio.
4. **Reescritura del upsert de import**: el patrón "buscar existentes, separar en insertar/actualizar" (ya usado en el fix del bug 500) se generaliza para incluir `taskId` (nulo o no) en la identidad de cada fila, en vez de estar hard-codeado a `taskId: null`. Mismo patrón de dos lotes (`toInsert`/`toUpdate`) vía `turso.batch()`.
5. **Mi Reporte — desglose por tarea**: tabla nueva y separada, "Horas por tarea" (Proyecto — Tarea — Horas), debajo de la tabla pivot existente — **no se toca `buildTimeEntriesPivot`** (evita cualquier riesgo de regresión en `admin/daily-report`, que comparte esa función). Nueva query liviana, agrupa por `(projectId, taskId)` sobre el mismo rango de fechas/proyecto ya filtrado. Filas sin tarea (T&M) se agrupan bajo "Sin tarea". Ordenada por proyecto, luego por horas descendente.
6. **Alcance: solo importaciones nuevas, hacia adelante** — según lo pedido ("a partir de ahora hay que tener en cuenta"). No se reprocesan entradas ya importadas antes de este cambio.
7. **Las 13 tareas ya cargadas hoy** se dejan como están (no se borran automáticamente) — si el nombre coincide con una tarea de Clockify, el import la reusa; si no, crea una nueva al lado. Ver Open Questions.

## Tech Stack

Sin librerías nuevas. Requiere una migración de schema (`@@unique([projectId, name])` en `Task`) aplicada contra Turso vía script, mismo patrón que migraciones anteriores del repo.

## Project Structure

```
prisma/schema.prisma                  -> Task: +@@unique([projectId, name])
scripts/add-task-unique-constraint.ts -> NUEVO: migración idempotente contra Turso
app/admin/hours/page.tsx              -> parseClockifyCsv(): +taskName en la clave de agrupación y en ParsedTimeEntry
types/index.ts                        -> ParsedTimeEntry: +taskName?: string
app/api/time-entries/import/route.ts  -> resolución de taskId (match-or-create scopeado por proyecto) + upsert task-aware
app/api/tasks/route.ts                -> POST: valida nombre duplicado (case-insensitive) dentro del proyecto
app/api/tasks/[id]/route.ts           -> PUT: misma validación al renombrar
app/mis-horas/page.tsx                -> createTask(): maneja el error de nombre duplicado con toast
components/modals/ProjectModal.tsx    -> addTask(): mismo manejo de error
lib/time-entries-pivot.ts             -> SIN CAMBIOS (confirmado que no hace falta tocarlo)
app/mi-reporte/page.tsx               -> +tabla "Horas por tarea" (nueva sección, nueva query)
app/api/me/time-entries/route.ts      -> +vista de agregación por tarea, scopeada al resourceId propio
```

## Code Style

Reutiliza patrones ya establecidos: `Map<string, number>` para resolución de nombres (mismo estilo que `resourceMap`/`projectMap`), toast para errores de validación (`variant: 'error'`), el mismo patrón de dos lotes insert/update vía `turso.batch()` ya usado en el fix del bug 500.

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + `npm run build` + QA manual con el CSV real, contra datos de prueba descartables:
- Importar el CSV real (o un subconjunto): confirmar que las tareas se crean con los nombres correctos y las horas quedan atribuidas a la tarea correcta (no mezcladas entre tareas del mismo proyecto/día).
- Confirmar que las filas del CSV sin tarea siguen importándose igual que hoy (`taskId: null`).
- Intentar crear una tarea con nombre duplicado (mismo proyecto) desde `POST /api/tasks` y desde la UI de Mis Horas → error claro, no crea la tarea.
- Confirmar que el total por proyecto en Mi Reporte sigue siendo la suma correcta de todas sus tareas + entradas sin tarea.
- Confirmar que la tabla nueva "Horas por tarea" en Mi Reporte muestra los valores correctos para el rango filtrado.
- `git diff --stat` confirma que `lib/time-entries-pivot.ts` y `admin/daily-report` no fueron tocados.

## Boundaries

- **Always**: resolver `taskId` scopeado por `projectId` (nunca un match global de nombre de tarea entre proyectos distintos); mantener el comportamiento de "sin tarea" para filas del CSV sin columna Tarea.
- **Ask first**: borrar las 13 tareas ya existentes hoy (ver Open Questions); reprocesar/backfill de entradas ya importadas antes de este cambio.
- **Never**: tocar `lib/time-entries-pivot.ts` ni `admin/daily-report` para este spec; fusionar automáticamente filas viejas `taskId: null` con las nuevas filas con tarea al reimportar un mes ya importado (el flujo correcto es "Eliminar horas por mes" antes de reimportar, ya existente).

## Success Criteria

1. Importar el CSV real adjuntado crea las tareas correspondientes y las asocia correctamente a cada `TimeEntry`.
2. No se pueden crear 2 tareas con el mismo nombre (case-insensitive) en el mismo proyecto, ni por API ni por UI.
3. Mi Reporte muestra el desglose de horas por tarea, además del total por proyecto (ya existente, sin cambios).
4. `git diff --stat` confirma cero cambios en `lib/time-entries-pivot.ts`, `admin/daily-report`, Gantt, Control de Horas.
5. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

- ¿Borro las 13 tareas ya cargadas hoy para arrancar limpio, o las dejo? (si el nombre coincide con lo que trae Clockify se van a reusar solas; si no, van a convivir con las nuevas sin romper nada — no es necesario borrarlas para que esto funcione).

---

# Spec: Filtro por tarea (Mi Reporte), navegación por mes y desglose por tarea (Reporte Diario)

## Objective

Cuatro pedidos relacionados:

1. **Investigar**: la tarea "Diseño Checkout y Stripe MX" no aparece en el picker de Mis Horas.
2. Mi Reporte: agregar un filtro por Tarea, justo después del de Proyecto.
3. Reporte Diario (admin): agregar navegación por mes (flechas u otra forma), para no depender solo de elegir fecha Desde/Hasta a mano.
4. Reporte Diario: mostrar el desglose de horas por tarea cuando se elige un proyecto, igual que en Mi Reporte.

**Éxito** = queda claro por qué la tarea del punto 1 no aparecía (no era un bug); Mi Reporte permite filtrar por tarea dentro de un proyecto; Reporte Diario permite moverse entre meses con un clic; Reporte Diario muestra el desglose por tarea al elegir un proyecto — todo sin tocar `lib/time-entries-pivot.ts` (compartida entre las dos pantallas de reporte) ni la lógica de Gantt/Control de Horas.

## Hallazgos clave

- **Punto 1, resuelto sin cambio de código**: se consultó la base real — la tarea "Diseño Checkout y Stripe MX" (id 25, proyecto "MOB Mantenimiento") existe una sola vez, activa, sin duplicados ni diferencias de espacios/mayúsculas. No aparece en el picker de "+ Seleccionar proyecto" porque **ya es una fila cargada esa semana** (se ve en la propia captura del usuario, con 3 horas el lunes) — `pickerTaskOptions` excluye a propósito las tareas que ya son una fila, para no permitir agregar una fila duplicada. Es el comportamiento esperado. No se toca código para esto.
- **Reporte Diario hoy** (`app/admin/daily-report/page.tsx`) filtra por Persona y Proyecto (`SearchableSelect`, ya con búsqueda/orden alfabético de un spec anterior) y por un par Desde/Hasta de `<input type="date">` — sin atajos de mes, sin flechas. Pega a `/api/time-entries?view=pivot` (ruta admin, sin scope a un solo recurso), que ya usa `buildTimeEntriesPivot` — **la misma función que usa Mi Reporte**.
- **`buildTimeEntriesPivot` es agnóstica al filtro que recibe**: el `where: Prisma.TimeEntryWhereInput` se pasa tal cual a Prisma, sin que la función lea/hardcodee qué campos tiene — solo usa `range.from/to` para armar la lista de columnas de día. Esto confirma que se puede agregar `where.taskId = X` en el caller (tanto en `/api/time-entries` como en `/api/me/time-entries`) **sin tocar `lib/time-entries-pivot.ts` para nada** — ninguna de las 2 pantallas de reporte ni `admin/daily-report` se ven afectadas si no mandan ese filtro.
- **No existe hoy ningún endpoint admin de "horas por tarea"** — el único precedente es el `view=by-task` que se agregó a `/api/me/time-entries` en el spec anterior (agrupa por `taskId`, vía `groupBy`). Se replica el mismo patrón en `/api/time-entries` (admin), agrupando también solo por `taskId` (no por recurso) — coherente con "igual que en Mi Reporte", que tampoco desglosa por persona.
- **La tabla de Reporte Diario no tiene ninguna interacción de "click en una fila para ver más"** — cada fila de proyecto ya está bajo un encabezado de recurso (agrupación de 2 niveles: recurso → proyecto), a diferencia de Mi Reporte que es una lista plana de proyectos. El combo de Proyecto ya existente es el disparador más simple y consistente: al elegir un proyecto puntual (no "Todos los proyectos"), aparece la sección nueva debajo de la tabla — mismo patrón que ya construimos en Mi Reporte, sin inventar una interacción de click-en-fila nueva.

## Decisiones confirmadas

1. **Punto 1**: cerrado, sin cambios de código — documentado arriba.
2. **Mi Reporte — filtro por Tarea**: nuevo `SearchableSelect` "Tarea" en la barra de filtros, inmediatamente después de "Proyecto". Opciones desde `GET /api/tasks?projectId=X` — solo se puebla/habilita cuando hay un proyecto elegido (las tareas están scopeadas a un proyecto, no tiene sentido elegir tarea sin proyecto primero). Al elegir una tarea, se agrega `taskId` a los params de `view=pivot` y `view=by-task` — la tabla de días y el total de esa fila pasan a reflejar solo esa tarea (la función de pivot no cambia, solo recibe un `where` más angosto).
3. **`/api/me/time-entries` y `/api/time-entries`**: ambos GET aceptan un nuevo query param `taskId` opcional, que se agrega al `where` (`where.taskId = Number(taskId)`) antes de pasarlo a `buildTimeEntriesPivot` o al `groupBy` de `by-task`.
4. **Reporte Diario — navegación por mes**: flechas `←`/`→` (mismo componente visual y mismos `aria-label` "Mes anterior"/"Mes siguiente" que ya se usan en Mis Horas para semana), que desplazan el mes actual de `dateFrom` en ±1 y recalculan `dateFrom`/`dateTo` a los límites de ese mes — mismo cálculo que ya usa `selectMonth()` en Mi Reporte, aplicado de forma relativa en vez de a "este mes"/"mes anterior" fijos, para poder navegar indefinidamente hacia atrás o adelante. Los campos Desde/Hasta existentes **se mantienen** para rangos custom (no se reemplazan) — igual que se decidió para Mi Reporte.
5. **Reporte Diario — desglose por tarea**: nueva sección "Horas por tarea" debajo de la tabla pivot, **visible solo cuando hay un proyecto elegido** (no con "Todos los proyectos", para no traer una lista enorme de tareas de todos los proyectos mezcladas). Nuevo `view=by-task` en `/api/time-entries` (admin), agrupado por `taskId` únicamente — no por recurso, igual que Mi Reporte. Respeta los demás filtros ya activos (Persona, fechas) si están puestos.
6. **No se toca** `lib/time-entries-pivot.ts`, ni la agrupación recurso→proyecto ya existente en Reporte Diario, ni Gantt, ni Control de Horas.

## Tech Stack

Sin librerías nuevas.

## Project Structure

```
app/api/me/time-entries/route.ts    -> GET: +taskId opcional en el where (pivot y by-task)
app/api/time-entries/route.ts       -> GET: +taskId opcional en el where (pivot); +nuevo view=by-task (agrupado por taskId)
app/mi-reporte/page.tsx             -> +SearchableSelect "Tarea" tras "Proyecto"
app/admin/daily-report/page.tsx     -> +flechas de navegación por mes; +sección "Horas por tarea" cuando hay proyecto elegido
types/index.ts                      -> sin cambios (TaskHoursBreakdown ya sirve para ambos endpoints)
```

## Code Style

Mismo patrón ya establecido: `SearchableSelect` para el nuevo filtro de tarea (igual que Proyecto/Persona), flechas con `aria-label` explícito (mismo texto que Mis Horas), la sección "Horas por tarea" reutiliza el mismo markup/estilo que ya se construyó en `app/mi-reporte/page.tsx` (encabezado de proyecto + subfilas de tarea, sin necesitar rama mobile/desktop separada).

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + `npm run build` + QA manual con datos de prueba descartables:
- Mi Reporte: elegir un proyecto, luego una tarea → la tabla y el total reflejan solo esa tarea.
- Reporte Diario: flechas de mes navegan correctamente hacia atrás y adelante, Desde/Hasta se actualizan y la tabla recarga.
- Reporte Diario: elegir un proyecto muestra "Horas por tarea" con los valores correctos; "Todos los proyectos" no la muestra.
- `git diff --stat` confirma cero cambios en `lib/time-entries-pivot.ts`, Gantt, Control de Horas.

## Boundaries

- **Always**: mantener `buildTimeEntriesPivot` sin cambios — el filtro de tarea se resuelve enteramente en el `where` que arma cada caller.
- **Ask first**: extender el desglose por tarea de Reporte Diario para que también discrimine por persona (fuera de alcance de este spec, que replica el comportamiento de Mi Reporte tal cual).
- **Never**: tocar la agrupación recurso→proyecto ya existente en Reporte Diario; tocar Gantt o Control de Horas.

## Success Criteria

1. Mi Reporte: filtro de Tarea funcional, aparece tras Proyecto, solo habilitado con un proyecto elegido.
2. Reporte Diario: flechas de mes navegan correctamente; Desde/Hasta siguen funcionando para rangos custom.
3. Reporte Diario: "Horas por tarea" aparece al elegir un proyecto, con los valores correctos.
4. `git diff --stat` confirma cero cambios en `lib/time-entries-pivot.ts`, Gantt, Control de Horas.
5. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

Ninguna.

---

# Spec: Import de Vacaciones desde CSV (Vacaciones programadas)

## Objective

La sección "Vacaciones programadas" de `/holidays` hoy solo permite cargar vacaciones una por una vía `VacationModal`. El usuario tiene un CSV histórico ("Registro Inasistencias/Vacaciones") exportado de un Google Form, con columnas `Timestamp, Email Address, Starting, Finishing, Half Day or Full Day?, Type of Time off`, y quiere poder importarlo masivamente, igual que ya existe para Feriados por País.

**Éxito** = un admin puede subir el CSV, ver un preview con las filas de 2026 ya resueltas contra un `Resource` (match directo por email o heurístico por nombre), asignar manualmente el recurso a las filas sin match automático (o descartarlas), corregir/descartar filas con datos inválidos, y confirmar la importación — creando registros `Vacation` con tipo y medio-día, sin duplicar filas ya importadas antes.

## Hallazgos clave de la exploración (macheo CSV ↔ DB)

- **Cobertura de `Resource.email` muy baja**: solo 6 de 29 recursos tienen email cargado. Match exacto por email por sí solo deja afuera a la mayoría de las personas del CSV.
- **Heurístico nombre↔email viable como fallback**: varios recursos sin email están nombrados igual al local-part del email (`fwade`, `ifrancisco`) o siguen el patrón "inicial del nombre + apellido" (`aragih@zircon.tech` → "Abdulelah Ragih", `ppietraroia@zircon.tech` → "Pablo Pietraroia", `prappalini@zircon.tech` → "PABLO RAPPALINI", etc.).
- **Alcance acordado con el usuario: solo filas con `Starting` en 2026.** Sobre esas 57 filas: 24 matchean directo por email, 13 más por heurístico (37/57 total), y **20 filas de 6 personas quedan sin candidato** (`mmartin@zircon.tech` sola aporta 11 de esas 20; el resto: `mcasal@zircon.tech`, `matiascasalh@gmail.com`, `faguero@zircon.tech`, `kleon@zircon.tech`, `oantilef@zircon.tech`). Estas personas no tienen un `Resource` reconocible en el sistema hoy (o el nombre no se parece lo suficiente al email).
- **Una fila con dato inválido**: `faguero@zircon.tech`, `Starting=9/24/2026`, `Finishing=9/3/2026` (fin antes que inicio) — se excluye del import y se reporta como error, sin invertir fechas.
- **El modelo `Vacation` no tiene `type` ni `halfDay`** — solo `startDate`, `endDate`, `notes` (texto libre). El CSV trae "Type of Time off" (`Vacation / Day Off` | `Sick Day` | `Birthday`) y "Half Day or Full Day?" que no tienen dónde guardarse hoy sin cambiar el schema.
- **`luciana.diniz@riskified.com` y `ldiniz@zircon.tech` son la misma persona** (Luciana Diniz) con dos direcciones distintas — ambas resuelven al mismo `Resource` vía heurístico.

## Decisiones confirmadas con el usuario

1. **Alcance**: solo importar filas cuyo `Starting` caiga en el año 2026 (ignorar 2024/2025 del CSV histórico).
2. **Matching**: match directo por email exacto, con fallback heurístico (nombre igual al local-part, o patrón inicial+apellido contra `Resource.name`, sin distinguir mayúsculas/acentos). Las filas sin match automático se muestran en el preview con un `SearchableSelect` para asignar manualmente el recurso, o un toggle para descartarlas — no bloquean el resto del import.
3. **Schema**: agregar `type: String` y `halfDay: Boolean @default(false)` al modelo `Vacation` (migración chica, sin tocar `startDate`/`endDate`/`notes`/`resourceId` existentes). `type` guarda el valor crudo del CSV (`Vacation / Day Off`, `Sick Day`, `Birthday`); default `'Vacation / Day Off'` para vacaciones cargadas manualmente vía `VacationModal` (no rompe el flujo existente).
4. **Backfill de email**: cuando una fila se resuelve por heurístico (auto o asignación manual en el preview) y el `Resource` no tiene `email` cargado, se completa `Resource.email` con el email del CSV al confirmar el import. Nunca sobreescribe un email ya existente, aunque difiera del CSV (se deja tal cual, sin error bloqueante).
5. **Filas con fecha inválida** (`Finishing < Starting`): se excluyen del import y se listan como error en el resultado — no se intenta invertir fechas ni adivinar.
6. **Idempotencia**: antes de crear, se chequea si ya existe un `Vacation` con el mismo `(resourceId, startDate, endDate)` — si existe, se saltea y se cuenta como "ya existía" en vez de duplicar. No es una constraint de DB (una persona podría legítimamente cargar dos rangos idénticos en teoría), es un chequeo a nivel aplicación, igual que el patrón ya usado en `PUT /api/me/time-entries`.

## Tech Stack

Next.js 14 App Router, TypeScript, Prisma + Turso, TanStack Query. Reutiliza el patrón de `CsvImportModal` (parseo client-side con detección BOM/encoding, preview antes de confirmar, POST a un endpoint de import) y el patrón de resolución de nombres del import de tareas de Clockify (normalización case-insensitive).

## Project Structure

- `prisma/schema.prisma` — agregar `type` y `halfDay` a `Vacation`.
- `app/api/vacations/import/route.ts` (nuevo) — recibe filas ya parseadas + resueltas por el cliente (`{ resourceId, startDate, endDate, halfDay, type }[]`), aplica idempotencia, crea los `Vacation`, hace el backfill de `Resource.email` cuando corresponda.
- `components/modals/VacationCsvImportModal.tsx` (nuevo, separado de `CsvImportModal` porque el formato de columnas y la lógica de matching son completamente distintos) — parseo del CSV, filtro a filas 2026, resolución de matching (directo + heurístico), UI de preview con asignación manual/descarte por fila sin match, y de filas con error (fecha inválida).
- `app/holidays/page.tsx` — nuevo botón "Importar CSV" en la sección "Vacaciones programadas" (mismo estilo que el ya existente en "Feriados por País"), abre `VacationCsvImportModal`.
- `types/index.ts` — extender el tipo `Vacation` con `type: string` y `halfDay: boolean`.

## Code Style

Mismo patrón visual y de estados (loading/error/preview/result) que `CsvImportModal`. Función de normalización de nombres (para el heurístico) como helper puro y testeable, sin dependencias de red, ubicada junto al nuevo modal o en `lib/`.

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + `npm run build` + QA manual con datos de prueba descartables:
- Importar un CSV de prueba con: una fila de match directo, una de match heurístico, una sin match (verificar que aparece el picker manual), una con fecha inválida (verificar que se excluye y reporta), y una fila duplicada de una ya importada antes (verificar que no duplica).
- Verificar que el backfill de email solo pisa `Resource.email` cuando estaba vacío.
- Verificar en `/holidays` que las vacaciones importadas aparecen en la tabla con sus datos correctos.

## Boundaries

- **Always**: nunca sobreescribir un `Resource.email` ya existente. Nunca importar una fila fuera de 2026 sin confirmación explícita futura (este spec es solo para 2026). Nunca crear un `Vacation` duplicado silenciosamente.
- **Ask first**: si en el futuro se quiere importar años adicionales del mismo CSV, o cambiar el heurístico de matching.
- **Never**: modificar `CsvImportModal.tsx` ni `/api/country-holidays/import` (flujo de feriados, no tocar). No tocar Gantt, Control de Horas, ni la lógica de capacidad/sobrecarga existente — el nuevo campo `halfDay` queda como dato descriptivo, sin wiring a cálculos de capacidad en este spec.

## Success Criteria

1. Botón "Importar CSV" en "Vacaciones programadas", visible solo para admin.
2. Preview muestra correctamente: filas con match automático, filas sin match con picker manual, filas con error (fecha inválida) excluidas y listadas.
3. Confirmar el import crea los `Vacation` correctos (fechas, tipo, medio-día), sin duplicar reimportaciones, y completa `Resource.email` solo cuando estaba vacío.
4. `npx tsc --noEmit` y `npm run build` pasan sin errores.
5. QA manual con datos descartables confirma los 5 casos de la Testing Strategy.

## Open Questions

Ninguna.

---

# Spec: Reporte mensual "Info para invoicing" (Recurso × Proyecto)

## Objective

Todos los meses el usuario arma a mano una hoja de cálculo "Info para invoicing": una tabla pivot
con una fila por persona, una columna por proyecto, y las horas cargadas ese mes en cada celda, más
una columna "Total Horas" por fila. Quiere que ZirconTracker genere ese mismo contenido
automáticamente para no tener que armarlo a mano cada mes.

**Éxito** = desde una pantalla de ZirconTracker, elegir un mes y descargar un archivo `.xlsx` con
esa tabla ya armada — mismas horas que hoy carga a mano, en el mismo formato de pivot — para
pegar/subir directo a su Google Sheet.

## Hallazgos clave de la exploración (contra la imagen adjunta)

- **12 de 14 columnas de proyecto matchean exacto** contra `Project.name` en la base. "IMOUY (EG+)"
  y "Bench (Internal Issues)" son, a juzgar por el paréntesis, nombres viejos de los proyectos
  actuales "EG+" e "Internal Issues".
- **"SCC-Congroup" no existe como `Project`** en la base (igual tiene 64hs cargadas a un recurso en
  la imagen). El usuario confirmó que no lo va a crear como proyecto real.
- Los nombres de la columna "Recurso" en la planilla vieja no coinciden literalmente con
  `Resource.name` actual, pero casi todos resuelven a un recurso real una vez que se tiene en cuenta
  que varios fueron renombrados en la base durante esta misma sesión (ver tabla de mapeo abajo):
  `EDUARDO NOGUEIRA` → `Eduardo Nogueira Vicentini`, `AVNER NAHUM` → `AVNER Santos`, `lgutierrez` →
  `Luz Gutierrez`, `Facundo Wade Jacobs (fwade)` → `Facundo Wade`. El resto son alias/abreviaturas
  sin cambio en la base: `Bsilva` → `Betzabe Silva`, `Yan - Kreitech` → `Yan` (el otro recurso
  "Yan", distinto de "Kevin Yan" que ya está aparte en la lista), `Luciana Diniz Gonçalves dos
  Santos` → `Luciana Diniz`, `Victor Córdoba` → `Victor Cordoba`.
- **"Nicolas Daneri" no existe como `Resource`** en la base — es el único nombre de la lista que no
  resuelve a ningún recurso real.
- **"Total Horas" = suma de todas las columnas de esa fila** (verificado con la imagen: Abdulelah
  Ragih tiene 0.30 + 167.70 = 168.00, coincide exacto). No hay distinción de "horas facturables" —
  es la suma de todo lo cargado ese mes, sin importar proyecto.

## Decisiones confirmadas con el usuario

1. **Entrega**: pantalla en ZirconTracker con un selector de mes, un botón para generar una
   **previsualización**, y desde ahí descargar el `.xlsx` final — no hay push automático a un
   Google Sheet (eso requeriría autorizar un conector de Google que hoy no está conectado en esta
   sesión).
2. **Orden de filas y columnas: fijo, no derivado de la base.** El usuario dio el orden exacto de
   ambos ejes y tiene que respetarse tal cual, mes a mes:
   - **Proyectos (columnas), en este orden**: SCC-Congroup, Breinchild, IMOUY (EG+), Ideal Protein,
     Bench (Internal Issues), MOB Mantenimiento, SCC-Holcim, SmartWay, StarCenter, Suku 2024,
     Infogain, AI Assessments, Claldy, HubID-Guardian.
   - **Recursos (filas), en este orden**: Raul Velazquez, Abdulelah Ragih, AVNER NAHUM, Bruno
     Rodrigues Lopes, Bsilva, Claudio Uslenghi, EDUARDO NOGUEIRA, Facundo Wade Jacobs (fwade),
     Gonzalo Torterolo, Kevin Yan, lgutierrez, PABLO RAPPALINI, Rafael Basile, rgomez, RICARDO
     AMARANTE, Will Olivera, Yan - Kreitech, Luciana Diniz Gonçalves dos Santos, Victor Córdoba,
     Nicolas Daneri, Nelson Toledo.
   - Cada nombre de esta lista fija se resuelve a un `Resource`/`Project` real vía el mapeo de
     Hallazgos de arriba (match exacto donde coincide, alias hardcodeado donde no) — el texto que
     se muestra en el archivo final es el `Resource.name`/`Project.name` **actual** de la base, no
     la etiqueta vieja de la lista (la lista fija es solo la llave de orden + búsqueda).
3. **Avisos + previsualización cuando una persona/proyecto no tuvo horas ese mes, o no existe en la
   base**: el sistema NO los descarta en silencio. Se muestran en una previsualización con un aviso
   claro, y el usuario decide por checkbox si esa fila/columna va igual (en 0) o se excluye del
   archivo final para ese mes. Esto cubre tanto el caso "existe pero no cargó horas este mes" como
   el caso "no existe en la base" (`Nicolas Daneri`, `SCC-Congroup` hoy) — para estos últimos la
   previsualización simplemente no tiene de dónde sacar un total, pero igual se listan en el aviso
   para que quede claro que faltan, en vez de desaparecer sin explicación.
4. **Nombres mostrados**: `Resource.name` y `Project.name` actuales de la base (no los alias viejos
   de la lista fija, que solo sirven para el orden/búsqueda — ver punto 2).

## Tech Stack

Next.js 14 App Router, TypeScript, Prisma + Turso, librería `xlsx` (SheetJS) — ya es dependencia
del proyecto (usada por el import de SCC) — para generar el `.xlsx`.

## Project Structure

- `lib/invoicing-report.ts` (nuevo) — las dos listas fijas ordenadas (`INVOICING_PROJECT_ORDER`,
  `INVOICING_RESOURCE_ORDER`) como arrays de `{ label: string; lookupNames: string[] }` (`label` =
  el texto de la lista vieja, solo para referencia/debug; `lookupNames` = uno o más
  `Resource.name`/`Project.name` candidatos a matchear, case-insensitive, para cubrir los alias ya
  identificados — p.ej. `Bsilva` → `lookupNames: ['Betzabe Silva']`). Función pura
  `resolveInvoicingOrder(order, dbNames)` que, dado el array fijo y los nombres reales existentes en
  la base, devuelve para cada entrada `{ label, resolvedName: string | null }` (`null` = no existe
  ningún recurso/proyecto con ese nombre hoy).
- `app/api/reports/invoicing/route.ts` (nuevo) — `GET` con `?month=YYYY-MM`, admin-only
  (`requireAdmin`). Resuelve ambas listas fijas contra `Resource`/`Project` reales, hace
  `prisma.timeEntry.groupBy({ by: ['resourceId','projectId'], where: { date: {gte, lte} }, _sum: {
  hours: true } })` (mismo patrón que el `groupBy` de "Horas por tarea" ya usado en
  `/api/time-entries`/`/api/me/time-entries`), arma la matriz completa en el orden fijo, y devuelve
  JSON: `{ projects: [{label, resolvedName, hasData}], resources: [{label, resolvedName, hasData,
  total, hoursByProject}], warnings: string[] }` — no genera el `.xlsx` todavía, eso es un segundo
  paso una vez confirmada la previsualización.
- `app/api/reports/invoicing/export/route.ts` (nuevo) — `POST`, admin-only, recibe `{ month,
  includeProjects: string[], includeResources: string[] }` (las filas/columnas que el usuario
  confirmó incluir tras ver los avisos) y devuelve el `.xlsx` como buffer binario con
  `Content-Disposition: attachment`.
- Componente nuevo (p.ej. `components/modals/InvoicingReportModal.tsx` o una sección en
  `/admin/hours`) con: selector de mes → "Generar previsualización" → tabla de preview + bloque de
  avisos (mismo patrón visual que `VacationCsvImportModal`: caja ámbar con `AlertTriangle`, un
  checkbox por fila/columna con aviso para incluir/excluir) → botón "Descargar .xlsx" que llama al
  endpoint de export con la selección confirmada.

## Code Style

Reutilizar el patrón de `groupBy` + pivot en memoria ya usado en las rutas `by-task` de
`/api/time-entries`/`/api/me/time-entries`, y el patrón de preview-con-avisos-y-checkboxes ya usado
en `VacationCsvImportModal` (componentes/modals/VacationCsvImportModal.tsx) para la resolución
manual de filas problemáticas.

## Testing Strategy

Sin suite automatizada — `npx tsc --noEmit` + `npm run build` + QA manual con datos de prueba
descartables:
- Mes con horas de prueba para varios recursos/proyectos de la lista fija → preview muestra la
  matriz completa en el orden fijo correcto, con los nombres actuales de la base.
- Un recurso/proyecto de la lista fija sin horas ese mes (pero que sí existe en la base) → aparece
  en los avisos, con checkbox; si se destilda, no sale en el `.xlsx` final.
- `Nicolas Daneri` / `SCC-Congroup` (no existen en la base) → aparecen en los avisos explicando que
  no se encontró el recurso/proyecto, sin romper el resto de la previsualización.
- El `.xlsx` descargado respeta el orden fijo de columnas y filas, y el contenido de las celdas
  coincide con los totales ya mostrados en Reporte de Horas para el mismo mes.

## Boundaries

- **Always**: no crear "SCC-Congroup" ni "Nicolas Daneri" como registros reales — solo reportarlos
  como aviso en la previsualización. Nunca inventar un valor de horas para algo que no está en la
  base.
- **Ask first**: si en algún momento se quiere agregar push automático a Google Sheets (necesita
  autorizar un conector de Google primero), o si el orden fijo de personas/proyectos cambia y hay
  que actualizar `lib/invoicing-report.ts`.
- **Never**: modificar `buildTimeEntriesPivot` ni las vistas existentes de Reporte de Horas/Reporte
  Diario/Mi Reporte — este es un flujo nuevo e independiente.

## Success Criteria

1. La previsualización muestra la matriz completa en el orden fijo exacto dado por el usuario, con
   los nombres actuales de la base.
2. Toda fila/columna de la lista fija sin horas ese mes, o sin match en la base, aparece como aviso
   explícito con opción de incluir/excluir — nunca desaparece en silencio.
3. El `.xlsx` descargado refleja exactamente lo que el usuario confirmó en la previsualización, con
   los mismos totales que Reporte de Horas para ese mes.
4. `npx tsc --noEmit` y `npm run build` pasan sin errores.
5. QA manual con datos descartables confirma los casos de la Testing Strategy.

## Open Questions

Ninguna — el orden fijo y el manejo de avisos quedaron confirmados por el usuario.

---

# Spec: Nueva sección "Facturación" en el menú

## Objective

El bloque "Info para invoicing" vive hoy dentro de Reporte de Horas > Importar, mezclado con los
importadores de horas. El usuario quiere una opción de menú propia, al final, llamada
"Facturación", y que esa funcionalidad se mude ahí.

**Éxito** = el menú de Administración tiene una última entrada "Facturación" que lleva a una
página nueva con el mismo bloque de "Info para invoicing" (selector de mes, previsualización,
avisos, descarga) que hoy está en Reporte de Horas — y ya no está en Reporte de Horas.

## Decisiones (sin ambigüedad, no requirió preguntas)

1. Nueva ruta `/admin/billing`, protegida igual que el resto de `/admin/*` (el middleware ya exige
   rol admin para cualquier ruta bajo `/admin`, sin cambios ahí).
2. Entrada nueva al final de `ADMIN_ITEMS` en `components/layout/Sidebar.tsx` (después de "Control
   de Horas"), label "Facturación", ícono `Receipt` de `lucide-react` (nuevo import).
3. El componente `InvoicingReportExport` (y sus tipos `InvoicingRow`/`InvoicingCol`/
   `InvoicingPreview`) se mueven tal cual de `app/admin/hours/page.tsx` a la nueva página — se
   elimina el bloque y su bloque `<div className="border-t ...">` contenedor de
   `TabImport` en Reporte de Horas.

## Project Structure

- `app/admin/billing/page.tsx` (nuevo) — página mínima: título "Facturación" + `<InvoicingReportExport />`.
- `app/admin/hours/page.tsx` — se quita el bloque "4. Invoicing report export" de `TabImport` y se
  quita la función `InvoicingReportExport` (se muda entera a la página nueva).
- `components/layout/Sidebar.tsx` — nueva entrada en `ADMIN_ITEMS`.

## Boundaries

- **Never**: tocar `/api/reports/invoicing` ni `/api/reports/invoicing/export` — el backend no
  cambia, solo dónde vive el botón en el frontend.

## Testing Strategy

`npx tsc --noEmit` + `npm run build` + verificación visual en el browser: la nueva entrada
"Facturación" aparece al final del menú Administración, lleva a `/admin/billing`, el bloque
funciona igual que antes (previsualización + avisos + descarga), y ya no aparece en Reporte de
Horas > Importar.

## Success Criteria

1. "Facturación" aparece como última entrada del menú Administración.
2. `/admin/billing` muestra el mismo flujo de previsualización/descarga que antes.
3. El bloque ya no está en Reporte de Horas.
4. `npx tsc --noEmit` y `npm run build` pasan sin errores.

## Open Questions

Ninguna.
