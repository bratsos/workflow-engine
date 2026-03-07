# @bratsos/workflow-engine-host-serverless

## 0.2.6

### Patch Changes

- b83ecb1: Republish host packages with resolved workspace dependencies and repository.url for provenance

## 0.2.5

### Patch Changes

- f456a5f: Fix release script to use pnpm -r publish so workspace:\* dependencies are resolved to actual versions at publish time

## 0.2.4

### Patch Changes

- Updated dependencies [3b07f56]
  - @bratsos/workflow-engine@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [579106e]
  - @bratsos/workflow-engine@0.3.0

## 0.2.2

### Patch Changes

- d824b47: Fix publishing for host packages to npm registry

## 0.2.1

### Patch Changes

- Updated dependencies [71b84a9]
  - @bratsos/workflow-engine@0.2.1

## 0.2.0

### Minor Changes

- e3b8cb4: Command kernel API migration: pure command dispatcher with typed handlers, transactional outbox, idempotency, optimistic concurrency, DLQ support, and host packages for Node.js and serverless environments.

### Patch Changes

- Updated dependencies [e3b8cb4]
  - @bratsos/workflow-engine@0.2.0
