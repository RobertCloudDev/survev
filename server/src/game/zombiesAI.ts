import type { ZombieDef } from "../../../shared/defs/gameObjects/zombieDefs.ts";
import { MapObjectDefs } from "../../../shared/defs/register.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import type { NavDebugZombie } from "../../../shared/net/net.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import { type ZombieNavFailureDiagnostic, ZombiesNavDebugger } from "./zombiesDebug.ts";
import {
    type DetailedPathResult,
    doorNormal,
    getBuildingAt,
    getDoorwayCenter,
    getReachableMeleeApproach,
    inferGroundLayer,
    isCapsuleClear,
    MapNavGraph,
    type NavigationResult,
    navGroundLayer,
    pointClear,
    ZombieNavRadius,
} from "./zombiesNav.ts";
import {
    DefaultPersonalityWeights,
    type UtilityContext,
    type ZombieAction,
    type ZombieNeeds,
    ZombiesUtilityEvaluator,
} from "./zombiesUtility.ts";

/**
 * Checks whether there is an unobstructed direct line of sight between two positions.
 * Closed doors and solid walls block line of sight.
 */
export function hasLineOfSight(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
): boolean {
    const objs = game.grid.intersectLineSegment(from, to);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (o.dead || !o.collidable || !util.sameLayer(o.layer, layer)) continue;
        // Open doors do not block line of sight
        if (o.isDoor && o.door?.open) continue;
        if (collider.intersectSegment(o.collider, from, to)) {
            return false;
        }
    }
    return true;
}

/**
 * Tests whether a circular entity can exist at the given position without colliding with obstacles.
 */
export function isPositionPassable(
    game: Game,
    pos: Vec2,
    rad: number,
    layer: number,
): boolean {
    if (
        pos.x < rad
        || pos.x > game.map.width - rad
        || pos.y < rad
        || pos.y > game.map.height - rad
    ) {
        return false;
    }
    return pointClear(game, pos, layer, rad, true);
}

/**
 * Tests whether a path from 'from' to 'to' is clear of obstacles for an entity with the given radius.
 */
export function isPathPassable(
    game: Game,
    from: Vec2,
    to: Vec2,
    rad: number,
    layer: number,
): boolean {
    return isCapsuleClear(game, from, to, layer, rad, true);
}

/**
 * Scans for nearby doors along the path toward the goal and triggers opening or closing as required.
 * - Closed doors along the route are opened.
 * - Open doors whose swung panel obstructs movement are closed when closing creates a valid passage.
 * - Locked doors and doors restricted by one-way orientation are strictly respected.
 */
export function tryInteractDoorsAlongRoute(
    zombie: Player,
    goal: Vec2,
    doorCooldowns?: Map<number, number>,
    doorFailures?: Map<number, number>,
    doorToggles?: Map<number, number>,
    doorLastAction?: Map<number, "open" | "close">,
    isOpenDoorBlocking?: (door: Obstacle) => boolean,
): boolean {
    const scanRadius = zombie.rad + 2.6;
    const objs = zombie.game.grid.intersectCollider(collider.createCircle(zombie.pos, scanRadius));

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const door = obj as Obstacle;
        if (!door.isDoor || !door.door || door.dead) continue;
        if (!util.sameLayer(door.layer, zombie.layer)) continue;

        // Check per-door cooldown
        if (doorCooldowns) {
            const cd = doorCooldowns.get(door.__id) ?? 0;
            if (cd > 0) continue;
        }

        // Respect one-way door orientation (e.g. vault doors)
        if (door.door.openOneWay && door.getPlayerSide(zombie) !== door.door.openOneWay) {
            continue;
        }

        // Check interaction reach
        const reach = zombie.rad + Math.max(door.interactionRad, 1.0) + 0.65;
        const inReach = collider.intersectCircle(door.collider, zombie.pos, reach)
            || v2.distance(zombie.pos, door.pos) <= reach;
        if (!inReach) continue;

        // If locked or unusable, count as failed attempt to trigger alternate routing
        if (door.door.locked || !door.door.canUse) {
            if (doorFailures) {
                const fails = (doorFailures.get(door.__id) ?? 0) + 1;
                doorFailures.set(door.__id, fails);
            }
            continue;
        }

        // Check toggle limit to prevent endless oscillation (allow up to 6 toggles)
        if (doorToggles) {
            const toggles = doorToggles.get(door.__id) ?? 0;
            if (toggles >= 6) {
                if (doorFailures) {
                    doorFailures.set(door.__id, 3);
                }
                continue;
            }
        }

        if (!door.door.open) {
            // If the zombie just closed this door, do not reopen it unless the route explicitly crosses the closed doorframe
            if (doorLastAction && doorLastAction.get(door.__id) === "close") {
                const crossesFrame = collider.intersectSegment(door.collider, zombie.pos, goal);
                if (!crossesFrame) continue;
            }

            // Closed door: check if door is relevant to active movement route
            const toGoal = v2.sub(goal, zombie.pos);
            const toDoor = v2.sub(door.pos, zombie.pos);
            const goalDist = v2.length(toGoal);
            const doorDist = v2.length(toDoor);

            let isRelevant = false;
            const crossesFrame = collider.intersectSegment(door.collider, zombie.pos, goal);
            const goalNearDoor = collider.intersectCircle(door.collider, goal, zombie.rad + 0.5);
            if (crossesFrame || goalNearDoor) {
                isRelevant = true;
            } else if (doorDist <= reach) {
                // If moving generally toward the door, or goal is beyond the door
                const along = v2.dot(toDoor, v2.normalizeSafe(toGoal));
                if (along > -0.5 || doorDist <= 1.8) {
                    isRelevant = true;
                }
            }

            if (isRelevant) {
                door.openDoor(zombie);
                if (doorCooldowns) {
                    doorCooldowns.set(door.__id, 1.2);
                }
                if (doorToggles) {
                    doorToggles.set(door.__id, (doorToggles.get(door.__id) ?? 0) + 1);
                }
                if (doorLastAction) {
                    doorLastAction.set(door.__id, "open");
                }
                if (doorFailures) {
                    doorFailures.delete(door.__id);
                }
                ZombiesNavDebugger.recordDoor(zombie.__id, door.pos, "open");
                return true;
            }
        } else {
            // Open door: check if swung door panel obstructs the route
            if (isOpenDoorBlocking && isOpenDoorBlocking(door)) {
                door.closeDoor(zombie);
                if (doorCooldowns) {
                    doorCooldowns.set(door.__id, 1.2);
                }
                if (doorToggles) {
                    doorToggles.set(door.__id, (doorToggles.get(door.__id) ?? 0) + 1);
                }
                if (doorLastAction) {
                    doorLastAction.set(door.__id, "close");
                }
                if (doorFailures) {
                    doorFailures.delete(door.__id);
                }
                ZombiesNavDebugger.recordDoor(zombie.__id, door.pos, "close");
                return true;
            }
        }
    }
    return false;
}

