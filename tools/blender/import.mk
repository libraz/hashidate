# Model conversion targets. The including Makefile must define BLENDER, OUT,
# TOOLS, AVATARS, PROFILE and PACKS; this file supplies no defaults.
$(foreach v,BLENDER OUT TOOLS AVATARS PROFILE PACKS,$(if $(value $(v)),,$(error $(v) must be set by the including Makefile)))

.PHONY: import textures glb

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
