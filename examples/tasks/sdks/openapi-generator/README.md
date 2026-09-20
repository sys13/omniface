# Open-source generators

No account, no vendor. Two that read an OpenAPI 3.1 document with extensions intact:

## openapi-python-client

```sh
pnpm --filter example-tasks exec omniface build src/app.ts
uvx openapi-python-client generate --path .omniface/openapi.json --config sdks/openapi-generator/python.yaml
```

It reads `components.schemas` for its models, which is why facet hoists named types: without the
hoist you get `TasksCreateResponse`, `TasksGetResponse` and `TasksCompleteResponse` for one `Task`.

## openapi-generator-cli

```sh
npx @openapitools/openapi-generator-cli generate \
  -i .omniface/openapi.json \
  -g python \
  -c sdks/openapi-generator/openapi-generator.json \
  -o generated/python
```

Neither carries `x-omniface-*` into the generated code on its own. What they give you is the shapes
and the calls; the traits are yours to apply, and [docs/SDKS.md](../../../../docs/SDKS.md) says
which ones change behaviour (`readonly` and `idempotent` decide what is safe to retry, `paginated`
marks the ops that need an auto-paginator, `pii` decides what must not be logged).
