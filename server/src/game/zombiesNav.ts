import { MapObjectDefs } from "../../../shared/defs/register.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { coldet, type Collider } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import type { Building } from "./objects/building.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import type { Structure } from "./objects/structure.ts";

export type NavKind = "open" | "hull" | "corner" | "door" | "window" | "stair" | "interior";

export type NavigationResult =
    | "success"
    | "unreachable"
    | "blocked"
    | "invalid_start"
    | "invalid_goal";

export interface CandidateGoalReport {
    id: number;
    kind: string;
    pos: Vec2;
    dist: number;
    rejectionReason: string;
}

export interface DetailedPathResult {
    result: NavigationResult;
    path: Vec2[];
    failureReason: string;
    approachPos?: Vec2 | null;
    candidatesConsidered?: CandidateGoalReport[];
}

export interface NavNode {
    id: number;
    pos: Vec2;
    layer: number;
    kind: NavKind;
    buildingId?: number;
    obstacleId?: number;
    neighbors: number[];
    costs: number[];
}

export type NavAabb = { min: Vec2; max: Vec2 };

/**
 * Physical navigation radius accounting for the zombie's actual collision collider (rad = 1.0)
 * plus a 0.15u safety buffer to prevent physics boundary friction and corner scraping.
 */
export const ZombieNavRadius = 1.15;

const HashCell = 10;
const GridStep = 14;
const LinkRadius = 18;
const StairLinkRadius = 42;
const MaxExtraLinks = 10;
const InteriorGridStep = 1.6;
const PathNearbyRadius = 24;
const PathNearbyStairRadius = 28;

function hashKey(cx: number, cy: number): number {
    return (((cx + 4096) & 0xffff) << 16) | ((cy + 4096) & 0xffff);
}

function toAabb(o: Obstacle): NavAabb {
    const box = collider.toAabb(o.collider);
    return { min: box.min, max: box.max };
}

function expandAabb(aabb: NavAabb, pad: number): NavAabb {
    return {
        min: v2.create(aabb.min.x - pad, aabb.min.y - pad),
        max: v2.create(aabb.max.x + pad, aabb.max.y + pad),
    };
}

function periLen(aabb: NavAabb): number {
    return 2 * (aabb.max.x - aabb.min.x + (aabb.max.y - aabb.min.y));
}

function periPoint(t: number, aabb: NavAabb): Vec2 {
    const w = aabb.max.x - aabb.min.x;
    const h = aabb.max.y - aabb.min.y;
    const peri = Math.max(periLen(aabb), 0.001);
    let s = t % peri;
    if (s < 0) s += peri;
    if (s <= w) return v2.create(aabb.min.x + s, aabb.min.y);
    s -= w;
    if (s <= h) return v2.create(aabb.max.x, aabb.min.y + s);
    s -= h;
    if (s <= w) return v2.create(aabb.max.x - s, aabb.max.y);
    s -= w;
    return v2.create(aabb.min.x, aabb.max.y - s);
}

export function buildingHull(building: Building): NavAabb | undefined {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;

    for (let i = 0; i < building.zoomRegions.length; i++) {
        const zoomIn = building.zoomRegions[i].zoomIn;
        if (zoomIn) {
            minX = Math.min(minX, zoomIn.min.x);
            minY = Math.min(minY, zoomIn.min.y);
            maxX = Math.max(maxX, zoomIn.max.x);
            maxY = Math.max(maxY, zoomIn.max.y);
            found = true;
        }
    }
    if (!found) return undefined;
    return { min: v2.create(minX, minY), max: v2.create(maxX, maxY) };
}

export function navSolid(o: Obstacle, ignoreDoors: boolean): boolean {
    if (!o.active || o.dead || !o.collidable) return false;
    // Unlocked usable doors count as passable when planning graph routes
    if (ignoreDoors && o.isDoor && !o.door?.locked && o.door?.canUse) return false;
    return true;
}

/**
 * Closed-form analytical swept-capsule collision check against all collidable obstacles in the layer.
 * A path is valid only when the entire physical zombie circle collider can traverse it without clipping.
 */
export function isCapsuleClear(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
    rad = ZombieNavRadius,
    ignoreDoors = false,
): boolean {
    const minX = Math.min(from.x, to.x) - rad;
    const maxX = Math.max(from.x, to.x) + rad;
    const minY = Math.min(from.y, to.y) - rad;
    const maxY = Math.max(from.y, to.y) + rad;

    const bounds = collider.createAabb(v2.create(minX, minY), v2.create(maxX, maxY));
    const objs = game.grid.intersectCollider(bounds);

    const delta = v2.sub(to, from);
    const lenSq = v2.lengthSqr(delta);

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!o.active || o.dead || !o.collidable) continue;
        if (!util.sameLayer(o.layer, layer)) continue;

        const isBarricade = !!o.isBarricade;
        if (o.isDoor || isBarricade) {
            if (ignoreDoors) {
                if (isBarricade) continue;
                if (!o.door?.locked && o.door?.canUse) continue;
            }
        }

        const col = o.collider;
        if (col.type === collider.Type.Circle) {
            const C = col.pos;
            let t = 0;
            if (lenSq > 1e-6) {
                t = math.clamp(((C.x - from.x) * delta.x + (C.y - from.y) * delta.y) / lenSq, 0, 1);
            }
            const px = from.x + t * delta.x;
            const py = from.y + t * delta.y;
            const distSq = (C.x - px) * (C.x - px) + (C.y - py) * (C.y - py);
            const totalR = col.rad + rad;
            if (distSq < totalR * totalR) {
                return false;
            }
        } else if (col.type === collider.Type.Aabb) {
            const min = col.min;
            const max = col.max;

            // 1. Check endpoints inside expanded Minkowski sum
            if (coldet.testCircleAabb(from, rad, min, max)) return false;
            if (coldet.testCircleAabb(to, rad, min, max)) return false;

            if (lenSq > 1e-6) {
                // 2. Horizontal expanded rectangle
                const r1Min = v2.create(min.x - rad, min.y);
                const r1Max = v2.create(max.x + rad, max.y);
                if (coldet.intersectSegmentAabb(from, to, r1Min, r1Max)) return false;

                // 3. Vertical expanded rectangle
                const r2Min = v2.create(min.x, min.y - rad);
                const r2Max = v2.create(max.x, max.y + rad);
                if (coldet.intersectSegmentAabb(from, to, r2Min, r2Max)) return false;

                // 4. Four corner rounded vertices of Minkowski sum
                const radSq = rad * rad;
                const corners = [
                    v2.create(min.x, min.y),
                    v2.create(max.x, min.y),
                    v2.create(max.x, max.y),
                    v2.create(min.x, max.y),
                ];
                for (let c = 0; c < 4; c++) {
                    const corner = corners[c];
                    const t = math.clamp(
                        ((corner.x - from.x) * delta.x + (corner.y - from.y) * delta.y) / lenSq,
                        0,
                        1,
                    );
                    const px = from.x + t * delta.x;
                    const py = from.y + t * delta.y;
                    const dSq = (corner.x - px) * (corner.x - px) + (corner.y - py) * (corner.y - py);
                    if (dSq < radSq) return false;
                }
            }
        }
    }

    return true;
}

