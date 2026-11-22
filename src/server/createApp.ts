import express, { type Express, type Request, type Response } from 'express';
import fs from 'node:fs';
import { probeLinuxEnvironment } from './systemProbe.ts';
import { convertBufferToMp4 } from './mp4Converter.ts';
import type { DisplayEnvInput } from '../utils/displayServer.ts';
import { buildDebianPackage } from '../../scripts/build-deb.mjs';

let cachedDebBuild: {
  fileName: string;
  filePath: string;
  version: string;
  arch: string;
  sizeBytes: number;
  sha256: string;
  dpkgInfo: string;
} | null = null;

function ensureDebArtifact() {
  if (cachedDebBuild && fs.existsSync(cachedDebBuild.filePath)) {
    return cachedDebBuild;
  }
  cachedDebBuild = buildDebianPackage();
  return cachedDebBuild;
}

export function createApiApp(): Express {
  const app = express();

  // Startup probe runs immediately when server initializes
  const startupProbe = probeLinuxEnvironment();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      startupDisplayProtocol: startupProbe.displayServer.protocol,
    });
  });

  /**
   * Returns startup OS & X11/Wayland auto-detection details.
   * Supports optional ?simulate=wayland|x11 query param so users and tests
   * can verify X11 vs Wayland detection behavior interactively.
   */
  app.get('/api/system-info', (req: Request, res: Response) => {
    const simulate = typeof req.query.simulate === 'string' ? req.query.simulate.toLowerCase() : '';
    if (simulate === 'wayland') {
      const simulated: DisplayEnvInput = {
        xdgSessionType: 'wayland',
        waylandDisplay: 'wayland-0',
        display: ':0',
        xdgCurrentDesktop: 'GNOME',
      };
      res.json(probeLinuxEnvironment(simulated));
      return;
    }
    if (simulate === 'x11') {
      const simulated: DisplayEnvInput = {
        xdgSessionType: 'x11',
        display: ':0.0',
        xdgCurrentDesktop: 'XFCE',
      };
      res.json(probeLinuxEnvironment(simulated));
      return;
    }

    res.json(probeLinuxEnvironment());
  });

  /**
   * Converts uploaded screen recording media stream into a genuine H.264/AAC MP4 file.
   */
  app.post(
    '/api/convert-mp4',
    express.raw({ type: '*/*', limit: '250mb' }),
    async (req: Request, res: Response) => {
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength < 32) {
          res.status(400).json({
            error: 'Invalid or empty media payload provided for MP4 conversion.',
          });
          return;
        }

        const { mp4Buffer, byteLength } = await convertBufferToMp4(body);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(byteLength));
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(mp4Buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'MP4 conversion failed.';
        res.status(500).json({ error: message });
      }
    }
  );

  /**
   * Returns metadata & dpkg-deb inspection details for the built .deb installer.
   */
  app.get('/api/package/deb-info', (_req: Request, res: Response) => {
    try {
      const info = ensureDebArtifact();
      res.json({
        fileName: info.fileName,
        version: info.version,
        arch: info.arch,
        sizeBytes: info.sizeBytes,
        sha256: info.sha256,
        dpkgInfo: info.dpkgInfo,
        installCommand: `sudo apt install ./${info.fileName}`,
        dpkgCommand: `sudo dpkg -i ${info.fileName} && sudo apt-get install -f`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to inspect .deb package.';
      res.status(500).json({ error: message });
    }
  });

  /**
   * Builds (if needed) and downloads the Debian .deb installation package.
   */
  app.get('/api/package/deb', (_req: Request, res: Response) => {
    try {
      const info = ensureDebArtifact();
      res.setHeader('Content-Type', 'application/vnd.debian.binary-package');
      res.setHeader('Content-Disposition', `attachment; filename="${info.fileName}"`);
      res.setHeader('Content-Length', String(info.sizeBytes));
      fs.createReadStream(info.filePath).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build .deb package.';
      res.status(500).json({ error: message });
    }
  });

  return app;
}
