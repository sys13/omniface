/**
 * The facets omniface ships. Import order is registration order, and registration order is
 * the order a facet appears in the manifest, in a diff report and in the inspector.
 *
 * Side-effect imports on purpose: each module calls `registerFacet` as it loads, and naming them
 * here as values would fail under the import cycle a facet's server module creates. Read the
 * registered set back with `facetModules()`; nothing in the core knows them by name.
 */
import './rest.facet.ts'
import './mcp.facet.ts'
import './cli.facet.ts'
import './sdk.facet.ts'
import './web.facet.ts'
import './events.facet.ts'
