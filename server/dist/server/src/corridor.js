import { driver, TUNING } from './attention.js';
/** Shared bounds keep queue inference and the cameras offered to Jev on the same corridor. */
export const CORRIDOR = {
    /** Two hops catch the next stretch of road on either side without waking an entire corridor. */
    PROMOTE_HOPS: 2,
    /** Thirty extra cameras bound the request cost even when many events happen together. */
    PROMOTE_MAX: 30,
    /** Five minutes of attention after the last trigger keep flickering evidence from flapping the poll rate. */
    PROMOTE_HOLD_S: 300,
    /** Movement at roughly 1.8 times usual deserves a fresh look at neighbours once the baseline is established. */
    PROMOTE_ANOMALY: 0.9,
    /** How far up the corridor the candidate set for the queue-tail question reaches, in directed graph hops. A queue from a freeway closure routinely stands back further than the first camera upstream, and one hop can only ever offer the model a tail it has already passed. Three, because the corridor graph's sites are a few hundred metres to a couple of kilometres apart, so three hops covers the distance a queue reaches inside the half hour the incident floor survives. */
    MAX_UPSTREAM_HOPS: 3,
    /** How fast a queue's tail travels back up the corridor, in kilometres per hour, against the traffic. A stopping wave behind a blockage runs at roughly this speed on a freeway, so the road distance to an upstream camera divided by it is the time before the tail should be visible there. Treiber, Kesting and Helbing (2010, Transportation Research Part B 44(8-9), 983-1000) report typical propagation speeds of congestion between 15 and 20 km/h against the traffic, varying with country and traffic composition. This setting sits at the slow end of that range, which errs towards inferring a queue later rather than sooner. It has not been measured on these corridors, and it is shared by scoring and by the candidate descriptions Jev reads. */
    WAVE_SPEED_KMH: 15,
    /** How far up the corridor the walk may reach, in metres of road, whatever the hop count allows. Three hops through a ramp-dense interchange runs to 18 km on the Miami graph, and a queue standing that far back would have taken over an hour to get there, by which time the incident floor it belongs to has decayed through two half-lives. Five kilometres is about twenty minutes at the stopping-wave speed, which is the window the floor actually survives. */
    MAX_UPSTREAM_M: 5000,
};
/** Index once per ranking so scoring never walks the graph per camera. Named cameras are excluded from their own record even when another anchor reaches them. Other sides remain available only for an explicit Jev choice and receive no inferred queue floor. */
export function buildQueueIndex(incidents, corridor, cameras, gate, now = Date.now() / 1000) {
    const index = new Map();
    for (const incident of incidents) {
        const anchors = incident.cameras.flatMap((uid) => {
            const camera = cameras.get(uid);
            return camera ? [{ uid, lat: camera.lat, lon: camera.lon }] : [];
        });
        for (const anchor of anchors) {
            for (const neighbour of corridor.get(anchor.uid) ?? []) {
                if (incident.cameras.includes(neighbour.uid))
                    continue;
                const entries = index.get(neighbour.uid) ?? [];
                entries.push({ incident, anchor, anchors, length_m: neighbour.length_m, wave_s: neighbour.wave_s, upstream: neighbour.side === 'upstream' });
                index.set(neighbour.uid, entries);
            }
        }
    }
    for (const [uid, camera] of cameras) {
        if (!gate || (gate(uid, now)?.value ?? 0) <= 0)
            continue;
        for (const neighbour of corridor.get(uid) ?? []) {
            if (neighbour.side !== 'upstream' || neighbour.uid === uid)
                continue;
            const entries = index.get(neighbour.uid) ?? [];
            entries.push({ source: 'standstill', description: camera.location ?? camera.roadway ?? `camera ${uid}`, anchor: { uid, lat: camera.lat, lon: camera.lon }, length_m: neighbour.length_m, wave_s: neighbour.wave_s, upstream: true });
            index.set(neighbour.uid, entries);
        }
    }
    return index;
}
/** Inferred queues cannot recruit another generation of neighbours, and a cold movement baseline cannot distinguish an event from noise. */
export function promotionTrigger(state) {
    const axes = state.axes;
    if (!axes)
        return null;
    const cause = driver(axes);
    if (cause === 'incident' && axes.incident_floor > 0)
        return { reason: cause, strength: axes.incident_floor };
    if (cause === 'still' && (axes.gate?.floor ?? 0) > 0)
        return { reason: cause, strength: axes.gate.floor };
    if (cause !== 'queue' && (axes.anomaly ?? 0) >= CORRIDOR.PROMOTE_ANOMALY && axes.baseline_n >= TUNING.AMBIGUOUS_MIN_SAMPLES)
        return { reason: 'movement', strength: axes.anomaly };
    return null;
}
/** Selection is pure so the same hold boundary and global cap can be checked without starting a poller.
 *
 * Hops come first in the ordering, ahead of trigger strength. A two-hop neighbourhood through an interchange is large, and ordered by strength alone the two strongest triggers used the whole cap on live Florida data, leaving every other event with no neighbour looked at. Taking every trigger's adjacent cameras before anyone's second hop spreads the budget across events, and the adjacent camera is the one a queue or a moving disturbance reaches first. */
export function selectPromotions(held, corridor, now) {
    const sideRank = { upstream: 0, downstream: 1, nearby: 2 };
    const candidates = [...held].flatMap(([because, trigger]) => now - trigger.at >= CORRIDOR.PROMOTE_HOLD_S ? [] : (corridor.get(because) ?? []).filter((n) => n.uid !== because && n.hops <= CORRIDOR.PROMOTE_HOPS).map((n) => ({ uid: n.uid, because, reason: trigger.reason, strength: trigger.strength, hops: n.hops, side: sideRank[n.side], distance: n.length_m })));
    candidates.sort((a, b) => a.hops - b.hops || b.strength - a.strength || a.side - b.side || a.distance - b.distance || a.uid - b.uid || a.because - b.because);
    const unique = new Map();
    for (const { uid, because, reason } of candidates) {
        if (!unique.has(uid))
            unique.set(uid, { uid, because, reason });
        if (unique.size >= CORRIDOR.PROMOTE_MAX)
            break;
    }
    return [...unique.values()];
}
//# sourceMappingURL=corridor.js.map