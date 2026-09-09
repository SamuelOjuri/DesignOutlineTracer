from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import warnings

from PIL import Image, UnidentifiedImageError

from .contracts import ReferenceError


@dataclass(frozen=True)
class PreparedImage:
    png: bytes
    source_sha256: str
    source_width: int
    source_height: int
    width: int
    height: int

    def metadata(self) -> dict:
        return {
            "source_sha256": self.source_sha256,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "inference_sha256": sha256(self.png).hexdigest(),
            "inference_width": self.width,
            "inference_height": self.height,
            "mime_type": "image/png",
            "preparation_version": "rgb-white-lanczos-png-v1",
            "orientation": "encoded_pixels_no_exif_rotation",
        }


def prepare_image(path: Path, config: dict) -> PreparedImage:
    with path.open("rb") as source:
        data = source.read(config["max_input_bytes"] + 1)
    if len(data) > config["max_input_bytes"]:
        raise ReferenceError("image_bytes_exceeded")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in ("PNG", "JPEG"):
                    raise ReferenceError("unsupported_image")
                width, height = image.size
                if width * height > config["max_decoded_pixels"]:
                    raise ReferenceError("image_pixels_exceeded")
                image.verify()
            with Image.open(BytesIO(data)) as image:
                if getattr(image, "n_frames", 1) != 1:
                    raise ReferenceError("unsupported_image")
                if image.getexif().get(274, 1) != 1:
                    raise ReferenceError("ambiguous_exif_orientation")
                rgba = image.convert("RGBA")
                flattened = Image.new("RGBA", rgba.size, "white")
                flattened.alpha_composite(rgba)
                inference = flattened.convert("RGB")
                inference.thumbnail(
                    (config["max_image_side"], config["max_image_side"]),
                    Image.Resampling.LANCZOS,
                )
                output = BytesIO()
                inference.save(output, format="PNG")
                return PreparedImage(
                    output.getvalue(), sha256(data).hexdigest(), width, height,
                    inference.width, inference.height,
                )
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, SyntaxError):
        raise ReferenceError("invalid_image") from None