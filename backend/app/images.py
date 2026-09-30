from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import warnings

from PIL import Image, UnidentifiedImageError

from .config import Settings
from .errors import RoiError


PREPARATION_VERSION = "rgb-white-lanczos-png-v1"


@dataclass(frozen=True)
class PreparedImage:
    original: bytes
    png: bytes
    source_hash: str
    width: int
    height: int
    inference_width: int
    inference_height: int


def prepare_image(data: bytes, settings: Settings) -> PreparedImage:
    if not data or len(data) > settings.max_upload_bytes:
        raise RoiError("image_bytes_exceeded", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in ("PNG", "JPEG"):
                    raise RoiError("unsupported_image")
                width, height = image.size
                if width * height > settings.max_decoded_pixels:
                    raise RoiError("image_pixels_exceeded", 413)
                image.verify()
            with Image.open(BytesIO(data)) as image:
                if getattr(image, "n_frames", 1) != 1:
                    raise RoiError("unsupported_image")
                if image.getexif().get(274, 1) != 1:
                    raise RoiError("ambiguous_exif_orientation")
                rgba = image.convert("RGBA")
                flattened = Image.new("RGBA", rgba.size, "white")
                flattened.alpha_composite(rgba)
                inference = flattened.convert("RGB")
                inference.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                output = BytesIO()
                inference.save(output, format="PNG")
                return PreparedImage(data, output.getvalue(), sha256(data).hexdigest(), width, height,
                                     inference.width, inference.height)
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, SyntaxError, ValueError):
        raise RoiError("invalid_image") from None