export function pointClear(game: Game, pos: Vec2, layer: number, rad = ZombieNavRadius, ignoreDoors = true): boolean {
    return isCapsuleClear(game, pos, pos, layer, rad, ignoreDoors);
}

export function isWalkClear(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
    rad = ZombieNavRadius,
    ignoreDoors = true,
): boolean {
    return isCapsuleClear(game, from, to, layer, rad, ignoreDoors);
}

function isPointInsideCollider(col: Collider, pt: Vec2): boolean {
    if (col.type === collider.Type.Aabb) {
        return pt.x >= col.min.x && pt.x <= col.max.x && pt.y >= col.min.y && pt.y <= col.max.y;
    }
    return v2.distance(pt, col.pos) <= col.rad;
}

export function isSeparatedByWall(game: Game, from: Vec2, to: Vec2, layer: number): boolean {
    const objs = game.grid.intersectLineSegment(from, to);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!o.active || o.dead || !o.collidable || !util.sameLayer(o.layer, layer)) continue;
        // Unlocked usable doors do not separate regions (zombies can open them)
        if (o.isDoor && !o.door?.locked && o.door?.canUse) continue;
        // Breakable barricades do not permanently separate regions (zombies can break them)
        if (o.isBarricade) continue;
        // Only solid walls or locked doors count as separating barriers
        const isWallBarrier = o.isWall || o.type.includes("wall") || (o.isDoor && (o.door?.locked || !o.door?.canUse));
        if (!isWallBarrier) continue;

        if (o.collider.type === collider.Type.Aabb) {
            const min = o.collider.min;
            const max = o.collider.max;
            if (!coldet.intersectSegmentAabb(from, to, min, max)) continue;

            // Check if segment truly crosses the wall from one side to the other,
            // or if the midpoint penetrates inside the solid wall
            const crossesX = (from.x <= min.x + 1e-4 && to.x >= max.x - 1e-4)
                || (from.x >= max.x - 1e-4 && to.x <= min.x + 1e-4);
            const crossesY = (from.y <= min.y + 1e-4 && to.y >= max.y - 1e-4)
                || (from.y >= max.y - 1e-4 && to.y <= min.y + 1e-4);
            const mid = v2.mul(v2.add(from, to), 0.5);
            const midInside = mid.x > min.x && mid.x < max.x && mid.y > min.y && mid.y < max.y;

            if (crossesX || crossesY || midInside) {
                return true;
            }
        } else {
            if (collider.intersectSegment(o.collider, from, to)) {
                return true;
            }
        }
    }
    return false;
}

export function isLineClear(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
    ignoreDoors = true,
): boolean {
    const objs = game.grid.intersectLineSegment(from, to);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!o.active || o.dead || !o.collidable || !util.sameLayer(o.layer, layer)) continue;
        if (o.isDoor) {
            if (ignoreDoors) {
                if (!o.door?.locked && o.door?.canUse) continue;
            }
        }
        if (collider.intersectSegment(o.collider, from, to)) {
            return false;
        }
    }
    return true;
}

export function getBuildingAt(game: Game, pos: Vec2): Building | undefined {
    const buildings = game.map.buildings;
    // 1. Zoom regions check with radius tolerance (1.2u for player collider boundary)
    for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        for (let j = 0; j < b.zoomRegions.length; j++) {
            const z = b.zoomRegions[j].zoomIn;
            if (z && (coldet.testPointAabb(pos, z.min, z.max) || coldet.testCircleAabb(pos, 1.2, z.min, z.max))) {
                return b;
            }
        }
    }
    // 2. Footprint / hull fallback
    for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        const hull = buildingHull(b);
        if (hull && coldet.testPointAabb(pos, hull.min, hull.max)) {
            const ground = util.toGroundLayer(b.layer);
            if (!isSeparatedByWall(game, pos, b.pos, ground)) {
                return b;
            }
        }
    }
    return undefined;
}

/**
 * Generates a physically reachable melee approach position for pursuit.
 * Selects a position within valid melee attack range from which the zombie collider
 * can occupy without clipping walls/obstacles and has unobstructed line-of-sight to the target.
 */
export function getReachableMeleeApproach(
    game: Game,
    targetPos: Vec2,
    fromPos: Vec2,
    layer: number,
    targetBuilding?: Building,
    zombieRad = ZombieNavRadius,
): Vec2 | null {
    const targetB = targetBuilding ?? getBuildingAt(game, targetPos);

    // If target position itself already has full physical clearance for the zombie,
    // targetPos itself is the ideal navigation destination (no offset needed).
    if (pointClear(game, targetPos, layer, zombieRad, false)) {
        return targetPos;
    }

    // Direction from target towards zombie (prefer approach on zombie's incoming side)
    const toZombie = v2.sub(fromPos, targetPos);
    const baseAngle = v2.length(toZombie) > 0.01 ? Math.atan2(toZombie.y, toZombie.x) : 0;

    // Distances to test: melee attack range is ~2.5 - 2.8u; zombie radius is 1.15u, player radius 1.0u
    const distances = [1.8, 2.1, 2.4, 2.7, 1.5];

    // 16 radial directions around target, sorted starting from facing the zombie
    const angleOffsets: number[] = [0];
    for (let step = 1; step <= 8; step++) {
        const offset = (step * Math.PI) / 8;
        angleOffsets.push(offset);
        if (step < 8) angleOffsets.push(-offset);
    }

    for (let d = 0; d < distances.length; d++) {
        const dist = distances[d];
        for (let a = 0; a < angleOffsets.length; a++) {
            const angle = baseAngle + angleOffsets[a];
            const pt = v2.add(targetPos, v2.mul(v2.create(Math.cos(angle), Math.sin(angle)), dist));
            game.map.clampToMapBounds(pt, 2);

            // 1. Must match target's building / room classification
            if (targetB) {
                const ptB = getBuildingAt(game, pt);
                if (ptB?.__id !== targetB.__id) continue;
            } else {
                const ptB = getBuildingAt(game, pt);
                if (ptB !== undefined) continue;
            }

            // 2. Must not be separated from target by a solid wall
            if (isSeparatedByWall(game, pt, targetPos, layer)) continue;

            // 3. Zombie physical collider must be able to occupy pt without clipping
            if (!pointClear(game, pt, layer, zombieRad, false)) continue;

            // 4. Must have unobstructed attack contact to target
            if (!isLineClear(game, pt, targetPos, layer, false)) continue;

            return pt;
        }
    }

    return null;
}

