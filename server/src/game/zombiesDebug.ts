import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import type { Obstacle } from "./objects/obstacle.ts";

export interface ZombieNavSnapshot {
    zombieId: number;
    pos: Vec2;
    layer: number;
    targetPos: Vec2 | null;
    targetLayer: number;
    currentWaypoint: Vec2 | null;
    currentWaypointIndex: number;
    pathLength: number;
    path: Vec2[];
    stuckStrikes: number;
    timeSpentStuck: number;
    recalcCount: number;
    lastRecalcReason: string;
    lastEvent: string;
    lastEventTime: number;
    doorInteractions: number;
    isReachable: boolean;
    noRoute: boolean;
}

export interface ZombieNavFailureDiagnostic {
    timestamp: number;
    zombieId: number;
    failureType: "no_route" | "stuck" | "door_failure" | "collision_obstruction";
    failureReason?: string;
    // Zombie coordinates and map layer
    zombiePos: Vec2;
    zombieLayer: number;
    // Target coordinates and map layer
    targetPos: Vec2;
    targetLayer: number;
    // Current navigation node
    currentNavNode: { id: number; pos: Vec2; kind: string; layer: number } | null;
    // Target navigation node
    targetNavNode: { id: number; pos: Vec2; kind: string; layer: number } | null;
    // Current waypoint
    currentWaypoint: Vec2 | null;
    currentWaypointIndex: number;
    // Calculated path
    calculatedPath: Vec2[];
    // Failed or blocked connections
    blockedConnections: Array<{ from: Vec2; to: Vec2; reason: string }>;
    // Door state and interaction attempts
    doorState: {
        nearbyDoorId?: number;
        doorPos?: Vec2;
        isOpen?: boolean;
        isLocked?: boolean;
        canUse?: boolean;
        openOneWay?: number;
        attempts: number;
        lastAttemptResult?: string;
    } | null;
    // Collision obstruction preventing movement
    collisionObstruction: {
        obstacleType?: string;
        pos?: Vec2;
        colliderType?: string;
        details?: string;
    } | null;
    // Time spent stuck
    timeSpentStuck: number;
    // Number of path recalculations
    recalculationCount: number;
    lastRecalcReason: string;
}

/**
 * Development-only visual navigation debugger and diagnostic recorder for Zombies AI.
 * Completely disabled by default with zero performance impact in normal gameplay.
 */
export class ZombiesNavDebugger {
    static enabled = process.env.DEBUG_ZOMBIES_NAV === "true" || process.env.ZOMBIES_NAV_DEBUG === "true";

    private static snapshots = new Map<number, ZombieNavSnapshot>();
    private static failureHistory: ZombieNavFailureDiagnostic[] = [];
    private static latestFailure: ZombieNavFailureDiagnostic | null = null;

    static recordPath(
        zombieId: number,
        pos: Vec2,
        layer: number,
        targetPos: Vec2,
        targetLayer: number,
        path: Vec2[] | null,
        recalcCount: number,
        reason: string,
    ): void {
        const entry = this.getOrCreate(zombieId);
        entry.pos = { x: pos.x, y: pos.y };
        entry.layer = layer;
        entry.targetPos = { x: targetPos.x, y: targetPos.y };
        entry.targetLayer = targetLayer;
        entry.path = path ? path.map((p) => ({ x: p.x, y: p.y })) : [];
        entry.pathLength = entry.path.length;
        entry.recalcCount = recalcCount;
        entry.lastRecalcReason = reason;
        entry.isReachable = path !== null && path.length > 0;
        entry.noRoute = path === null;
        entry.lastEvent = path
            ? `path_planned (${path.length} waypoints, reason: ${reason})`
            : `path_failed (${reason})`;
        entry.lastEventTime = Date.now();

        if (this.enabled) {
            console.log(
                `[ZombieNavDebug] Zombie #${zombieId} path planned to (${targetPos.x.toFixed(1)}, ${
                    targetPos.y.toFixed(1)
                }): ${entry.path.length} waypoints (reason: ${reason})`,
            );
        }
    }

    static recordWaypoint(zombieId: number, wpIndex: number, wp: Vec2 | null): void {
        const entry = this.getOrCreate(zombieId);
        entry.currentWaypointIndex = wpIndex;
        entry.currentWaypoint = wp ? { x: wp.x, y: wp.y } : null;
    }

