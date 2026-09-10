from hashlib import sha256
from io import BytesIO
import unittest

from PIL import Image

from backend.roi_app.config import Settings
from backend.roi_app.errors import RoiError
from backend.roi_app.images import prepare_image


def image_bytes(size=(1600, 800), image_format="PNG", **kwargs):
    output = BytesIO()
    Image.new("RGB", size, "white").save(output, format=image_format, **kwargs)
    return output.getvalue()


class ImageTests(unittest.TestCase):
    def test_preserves_original_and_aspect(self):
        data = image_bytes()
        prepared = prepare_image(data, Settings())
        self.assertEqual(prepared.original, data)
        self.assertEqual(prepared.source_hash, sha256(data).hexdigest())
        self.assertEqual((prepared.inference_width, prepared.inference_height), (1024, 512))
        self.assertEqual((prepared.width, prepared.height), (1600, 800))

    def test_invalid_bytes_pixels_format_and_orientation(self):
        exif = Image.Exif()
        exif[274] = 6
        cases = [(b"not an image", Settings()), (image_bytes(image_format="GIF"), Settings()),
                 (image_bytes(), Settings(max_upload_bytes=10)),
                 (image_bytes(), Settings(max_decoded_pixels=100)),
                 (image_bytes(image_format="JPEG", exif=exif), Settings()),
                 (image_bytes()[:100], Settings())]
        for data, settings in cases:
            with self.subTest(size=len(data)), self.assertRaises(RoiError):
                prepare_image(data, settings)

    def test_small_jpeg_is_not_upscaled(self):
        prepared = prepare_image(image_bytes((100, 200), "JPEG"), Settings())
        self.assertEqual((prepared.inference_width, prepared.inference_height), (100, 200))