export function inferGroundLayer(game: Game, pos: Vec2, fallback: number): number {
    const b = getBuildingAt(game, pos);
    if (b) return util.toGroundLayer(b.layer);
    return util.toGroundLayer(fallback);
}

export function navGroundLayer(layer: number): number {
    return util.toGroundLayer(layer);
}

type NavStair = Structure["stairs"][number];

export function stairAtPos(
    game: Game,
    pos: Vec2,
    rad = ZombieNavRadius,
): { stair: NavStair; structure: Structure } | undefined {
    const objs = game.grid.intersectCollider(collider.createCircle(pos, rad));
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Structure) continue;
        const structure = obj as Structure;
        for (let j = 0; j < structure.stairs.length; j++) {
            const stair = structure.stairs[j];
            if (stair.lootOnly) continue;
            if (coldet.testCircleAabb(pos, rad, stair.collision.min, stair.collision.max)) {
                return { stair, structure };
            }
        }
    }
    return undefined;
}

export function doorNormal(door: Obstacle): Vec2 {
    const ori = door.door?.closedOri ?? door.ori;
    return v2.rotate(v2.create(1, 0), math.oriToRad(ori));
}

export function getDoorwayCenter(door: Obstacle): Vec2 {
    if (!door.door) return v2.copy(door.pos);
    const def = MapObjectDefs.typeToDef(door.type, "obstacle");
    if (!def?.collision) return v2.copy(door.pos);
    const closedOri = door.door.closedOri ?? door.ori;
    const closedRot = math.oriToRad(closedOri);
    const closedColl = collider.transform(def.collision, door.pos, closedRot, door.scale);
    const aabb = collider.toAabb(closedColl);
    return v2.mul(v2.add(aabb.min, aabb.max), 0.5);
}

function aabbCenter(aabb: NavAabb): Vec2 {
    return v2.create(
        (aabb.min.x + aabb.max.x) * 0.5,
        (aabb.min.y + aabb.max.y) * 0.5,
    );
}

class MinHeap {
    data: Array<{ id: number; f: number }> = [];

    push(id: number, f: number): void {
        this.data.push({ id, f });
        this.siftUp(this.data.length - 1);
    }

    pop(): number | undefined {
        if (!this.data.length) return undefined;
        const id = this.data[0].id;
        const last = this.data.pop()!;
        if (this.data.length) {
            this.data[0] = last;
            this.siftDown(0);
        }
        return id;
    }

    private siftUp(i: number): void {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].f <= this.data[i].f) break;
            const tmp = this.data[p];
            this.data[p] = this.data[i];
            this.data[i] = tmp;
            i = p;
        }
    }

    private siftDown(i: number): void {
        const n = this.data.length;
        while (true) {
            let s = i;
            const l = i * 2 + 1;
            const r = l + 1;
            if (l < n && this.data[l].f < this.data[s].f) s = l;
            if (r < n && this.data[r].f < this.data[s].f) s = r;
            if (s === i) break;
            const tmp = this.data[s];
            this.data[s] = this.data[i];
            this.data[i] = tmp;
            i = s;
        }
    }
}

/**
 * Server-authoritative Navigation Graph for Zombies AI.
 * Built once with verified collision clearance for all nodes and edges.
 */
export class MapNavGraph {
    readonly nodes: NavNode[] = [];
    private cells = new Map<number, number[]>();
    private pathCache = new Map<string, Vec2[] | null>();
    lastFailureReason = "none";

    lastCandidateGoalReports: CandidateGoalReport[] = [];

    static build(game: Game): MapNavGraph {
        const graph = new MapNavGraph();
        graph.sample(game);
        graph.link(game);
        graph.linkStairLandings(game);
        return graph;
    }

    invalidateCache(): void {
        this.pathCache.clear();
    }

    firstWaypoint(from: Player, goal: Vec2): Vec2 | undefined {
        const fromLayer = navGroundLayer(from.layer);
        const toLayer = inferGroundLayer(from.game, goal, from.layer);
        const path = this.path(from.game, from.pos, goal, fromLayer, toLayer, from.layer);
        if (!path?.length) return undefined;
        for (let i = 0; i < path.length; i++) {
            if (v2.distance(from.pos, path[i]) > 1.8) return path[i];
        }
        return path[path.length - 1];
    }

    hasPath(from: Player, goal: Vec2): boolean {
        const fromLayer = navGroundLayer(from.layer);
        const toLayer = inferGroundLayer(from.game, goal, from.layer);
        const path = this.path(from.game, from.pos, goal, fromLayer, toLayer, from.layer);
        return !!path && path.length > 0;
    }

    findDetailedPath(
        game: Game,
        from: Vec2,
        to: Vec2,
        fromLayer: number,
        toLayer: number,
        rawLayer = fromLayer,
        edgePenalties?: Map<string, number>,
        approachPos?: Vec2 | null,
    ): DetailedPathResult {
        const waypoints = this.path(game, from, to, fromLayer, toLayer, rawLayer, edgePenalties, approachPos);
        const candidates = this.lastCandidateGoalReports;

        if (waypoints && waypoints.length > 0) {
            return {
                result: "success",
                path: waypoints,
                failureReason: "none",
                approachPos,
                candidatesConsidered: candidates,
            };
        }

        let result: NavigationResult = "unreachable";
        if (this.lastFailureReason === "no_start_nodes") {
            result = "invalid_start";
        } else if (this.lastFailureReason === "no_end_nodes") {
            result = "invalid_goal";
        } else if (this.lastFailureReason === "all_doors_impassable") {
            result = "blocked";
        }

        return {
            result,
            path: [],
            failureReason: this.lastFailureReason,
            approachPos,
            candidatesConsidered: candidates,
        };
    }

