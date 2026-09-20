/**
 * Study subject: Stripe's payments core.
 *
 * Why this one: it is the reference API for the things facet says it handles — idempotency keys,
 * cursor pagination, typed errors — plus three it has not met yet: money, polymorphic resources
 * (a PaymentMethod is a card *or* a bank account), and free-form `metadata`. It is also the API
 * most defined by *events*, which facet lists as unbuilt.
 */
import { errors, facet, paginate } from 'omniface'
import { apiKeys, idempotency, logging, rateLimit, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

/**
 * FITS — money is a first-class scalar. `t.money()` is `{ amount, currency }` tagged
 * `x-omniface-scalar: money`, which is exactly Stripe's minor-units representation, and the tag
 * travels to every facet and into OpenAPI.
 */
const Money = t.named('Money', t.money())

/**
 * FRICTION 4 — free-form maps. Stripe's `metadata` is an open string→string map on every object.
 * `z.record` survives to JSON Schema, but no facet does anything intelligent with it: the CLI has
 * no flag shape for "arbitrary key/value" (Stripe's own CLI invented `-d "metadata[k]=v"`), and
 * there is no trait that says "user-supplied, never validated, never redacted".
 */
const Metadata = t.named('Metadata', z.record(z.string(), z.string()))

/**
 * FRICTION 5 — polymorphism. A Stripe PaymentMethod is one of several shapes discriminated by
 * `type`. zod expresses it, and it reaches JSON Schema as a `oneOf`, so REST and MCP are fine.
 * The open question this file answers empirically is what the *generated SDK* and the *CLI* do
 * with a union — see docs/EXPRESSIBILITY.md.
 */
const Card = z.object({
  type: z.literal('card'),
  brand: z.enum(['visa', 'mastercard', 'amex']),
  last4: t(z.string().length(4), { sensitive: true }),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
})
const BankAccount = z.object({
  type: z.literal('bank_account'),
  bankName: z.string(),
  last4: t(z.string().length(4), { sensitive: true }),
  country: z.string().length(2),
})
const PaymentMethod = t.named('PaymentMethod', z.discriminatedUnion('type', [Card, BankAccount]))
type PaymentMethod = z.infer<typeof PaymentMethod>

const Customer = t.named(
  'Customer',
  z.object({
    id: t.id({ example: 'cus_123' }),
    email: t(z.email(), { pii: true }),
    name: t(z.string(), { pii: true }).nullable(),
    balance: Money,
    metadata: Metadata,
    createdAt: t.datetime(),
  }),
)
type Customer = z.infer<typeof Customer>

const PaymentIntent = t.named(
  'PaymentIntent',
  z.object({
    id: t.id({ example: 'pi_123' }),
    customerId: t.id(),
    amount: Money,
    status: z.enum(['requires_payment_method', 'requires_confirmation', 'processing', 'succeeded', 'canceled']),
    paymentMethod: PaymentMethod.nullable(),
    /** Stripe's own risk score: real, and never shown to the merchant's own API consumers. */
    riskScore: t(z.number(), { internal: true }),
    metadata: Metadata,
    createdAt: t.datetime(),
  }),
)
type PaymentIntent = z.infer<typeof PaymentIntent>

const Refund = t.named(
  'Refund',
  z.object({
    id: t.id({ example: 're_123' }),
    paymentIntentId: t.id(),
    amount: Money,
    reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).nullable(),
    createdAt: t.datetime(),
  }),
)
type Refund = z.infer<typeof Refund>

/**
 * FRICTION 6 — events are data here, but not a facet.
 *
 * Stripe's defining feature is the webhook: an event stream the integrator subscribes to. facet
 * can model the event *object* and a poll-style `events.list` (Stripe has one), and that is what
 * this does. What it cannot express is the delivery: an outbound subscription, a signed payload,
 * a retry schedule. The README lists webhooks and events as unbuilt; this is what their absence
 * costs on a real API.
 */
