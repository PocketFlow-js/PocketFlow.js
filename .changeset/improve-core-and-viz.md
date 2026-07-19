---
"@pocketflow/core": minor
"@pocketflow/viz": patch
---

Add TypeScript generics to all core classes, `ParallelBatchNode` with configurable concurrency, and `FlowHooks` lifecycle events (`onFlowStart/End`, `onNodeStart/End/Error`). Fix script-injection (XSS) in the viz HTML output and update all dependencies to latest.
