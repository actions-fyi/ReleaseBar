// The refresh queue: refresh jobs and GitHub webhook jobs, consumed by the Worker's queue handler.

import type { WorkerQueueMessage } from "../runtime.ts";

// Puts a message on the queue. Resolves once the queue has it.
export async function sendQueueMessage(
  env: Env,
  message: WorkerQueueMessage,
  options?: { delaySeconds?: number },
): Promise<void> {
  if (options) {
    await env.REFRESH_QUEUE.send(message, options);
  } else {
    await env.REFRESH_QUEUE.send(message);
  }
}