    path(
        game: Game,
        from: Vec2,
        to: Vec2,
        fromLayer: number,
        toLayer: number,
        rawLayer = fromLayer,
        edgePenalties?: Map<string, number>,
        approachPos?: Vec2 | null,
    ): Vec2[] | null {
        const effectiveGoal = approachPos ?? to;
        const hasPenalties = edgePenalties !== undefined && edgePenalties.size > 0;
        const cacheKey = this.cacheKey(from, effectiveGoal, fromLayer, toLayer);
        if (!hasPenalties) {
            const cached = this.pathCache.get(cacheKey);
            if (cached !== undefined) return cached;
        }

        const targetBuilding = getBuildingAt(game, to) ?? getBuildingAt(game, effectiveGoal);
        const startBuilding = getBuildingAt(game, from);

        // Immediate direct clear line check if in same environment and ground layer
        // Note: ignoreDoors is false so closed doors force proper doorway navigation
        if (
            fromLayer === toLayer
            && targetBuilding === startBuilding
            && isCapsuleClear(game, from, effectiveGoal, fromLayer, ZombieNavRadius, false)
        ) {
            const direct = [v2.copy(effectiveGoal)];
            if (!hasPenalties) this.remember(cacheKey, direct);
            return direct;
        }

        this.lastFailureReason = "none";

        const onStair = rawLayer >= 2 || !!stairAtPos(game, from, 0.65);
        const startRadius = onStair ? PathNearbyStairRadius : PathNearbyRadius;

        const starts = this.findValidStarts(game, from, fromLayer, startRadius, onStair, startBuilding?.__id);
        const endsResult = this.findValidEnds(game, to, toLayer, PathNearbyRadius, targetBuilding?.__id, approachPos);
        const ends = endsResult.ends;
        this.lastCandidateGoalReports = endsResult.candidates;

        if (!starts.length) {
            this.lastFailureReason = "no_start_nodes";
            if (!hasPenalties) this.remember(cacheKey, null);
            return null;
        }
        if (!ends.length) {
            this.lastFailureReason = "no_end_nodes";
            if (!hasPenalties) this.remember(cacheKey, null);
            return null;
        }

        const endSet = new Set<number>();
        for (let i = 0; i < ends.length; i++) endSet.add(ends[i].id);

        const gScore = new Map<number, number>();
        const came = new Map<number, number>();
        const heap = new MinHeap();
        const closed = new Set<number>();

        for (let i = 0; i < starts.length; i++) {
            const node = starts[i];
            const g = v2.distance(from, node.pos);
            const layerPenalty = node.layer === toLayer ? 0 : (node.kind === "stair" ? 4 : 10);
            gScore.set(node.id, g);
            heap.push(node.id, g + v2.distance(node.pos, effectiveGoal) + layerPenalty);
        }

        let found: number | undefined;
        let blockedByLockedDoor = false;

        while (true) {
            const id = heap.pop();
            if (id === undefined) break;
            if (closed.has(id)) continue;
            closed.add(id);
            if (endSet.has(id)) {
                found = id;
                break;
            }
            const node = this.nodes[id];
            const g = gScore.get(id) ?? Infinity;
            for (let i = 0; i < node.neighbors.length; i++) {
                const nid = node.neighbors[i];
                if (closed.has(nid)) continue;

                const next = this.nodes[nid];

                // Check door / barricade edge traversability and costs
                let doorCostPenalty = 0;
                const obsId = next.obstacleId ?? (next.kind === "door" ? node.obstacleId : undefined);
                if (obsId !== undefined) {
                    const obs = game.objectRegister.getById(obsId) as Obstacle | undefined;
                    if (obs && !obs.dead) {
                        const isBarricade = !!obs.isBarricade;
                        if (obs.isDoor && obs.door) {
                            if (obs.door.locked) {
                                if (isBarricade) {
                                    doorCostPenalty = 35.0; // Breakable locked door / barricade
                                } else {
                                    blockedByLockedDoor = true;
                                    continue; // Impassable unbreakable locked door
                                }
                            } else if (!obs.door.open) {
                                doorCostPenalty = 3.0; // Closed, unlocked door (openable by zombie)
                            }
                        } else if (isBarricade) {
                            doorCostPenalty = 35.0; // Standalone breakable barricade
                        }
                    }
                }

                // Apply dynamic edge penalty for stuck recovery
                const edgeKey = node.id < nid ? `${node.id}->${nid}` : `${nid}->${node.id}`;
                const penalty = edgePenalties?.get(edgeKey) ?? 0;

                const ng = g + node.costs[i] + penalty + doorCostPenalty;
                if (ng >= (gScore.get(nid) ?? Infinity)) continue;
                gScore.set(nid, ng);
                came.set(nid, id);
                const layerPenalty = next.layer === toLayer ? 0 : (next.kind === "stair" ? 4 : 10);
                heap.push(nid, ng + v2.distance(next.pos, effectiveGoal) + layerPenalty);
            }
        }

        if (found === undefined) {
            this.lastFailureReason = blockedByLockedDoor
                ? "all_doors_impassable"
                : (hasPenalties ? "path_penalized_exhaustion" : "disconnected_subgraph");
            if (!hasPenalties) this.remember(cacheKey, null);
            return null;
        }

        const ids: number[] = [];
        let cur: number | undefined = found;
        while (cur !== undefined) {
            ids.push(cur);
            cur = came.get(cur);
        }
        ids.reverse();

        const out: Vec2[] = [];
        for (let i = 0; i < ids.length; i++) {
            const pos = this.nodes[ids[i]].pos;
            if (out.length && v2.distance(out[out.length - 1], pos) < 0.6) continue;
            out.push(pos);
        }

        // Connect from final node to effectiveGoal
        const lastPos = out[out.length - 1];
        if (lastPos && v2.distance(lastPos, effectiveGoal) > 0.6) {
            out.push(v2.copy(effectiveGoal));
        }

        if (!hasPenalties) this.remember(cacheKey, out);
        return out;
    }

    private findValidStarts(
        game: Game,
        from: Vec2,
        layer: number,
        radius: number,
        onStair: boolean,
        buildingId?: number,
    ): NavNode[] {
        const raw = this.nearby(from, layer, radius, onStair, buildingId);
        const valid: NavNode[] = [];

        for (let i = 0; i < raw.length; i++) {
            const n = raw[i];
            if (buildingId === undefined && n.kind === "interior") continue;
            if (buildingId !== undefined && (n.kind === "open" || n.kind === "hull")) continue;

            // Reject any node that is separated from 'from' by a solid wall or locked door
            if (isSeparatedByWall(game, from, n.pos, layer)) continue;

            const dist = v2.distance(from, n.pos);
            const clearWide = isCapsuleClear(game, from, n.pos, layer, ZombieNavRadius, true);
            if (clearWide) {
                valid.push(n);
            }
        }

        // Fallback: If no candidate had strict capsule clearance, fallback to relaxed clearance or close clear line
        if (!valid.length) {
            for (let i = 0; i < raw.length; i++) {
                const n = raw[i];
                if (buildingId === undefined && n.kind === "interior") continue;
                if (buildingId !== undefined && (n.kind === "open" || n.kind === "hull")) continue;
                if (isSeparatedByWall(game, from, n.pos, layer)) continue;

                const dist = v2.distance(from, n.pos);
                if (
                    isCapsuleClear(game, from, n.pos, layer, 0.75, true)
                    || isCapsuleClear(game, from, n.pos, layer, 0.35, true)
                    || (dist < 2.5 && isLineClear(game, from, n.pos, layer, true))
                    || (onStair && n.kind === "stair")
                ) {
                    valid.push(n);
                }
            }
        }

        return valid;
    }

