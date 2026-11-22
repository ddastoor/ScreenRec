import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface Mp4ConvertResult {
  mp4Buffer: Buffer;
  byteLength: number;
}

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/**
 * Converts a recorded media buffer (WebM VP8/VP9/Opus or fragmented MP4)
 * into a standards-compliant ISO Base Media MP4 (H.264 yuv420p + AAC + faststart).
 * Handles both recordings with audio tracks and silent video-only recordings.
 */
export async function convertBufferToMp4(inputBuffer: Buffer): Promise<Mp4ConvertResult> {
  if (!inputBuffer || inputBuffer.byteLength < 32) {
    throw new Error('Recording buffer is empty or too small to convert.');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenrec-mp4-'));
  const inputPath = path.join(tmpDir, 'recording.input');
  const outputPath = path.join(tmpDir, 'recording.mp4');

  try {
    await fs.writeFile(inputPath, inputBuffer);

    const args = [
      '-y',
      '-i',
      inputPath,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    const { code, stderr } = await runFfmpeg(args);
    if (code !== 0) {
      throw new Error(`FFmpeg MP4 conversion failed (exit ${code}): ${stderr.slice(-400)}`);
    }

    const mp4Buffer = await fs.readFile(outputPath);
    if (mp4Buffer.byteLength < 32) {
      throw new Error('FFmpeg produced an empty MP4 output file.');
    }

    return {
      mp4Buffer,
      byteLength: mp4Buffer.byteLength,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
