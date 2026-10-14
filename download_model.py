import os
import urllib.request
import json

BASE_URL = "https://huggingface.co/onnx-community/whisper-base/raw/main"
LFS_URL = "https://huggingface.co/onnx-community/whisper-base/resolve/main"

TARGET_DIR = "public/models/whisper-base"
os.makedirs(f"{TARGET_DIR}/onnx", exist_ok=True)

files = [
    ("config.json", BASE_URL),
    ("generation_config.json", BASE_URL),
    ("preprocessor_config.json", BASE_URL),
    ("tokenizer.json", LFS_URL),
    ("tokenizer_config.json", BASE_URL),
    ("special_tokens_map.json", BASE_URL),
    ("onnx/encoder_model_quantized.onnx", LFS_URL),
    ("onnx/decoder_model_merged_quantized.onnx", LFS_URL),
]

headers = {"User-Agent": "Mozilla/5.0"}

for rel_path, host in files:
    dest = os.path.join(TARGET_DIR, rel_path)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        print(f"Already exists: {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")
        continue
    url = f"{host}/{rel_path}"
    print(f"Downloading {url} -> {dest} ...")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("content-length", 0))
        done = 0
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total > 0 and done % (5 * 1024 * 1024) < 64 * 1024:
                print(f"  {done / 1e6:.1f} / {total / 1e6:.1f} MB")
    print(f"✓ Saved {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")

print("All files downloaded successfully.")
