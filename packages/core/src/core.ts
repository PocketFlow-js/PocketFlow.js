// helper sleep function (ms)
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export class BaseNode {
  params: any = {};
  successors: { [key: string]: BaseNode } = {};

  setParams(params: any): void {
    this.params = params;
  }

  addSuccessor(node: BaseNode, action: string = "default"): BaseNode {
    if (this.successors[action]) {
      console.warn(`overwriting successor for action '${action}'`);
    }
    this.successors[action] = node;
    return node;
  }

  connect(node: BaseNode, action: string = "default"): BaseNode {
    return this.addSuccessor(node, action);
  }

  transition(action: string) {
    return { to: (target: BaseNode) => this.addSuccessor(target, action) };
  }

  async prep(shared: any): Promise<any> { /* override me */ }
  async exec(prepRes: any): Promise<any> { /* override me */ }
  async post(shared: any, prepRes: any, execRes: any): Promise<any> { /* override me */ }

  async _exec(prepRes: any): Promise<any> {
    return this.exec(prepRes);
  }

  async _run(shared: any): Promise<any> {
    const p = await this.prep(shared);
    const e = await this._exec(p);
    return this.post(shared, p, e);
  }

  async run(shared: any): Promise<any> {
    if (Object.keys(this.successors).length > 0) {
      console.warn("node won't run successors. use Flow.");
    }
    return this._run(shared);
  }
}

export class Node extends BaseNode {
  maxRetries: number;
  wait: number;
  constructor(maxRetries: number = 1, wait: number = 0) {
    super();
    this.maxRetries = maxRetries;
    this.wait = wait;
  }

  async execFallback(prepRes: any, exc: any): Promise<any> {
    throw exc;
  }

  async _exec(prepRes: any): Promise<any> {
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

export class BatchNode extends Node {
  async _exec(items: any[]): Promise<any[]> {
    const results: any[] = [];
    for (const item of items) {
      results.push(await super._exec(item));
    }
    return results;
  }
}

export class Flow extends BaseNode {
  start: BaseNode;
  constructor(start: BaseNode) {
    super();
    this.start = start;
  }

  getNextNode(curr: BaseNode, action: any): BaseNode | undefined {
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

  async _orch(shared: any, params?: any): Promise<void> {
    let curr: BaseNode | undefined = this.start;
    const p = { ...this.params, ...(params || {}) };
    while (curr) {
      curr.setParams(p);
      const act = await curr._run(shared);
      curr = this.getNextNode(curr, act);
    }
  }

  async _run(shared: any): Promise<any> {
    const pr = await this.prep(shared);
    await this._orch(shared);
    return this.post(shared, pr, null);
  }

  async exec(prepRes: any): Promise<any> {
    throw new Error("flow can't exec.");
  }
}

export class BatchFlow extends Flow {
  async _run(shared: any): Promise<any> {
    const pr: any[] = (await this.prep(shared)) || [];
    for (const bp of pr) {
      await this._orch(shared, { ...this.params, ...bp });
    }
    return this.post(shared, pr, null);
  }
}