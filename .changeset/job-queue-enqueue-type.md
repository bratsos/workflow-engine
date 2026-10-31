---
"@bratsos/workflow-engine": patch
---

`createPrismaJobQueue` now returns `PrismaJobQueue`, so `enqueue` type-checks. It always existed at runtime, but the factory's `JobQueue` return type hid it. A value used as a `JobQueue` keeps working, and the `JobQueue` port itself is unchanged.

One thing can stop compiling: a variable, class field or test double whose type is inferred from `createPrismaJobQueue` and that later holds another `JobQueue` now fails with TS2740, because the inferred type is `PrismaJobQueue` (`let queue = createPrismaJobQueue(prisma); queue = myQueue;`, a class field `queue = createPrismaJobQueue(prisma)` that is later assigned a `JobQueue`, or `const make: typeof createPrismaJobQueue = () => myQueue`). Annotate it as `JobQueue`. A union such as `useMine ? createPrismaJobQueue(prisma) : myQueue` compiles unchanged.
