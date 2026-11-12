// Using the library inside your own agent loop (any LLM SDK).
import { captureMedia, InspectionQueue, LocalMediaStore, S3PublicStore } from '@zhin.js/agent-media';

const privateStore = new LocalMediaStore({ dir: './.media' });
const publicStore = process.env.S3_BUCKET ? new S3PublicStore({
  endpoint: process.env.S3_ENDPOINT!, bucket: process.env.S3_BUCKET, region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  publicBaseUrl: process.env.S3_PUBLIC_BASE_URL, prefix: 'agent/',
}) : undefined;

export async function runTool(tool: { name: string; publishable?: boolean; execute(args: unknown): Promise<unknown> }, args: unknown, sessionId: string) {
  const raw = await tool.execute(args);
  // 1. One place, every tool, before the result reaches history.
  const { value } = await captureMedia(raw, {
    policy: tool.publishable && publicStore ? 'public' : 'private',
    privateStore, publicStore, scope: sessionId, source: tool.name,
  });
  return value; // write THIS to history
}

// 2. The inspect tool only queues; the loop attaches images to the next request and never stores them.
export function makeInspect(sessionId: string) {
  const queue = new InspectionQueue(privateStore, sessionId, { perTurn: 4 });
  return {
    tool: { name: 'inspect_media', execute: async ({ asset_id }: { asset_id: string }) => queue.request(asset_id) },
    async beforeModelCall<M>(messages: M[], toImageMessage: (images: Awaited<ReturnType<typeof queue.drain>>) => M): Promise<M[]> {
      const images = await queue.drain();
      return images.length ? [...messages, toImageMessage(images)] : messages;
    },
    newTurn: () => queue.resetBudget(),
  };
}