    private findValidEnds(
        game: Game,
        to: Vec2,
        layer: number,
        radius: number,
        buildingId?: number,
        approachPos?: Vec2 | null,
    ): { ends: NavNode[]; candidates: CandidateGoalReport[] } {
        const effectiveGoal = approachPos ?? to;
        const candidates: CandidateGoalReport[] = [];
        const seen = new Set<number>();
        const candidateNodes: NavNode[] = [];

        // 1. Collect candidates around effectiveGoal and to
        const poolA = this.nearby(effectiveGoal, layer, radius, false, buildingId);
        for (let i = 0; i < poolA.length; i++) {
            if (!seen.has(poolA[i].id)) {
                seen.add(poolA[i].id);
                candidateNodes.push(poolA[i]);
            }
        }
        if (approachPos && v2.distance(approachPos, to) > 0.5) {
            const poolB = this.nearby(to, layer, radius, false, buildingId);
            for (let i = 0; i < poolB.length; i++) {
                if (!seen.has(poolB[i].id)) {
                    seen.add(poolB[i].id);
                    candidateNodes.push(poolB[i]);
                }
            }
        }

        const valid: NavNode[] = [];

        for (let i = 0; i < candidateNodes.length; i++) {
            const n = candidateNodes[i];
            const dist = v2.distance(n.pos, effectiveGoal);
            let rejectionReason = "";

            // Check 1: Map layer match
            if (n.layer !== layer) {
                rejectionReason = "layer_mismatch";
            }
            // Check 2: Room / building connectivity
            else if (buildingId !== undefined) {
                if (n.kind === "open" || n.kind === "hull") {
                    rejectionReason = "exterior_node_for_indoor_target";
                } else if (n.buildingId !== undefined && n.buildingId !== buildingId && n.kind !== "door") {
                    rejectionReason = "different_building";
                }
            } else if (buildingId === undefined && n.kind === "interior") {
                rejectionReason = "interior_node_for_outdoor_target";
            }

            // Check 3: Physical collision clearance at the node position
            if (!rejectionReason) {
                const ignoreDoors = n.kind === "door";
                if (!pointClear(game, n.pos, layer, ZombieNavRadius, ignoreDoors)) {
                    rejectionReason = "node_clearance_blocked";
                }
            }

            // Check 4: Wall separation from effectiveGoal (or to)
            if (!rejectionReason) {
                if (isSeparatedByWall(game, n.pos, effectiveGoal, layer) || isSeparatedByWall(game, n.pos, to, layer)) {
                    rejectionReason = "separated_by_wall";
                }
            }

            // Check 5: Valid traversable connection to effectiveGoal
            if (!rejectionReason) {
                const clearWide = isCapsuleClear(game, n.pos, effectiveGoal, layer, ZombieNavRadius, true);
                if (clearWide) {
                    rejectionReason = "accepted";
                    valid.push(n);
                } else {
                    const clearMid = isCapsuleClear(game, n.pos, effectiveGoal, layer, 0.75, true);
                    const clearNarrow = isCapsuleClear(game, n.pos, effectiveGoal, layer, 0.35, true);
                    if (clearMid || clearNarrow || dist < 2.5) {
                        rejectionReason = "accepted_relaxed";
                    } else {
                        rejectionReason = "no_clear_path_to_goal";
                    }
                }
            }

            candidates.push({
                id: n.id,
                kind: n.kind,
                pos: v2.copy(n.pos),
                dist,
                rejectionReason,
            });
        }

        // Fallback: If no candidate passed strict capsule check, accept candidates that are in the same room/environment and not separated by a wall
        if (!valid.length) {
            for (let i = 0; i < candidates.length; i++) {
                const report = candidates[i];
                if (report.rejectionReason === "accepted_relaxed" || report.rejectionReason === "no_clear_path_to_goal") {
                    const n = this.nodes[report.id];
                    valid.push(n);
                    break;
                }
            }
        }

        return { ends: valid, candidates };
    }

    private sample(game: Game): void {
        this.sampleGrid(game);
        this.sampleObstacles(game);
        this.sampleBuildings(game);
        this.sampleStairs(game);
    }

    private sampleGrid(game: Game): void {
        const inset = Math.max(game.map.shoreInset + 4, 8);
        const x0 = inset;
        const y0 = inset;
        const x1 = game.map.width - inset;
        const y1 = game.map.height - inset;
        for (let x = x0; x <= x1; x += GridStep) {
            for (let y = y0; y <= y1; y += GridStep) {
                const pos = v2.create(x, y);
                if (game.map.isOnWater(pos, 0)) continue;
                if (!pointClear(game, pos, 0, ZombieNavRadius, true)) continue;
                this.addNode(pos, 0, "open");
            }
        }
    }

    private sampleObstacles(game: Game): void {
        const obstacles = game.map.obstacles;
        const cornerPad = ZombieNavRadius + 0.35; // 1.5u clearance from obstacle vertex

        for (let i = 0; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (!o.active || o.dead || !o.collidable) continue;
            if (o.parentBuilding) continue;
            if (o.isBarricade) {
                this.addBarricade(game, o);
                continue;
            }
            if (o.isDoor || o.isWindow) continue;

            const layer = util.toGroundLayer(o.layer);
            const box = toAabb(o);
            const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
            if (span < 1.0) continue;

            const corners = [
                v2.create(box.min.x - cornerPad, box.min.y - cornerPad),
                v2.create(box.max.x + cornerPad, box.min.y - cornerPad),
                v2.create(box.max.x + cornerPad, box.max.y + cornerPad),
                v2.create(box.min.x - cornerPad, box.max.y + cornerPad),
            ];

            const cornerIds: number[] = [];
            for (let c = 0; c < 4; c++) {
                const pt = corners[c];
                game.map.clampToMapBounds(pt, 4);
                if (game.map.isOnWater(pt, layer)) continue;
                if (!pointClear(game, pt, layer, ZombieNavRadius, true)) continue;
                cornerIds.push(this.addNode(pt, layer, "corner"));
            }

            // Link accessible convex corners around obstacle
            if (cornerIds.length >= 2) {
                for (let a = 0; a < cornerIds.length; a++) {
                    for (let b = a + 1; b < cornerIds.length; b++) {
                        const na = this.nodes[cornerIds[a]];
                        const nb = this.nodes[cornerIds[b]];
                        const dist = v2.distance(na.pos, nb.pos);
                        if (dist > span + 4.5) continue;
                        if (isCapsuleClear(game, na.pos, nb.pos, layer, ZombieNavRadius, true)) {
                            this.linkBoth(na.id, nb.id, dist);
                        }
                    }
                }
            }
        }
    }

