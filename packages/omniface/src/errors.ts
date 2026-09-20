import type { ValidationIssue } from './standard.ts'

export const ERROR_CODES = {
  invalid_input: { status: 400, exit: 2, title: 'Invalid input' },
  unauthenticated: { status: 401, exit: 3, title: 'Unauthenticated' },
  forbidden: { status: 403, exit: 4, title: 'Forbidden' },
  not_found: { status: 404, exit: 5, title: 'Not found' },
  conflict: { status: 409, exit: 6, title: 'Conflict' },
  rate_limited: { status: 429, exit: 7, title: 'Rate limited' },
  internal: { status: 500, exit: 1, title: 'Internal error' },
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export type FacetErrorOptions = {
  issues?: ValidationIssue[]
  retryAfter?: number
  details?: Record<string, unknown>
  cause?: unknown
}

/** The one error model. Facets decide how to render it; nothing else decides what it means. */
export class FacetError extends Error {
  readonly code: ErrorCode
  readonly issues?: ValidationIssue[]
  readonly retryAfter?: number
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message?: string, options: FacetErrorOptions = {}) {
    super(message ?? ERROR_CODES[code].title, { cause: options.cause })
    this.name = 'FacetError'
    this.code = code
    this.issues = options.issues
    this.retryAfter = options.retryAfter
    this.details = options.details
  }

  get status(): number {
    return ERROR_CODES[this.code].status
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export const errors = {
  invalidInput: (message?: string, issues?: ValidationIssue[]) => new FacetError('invalid_input', message, { issues }),
  unauthenticated: (message?: string) => new FacetError('unauthenticated', message),
  forbidden: (message?: string) => new FacetError('forbidden', message),
  notFound: (message?: string) => new FacetError('not_found', message),
  conflict: (message?: string) => new FacetError('conflict', message),
  rateLimited: (retryAfter: number, message?: string) => new FacetError('rate_limited', message, { retryAfter }),
  internal: (message?: string, cause?: unknown) => new FacetError('internal', message, { cause }),
}

export function toFacetError(err: unknown): FacetError {
  if (err instanceof FacetError) return err
  return new FacetError('internal', 'Internal error', { cause: err })
}
