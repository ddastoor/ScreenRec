import type { CaptureSourceType } from './recorderConfig';

export interface DemoStreamHandle {
  stream: MediaStream;
  setCursorVisible: (visible: boolean) => void;
  stop: () => void;
}

/**
 * Creates a live 1280x720 30fps synthetic desktop/window/tab capture stream
 * with optional synthesized system audio and live mouse cursor visibility toggle.
 * Used when testing in browser environments without OS screen-share permission prompts.
 */
export function createDemoCaptureStream(opts: {
  sourceType: CaptureSourceType;
  systemAudio: boolean;
  includeCursor: boolean;
  displayLabel: string;
}): DemoStreamHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  let showCursor = opts.includeCursor;
  let frame = 0;
  let stopped = false;

  const drawFrame = () => {
    if (!ctx || stopped) return;
    frame += 1;
    const t = frame / 30;

    // Clean Debian desktop neutral background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle top desktop panel for Entire Screen mode
    if (opts.sourceType === 'monitor') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvas.width, 36);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 14px sans-serif';
      ctx.fillText(`Debian Desktop  ·  ${opts.displayLabel}`, 20, 23);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(new Date().toLocaleTimeString(), canvas.width - 130, 23);
    }

    // Simulated application window or browser tab frame
    const winX = opts.sourceType === 'monitor' ? 110 : 40;
    const winY = opts.sourceType === 'monitor' ? 76 : 36;
    const winW = canvas.width - winX * 2;
    const winH = canvas.height - winY - 48;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(winX, winY, winW, winH);

    // Window / Tab header bar
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(winX, winY, winW, 44);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 16px sans-serif';
    const titleText =
      opts.sourceType === 'monitor'
        ? 'Entire Screen Capture — Workspace 1'
        : opts.sourceType === 'window'
          ? 'Application Window — Terminal / Editor'
          : 'Browser Tab — Documentation Preview';
    ctx.fillText(titleText, winX + 20, winY + 28);

    // Animated content bars inside window so video frames have smooth real motion
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(winX + 32, winY + 76, 320, 22);
    ctx.fillStyle = '#64748b';
    ctx.font = '500 15px monospace';
    ctx.fillText(
      `Frame #${String(frame).padStart(4, '0')}  |  Elapsed ${t.toFixed(1)}s  |  Cursor: ${
        showCursor ? 'INCLUDED' : 'HIDDEN'
      }`,
      winX + 32,
      winY + 132
    );

    // Moving progress wave
    const barMaxW = winW - 64;
    const progress = ((Math.sin(t * 1.6) + 1) / 2) * barMaxW;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(winX + 32, winY + 164, barMaxW, 18);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(winX + 32, winY + 164, Math.max(24, progress), 18);

    // Simulated terminal log lines
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(winX + 32, winY + 212, barMaxW, winH - 248);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px monospace';
    ctx.fillText(`$ screenrec --protocol="${opts.displayLabel}" --format=mp4`, winX + 52, winY + 248);
    ctx.fillText(
      `[audio] system_audio=${opts.systemAudio ? 'enabled' : 'muted'} | container=isom (H.264 + AAC)`,
      winX + 52,
      winY + 276
    );
    ctx.fillText(
      `[video] 1280x720 @ 30fps | mouse_cursor=${showCursor ? 'visible' : 'excluded'}`,
      winX + 52,
      winY + 304
    );

    // Draw simulated mouse cursor ONLY when includeCursor is enabled
    if (showCursor) {
      const cx = canvas.width * 0.5 + Math.cos(t * 2.1) * 220;
      const cy = canvas.height * 0.54 + Math.sin(t * 1.5) * 120;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 26);
      ctx.lineTo(7, 20);
      ctx.lineTo(13, 31);
      ctx.lineTo(17, 29);
      ctx.lineTo(11, 18);
      ctx.lineTo(19, 18);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
      ctx.restore();
    }
  };

  drawFrame();
  const intervalId = window.setInterval(drawFrame, 1000 / 30);
  const canvasStream = canvas.captureStream(30);

  let audioCtx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let pulseTimer: number | null = null;

  if (opts.systemAudio) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 330;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    let toggle = false;
    pulseTimer = window.setInterval(() => {
      if (!osc || !audioCtx) return;
      toggle = !toggle;
      osc.frequency.setValueAtTime(toggle ? 440 : 330, audioCtx.currentTime);
    }, 600);

    dest.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  }

  return {
    stream: canvasStream,
    setCursorVisible: (visible: boolean) => {
      showCursor = visible;
    },
    stop: () => {
      stopped = true;
      window.clearInterval(intervalId);
      if (pulseTimer !== null) window.clearInterval(pulseTimer);
      try {
        osc?.stop();
      } catch {
        // ignore already stopped oscillator
      }
      audioCtx?.close().catch(() => undefined);
      canvasStream.getTracks().forEach((t) => t.stop());
    },
  };
}
