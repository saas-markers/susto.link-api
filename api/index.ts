import type { IncomingMessage, ServerResponse } from 'http';
import app, { ensureDbInitialized } from '../src/app';

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ensureDbInitialized();

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('finish', onFinish);
      res.off('close', onFinish);
      res.off('error', onError);
    };

    const onFinish = () => {
      cleanup();
      resolve();
    };

    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };

    res.on('finish', onFinish);
    res.on('close', onFinish);
    res.on('error', onError);

    // ✅ converter req/res para any (Express compatível)
    app(req as any, res as any, (err?: unknown) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}
