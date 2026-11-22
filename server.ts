import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiApp } from './src/server/createApp.ts';
import { probeLinuxEnvironment } from './src/server/systemProbe.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApiApp();
  const port = Number(process.env.PORT || 3000);

  const startupInfo = probeLinuxEnvironment();
  console.log(
    `[ScreenRec] Startup OS: ${startupInfo.os.prettyName} (${startupInfo.os.arch}) | Display: ${startupInfo.displayServer.label}`
  );

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[ScreenRec] Server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('[ScreenRec] Failed to start server:', err);
  process.exit(1);
});
