#!/usr/bin/env python3
"""
Train a small SketchRNN-style model on your stroke library.

Converts unit-normalized polylines → (dx, dy, pen) sequences,
learns a latent + decoder that can invent new gestures.

    PYTHONPATH=. python3 generate/stroke_model/train.py --epochs 40
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[2]
LIB_PATH = ROOT / "data" / "generate" / "stroke_library.json"
ICONS_DIR = ROOT / "data" / "generate" / "icons"
CKPT_DIR = ROOT / "data" / "generate" / "stroke_model"
CKPT_PATH = CKPT_DIR / "sketchrnn.pt"

MAX_LEN = 64  # steps (dx,dy) after converting points
ICON_MAX_LEN = 96
N_LATENT = 64
N_HIDDEN = 256
N_MIX = 10
MIN_POINTS = 8


def points_to_offsets(points: list[list[float]]) -> np.ndarray:
    """points [[x,y],...] unit-ish → (T, 3) dx,dy,pen_down(1) with last pen=0 end."""
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 2:
        return np.zeros((0, 3), dtype=np.float32)
    d = np.diff(pts, axis=0)
    # soft clip outliers
    d = np.clip(d, -0.35, 0.35)
    pen = np.ones((len(d), 1), dtype=np.float64)
    pen[-1, 0] = 0.0  # end of stroke
    return np.concatenate([d, pen], axis=1).astype(np.float32)


def offsets_to_points(offsets: np.ndarray) -> list[list[float]]:
    """(T,3) → polyline centered at origin."""
    if len(offsets) == 0:
        return []
    xy = np.cumsum(offsets[:, :2], axis=0)
    # center
    xy = xy - xy.mean(axis=0, keepdims=True)
    return [[float(x), float(y)] for x, y in xy]


def load_offset_sequences(
    max_strokes: int = 8000,
    *,
    icon: str | None = None,
    max_len: int = MAX_LEN,
) -> list[np.ndarray]:
    if icon:
        path = ICONS_DIR / f"{icon}.json"
        if not path.exists():
            raise SystemExit(
                f"Missing {path}\nRun: PYTHONPATH=. python3 generate/extract_icons.py --label {icon}"
            )
        lib = json.loads(path.read_text(encoding="utf-8"))
        raw = lib.get("sequences") or []
        seqs: list[np.ndarray] = []
        for s in raw:
            pts = s.get("points") or []
            if len(pts) < MIN_POINTS:
                continue
            off = points_to_offsets(pts)
            if len(off) < 4:
                continue
            if len(off) > max_len:
                idx = np.linspace(0, len(off) - 1, max_len).astype(int)
                off = off[idx]
                off[-1, 2] = 0.0
            seqs.append(off)
            if len(seqs) >= max_strokes:
                break
        if len(seqs) < 30:
            raise SystemExit(f"Need more icon sequences for '{icon}' (got {len(seqs)})")
        return seqs

    if not LIB_PATH.exists():
        raise SystemExit(f"Missing {LIB_PATH}\nRun: npm run vectorize")
    lib = json.loads(LIB_PATH.read_text(encoding="utf-8"))
    seqs = []
    for s in lib.get("strokes") or []:
        if s.get("fill"):
            continue
        pts = s.get("points") or []
        if len(pts) < MIN_POINTS:
            continue
        off = points_to_offsets(pts)
        if len(off) < 4:
            continue
        if len(off) > max_len:
            idx = np.linspace(0, len(off) - 1, max_len).astype(int)
            off = off[idx]
            off[-1, 2] = 0.0
        seqs.append(off)
        if len(seqs) >= max_strokes:
            break
    if len(seqs) < 50:
        raise SystemExit(f"Need more strokes to train (got {len(seqs)})")
    return seqs


class StrokeDataset(Dataset):
    def __init__(self, seqs: list[np.ndarray], max_len: int = MAX_LEN):
        self.seqs = seqs
        self.max_len = max_len

    def __len__(self) -> int:
        return len(self.seqs)

    def __getitem__(self, i: int) -> torch.Tensor:
        s = self.seqs[i]
        out = np.zeros((self.max_len, 3), dtype=np.float32)
        n = min(len(s), self.max_len)
        out[:n] = s[:n]
        out[n - 1, 2] = 0.0
        if n < self.max_len:
            out[n:, 2] = 0.0
        return torch.from_numpy(out)


def collate(batch: list[torch.Tensor]) -> tuple[torch.Tensor, torch.Tensor]:
    x = torch.stack(batch, dim=0)  # B,T,3
    # mask: true while pen_down was 1 on previous or we're in active region
    # simpler: length until first end (pen=0) after start
    B, T, _ = x.shape
    mask = torch.zeros(B, T, dtype=torch.bool)
    for b in range(B):
        active = True
        for t in range(T):
            mask[b, t] = active
            if x[b, t, 2] < 0.5:
                active = False
    return x, mask


class Encoder(nn.Module):
    def __init__(self, hidden: int = N_HIDDEN, latent: int = N_LATENT):
        super().__init__()
        self.rnn = nn.LSTM(3, hidden, batch_first=True, bidirectional=True)
        self.mu = nn.Linear(hidden * 2, latent)
        self.logvar = nn.Linear(hidden * 2, latent)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        # x: B,T,3
        h, _ = self.rnn(x)
        # last valid step
        lengths = mask.sum(dim=1).clamp(min=1) - 1
        idx = lengths.view(-1, 1, 1).expand(-1, 1, h.size(-1))
        last = h.gather(1, idx).squeeze(1)
        return self.mu(last), self.logvar(last)


class Decoder(nn.Module):
    def __init__(self, hidden: int = N_HIDDEN, latent: int = N_LATENT, n_mix: int = N_MIX):
        super().__init__()
        self.hidden = hidden
        self.n_mix = n_mix
        self.fc_z = nn.Linear(latent, hidden)
        self.rnn = nn.LSTM(3 + latent, hidden, batch_first=True)
        # GMM: pi, mu_x, mu_y, s_x, s_y, rho  +  pen logits (2: down/end)
        self.out = nn.Linear(hidden, n_mix * 6 + 2)

    def forward(
        self,
        x: torch.Tensor,
        z: torch.Tensor,
        h0: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        # teacher force: input shifted strokes + z
        B, T, _ = x.shape
        z_rep = z.unsqueeze(1).expand(-1, T, -1)
        inp = torch.cat([x, z_rep], dim=-1)
        if h0 is None:
            h0_h = torch.tanh(self.fc_z(z)).unsqueeze(0)
            h0_c = torch.zeros_like(h0_h)
            h0 = (h0_h, h0_c)
        out, state = self.rnn(inp, h0)
        return self.out(out), state


class SketchRNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = Encoder()
        self.decoder = Decoder()

    def reparam(self, mu: torch.Tensor, logvar: torch.Tensor) -> torch.Tensor:
        std = torch.exp(0.5 * logvar)
        eps = torch.randn_like(std)
        return mu + eps * std


def gmm_nll(
    params: torch.Tensor,
    target_xy: torch.Tensor,
    n_mix: int = N_MIX,
) -> torch.Tensor:
    """params: B,T, n_mix*6+2 ; target_xy: B,T,2 → NLL per step B,T"""
    B, T, _ = params.shape
    mix = params[..., : n_mix * 6].view(B, T, n_mix, 6)
    pi = F.log_softmax(mix[..., 0], dim=-1)
    mu_x = mix[..., 1]
    mu_y = mix[..., 2]
    s_x = torch.exp(torch.clamp(mix[..., 3], -4, 4)) + 1e-3
    s_y = torch.exp(torch.clamp(mix[..., 4], -4, 4)) + 1e-3
    rho = torch.tanh(mix[..., 5]) * 0.95

    dx = target_xy[..., 0:1] - mu_x
    dy = target_xy[..., 1:2] - mu_y
    z = (
        (dx / s_x) ** 2
        + (dy / s_y) ** 2
        - 2 * rho * dx * dy / (s_x * s_y)
    )
    denom = 2 * math.pi * s_x * s_y * torch.sqrt(torch.clamp(1 - rho**2, min=1e-4))
    log_n = -math.log(2 * math.pi)  # unused; use denom
    log_prob = (
        -0.5 * z / torch.clamp(1 - rho**2, min=1e-4)
        - torch.log(denom)
    )
    log_gmm = torch.logsumexp(pi + log_prob, dim=-1)
    return -log_gmm


def loss_fn(
    model: SketchRNN,
    x: torch.Tensor,
    mask: torch.Tensor,
) -> tuple[torch.Tensor, dict]:
    # encode full stroke
    mu, logvar = model.encoder(x, mask)
    z = model.reparam(mu, logvar)
    # teacher force: feed x[:-1], predict x[1:]
    inp = torch.zeros_like(x)
    inp[:, 1:] = x[:, :-1]
    params, _ = model.decoder(inp, z)
    # xy nll
    nll_xy = gmm_nll(params, x[..., :2])
    # pen: logits for [down, end]
    pen_logits = params[..., N_MIX * 6 :]
    pen_target = (x[..., 2] < 0.5).long()  # 0=down, 1=end
    nll_pen = F.cross_entropy(
        pen_logits.reshape(-1, 2),
        pen_target.reshape(-1),
        reduction="none",
    ).view_as(pen_target)

    masked = mask.float()
    recon = ((nll_xy + nll_pen) * masked).sum() / masked.sum().clamp(min=1)
    kl = -0.5 * torch.mean(1 + logvar - mu.pow(2) - logvar.exp())
    # free bits-ish: anneal handled outside
    return recon + kl, {"recon": float(recon), "kl": float(kl)}


@torch.no_grad()
def sample_stroke(
    model: SketchRNN,
    *,
    temperature: float = 0.6,
    max_len: int = MAX_LEN,
    device: str | torch.device = "cpu",
    z: torch.Tensor | None = None,
) -> list[list[float]]:
    model.eval()
    device = torch.device(device)
    if z is None:
        z = torch.randn(1, N_LATENT, device=device) * temperature
    else:
        z = z.to(device)
        if z.dim() == 1:
            z = z.unsqueeze(0)

    h = torch.tanh(model.decoder.fc_z(z)).unsqueeze(0)
    c = torch.zeros_like(h)
    state = (h, c)
    prev = torch.zeros(1, 1, 3, device=device)
    offsets = []

    for _ in range(max_len):
        z_rep = z.unsqueeze(1)
        inp = torch.cat([prev, z_rep], dim=-1)
        out, state = model.decoder.rnn(inp, state)
        params = model.decoder.out(out)[:, 0]  # 1, features

        mix = params[:, : N_MIX * 6].view(1, N_MIX, 6)
        pi = F.softmax(mix[0, :, 0] / max(temperature, 0.05), dim=0)
        k = int(torch.multinomial(pi, 1).item())
        mu_x = mix[0, k, 1]
        mu_y = mix[0, k, 2]
        s_x = (torch.exp(torch.clamp(mix[0, k, 3], -4, 4)) + 1e-3) * temperature
        s_y = (torch.exp(torch.clamp(mix[0, k, 4], -4, 4)) + 1e-3) * temperature
        rho = torch.tanh(mix[0, k, 5]) * 0.95

        # sample bivariate normal
        eps1 = torch.randn((), device=device)
        eps2 = torch.randn((), device=device)
        x = mu_x + s_x * eps1
        y = mu_y + s_y * (rho * eps1 + torch.sqrt(torch.clamp(1 - rho**2, min=1e-4)) * eps2)
        x = torch.clamp(x, -0.4, 0.4)
        y = torch.clamp(y, -0.4, 0.4)

        pen_logits = params[:, N_MIX * 6 :] / max(temperature, 0.05)
        pen_p = F.softmax(pen_logits, dim=-1)[0]
        end = bool(torch.multinomial(pen_p, 1).item() == 1)

        pen_v = 0.0 if end else 1.0
        offsets.append([float(x), float(y), pen_v])
        prev = torch.tensor([[[float(x), float(y), pen_v]]], device=device)
        if end and len(offsets) > 6:
            break

    arr = np.asarray(offsets, dtype=np.float32)
    return offsets_to_points(arr)


def load_model(
    device: str | torch.device = "cpu",
    *,
    icon: str | None = None,
) -> SketchRNN | None:
    path = CKPT_DIR / f"{icon}.pt" if icon else CKPT_PATH
    if not path.exists():
        return None
    device = torch.device(device)
    model = SketchRNN().to(device)
    state = torch.load(path, map_location=device, weights_only=True)
    model.load_state_dict(state["model"])
    model.eval()
    return model


def train(
    *,
    epochs: int = 40,
    batch: int = 64,
    lr: float = 1e-3,
    device: str = "cpu",
    icon: str | None = None,
) -> None:
    max_len = ICON_MAX_LEN if icon else MAX_LEN
    seqs = load_offset_sequences(icon=icon, max_len=max_len)
    tag = icon or "vibe"
    print(f"train [{tag}] on {len(seqs)} sequences · device={device} · epochs={epochs}")
    ds = StrokeDataset(seqs, max_len=max_len)
    # small icon sets: don't drop_last if tiny
    drop_last = len(ds) >= batch * 2
    loader = DataLoader(
        ds, batch_size=min(batch, len(ds)), shuffle=True, collate_fn=collate, drop_last=drop_last
    )
    device_t = torch.device(device)
    model = SketchRNN().to(device_t)
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    for ep in range(1, epochs + 1):
        model.train()
        total = 0.0
        n = 0
        kl_w = min(1.0, ep / 15)
        for x, mask in loader:
            x = x.to(device_t)
            mask = mask.to(device_t)
            opt.zero_grad()
            mu, logvar = model.encoder(x, mask)
            z = model.reparam(mu, logvar)
            inp = torch.zeros_like(x)
            inp[:, 1:] = x[:, :-1]
            params, _ = model.decoder(inp, z)
            nll_xy = gmm_nll(params, x[..., :2])
            pen_logits = params[..., N_MIX * 6 :]
            pen_target = (x[..., 2] < 0.5).long()
            nll_pen = F.cross_entropy(
                pen_logits.reshape(-1, 2),
                pen_target.reshape(-1),
                reduction="none",
            ).view_as(pen_target)
            m = mask.float()
            recon = ((nll_xy + nll_pen) * m).sum() / m.sum().clamp(min=1)
            kl = -0.5 * torch.mean(1 + logvar - mu.pow(2) - logvar.exp())
            loss = recon + kl_w * kl
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += float(loss)
            n += 1
        print(f"  epoch {ep:02d}  loss={total/max(n,1):.3f}  kl_w={kl_w:.2f}")

    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    out = CKPT_DIR / f"{icon}.pt" if icon else CKPT_PATH
    torch.save(
        {
            "model": model.state_dict(),
            "meta": {"max_len": max_len, "latent": N_LATENT, "icon": icon},
        },
        out,
    )
    print(f"Wrote {out}")
    pts = sample_stroke(model, temperature=0.55, device=device, max_len=max_len)
    print(f"sample points: {len(pts)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--device", default="cpu")
    ap.add_argument(
        "--icon",
        default="",
        help="Train on a labeled icon library (e.g. flower). Empty = vibe strokes.",
    )
    args = ap.parse_args()
    if args.device == "cuda" and not torch.cuda.is_available():
        args.device = "cpu"
    train(
        epochs=args.epochs,
        batch=args.batch,
        device=args.device,
        icon=args.icon or None,
    )


if __name__ == "__main__":
    main()