export function tryOpenDoorsAlongRoute(
    zombie: Player,
    goal: Vec2,
    doorCooldowns?: Map<number, number>,
    doorFailures?: Map<number, number>,
): boolean {
    return tryInteractDoorsAlongRoute(zombie, goal, doorCooldowns, doorFailures);
}

export type ZombieState = "idle" | "chase" | "attack";

export class ZombieAI {
    readonly zombie: Player;
    readonly game: Game;
    readonly def: ZombieDef;
    navGraph: MapNavGraph;

    target: Player | null = null;
    state: ZombieState = "idle";
    activeAction: ZombieAction = "idle";
    readonly utilityEvaluator: ZombiesUtilityEvaluator;
    currentNeeds: ZombieNeeds;

    attackCooldownTimer = 0;
    targetUpdateTimer = 0;
    utilityEvalTimer = 0;
    commitmentTimer = 0;

    // Last known target and perception
    lastKnownTargetPos: Vec2 | null = null;
    timeSinceSawTarget = 0;
    recentDamageTaken = 0;
    staggerDuration = 0;

    // Navigation and path state
    currentPath: Vec2[] = [];
    currentWaypointIndex = 0;
    pathRecalcTimer = 0;
    lastTargetPos: Vec2;
    doorCooldownTimer = 0;
    doorCooldowns = new Map<number, number>();
    doorFailures = new Map<number, number>();
    doorToggles = new Map<number, number>();
    doorLastAction = new Map<number, "open" | "close">();
    edgePenalties = new Map<string, number>();

    // Diagnostics and metrics tracking
    recalcCount = 0;
    lastRecalcReason = "init";
    isTargetReachable = false;
    noRoute = false;
    timeSpentStuck = 0;
    doorInteractionAttempts = 0;
    navigationResult: NavigationResult = "success";

    // Stuck detection and recovery
    stuckCheckTimer = 0;
    lastPos: Vec2;
    stuckStrikes = 0;

    // Entity separation jitter (adapted from Fireteam CQC)
    strafeSign = Math.random() < 0.5 ? 1 : -1;
    strafeFlipTimer = 0.8;

    // Diagnostic logging rate limiting
    private lastLoggedFailureTime = 0;
    private lastLoggedFailureReason = "";

    isDead = false;

    constructor(
        zombie: Player,
        game: Game,
        def: ZombieDef,
        navGraph?: MapNavGraph,
    ) {
        this.zombie = zombie;
        this.game = game;
        this.def = def;
        this.navGraph = navGraph ?? game.zombiesManager?.getNavGraph() ?? MapNavGraph.build(game);
        this.lastPos = v2.copy(zombie.pos);
        this.lastTargetPos = v2.copy(zombie.pos);

        const personality = DefaultPersonalityWeights[def.id] ?? DefaultPersonalityWeights.walker;
        this.utilityEvaluator = new ZombiesUtilityEvaluator(personality);
        this.currentNeeds = {
            pursuit: 0,
            attack: 0,
            investigate: 0,
            breach: 0,
            survival: 0,
            group: 0,
        };
    }

    /**
     * Finds the best living human player target using weighted distance hysteresis.
     */
    findTarget(): Player | null {
        let best: Player | null = null;
        let minWeight = Infinity;

        for (let i = 0; i < this.game.playerBarn.livingPlayers.length; i++) {
            const p = this.game.playerBarn.livingPlayers[i];
            if (p.isZombie || p.dead) continue;

            const d2 = v2.lengthSqr(v2.sub(this.zombie.pos, p.pos));
            let weight = d2;
            // Target commitment hysteresis: favor retaining current target unless another is significantly closer
            if (this.target && p !== this.target && !this.target.dead) {
                weight *= 1.45;
            }

            if (weight < minWeight) {
                minWeight = weight;
                best = p;
            }
        }

        return best;
    }

