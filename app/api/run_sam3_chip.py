"""Stage 2: run SAM 3 (text-concept segmentation) on a chip produced by stage 1.

Stage 1 (test_sam3_cog.py) does DuckDB discovery + rasterio pixel read and writes
chip.png. This script consumes that PNG and runs SAM 3's image predictor with a
text prompt (e.g. "car"), then writes an overlay + a count.

Why a separate script / separate venv:
  - SAM 3 pins numpy<2; rasterio (stage 1) needs numpy>=2. They cannot share a venv.
  - So stage 1 (read) and stage 2 (inference) run in different environments and
    communicate through the chip file. This also mirrors the real pipeline: the
    GPU inference worker is decoupled from the COG reader.

Prereqs (one-time, in a DEDICATED venv):
  python3.12 -m venv ~/.venvs/sam3 && source ~/.venvs/sam3/bin/activate
  # macOS Apple Silicon: CPU/MPS torch (NOT the CUDA wheel the README shows)
  pip install torch torchvision
  pip install -e ~/working/sam3
  # Gated checkpoint — request access first at https://huggingface.co/facebook/sam3
  pip install huggingface_hub && hf auth login

Run:
  PYTORCH_ENABLE_MPS_FALLBACK=1 python run_sam3_chip.py --chip chip.png --prompt car
"""

import argparse
import os

# SAM 3 has a few ops with no MPS kernel (e.g. aten::_addmm_activation); route
# those to CPU automatically. Must be set before torch imports. Harmless on CUDA.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chip", default="chip.png", help="PNG written by test_sam3_cog.py")
    ap.add_argument("--prompt", default="car", help="text concept to segment")
    ap.add_argument("--score-thresh", type=float, default=0.5)
    ap.add_argument("--out", default="chip_sam3.png", help="overlay output path")
    args = ap.parse_args()

    import numpy as np
    # MUST run before importing sam3: routes .cuda() -> .to(device) so the
    # CUDA-coded model loads/runs on Apple Silicon. Returns the chosen device.
    import mps_compat
    device = mps_compat.install()
    print(f"device: {device}")

    from PIL import Image

    # Documented SAM 3 image API (README "Basic Usage").
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    image = Image.open(args.chip).convert("RGB")
    print(f"chip: {image.size} (W,H)")

    model = build_sam3_image_model()
    try:
        model = model.to(device)
    except Exception as e:  # noqa: BLE001 - device move can fail on MPS gaps
        print(f"[warn] .to({device}) failed ({e}); falling back to cpu")
        device = "cpu"
        model = model.to("cpu")
    processor = Sam3Processor(model, device=device)

    state = processor.set_image(image)
    output = processor.set_text_prompt(state=state, prompt=args.prompt)
    masks, scores = output["masks"], output["scores"]

    def to_np(x):
        return x.detach().cpu().numpy() if hasattr(x, "detach") else np.asarray(x)

    scores_np = to_np(scores).reshape(-1)
    keep = scores_np >= args.score_thresh
    n_total = int(scores_np.size)
    n_keep = int(keep.sum())
    print(f"prompt={args.prompt!r}: {n_total} instances detected, "
          f"{n_keep} above score>={args.score_thresh}")

    # Overlay kept masks on the chip so you can eyeball the result.
    base = np.asarray(image).copy()
    masks_np = to_np(masks)
    if masks_np.ndim == 4:  # (N,1,H,W) -> (N,H,W)
        masks_np = masks_np[:, 0]
    rng = np.random.default_rng(0)
    for i in range(masks_np.shape[0]):
        if not keep[i]:
            continue
        m = masks_np[i] > 0.5
        color = rng.integers(64, 255, size=3)
        base[m] = (0.5 * base[m] + 0.5 * color).astype(np.uint8)
    Image.fromarray(base).save(args.out)
    print(f"wrote {args.out}  (kept {n_keep} {args.prompt} masks)")


if __name__ == "__main__":
    main()
