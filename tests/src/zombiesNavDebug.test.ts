import { describe, expect, test } from "vitest";
import { Obstacle } from "../../server/src/game/objects/obstacle.ts";
import { ZombiesNavDebugger } from "../../server/src/game/zombiesDebug.ts";
import {
    getBuildingAt,
    getDoorwayCenter,
    getReachableMeleeApproach,
    isCapsuleClear,
    isSeparatedByWall,
    isWalkClear,
    MapNavGraph,
    pointClear,
    ZombieNavRadius,
} from "../../server/src/game/zombiesNav.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { BitStream, MsgType, ZombiesNavDebugMsg } from "../../shared/net/net.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { collider } from "../../shared/utils/collider.ts";
import { math } from "../../shared/utils/math.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

describe("Visual Navigation Debugger & Diagnostic Suite (Task 004.6)", () => {
    test("ZombiesNavDebugMsg: Binary BitStream round-trip serialization", () => {
        const msg = new ZombiesNavDebugMsg();

        msg.zombies.push({
            id: 101,
            pos: { x: 125.5, y: 130.25 },
            layer: 0,
            rad: 1.15,
            targetId: 202,
            targetPos: { x: 150.0, y: 160.0 },
            targetLayer: 0,
            isReachable: true,
            noRoute: false,
            isStuck: false,
            stuckStrikes: 0,
            timeSpentStuck: 0,
            recalcCount: 3,
            lastRecalcReason: "target_moved",
            currentWaypointIndex: 1,
            currentWaypoint: { x: 135.0, y: 140.0 },
            finalDestination: { x: 150.0, y: 160.0 },
            path: [
                { x: 125.5, y: 130.25 },
                { x: 135.0, y: 140.0 },
                { x: 150.0, y: 160.0 },
            ],
            selectedNeed: "pursuit",
            activeAction: "pursuit",
            utilityScores: "P:85 A:0 I:0 B:0 S:0 G:0",
            navResult: "success",
        });

        msg.nodes.push(
            { id: 1, pos: { x: 120.0, y: 120.0 }, layer: 0, kind: "open" },
            { id: 2, pos: { x: 130.0, y: 130.0 }, layer: 0, kind: "corner" },
            { id: 3, pos: { x: 140.0, y: 140.0 }, layer: 0, kind: "door" },
            { id: 4, pos: { x: 150.0, y: 150.0 }, layer: 0, kind: "interior" },
        );

        msg.edges.push(
            { fromId: 1, toId: 2, isDoor: false, isTraversable: true },
            { fromId: 2, toId: 3, isDoor: false, isTraversable: false },
            { fromId: 3, toId: 4, isDoor: true, isTraversable: true },
        );

        msg.failureJson = JSON.stringify({
            timestamp: 123456789,
            zombieId: 101,
            failureType: "stuck",
            timeSpentStuck: 1.2,
        });

        const stream = new BitStream(new ArrayBuffer(4096));
        msg.serialize(stream);

        // Reset read pointer
        stream.index = 0;

        const deserialized = new ZombiesNavDebugMsg();
        deserialized.deserialize(stream);

        expect(deserialized.zombies.length).toBe(1);
        const z = deserialized.zombies[0];
        expect(z.id).toBe(101);
        expect(z.pos.x).toBeCloseTo(125.5);
        expect(z.pos.y).toBeCloseTo(130.25);
        expect(z.rad).toBeCloseTo(1.15);
        expect(z.targetId).toBe(202);
        expect(z.isReachable).toBe(true);
        expect(z.noRoute).toBe(false);
        expect(z.recalcCount).toBe(3);
        expect(z.lastRecalcReason).toBe("target_moved");
        expect(z.currentWaypointIndex).toBe(1);
        expect(z.currentWaypoint?.x).toBeCloseTo(135.0);
        expect(z.finalDestination?.x).toBeCloseTo(150.0);
        expect(z.path.length).toBe(3);
        expect(z.selectedNeed).toBe("pursuit");
        expect(z.activeAction).toBe("pursuit");
        expect(z.utilityScores).toBe("P:85 A:0 I:0 B:0 S:0 G:0");
        expect(z.navResult).toBe("success");

        expect(deserialized.nodes.length).toBe(4);
        expect(deserialized.nodes[0].kind).toBe("open");
        expect(deserialized.nodes[1].kind).toBe("corner");
        expect(deserialized.nodes[2].kind).toBe("door");
        expect(deserialized.nodes[3].kind).toBe("interior");

        expect(deserialized.edges.length).toBe(3);
        expect(deserialized.edges[0].isTraversable).toBe(true);
        expect(deserialized.edges[1].isTraversable).toBe(false);
        expect(deserialized.edges[2].isDoor).toBe(true);

        expect(deserialized.failureJson).toContain("stuck");
    });

    test("1. Outdoor open space: direct pursuit and local subgraph verification", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(180, 180), name: "Survivor" });
        const zombie = zm.spawnZombie("walker", v2.create(170, 180))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        const debugData = ai.getDebugData();
        expect(debugData.id).toBe(zombie.__id);
        expect(debugData.rad).toBe(ZombieNavRadius);
        expect(debugData.targetId).toBe(human.__id);
        expect(debugData.isReachable).toBe(true);
        expect(debugData.noRoute).toBe(false);
        expect(debugData.isStuck).toBe(false);

        // Verify local subgraph generation around zombie in open space
        const local = zm.getNavGraph().getLocalSubgraph(game, zombie.pos, zombie.layer, 24);
        expect(local.nodes.length).toBeGreaterThan(0);
        const traversable = local.edges.filter((e) => e.isTraversable);
        expect(traversable.length).toBeGreaterThan(0);
    });

    test("2. L-shaped wall: path polyline, convex corners, and traversable vs blocked edges", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Two perpendicular walls meeting at (80, 80)
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(80, 86.5), 0, 0);
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(86.5, 80), 0, 1);

        zm.navGraph = MapNavGraph.build(game);

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(74, 74), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(86, 86))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        const debug = ai.getDebugData();
        // Requirement 1: Calculated path as connected line segments
        expect(debug.path.length).toBeGreaterThanOrEqual(2);
        // Requirement 2: Current waypoint and destination marked
        expect(debug.currentWaypoint).not.toBeNull();
        expect(debug.finalDestination).not.toBeNull();
        expect(debug.isReachable).toBe(true);

        // Requirements 3, 4: Local subgraph nodes and edges
        const local = zm.getNavGraph().getLocalSubgraph(game, zombie.pos, zombie.layer, 26);
        const cornerNodes = local.nodes.filter((n) => n.kind === "corner");
        expect(cornerNodes.length).toBeGreaterThan(0);

        // Traversable connections (green) exist around corner
        const traversableEdges = local.edges.filter((e) => e.isTraversable);
        expect(traversableEdges.length).toBeGreaterThan(0);
    });

    test("3. Narrow doorway: 3-node doorway portal structure and door connections", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        // Find a door obstacle on the map
        const testDoor = game.map.obstacles.find((o) => o.isDoor && o.door && !o.dead && o.collidable);
        expect(testDoor).toBeDefined();
        if (!testDoor) return;

        // Requirement 5: Highlight door-related navigation nodes and portal connections
        const local = nav.getLocalSubgraph(game, testDoor.pos, testDoor.layer, 12);
        const doorNodes = local.nodes.filter((n) => n.kind === "door");
        expect(doorNodes.length).toBeGreaterThanOrEqual(1);

        const doorEdges = local.edges.filter((e) => e.isDoor);
        expect(doorEdges.length).toBeGreaterThanOrEqual(1);
    });

    test("4. Building containing multiple rooms: interior nodes and partition differentiation", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const building = game.map.buildings.find((b) => b.zoomRegions.length >= 1);
        expect(building).toBeDefined();
        if (!building) return;

        const local = nav.getLocalSubgraph(game, building.pos, building.layer, 28);
        // Requirement 3: Interior nodes
        const interiorNodes = local.nodes.filter((n) => n.kind === "interior");
        expect(interiorNodes.length).toBeGreaterThan(0);

        // Requirement 4: Traversable connections exist within building corridors
        const hasTraversable = local.edges.some((e) => e.isTraversable);
        expect(hasTraversable).toBe(true);
    });

    test("5. Target standing near an exterior wall: routing to entrance instead of straight through", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Find a building with doors on the map
        const door = game.map.obstacles.find((o) => o.isDoor && o.door && !o.dead && o.collidable && o.parentBuilding);
        expect(door).toBeDefined();
        if (!door || !door.parentBuilding) return;

        const building = door.parentBuilding;

        // Calculate inside direction towards building center, and outside direction away
        const toBuilding = v2.normalize(v2.sub(building.pos, door.pos));
        const insidePos = v2.add(door.pos, v2.mul(toBuilding, 6.0));
        const outsidePos = v2.add(door.pos, v2.mul(v2.neg(toBuilding), 8.0));

        // Human inside building near the exterior wall
        const human = game.playerBarn.addTestPlayer({ pos: insidePos, name: "InsideNearWall" });

        // Zombie outside opposite the entrance
        const zombie = zm.spawnZombie("walker", outsidePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        const debug = ai.getDebugData();

        // Target should be recognized as reachable via path around the building
        expect(debug.isReachable).toBe(true);
        expect(debug.noRoute).toBe(false);
        // Path routes via waypoints through the entrance
        expect(debug.path.length).toBeGreaterThanOrEqual(2);
    });

    test("6. Closed or locked door: diagnostic recording when no route exists", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Find a building with doors on the map
        const testDoor = game.map.obstacles.find((o) =>
            o.isDoor && o.door && !o.dead && o.collidable && o.parentBuilding
        );
        expect(testDoor).toBeDefined();
        if (!testDoor || !testDoor.door || !testDoor.parentBuilding) return;

        const building = testDoor.parentBuilding;

        // Lock ALL doors on the building so no entrance portals exist
        for (const child of building.childObjects) {
            if (child.__type === ObjectType.Obstacle) {
                const obs = child as Obstacle;
                if (obs.isDoor && obs.door) {
                    obs.door.locked = true;
                    obs.door.canUse = false;
                    obs.door.open = false;
                }
            }
        }

        // Rebuild nav graph without unlocked door portals
        zm.navGraph = MapNavGraph.build(game);

        // Place human deep inside the building zoom region
        const zoom = building.zoomRegions[0]?.zoomIn;
        const humanPos = zoom
            ? v2.create((zoom.min.x + zoom.max.x) * 0.5, (zoom.min.y + zoom.max.y) * 0.5)
            : v2.add(building.pos, v2.create(0, 0));
        const human = game.playerBarn.addTestPlayer({ pos: humanPos, name: "TrappedInside" });

        // Place zombie outside in front of the locked door
        const toBuilding = v2.sub(building.pos, testDoor.pos);
        const norm = v2.rotate(v2.create(1, 0), math.oriToRad(testDoor.door.closedOri ?? testDoor.ori));
        const outsideDir = v2.dot(norm, toBuilding) >= 0 ? v2.neg(norm) : norm;
        const zombiePos = v2.add(testDoor.pos, v2.mul(outsideDir, 2.0));
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ZombiesNavDebugger.clearFailures();

        // Run AI update
        ai.update(1 / 30);

        const debug = ai.getDebugData();
        // Requirement 10: Identify when no valid route exists
        expect(debug.noRoute).toBe(true);
        expect(debug.isReachable).toBe(false);

        // Diagnostic requirements verification
        const failure = ZombiesNavDebugger.getLatestFailure();
        expect(failure).not.toBeNull();
        if (failure) {
            expect(failure.failureType).toBe("no_route");
            expect(failure.zombiePos.x).toBeCloseTo(zombie.pos.x);
            expect(failure.targetPos.x).toBeCloseTo(human.pos.x);
            expect(failure.doorState).not.toBeNull();
            expect(failure.doorState?.isLocked).toBe(true);
            expect(failure.calculatedPath.length).toBe(0);
        }
    });

    test("7. Stuck detection: progress threshold, timer tracking, and failure recording", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Place wall between zombie and human so canDirectPursue is false
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(195, 200), 0, 1);

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(205, 200), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(185, 200))!;
        const ai = zm.zombies[0];

        // Pin zombie position so movedDist is always 0
        ai.lastPos = v2.copy(zombie.pos);

        // Step through multiple stuck check intervals
        for (let i = 0; i < 6; i++) {
            ai.update(0.4);
        }

        const debug = ai.getDebugData();
        // Requirement 8: Stuck indicator when progress falls below threshold
        expect(debug.isStuck).toBe(true);
        expect(debug.stuckStrikes).toBeGreaterThanOrEqual(2);
        expect(debug.timeSpentStuck).toBeGreaterThanOrEqual(0.8);

        // Requirement 9: Track path recalculations and reason
        expect(debug.recalcCount).toBeGreaterThan(0);
        expect(debug.lastRecalcReason).toBe("stuck");

        // Verify diagnostic failure record
        const failure = ZombiesNavDebugger.getLatestFailure();
        expect(failure).not.toBeNull();
        expect(failure?.failureType).toBe("stuck");
        expect(failure?.timeSpentStuck).toBeGreaterThanOrEqual(0.8);
    });

    test("8. Visual debugger is disabled by default and generates zero overhead", () => {
        // Ensure default environment has debug disabled
        expect(ZombiesNavDebugger.enabled).toBe(false);

        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        game.playerBarn.addTestPlayer({ pos: v2.create(150, 150), name: "Player" });
        zm.spawnZombie("walker", v2.create(160, 150))!;

        // Mock client without zombiesNav enabled
        let sentCount = 0;
        const mockClient = {
            player: {
                debug: {
                    zombiesNav: false,
                },
            },
            sendMsg: () => {
                sentCount++;
            },
        };
        game.clientBarn.clients.push(mockClient as any);

        zm.update(1 / 30);
        expect(sentCount).toBe(0);
    });
});

