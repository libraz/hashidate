BLENDER ?= /Applications/Blender.app/Contents/MacOS/Blender
# What the viewer actually loads. Git-ignored and fully derived — everything
# here can be rebuilt from the sources a profile names.
OUT      = public/models
TOOLS    = tools/blender
# Descriptors and their export profiles (<AVATARS>/export/<id>.json).
AVATARS ?= avatars
PROFILE  = $(AVATARS)/export/$(AVATAR).json
# Import recipes for purchasable models, one directory per avatar id.
PACKS    = packs

# The two ports `make dev` brings up, named once so that `help` and `stop`
# cannot drift apart. Control honours the same environment variable the runtime
# reads, by the same rule as `controlPort` in src/shell/config.ts: its leading
# digits, if they are a port, else 8765. The viewer's is vite's own and is not
# configurable.
VIEWER_PORT  = 5173
CONTROL_PORT := $(shell p=$$(expr "$(strip $(HASHIDATE_CONTROL_PORT))" : '\([0-9]*\)'); \
	if [ -n "$$p" ] && [ "$$p" -ge 1 ] 2>/dev/null && [ "$$p" -le 65535 ]; then expr "$$p" + 0; else echo 8765; fi)

TTS      = tools/tts
# Speech is the third thing `make dev` starts and the one that opens no port:
# its only caller is the control server on this machine, so it answers on a
# socket that no other user can reach. Mirrors `SOCKET_DIR`/`SOCKET_NAME` in
# src/speech/sidecar.ts and tools/tts/server.py, and HASHIDATE_TTS_SOCKET moves
# all three together. An override is made absolute against the repository root
# here and exported back, so the sidecar (which runs from $(TTS)) and the control
# server do not read one relative path as two places.
ifneq ($(HASHIDATE_TTS_SOCKET),)
TTS_SOCK = $(abspath $(HASHIDATE_TTS_SOCKET))
export HASHIDATE_TTS_SOCKET := $(TTS_SOCK)
else
TTS_SOCK = $(TTS)/.run/speech.sock
endif
# Where a voice is made from: clips in, latents out. Ships empty and keeps its
# own .gitignore, and matches `config.VOICE` on the Python side —
# HASHIDATE_VOICE_DIR moves both together.
CLIPS    = $(TTS)/reference/clips

.PHONY: help dev stop import textures glb \
        voice tts-setup tts-vet tts-refs tts \
        format format-check lint check-assets clean

help:
	@echo "Model conversion and startup. Use yarn ctl for control."
	@echo ""
	@echo "-- Run"
	@echo "  dev              start viewer, control and speech at once"
	@echo "  stop             free :$(VIEWER_PORT), :$(CONTROL_PORT) and the speech socket if something is left holding one"
	@echo "-- Model"
	@echo "  import PACK=<id> PACKAGE=<zip>  unpack a purchased model through $(PACKS)/<id> and build it; no PACK lists the packs"
	@echo "  glb AVATAR=<id>       build $(OUT)/<id>.glb from $(AVATARS)/export/<id>.json, and copy the toon textures its descriptor names to $(OUT)/<id>/"
	@echo "  textures AVATAR=<id>  copy and shrink the profile's textures for the web, subdirectories included"
	@echo "-- Speech"
	@echo "  voice            put WAV clips in $(CLIPS), run this, and the voice is ready"
	@echo "  tts-setup        build the speech sidecar's Python environment (first time only)"
	@echo "  tts-vet          inspect the reference clips (does not build latents)"
	@echo "  tts-refs         re-encode the clips after changing them"
	@echo "  tts              start the speech server ($(TTS_SOCK))"
	@echo "-- Common"
	@echo "  format           format Rust and TypeScript, then lint"
	@echo "  format-check     fail if Rust or TypeScript is not formatted"
	@echo "  lint             clippy, biome and tsc"
	@echo "  check-assets     check that no huge file has crept into what git tracks"
	@echo "  clean            remove the generated files"

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

