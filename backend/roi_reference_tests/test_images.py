from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from backend.roi_reference.contracts import ReferenceError
from backend.roi_reference.images import prepare_image


CONFIG = {"max_input_bytes": 1024 * 1024, "max_decoded_pixels": 4000000,
          "max_image_side": 1024}


class ImageTests(unittest.TestCase):
    def test_preserves_aspect_ratio_hash_and_source(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (2400, 1200), "white").save(path)
            original = path.read_bytes()
            prepared = prepare_image(path, CONFIG)
            self.assertEqual((prepared.width, prepared.height), (1024, 512))
            self.assertEqual(prepared.source_sha256, sha256(original).hexdigest())
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(prepared.png, prepare_image(path, CONFIG).png)

    def test_no_upscale_and_transparency_is_white(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGBA", (40, 80), (0, 0, 0, 0)).save(path)
            prepared = prepare_image(path, CONFIG)
            with Image.open(BytesIO(prepared.png)) as image:
                self.assertEqual(image.size, (40, 80))
                self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    def test_invalid_image_and_limits(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            path.write_bytes(b"not an image")
            with self.assertRaisesRegex(ReferenceError, "invalid_image"):
                prepare_image(path, CONFIG)
            Image.new("RGB", (40, 80)).save(path)
            with self.assertRaisesRegex(ReferenceError, "image_bytes_exceeded"):
                prepare_image(path, {**CONFIG, "max_input_bytes": 8})
            with self.assertRaisesRegex(ReferenceError, "image_pixels_exceeded"):
                prepare_image(path, {**CONFIG, "max_decoded_pixels": 100})

    def test_rejects_exif_rotation_instead_of_rotating_twice(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "source.jpg"
            exif = Image.Exif()
            exif[274] = 6
            Image.new("RGB", (40, 80)).save(path, exif=exif)
            with self.assertRaisesRegex(ReferenceError, "ambiguous_exif_orientation"):
                prepare_image(path, CONFIG)