import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmPathClearance } from '@/engine/rig/arm-path';
import type { Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

function scenario(side: Side) {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const driver = rig.armDriver(side);
  const context = rig.armForwardContext(side);
  if (!(driver && context)) throw new Error(`missing ${side} arm driver`);
  driver.captureVolumeFrame();
  driver.requestForConfiguration(driver.acceptedConfiguration, context, {}, {});
  expect(driver.validateLockedPose(driver.acceptedQ, context, {}, {})).toBe(true);
  const points = driver.bridgeOutput.points.map((point) => ({
    id: point.id,
    kind: point.kind,
    position: point.position.clone(),
  }));
  const rows: ArmPathClearance[] = Array.from({ length: driver.environment.rowCount }, () => ({
    key: '',
    pointIndex: -1,
    valid: false,
    distance: Number.POSITIVE_INFINITY,
    normal: new THREE.Vector3(),
  }));
  return { driver, points, rows };
}

function snapshot(rows: readonly ArmPathClearance[]) {
  return rows.map((row) => ({
    key: row.key,
    pointIndex: row.pointIndex,
    valid: row.valid,
    distance: row.distance,
    normal: row.normal.toArray(),
  }));
}

describe('arm clearance row keys', () => {
  it.each(['L', 'R'] as const)('reads each %s point identity once per repeated sample', (side) => {
    const { driver, points, rows } = scenario(side);
    let reads = 0;
    const observed = points.map((point) => ({
      get id() {
        reads++;
        return point.id;
      },
      kind: point.kind,
      position: point.position,
    }));
    driver.sampleEnvironment(observed, rows);
    const first = snapshot(rows);
    driver.sampleEnvironment(observed, rows);
    expect(snapshot(rows)).toEqual(first);
    expect(reads).toBe(2 * points.length);
    expect(rows.map((row) => row.key)).toEqual(
      points.flatMap((point) => [`${point.id}:torso`, `${point.id}:head`, `${point.id}:face`]),
    );
  });

  it.each(['L', 'R'] as const)(
    'preserves %s row values and order across reordered and renamed point IDs',
    (side) => {
      const { driver, points, rows } = scenario(side);
      driver.sampleEnvironment(points, rows);
      const baseline = snapshot(rows);
      const byKey = new Map(baseline.map((row) => [row.key, row]));
      const reordered = [...points].reverse();
      driver.sampleEnvironment(reordered, rows);
      for (const row of snapshot(rows)) {
        const prior = byKey.get(row.key);
        expect(prior, row.key).toBeDefined();
        expect(row).toEqual({ ...prior, pointIndex: row.pointIndex });
      }
      expect(rows.map((row) => row.key)).toEqual(
        reordered.flatMap((point) => [`${point.id}:torso`, `${point.id}:head`, `${point.id}:face`]),
      );
      expect(rows.map((row) => row.pointIndex)).toEqual(reordered.flatMap((_, i) => [i, i, i]));

      const renamed = points.map((point, i) => ({ ...point, id: `${point.id}:renamed.${i}` }));
      driver.sampleEnvironment(renamed, rows);
      expect(snapshot(rows)).toEqual(
        baseline.map((row) => ({
          ...row,
          key: `${renamed[row.pointIndex].id}:${row.key.slice(row.key.lastIndexOf(':') + 1)}`,
        })),
      );
      driver.sampleEnvironment(points, rows);
      expect(snapshot(rows)).toEqual(baseline);
    },
  );

  it('refreshes geometry while retaining the point keys', () => {
    const { driver, points, rows } = scenario('R');
    driver.sampleEnvironment(points, rows);
    const baseline = snapshot(rows);
    const index = rows.findIndex((row) => row.valid && row.key.endsWith(':torso'));
    expect(index).toBeGreaterThanOrEqual(0);
    const pointIndex = rows[index].pointIndex;
    points[pointIndex].position.x += 1;
    driver.sampleEnvironment(points, rows);
    expect(rows.map((row) => row.key)).toEqual(baseline.map((row) => row.key));
    expect(rows[index].distance).not.toBe(baseline[index].distance);
    const changed = snapshot(rows);
    driver.sampleEnvironment(points, rows);
    expect(snapshot(rows)).toEqual(changed);
  });
});
