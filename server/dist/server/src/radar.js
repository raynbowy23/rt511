/** Sparse national sampling costs 18 regions times 10 anchors divided by 600 seconds, or 0.3 requests per second before bounded corridor promotion. */
export const RADAR = {
    /** Ten anchors per metro make 180 cameras nationally, so one frame each per 600 seconds costs 0.3 requests per second. */
    RADAR_PER_REGION: 10,
    /** Ten minutes between frames keeps 18 times 10 anchors at 0.3 requests per second, including retries and unchanged images. */
    RADAR_PERIOD_S: 600,
    /** Hourly rotation changes which cameras spend the same 0.3 requests per second budget without adding a warmup poll. */
    RADAR_ROTATE_S: 3600,
    /** Recomputing local selections every thirty seconds adds no DOT requests to the 0.3 requests per second frame budget. */
    RADAR_TICK_S: 30,
};
/** Start with the strongest road priors, then walk the same ordering in bounded batches so smaller roads also get sampled. Elapsed time starts with this server rather than the Unix epoch. */
export function selectRadarAnchors(cameras, watching, prior, elapsedS) {
    const regions = new Map();
    for (const [uid, camera] of cameras) {
        if (watching.has(camera.region))
            continue;
        const ids = regions.get(camera.region) ?? [];
        ids.push(uid);
        regions.set(camera.region, ids);
    }
    const anchors = [];
    for (const ids of regions.values()) {
        ids.sort((a, b) => prior(b) - prior(a) || cameras.get(a).id - cameras.get(b).id || a - b);
        const offset = Math.floor(Math.max(0, elapsedS) / RADAR.RADAR_ROTATE_S) * RADAR.RADAR_PER_REGION;
        for (let i = 0; i < Math.min(ids.length, RADAR.RADAR_PER_REGION); i++)
            anchors.push(ids[(offset + i) % ids.length]);
    }
    return anchors;
}
//# sourceMappingURL=radar.js.map