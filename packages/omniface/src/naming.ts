export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

export function snake(s: string): string {
  return kebab(s).replace(/-/g, '_')
}

export function camel(s: string): string {
  return s.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RestBinding = { method: HttpMethod; path: string; status: number; pathParams: string[] }

/**
 * Convention: tasks.create → POST /tasks, tasks.list → GET /tasks, tasks.get → GET /tasks/{id},
 * tasks.update → PATCH /tasks/{id}, tasks.delete → DELETE /tasks/{id}, tasks.complete → POST /tasks/{id}/complete.
 * `{id}` appears only when the input has an `id` property.
 */
export function conventionalRest(path: string[], readonly: boolean, inputProps: string[]): RestBinding {
  const name = path[path.length - 1]!
  const base = '/' + path.slice(0, -1).map(kebab).join('/')
  const root = base === '/' ? '' : base
  const hasId = inputProps.includes('id')
  const withId = hasId ? `${root}/{id}` : root
  const params = hasId ? ['id'] : []
  switch (name) {
    case 'create':
      return { method: 'POST', path: root || '/', status: 201, pathParams: [] }
    case 'list':
      return { method: 'GET', path: root || '/', status: 200, pathParams: [] }
    case 'get':
      return { method: 'GET', path: withId || '/', status: 200, pathParams: params }
    case 'update':
      return { method: 'PATCH', path: withId || '/', status: 200, pathParams: params }
    case 'delete':
    case 'remove':
      return { method: 'DELETE', path: withId || '/', status: 200, pathParams: params }
    default:
      return {
        method: readonly ? 'GET' : 'POST',
        path: `${withId}/${kebab(name)}`,
        status: 200,
        pathParams: params,
      }
  }
}

export function pathParamsOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
}

export function conventionalToolName(path: string[]): string {
  return path.map(snake).join('_')
}

export function conventionalCommand(path: string[]): string[] {
  return path.map(kebab)
}

/**
 * Which screen an op becomes on the web facet. Derived, never declared: a read of a collection is
 * a table, any other read is a detail, anything that writes is a form. `destructive` does not add
 * a fourth kind — it adds a confirmation to whichever kind the op already is.
 */
export type ScreenKind = 'table' | 'detail' | 'form'

export type WebBinding = { screen: ScreenKind; path: string; pathParams: string[]; title: string; confirm: boolean }

export type ScreenTraits = { readonly?: boolean; paginated?: boolean; destructive?: boolean }

function humanize(s: string): string {
  const words = kebab(s).split('-')
  return words.join(' ')
}

/** Naive, and deliberately so: a wrong plural is a label, and labels are overridable (12.4). */
function singular(s: string): string {
  if (/ies$/.test(s)) return `${s.slice(0, -3)}y`
  if (/(s|sh|ch|x|z)es$/.test(s)) return s.slice(0, -2)
  if (/[^s]s$/.test(s)) return s.slice(0, -1)
  return s
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Convention: tasks.list → a table at /tasks, tasks.get → a detail at /tasks/{id},
 * tasks.create → a form at /tasks/new, tasks.update → /tasks/{id}/edit,
 * tasks.delete → /tasks/{id}/delete, tasks.complete → /tasks/{id}/complete.
 *
 * `collection` is whether the output is a list of rows — the trait says `paginated`, but an
 * unpaginated read that returns `items` is still a table, and the shape is what a person sees.
 */
export function conventionalScreen(
  path: string[],
  traits: ScreenTraits,
  inputProps: string[],
  collection: boolean,
): WebBinding {
  const name = path[path.length - 1]!
  const resource = path.length > 1 ? path[path.length - 2]! : path[0]!
  const base = '/' + path.slice(0, -1).map(kebab).join('/')
  const root = base === '/' ? '' : base
  const hasId = inputProps.includes('id')
  const withId = hasId ? `${root}/{id}` : root
  const params = hasId ? ['id'] : []
  // A top-level op (`ping`) has no resource to name, so the action is the whole title.
  const one = path.length > 1 ? humanize(singular(resource)) : ''
  const many = path.length > 1 ? humanize(resource) : humanize(name)
  const screen: ScreenKind = traits.readonly ? (traits.paginated || collection ? 'table' : 'detail') : 'form'
  const confirm = Boolean(traits.destructive)

  const route = (suffix: string, withParams: string[]): { path: string; pathParams: string[] } => ({
    path: suffix || '/',
    pathParams: withParams,
  })

  switch (name) {
    case 'list':
      return { screen, ...route(root, []), title: sentence(many), confirm }
    case 'get':
      return { screen, ...route(withId, params), title: sentence(one), confirm }
    case 'create':
      return { screen, ...route(`${root}/new`, []), title: `New ${one}`, confirm }
    case 'update':
      return { screen, ...route(`${withId}/edit`, params), title: `Edit ${one}`, confirm }
    default:
      return {
        screen,
        ...route(`${withId}/${kebab(name)}`, params),
        // With a subject in the route the action reads against it ("Complete task"); without one
        // there is nothing to act on, so the action is the whole label ("Whoami", not "Whoami auth").
        title: sentence(hasId ? `${humanize(name)} ${one}`.trim() : humanize(name)),
        confirm,
      }
  }
}
