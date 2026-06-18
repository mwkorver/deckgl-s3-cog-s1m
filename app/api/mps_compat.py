"""Make SAM 3 runnable on Apple Silicon (MPS) / CPU.

SAM 3 is written for CUDA: it sprinkles `.cuda()` calls and `device="cuda"`
literals throughout. The `.cuda()` calls (image preprocessing in io_utils plus
all the tracker/video paths) are caught here by monkeypatching Tensor.cuda and
Module.cuda to route to the chosen device. The `device="cuda"` *string literals*
can't be intercepted this way and are edited directly in the sam3 source.

`@torch.autocast(device_type="cuda")` does NOT need handling: torch auto-disables
cuda autocast (with a warning) when CUDA is unavailable.

IMPORTANT: call install() BEFORE importing sam3, so method decorators applied at
import time see the patched behavior.
"""

import torch


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def install(device: str | None = None) -> str:
    """Route .cuda() -> .to(device). Returns the chosen device string."""
    device = device or pick_device()
    if device == "cuda":
        return device  # real CUDA box: leave torch untouched

    def _tensor_cuda(self, *args, **kwargs):
        return self.to(device)

    def _module_cuda(self, *args, **kwargs):
        return self.to(device)

    torch.Tensor.cuda = _tensor_cuda
    torch.nn.Module.cuda = _module_cuda
    return device