# Free the two ports and the speech socket when something is still holding one.
#
# Ctrl-C on `make dev` already stops all three, so this is for the case where
# that never happened: a terminal closed, an SSH session dropped, a task runner
# killed from elsewhere. The child keeps the address bound, and the next
# `make dev` fails to bind rather than saying anything useful about why.
#
# The socket has a second half to it. A sidecar that was killed rather than
# stopped leaves its path in the filesystem with nothing behind it, and a bind
# onto that fails as loudly as a real collision — so once nothing holds it, the
# file goes too. The sidecar clears it on the way up as well; this is for the
# operator who ran `make stop` and then looked at the directory.
#
# It asks the OS what is bound rather than reading a pid file it wrote earlier.
# A pid file goes stale, and a stale one either lies about there being nothing
# to stop or names a pid the system has since reused — both worse to diagnose
# than the EADDRINUSE this exists to clear, which at least was true.
#
# What it signals is the process group, not the process holding the port, and
# that part is load-bearing. dev:control is `tsx watch`, so the listener is a
# grandchild of a watcher that outlives it: killing the pid on :8765 frees the
# port and then the watcher rebinds it on the next save, which is a stop that
# lies in the one way this target exists to avoid. The whole `make dev` tree —
# make, concurrently, both wrappers, the watcher, the sidecar — shares one
# group, so one signal per group ends all of it and needs no pattern matching.
#
# The consequence is that it is indiscriminate: it frees these ports whoever is
# on them, including another project's server, and takes that server's group
# with it. That is usually what is wanted, since a foreign listener blocks
# `make dev` exactly as an own one does, so the group is printed with the
# process before anything is signalled and the surprising case stays visible.
stop:
	@ports="$(VIEWER_PORT) $(CONTROL_PORT)"; \
	sock="$(TTS_SOCK)"; \
	if [ -L "$$sock" ] || { [ -e "$$sock" ] && [ ! -S "$$sock" ]; }; then \
		echo "refusing to inspect non-socket speech path: $$sock" >&2; \
		exit 1; \
	fi; \
	self=$$(ps -o pgid= -p $$$$ 2>/dev/null | tr -d ' '); \
	groups=""; pids=""; \
	for p in $$ports; do \
		holders=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN -t 2>/dev/null || true); label=":$$p"; \
		for pid in $$holders; do \
			pgid=$$(ps -o pgid= -p $$pid 2>/dev/null | tr -d ' '); \
			echo "  $$label  pid $$pid  group $$pgid  $$(ps -o command= -p $$pid 2>/dev/null | cut -c1-64)"; \
			if [ -z "$$pgid" ] || [ "$$pgid" = "$$self" ] || [ "$$pgid" = 1 ]; then \
				pids="$$pids $$pid"; \
			else \
				case " $$groups " in *" $$pgid "*) ;; *) groups="$$groups $$pgid";; esac; \
			fi; \
		done; \
	done; \
	if [ -S "$$sock" ]; then \
		holders=$$(lsof -nP -t -- "$$sock" 2>/dev/null || true); label="$$sock"; \
		for pid in $$holders; do \
			pgid=$$(ps -o pgid= -p $$pid 2>/dev/null | tr -d ' '); \
			echo "  $$label  pid $$pid  group $$pgid  $$(ps -o command= -p $$pid 2>/dev/null | cut -c1-64)"; \
			if [ -z "$$pgid" ] || [ "$$pgid" = "$$self" ] || [ "$$pgid" = 1 ]; then \
				pids="$$pids $$pid"; \
			else \
				case " $$groups " in *" $$pgid "*) ;; *) groups="$$groups $$pgid";; esac; \
			fi; \
		done; \
	fi; \
	if [ -z "$$groups$$pids" ]; then \
		if [ -S "$$sock" ]; then rm -f "$$sock"; fi; \
		echo "nothing listening on the dev addresses"; exit 0; \
	fi; \
	for g in $$groups; do kill -TERM -$$g 2>/dev/null || true; done; \
	if [ -n "$$pids" ]; then kill -TERM $$pids 2>/dev/null || true; fi; \
	sleep 2; \
	for g in $$groups; do kill -KILL -$$g 2>/dev/null || true; done; \
	if [ -n "$$pids" ]; then kill -KILL $$pids 2>/dev/null || true; fi; \
	sleep 1; \
	held=""; \
	for p in $$ports; do \
		if lsof -nP -iTCP:$$p -sTCP:LISTEN -t >/dev/null 2>&1; then held="$$held :$$p"; fi; \
	done; \
	if [ -L "$$sock" ] || { [ -e "$$sock" ] && [ ! -S "$$sock" ]; }; then \
		held="$$held $$sock (path changed to a non-socket)"; \
	elif [ -S "$$sock" ]; then \
		holders=$$(lsof -nP -t -- "$$sock" 2>/dev/null || true); \
		if [ -n "$$holders" ]; then held="$$held $$sock"; else rm -f "$$sock"; fi; \
	fi; \
	if [ -n "$$held" ]; then echo "still held:$$held"; exit 1; fi; \
	echo "stopped"