    static recordStuck(
        zombieId: number,
        pos: Vec2,
        strikes: number,
        timeStuck: number,
        action: string,
    ): void {
        const entry = this.getOrCreate(zombieId);
        entry.pos = { x: pos.x, y: pos.y };
        entry.stuckStrikes = strikes;
        entry.timeSpentStuck = timeStuck;
        entry.lastEvent = `stuck (strike ${strikes}, ${timeStuck.toFixed(1)}s): ${action}`;
        entry.lastEventTime = Date.now();

        if (this.enabled) {
            console.warn(
                `[ZombieNavDebug] Zombie #${zombieId} stuck at (${pos.x.toFixed(1)}, ${
                    pos.y.toFixed(1)
                }) strike ${strikes} (${timeStuck.toFixed(1)}s): ${action}`,
            );
        }
    }

    static recordDoor(zombieId: number, doorPos: Vec2, action: string): void {
        const entry = this.getOrCreate(zombieId);
        entry.doorInteractions++;
        entry.lastEvent = `door (${action}) at (${doorPos.x.toFixed(1)}, ${doorPos.y.toFixed(1)})`;
        entry.lastEventTime = Date.now();

        if (this.enabled) {
            console.log(
                `[ZombieNavDebug] Zombie #${zombieId} door interaction: ${action} at (${doorPos.x.toFixed(1)}, ${
                    doorPos.y.toFixed(1)
                })`,
            );
        }
    }

    static recordRepath(zombieId: number, reason: string, count: number): void {
        const entry = this.getOrCreate(zombieId);
        entry.recalcCount = count;
        entry.lastRecalcReason = reason;
        entry.lastEvent = `repath: ${reason} (count: ${count})`;
        entry.lastEventTime = Date.now();
    }

    static recordFailure(diagnostic: ZombieNavFailureDiagnostic): void {
        this.latestFailure = diagnostic;
        this.failureHistory.push(diagnostic);
        if (this.failureHistory.length > 50) {
            this.failureHistory.shift();
        }

        if (this.enabled) {
            console.warn(this.formatDiagnosticReport(diagnostic));
        }
    }

    static getLatestFailure(): ZombieNavFailureDiagnostic | null {
        return this.latestFailure;
    }

    static getFailureHistory(): ZombieNavFailureDiagnostic[] {
        return [...this.failureHistory];
    }

    static clearFailures(): void {
        this.failureHistory = [];
        this.latestFailure = null;
    }