const Event = t.named(
  'Event',
  z.object({
    id: t.id({ example: 'evt_123' }),
    type: z.enum(['payment_intent.succeeded', 'payment_intent.canceled', 'refund.created']),
    objectId: t.id(),
    createdAt: t.datetime(),
  }),
)
type Event = z.infer<typeof Event>

export function createStripeApp() {
  const f = facet({
    plugins: [
      logging(),
      apiKeys({
        prefix: 'sk_',
        keys: [
          { key: 'sk_test_admin', principalId: 'acct_admin', scopes: ['*'] },
          { key: 'sk_test_reader', principalId: 'acct_reader', scopes: ['payments:read'] },
        ],
      }),
      scopes(),
      rateLimit({ limit: '100/sec' }),
      // Stripe's Idempotency-Key header, which facet already implements as a pipeline stage.
      idempotency(),
    ],
  })

  const customers = new Map<string, Customer>()
  const intents = new Map<string, PaymentIntent>()
  const refunds = new Map<string, Refund>()
  const events: Event[] = []
  let seq = 0
  const nextId = (prefix: string) => `${prefix}_${++seq}`

  const findCustomer = (id: string) => {
    const found = customers.get(id)
    if (!found) throw errors.notFound(`No customer "${id}"`)
    return found
  }
  const findIntent = (id: string) => {
    const found = intents.get(id)
    if (!found) throw errors.notFound(`No payment intent "${id}"`)
    return found
  }
  const record = (type: Event['type'], objectId: string) => {
    events.unshift({ id: nextId('evt'), type, objectId, createdAt: new Date().toISOString() })
  }

  const ops = {
    customers: {
      create: f
        .op({
          description: 'Create a customer',
          input: Customer.pick({ email: true, name: true, metadata: true }).partial({ name: true, metadata: true }),
          output: Customer,
        })
        .traits({ idempotent: true, scope: 'payments:write' })
        .handle(({ input }) => {
          const customer: Customer = {
            id: nextId('cus'),
            email: input.email,
            name: input.name ?? null,
            balance: { amount: 0, currency: 'usd' },
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString(),
          }
          customers.set(customer.id, customer)
          return customer
        }),

      get: f
        .op({ description: 'Retrieve a customer', input: z.object({ id: t.id() }), output: Customer, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'payments:read' })
        .handle(({ input }) => findCustomer(input.id)),

      list: f
        .op({ description: 'List customers', input: t.pageInput({ email: z.email().optional() }), output: t.page(Customer) })
        .traits({ readonly: true, paginated: true, scope: 'payments:read' })
        .handle(({ input }) =>
          paginate([...customers.values()].filter((c) => input.email === undefined || c.email === input.email), input),
        ),
    },

    paymentIntents: {
      create: f
        .op({
          description: 'Create a payment intent',
          input: z.object({ customerId: t.id(), amount: Money, paymentMethod: PaymentMethod.optional(), metadata: Metadata.optional() }),
          output: PaymentIntent,
          errors: ['not_found'],
        })
        // Stripe's whole reason for inventing the idempotency key: a retried charge must not
        // charge twice. facet enforces this in the pipeline, so every facet inherits it.
        .traits({ idempotent: true, scope: 'payments:write' })
        .handle(({ input }) => {
          findCustomer(input.customerId)
          const intent: PaymentIntent = {
            id: nextId('pi'),
            customerId: input.customerId,
            amount: input.amount,
            status: input.paymentMethod ? 'requires_confirmation' : 'requires_payment_method',
            paymentMethod: input.paymentMethod ?? null,
            riskScore: Math.random(),
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString(),
          }
          intents.set(intent.id, intent)
          return intent
        }),

      get: f
        .op({ description: 'Retrieve a payment intent', input: z.object({ id: t.id() }), output: PaymentIntent, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'payments:read' })
        .handle(({ input }) => findIntent(input.id)),

      list: f
        .op({
          description: 'List payment intents',
          input: t.pageInput({ customerId: t.id().optional() }),
          output: t.page(PaymentIntent),
        })
        .traits({ readonly: true, paginated: true, scope: 'payments:read' })
        .handle(({ input }) =>
          paginate([...intents.values()].filter((i) => !input.customerId || i.customerId === input.customerId), input),
        ),

      confirm: f
        .op({
          description: 'Confirm a payment intent and capture the funds',
          input: z.object({ id: t.id(), paymentMethod: PaymentMethod.optional() }),
          output: PaymentIntent,
          errors: ['not_found', 'conflict'],
        })
        .traits({ idempotent: true, scope: 'payments:write' })
        .handle(({ input }) => {
          const intent = findIntent(input.id)
          const method = input.paymentMethod ?? intent.paymentMethod
          if (!method) throw errors.conflict('A payment method is required before confirming')
          const next: PaymentIntent = { ...intent, paymentMethod: method, status: 'succeeded' }
          intents.set(next.id, next)
          record('payment_intent.succeeded', next.id)
          return next
        }),

      cancel: f
        .op({
          description: 'Cancel a payment intent',
          input: z.object({ id: t.id() }),
          output: PaymentIntent,
          errors: ['not_found', 'conflict'],
        })
        .traits({ idempotent: true, destructive: true, scope: 'payments:write' })
        .handle(({ input }) => {
          const intent = findIntent(input.id)
          if (intent.status === 'succeeded') throw errors.conflict('A succeeded intent cannot be canceled; refund it instead')
          const next: PaymentIntent = { ...intent, status: 'canceled' }
          intents.set(next.id, next)
          record('payment_intent.canceled', next.id)
          return next
        }),
    },

    refunds: {
      create: f
        .op({
          description: 'Refund a payment, in full or in part',
          input: z.object({
            paymentIntentId: t.id(),
            amount: Money.optional(),
            reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
          }),
          output: Refund,
          errors: ['not_found', 'conflict'],
        })
        .traits({ idempotent: true, destructive: true, scope: 'payments:write' })
        .handle(({ input }) => {
          const intent = findIntent(input.paymentIntentId)
          if (intent.status !== 'succeeded') throw errors.conflict('Only a succeeded payment can be refunded')
          const refund: Refund = {
            id: nextId('re'),
            paymentIntentId: intent.id,
            amount: input.amount ?? intent.amount,
            reason: input.reason ?? null,
            createdAt: new Date().toISOString(),
          }
          refunds.set(refund.id, refund)
          record('refund.created', refund.id)
          return refund
        }),
    },

    /** The poll half of Stripe's event model. The push half (webhooks) has no facet to live on. */
    events: {
      list: f
        .op({ description: 'List recent events, newest first', input: t.pageInput(), output: t.page(Event) })
        .traits({ readonly: true, paginated: true, scope: 'payments:read' })
        .handle(({ input }) => paginate(events, input)),
    },
  }

  return f.app({
    name: 'stripe',
    version: '0.1.0',
    description: 'A slice of Stripe — customers, payment intents, refunds and events',
    ops,
    facets: {
      // Every path here is conventional: Stripe's own routes are `/customers`, `/customers/{id}`,
      // `/payment_intents/{id}/confirm`. Flat `id` identity is what makes this possible, and it is
      // the whole difference from the GitHub subject.
      rest: true,
      sdk: true,
      cli: {
        binName: 'stripe',
        ops: {
          'customers.create': { args: ['email'] },
          'customers.list': { columns: ['id', 'email', 'name'] },
          'paymentIntents.list': { columns: ['id', 'customerId', 'status'] },
        },
      },
      mcp: {
        ops: {
          'paymentIntents.list': { maxItems: 10 },
        },
      },
    },
  })
}

const app = createStripeApp()
export default app
