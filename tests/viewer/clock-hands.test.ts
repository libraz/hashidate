import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ClockHands } from '@/viewer/scene/backdrop/clock-hands';

/** A thin hand whose tip sits `degrees` clockwise from twelve. */
function hand(name: string, degrees: number): THREE.Mesh {
  const a = THREE.MathUtils.degToRad(degrees);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -0.02 * Math.sin(a),
        -0.02 * Math.cos(a),
        0,
        0.1 * Math.sin(a),
        0.1 * Math.cos(a),
        0,
        0,
        0,
        0,
      ],
      3,
    ),
  );
  const mesh = new THREE.Mesh(geometry);
  mesh.name = name;
  return mesh;
}

function clock(): { root: THREE.Group; pointing: (name: string) => number } {
  const root = new THREE.Group();
  // The modelled pose is roughly ten past ten.
  root.add(hand('wall_clock_hours_hand', 306.8));
  root.add(hand('wall_clock_minute_hand', 57));
  root.add(hand('wall_clock_second_hand', 170.5));
  const pointing = (name: string): number => {
    const mesh = root.getObjectByName(name) as THREE.Mesh;
    mesh.updateMatrixWorld();
    const position = mesh.geometry.getAttribute('position');
    const tip = new THREE.Vector3(position.getX(1), position.getY(1), 0).applyMatrix4(
      mesh.matrixWorld,
    );
    return (THREE.MathUtils.radToDeg(Math.atan2(tip.x, tip.y)) + 360) % 360;
  };
  return { root, pointing };
}

describe('ClockHands', () => {
  it('points each hand at the local time', () => {
    const { root, pointing } = clock();
    const hands = ClockHands.find(root);
    expect(hands).not.toBeNull();

    hands?.set(new Date(2026, 9, 6, 15, 30, 45));
    expect(pointing('wall_clock_second_hand')).toBeCloseTo(270, 6);
    expect(pointing('wall_clock_minute_hand')).toBeCloseTo((30.75 / 60) * 360, 6);
    expect(pointing('wall_clock_hours_hand')).toBeCloseTo(((3 + 30.75 / 60) / 12) * 360, 6);
  });

  it('steps the second hand rather than sweeping it', () => {
    const { root, pointing } = clock();
    const hands = ClockHands.find(root);
    const at = new Date(2026, 9, 6, 0, 0, 12);
    hands?.set(at);
    const whole = pointing('wall_clock_second_hand');
    hands?.set(new Date(at.getTime() + 900));
    expect(pointing('wall_clock_second_hand')).toBeCloseTo(whole, 6);
  });

  it('finds nothing when a hand is missing', () => {
    const root = new THREE.Group();
    root.add(hand('wall_clock_hours_hand', 0));
    root.add(hand('wall_clock_minute_hand', 0));
    expect(ClockHands.find(root)).toBeNull();
  });
});
