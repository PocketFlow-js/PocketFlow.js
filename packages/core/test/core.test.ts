import {
  BaseNode,
  Node,
  BatchNode,
  ParallelBatchNode,
  Flow,
  BatchFlow,
  FlowHooks,
} from '../src/core';

describe('BaseNode', () => {
  it('runs prep -> exec -> post in order', async () => {
    const calls: string[] = [];
    class TestNode extends BaseNode {
      async prep() {
        calls.push('prep');
        return 'prepRes';
      }
      async exec(prepRes: string) {
        calls.push('exec');
        expect(prepRes).toBe('prepRes');
        return 'execRes';
      }
      async post(_shared: any, prepRes: string, execRes: string) {
        calls.push('post');
        expect(prepRes).toBe('prepRes');
        expect(execRes).toBe('execRes');
        return 'action';
      }
    }
    const result = await new TestNode().run({});
    expect(calls).toEqual(['prep', 'exec', 'post']);
    expect(result).toBe('action');
  });

  it('warns when running a node with successors directly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const a = new BaseNode();
    a.connect(new BaseNode());
    await a.run({});
    expect(warn).toHaveBeenCalledWith("node won't run successors. use Flow.");
    warn.mockRestore();
  });

  it('warns when overwriting a successor', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const a = new BaseNode();
    a.connect(new BaseNode());
    a.connect(new BaseNode());
    expect(warn).toHaveBeenCalledWith("overwriting successor for action 'default'");
    warn.mockRestore();
  });

  it('connect and transition().to() register successors and return the target', () => {
    const a = new BaseNode();
    const b = new BaseNode();
    const c = new BaseNode();
    expect(a.connect(b)).toBe(b);
    expect(a.transition('alt').to(c)).toBe(c);
    expect(a.successors['default']).toBe(b);
    expect(a.successors['alt']).toBe(c);
  });
});