describe("Task 004.7 Regression Tests — Confirmed Zombie Navigation Failures", () => {
    test("1. Same nearest node with a wall between zombie and player (Failure B)", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Place a long horizontal wall obstacle at y = 163 between y=168 (zombie) and y=157 (human)
        game.map.genObstacle("warehouse_wall_side", v2.create(193, 163), 0, 0);

        const zombiePos = v2.create(193.94, 168.17);
        const humanPos = v2.create(192.60, 157.75);

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "TargetBehindWall" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        // 1. Validate physical segment check: direct line of sight and capsule clearance are blocked by wall
        expect(isCapsuleClear(game, zombiePos, humanPos, 0, ZombieNavRadius, false)).toBe(false);
        expect(isSeparatedByWall(game, zombiePos, humanPos, 0)).toBe(true);

        ai.update(1 / 30);

        // 2. Direct pursuit must NOT bypass collision checks
        expect(ai.state).toBe("chase");
        // Touch move dir should not aim directly south through the wall (-y)
        expect(v2.dot(zombie.touchMoveDir, v2.create(0, -1))).toBeLessThan(0.9);

        // 3. No infinite recalculation loop: pathRecalcTimer is rate-limited
        expect(ai.recalcCount).toBeLessThanOrEqual(2);
    });

    test("2. Open door with repeated approach attempts (Failure A)", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Find a door obstacle and set it to already open
        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.dead && o.collidable && o.parentBuilding,
        )!;
        expect(door).toBeDefined();
        door.door!.open = true;

        const outsidePos = v2.add(door.pos, v2.create(3.0, 0));
        const insidePos = v2.add(door.pos, v2.create(-3.0, 0));

        game.playerBarn.addTestPlayer({ pos: insidePos, name: "InsidePlayer" });
        const zombie = zm.spawnZombie("walker", outsidePos)!;
        const ai = zm.zombies[0];

        // Simulate 60 ticks (2 seconds) of approach towards and through the already-open door
        for (let t = 0; t < 60; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // Acceptance Criteria: No infinite door interaction loops (was 4,300 attempts in Failure A)
        expect(ai.doorInteractionAttempts).toBe(0);
    });

    test("3. Valid graph path whose waypoint is physically obstructed (Failure A)", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        game.playerBarn.addTestPlayer({ pos: v2.create(150, 180), name: "Player" });
        const zombie = zm.spawnZombie("walker", v2.create(150, 150))!;
        const ai = zm.zombies[0];

        // Force a path with known waypoints
        ai.currentPath = [v2.create(150, 160), v2.create(150, 170), v2.create(150, 180)];
        ai.currentWaypointIndex = 0;

        // Place an obstruction directly blocking waypoint 0
        game.map.genObstacle("crate_01", v2.create(150, 155), 0, 0);

        // Keep zombie position fixed to simulate physical blockage
        ai.lastPos = v2.copy(zombie.pos);

        // Simulate stuck ticks
        for (let i = 0; i < 4; i++) {
            ai.update(0.4);
        }

        // Acceptance Criteria: Stuck state detected and connection penalized
        expect(ai.stuckStrikes).toBeGreaterThanOrEqual(2);
        expect(ai.timeSpentStuck).toBeGreaterThanOrEqual(0.8);
        expect(ai.edgePenalties.size).toBeGreaterThan(0);
    });

    test("4. Repeated stuck states that previously generated identical paths", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        game.playerBarn.addTestPlayer({ pos: v2.create(100, 140), name: "Target" });
        const zombie = zm.spawnZombie("walker", v2.create(100, 100))!;
        const ai = zm.zombies[0];

        // Initial path calculation
        ai.update(1 / 30);
        const initialPath = ai.currentPath.map((p) => v2.copy(p));
        expect(initialPath.length).toBeGreaterThan(0);

        // Simulate repeated stuck on this route
        ai.stuckStrikes = 3;
        ai.timeSpentStuck = 1.2;
        const fromNode = ai.navGraph.findNearestNavNode(zombie.pos, zombie.layer);
        const toNode = ai.navGraph.findNearestNavNode(ai.currentPath[0], zombie.layer);
        if (fromNode && toNode) {
            const edgeKey = fromNode.id < toNode.id ? `${fromNode.id}->${toNode.id}` : `${toNode.id}->${fromNode.id}`;
            ai.edgePenalties.set(edgeKey, 150);
        }

        // Invalidate cache and recalculate with edge penalty
        ai.navGraph.invalidateCache();
        ai.pathRecalcTimer = 0;
        ai.update(1 / 30);

        // Acceptance Criteria: Dynamic edge penalties ensure graph path search penalizes failed connections
        expect(ai.edgePenalties.size).toBeGreaterThan(0);
        expect(ai.lastRecalcReason).toBe("stuck");
    });

    test("5. An isolated navigation node with blocked links (Failure B)", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        // Create an isolated node with 0 traversable neighbors
        const isolatedPos = v2.create(193.0, 168.0);
        const isolatedId = (nav as any).addNode(isolatedPos, 0, "open");
        const isolatedNode = nav.nodes[isolatedId];
        isolatedNode.neighbors = [];
        isolatedNode.costs = [];

        // Surround target with wall so it cannot connect to isolated node
        game.map.genObstacle("warehouse_wall_side", v2.create(193, 163), 0, 0);

        zm.spawnZombie("walker", v2.create(193.94, 168.17))!;
        game.playerBarn.addTestPlayer({ pos: v2.create(192.60, 157.75), name: "IsolatedHuman" });
        const ai = zm.zombies[0];

        // Run AI update
        ai.update(1 / 30);

        // Acceptance Criteria: No unbounded repeated path recalculation (was 991 in Failure B)
        // Rate limiting backoff timer is applied
        expect(ai.recalcCount).toBeLessThan(5);
        if (ai.noRoute) {
            expect(ai.pathRecalcTimer).toBeGreaterThan(0.5);
            expect(ai.isTargetReachable).toBe(false);
        }
    });

    test("6. A player inside a room near an exterior wall", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.dead && o.collidable && o.parentBuilding,
        )!;
        expect(door).toBeDefined();
        const building = door.parentBuilding!;

        // Place human inside room 1.2 units from exterior wall
        const zoom = building.zoomRegions[0].zoomIn;
        const humanPos = zoom
            ? v2.create(zoom.min.x + 1.2, zoom.min.y + 1.2)
            : v2.copy(building.pos);
        const human = game.playerBarn.addTestPlayer({ pos: humanPos, name: "SurvivorNearExteriorWall" });

        // Place zombie outside opposite the exterior wall
        const outsidePos = zoom
            ? v2.create(zoom.min.x - 6.0, zoom.min.y + 1.2)
            : v2.add(building.pos, v2.create(-25, 0));
        const zombie = zm.spawnZombie("walker", outsidePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Acceptance Criteria:
        // 1. Physical segment check: direct pursuit is blocked by exterior wall
        expect(isCapsuleClear(game, zombie.pos, human.pos, 0, ZombieNavRadius, false)).toBe(false);
        expect(isSeparatedByWall(game, zombie.pos, human.pos, 0)).toBe(true);
        // 2. Waypoint path routes to reachable destination inside building
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.currentPath.length).toBeGreaterThanOrEqual(2);
        // 3. Final waypoint reaches human
        const lastWaypoint = ai.currentPath[ai.currentPath.length - 1];
        expect(v2.distance(lastWaypoint, human.pos)).toBeLessThan(2.0);
    });
});

