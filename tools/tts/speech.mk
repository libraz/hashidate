# Speech sidecar targets. The including Makefile must define TTS and CLIPS;
# this file supplies no defaults.
$(foreach v,TTS CLIPS,$(if $(value $(v)),,$(error $(v) must be set by the including Makefile)))

.PHONY: voice tts-setup tts-vet tts-refs tts

# Everything the voice needs, in one command: put WAV clips in $(CLIPS) and run
# this. It builds the Python environment if there is not one, then encodes the
# clips into the latents the sidecar loads at startup.
#
# Both halves are safe to repeat. The environment is skipped when it already
# exists, so re-running after adding a clip only redoes the encoding, which is
# the part that is actually cheap.
#
# The clips themselves are the one thing that cannot be automated: they are
# recordings of whoever the voice is supposed to be, and nobody else's are a
# substitute.
voice:
	@if [ -z "$$HASHIDATE_VOICE_DIR" ] && [ -z "$$(ls $(CLIPS)/*.wav 2>/dev/null)" ] \
	   && [ -z "$$(ls backup/voice/clips/*.wav 2>/dev/null)" ]; then \
		echo "no reference clips in $(CLIPS)"; \
		echo ""; \
		echo "Put WAV files of the voice there and run this again. Clean speech, one"; \
		echo "speaker, no music and no second voice. A minute or two is enough — this"; \
		echo "is a reference, not a training set."; \
		echo ""; \
		echo "HASHIDATE_VOICE_DIR points all of this somewhere else."; \
		exit 1; \
	fi
	@if [ ! -x $(TTS)/.venv/bin/python ]; then \
		echo "no speech environment yet, building it first"; \
		$(MAKE) tts-setup; \
	fi
	cd $(TTS) && .venv/bin/python refs.py

# Irodori-TTS is installed straight from upstream. It carries torch, so it comes
# to around 3 GB. Python 3.11 is libsonare's requirement (upstream TTS is happy
# with anything from 3.10 up). Completely separate from the Node-side environment.
tts-setup:
	cd $(TTS) && uv venv --python 3.11 .venv
	cd $(TTS) && uv pip install --python .venv -r pyproject.toml

# Inspection of the reference clips. For when only a check is wanted, without
# building latents. tts-refs runs the same inspection internally and stops if any
# clip failed it.
tts-vet:
	cd $(TTS) && .venv/bin/python vet.py

# The encoding half of `voice`, on its own, for when the environment is known to
# be there and only the clips have changed.
tts-refs:
	cd $(TTS) && .venv/bin/python refs.py

tts:
	cd $(TTS) && .venv/bin/python server.py
