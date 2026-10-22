import { expect } from "bun:test"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { createNodeRoutes, createRoutes } from "../src/routes"

it.live("createRoutes does not enable auto-login from ServerOptions", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        autoLogin: true,
        app: { version: "test-version" },
        database: { path: ":memory:" },
        config: { project: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))

    const response = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/info")))
    expect(response.status).toBe(401)
  }),
)

it.effect("createNodeRoutes rejects unsafe auto-login options", () =>
  Effect.forEach(
    [
      { hostname: "0.0.0.0", message: "exactly 127.0.0.1" },
      { hostname: undefined, message: "exactly 127.0.0.1" },
      { hostname: "127.0.0.1", remote: true, message: "remote access" },
    ],
    (input) =>
      Effect.gen(function* () {
        const result = yield* Layer.build(
          createNodeRoutes({
            password: "secret",
            autoLogin: true,
            hostname: input.hostname,
            remote: input.remote,
          }).pipe(Layer.provide(HttpServer.layerServices)),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ message: expect.stringContaining(input.message) })
      }),
  ),
)
