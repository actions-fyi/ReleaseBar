// Runs tasks one at a time, in the order they were added: the next starts when the one before has
// settled, whether it succeeded or failed.
//
// A Durable Object method that awaits nothing needs no queue: nothing else runs until it returns.
// One that waits on KV or a queue between reading and writing its own state does, because other
// calls are let in while it waits. `blockConcurrencyWhile` would keep them out too, but it is
// meant for initialisation: a task that fails or takes too long inside it resets the object.
export class SerialQueue {
  #last: Promise<unknown> = Promise.resolve();

  run<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = this.#last.then(task, task);
    this.#last = result.catch(() => undefined);
    return result;
  }
}
