# PocketFlow.js

A minimal LLM workflow framework written in TypeScript. This is a port of [PocketFlow](https://github.com/miniLLMFlow/PocketFlow) from Python to TypeScript.

## Features

- 🚀 Simple and lightweight workflow framework
- 🔌 Composable nodes and flows
- 🔄 Support for retries and fallbacks
- ⚡ Sequential and parallel batch processing
- 🪝 Lifecycle hooks for logging, metrics, and debugging
- 🎯 Type-safe with TypeScript generics

## Installation

```bash
npm install @pocketflow/core
```

## Quick Start

A workflow is built from **nodes** connected into a **flow**. Each node has three lifecycle methods:

- `prep(shared)` — read from shared state, return input for `exec`
- `exec(prepRes)` — do the work (e.g. call an LLM)
- `post(shared, prepRes, execRes)` — write results to shared state, return an **action** string that decides which node runs next

```typescript
import { Node, Flow } from "@pocketflow/core";

interface Shared {
  topic: string;
  outline?: string;
  essay?: string;
}

class WriteOutline extends Node<Shared> {
  async prep(shared: Shared) {
    return shared.topic;
  }
  async exec(topic: string) {
    return callLLM(`Write an outline about ${topic}`);
  }
  async post(shared: Shared, _prep: string, outline: string) {
    shared.outline = outline;
    return "default"; // action -> next node
  }
}

class WriteEssay extends Node<Shared> {
  async prep(shared: Shared) {
    return shared.outline;
  }
  async exec(outline: string) {
    return callLLM(`Write an essay from this outline:\n${outline}`);
  }
  async post(shared: Shared, _prep: string, essay: string) {
    shared.essay = essay;
  }
}

const outline = new WriteOutline();
const essay = new WriteEssay();
outline.connect(essay); // default transition

const shared: Shared = { topic: "TypeScript" };
await new Flow(outline).run(shared);
console.log(shared.essay);
```

## Branching

`post()` returns an action string. Use `transition(action).to(node)` to branch:

```typescript
review.transition("approved").to(publish);
review.transition("rejected").to(rewrite);
rewrite.connect(review); // loop back for another review
```

Self-loops are supported — a node can transition back to itself.

## Retries and Fallbacks

`Node` takes `maxRetries` and `wait` (ms between attempts). If all retries fail, `execFallback()` is called:

```typescript
class CallModel extends Node {
  constructor() {
    super(3, 1000); // 3 attempts, 1s between
  }
  async exec(prompt: string) {
    return callLLM(prompt);
  }
  async execFallback(prompt: string, err: unknown) {
    return "Sorry, the model is unavailable.";
  }
}
```

## Batch Processing

`BatchNode` runs `exec()` once per item, sequentially. `ParallelBatchNode` runs items concurrently with a configurable limit:

```typescript
import { ParallelBatchNode } from "@pocketflow/core";

class Summarize extends ParallelBatchNode {
  constructor() {
    super(1, 0, 5); // maxRetries, wait, concurrency
  }
  async prep(shared: any) {
    return shared.documents; // array of items
  }
  async exec(doc: string) {
    return callLLM(`Summarize: ${doc}`);
  }
  async post(shared: any, _prep: any, summaries: string[]) {
    shared.summaries = summaries; // results preserve input order
  }
}
```

`BatchFlow` runs an entire flow once per param set returned by its `prep()`.

## Lifecycle Hooks

Observe flow execution without touching node code:

```typescript
const flow = new Flow(start, {
  onFlowStart: (shared) => console.log("flow started"),
  onNodeStart: (node) => console.log(`-> ${node.constructor.name}`),
  onNodeEnd: (node, action) => console.log(`<- ${node.constructor.name} (${action})`),
  onNodeError: (node, err) => console.error(`error in ${node.constructor.name}`, err),
  onFlowEnd: (shared) => console.log("flow finished"),
});
```

## Visualization

The [`@pocketflow/viz`](./packages/viz) package renders an interactive graph of your flow:

```typescript
import { visualize } from "@pocketflow/viz";

await visualize(flow); // opens http://localhost:3000
```

## API Summary

| Class | Purpose |
|-------|---------|
| `BaseNode` | Core lifecycle (`prep`/`exec`/`post`) and successor wiring |
| `Node` | Adds retries, wait between attempts, and `execFallback` |
| `BatchNode` | Runs `exec` per item, sequentially |
| `ParallelBatchNode` | Runs `exec` per item, in parallel with a concurrency limit |
| `Flow` | Orchestrates a node graph following returned actions |
| `BatchFlow` | Runs a flow once per param set |

## Examples

See the [examples](./packages/examples) directory for complete, runnable examples.

## Development

```bash
pnpm install
pnpm build   # build all packages
pnpm test    # run tests
pnpm lint    # lint all packages
```

## License

[MIT](./LICENSE)
