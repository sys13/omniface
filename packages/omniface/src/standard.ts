import type { StandardSchemaV1 } from '@standard-schema/spec'

export type { StandardSchemaV1 }
export type AnySchema = StandardSchemaV1<any, any>
export type InferIn<S> = S extends StandardSchemaV1<infer I, any> ? I : never
export type InferOut<S> = S extends StandardSchemaV1<any, infer O> ? O : never

export type ValidationIssue = { message: string; path: string }

export async function validate(
  schema: AnySchema,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; issues: ValidationIssue[] }> {
  let result = schema['~standard'].validate(value)
  if (result instanceof Promise) result = await result
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((i) => ({
        message: i.message,
        path: (i.path ?? []).map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.'),
      })),
    }
  }
  return { ok: true, value: result.value }
}

/** The input schema used by ops that declare none: accepts undefined or an empty object. */
export const emptyInput: StandardSchemaV1<Record<string, never> | undefined, Record<string, never>> & {
  '~standard': { jsonSchema: { input: () => Record<string, unknown>; output: () => Record<string, unknown> } }
} = {
  '~standard': {
    version: 1,
    vendor: 'omniface',
    validate: (value) =>
      value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value))
        ? { value: {} }
        : { issues: [{ message: 'Expected no input' }] },
    jsonSchema: {
      input: () => ({ type: 'object', properties: {} }),
      output: () => ({ type: 'object', properties: {} }),
    },
  },
}
