"""The checkpoint table and the step counts it implies."""

import importlib
import os
import unittest


def load(model: str | None):
    previous = os.environ.get("HASHIDATE_TTS_MODEL")
    try:
        if model is None:
            os.environ.pop("HASHIDATE_TTS_MODEL", None)
        else:
            os.environ["HASHIDATE_TTS_MODEL"] = model
        import config

        return importlib.reload(config)
    finally:
        if previous is None:
            os.environ.pop("HASHIDATE_TTS_MODEL", None)
        else:
            os.environ["HASHIDATE_TTS_MODEL"] = previous


class ConfigTests(unittest.TestCase):
    def test_every_checkpoint_has_its_own_step_count(self):
        config = load(None)
        self.assertEqual(set(config.STEPS), set(config.CHECKPOINTS))

    def test_the_loaded_model_sets_the_default_steps(self):
        for model in ("small", "large", "mf"):
            with self.subTest(model=model):
                config = load(model)
                self.assertEqual(config.DEFAULT_STEPS, config.STEPS[model])
        self.assertEqual(load("mf").DEFAULT_STEPS, 4)


if __name__ == "__main__":
    unittest.main()