    private sampleBuildings(game: Game): void {
        const buildings = game.map.buildings;
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            const hull = buildingHull(building);
            if (!hull) continue;
            const layer = util.toGroundLayer(building.layer);

            // Exterior perimeter hull nodes
            const ring = expandAabb(hull, ZombieNavRadius + 1.2);
            const peri = periLen(ring);
            const step = 8;
            const count = Math.max(4, Math.round(peri / step));
            const hullIds: number[] = [];
            for (let s = 0; s < count; s++) {
                const pos = periPoint((s / count) * peri, ring);
                game.map.clampToMapBounds(pos, 4);
                if (!pointClear(game, pos, layer, ZombieNavRadius, true)) continue;
                hullIds.push(this.addNode(pos, layer, "hull"));
            }

            // Link exterior hull perimeter
            for (let h = 0; h < hullIds.length; h++) {
                const a = hullIds[h];
                const b = hullIds[(h + 1) % hullIds.length];
                const na = this.nodes[a];
                const nb = this.nodes[b];
                const dist = v2.distance(na.pos, nb.pos);
                if (isCapsuleClear(game, na.pos, nb.pos, layer, ZombieNavRadius, true)) {
                    this.linkBoth(a, b, dist);
                }
            }

            // Dense interior room and corridor sampling
            const interiorIds = this.sampleBuildingInterior(game, building, layer);

            // Door portals and approach pairs (including breakable barricades)
            const doorPairs: Array<{ outside: number; portal: number; inside: number }> = [];
            for (let j = 0; j < building.childObjects.length; j++) {
                const child = building.childObjects[j];
                if (child.__type !== ObjectType.Obstacle) continue;
                const o = child as Obstacle;
                if (o.dead) continue;
                if ((o.isDoor && o.door) || o.isBarricade) {
                    const pair = this.addDoorPair(game, o, building, layer);
                    doorPairs.push(pair);
                }
            }

            // Link BOTH stances of every door to interior nodes, hull nodes, and sibling door stances
            for (let d = 0; d < doorPairs.length; d++) {
                const pair = doorPairs[d];
                const stances = [this.nodes[pair.outside], this.nodes[pair.inside]];

                for (let s = 0; s < stances.length; s++) {
                    const stance = stances[s];

                    // 1. Link to clear interior nodes within range
                    for (let k = 0; k < interiorIds.length; k++) {
                        const intNode = this.nodes[interiorIds[k]];
                        const dist = v2.distance(stance.pos, intNode.pos);
                        if (dist > 12.0) continue;
                        if (isCapsuleClear(game, stance.pos, intNode.pos, layer, ZombieNavRadius, true)) {
                            this.linkBoth(stance.id, intNode.id, dist);
                        }
                    }

                    // 2. Link to clear exterior hull nodes within range
                    for (let h = 0; h < hullIds.length; h++) {
                        const hullNode = this.nodes[hullIds[h]];
                        const dist = v2.distance(stance.pos, hullNode.pos);
                        if (dist > 14.0) continue;
                        if (isCapsuleClear(game, stance.pos, hullNode.pos, layer, ZombieNavRadius, true)) {
                            this.linkBoth(stance.id, hullNode.id, dist);
                        }
                    }

                    // 3. Link to sibling door stances in the same room/corridor within range
                    for (let other = d + 1; other < doorPairs.length; other++) {
                        const otherPair = doorPairs[other];
                        const otherStances = [this.nodes[otherPair.outside], this.nodes[otherPair.inside]];
                        for (let os = 0; os < otherStances.length; os++) {
                            const otherStance = otherStances[os];
                            const dist = v2.distance(stance.pos, otherStance.pos);
                            if (dist > 10.0) continue;
                            if (isCapsuleClear(game, stance.pos, otherStance.pos, layer, ZombieNavRadius, true)) {
                                this.linkBoth(stance.id, otherStance.id, dist);
                            }
                        }
                    }
                }
            }
        }
    }

    addBarricade(game: Game, barricade: Obstacle): { outside: number; portal: number; inside: number } {
        const layer = util.toGroundLayer(barricade.layer);
        const pair = this.addDoorPair(game, barricade, barricade.parentBuilding, layer);
        const stances = [this.nodes[pair.outside], this.nodes[pair.inside]];
        for (let s = 0; s < stances.length; s++) {
            const stance = stances[s];
            const nearby = this.nearby(stance.pos, layer, 12.0, false);
            for (let k = 0; k < nearby.length; k++) {
                const other = nearby[k];
                if (other.id === stance.id || other.id === pair.portal) continue;
                const dist = v2.distance(stance.pos, other.pos);
                if (isCapsuleClear(game, stance.pos, other.pos, layer, ZombieNavRadius, true)) {
                    this.linkBoth(stance.id, other.id, dist);
                }
            }
        }
        return pair;
    }

    private addDoorPair(
        game: Game,
        door: Obstacle,
        building: Building | undefined,
        layer: number,
    ): { outside: number; portal: number; inside: number } {
        const center = getDoorwayCenter(door);
        const n = doorNormal(door);
        const distA = this.findClearDoorStance(game, center, n, 2.5, layer);
        const distB = this.findClearDoorStance(game, center, v2.neg(n), 2.5, layer);

        // Determine which side is inside vs outside relative to building center (if in a building)
        let isAInside = true;
        if (building) {
            const toBuilding = v2.sub(building.pos, center);
            isAInside = v2.dot(n, toBuilding) >= 0;
        }

        const outsideDir = isAInside ? v2.neg(n) : n;
        const insideDir = isAInside ? n : v2.neg(n);
        const outsideDist = isAInside ? distB : distA;
        const insideDist = isAInside ? distA : distB;

        const outside = v2.add(center, v2.mul(outsideDir, outsideDist));
        const inside = v2.add(center, v2.mul(insideDir, insideDist));
        const portal = v2.copy(center);

        game.map.clampToMapBounds(outside, 4);
        game.map.clampToMapBounds(inside, 4);

        const a = this.addNode(outside, layer, "door", building?.__id, door.__id);
        const p = this.addNode(portal, layer, "door", building?.__id, door.__id);
        const b = this.addNode(inside, layer, "door", building?.__id, door.__id);

        this.linkBoth(a, p, v2.distance(outside, portal));
        this.linkBoth(p, b, v2.distance(portal, inside));
        // Note: Do NOT link outside stance (a) directly to inside stance (b).
        // Doorway traversal must strictly route through the doorframe portal (p).

        return { outside: a, portal: p, inside: b };
    }

    private findClearDoorStance(game: Game, doorPos: Vec2, dir: Vec2, baseDist: number, layer: number): number {
        for (let d = baseDist; d >= 1.6; d -= 0.3) {
            const pt = v2.add(doorPos, v2.mul(dir, d));
            if (pointClear(game, pt, layer, ZombieNavRadius, true)) return d;
        }
        for (let d = baseDist + 0.3; d <= 3.2; d += 0.3) {
            const pt = v2.add(doorPos, v2.mul(dir, d));
            if (pointClear(game, pt, layer, ZombieNavRadius, true)) return d;
        }
        return baseDist;
    }

    private sampleBuildingInterior(game: Game, building: Building, layer: number): number[] {
        const interiorIds: number[] = [];

        for (let r = 0; r < building.zoomRegions.length; r++) {
            const zoom = building.zoomRegions[r].zoomIn;
            if (!zoom) continue;
            const minX = zoom.min.x + ZombieNavRadius + 0.2;
            const maxX = zoom.max.x - ZombieNavRadius - 0.2;
            const minY = zoom.min.y + ZombieNavRadius + 0.2;
            const maxY = zoom.max.y - ZombieNavRadius - 0.2;

            // Also check center of zoom region
            const center = aabbCenter(zoom);
            if (pointClear(game, center, layer, ZombieNavRadius, true)) {
                interiorIds.push(this.addNode(center, layer, "interior", building.__id));
            }

            for (let x = minX; x <= maxX; x += InteriorGridStep) {
                for (let y = minY; y <= maxY; y += InteriorGridStep) {
                    const pos = v2.create(x, y);
                    if (!pointClear(game, pos, layer, ZombieNavRadius, true)) continue;
                    const id = this.addNode(pos, layer, "interior", building.__id);
                    interiorIds.push(id);
                }
            }
        }

        // Link interior nodes with capsule clearance
        for (let i = 0; i < interiorIds.length; i++) {
            const a = this.nodes[interiorIds[i]];
            for (let j = i + 1; j < interiorIds.length; j++) {
                const b = this.nodes[interiorIds[j]];
                const dist = v2.distance(a.pos, b.pos);
                if (dist > 5.8) continue;
                if (isCapsuleClear(game, a.pos, b.pos, layer, ZombieNavRadius, true)) {
                    this.linkBoth(a.id, b.id, dist);
                }
            }
        }

        return interiorIds;
    }

    private sampleStairs(game: Game): void {
        const structures = game.map.structures;
        for (let i = 0; i < structures.length; i++) {
            const structure = structures[i];
            const stairs = structure.stairs;
            const upLayer = util.toGroundLayer(structure.layer);
            const downLayer = upLayer ^ 1;
            for (let j = 0; j < stairs.length; j++) {
                const stair = stairs[j];
                if (stair.lootOnly) continue;
                const up = aabbCenter(stair.upAabb);
                const down = aabbCenter(stair.downAabb);
                game.map.clampToMapBounds(up, 4);
                game.map.clampToMapBounds(down, 4);
                const a = this.addNode(up, upLayer, "stair");
                const b = this.addNode(down, downLayer, "stair");
                this.linkBoth(a, b, v2.distance(up, down) + 2.0);

                const upApproach = v2.add(up, v2.mul(v2.neg(stair.downDir), 2.4));
                const downApproach = v2.add(down, v2.mul(stair.downDir, 2.4));
                game.map.clampToMapBounds(upApproach, 4);
                game.map.clampToMapBounds(downApproach, 4);
                if (pointClear(game, upApproach, upLayer, ZombieNavRadius, true)) {
                    const uid = this.addNode(upApproach, upLayer, "stair");
                    this.linkBoth(a, uid, v2.distance(up, upApproach) + 0.5);
                }
                if (pointClear(game, downApproach, downLayer, ZombieNavRadius, true)) {
                    const did = this.addNode(downApproach, downLayer, "stair");
                    this.linkBoth(b, did, v2.distance(down, downApproach) + 0.5);
                }
            }
        }
    }

    private linkStairLandings(game: Game): void {
        const stairIds: number[] = [];
        for (let i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i].kind === "stair") stairIds.push(i);
        }
        for (let s = 0; s < stairIds.length; s++) {
            const node = this.nodes[stairIds[s]];
            const nearby = this.nearby(node.pos, node.layer, StairLinkRadius);
            let linked = 0;
            for (let k = 0; k < nearby.length && linked < 12; k++) {
                const other = nearby[k];
                if (other.id === node.id || other.layer !== node.layer) continue;
                if (this.alreadyLinked(node.id, other.id)) continue;
                const dist = v2.distance(node.pos, other.pos);
                if (isCapsuleClear(game, node.pos, other.pos, node.layer, ZombieNavRadius, true)) {
                    this.linkBoth(node.id, other.id, dist);
                    linked++;
                }
            }
        }
    }

    private link(game: Game): void {
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (node.kind === "interior") continue; // Interiors linked during sampling

            const reach = Math.ceil(LinkRadius / HashCell);
            const cx = Math.floor(node.pos.x / HashCell);
            const cy = Math.floor(node.pos.y / HashCell);
            const extra: Array<{ id: number; dist: number }> = [];

            for (let dx = -reach; dx <= reach; dx++) {
                for (let dy = -reach; dy <= reach; dy++) {
                    const ids = this.cells.get(hashKey(cx + dx, cy + dy));
                    if (!ids) continue;
                    for (let k = 0; k < ids.length; k++) {
                        const oid = ids[k];
                        if (oid === node.id) continue;
                        const other = this.nodes[oid];
                        if (other.layer !== node.layer) continue;
                        const dist = v2.distance(node.pos, other.pos);
                        if (dist < 0.6 || dist > LinkRadius) continue;
                        extra.push({ id: oid, dist });
                    }
                }
            }

            extra.sort((a, b) => a.dist - b.dist);
            let linked = 0;
            for (let e = 0; e < extra.length && linked < MaxExtraLinks; e++) {
                const other = this.nodes[extra[e].id];
                if (this.alreadyLinked(node.id, other.id)) continue;
                if (isCapsuleClear(game, node.pos, other.pos, node.layer, ZombieNavRadius, true)) {
                    this.linkBoth(node.id, other.id, extra[e].dist);
                    linked++;
                }
            }
        }
    }

    private addNode(pos: Vec2, layer: number, kind: NavKind, buildingId?: number, obstacleId?: number): number {
        const id = this.nodes.length;
        this.nodes.push({
            id,
            pos: v2.copy(pos),
            layer,
            kind,
            buildingId,
            obstacleId,
            neighbors: [],
            costs: [],
        });
        const cx = Math.floor(pos.x / HashCell);
        const cy = Math.floor(pos.y / HashCell);
        const key = hashKey(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(id);
        else this.cells.set(key, [id]);
        return id;
    }

    private alreadyLinked(a: number, b: number): boolean {
        const n = this.nodes[a].neighbors;
        for (let i = 0; i < n.length; i++) {
            if (n[i] === b) return true;
        }
        return false;
    }

    private linkBoth(a: number, b: number, cost: number): void {
        if (a === b) return;
        if (!this.alreadyLinked(a, b)) {
            this.nodes[a].neighbors.push(b);
            this.nodes[a].costs.push(cost);
        }
        if (!this.alreadyLinked(b, a)) {
            this.nodes[b].neighbors.push(a);
            this.nodes[b].costs.push(cost);
        }
    }

    private nearby(
        pos: Vec2,
        layer: number,
        maxDist: number,
        includeStairs = false,
        buildingId?: number,
        maxOut = 20,
    ): NavNode[] {
        const reach = Math.ceil(maxDist / HashCell);
        const cx = Math.floor(pos.x / HashCell);
        const cy = Math.floor(pos.y / HashCell);
        const out: NavNode[] = [];

        for (let dx = -reach; dx <= reach; dx++) {
            for (let dy = -reach; dy <= reach; dy++) {
                const ids = this.cells.get(hashKey(cx + dx, cy + dy));
                if (!ids) continue;
                for (let i = 0; i < ids.length; i++) {
                    const node = this.nodes[ids[i]];
                    if (node.layer !== layer && !(includeStairs && node.kind === "stair")) continue;
                    if (buildingId !== undefined) {
                        if (node.kind === "hull" || node.kind === "open") continue;
                        if (node.buildingId !== undefined && node.buildingId !== buildingId && node.kind !== "door") {
                            continue;
                        }
                    } else {
                        // When outdoors, reject interior nodes
                        if (node.kind === "interior") continue;
                    }
                    if (v2.distance(pos, node.pos) <= maxDist) out.push(node);
                }
            }
        }

        if (out.length) {
            out.sort((a, b) => v2.distance(pos, a.pos) - v2.distance(pos, b.pos));
            if (out.length > maxOut) out.length = maxOut;
            return out;
        }

        let best: NavNode | undefined;
        let bestDist = Infinity;
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (node.layer !== layer && !(includeStairs && node.kind === "stair")) continue;
            if (buildingId !== undefined) {
                if (node.kind === "hull" || node.kind === "open") continue;
                if (node.buildingId !== undefined && node.buildingId !== buildingId && node.kind !== "door") {
                    continue;
                }
            } else {
                if (node.kind === "interior") continue;
            }
            const d = v2.distance(pos, node.pos);
            if (d < bestDist) {
                bestDist = d;
                best = node;
            }
        }
        return best ? [best] : [];
    }

    findNearestNavNode(pos: Vec2, layer: number, maxDist = 32): NavNode | null {
        const candidates = this.nearby(pos, layer, maxDist, true);
        return candidates.length > 0 ? candidates[0] : null;
    }

    getLocalSubgraph(
        game: Game,
        center: Vec2,
        layer: number,
        radius = 24,
    ): {
        nodes: Array<{ id: number; pos: Vec2; layer: number; kind: string }>;
        edges: Array<{ fromId: number; toId: number; isDoor: boolean; isTraversable: boolean }>;
    } {
        const b = getBuildingAt(game, center);
        const localNodes = this.nearby(center, layer, radius, true, b?.__id, 100);
        const nodeMap = new Map<number, NavNode>();
        for (let i = 0; i < localNodes.length; i++) {
            nodeMap.set(localNodes[i].id, localNodes[i]);
        }

        const outNodes: Array<{ id: number; pos: Vec2; layer: number; kind: string }> = [];
        for (let i = 0; i < localNodes.length; i++) {
            const node = localNodes[i];
            outNodes.push({
                id: node.id,
                pos: v2.copy(node.pos),
                layer: node.layer,
                kind: node.kind,
            });
        }

        const outEdges: Array<{ fromId: number; toId: number; isDoor: boolean; isTraversable: boolean }> = [];
        const seenEdges = new Set<number>();

        for (let i = 0; i < localNodes.length; i++) {
            const na = localNodes[i];
            for (let j = 0; j < na.neighbors.length; j++) {
                const nbId = na.neighbors[j];
                const nb = this.nodes[nbId];
                if (!nb) continue;
                if (!nodeMap.has(nbId) && v2.distance(center, nb.pos) > radius + 6) continue;

                const edgeKey = na.id < nbId ? (na.id << 16) | nbId : (nbId << 16) | na.id;
                if (seenEdges.has(edgeKey)) continue;
                seenEdges.add(edgeKey);

                const isDoor = na.kind === "door" || nb.kind === "door";
                const isTraversable = isCapsuleClear(
                    game,
                    na.pos,
                    nb.pos,
                    na.layer,
                    ZombieNavRadius,
                    false,
                );

                outEdges.push({
                    fromId: na.id,
                    toId: nb.id,
                    isDoor,
                    isTraversable,
                });
            }
        }

        return { nodes: outNodes, edges: outEdges };
    }

    private cacheKey(from: Vec2, to: Vec2, fl: number, tl: number): string {
        return `${from.x >> 4},${from.y >> 4},${to.x >> 4},${to.y >> 4},${fl},${tl}`;
    }

    private remember(key: string, path: Vec2[] | null): void {
        if (this.pathCache.size > 480) this.pathCache.clear();
        this.pathCache.set(key, path);
    }
}
