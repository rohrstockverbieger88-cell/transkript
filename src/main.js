import { probeDuration, extractAudio, terminateFFmpeg } from './audio.js';
import { toText, saveTxt, saveDocx, fmtTime } from './export.js';

const MAX_BYTES = 8 * 1024 ** 3;
const MAX_SECONDS = 2 * 3600;
const SEGMENT_SEC = 120; // audio sent to the worker in 2-minute pieces
const SR = 16000;

const $ = (id) => document.getElementById(id);
const el = {
  drop: $('dropzone'), input: $('file-input'), info: $('file-info'), name: $('file-name'), meta: $('file-meta'),
  remove: $('file-remove'), model: $('model-select'), lang: $('lang-select'), device: $('device-info'),
  start: $('start-btn'), error: $('error'), upload: $('upload-card'), progress: $('progress-card'),
  stage: $('stage'), percent: $('percent'), fill: $('bar-fill'), eta: $('eta'), cancel: $('cancel-btn'),
  result: $('result-card'), output: $('output'), ts: $('ts-toggle'),
  copy: $('copy-btn'), txt: $('txt-btn'), docx: $('docx-btn'), toast: $('toast'),
};

let file = null;
let duration = null;
let chunks = [];
let worker = null;
let cancelled = false;
let edited = false;

const hasGPU = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
el.device.textContent = hasGPU
  ? '⚡ WebGPU verfügbar – die Grafikkarte beschleunigt die Erkennung.'
  : '🐢 Kein WebGPU gefunden – läuft über den Prozessor (langsamer). Tipp: aktuelles Chrome/Edge verwenden.';
if (!hasGPU) {
  el.model.querySelector('[data-gpu]').disabled = true;
}

