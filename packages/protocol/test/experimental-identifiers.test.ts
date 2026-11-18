import { expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { ClientApi } from "../src/client.js"

const methods = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const

test("routes under /api/experimental, and only those, have experimental.* identifiers", () => {
  const operations = Object.entries(OpenApi.fromApi(ClientApi).paths).flatMap(([path, item]) =>
    methods.flatMap((method) => {
      const operation = item[method]
      return operation ? [{ path, identifier: operation.operationId }] : []
    }),
  )
  const offenders = operations
    .filter(
      ({ path, identifier }) =>
        (path === "/api/experimental" || path.startsWith("/api/experimental/")) !==
        identifier.startsWith("experimental."),
    )
    .map(({ path, identifier }) => `${identifier} ${path}`)

  expect(operations.length).toBeGreaterThan(100)
  expect(offenders).toEqual([])
})

test("task queues graduate to formal routes without experimental HTTP aliases", () => {
  const paths = OpenApi.fromApi(ClientApi).paths
  expect(Object.keys(paths).filter((path) => path.startsWith("/api/experimental/task-queue"))).toEqual([])
  expect(Object.entries(paths).filter(([path]) => path.startsWith("/api/task-queue")).flatMap(([path, item]) =>
    methods.flatMap((method) => item[method] ? [[method, path, item[method].operationId]] : []),
  )).toEqual([
    ["get", "/api/task-queue", "taskQueue.list"],
    ["post", "/api/task-queue", "taskQueue.create"],
    ["get", "/api/task-queue/{queueID}", "taskQueue.get"],
    ["delete", "/api/task-queue/{queueID}", "taskQueue.delete"],
    ["post", "/api/task-queue/{queueID}/start", "taskQueue.start"],
    ["post", "/api/task-queue/{queueID}/heartbeat", "taskQueue.heartbeat"],
    ["post", "/api/task-queue/{queueID}/stop", "taskQueue.stop"],
    ["post", "/api/task-queue/{queueID}/resume", "taskQueue.resume"],
  ])
})
