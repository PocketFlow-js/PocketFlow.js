// helper sleep function (ms)
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export type Params = Record<string, any>;
export type Action = string;

/**
 * Lifecycle hooks that can be attached to a Flow to observe execution
 * without modifying node code (logging, metrics, debugging, etc).
 */
export interface FlowHooks<S = any> {
  onFlowStart?: (shared: S) => void | Promise<void>;
  onFlowEnd?: (shared: S) => void | Promise<void>;
  onNodeStart?: (node: BaseNode<S>, shared: S) => void | Promise<void>;
  onNodeEnd?: (node: BaseNode<S>, action: Action | void, shared: S) => void | Promise<void>;
  onNodeError?: (node: BaseNode<S>, error: unknown, shared: S) => void | Promise<void>;
}

/**
 * Base building block of a workflow.
 *
 * Type parameters:
 * - `S` — shape of the shared state passed through the flow
 * - `P` — result type of `prep()`
 * - `E` — result type of `exec()`
 */
export class BaseNode<S = any, P = any, E = any> {
  params: Params = {};
  successors: Record<Action, BaseNode<S>> = {};

  setParams(params: Params): void {
    this.params = params;
  }

  addSuccessor<N extends BaseNode<S>>(node: N, action: Action = "default"): N {
    if (this.successors[action]) {
      console.warn(`overwriting successor for action '${action}'`);
    }
    this.successors[action] = node;
    return node;
  }

  connect<N extends BaseNode<S>>(node: N, action: Action = "default"): N {
    return this.addSuccessor(node, action);
  }

  transition(action: Action) {
    return { to: <N extends BaseNode<S>>(target: N): N => this.addSuccessor(target, action) };
  }

  async prep(shared: S): Promise<P | void> { /* override me */ }
  async exec(prepRes: P): Promise<E | void> { /* override me */ }
  async post(shared: S, prepRes: P, execRes: E): Promise<Action | void> { /* override me */ }

  async _exec(prepRes: P): Promise<E | void> {
    return this.exec(prepRes);
  }

  async _run(shared: S): Promise<Action | void> {
    const p = await this.prep(shared);
    const e = await this._exec(p as P);
    return this.post(shared, p as P, e as E);
  }

  async run(shared: S): Promise<Action | void> {
    if (Object.keys(this.successors).length > 0) {
      console.warn("node won't run successors. use Flow.");
    }
    return this._run(shared);
  }
}

/**
 * Node with retry support. Retries `exec()` up to `maxRetries` times,
 * waiting `wait` ms between attempts, then calls `execFallback()`.
 */
export class Node<S = any, P = any, E = any> extends BaseNode<S, P, E> {
  maxRetries: number;
  wait: number;
  constructor(maxRetries: number = 1, wait: number = 0) {
    super();
    this.maxRetries = maxRetries;
    this.wait = wait;
  }

  async execFallback(prepRes: P, exc: unknown): Promise<E | void> {
    throw exc;
  }

  async _exec(prepRes: P): Promise<E | void> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.exec(prepRes);
      } catch (e) {
        if (i === this.maxRetries - 1) {
          return await this.execFallback(prepRes, e);
        }
        if (this.wait > 0) await sleep(this.wait);
      }
    }
  }
}

/**
 * Processes an array of items sequentially, calling `exec()` per item.
 */
export class BatchNode<S = any, I = any, E = any> extends Node<S, I[], E[]> {
  async exec(item: any): Promise<any> { /* override me: receives a single item */ }

  async _exec(items: I[]): Promise<E[]> {
    const results: E[] = [];
    for (const item of items || []) {
      results.push((await Node.prototype._exec.call(this, item)) as E);
    }
    return results;
  }
}

/**
 * Processes an array of items in parallel with a concurrency limit,
 * calling `exec()` per item. Results preserve input order.
 */
export class ParallelBatchNode<S = any, I = any, E = any> extends BatchNode<S, I, E> {
  concurrency: number;

  constructor(maxRetries: number = 1, wait: number = 0, concurrency: number = 5) {
    super(maxRetries, wait);
    this.concurrency = concurrency;
  }

  async _exec(items: I[]): Promise<E[]> {
    const list = items || [];
    const results: E[] = new Array(list.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < list.length) {
        const idx = next++;
        results[idx] = (await Node.prototype._exec.call(this, list[idx])) as E;
      }
    };

    const workers = Array.from(
      { length: Math.max(1, Math.min(this.concurrency, list.length)) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }
}

/**
 * Orchestrates a graph of nodes, following the action returned by each
 * node's `post()` to pick the next successor.
 */
export class Flow<S = any> extends BaseNode<S> {
  start: BaseNode<S>;
  hooks: FlowHooks<S> = {};

  constructor(start: BaseNode<S>, hooks: FlowHooks<S> = {}) {
    super();
    this.start = start;
    this.hooks = hooks;
  }

  setHooks(hooks: FlowHooks<S>): this {
    this.hooks = hooks;
    return this;
  }

  getNextNode(curr: BaseNode<S>, action: Action | void): BaseNode<S> | undefined {
    const nxt = curr.successors[action || "default"];
    if (!nxt && Object.keys(curr.successors).length) {
      console.warn(
        `flow ends: '${action}' not found in [${Object.keys(curr.successors).join(
          ", "
        )}]`
      );
    }
    return nxt;
  }

  async _orch(shared: S, params?: Params): Promise<void> {
    let curr: BaseNode<S> | undefined = this.start;
    const p = { ...this.params, ...(params || {}) };
    while (curr) {
      curr.setParams(p);
      await this.hooks.onNodeStart?.(curr, shared);
      let act: Action | void;
      try {
        act = await curr._run(shared);
      } catch (e) {
        await this.hooks.onNodeError?.(curr, e, shared);
        throw e;
      }
      await this.hooks.onNodeEnd?.(curr, act, shared);
      curr = this.getNextNode(curr, act);
    }
  }

  async _run(shared: S): Promise<Action | void> {
    await this.hooks.onFlowStart?.(shared);
    const pr = await this.prep(shared);
    await this._orch(shared);
    const result = await this.post(shared, pr, null);
    await this.hooks.onFlowEnd?.(shared);
    return result;
  }

  async exec(prepRes: any): Promise<any> {
    throw new Error("flow can't exec.");
  }
}

/**
 * Runs the flow once per batch of params returned by `prep()`.
 */
export class BatchFlow<S = any> extends Flow<S> {
  async _run(shared: S): Promise<Action | void> {
    await this.hooks.onFlowStart?.(shared);
    const pr: Params[] = ((await this.prep(shared)) as Params[]) || [];
    for (const bp of pr) {
      await this._orch(shared, { ...this.params, ...bp });
    }
    const result = await this.post(shared, pr, null);
    await this.hooks.onFlowEnd?.(shared);
    return result;
  }
}
