# @omniface/client

The runtime the TypeScript SDK and the CLI of a [omniface](https://github.com/sys13/omniface) app share:
auth, retries, idempotency keys, pagination and typed errors — plus `createClient<typeof app>()`,
an SDK inferred from the app definition with no code generation.

```sh
npm install @omniface/client
```

```ts
import { createClient } from '@omniface/client'
import type app from './app.ts'

const client = createClient<typeof app>({ baseUrl: 'https://api.acme.com', apiKey: process.env.ACME_API_KEY })
const task = await client.tasks.create({ title: 'Write the launch post' })
```

Full documentation: https://github.com/sys13/omniface