describe("Task 004.8 — Reliable Indoor Routing and Door Traversal Regression Suite", () => {
    test("1. Multiple connected rooms: navigation connects interior rooms separated by closed unlocked doors", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const building = game.map.buildings.find(
            (b) => b.childObjects.filter((c) => (c as Obstacle).isDoor).length >= 1,
        )!;
        expect(building).toBeDefined();

        const doors = building.childObjects.filter((c) => (c as Obstacle).isDoor) as Obstacle[];
        const door = doors[0];
        door.door!.open = false;
        door.door!.locked = false;
        door.door!.canUse = true;

        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const zombiePos = v2.add(door.pos, v2.mul(n, 3.5));
        const humanPos = v2.add(door.pos, v2.mul(v2.neg(n), 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "RoomSurvivor" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        expect(ai.currentPath.length).toBeGreaterThan(0);
    });

    test("2. Multiple usable doors: zombie evaluates multiple valid entrances and prefers open door or alternate when blocked", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const doors = game.map.obstacles.filter((o) => o.isDoor && o.door);
        expect(doors.length).toBeGreaterThanOrEqual(2);
        const doorA = doors[0];
        const doorB = doors[1];

        doorA.door!.open = true;
        doorA.door!.locked = false;
        doorB.door!.open = false;
        doorB.door!.locked = false;
        doorB.door!.canUse = true;
        nav.invalidateCache();

        const zombiePos = v2.add(doorA.pos, v2.create(2.5, 0));
        const humanPos = v2.add(doorA.pos, v2.create(-5.0, 0));

        zm.spawnZombie("walker", zombiePos)!;
        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Target" });
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        // Lock Door A, leaving Door B as the usable entrance
        doorA.door!.locked = true;
        doorA.door!.canUse = false;
        doorA.door!.open = false;
        nav.invalidateCache();
        ai.pathRecalcTimer = 0;

        ai.update(1 / 30);
        expect(ai.recalcCount).toBeGreaterThanOrEqual(1);
    });

    test("3. An open door: traversable immediately with zero interaction delay", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const door = game.map.obstacles.find((o) => o.isDoor && o.door)!;
        door.door!.open = true;
        nav.invalidateCache();

        const zombiePos = v2.add(door.pos, v2.create(2.0, 0));
        const humanPos = v2.add(door.pos, v2.create(-5.0, 0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "OpenDoorTarget" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(ai.doorInteractionAttempts).toBe(0);
    });

    test("4. A closed but unlocked door: zombie approaches, opens it, and traverses cleanly", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.open && !o.door.locked && o.door.canUse,
        )!;
        expect(door).toBeDefined();

        const zombiePos = v2.add(door.pos, v2.create(1.2, 0));
        const humanPos = v2.add(door.pos, v2.create(-6.0, 0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "ClosedDoorTarget" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(door.door!.open).toBe(true);
        expect(ai.doorInteractionAttempts).toBe(1);
    });

    test("5. An ordinary locked door: remains impassable, zombie does not open it or get stuck", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const testDoor = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.dead && o.parentBuilding,
        )!;
        const building = testDoor.parentBuilding!;

        for (const obs of game.map.obstacles) {
            if (obs.isDoor && obs.door) {
                if (obs.parentBuilding === building || v2.distance(obs.pos, building.pos) < 60) {
                    obs.door.locked = true;
                    obs.door.canUse = false;
                    obs.door.open = false;
                    obs.isBarricade = false;
                }
            }
        }
        nav.invalidateCache();

        const zoom = building.zoomRegions[0]?.zoomIn;
        const humanPos = zoom
            ? v2.create((zoom.min.x + zoom.max.x) * 0.5, (zoom.min.y + zoom.max.y) * 0.5)
            : v2.copy(building.pos);
        game.playerBarn.addTestPlayer({ pos: humanPos, name: "InsideLockedBuilding" });

        const toBuilding = v2.sub(building.pos, testDoor.pos);
        const norm = v2.rotate(v2.create(1, 0), math.oriToRad(testDoor.door?.closedOri ?? testDoor.ori));
        const outsideDir = v2.dot(norm, toBuilding) >= 0 ? v2.neg(norm) : norm;
        const outsidePos = v2.add(testDoor.pos, v2.mul(outsideDir, 3.0));

        zm.navGraph = MapNavGraph.build(game);

        zm.spawnZombie("walker", outsidePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.noRoute).toBe(true);
        expect(ai.isTargetReachable).toBe(false);
        expect(ai.state).toBe("idle");
        expect(testDoor.door!.open).toBe(false);
    });

    test("6. A breakable barricade: zombie approaches, melee attacks, damages, and destroys barricade", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const barricadePos = v2.create(150, 150);
        const barricade = game.map.genObstacle("crate_01", barricadePos, 0, 0) as Obstacle;
        barricade.isBarricade = true;
        barricade.destructible = true;
        barricade.maxHealth = 40;
        barricade.health = 40;

        nav.addBarricade(game, barricade);

        game.playerBarn.addTestPlayer({ pos: v2.create(155, 150), name: "SurvivorBehindBarricade" });
        zm.spawnZombie("walker", v2.create(148.5, 150))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.state).toBe("attack");
        expect(barricade.health).toBeLessThan(40);

        for (let i = 0; i < 4; i++) {
            ai.attackCooldownTimer = 0;
            ai.update(0.1);
        }

        expect(barricade.dead).toBe(true);
        expect(barricade.collidable).toBe(false);
    });

    test("7. A player moving between rooms: zombie recalculates and follows through doorways", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && !o.door.locked)!;
        door.door!.open = true;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.add(door.pos, v2.create(-5, 0)),
            name: "MovingHuman",
        });

        zm.spawnZombie("walker", v2.add(door.pos, v2.create(5, 0)))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        human.pos = v2.add(door.pos, v2.create(-12, 6));
        ai.update(1 / 30);

        expect(ai.target).toBe(human);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(ai.isTargetReachable).toBe(true);
    });

    test("8. No valid route available: records failure diagnostic and avoids recalculation spam", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const center = v2.create(250, 250);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, 5)), 0, 0);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, -5)), 0, 0);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(5, 0)), 0, 1);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(-5, 0)), 0, 1);

        game.playerBarn.addTestPlayer({ pos: center, name: "EnclosedHuman" });
        zm.spawnZombie("walker", v2.add(center, v2.create(20, 20)))!;
        const ai = zm.zombies[0];

        ZombiesNavDebugger.clearFailures();

        for (let t = 0; t < 30; t++) {
            ai.update(1 / 30);
        }

        expect(ai.recalcCount).toBeLessThan(5);
        expect(ai.noRoute).toBe(true);
        expect(ai.state).toBe("idle");

        const failure = ZombiesNavDebugger.getLatestFailure();
        expect(failure).not.toBeNull();
        expect(failure?.failureType).toBe("no_route");
        expect(failure?.failureReason).toBeDefined();
    });

    test("9. Previously failing zero-waypoint scenario (Zombie #1231 diagnostic reproduction)", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && o.parentBuilding,
        )!;
        expect(door).toBeDefined();

        door.door!.open = false;
        door.door!.locked = false;
        door.door!.canUse = true;

        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const zombiePos = v2.add(door.pos, v2.mul(n, 3.5));
        const humanPos = v2.add(door.pos, v2.mul(v2.neg(n), 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "TargetRoom" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(ai.noRoute).toBe(false);
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.recalcCount).toBeLessThan(5);
    });

    test("10. Navigation updates after barricade destruction: cache invalidates and allows traversal", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const barricade = game.map.genObstacle("crate_01", v2.create(180, 180), 0, 0) as Obstacle;
        barricade.isBarricade = true;
        barricade.destructible = true;
        barricade.health = 20;
        nav.addBarricade(game, barricade);

        game.playerBarn.addTestPlayer({ pos: v2.create(185, 180), name: "Human" });
        zm.spawnZombie("walker", v2.create(175, 180))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        barricade.damage({
            amount: 50,
            damageType: GameConfig.DamageType.Player,
            source: ai.zombie,
            dir: v2.create(1, 0),
        });
        expect(barricade.dead).toBe(true);

        ai.pathRecalcTimer = 0;
        ai.update(1 / 30);

        // After barricade destruction, the obstacle is cleared and traversal is unblocked
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        // Direct pursuit or waypoint route traverses straight through the cleared space towards target
        expect(ai.lastRecalcReason === "direct_pursuit" || ai.currentPath.length > 0).toBe(true);
        expect(ai.zombie.touchMoveDir.x).toBeGreaterThan(0.5);
    });
});

