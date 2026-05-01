from pathlib import Path

import cv2
import numpy as np


def preprocess_raster_render(render_path: Path, debug_dir: Path) -> dict[str, Path]:
    debug_dir.mkdir(parents=True, exist_ok=True)
    image = cv2.imread(str(render_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not read raster image: {render_path}")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, h=7)
    gray = cv2.equalizeHist(gray)
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        11,
    )
    kernel = np.ones((3, 3), np.uint8)
    line_enhanced = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    edges = cv2.Canny(gray, 50, 150)

    outputs = {
        "original_render": debug_dir / "original_render.png",
        "gray_clean": debug_dir / "gray_clean.png",
        "binary_linework": debug_dir / "binary_linework.png",
        "line_enhanced": debug_dir / "line_enhanced.png",
        "debug_overlay": debug_dir / "debug_overlay.png",
    }
    cv2.imwrite(str(outputs["original_render"]), image)
    cv2.imwrite(str(outputs["gray_clean"]), gray)
    cv2.imwrite(str(outputs["binary_linework"]), binary)
    cv2.imwrite(str(outputs["line_enhanced"]), line_enhanced)
    cv2.imwrite(str(outputs["debug_overlay"]), edges)

    channel_dir = debug_dir / "colour_channels"
    channel_dir.mkdir(exist_ok=True)
    for name, channel in zip(("blue", "green", "red"), cv2.split(image), strict=True):
        cv2.imwrite(str(channel_dir / f"{name}.png"), channel)

    return outputs
