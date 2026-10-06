import * as THREE from 'three';

/** Repaint the CC0 clock's original UV atlas, retaining its mesh and hands. */
export function clockDial(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // The scan packs the dial into the bottom-left of the atlas; the remaining
  // islands wrap the case. Keep that UV layout rather than stretching a new
  // face texture across the rim and back of the clock.
  ctx.fillStyle = '#c2ac87';
  ctx.fillRect(0, 0, 1024, 1024);
  const cx = 284;
  const cy = 748;
  const radius = 278;
  ctx.fillStyle = '#f7f3eb';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5c605b';
  for (let i = 0; i < 60; i++) {
    const angle = (i * Math.PI) / 30 - Math.PI / 2;
    const major = i % 5 === 0;
    const outer = radius * 0.91;
    const inner = radius * (major ? 0.83 : 0.88);
    ctx.lineWidth = major ? 4 : 1.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = 8;
  return texture;
}