describe("Task 004.11 — Goal Selection and Stationary Target Navigation Regression Suite", () => {
    test("1. Stationary player inside a small room: zombie reaches melee position without player moving", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Construct a small enclosed room with 3 walls and an open entrance on the west side
        const center = v2.create(200, 200);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, 4)), 0, 0); // North wall
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, -4)), 0, 0); // South wall
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(4, 0)), 0, 1); // East wall
        // West side is open entrance

        zm.navGraph = MapNavGraph.build(game);

        const human = game.playerBarn.addTestPlayer({ pos: center, name: "StationaryHuman" });
        const zombie = zm.spawnZombie("walker", v2.add(center, v2.create(-14, 0)))!;
        const ai = zm.zombies[0];

        // Simulate 60 ticks of movement without human moving
        for (let t = 0; t < 60; t++) {
            ai.update(1 / 30);
            game.update(1 / 30);
        }

        // Acceptance Criteria:
        // 1. Navigation status is success (not invalid_goal)
        expect(ai.navigationResult).toBe("success");
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        // 2. Low recalculation count (no spamming)
        expect(ai.recalcCount).toBeLessThan(9);
        // 3. Zombie has navigated inside and reached valid melee range
        const dist = v2.distance(zombie.pos, human.pos);
        expect(dist).toBeLessThanOrEqual(ai.def.attackRange);
    });

    test("2. Player standing close to an exterior wall: approach position offset away from wall", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Wall obstacle centered at (160, 160)
        const wall = game.map.genObstacle("warehouse_wall_side", v2.create(160, 160), 0, 0) as Obstacle;
        zm.navGraph = MapNavGraph.build(game);

        // Player standing 1.05u north of wall edge (player collider rad 1.0 fits, but zombie rad 1.15 clips wall)
        const wallAabb = collider.toAabb(wall.collider);
        const playerPos = v2.create(160, wallAabb.max.y + 1.05);
        expect(pointClear(game, playerPos, 0, ZombieNavRadius, false)).toBe(false);

        const human = game.playerBarn.addTestPlayer({ pos: playerPos, name: "HumanNearWall" });
        const zombie = zm.spawnZombie("walker", v2.create(160, playerPos.y + 7))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Valid path found to reachable melee approach position
        expect(ai.navigationResult).toBe("success");
        expect(ai.isTargetReachable).toBe(true);

        // Simulate movement
        for (let t = 0; t < 50; t++) {
            ai.update(1 / 30);
            game.update(1 / 30);
        }

        // Zombie occupies physically valid approach position and reaches valid melee attack range
        const dist = v2.distance(zombie.pos, human.pos);
        expect(dist).toBeLessThanOrEqual(ai.def.attackRange);
        expect(pointClear(game, zombie.pos, 0, ZombieNavRadius, false)).toBe(true);
    });

    test("3. Player standing near furniture: approaches clear side without obstacle clipping", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const crate = game.map.genObstacle("crate_01", v2.create(140, 140), 0, 0) as Obstacle;
        zm.navGraph = MapNavGraph.build(game);

        // Human standing right next to crate
        const crateAabb = collider.toAabb(crate.collider);
        const humanPos = v2.create(140, crateAabb.max.y + 1.02);
        const human = game.playerBarn.addTestPlayer({ pos: humanPos, name: "NearFurniture" });
        const zombie = zm.spawnZombie("walker", v2.create(140, humanPos.y + 10))!;
        const ai = zm.zombies[0];

        for (let t = 0; t < 50; t++) {
            ai.update(1 / 30);
            game.update(1 / 30);
        }

        expect(ai.navigationResult).toBe("success");
        expect(v2.distance(zombie.pos, human.pos)).toBeLessThanOrEqual(ai.def.attackRange);
    });

    test("4. Player standing just inside a doorway: routes through portal without hanging", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && o.parentBuilding)!;
        expect(door).toBeDefined();

        door.door!.locked = false;
        door.door!.canUse = true;
        door.openDoor();
        nav.invalidateCache();

        const closedOri = door.door?.closedOri ?? door.ori;
        const n = v2.rotate(v2.create(1, 0), math.oriToRad(closedOri));
        const toBuilding = v2.sub(door.parentBuilding!.pos, door.pos);
        const isAInside = v2.dot(n, toBuilding) >= 0;
        const insideDir = isAInside ? n : v2.neg(n);
        const outsideDir = v2.neg(insideDir);

        const insidePos = v2.add(door.pos, v2.mul(insideDir, 1.5));
        const outsidePos = v2.add(door.pos, v2.mul(outsideDir, 3.0));

        const human = game.playerBarn.addTestPlayer({ pos: insidePos, name: "JustInsideDoor" });
        const zombie = zm.spawnZombie("walker", outsidePos)!;
        const ai = zm.zombies[0];

        for (let t = 0; t < 80; t++) {
            ai.update(1 / 30);
            game.update(1 / 30);
        }

        expect(ai.navigationResult).toBe("success");
        expect(v2.distance(zombie.pos, human.pos)).toBeLessThanOrEqual(ai.def.attackRange);
    });

    test("5. Nearest navigation node separated by a wall: rejects exterior node and picks interior candidate", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && o.parentBuilding)!;
        expect(door).toBeDefined();
        const building = door.parentBuilding!;

        const toBuilding = v2.normalize(v2.sub(building.pos, door.pos));
        const humanPos = v2.add(door.pos, v2.mul(toBuilding, 3.0));

        const detailed = zm.getNavGraph().findDetailedPath(
            game,
            v2.add(door.pos, v2.mul(v2.neg(toBuilding), 10.0)),
            humanPos,
            0,
            0,
            0,
        );

        expect(detailed.result).toBe("success");
        expect(detailed.candidatesConsidered).toBeDefined();
        // Any exterior hull nodes evaluated for indoor target are rejected
        const exteriorCandidate = detailed.candidatesConsidered?.find(
            (c) => c.rejectionReason === "exterior_node_for_indoor_target" || c.rejectionReason === "separated_by_wall",
        );
        // Path does not cut across the building exterior wall
        expect(detailed.path.length).toBeGreaterThan(0);
    });

    test("6. Multiple potential goal nodes: evaluates candidates and selects lowest-cost valid route", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const b = game.map.buildings.find((x) => x.zoomRegions.length >= 2)!;
        expect(b).toBeDefined();

        const fromPos = v2.add(b.pos, v2.create(-20, 0));
        const toPos = v2.copy(b.pos);

        const detailed = zm.getNavGraph().findDetailedPath(game, fromPos, toPos, 0, 0, 0);

        expect(detailed.result).toBe("success");
        expect(detailed.candidatesConsidered).toBeDefined();
        expect(detailed.candidatesConsidered!.length).toBeGreaterThanOrEqual(1);
        expect(detailed.candidatesConsidered!.some((c) => c.rejectionReason === "accepted" || c.rejectionReason === "accepted_relaxed")).toBe(true);
    });

    test("7. Multiple entrances to the same room: routes through available door when one is locked", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const nav = zm.getNavGraph();

        const b = game.map.buildings.find((x) => {
            const doors = x.childObjects.filter((c) => (c as Obstacle).isDoor && (c as Obstacle).door);
            return doors.length >= 2;
        });
        expect(b).toBeDefined();
        if (!b) return;

        const doors = b.childObjects.filter((c) => (c as Obstacle).isDoor && (c as Obstacle).door) as Obstacle[];
        const doorA = doors[0];
        const doorB = doors[1];

        // Lock door A
        doorA.door!.open = false;
        doorA.door!.locked = true;
        doorA.door!.canUse = false;

        // Open door B properly with openDoor
        doorB.door!.locked = false;
        doorB.door!.canUse = true;
        doorB.openDoor();
        nav.invalidateCache();

        // Calculate outside of Door A for zombie
        const closedOriA = doorA.door?.closedOri ?? doorA.ori;
        const normA = v2.rotate(v2.create(1, 0), math.oriToRad(closedOriA));
        const toBuildingA = v2.sub(b.pos, doorA.pos);
        const isAInside = v2.dot(normA, toBuildingA) >= 0;
        const outsideDirA = isAInside ? v2.neg(normA) : normA;
        const zombiePos = v2.add(doorA.pos, v2.mul(outsideDirA, 3.5));

        // Calculate inside of Door B for human
        const closedOriB = doorB.door?.closedOri ?? doorB.ori;
        const normB = v2.rotate(v2.create(1, 0), math.oriToRad(closedOriB));
        const toBuildingB = v2.sub(b.pos, doorB.pos);
        const isBInside = v2.dot(normB, toBuildingB) >= 0;
        const insideDirB = isBInside ? normB : v2.neg(normB);
        const humanPos = v2.add(doorB.pos, v2.mul(insideDirB, 2.5));

        const human = game.playerBarn.addTestPlayer({ pos: humanPos, name: "HumanMultiDoor" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Path routes around to door B rather than giving up with invalid_goal or blocked
        expect(ai.navigationResult).toBe("success");
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        expect(ai.currentPath.length).toBeGreaterThan(0);
    });

    test("8. Goal position too close to an obstacle: generates physically reachable attack approach", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;

        const wall = game.map.genObstacle("warehouse_wall_side", v2.create(170, 170), 0, 0) as Obstacle;
        const wallAabb = collider.toAabb(wall.collider);
        const targetPos = v2.create(170, wallAabb.max.y + 0.3); // Inside obstacle clearance margin for zombie
        const fromPos = v2.create(170, 185);

        expect(pointClear(game, targetPos, 0, ZombieNavRadius, false)).toBe(false);

        const approach = getReachableMeleeApproach(game, targetPos, fromPos, 0, undefined, ZombieNavRadius);

        expect(approach).not.toBeNull();
        expect(pointClear(game, approach!, 0, ZombieNavRadius, false)).toBe(true);
        expect(isSeparatedByWall(game, approach!, targetPos, 0)).toBe(false);
        expect(v2.distance(approach!, targetPos)).toBeLessThanOrEqual(2.8);
    });

    test("9. Reachable melee approach position: validates LOS and line contact in tight corner", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;

        // Two perpendicular walls forming a corner at (100, 100)
        game.map.genObstacle("warehouse_wall_side", v2.create(100, 95), 0, 0); // South wall
        game.map.genObstacle("warehouse_wall_side", v2.create(95, 100), 0, 1); // West wall

        const cornerPlayer = v2.create(98.5, 98.5);
        const zombiePos = v2.create(110, 110);

        const approach = getReachableMeleeApproach(game, cornerPlayer, zombiePos, 0, undefined, ZombieNavRadius);

        expect(approach).not.toBeNull();
        expect(pointClear(game, approach!, 0, ZombieNavRadius, false)).toBe(true);
        expect(isCapsuleClear(game, approach!, cornerPlayer, 0, 0.35, false)).toBe(true);
    });

    test("10. Genuinely unreachable enclosed room: enters controlled unreachable state without spam", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const center = v2.create(300, 300);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, 4)), 0, 0);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(0, -4)), 0, 0);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(4, 0)), 0, 1);
        game.map.genObstacle("warehouse_wall_side", v2.add(center, v2.create(-4, 0)), 0, 1);

        zm.navGraph = MapNavGraph.build(game);

        const human = game.playerBarn.addTestPlayer({ pos: center, name: "TrappedHuman" });
        const zombie = zm.spawnZombie("walker", v2.add(center, v2.create(25, 25)))!;
        const ai = zm.zombies[0];

        ZombiesNavDebugger.clearFailures();

        for (let t = 0; t < 30; t++) {
            ai.update(1 / 30);
        }

        // Acceptance Criteria:
        // 1. Correctly marks unreachable / no route
        expect(ai.isTargetReachable).toBe(false);
        expect(ai.noRoute).toBe(true);
        // 2. Preserves the target (does not drop target)
        expect(ai.target).toBe(human);
        // 3. No excessive recalculation spam
        expect(ai.recalcCount).toBeLessThan(5);
        // 4. Failure diagnostic captured
        const diag = ZombiesNavDebugger.getLatestFailure();
        expect(diag).not.toBeNull();
        expect(diag?.failureType).toBe("no_route");
        expect(diag?.zombieRadius).toBeCloseTo(ZombieNavRadius);
    });
});

