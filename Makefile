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

.PHONY: help all extract textures resize glb \
        manuka manuka-extract manuka-textures manuka-glb \
        tts-setup tts-vet tts-refs tts \
        check-assets clean clean-tex

help:
	@echo "モデル変換。デモの起動は yarn dev、制御は yarn ctl を使う。"
	@echo ""
	@echo "-- 旅枕ヨカ"
	@echo "  extract          購入 zip から FBX と unitypackage を取り出す"
	@echo "  textures         unitypackage からテクスチャを取り出す"
	@echo "  resize           テクスチャを Web 用に縮小する"
	@echo "  glb              $(OUT)/yoka.glb を生成する"
	@echo "-- マヌカ"
	@echo "  manuka-extract   購入 zip を展開する"
	@echo "  manuka-textures  同梱テクスチャを Web 用に縮小する"
	@echo "  manuka-glb       $(OUT)/manuka.glb を生成する"
	@echo "-- 音声"
	@echo "  tts-setup        音声サイドカーの Python 環境を作る（初回のみ）"
	@echo "  tts-vet          参照クリップを検品する（latent は作らない）"
	@echo "  tts-refs         backup/voice/clips の参照音声を潜在表現に変換する"
	@echo "  tts              音声サーバを起動する（127.0.0.1:8770）"
	@echo "-- 共通"
	@echo "  all              2 体とも GLB まで通す（展開済みが前提）"
	@echo "  check-assets     git 追跡対象に巨大ファイルが混ざっていないか検査する"
	@echo "  clean            生成物を削除する"

all: glb manuka-glb

# ---------------------------------------------------------------- 旅枕ヨカ

extract:
	mkdir -p $(RES)/yoka/fbx $(RES)/downloads
	unzip -o -j $(DL)/TabimakuraYoka_Assets_1.0.0.zip "*/Assets/fbx/*.fbx" -d $(RES)/yoka/fbx
	unzip -o -j $(DL)/TabimakuraYoka_Avatar_1.0.0.zip "*.unitypackage" -d $(RES)/downloads

textures:
	python3 $(TOOLS)/extract_textures.py \
		$(RES)/downloads/TabimakuraYokaVRChat_1.0.0.unitypackage $(RES)/yoka/tex

# Texture_1K の実体は 4096px のため Web 用に落とす。顔と身体だけ 2048 を保つ
resize:
	mkdir -p $(RES)/yoka/tex_web && cp $(RES)/yoka/tex/*.png $(RES)/yoka/tex_web/
	@for f in $(RES)/yoka/tex_web/*.png; do \
		case "$$(basename $$f)" in \
			Face*|Body*) sips -Z 2048 "$$f" >/dev/null ;; \
			*)           sips -Z 1024 "$$f" >/dev/null ;; \
		esac \
	done
	@du -sh $(RES)/yoka/tex $(RES)/yoka/tex_web

# 追加衣装は自前の揺れボーンを持つため、メイン骨格への移植を伴って統合される
glb:
	mkdir -p $(OUT)
	$(BLENDER) -b -P $(TOOLS)/export_glb.py -- \
		$(RES)/yoka/fbx/TabimakuraYoka.fbx $(OUT)/yoka.glb $(RES)/yoka/tex_web \
		$(RES)/yoka/fbx/Bottoms_long.fbx $(RES)/yoka/fbx/Pillow.fbx \
		2>&1 | grep -E '^@@@|Error'

# ------------------------------------------------------------------ マヌカ

manuka: manuka-textures manuka-glb

# マヌカは blend / FBX / PSD / VRM が同梱されており、展開はそのまま置くだけでよい
manuka-extract:
	mkdir -p $(RES)/manuka
	unzip -o -q $(DL)/MANUKA_ver1.02.zip -d $(RES)/manuka

# 同梱テクスチャは 4096px。顔と身体だけ 2048 を保つ
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

# 追加衣装はなく、テクスチャは FBX 側に参照が無いためマテリアル名で結線する。
# 残すシェイプ群の指定は export_glb.py の manuka プロファイル
manuka-glb:
	mkdir -p $(OUT)
	$(BLENDER) -b -P $(TOOLS)/export_glb.py -- --profile manuka \
		$(RES)/manuka/MANUKA_ver1.02/MANUKA.fbx $(OUT)/manuka.glb $(RES)/manuka/tex_web \
		2>&1 | grep -E '^@@@|Error'

# ---------------------------------------------------------------------- 音声

# Irodori-TTS を上流から直接入れる。torch を含むため 3 GB 前後になる。
# Python 3.11 は libsonare の要件（上流の TTS は 3.10 以上なら何でもよい）。
# Node 側の環境とは完全に別物。
tts-setup:
	cd $(TTS) && uv venv --python 3.11 .venv
	cd $(TTS) && uv pip install --python .venv -r pyproject.toml

# 参照クリップの検品。latent を作らずに確認だけしたいとき用。
# tts-refs も同じ検査を内部で走らせ、落ちたクリップがあれば中断する。
tts-vet:
	cd $(TTS) && .venv/bin/python vet.py

# 参照音声は backup/voice/clips/ に置く。git 追跡対象ではない
tts-refs:
	cd $(TTS) && .venv/bin/python refs.py

tts:
	cd $(TTS) && .venv/bin/python server.py

# -------------------------------------------------------------------- 共通

# .gitignore は書き忘れに弱く、ここで扱うファイルは 1 本 500 MB に達する。
# 追跡対象を実測して落とすほうが確実なので、二重にしてある。
check-assets:
	@tools/check-assets.sh

clean:
	rm -f $(OUT)/*.glb
	rmdir $(OUT) 2>/dev/null || true

# テクスチャの縮小結果まで捨てる。元の 4K は $(RES) に残るので作り直せる
clean-tex:
	rm -rf $(RES)/yoka/tex_web $(RES)/manuka/tex_web