# ------------------------------------------------------------------- Model

# A pack is data, so this runs no code a pack author wrote: the importer unpacks
# the package and puts the pack's descriptor and profile in place, then the two
# targets below build it as they would any other avatar.
import:
	@if [ -z "$(PACK)" ]; then python3 $(TOOLS)/import_pack.py $(PACKS); exit 0; fi; \
	test -n "$(PACKAGE)" || { echo "usage: make $@ PACK=<id> PACKAGE=<path to the zip>" >&2; exit 2; }; \
	python3 $(TOOLS)/import_pack.py $(PACKS) "$(PACK)" "$(PACKAGE)" $(AVATARS)
	@if [ -n "$(PACK)" ]; then $(MAKE) --no-print-directory textures glb AVATAR=$(PACK); fi

# Both targets read a profile rather than taking paths; see tools/blender.
textures:
	@test -n "$(AVATAR)" || { echo "usage: make $@ AVATAR=<id>" >&2; exit 2; }
	@test -f $(PROFILE) || { echo "no export profile: $(PROFILE)" >&2; exit 2; }
	python3 $(TOOLS)/textures.py $(PROFILE)

# Run the export script and show only its markers and errors. The filter must not
# hide the exit status, so Blender writes to a log first: the target fails on a
# non-zero exit, on a missing EXPORTED marker, or on an absent output file.
define blender-export
log=$$(mktemp); \
$(BLENDER) -b --python-exit-code 1 -P $(TOOLS)/export_glb.py $(2) >"$$log" 2>&1; rc=$$?; \
grep -E '^@@@|Error' "$$log" || true; \
if [ $$rc -ne 0 ] || ! grep -q '^@@@ EXPORTED' "$$log" || [ ! -s $(1) ]; then \
	echo "glb export failed (blender exit $$rc): $(1)" >&2; rm -f "$$log"; exit 1; \
fi; \
rm -f "$$log"
endef

glb:
	@test -n "$(AVATAR)" || { echo "usage: make $@ AVATAR=<id>" >&2; exit 2; }
	@test -f $(PROFILE) || { echo "no export profile: $(PROFILE)" >&2; exit 2; }
	mkdir -p $(OUT)
	@$(call blender-export,$(OUT)/$(AVATAR).glb,-- --profile $(PROFILE) $(OUT)/$(AVATAR).glb)
	python3 $(TOOLS)/toon_textures.py $(PROFILE) $(AVATARS)/$(AVATAR).json $(OUT)/$(AVATAR)

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

# The Python under tools/ has no configured formatter or linter, so none of the
# three targets below runs anything for it.
format:
	cargo fmt --all
	yarn lint:fix
	$(MAKE) lint

format-check:
	cargo fmt --all --check
	yarn lint

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	yarn lint
	yarn typecheck

# A .gitignore is weak against being forgotten to be written, and a single file
# handled here reaches 500 MB. Measuring what is actually tracked and failing on
# it is surer, so this is doubled up.
check-assets:
	@tools/check-assets.sh

clean:
	rm -f $(OUT)/*.glb
	rmdir $(OUT) 2>/dev/null || true
