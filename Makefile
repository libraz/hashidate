BLENDER ?= /Applications/Blender.app/Contents/MacOS/Blender
DL      ?= $(HOME)/Downloads
# Purchased archives, extracted meshes and raw textures. Git-ignored, and large:
# the two avatars together are around 1.5 GB.
RES      = backup/resource
# What the viewer actually loads. Git-ignored and fully derived — everything
# here can be rebuilt from $(RES) by the targets below.
OUT      = public/models
TOOLS    = tools/blender

TTS      = tools/tts
# Where a voice is made from: clips in, latents out. Ships empty and keeps its
# own .gitignore, and matches `config.VOICE` on the Python side —
# HASHIDATE_VOICE_DIR moves both together.
CLIPS    = $(TTS)/reference/clips

.PHONY: help dev all extract textures resize glb \
        manuka manuka-extract manuka-textures manuka-glb \
        voice tts-setup tts-vet tts-refs tts \
        check-assets clean clean-tex

help:
	@echo "Model conversion and startup. Use yarn ctl for control."
	@echo ""
	@echo "-- Run"
	@echo "  dev              start viewer, control and speech at once"
	@echo "-- Tabimakura Yoka"
	@echo "  extract          pull the FBX and unitypackage out of the purchased zip"
	@echo "  textures         pull the textures out of the unitypackage"
	@echo "  resize           shrink the textures for the web"
	@echo "  glb              build $(OUT)/yoka.glb"
	@echo "-- Manuka"
	@echo "  manuka-extract   unpack the purchased zip"
	@echo "  manuka-textures  shrink the bundled textures for the web"
	@echo "  manuka-glb       build $(OUT)/manuka.glb"
	@echo "-- Speech"
	@echo "  voice            put WAV clips in $(CLIPS), run this, and the voice is ready"
	@echo "  tts-setup        build the speech sidecar's Python environment (first time only)"
	@echo "  tts-vet          inspect the reference clips (does not build latents)"
	@echo "  tts-refs         re-encode the clips after changing them"
	@echo "  tts              start the speech server (127.0.0.1:8770)"
	@echo "-- Common"
	@echo "  all              take both avatars through to GLB (assumes they are unpacked)"
	@echo "  check-assets     check that no huge file has crept into what git tracks"
	@echo "  clean            remove the generated files"

all: glb manuka-glb

# ----------------------------------------------------------------------- Run

# Bring up the viewer, the control server and the speech sidecar at once.
#
# Only speech drops out silently when its environment is missing. The sidecar
# demands a purchased voice and 3 GB of PyTorch, so not having it is the normal
# case, and a "start everything" that fails on a machine without it is pointless.
#
# --kill-others is not passed to concurrently, and that too is for speech. A
# sidecar that dies mid-generation is expected, and if it dragged the renderer
# down with it the very design of falling silent and carrying on would stop
# holding. Ctrl-C is propagated to all three by concurrently, so stopping them
# together works without it.
#
# The trailing exit 0 is for that Ctrl-C. Stopping makes concurrently exit
# non-zero and make reports that as a failure, but here stopping is how this
# ends, so an Error printed every time is the more misleading outcome.
dev:
	@if [ -x $(TTS)/.venv/bin/python ]; then \
		yarn concurrently -n viewer,control,speech -c cyan,magenta,yellow \
			"yarn dev:viewer" \
			"yarn dev:control" \
			"cd $(TTS) && .venv/bin/python server.py"; \
	else \
		echo "no speech sidecar environment, so starting viewer and control only (make tts-setup to build one)"; \
		yarn dev; \
	fi; \
	exit 0

# --------------------------------------------------------- Tabimakura Yoka
#
# https://booth.pm/en/items/8217336 — the two zips below are what a purchase
# downloads, and they are expected in $(DL).

