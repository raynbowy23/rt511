/** The scoring constants the server's scorer and the browser's live line both use. Defined once here, because the live line mirrors the server's formula and a constant copied into two places drifts. */
export const SCORE = {
    /** A frame difference equal to the camera's baseline scores this, so an ordinary camera doing an ordinary thing sits mid-range and twice the baseline saturates. */
    ANOMALY_AT_BASELINE: 0.5,
    /** What a scale prior of 0 and of 1 multiply the movement term by: a quiet street, then a major interstate. */
    SCALE_AMPLIFIER_MIN: 0.5,
    SCALE_AMPLIFIER_MAX: 1.5,
};
//# sourceMappingURL=score.js.map