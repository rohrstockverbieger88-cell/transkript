import { pipeline, Tensor, env } from '@huggingface/transformers';

let asr = null;
let loadedKey = '';

async function load(model, device, baseURI) {
  const isLocal = model === 'whisper-base';
  if (isLocal) {
    const base = baseURI || self.location.origin;
    env.remoteHost = new URL('models/', base).href;
    env.remotePathTemplate = '{model}/';
  } else {
    env.remoteHost = 'https://huggingface.co/';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
  }

  // For whisper-base (q8 int8), wasm is instant, ultra-stable, and doesn't freeze on GPU shader compile
  const targetDevice = isLocal ? 'wasm' : device;
  const key = model + targetDevice;
  if (asr && loadedKey === key) return;

  const dtype = isLocal
    ? 'q8'
    : (targetDevice === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8');

  self.postMessage({ type: 'status', message: '🧠 KI-Modell wird geladen …' });

  asr = await pipeline('automatic-speech-recognition', model, {
    device: targetDevice,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress') {
        self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
      } else if (p.status === 'done' || p.status === 'ready') {
        self.postMessage({ type: 'status', message: '🧠 KI-Modell wird im Speicher initialisiert …' });
      }
    },
  });
  loadedKey = key;
  self.postMessage({ type: 'status', message: '✅ KI-Modell bereit!' });
}

// Whisper language ID: one decoder step after <|startoftranscript|>,
// then pick the most likely language token.
let lastLang = null;
async function detectLanguage(audio) {
  try {
    const { model, processor } = asr;
    const langToId = model.generation_config?.lang_to_id;
    if (!langToId) return lastLang;
    // use up to 30 s from the middle of the segment (avoids silent intros)
    const n = 30 * 16000;
    const start = Math.max(0, Math.floor((audio.length - n) / 2));
    const clip = audio.subarray(start, start + n);
    // skip near-silent clips
    let e = 0; for (let i = 0; i < clip.length; i += 16) e += clip[i] * clip[i];
    if (e / (clip.length / 16) < 1e-5) return lastLang;
    const { input_features } = await processor(clip);
    const sot = model.generation_config.decoder_start_token_id;
    const decoder_input_ids = new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]);
    const { logits } = await model({ input_features, decoder_input_ids });
    const row = logits.data.slice(-logits.dims.at(-1));
    let best = null, bestScore = -Infinity;
    for (const [tok, id] of Object.entries(langToId)) {
      if (row[id] > bestScore) { bestScore = row[id]; best = tok; }
    }
    if (best) lastLang = best.replace(/[<|>]/g, '');
    return lastLang;
  } catch (err) {
    console.warn('Language detection error (fallback):', err);
    return lastLang;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      lastLang = null;
      await load(data.model, data.device, data.baseURI);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'segment') {
      const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };
      if (data.language) {
        opts.language = data.language;
      } else {
        const detected = await detectLanguage(data.audio);
        if (detected) opts.language = detected;
      }
      if (opts.language) self.postMessage({ type: 'language', language: opts.language });
      const out = await asr(data.audio, opts);
      const chunks = (out.chunks || [{ text: out.text, timestamp: [0, data.audio.length / 16000] }])
        .map((c) => ({
          text: (c.text || '').trim(),
          start: data.offset + (c.timestamp?.[0] ?? 0),
          end: data.offset + (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0),
        }))
        .filter((c) => c.text);
      console.log(`[worker] Segment ${data.id} produced ${chunks.length} chunks`, chunks);
      self.postMessage({ type: 'segment', id: data.id, chunks });
    }
  } catch (e) {
    console.error('[worker] Error:', e);
    self.postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
