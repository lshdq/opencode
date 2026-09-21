import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

const filesystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(
    Effect.all({
      locationServices: Effect.promise(() => import("@opencode-ai/core/location-services")),
      location: Effect.promise(() => import("@opencode-ai/core/location")),
      schema: Effect.promise(() => import("@opencode-ai/core/schema")),
    }),
    ({ locationServices, location, schema }) =>
      effect.pipe(
        Effect.provide(
          locationServices.LocationServiceMap.Service.get(
            location.Location.Ref.make({ directory: schema.AbsolutePath.make(process.cwd()) }),
          ),
        ),
        Effect.provide(locationServices.locationServiceMapLayer),
      ),
  )

const FileSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search files by query",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: "Search query",
    }),
  handler: Effect.fn("Cli.debug.file.search")(function* (args) {
    const { FileSystem } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem"))
    const results = yield* Effect.orDie(filesystem(FileSystem.Service.use((svc) => svc.find({ query: args.query }))))
    process.stdout.write(results.map((item) => item.path).join(EOL) + EOL)
  }),
})

const FileReadCommand = effectCmd({
  command: "read <path>",
  describe: "read file contents as JSON",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to read",
    }),
  handler: Effect.fn("Cli.debug.file.read")(function* (args) {
    const { FileSystem } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem"))
    const { RelativePath } = yield* Effect.promise(() => import("@opencode-ai/core/schema"))
    const file = yield* filesystem(FileSystem.Service.use((svc) => svc.read({ path: RelativePath.make(args.path) })))
    process.stdout.write(
      JSON.stringify(
        { content: Buffer.from(file.content).toString("base64"), encoding: "base64", mime: file.mime },
        null,
        2,
      ) + EOL,
    )
  }),
})

const FileListCommand = effectCmd({
  command: "list <path>",
  describe: "list files in a directory",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to list",
    }),
  handler: Effect.fn("Cli.debug.file.list")(function* (args) {
    const { FileSystem } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem"))
    const { RelativePath } = yield* Effect.promise(() => import("@opencode-ai/core/schema"))
    const files = yield* filesystem(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(args.path) })))
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  }),
})

export const FileCommand = cmd({
  command: "file",
  describe: "file system debugging utilities",
  builder: (yargs) =>
    yargs.command(FileReadCommand).command(FileListCommand).command(FileSearchCommand).demandCommand(),
  async handler() {},
})
