import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const V2Command = effectCmd({
  command: "v2",
  describe: "debug v2 catalog and built-in plugins",
  instance: false,
  handler: () =>
    Effect.flatMap(
      Effect.all({
        catalog: Effect.promise(() => import("@opencode-ai/core/catalog")),
        locationServices: Effect.promise(() => import("@opencode-ai/core/location-services")),
        location: Effect.promise(() => import("@opencode-ai/core/location")),
        schema: Effect.promise(() => import("@opencode-ai/core/schema")),
      }),
      ({ catalog, locationServices, location, schema }) =>
        Effect.gen(function* () {
          const svc = yield* catalog.Catalog.Service
          const providers = (yield* svc.provider.available()).sort((a, b) => a.id.localeCompare(b.id))
          const all = (yield* svc.provider.all()).sort((a, b) => a.id.localeCompare(b.id))
          const result = {
            providers,
            default: svc.model.default().pipe(Effect.map((item) => item?.id)),
            small: Object.fromEntries(
              yield* Effect.all(
                all.map((provider) =>
                  Effect.map(svc.model.small(provider.id), (model) => [provider.id, model?.id] as const),
                ),
                { concurrency: "unbounded" },
              ),
            ),
          }
          process.stdout.write(JSON.stringify(result, null, 2) + EOL)
        }).pipe(
          Effect.withSpan("Cli.debug.v2"),
          Effect.provide(
            locationServices.LocationServiceMap.Service.get(
              location.Location.Ref.make({
                directory: schema.AbsolutePath.make(process.cwd()),
              }),
            ),
          ),
          Effect.provide(locationServices.locationServiceMapLayer),
        ),
    ),
})
