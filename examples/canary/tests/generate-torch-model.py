"""Generate the owned CPU fixture with Python and torch==2.7.1; no pretrained data.

Usage: python generate-torch-model.py /path/to/torch-model.base64
"""
import base64
import io
from pathlib import Path
import sys

import torch


class OwnedRelu(torch.nn.Module):
    def __init__(self):
        super().__init__()
        # Stock FFmpeg discovers the CPU device from the first model parameter.
        self.device_parameter = torch.nn.Parameter(torch.zeros(1), requires_grad=False)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return torch.relu(value)


if __name__ == '__main__':
    if torch.__version__.split('+')[0] != '2.7.1':
        raise SystemExit('Generate this fixture with torch==2.7.1')
    model = torch.jit.script(OwnedRelu().eval())
    assert next(model.parameters()).device.type == 'cpu'
    assert torch.equal(model(torch.tensor([-2.0, 1.0])), torch.tensor([0.0, 1.0]))
    stream = io.BytesIO()
    torch.jit.save(model, stream)
    Path(sys.argv[1]).write_text(base64.b64encode(stream.getvalue()).decode() + '\n')