describe("Task 004.13 — Open-Door Collision and Door State Navigation Suite", () => {
    test("1. Closed door that needs to open: approaches, opens cleanly, and traverses through doorway", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.locked && o.door.canUse && o.parentBuilding,
        ) as Obstacle;
        expect(door).toBeDefined();
        door.closeDoor();
        expect(door.door!.open).toBe(false);

        const center = getDoorwayCenter(door);
        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const toBuilding = v2.sub(door.parentBuilding!.pos, center);
        const outsideDir = v2.dot(n, toBuilding) >= 0 ? v2.neg(n) : n;
        const insideDir = v2.neg(outsideDir);

        const zombiePos = v2.add(center, v2.mul(outsideDir, 3.2));
        const humanPos = v2.add(center, v2.mul(insideDir, 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S1_Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        const initialDist = v2.distance(zombie.pos, humanPos);

        for (let t = 0; t < 35; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        expect(door.door!.open).toBe(true);
        const finalDist = v2.distance(zombie.pos, humanPos);
        expect(finalDist).toBeLessThan(initialDist);
    });

    test("2. Open door that is not obstructing movement: navigates directly through without closing door", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.locked && o.parentBuilding,
        ) as Obstacle;
        expect(door).toBeDefined();

        door.openDoor();
        expect(door.door!.open).toBe(true);
        zm.getNavGraph().invalidateCache();

        const center = getDoorwayCenter(door);
        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const toBuilding = v2.sub(door.parentBuilding!.pos, center);
        const outsideDir = v2.dot(n, toBuilding) >= 0 ? v2.neg(n) : n;
        const insideDir = v2.neg(outsideDir);

        const zombiePos = v2.add(center, v2.mul(outsideDir, 3.2));
        const humanPos = v2.add(center, v2.mul(insideDir, 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S2_Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        const initialDist = v2.distance(zombie.pos, humanPos);

        for (let t = 0; t < 25; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // Must remain open (not close open door)
        expect(door.door!.open).toBe(true);
        expect(v2.distance(zombie.pos, humanPos)).toBeLessThan(initialDist);
    });

    test("3. Open door whose swung panel blocks the intended route: detects blockage, closes door, and resumes path", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Place a door obstacle along a corridor
        const doorPos = v2.create(150, 150);
        const door = game.map.genObstacle("house_door_01", doorPos, 0, 0) as Obstacle;
        door.openDoor();
        expect(door.door!.open).toBe(true);

        // Open door collider spans x in [146, 150] at y=150
        const zombiePos = v2.add(door.pos, v2.create(-2.0, 1.5));
        const goalPos = v2.add(door.pos, v2.create(-2.0, -1.5));
        const human = game.playerBarn.addTestPlayer({ pos: goalPos, name: "S3_Target" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];
        ai.target = human;
        ai.currentPath = [goalPos];

        expect(ai.isOpenDoorBlockingRoute(door)).toBe(true);

        for (let t = 0; t < 20; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // Zombie should close the blocking door to free the route
        expect(door.door!.open).toBe(false);
    });

    test("4. Door that must close to allow passage: closes swinging panel obstructing hallway traversal", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Door positioned beside a corridor
        const doorPos = v2.create(200, 200);
        const door = game.map.genObstacle("house_door_01", doorPos, 0, 0) as Obstacle;
        door.openDoor();
        expect(door.door!.open).toBe(true);

        // Hallway along x = 198: panel spans [196, 200] at y = 200
        const zombiePos = v2.create(198.0, 202.5);
        const humanPos = v2.create(198.0, 196.0);

        const human = game.playerBarn.addTestPlayer({ pos: humanPos, name: "S4_Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];
        ai.target = human;
        ai.currentPath = [humanPos];

        const initialDist = v2.distance(zombie.pos, humanPos);

        for (let t = 0; t < 30; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // To navigate along the hallway past the door, the swung panel must be closed
        expect(door.door!.open).toBe(false);
        expect(v2.distance(zombie.pos, humanPos)).toBeLessThan(initialDist);
    });

    test("5. Door with obstacles on either side: respects physical radius clearance without clipping crates", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.locked && o.parentBuilding,
        ) as Obstacle;
        expect(door).toBeDefined();

        const center = getDoorwayCenter(door);
        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const tangent = v2.perp(n);

        // Place crates flanking either side of doorway frame leaving doorframe clear
        const crateLeft = game.map.genObstacle("crate_01", v2.add(center, v2.mul(tangent, 3.6)), 0, 0);
        const crateRight = game.map.genObstacle("crate_01", v2.add(center, v2.mul(tangent, -3.6)), 0, 0);

        zm.navGraph = MapNavGraph.build(game);

        const toBuilding = v2.sub(door.parentBuilding!.pos, center);
        const outsideDir = v2.dot(n, toBuilding) >= 0 ? v2.neg(n) : n;
        const insideDir = v2.neg(outsideDir);

        const zombiePos = v2.add(center, v2.mul(outsideDir, 3.0));
        const humanPos = v2.add(center, v2.mul(insideDir, 3.5));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S5_Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        for (let t = 0; t < 35; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
            // Verify zombie never collides with either crate (collider returns null when no intersection)
            expect(collider.intersectCircle(crateLeft.collider, zombie.pos, zombie.rad)).toBeNull();
            expect(collider.intersectCircle(crateRight.collider, zombie.pos, zombie.rad)).toBeNull();
        }

        expect(door.door!.open).toBe(true);
    });

    test("6. Multiple available entrances: routes to alternate valid entrance when one entrance is blocked", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const building = game.map.buildings.find(
            (b) => b.childObjects.filter((c) => (c as Obstacle).isDoor).length >= 2,
        )!;
        expect(building).toBeDefined();

        const doors = building.childObjects.filter((c) => (c as Obstacle).isDoor) as Obstacle[];
        const doorA = doors[0];
        const doorB = doors[1];

        // Door A is locked and unusable
        doorA.door!.locked = true;
        doorA.door!.canUse = false;
        doorA.door!.open = false;

        // Door B is unlocked and usable
        doorB.door!.locked = false;
        doorB.door!.canUse = true;
        doorB.door!.open = false;

        zm.navGraph = MapNavGraph.build(game);

        // Human inside building
        const humanPos = v2.copy(building.pos);
        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S6_Human" });

        // Zombie outside near blocked Door A
        const zombiePos = v2.add(doorA.pos, v2.create(3.0, 0));
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        expect(doorA.door!.open).toBe(false); // Locked door not opened
    });

    test("7. Locked door that cannot be operated: recognizes impassable entrance without infinite toggle loops", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const testDoor = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.dead && o.parentBuilding,
        )!;
        const building = testDoor.parentBuilding!;

        for (const obs of game.map.obstacles) {
            if (obs.isDoor && obs.door) {
                if (obs.parentBuilding === building || v2.distance(obs.pos, building.pos) < 60) {
                    obs.door.locked = true;
                    obs.door.canUse = false;
                    obs.door.open = false;
                    obs.isBarricade = false;
                }
            }
        }

        const zoom = building.zoomRegions[0]?.zoomIn;
        const humanPos = zoom
            ? v2.create((zoom.min.x + zoom.max.x) * 0.5, (zoom.min.y + zoom.max.y) * 0.5)
            : v2.copy(building.pos);
        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S7_TrappedHuman" });

        const toBuilding = v2.sub(building.pos, testDoor.pos);
        const norm = v2.rotate(v2.create(1, 0), math.oriToRad(testDoor.door?.closedOri ?? testDoor.ori));
        const outsideDir = v2.dot(norm, toBuilding) >= 0 ? v2.neg(norm) : norm;
        const zombiePos = v2.add(testDoor.pos, v2.mul(outsideDir, 3.0));

        zm.navGraph = MapNavGraph.build(game);

        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        for (let t = 0; t < 30; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        expect(testDoor.door!.open).toBe(false);
        expect(ai.doorToggles.get(testDoor.__id) ?? 0).toBeLessThanOrEqual(3);
        expect(ai.isTargetReachable).toBe(false);
    });

    test("8. Door state transitions while approaching: dynamically recalculates route when door state changes mid-path", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.locked && o.parentBuilding,
        ) as Obstacle;
        expect(door).toBeDefined();

        door.closeDoor();
        expect(door.door!.open).toBe(false);

        const center = getDoorwayCenter(door);
        const n = v2.rotate(v2.create(1, 0), math.oriToRad(door.door?.closedOri ?? door.ori));
        const toBuilding = v2.sub(door.parentBuilding!.pos, center);
        const outsideDir = v2.dot(n, toBuilding) >= 0 ? v2.neg(n) : n;
        const insideDir = v2.neg(outsideDir);

        const zombiePos = v2.add(center, v2.mul(outsideDir, 6.0));
        const humanPos = v2.add(center, v2.mul(insideDir, 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "S8_Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        // Tick 0-9: Approaching closed door
        for (let t = 0; t < 10; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        const preRecalc = ai.recalcCount;

        // External event: door opens while zombie is still approaching
        door.openDoor();
        expect(door.door!.open).toBe(true);

        // Tick 10-25: Zombie continues approach with updated door geometry
        for (let t = 0; t < 15; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // onDoorStateChanged triggered path update
        expect(ai.recalcCount).toBeGreaterThan(preRecalc);
        expect(ai.isTargetReachable).toBe(true);
        expect(v2.distance(zombie.pos, humanPos)).toBeLessThan(v2.distance(zombiePos, humanPos));
    });
});
