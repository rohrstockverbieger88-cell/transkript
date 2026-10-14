// Extracts the audio track as 16 kHz mono PCM using ffmpeg.wasm.
// WORKERFS lets ffmpeg read the File in slices, so large videos (up to 8 GB)
// never have to be loaded into memory entirely.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
let ffmpeg = null;

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const ff = new FFmpeg();
  await ff.load({
    coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  ffmpeg = ff;
  return ff;
}

function parseTime(str) {
  const [h, m, s] = str.split(':').map(parseFloat);
  return h * 3600 + m * 60 + s;
}

export function terminateFFmpeg() {
  if (ffmpeg) { try { ffmpeg.terminate(); } catch {} ffmpeg = null; }
}

/** Reads duration (seconds) from the container header. */
export async function probeDuration(file) {
  const ff = await getFFmpeg();
  const dir = '/probe';
  let duration = null;
  const onLog = ({ message }) => {
    const m = message.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
    if (m) duration = parseTime(m[1]);
  };
  ff.on('log', onLog);
  try {
    await ff.createDir(dir).catch(() => {});
    await ff.mount('WORKERFS', { files: [file] }, dir);
    await ff.exec(['-hide_banner', '-i', `${dir}/${file.name}`]); // exits with error, that's fine
  } finally {
    ff.off('log', onLog);
    await ff.unmount(dir).catch(() => {});
  }
  return duration;
}

/** Returns Float32Array with 16 kHz mono samples. */
export async function extractAudio(file, duration, onProgress) {
  const ff = await getFFmpeg();
  const dir = '/input';
  const onLog = ({ message }) => {
    const m = message.match(/time=\s*(\d+:\d+:\d+(?:\.\d+)?)/);
    if (m && duration) onProgress(Math.min(1, parseTime(m[1]) / duration));
  };
  ff.on('log', onLog);
  try {
    await ff.createDir(dir).catch(() => {});
    await ff.mount('WORKERFS', { files: [file] }, dir);
    const code = await ff.exec([
      '-hide_banner', '-i', `${dir}/${file.name}`,
      '-vn', '-ac', '1', '-ar', '16000', '-t', '7200',
      '-f', 's16le', '-acodec', 'pcm_s16le', 'out.pcm',
    ]);
    if (code !== 0) throw new Error('Die Tonspur konnte nicht gelesen werden. Ist das Format unterstützt?');
    const data = await ff.readFile('out.pcm');
    await ff.deleteFile('out.pcm');
    const pcm = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
  } finally {
    ff.off('log', onLog);
    await ff.unmount(dir).catch(() => {});
  }
}