describe('Node retries', () => {
  it('retries exec up to maxRetries and succeeds', async () => {
    let attempts = 0;
    class Flaky extends Node {
      async exec() {
        attempts++;
        if (attempts < 3) throw new Error('boom');
        return 'ok';
      }
      async post(_s: any, _p: any, execRes: string) {
        return execRes;
      }
    }
    const result = await new Flaky(3).run({});
    expect(attempts).toBe(3);
    expect(result).toBe('ok');
  });

  it('calls execFallback after exhausting retries', async () => {
    class AlwaysFails extends Node {
      async exec(): Promise<string> {
        throw new Error('boom');
      }
      async execFallback(_p: any, exc: unknown) {
        return `fallback: ${(exc as Error).message}`;
      }
      async post(_s: any, _p: any, execRes: string) {
        return execRes;
      }
    }
    const result = await new AlwaysFails(2).run({});
    expect(result).toBe('fallback: boom');
  });

  it('default execFallback rethrows the error', async () => {
    class AlwaysFails extends Node {
      async exec(): Promise<void> {
        throw new Error('boom');
      }
    }
    await expect(new AlwaysFails(2).run({})).rejects.toThrow('boom');
  });

  it('waits between retries', async () => {
    let attempts = 0;
    class Flaky extends Node {
      async exec() {
        attempts++;
        if (attempts < 2) throw new Error('boom');
        return 'ok';
      }
    }
    const start = Date.now();
    await new Flaky(2, 50).run({});
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

describe('BatchNode', () => {
  it('processes items sequentially and returns results in order', async () => {
    const order: number[] = [];
    class Doubler extends BatchNode {
      async prep() {
        return [1, 2, 3];
      }
      async exec(item: number) {
        order.push(item);
        return item * 2;
      }
      async post(shared: any, _p: any, execRes: number[]) {
        shared.results = execRes;
      }
    }
    const shared: any = {};
    await new Doubler().run(shared);
    expect(order).toEqual([1, 2, 3]);
    expect(shared.results).toEqual([2, 4, 6]);
  });

  it('retries per item', async () => {
    const attempts: Record<number, number> = {};
    class FlakyBatch extends BatchNode {
      async prep() {
        return [1, 2];
      }
      async exec(item: number) {
        attempts[item] = (attempts[item] || 0) + 1;
        if (attempts[item] < 2) throw new Error('boom');
        return item;
      }
      async post(shared: any, _p: any, execRes: number[]) {
        shared.results = execRes;
      }
    }
    const shared: any = {};
    await new FlakyBatch(2).run(shared);
    expect(shared.results).toEqual([1, 2]);
    expect(attempts).toEqual({ 1: 2, 2: 2 });
  });
});

describe('ParallelBatchNode', () => {
  it('processes items in parallel and preserves input order', async () => {
    class Delayed extends ParallelBatchNode {
      async prep() {
        return [30, 10, 20];
      }
      async exec(ms: number) {
        await new Promise(res => setTimeout(res, ms));
        return ms;
      }
      async post(shared: any, _p: any, execRes: number[]) {
        shared.results = execRes;
      }
    }
    const shared: any = {};
    const start = Date.now();
    await new Delayed().run(shared);
    // Parallel: total should be ~30ms, not 60ms.
    expect(Date.now() - start).toBeLessThan(55);
    expect(shared.results).toEqual([30, 10, 20]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    class Tracked extends ParallelBatchNode {
      async prep() {
        return [1, 2, 3, 4, 5, 6];
      }
      async exec(item: number) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(res => setTimeout(res, 10));
        active--;
        return item;
      }
    }
    await new Tracked(1, 0, 2).run({});
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('Flow', () => {
  class ActionNode extends Node {
    constructor(private name: string, private action?: string) {
      super();
    }
    async post(shared: any) {
      (shared.visited ||= []).push(this.name);
      return this.action;
    }
  }

  it('orchestrates nodes following returned actions', async () => {
    const a = new ActionNode('a', 'next');
    const b = new ActionNode('b', 'default');
    const c = new ActionNode('c');
    a.transition('next').to(b);
    b.connect(c);

    const shared: any = {};
    await new Flow(a).run(shared);
    expect(shared.visited).toEqual(['a', 'b', 'c']);
  });

  it('warns and ends when an action has no successor', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const a = new ActionNode('a', 'missing');
    a.transition('known').to(new ActionNode('b'));

    const shared: any = {};
    await new Flow(a).run(shared);
    expect(shared.visited).toEqual(['a']);
    expect(warn).toHaveBeenCalledWith(
      "flow ends: 'missing' not found in [known]"
    );
    warn.mockRestore();
  });

  it('passes merged params to nodes', async () => {
    let seen: any;
    class ParamNode extends Node {
      async prep() {
        seen = this.params;
      }
    }
    const flow = new Flow(new ParamNode());
    flow.setParams({ foo: 1 });
    await flow.run({});
    expect(seen).toEqual({ foo: 1 });
  });

  it('throws when exec is called on a Flow', async () => {
    await expect(new Flow(new BaseNode()).exec(null)).rejects.toThrow(
      "flow can't exec."
    );
  });

  it('supports self-loops', async () => {
    class Counter extends Node {
      async post(shared: any) {
        shared.count = (shared.count || 0) + 1;
        return shared.count < 3 ? 'again' : 'done';
      }
    }
    const counter = new Counter();
    counter.transition('again').to(counter);
    const shared: any = {};
    await new Flow(counter).run(shared);
    expect(shared.count).toBe(3);
  });
});

describe('Flow hooks', () => {
  it('fires lifecycle hooks in order', async () => {
    const events: string[] = [];
    class Named extends Node {
      constructor(public name: string, private action?: string) {
        super();
      }
      async post() {
        return this.action;
      }
    }
    const a = new Named('a', 'next');
    const b = new Named('b');
    a.transition('next').to(b);

    const hooks: FlowHooks = {
      onFlowStart: () => void events.push('flowStart'),
      onFlowEnd: () => void events.push('flowEnd'),
      onNodeStart: node => void events.push(`start:${(node as Named).name}`),
      onNodeEnd: (node, action) =>
        void events.push(`end:${(node as Named).name}:${action}`),
    };
    await new Flow(a, hooks).run({});
    expect(events).toEqual([
      'flowStart',
      'start:a',
      'end:a:next',
      'start:b',
      'end:b:undefined',
      'flowEnd',
    ]);
  });

  it('fires onNodeError and rethrows', async () => {
    class Boom extends Node {
      async exec(): Promise<void> {
        throw new Error('boom');
      }
    }
    const errors: unknown[] = [];
    const flow = new Flow(new Boom()).setHooks({
      onNodeError: (_node, error) => void errors.push(error),
    });
    await expect(flow.run({})).rejects.toThrow('boom');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });
});

describe('BatchFlow', () => {
  it('runs the flow once per param batch', async () => {
    class Collect extends Node {
      async post(shared: any) {
        (shared.seen ||= []).push(this.params.id);
      }
    }
    class TestBatchFlow extends BatchFlow {
      async prep() {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      }
    }
    const shared: any = {};
    await new TestBatchFlow(new Collect()).run(shared);
    expect(shared.seen).toEqual([1, 2, 3]);
  });
});
