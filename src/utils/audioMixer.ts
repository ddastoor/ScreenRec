export interface AudioMixerHandle {
  combinedStream: MediaStream;
  getAudioLevel: () => number;
  cleanup: () => void;
}

/**
 * Combines a screen/window/tab video+system-audio MediaStream with an optional
 * user microphone MediaStream into a single synchronized MediaStream for recording.
 */
export function createRecordingStreamMixer(
  displayStream: MediaStream,
  micStream: MediaStream | null,
  enableSystemAudio: boolean
): AudioMixerHandle {
  const videoTracks = displayStream.getVideoTracks();
  const systemAudioTracks = enableSystemAudio ? displayStream.getAudioTracks() : [];
  const micAudioTracks = micStream ? micStream.getAudioTracks() : [];

  const hasAnyAudio = systemAudioTracks.length > 0 || micAudioTracks.length > 0;
  if (!hasAnyAudio) {
    const videoOnlyStream = new MediaStream([...videoTracks]);
    return {
      combinedStream: videoOnlyStream,
      getAudioLevel: () => 0,
      cleanup: () => {
        displayStream.getTracks().forEach((t) => t.stop());
        micStream?.getTracks().forEach((t) => t.stop());
      },
    };
  }

  const audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  if (systemAudioTracks.length > 0) {
    const sysOnly = new MediaStream(systemAudioTracks);
    const sysSource = audioCtx.createMediaStreamSource(sysOnly);
    const sysGain = audioCtx.createGain();
    sysGain.gain.value = 1.0;
    sysSource.connect(sysGain);
    sysGain.connect(destination);
    sysGain.connect(analyser);
  }

  if (micAudioTracks.length > 0) {
    const micOnly = new MediaStream(micAudioTracks);
    const micSource = audioCtx.createMediaStreamSource(micOnly);
    const micGain = audioCtx.createGain();
    micGain.gain.value = 1.0;
    micSource.connect(micGain);
    micGain.connect(destination);
    micGain.connect(analyser);
  }

  const combinedStream = new MediaStream([
    ...videoTracks,
    ...destination.stream.getAudioTracks(),
  ]);

  return {
    combinedStream,
    getAudioLevel: () => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      return Math.min(100, Math.round(rms * 280));
    },
    cleanup: () => {
      displayStream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      audioCtx.close().catch(() => undefined);
    },
  };
}