const fmtSize = (b) => (b > 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');
const showError = (msg) => { el.error.textContent = msg; el.error.classList.toggle('hidden', !msg); };
const toast = (msg) => { el.toast.textContent = msg; el.toast.classList.add('show'); setTimeout(() => el.toast.classList.remove('show'), 2200); };
const baseName = () => (file?.name || 'transkript').replace(/\.[^.]+$/, '');

function setProgress(stage, frac, eta = '') {
  el.stage.textContent = stage;
  const p = Math.round(frac * 100);
  el.percent.textContent = p + ' %';
  el.fill.style.width = p + '%';
  el.eta.textContent = eta;
}

async function selectFile(f) {
  showError('');
  el.start.disabled = true;
  if (!f) return;
  if (f.size > MAX_BYTES) return showError(`Die Datei ist ${fmtSize(f.size)} groß – erlaubt sind maximal 8 GB.`);
  file = f;
  el.drop.classList.add('hidden');
  el.info.classList.remove('hidden');
  el.name.textContent = f.name;
  el.meta.textContent = `${fmtSize(f.size)} · Länge wird geprüft …`;
  try {
    duration = await probeDuration(f);
  } catch (e) {
    duration = null;
  }
  if (file !== f) return;
  if (duration == null) {
    el.meta.textContent = `${fmtSize(f.size)} · Länge unbekannt`;
    return showError('Die Datei konnte nicht gelesen werden. Bitte ein gängiges Video- oder Audioformat verwenden.');
  }
  el.meta.textContent = `${fmtSize(f.size)} · ${fmtTime(duration)}`;
  if (duration > MAX_SECONDS) return showError(`Die Datei ist ${fmtTime(duration)} lang – erlaubt sind maximal 2 Stunden.`);
  el.start.disabled = false;
}

function resetFile() {
  file = null; duration = null;
  el.input.value = '';
  el.info.classList.add('hidden');
  el.drop.classList.remove('hidden');
  el.start.disabled = true;
  showError('');
}

el.input.addEventListener('change', () => selectFile(el.input.files[0]));
el.remove.addEventListener('click', (e) => { e.preventDefault(); resetFile(); });
['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('drag'); }));
el.drop.addEventListener('drop', (e) => selectFile(e.dataTransfer.files[0]));

function render() {
  if (!edited) el.output.value = toText(chunks, el.ts.checked);
}

function waitFor(type) {
  return new Promise((resolve, reject) => {
    const h = ({ data }) => {
      if (data.type === type) { worker.removeEventListener('message', h); resolve(data); }
      else if (data.type === 'error') { worker.removeEventListener('message', h); reject(new Error(data.message)); }
    };
    worker.addEventListener('message', h);
  });
}

async function run() {
  cancelled = false; edited = false; chunks = [];
  showError('');
  el.upload.classList.add('hidden');
  el.progress.classList.remove('hidden');
  el.result.classList.add('hidden');
  el.output.value = '';

  try {
    // 1) extract audio
    setProgress('🎵 Tonspur wird extrahiert …', 0);
    const audio = await extractAudio(file, duration, (f) => setProgress('🎵 Tonspur wird extrahiert …', f));
    terminateFFmpeg(); // free memory
    if (cancelled) return;

    // 2) load model
    if (!worker) {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'language' && data.language) {
          el.device.textContent = '🌍 Erkannte Sprache: ' + (new Intl.DisplayNames(['de'], { type: 'language' }).of(data.language) || data.language);
        }
        if (data.type === 'download' && data.total) {
          setProgress('🧠 KI-Modell wird geladen (nur beim ersten Mal) …', data.loaded / data.total,
            `${data.file}: ${fmtSize(data.loaded)} / ${fmtSize(data.total)}`);
        }
      });
    }
    setProgress('🧠 KI-Modell wird vorbereitet …', 0);
    for (let attempt = 1; ; attempt++) {
      try {
        worker.postMessage({
          type: 'load',
          model: el.model.value,
          device: hasGPU ? 'webgpu' : 'wasm',
          baseURI: document.baseURI
        });
        await waitFor('ready');
        break;
      } catch (e) {
        if (attempt >= 3 || !/fetch|network/i.test(e.message)) throw e;
        setProgress(`🔁 Download unterbrochen – neuer Versuch (${attempt + 1}/3) …`, 0);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (cancelled) return;

    // 3) transcribe segment by segment
    const total = audio.length;
    if (!total) {
      throw new Error('Aus der Datei konnte kein Ton extrahiert werden (0 Sekunden Audio).');
    }
    el.result.classList.remove('hidden');
    el.output.placeholder = 'Transkription läuft … der Text erscheint hier fortlaufend.';
    const segLen = SEGMENT_SEC * SR;
    const t0 = performance.now();
    for (let off = 0, id = 0; off < total; off += segLen, id++) {
      if (cancelled) return;
      const seg = audio.slice(off, Math.min(off + segLen, total));
      worker.postMessage({ type: 'segment', id, audio: seg, offset: off / SR, language: el.lang.value || null }, [seg.buffer]);
      const res = await waitFor('segment');
      if (res.chunks && res.chunks.length > 0) {
        chunks.push(...res.chunks);
        render();
        el.output.scrollTop = el.output.scrollHeight;
      }
      const done = Math.min(off + segLen, total) / total;
      const elapsed = (performance.now() - t0) / 1000;
      const remain = elapsed / done - elapsed;
      setProgress('✍️ Transkript wird erstellt …', done, `Noch ca. ${fmtTime(remain)} · ${fmtTime((off + segLen) / SR)} von ${fmtTime(total / SR)}`);
    }
    if (chunks.length === 0) {
      showError('Es konnte keine gesprochene Sprache im Video erkannt werden. Bitte prüfe, ob die Datei Ton enthält und die Sprache passend eingestellt ist.');
    } else {
      setProgress('✅ Fertig!', 1);
      toast('Transkript fertig!');
      setTimeout(() => { el.progress.classList.add('hidden'); el.upload.classList.remove('hidden'); }, 1200);
    }
  } catch (e) {
    console.error(e);
    el.progress.classList.add('hidden');
    el.upload.classList.remove('hidden');
    const msg = e.message || String(e);
    let hint = '';
    if (/memory|allocat/i.test(msg)) hint = ' – zu wenig Arbeitsspeicher. Andere Tabs schließen oder kleinere Qualität wählen.';
    else if (/fetch|network/i.test(msg)) hint = ' – das KI-Modell konnte nicht heruntergeladen werden. Bitte Internetverbindung prüfen, Werbeblocker/VPN für diese Seite deaktivieren und erneut versuchen.';
    showError(`Fehler bei „${el.stage.textContent.replace(/[^\p{L}\s-]/gu, '').trim()}“: ${msg}${hint}`);
  }
}

el.start.addEventListener('click', run);
el.cancel.addEventListener('click', () => {
  cancelled = true;
  terminateFFmpeg();
  if (worker) { worker.terminate(); worker = null; }
  el.progress.classList.add('hidden');
  el.upload.classList.remove('hidden');
  if (chunks.length) toast('Abgebrochen – bisheriger Text bleibt erhalten');
});

el.output.addEventListener('input', () => { edited = true; });
el.ts.addEventListener('change', () => { edited = false; render(); });
el.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.output.value);
  toast('In die Zwischenablage kopiert');
});
el.txt.addEventListener('click', () => saveTxt(el.output.value, baseName()));
el.docx.addEventListener('click', () => saveDocx(el.output.value, baseName()));
