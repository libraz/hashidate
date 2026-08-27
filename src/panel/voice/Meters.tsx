import { useT } from '@/i18n';
import type { VoiceReport } from '@/protocol';
import styles from './Meters.module.css';

/**
 * What the last line actually measured.
 *
 * Per take rather than per frame, and that is not a limitation — it is the only
 * honest reading available. The take is processed in one pass before any of it
 * plays, so its integrated loudness and its true peak are known exactly, for the
 * whole line, before a sample is heard. A live meter would show a moving average
 * of something already decided.
 *
 * ## The two numbers answer different questions
 *
 * **LUFS** is how loud it will seem, and the target is a platform's, not a
 * preference: −14 LUFS is what the major streaming services normalise toward, so
 * a stream that sits well below it gets turned up on the way out — along with
 * everything else in the mix — and one above it gets turned down.
 *
 * **True peak** is whether it will distort, and it is a different question from
 * how loud it is. The peak that matters is the one *between* samples, which
 * appears when the platform re-encodes: a stream that reads 0.0 dBFS here can
 * clip after transcoding. −1 dBTP is the headroom that survives it.
 */

/** Where the loudness should land, and how far off is worth colouring. */
const TARGET_LUFS = -14;
const LUFS_TOLERANCE = 2;

/** Above this a take will not survive a lossy re-encode intact. */
const PEAK_CEILING_DBTP = -1;

/** The window the loudness bar spans, chosen so the target sits mid-scale. */
const LUFS_FLOOR = -32;
const LUFS_ROOF = -4;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function Meters({ voice }: { voice: VoiceReport | null }) {
  const { t } = useT();
  const lufs = voice?.lufs ?? null;
  const peak = voice?.truePeakDb ?? null;

  const lufsOff = lufs === null ? 0 : Math.abs(lufs - TARGET_LUFS);
  const lufsState = lufs === null ? 'idle' : lufsOff <= LUFS_TOLERANCE ? 'ok' : 'warn';
  const peakState = peak === null ? 'idle' : peak > PEAK_CEILING_DBTP ? 'bad' : 'ok';

  return (
    <div className={styles.meters}>
      <div className={styles.meter}>
        <div className={styles.head}>
          <span className={styles.label}>{t('panel.meters.loudness')}</span>
          <span className={`${styles.value} ${styles[lufsState]}`}>
            {lufs === null ? '—' : `${lufs.toFixed(1)} LUFS`}
          </span>
        </div>
        <div className={styles.track}>
          {/* The target, drawn on the scale rather than stated beside it: the
              question is "how far off", and a distance is read faster than the
              subtraction of two numbers. */}
          <span
            className={styles.target}
            style={{
              left: `${clamp01((TARGET_LUFS - LUFS_FLOOR) / (LUFS_ROOF - LUFS_FLOOR)) * 100}%`,
            }}
            aria-hidden="true"
          />
          {lufs === null ? null : (
            <span
              className={`${styles.fill} ${styles[lufsState]}`}
              style={{ width: `${clamp01((lufs - LUFS_FLOOR) / (LUFS_ROOF - LUFS_FLOOR)) * 100}%` }}
            />
          )}
        </div>
        <span className={styles.foot}>{t('panel.meters.target', { value: TARGET_LUFS })}</span>
      </div>

      <div className={styles.meter}>
        <div className={styles.head}>
          <span className={styles.label}>{t('panel.meters.truePeak')}</span>
          <span className={`${styles.value} ${styles[peakState]}`}>
            {peak === null ? '—' : `${peak.toFixed(1)} dBTP`}
          </span>
        </div>
        <div className={styles.track}>
          <span
            className={styles.target}
            style={{ left: `${clamp01((PEAK_CEILING_DBTP + 24) / 24) * 100}%` }}
            aria-hidden="true"
          />
          {peak === null ? null : (
            <span
              className={`${styles.fill} ${styles[peakState]}`}
              style={{ width: `${clamp01((peak + 24) / 24) * 100}%` }}
            />
          )}
        </div>
        <span className={styles.foot}>
          {t('panel.meters.ceiling', { value: PEAK_CEILING_DBTP })}
        </span>
      </div>
    </div>
  );
}