    static formatDiagnosticReport(d: ZombieNavFailureDiagnostic): string {
        const lines: string[] = [
            "================================================================================",
            `[ZOMBIE NAVIGATION FAILURE DIAGNOSTIC] - ${d.failureType.toUpperCase()}`,
            `Timestamp:      ${new Date(d.timestamp).toISOString()}`,
            `Zombie:         #${d.zombieId} at (${d.zombiePos.x.toFixed(2)}, ${
                d.zombiePos.y.toFixed(2)
            }) layer ${d.zombieLayer}`,
            `Target:         at (${d.targetPos.x.toFixed(2)}, ${d.targetPos.y.toFixed(2)}) layer ${d.targetLayer}`,
            `Current Node:   ${
                d.currentNavNode
                    ? `#${d.currentNavNode.id} [${d.currentNavNode.kind}] at (${d.currentNavNode.pos.x.toFixed(2)}, ${
                        d.currentNavNode.pos.y.toFixed(2)
                    })`
                    : "none"
            }`,
            `Target Node:    ${
                d.targetNavNode
                    ? `#${d.targetNavNode.id} [${d.targetNavNode.kind}] at (${d.targetNavNode.pos.x.toFixed(2)}, ${
                        d.targetNavNode.pos.y.toFixed(2)
                    })`
                    : "none"
            }`,
            `Waypoint:       ${
                d.currentWaypoint
                    ? `#${d.currentWaypointIndex} at (${d.currentWaypoint.x.toFixed(2)}, ${
                        d.currentWaypoint.y.toFixed(2)
                    })`
                    : "none"
            }`,
            `Calculated Path:${d.calculatedPath.length} waypoints`,
            `Blocked Links:  ${d.blockedConnections.length} connection(s)`,
        ];

        for (let i = 0; i < Math.min(d.blockedConnections.length, 5); i++) {
            const bc = d.blockedConnections[i];
            lines.push(
                `  - from (${bc.from.x.toFixed(1)}, ${bc.from.y.toFixed(1)}) to (${bc.to.x.toFixed(1)}, ${
                    bc.to.y.toFixed(1)
                }): ${bc.reason}`,
            );
        }

        if (d.doorState) {
            lines.push(
                `Door State:     #${d.doorState.nearbyDoorId ?? "?"} at (${d.doorState.doorPos?.x.toFixed(1) ?? "?"}, ${
                    d.doorState.doorPos?.y.toFixed(1) ?? "?"
                }) | open: ${d.doorState.isOpen} | locked: ${d.doorState.isLocked} | canUse: ${d.doorState.canUse} | attempts: ${d.doorState.attempts}`,
            );
        } else {
            lines.push("Door State:     None nearby");
        }

        if (d.collisionObstruction) {
            lines.push(
                `Obstruction:    ${d.collisionObstruction.obstacleType} at (${
                    d.collisionObstruction.pos?.x.toFixed(1)
                }, ${d.collisionObstruction.pos?.y.toFixed(1)}) | ${d.collisionObstruction.details}`,
            );
        } else {
            lines.push("Obstruction:    No direct collider obstruction detected");
        }

        lines.push(`Time Stuck:     ${d.timeSpentStuck.toFixed(2)}s`);
        lines.push(`Recalculations: ${d.recalculationCount} (last reason: ${d.lastRecalcReason})`);
        lines.push("================================================================================");
        return lines.join("\n");
    }

    /**
     * Finds any physical obstacle directly blocking the zombie along its movement direction.
     */
    static findCollisionObstruction(
        game: Game,
        pos: Vec2,
        moveDir: Vec2,
        layer: number,
        rad: number,
    ): ZombieNavFailureDiagnostic["collisionObstruction"] {
        const checkPos = v2.add(pos, v2.mul(moveDir, 0.6));
        const circle = collider.createCircle(checkPos, rad);
        const objs = game.grid.intersectCollider(circle);

        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            const o = obj as Obstacle;
            if (o.dead || !o.collidable || !util.sameLayer(o.layer, layer)) continue;
            if (o.isDoor && o.door?.open) continue;

            return {
                obstacleType: o.type,
                pos: v2.copy(o.pos),
                colliderType: o.collider.type === collider.Type.Circle ? "Circle" : "Aabb",
                details: o.isDoor
                    ? `Door (locked: ${o.door?.locked}, open: ${o.door?.open})`
                    : `Solid obstacle: ${o.type}`,
            };
        }
        return null;
    }

    /**
     * Inspects the nearest door in interaction proximity.
     */
    static findNearbyDoorState(
        game: Game,
        pos: Vec2,
        layer: number,
        reach = 3.5,
        attempts = 0,
    ): ZombieNavFailureDiagnostic["doorState"] {
        const objs = game.grid.intersectCollider(collider.createCircle(pos, reach));
        let nearestDoor: Obstacle | null = null;
        let minD = Infinity;

        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            const o = obj as Obstacle;
            if (!o.isDoor || !o.door || o.dead || !util.sameLayer(o.layer, layer)) continue;
            const d = v2.distance(pos, o.pos);
            if (d < minD) {
                minD = d;
                nearestDoor = o;
            }
        }

        if (!nearestDoor || !nearestDoor.door) return null;

        return {
            nearbyDoorId: nearestDoor.__id,
            doorPos: v2.copy(nearestDoor.pos),
            isOpen: nearestDoor.door.open,
            isLocked: nearestDoor.door.locked,
            canUse: nearestDoor.door.canUse,
            openOneWay: nearestDoor.door.openOneWay,
            attempts,
            lastAttemptResult: nearestDoor.door.locked
                ? "door_locked"
                : (nearestDoor.door.open ? "already_open" : "can_toggle"),
        };
    }

    static clearZombie(zombieId: number): void {
        this.snapshots.delete(zombieId);
    }

    static getSnapshot(zombieId: number): ZombieNavSnapshot | undefined {
        return this.snapshots.get(zombieId);
    }

    static getAllSnapshots(): ZombieNavSnapshot[] {
        return Array.from(this.snapshots.values());
    }

    private static getOrCreate(zombieId: number): ZombieNavSnapshot {
        let entry = this.snapshots.get(zombieId);
        if (!entry) {
            entry = {
                zombieId,
                pos: { x: 0, y: 0 },
                layer: 0,
                targetPos: null,
                targetLayer: 0,
                currentWaypoint: null,
                currentWaypointIndex: 0,
                pathLength: 0,
                path: [],
                stuckStrikes: 0,
                timeSpentStuck: 0,
                recalcCount: 0,
                lastRecalcReason: "init",
                lastEvent: "init",
                lastEventTime: Date.now(),
                doorInteractions: 0,
                isReachable: false,
                noRoute: false,
            };
            this.snapshots.set(zombieId, entry);
        }
        return entry;
    }
}
