/**
 * Is a key containing `/` reachable on every facet? Run the same op on all four with two inputs,
 * one flat key and one nested — then show why the answer is yes: facet's clients percent-encode
 * the path parameter, and the literal form S3 itself uses does not route.
 */
import { buildManifest } from 'omniface'
import { createRestApp } from 'omniface/rest'
import { createHarness } from '@omniface/testing'
import { createStorageApp } from './src/s3.ts'

const app = createStorageApp()
const harness = createHarness(app, { apiKey: 'akia_admin' })

await harness.call('rest', 'buckets.create', { name: 'b' })

for (const key of ['cat.jpg', 'photos/2026/cat.jpg']) {
  await harness.call('rest', 'objects.put', { bucket: 'b', key, contentType: 'text/plain', body: 'aGk=' })
  const outcomes = {}
  for (const channel of ['rest', 'sdk', 'cli', 'mcp']) {
    const outcome = await harness.call(channel, 'objects.head', { bucket: 'b', key })
    outcomes[channel] = outcome.ok ? 'ok' : outcome.code
  }
  console.log(`key ${JSON.stringify(key).padEnd(24)} ->`, outcomes)
}

// And the reason it agrees: facet's clients percent-encode the key. Raw over HTTP, the literal
// form S3 itself uses does not route — which is defect 3 in docs/EXPRESSIBILITY.md.
const hono = createRestApp(app, buildManifest(app), { security: false })
for (const path of ['/b/photos%2F2026%2Fcat.jpg', '/b/photos/2026/cat.jpg']) {
  const res = await hono.request(path, { headers: { Authorization: 'Bearer akia_admin' } })
  console.log(`raw GET ${path.padEnd(28)} ->`, res.status)
}

await harness.close?.()
