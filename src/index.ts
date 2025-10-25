import app, { ensureDbInitialized } from './app';

const port = Number(process.env.PORT ?? 3000);

export async function startServer(): Promise<void> {
  await ensureDbInitialized();
  return new Promise((resolve) => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Share limit API listening on port ${port}`);
      resolve();
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server', err);
    process.exit(1);
  });
}

export default app;