extract:
	mkdir -p $(RES)/yoka/fbx $(RES)/downloads
	unzip -o -j $(DL)/TabimakuraYoka_Assets_1.0.0.zip "*/Assets/fbx/*.fbx" -d $(RES)/yoka/fbx
	unzip -o -j $(DL)/TabimakuraYoka_Avatar_1.0.0.zip "*.unitypackage" -d $(RES)/downloads

textures:
	python3 $(TOOLS)/extract_textures.py \
		$(RES)/downloads/TabimakuraYokaVRChat_1.0.0.unitypackage $(RES)/yoka/tex

# Texture_1K is really 4096px, so it is dropped for the web. Face and body keep 2048
resize:
	mkdir -p $(RES)/yoka/tex_web && cp $(RES)/yoka/tex/*.png $(RES)/yoka/tex_web/
	@for f in $(RES)/yoka/tex_web/*.png; do \
		case "$$(basename $$f)" in \
			Face*|Body*) sips -Z 2048 "$$f" >/dev/null ;; \
			*)           sips -Z 1024 "$$f" >/dev/null ;; \
		esac \
	done
	@du -sh $(RES)/yoka/tex $(RES)/yoka/tex_web

# Extra outfits carry their own physics bones, so they are merged together with a
# graft of those bones onto the main skeleton
glb:
	mkdir -p $(OUT)
	$(BLENDER) -b -P $(TOOLS)/export_glb.py -- \
		$(RES)/yoka/fbx/TabimakuraYoka.fbx $(OUT)/yoka.glb $(RES)/yoka/tex_web \
		$(RES)/yoka/fbx/Bottoms_long.fbx $(RES)/yoka/fbx/Pillow.fbx \
		2>&1 | grep -E '^@@@|Error'

# ------------------------------------------------------------------ Manuka
#
# https://booth.pm/en/items/5058077 — the zip below is what a purchase
# downloads, and it is expected in $(DL).

manuka: manuka-textures manuka-glb

# Manuka bundles blend / FBX / PSD / VRM, so unpacking only has to put them in place
manuka-extract:
	mkdir -p $(RES)/manuka
	unzip -o -q $(DL)/MANUKA_ver1.02.zip -d $(RES)/manuka

# The bundled textures are 4096px. Face and body keep 2048
manuka-textures:
	mkdir -p $(RES)/manuka/tex_web
	cp $(RES)/manuka/MANUKA_ver1.02/PNG/*.png $(RES)/manuka/tex_web/
	@for f in $(RES)/manuka/tex_web/*.png; do \
		case "$$(basename $$f)" in \
			Manuka_face*|Manuka_body*) sips -Z 2048 "$$f" >/dev/null ;; \
			*)                         sips -Z 1024 "$$f" >/dev/null ;; \
		esac \
	done
	@du -sh $(RES)/manuka/MANUKA_ver1.02/PNG $(RES)/manuka/tex_web

# No extra outfits, and the FBX holds no texture references, so they are wired by
# material name. Which shape groups to keep is in export_glb.py's manuka profile
manuka-glb:
	mkdir -p $(OUT)
	$(BLENDER) -b -P $(TOOLS)/export_glb.py -- --profile manuka \
		$(RES)/manuka/MANUKA_ver1.02/MANUKA.fbx $(OUT)/manuka.glb $(RES)/manuka/tex_web \
		2>&1 | grep -E '^@@@|Error'

# -------------------------------------------------------------------- Speech

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

# ------------------------------------------------------------------ Common

# A .gitignore is weak against being forgotten to be written, and a single file
# handled here reaches 500 MB. Measuring what is actually tracked and failing on
# it is surer, so this is doubled up.
check-assets:
	@tools/check-assets.sh

clean:
	rm -f $(OUT)/*.glb
	rmdir $(OUT) 2>/dev/null || true

# Throws the shrunk textures away as well. The original 4K stays in $(RES), so it
# can be remade
clean-tex:
	rm -rf $(RES)/yoka/tex_web $(RES)/manuka/tex_web