    /**
     * Evaluates whether an open door's physical swung panel is obstructing the zombie's route,
     * and whether closing the door would create a valid passage.
     */
    isOpenDoorBlockingRoute(door: Obstacle): boolean {
        if (!door.isDoor || !door.door || !door.door.open || door.dead || door.door.locked || !door.door.canUse) {
            return false;
        }

        const cd = this.doorCooldowns.get(door.__id) ?? 0;
        if (cd > 0) return false;

        const toggles = this.doorToggles.get(door.__id) ?? 0;
        if (toggles >= 3) return false;

        // If the zombie's current route is actively planning to traverse through this door's frame,
        // closing the door would block the passage. An open door must remain open for doorway traversal.
        for (let i = this.currentWaypointIndex; i < this.currentPath.length; i++) {
            const wp = this.currentPath[i];
            const node = this.navGraph.findNearestNavNode(wp, this.zombie.layer, 2.5);
            if (node && node.kind === "door" && node.obstacleId === door.__id) {
                return false;
            }
        }

        // Compute closed collider geometry
        const def = MapObjectDefs.typeToDef(door.type, "obstacle");
        if (!def?.collision) return false;
        const closedRot = math.oriToRad(door.door.closedOri);
        const closedColl = collider.transform(def.collision, door.pos, closedRot, door.scale);

        // An open door panel only swings into corridors/rooms if it is actually rotated open
        if (Math.abs(door.rot - closedRot) < 1e-4) {
            return false;
        }

        // Check if the current goal or next waypoint passes through the doorway frame
        const nextWaypoint = this.currentPath[this.currentWaypointIndex] ?? this.target?.pos;
        if (nextWaypoint) {
            // If zombie and waypoint/target are on opposite sides of the doorframe and near the doorway,
            // the zombie is actively traversing through this entrance: DO NOT CLOSE IT
            const center = getDoorwayCenter(door);
            const n = doorNormal(door);
            const dotZombie = v2.dot(n, v2.sub(this.zombie.pos, center));
            const dotGoal = v2.dot(n, v2.sub(nextWaypoint, center));
            if (dotZombie * dotGoal < 0 && Math.abs(dotZombie) < 4.5 && Math.abs(dotGoal) < 6.0) {
                return false;
            }

            // If heading through the doorway frame, do NOT close it
            if (collider.intersectSegment(closedColl, this.zombie.pos, nextWaypoint)) {
                return false;
            }
            if (collider.intersectCircle(closedColl, nextWaypoint, this.zombie.rad)) {
                return false;
            }
        }

        // 1. Check if the zombie is currently in physical contact with or stuck against this open door panel
        const zombieTouchesOpenDoor = collider.intersectCircle(door.collider, this.zombie.pos, this.zombie.rad + 0.15);
        if (zombieTouchesOpenDoor) {
            // Closing frees the zombie if the closed collider does not intersect the zombie (i.e. zombie not in doorframe)
            if (!collider.intersectCircle(closedColl, this.zombie.pos, this.zombie.rad)) {
                return true;
            }
        }

        // 2. Check if the zombie's active path or immediate movement segment intersects the open door panel
        if (nextWaypoint) {
            const pathBlockedByOpenDoor = collider.intersectSegment(door.collider, this.zombie.pos, nextWaypoint);
            if (pathBlockedByOpenDoor) {
                // If closing does not block the waypoint and does not hit the zombie, closing creates a valid passage
                if (!collider.intersectCircle(closedColl, this.zombie.pos, this.zombie.rad)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Scans for an obstacle (closed door, route-blocking open door, or breakable barricade) within interaction range.
     */
    findNearbyObstacleToBreach(maxDist = 2.8): Obstacle | null {
        const scanBounds = collider.createAabb(
            v2.create(this.zombie.pos.x - maxDist, this.zombie.pos.y - maxDist),
            v2.create(this.zombie.pos.x + maxDist, this.zombie.pos.y + maxDist),
        );
        const objs = this.game.grid.intersectCollider(scanBounds);
        let bestObstacle: Obstacle | null = null;
        let bestDist = Infinity;

        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            const o = obj as Obstacle;
            if (o.dead || !o.collidable || !util.sameLayer(o.layer, this.zombie.layer)) continue;

            const isBarricade = !!o.isBarricade;
            const isClosedDoor = o.isDoor && o.door && !o.door.open;
            const isOpenDoorBlocking = o.isDoor && o.door && o.door.open && !o.door.locked && o.door.canUse && this.isOpenDoorBlockingRoute(o);

            if (!isBarricade && !isClosedDoor && !isOpenDoorBlocking) continue;

            // Check door cooldown and toggle limits
            if (o.isDoor) {
                const cd = this.doorCooldowns.get(o.__id) ?? 0;
                if (cd > 0) continue;
                const toggles = this.doorToggles.get(o.__id) ?? 0;
                if (toggles >= 3) continue;
            }

            // For closed doors: only breach if the zombie did NOT just close it
            if (isClosedDoor) {
                if (o.door!.locked && !isBarricade) continue;
                if (this.doorLastAction.get(o.__id) === "close") continue;
            }

            const dist = v2.distance(this.zombie.pos, o.pos);
            const inReach = dist <= maxDist || (o.isDoor && !!collider.intersectCircle(o.collider, this.zombie.pos, maxDist));
            if (inReach && dist < bestDist) {
                bestDist = dist;
                bestObstacle = o;
            }
        }
        return bestObstacle;
    }

    /**
     * Finds nearby blocking breakable barricade within melee reach.
     */
    findNearbyBlockingBarricade(): Obstacle | null {
        const obs = this.findNearbyObstacleToBreach(2.4);
        return obs && obs.isBarricade ? obs : null;
    }

    /**
     * Counts nearby living zombies for swarm/group density calculation.
     */
    countNearbyZombies(radius = 3.5): number {
        let count = 0;
        const living = this.game.playerBarn.livingPlayers;
        for (let i = 0; i < living.length; i++) {
            const p = living[i];
            if (p.isZombie && !p.dead && p !== this.zombie) {
                if (v2.distance(this.zombie.pos, p.pos) <= radius) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Called when the zombie takes damage, triggering reactive survival utility evaluation.
     */
    takeDamage(amount: number, attacker?: Player): void {
        this.recentDamageTaken += amount;
        if (amount >= 35) {
            this.staggerDuration = 0.2;
        }
        if (attacker && (!this.target || this.target.dead || !hasLineOfSight(this.game, this.zombie.pos, this.target.pos, this.zombie.layer))) {
            this.target = attacker;
            this.lastKnownTargetPos = v2.copy(attacker.pos);
            this.timeSinceSawTarget = 0;
        }
        this.utilityEvalTimer = 0;
    }

    /**
     * Called when a door state changes, flushing edge penalties and prompting route reconsidering.
     */
    onDoorStateChanged(door: Obstacle): void {
        this.pathRecalcTimer = 0;
        this.utilityEvalTimer = 0;
        this.doorFailures.delete(door.__id);
        const doorNode = this.navGraph.findNearestNavNode(door.pos, door.layer, 4);
        if (doorNode) {
            for (let i = 0; i < doorNode.neighbors.length; i++) {
                const nid = doorNode.neighbors[i];
                const edgeKey = doorNode.id < nid ? `${doorNode.id}->${nid}` : `${nid}->${doorNode.id}`;
                this.edgePenalties.delete(edgeKey);
            }
        }
    }

    update(dt: number): void {
        // Immediate termination if zombie is dead
        if (this.zombie.dead || this.zombie.health <= 0) {
            this.destroy();
            return;
        }

        // Timer updates
        if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
        if (this.commitmentTimer > 0) this.commitmentTimer -= dt;
        if (this.utilityEvalTimer > 0) this.utilityEvalTimer -= dt;
        if (this.staggerDuration > 0) this.staggerDuration -= dt;
        if (this.recentDamageTaken > 0) {
            this.recentDamageTaken = Math.max(0, this.recentDamageTaken - dt * 25.0);
        }

        // Per-door cooldown timer updates
        for (const [id, timer] of this.doorCooldowns) {
            const rem = timer - dt;
            if (rem <= 0) this.doorCooldowns.delete(id);
            else this.doorCooldowns.set(id, rem);
        }

        // Periodic target evaluation
        this.targetUpdateTimer -= dt;
        if (
            this.targetUpdateTimer <= 0
            || !this.target
            || this.target.dead
            || this.target.health <= 0
        ) {
            this.target = this.findTarget();
            this.targetUpdateTimer = 0.4;
        }

        // Line-of-sight and perception tracking
        let distToTarget = Infinity;
        let directDir = v2.create(1, 0);
        let hasLoS = false;

        if (this.target && !this.target.dead) {
            distToTarget = v2.distance(this.zombie.pos, this.target.pos);
            directDir = v2.normalizeSafe(v2.sub(this.target.pos, this.zombie.pos));
            hasLoS = hasLineOfSight(this.game, this.zombie.pos, this.target.pos, this.zombie.layer);

            if (hasLoS) {
                this.lastKnownTargetPos = v2.copy(this.target.pos);
                this.timeSinceSawTarget = 0;
            } else {
                this.timeSinceSawTarget += dt;
            }
        } else {
            this.timeSinceSawTarget += dt;
        }

        // Scan for breachable obstacles (doors or breakable barricades)
        const breachObstacle = this.findNearbyObstacleToBreach(2.8);
        const nearbyDensity = this.countNearbyZombies(3.5);

        // --- Periodic & Event-Driven Six-Need Utility AI Evaluation ---
        const inAttackReach = !!(this.target && distToTarget <= this.def.attackRange && hasLoS);
        const reachedBreach = !!(breachObstacle && (
            v2.distance(this.zombie.pos, breachObstacle.pos) <= 2.8
            || (breachObstacle.isDoor && !!collider.intersectCircle(breachObstacle.collider, this.zombie.pos, 2.5))
        ));
        const isEventTriggered = inAttackReach || reachedBreach || this.staggerDuration > 0;

        if (this.utilityEvalTimer <= 0 || isEventTriggered) {
            const ctx: UtilityContext = {
                zombie: this.zombie,
                game: this.game,
                target: this.target,
                lastKnownTargetPos: this.lastKnownTargetPos,
                distToTarget,
                hasLineOfSight: hasLoS,
                isTargetReachable: this.isTargetReachable,
                attackCooldown: this.attackCooldownTimer,
                attackRange: this.def.attackRange,
                nearbyObstacleToBreach: breachObstacle,
                recentDamageTaken: this.recentDamageTaken,
                timeSinceSawTarget: this.timeSinceSawTarget,
                nearbyZombieDensity: nearbyDensity,
                staggerDuration: this.staggerDuration,
            };

            const evalResult = this.utilityEvaluator.selectAction(ctx, this.activeAction, this.commitmentTimer);
            this.currentNeeds = evalResult.needs;

            if (evalResult.selectedAction !== this.activeAction) {
                this.activeAction = evalResult.selectedAction;
                this.commitmentTimer = ZombiesUtilityEvaluator.MIN_COMMITMENT_TIME;
            }

            // Map modular activeAction to legacy high-level state
            switch (this.activeAction) {
                case "attack":
                case "breach":
                    this.state = "attack";
                    break;
                case "pursuit":
                case "investigate":
                case "group":
                    this.state = "chase";
                    break;
                case "idle":
                case "survival":
                    this.state = "idle";
                    break;
            }

            this.utilityEvalTimer = 0.1;
        }

        // --- Execute Selected Utility Action ---

        // 1. Action: Idle
        if (this.activeAction === "idle" || (!this.target && !this.lastKnownTargetPos)) {
            this.stop();
            return;
        }

        // 2. Action: Survival / Reaction (stagger / stun)
        if (this.activeAction === "survival") {
            this.stop();
            return;
        }

        // 3. Action: Attack Player (Melee)
        if (this.activeAction === "attack" && this.target) {
            this.stop();
            this.zombie.dirNew = directDir;
            this.zombie.dir = directDir;

            if (this.attackCooldownTimer <= 0 && hasLoS) {
                this.zombie.playAnim(GameConfig.Anim.Melee, 0.3);
                this.target.damage({
                    amount: this.def.damage,
                    damageType: GameConfig.DamageType.Player,
                    source: this.zombie,
                    dir: directDir,
                });
                this.attackCooldownTimer = this.def.attackCooldown;
            }
            return;
        }

        // 4. Action: Breach Obstacle (Open closed door or melee attack breakable barricade)
        if (this.activeAction === "breach" && breachObstacle) {
            const isBarricade = !!breachObstacle.isBarricade;
            const isClosedDoor = breachObstacle.isDoor && breachObstacle.door && !breachObstacle.door.open;
            const isOpenDoor = breachObstacle.isDoor && breachObstacle.door && breachObstacle.door.open;

            if (isClosedDoor && !breachObstacle.door!.locked && breachObstacle.door!.canUse) {
                // Open unlocked door
                breachObstacle.openDoor(this.zombie);
                this.doorInteractionAttempts++;
                this.doorCooldownTimer = 1.2;
                this.doorCooldowns.set(breachObstacle.__id, 1.2);
                this.doorLastAction.set(breachObstacle.__id, "open");
                const toggles = (this.doorToggles.get(breachObstacle.__id) ?? 0) + 1;
                this.doorToggles.set(breachObstacle.__id, toggles);
                this.navGraph.invalidateCache();
                this.pathRecalcTimer = 0;
                this.utilityEvalTimer = 0;
                ZombiesNavDebugger.recordDoor(this.zombie.__id, breachObstacle.pos, "open");
            } else if (isOpenDoor && !breachObstacle.door!.locked && breachObstacle.door!.canUse && this.isOpenDoorBlockingRoute(breachObstacle)) {
                // Close open door that is blocking route
                breachObstacle.closeDoor(this.zombie);
                this.doorInteractionAttempts++;
                this.doorCooldownTimer = 1.2;
                this.doorCooldowns.set(breachObstacle.__id, 1.2);
                this.doorLastAction.set(breachObstacle.__id, "close");
                const toggles = (this.doorToggles.get(breachObstacle.__id) ?? 0) + 1;
                this.doorToggles.set(breachObstacle.__id, toggles);
                this.navGraph.invalidateCache();
                this.pathRecalcTimer = 0;
                this.utilityEvalTimer = 0;
                ZombiesNavDebugger.recordDoor(this.zombie.__id, breachObstacle.pos, "close");
            } else if (isBarricade) {
                // Melee attack breakable barricade
                this.stop();
                const toBarricade = v2.normalizeSafe(v2.sub(breachObstacle.pos, this.zombie.pos));
                this.zombie.dirNew = toBarricade;
                this.zombie.dir = toBarricade;

                if (this.attackCooldownTimer <= 0) {
                    this.zombie.playAnim(GameConfig.Anim.Melee, 0.3);
                    breachObstacle.damage({
                        amount: this.def.damage,
                        damageType: GameConfig.DamageType.Player,
                        source: this.zombie,
                        dir: toBarricade,
                    });
                    this.attackCooldownTimer = this.def.attackCooldown;
                    if (breachObstacle.dead || breachObstacle.health <= 0) {
                        this.navGraph.invalidateCache();
                        this.pathRecalcTimer = 0;
                        this.utilityEvalTimer = 0;
                    }
                }
                return;
            }
        }

        // 5. Actions: Pursuit / Investigate / Group (Movement and Navigation)
        let destination: Vec2;
        if (this.activeAction === "investigate" && this.lastKnownTargetPos) {
            destination = this.lastKnownTargetPos;
        } else if (this.target) {
            destination = this.target.pos;
        } else if (this.lastKnownTargetPos) {
            destination = this.lastKnownTargetPos;
        } else {
            this.stop();
            return;
        }

        // Compute reachable melee approach position if pursuing a target player
        const targetBuilding = getBuildingAt(this.game, destination);
        const approachPos = this.target && this.activeAction !== "investigate"
            ? getReachableMeleeApproach(this.game, this.target.pos, this.zombie.pos, this.zombie.layer, targetBuilding, ZombieNavRadius)
            : null;
        const effectiveGoal = approachPos ?? destination;

        // Direct pursuit check: same ground layer, within 12u, same building context, full capsule clear to effectiveGoal
        const sameGround = this.target ? util.toGroundLayer(this.zombie.layer) === util.toGroundLayer(this.target.layer) : true;
        const sameBuilding = getBuildingAt(this.game, this.zombie.pos) === targetBuilding;
        const canDirectPursue = !!(
            this.target
            && this.activeAction !== "investigate"
            && sameGround
            && sameBuilding
            && distToTarget < 12.0
            && isCapsuleClear(this.game, this.zombie.pos, effectiveGoal, this.zombie.layer, ZombieNavRadius, false)
        );

        let goal: Vec2;

        if (canDirectPursue) {
            goal = effectiveGoal;
            this.currentPath.length = 0;
            this.currentWaypointIndex = 0;
            this.isTargetReachable = true;
            this.noRoute = false;
            this.navigationResult = "success";
            this.lastRecalcReason = "direct_pursuit";
            ZombiesNavDebugger.recordWaypoint(this.zombie.__id, 0, goal);
        } else {
            // Path following with rate-limited recalculation
            this.pathRecalcTimer -= dt;
            const targetMoved = v2.distance(destination, this.lastTargetPos) > 2.8;
            const pathEnded = this.currentPath.length > 0 && this.currentWaypointIndex >= this.currentPath.length;
            const needsInitialPath = this.currentPath.length === 0 && !this.noRoute;

            if (this.pathRecalcTimer <= 0 || targetMoved || pathEnded || needsInitialPath) {
                let recalcReason = "timer_expired";
                if (this.stuckStrikes > 0) {
                    recalcReason = "stuck";
                } else if (this.currentPath.length === 0) {
                    recalcReason = "initial_path";
                } else if (targetMoved) {
                    recalcReason = "target_moved";
                } else if (pathEnded) {
                    recalcReason = "path_ended";
                }
                this.recalcCount++;
                this.lastRecalcReason = recalcReason;

                const fromLayer = navGroundLayer(this.zombie.layer);
                const toLayer = inferGroundLayer(this.game, destination, this.target ? this.target.layer : this.zombie.layer);

                const detailed = this.navGraph.findDetailedPath(
                    this.game,
                    this.zombie.pos,
                    destination,
                    fromLayer,
                    toLayer,
                    this.zombie.layer,
                    this.edgePenalties,
                    approachPos,
                );

                this.navigationResult = detailed.result;
                this.currentPath = detailed.path;
                this.currentWaypointIndex = 0;
                this.lastTargetPos = v2.copy(destination);

                if (detailed.result !== "success") {
                    this.isTargetReachable = false;
                    this.noRoute = true;
                    this.state = "idle";
                    this.stop();
                    // Controlled backoff for stationary targets to avoid excessive recalculations
                    this.pathRecalcTimer = 1.0 + Math.random() * 0.4;
                    this.recordFailureDiagnostic("no_route", detailed.failureReason, detailed);
                    return;
                }

                this.isTargetReachable = true;
                this.noRoute = false;
                this.pathRecalcTimer = 0.5 + Math.random() * 0.1;

                ZombiesNavDebugger.recordPath(
                    this.zombie.__id,
                    this.zombie.pos,
                    this.zombie.layer,
                    destination,
                    toLayer,
                    detailed.path,
                    this.recalcCount,
                    recalcReason,
                );

                // Forward string-pulling: start from the furthest reachable waypoint along path
                let bestIdx = 0;
                for (let i = this.currentPath.length - 1; i >= 0; i--) {
                    if (
                        isCapsuleClear(
                            this.game,
                            this.zombie.pos,
                            this.currentPath[i],
                            this.zombie.layer,
                            ZombieNavRadius,
                            false,
                        )
                        || isCapsuleClear(
                            this.game,
                            this.zombie.pos,
                            this.currentPath[i],
                            this.zombie.layer,
                            this.zombie.rad,
                            false,
                        )
                    ) {
                        bestIdx = i;
                        break;
                    }
                }
                if (bestIdx === 0 && this.currentPath.length > 1) {
                    if (v2.distance(this.zombie.pos, this.currentPath[0]) <= 1.2) {
                        bestIdx = 1;
                    }
                }
                this.currentWaypointIndex = bestIdx;
            }

            // Waypoint progression and arrival tolerance
            if (this.currentWaypointIndex < this.currentPath.length) {
                let wp = this.currentPath[this.currentWaypointIndex];

                // Arrival tolerance
                if (v2.distance(this.zombie.pos, wp) <= 1.2) {
                    this.currentWaypointIndex++;
                    if (this.currentWaypointIndex < this.currentPath.length) {
                        wp = this.currentPath[this.currentWaypointIndex];
                    }
                }

                // Safe corner shortcutting: advance ONLY if full physical capsule is completely clear
                if (this.currentWaypointIndex + 1 < this.currentPath.length) {
                    const nextWp = this.currentPath[this.currentWaypointIndex + 1];
                    if (
                        isCapsuleClear(this.game, this.zombie.pos, nextWp, this.zombie.layer, ZombieNavRadius, false)
                        || isCapsuleClear(this.game, this.zombie.pos, nextWp, this.zombie.layer, this.zombie.rad, false)
                    ) {
                        this.currentWaypointIndex++;
                        wp = nextWp;
                    }
                }

                goal = (this.currentWaypointIndex < this.currentPath.length)
                    ? this.currentPath[this.currentWaypointIndex]
                    : effectiveGoal;
            } else {
                goal = effectiveGoal;
            }

            ZombiesNavDebugger.recordWaypoint(this.zombie.__id, this.currentWaypointIndex, goal);
        }

        if (this.noRoute) {
            this.state = "idle";
            this.stop();
            return;
        }

        // Door interaction: open closed unlocked doors or close route-blocking open doors along route
        if (this.doorCooldownTimer > 0) {
            this.doorCooldownTimer -= dt;
        } else {
            this.doorCooldownTimer = 0.25;
            if (tryInteractDoorsAlongRoute(
                this.zombie,
                goal,
                this.doorCooldowns,
                this.doorFailures,
                this.doorToggles,
                this.doorLastAction,
                (d) => this.isOpenDoorBlockingRoute(d),
            )) {
                this.doorInteractionAttempts++;
                this.doorCooldownTimer = 0.4;
                this.navGraph.invalidateCache();
            }

            // Check if any nearby door has failed repeatedly
            for (const [failedDoorId, failCount] of this.doorFailures) {
                if (failCount >= 3) {
                    const failedDoor = this.game.objectRegister.getById(failedDoorId) as Obstacle | undefined;
                    if (failedDoor) {
                        const doorNode = this.navGraph.findNearestNavNode(failedDoor.pos, failedDoor.layer, 4);
                        if (doorNode) {
                            for (let i = 0; i < doorNode.neighbors.length; i++) {
                                const nid = doorNode.neighbors[i];
                                const edgeKey = doorNode.id < nid ? `${doorNode.id}->${nid}` : `${nid}->${doorNode.id}`;
                                this.edgePenalties.set(edgeKey, 1000);
                            }
                        }
                    }
                    this.pathRecalcTimer = 0;
                    this.recordFailureDiagnostic("door_failure");
                    break;
                }
            }
        }

        // Apply movement vector toward active goal with Fireteam CQC separation
        const desired = v2.normalizeSafe(v2.sub(goal, this.zombie.pos));
        let moveDir = desired;

        // Swarm / Group dispersion jitter
        if (this.activeAction === "group" || nearbyDensity >= 2) {
            this.strafeFlipTimer -= dt;
            if (this.strafeFlipTimer <= 0) {
                this.strafeSign = -this.strafeSign;
                this.strafeFlipTimer = 0.8 + Math.random() * 0.8;
            }
            moveDir = v2.normalizeSafe(v2.add(desired, v2.mul(v2.perp(desired), this.strafeSign * 0.15)));
        }

        this.zombie.touchMoveActive = true;
        this.zombie.touchMoveLen = 255;
        this.zombie.touchMoveDir = moveDir;

        // Facing direction: Face target when in close melee reach with clear sight, otherwise face movement direction
        if (distToTarget <= 2.8 && hasLoS) {
            this.zombie.dirNew = directDir;
        } else {
            this.zombie.dirNew = moveDir;
        }
        this.zombie.dir = this.zombie.dirNew;

        // Stuck detection and recovery
        this.stuckCheckTimer += dt;
        if (this.stuckCheckTimer >= 0.4) {
            const movedDist = v2.distance(this.zombie.pos, this.lastPos);
            if (movedDist < 0.15) {
                this.stuckStrikes++;
                this.timeSpentStuck += 0.4;

                // When stuck, clear door cooldowns to immediately allow clearing any door obstacle
                for (const [doorId] of this.doorCooldowns) {
                    this.doorCooldowns.set(doorId, 0);
                }
                this.doorCooldownTimer = 0;

                // Check for closed or route-blocking open doors without inflating interaction counter on clear doors
                if (tryInteractDoorsAlongRoute(
                    this.zombie,
                    goal,
                    this.doorCooldowns,
                    this.doorFailures,
                    this.doorToggles,
                    this.doorLastAction,
                    (d) => this.isOpenDoorBlockingRoute(d),
                )) {
                    this.doorInteractionAttempts++;
                }

                // If stuck on current route, apply dynamic penalty to current nearest edge
                if (this.stuckStrikes >= 2) {
                    const fromNode = this.navGraph.findNearestNavNode(this.zombie.pos, this.zombie.layer, 8);
                    const toNode = this.currentPath.length > this.currentWaypointIndex
                        ? this.navGraph.findNearestNavNode(this.currentPath[this.currentWaypointIndex], this.zombie.layer, 8)
                        : null;

                    if (fromNode && toNode && fromNode.id !== toNode.id) {
                        const edgeKey = fromNode.id < toNode.id ? `${fromNode.id}->${toNode.id}` : `${toNode.id}->${fromNode.id}`;
                        const curPenalty = this.edgePenalties.get(edgeKey) ?? 0;
                        this.edgePenalties.set(edgeKey, curPenalty + 150);
                    }

                    this.lastRecalcReason = "stuck";
                    this.pathRecalcTimer = 0;
                    this.navGraph.invalidateCache();
                    this.recordFailureDiagnostic("stuck");
                }
            } else {
                this.stuckStrikes = 0;
                this.timeSpentStuck = 0;
            }

            this.lastPos = v2.copy(this.zombie.pos);
            this.stuckCheckTimer = 0;
        }
    }

    private recordFailureDiagnostic(
        failureType: "no_route" | "stuck" | "door_failure" | "collision_obstruction",
        specificReason?: string,
        detailed?: DetailedPathResult,
    ): void {
        const now = Date.now();
        const reason = specificReason ?? this.navGraph.lastFailureReason;
        if (reason === this.lastLoggedFailureReason && now - this.lastLoggedFailureTime < 3000) {
            return;
        }
        this.lastLoggedFailureTime = now;
        this.lastLoggedFailureReason = reason;

        const fromLayer = navGroundLayer(this.zombie.layer);
        const toLayer = this.target ? inferGroundLayer(this.game, this.target.pos, this.target.layer) : fromLayer;
        const targetPos = this.target ? v2.copy(this.target.pos) : v2.copy(this.zombie.pos);
        const targetBuilding = getBuildingAt(this.game, targetPos);

        const currentNavNode = this.navGraph.findNearestNavNode(this.zombie.pos, fromLayer);
        const targetNavNode = this.navGraph.findNearestNavNode(targetPos, toLayer);

        let doorState: ZombieNavFailureDiagnostic["doorState"] = null;
        const scanBounds = collider.createAabb(
            v2.create(this.zombie.pos.x - 4, this.zombie.pos.y - 4),
            v2.create(this.zombie.pos.x + 4, this.zombie.pos.y + 4),
        );
        const nearbyObstacles = this.game.grid.intersectCollider(scanBounds);
        const nearbyDoor = nearbyObstacles.find((o) => (o as Obstacle).isDoor && (o as Obstacle).door) as Obstacle | undefined;

        if (nearbyDoor && nearbyDoor.door) {
            doorState = {
                nearbyDoorId: nearbyDoor.__id,
                doorPos: v2.copy(nearbyDoor.pos),
                isOpen: nearbyDoor.door.open,
                isLocked: nearbyDoor.door.locked,
                canUse: nearbyDoor.door.canUse,
                openOneWay: nearbyDoor.door.openOneWay,
                attempts: this.doorInteractionAttempts,
            };
        }

        let collisionObstruction: ZombieNavFailureDiagnostic["collisionObstruction"] = null;
        for (let i = 0; i < nearbyObstacles.length; i++) {
            const obs = nearbyObstacles[i] as Obstacle;
            if (obs.collidable && !obs.dead && !obs.isDoor) {
                collisionObstruction = {
                    obstacleType: obs.type,
                    pos: v2.copy(obs.pos),
                    colliderType: obs.collider.type === collider.Type.Circle ? "circle" : "aabb",
                };
                break;
            }
        }

        const diagnostic: ZombieNavFailureDiagnostic = {
            timestamp: now,
            zombieId: this.zombie.__id,
            failureType,
            failureReason: reason,
            zombiePos: v2.copy(this.zombie.pos),
            zombieLayer: this.zombie.layer,
            targetPos,
            targetLayer: toLayer,
            currentNavNode: currentNavNode
                ? { id: currentNavNode.id, pos: v2.copy(currentNavNode.pos), kind: currentNavNode.kind, layer: currentNavNode.layer }
                : null,
            targetNavNode: targetNavNode
                ? { id: targetNavNode.id, pos: v2.copy(targetNavNode.pos), kind: targetNavNode.kind, layer: targetNavNode.layer }
                : null,
            currentWaypoint: this.currentWaypointIndex < this.currentPath.length ? v2.copy(this.currentPath[this.currentWaypointIndex]) : null,
            currentWaypointIndex: this.currentWaypointIndex,
            calculatedPath: this.currentPath.map((p) => v2.copy(p)),
            blockedConnections: [],
            doorState,
            collisionObstruction,
            timeSpentStuck: this.timeSpentStuck,
            recalculationCount: this.recalcCount,
            lastRecalcReason: this.lastRecalcReason,
            // Task 004.11 Goal selection diagnostics
            targetRadius: this.target ? this.target.rad : 1.0,
            zombieRadius: ZombieNavRadius,
            candidateGoalNodes: detailed?.candidatesConsidered,
            approachPos: detailed?.approachPos ?? null,
            hasReachableAttackPosition: detailed?.approachPos !== null && detailed?.approachPos !== undefined,
            targetBuildingId: targetBuilding?.__id,
            targetBuildingType: targetBuilding?.type,
        };

        ZombiesNavDebugger.recordFailure(diagnostic);
    }

    getDebugData(): NavDebugZombie {
        const targetPos = this.target ? v2.copy(this.target.pos) : v2.create(0, 0);
        const targetLayer = this.target ? this.target.layer : 0;
        const currentWaypoint = this.currentWaypointIndex < this.currentPath.length
            ? v2.copy(this.currentPath[this.currentWaypointIndex])
            : (this.target ? v2.copy(this.target.pos) : null);
        const finalDestination = this.currentPath.length > 0
            ? v2.copy(this.currentPath[this.currentPath.length - 1])
            : (this.target ? v2.copy(this.target.pos) : null);

        const utilityStr = `P:${this.currentNeeds.pursuit.toFixed(0)} A:${this.currentNeeds.attack.toFixed(0)} I:${this.currentNeeds.investigate.toFixed(0)} B:${this.currentNeeds.breach.toFixed(0)} S:${this.currentNeeds.survival.toFixed(0)} G:${this.currentNeeds.group.toFixed(0)}`;

        return {
            id: this.zombie.__id,
            pos: v2.copy(this.zombie.pos),
            layer: this.zombie.layer,
            rad: ZombieNavRadius,
            targetId: this.target ? this.target.__id : 0,
            targetPos,
            targetLayer,
            isReachable: this.isTargetReachable,
            noRoute: this.noRoute,
            isStuck: this.stuckStrikes > 0,
            stuckStrikes: this.stuckStrikes,
            timeSpentStuck: this.timeSpentStuck,
            recalcCount: this.recalcCount,
            lastRecalcReason: this.lastRecalcReason,
            currentWaypointIndex: this.currentWaypointIndex,
            currentWaypoint,
            finalDestination,
            path: this.currentPath.map((p) => v2.copy(p)),
            selectedNeed: this.activeAction,
            activeAction: this.activeAction,
            utilityScores: utilityStr,
            navResult: this.navigationResult,
        };
    }

    stop(): void {
        this.zombie.touchMoveActive = false;
        this.zombie.touchMoveLen = 0;
        v2.set(this.zombie.moveVel, v2.create(0, 0));
    }

    destroy(): void {
        this.isDead = true;
        this.target = null;
        this.currentPath.length = 0;
        this.stop();
    }
}
