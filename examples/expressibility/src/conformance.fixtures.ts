import type { ConformanceOptions, Harness } from '@omniface/testing'
import { createTrackerApp, DEV_KEYS } from './linear.ts'

/**
 * Fixtures for the control subject. The point of running the generated suite here is not to test
 * facet's own example app again — it is to check that a *foreign* app, written against the public
 * API with nothing hand-tuned, gets a working conformance suite for free. It does.
 *
 * `omniface conformance src/linear.ts` finds this file by name.
 */

const seedTeam = async (h: Harness) => void (await h.call('rest', 'teams.create', { key: 'ENG', name: 'Engineering' }))

const seedIssue = async (h: Harness) => {
  await seedTeam(h)
  await h.call('rest', 'issues.create', { teamId: 'team_1', title: 'Seeded' })
}

export default {
  app: () => createTrackerApp(),
  apiKey: DEV_KEYS.admin,
  unprivileged: { apiKey: DEV_KEYS.reader, scopes: ['issues:read'] },
  ops: {
    'teams.create': { input: { key: 'ENG', name: 'Engineering' } },
    'users.get': { input: { id: 'usr_admin' } },
    'issues.create': { input: { teamId: 'team_1', title: 'Conformance' }, setup: seedTeam },
    'issues.get': { input: { id: 'iss_2' }, setup: seedIssue },
    'issues.update': { input: { id: 'iss_2', title: 'Renamed' }, setup: seedIssue },
    'issues.assign': { input: { id: 'iss_2', assigneeId: 'usr_admin' }, setup: seedIssue },
    'issues.comment': { input: { id: 'iss_2', body: 'Looks good' }, setup: seedIssue },
    'issues.delete': { input: { id: 'iss_2' }, setup: seedIssue },
    'apiKeys.create': { input: { name: 'conformance', scopes: ['issues:read'] } },
    // Same reason as the tasks example: a key id is random, so no input can name one that exists
    // before the call, and revoking the admin's own key would strand the facets still to run.
    'apiKeys.revoke': { skip: ['agree', 'idempotent'] },
  },
} satisfies ConformanceOptions
