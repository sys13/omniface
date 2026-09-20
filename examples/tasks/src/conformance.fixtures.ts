import type { ConformanceOptions, Harness } from '@omniface/testing'
import { createTasksApp, DEV_KEYS } from './app.ts'

/**
 * What the definition cannot know, and nothing else: a credential, and for the ops that write, a
 * valid input plus the state a read expects to find. Everything else about the suite — which ops,
 * which checks, which facets — comes from the app.
 *
 * `omniface conformance src/app.ts` finds this file by name. The same object is what the vitest suite
 * in test/generated-conformance.test.ts passes to `conformanceCases`.
 */

const seedOneTask = async (h: Harness) => void (await h.call('rest', 'tasks.create', { title: 'Seeded' }))

export default {
  app: () => createTasksApp({ logSink: () => {} }),
  apiKey: DEV_KEYS.admin,
  unprivileged: { apiKey: DEV_KEYS.reader, scopes: ['tasks:read'] },
  ops: {
    'tasks.create': { input: { title: 'Conformance' } },
    // A table screen with no rows proves nothing about what reaches the page, so the list gets a
    // row like every other read does. The `presentation` check says so out loud when it does not.
    'tasks.list': { setup: seedOneTask },
    'tasks.get': { input: { id: 'task_1' }, setup: seedOneTask },
    'tasks.update': { input: { id: 'task_1', title: 'Renamed' }, setup: seedOneTask },
    'tasks.complete': { input: { id: 'task_1' }, setup: seedOneTask },
    'tasks.delete': { input: { id: 'task_1' }, setup: seedOneTask },
    'apiKeys.create': { input: { name: 'conformance', scopes: ['tasks:read'] } },
    'agentToken.mint': { input: { scopes: ['tasks:read'], note: 'conformance' } },
    // The one op no input can reach: key ids are random, so there is no id to write down ahead of
    // the call, and the only ids that exist before one are the seeded keys — revoking the admin's
    // own key mid-case would pull the credential out from under the facets still to run. Skipped
    // deliberately rather than papered over with an id that would only ever produce not_found.
    'apiKeys.revoke': { skip: ['agree', 'idempotent'] },
  },
} satisfies ConformanceOptions
