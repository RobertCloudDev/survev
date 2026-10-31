import { describe, expect, test } from "vitest";
import { Obstacle } from "../../server/src/game/objects/obstacle.ts";
import { Player } from "../../server/src/game/objects/player.ts";
import { hasLineOfSight } from "../../server/src/game/zombiesAI.ts";
import { MapNavGraph, ZombieNavRadius } from "../../server/src/game/zombiesNav.ts";
import {
    DefaultPersonalityWeights,
    type UtilityContext,
    ZombiesUtilityEvaluator,
} from "../../server/src/game/zombiesUtility.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { math } from "../../shared/utils/math.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

describe("Task 004.9 — Six-Need Utility AI & Reliable Navigation Architecture", () => {
    test("1. Six-Need Utility Evaluator: Raw scores and action possibility checks", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(180, 180), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(170, 180))!;
        const evaluator = new ZombiesUtilityEvaluator(DefaultPersonalityWeights.walker);

        // Case A: Distant target with line-of-sight -> High pursuit
        const ctxPursuit: UtilityContext = {
            zombie,
            game,
            target: human,
            lastKnownTargetPos: v2.copy(human.pos),
            distToTarget: 10.0,
            hasLineOfSight: true,
            isTargetReachable: true,
            attackCooldown: 0,
            attackRange: 2.2,
            nearbyObstacleToBreach: null,
            recentDamageTaken: 0,
            timeSinceSawTarget: 0,
            nearbyZombieDensity: 0,
            staggerDuration: 0,
        };

        const resPursuit = evaluator.selectAction(ctxPursuit, "idle", 0);
        expect(resPursuit.selectedAction).toBe("pursuit");
        expect(resPursuit.needs.pursuit).toBeGreaterThan(60);
        expect(resPursuit.needs.attack).toBe(0); // Not within attackRange

        // Case B: In melee attack range with line of sight -> High attack
        const ctxAttack: UtilityContext = {
            ...ctxPursuit,
            distToTarget: 1.8,
        };
        const resAttack = evaluator.selectAction(ctxAttack, "pursuit", 0);
        expect(resAttack.selectedAction).toBe("attack");
        expect(resAttack.needs.attack).toBeGreaterThan(resAttack.needs.pursuit);

        // Case C: Target in melee distance but behind solid wall -> Attack IMPOSSIBLE, falls back to pursuit/investigate
        const ctxBehindWall: UtilityContext = {
            ...ctxAttack,
            hasLineOfSight: false,
        };
        expect(evaluator.isActionPossible("attack", ctxBehindWall)).toBe(false);
        const resBehindWall = evaluator.selectAction(ctxBehindWall, "attack", 0);
        expect(resBehindWall.selectedAction).not.toBe("attack");
    });

    test("2. Behavioral Commitment and Hysteresis: Prevents rapid oscillation between close needs", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(180, 180), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(170, 180))!;
        const evaluator = new ZombiesUtilityEvaluator(DefaultPersonalityWeights.walker);

        // Setup context where investigate is slightly higher than pursuit if uncommitted
        const ctx: UtilityContext = {
            zombie,
            game,
            target: human,
            lastKnownTargetPos: v2.create(174, 180),
            distToTarget: 15.0,
            hasLineOfSight: false,
            isTargetReachable: true,
            attackCooldown: 0,
            attackRange: 2.2,
            nearbyObstacleToBreach: null,
            recentDamageTaken: 0,
            timeSinceSawTarget: 0.8,
            nearbyZombieDensity: 0,
            staggerDuration: 0,
        };

        // When committed to pursuit with commitmentTimer > 0, pursuit retains inertia due to hysteresis bonus
        const resCommitted = evaluator.selectAction(ctx, "pursuit", 0.5);
        expect(resCommitted.selectedAction).toBe("pursuit");
        expect(resCommitted.decisionReason).toContain("hysteresis_committed");

        // When uncommitted (timer = 0), the evaluator can transition
        const resUncommitted = evaluator.selectAction(ctx, "idle", 0);
        expect(resUncommitted.selectedAction).toBeDefined();
    });

    test("3. Personality Weights: Runner vs Tank vs Walker distinct priorities", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(180, 180), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(170, 180))!;

        const walkerEval = new ZombiesUtilityEvaluator(DefaultPersonalityWeights.walker);
        const runnerEval = new ZombiesUtilityEvaluator(DefaultPersonalityWeights.runner);
        const tankEval = new ZombiesUtilityEvaluator(DefaultPersonalityWeights.tank);

        const ctx: UtilityContext = {
            zombie,
            game,
            target: human,
            lastKnownTargetPos: v2.copy(human.pos),
            distToTarget: 12.0,
            hasLineOfSight: true,
            isTargetReachable: true,
            attackCooldown: 0,
            attackRange: 2.2,
            nearbyObstacleToBreach: null,
            recentDamageTaken: 0,
            timeSinceSawTarget: 0,
            nearbyZombieDensity: 0,
            staggerDuration: 0,
        };

        const walkerNeeds = walkerEval.evaluateNeeds(ctx);
        const runnerNeeds = runnerEval.evaluateNeeds(ctx);
        const tankNeeds = tankEval.evaluateNeeds(ctx);

        // Runner has higher pursuit weight (1.35) than Walker (1.0) and Tank (0.9)
        expect(runnerNeeds.pursuit).toBeGreaterThan(walkerNeeds.pursuit);
        expect(walkerNeeds.pursuit).toBeGreaterThan(tankNeeds.pursuit);
    });

    test("4. Attack range and Line-of-Sight validation: Cannot attack through walls", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Spawn a brick wall between human and zombie
        const wall = game.map.genObstacle("warehouse_wall_edge_2", v2.create(180, 180), 0, 0) as Obstacle;
        const human = game.playerBarn.addTestPlayer({ pos: v2.create(182, 180), name: "HumanBehindWall" });
        const zombie = zm.spawnZombie("walker", v2.create(178, 180))!;
        const ai = zm.zombies[0];

        // Verify line of sight is blocked by the wall
        const los = hasLineOfSight(game, zombie.pos, human.pos, zombie.layer);
        expect(los).toBe(false);

        // Run AI update
        ai.update(1 / 30);

        // Zombie must NOT select attack action when wall blocks line of sight
        expect(ai.activeAction).not.toBe("attack");
        expect(human.health).toBe(100); // Unharmed
    });

    test("5. Breach action: Zombie opens closed unlocked door along route", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && !o.door.open && !o.door.locked);
        expect(door).toBeDefined();
        if (!door || !door.door) return;

        door.door.open = false;
        door.door.locked = false;

        const doorNorm = v2.rotate(v2.create(1, 0), math.oriToRad(door.door.closedOri ?? door.ori));
        const zombiePos = v2.add(door.pos, v2.mul(doorNorm, 2.0));
        const humanPos = v2.add(door.pos, v2.mul(v2.neg(doorNorm), 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "SurvivorInside" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Zombie near closed door should evaluate breach or open door along route
        expect(door.door.open).toBe(true);
    });

    test("6. Breach action: Zombie attacks and destroys breakable barricade", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const barricade = game.map.genObstacle("crate_01", v2.create(180, 180), 0, 0) as Obstacle;
        barricade.isBarricade = true;
        barricade.destructible = true;
        barricade.health = 30;
        barricade.maxHealth = 30;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(184, 180), name: "SurvivorBehindBarricade" });
        zm.spawnZombie("walker", v2.create(178.5, 180))!;
        const ai = zm.zombies[0];

        // Update AI: within 1.5u of barricade, breach utility triggers melee strike on barricade
        ai.update(1 / 30);
        expect(ai.activeAction).toBe("breach");

        // Simulate a few ticks to verify barricade takes damage
        ai.attackCooldownTimer = 0;
        ai.update(1 / 30);
        expect(barricade.health).toBeLessThan(30);
    });

    test("7. Survival action: Triggered by damage and stagger", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(180, 180), name: "Shooter" });
        const zombie = zm.spawnZombie("walker", v2.create(170, 180))!;
        const ai = zm.zombies[0];

        // Deal high burst damage to zombie
        ai.takeDamage(40, human);
        expect(ai.staggerDuration).toBeGreaterThan(0);

        ai.update(1 / 30);
        expect(ai.activeAction).toBe("survival");
        expect(ai.zombie.touchMoveActive).toBe(false); // Pauses while staggered
    });

    test("8. Swarm / Group action: Density triggers lateral dispersion", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(200, 180), name: "SurvivorFar" });
        // Spawn 3 zombies in a cluster
        const z1 = zm.spawnZombie("walker", v2.create(170, 180))!;
        const z2 = zm.spawnZombie("walker", v2.create(170.5, 180.5))!;
        const z3 = zm.spawnZombie("walker", v2.create(170.2, 179.5))!;

        const ai1 = zm.zombies[0];
        ai1.update(1 / 30);

        // Density is at least 2 other zombies nearby
        expect(ai1.countNearbyZombies(3.5)).toBeGreaterThanOrEqual(2);
        // Strafe jitter is active on moveDir
        expect(Math.abs(ai1.zombie.touchMoveDir.y)).toBeGreaterThan(0);
    });

    test("9. Furniture obstacles: Indoor furniture does not block pathfinding", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Place a table / crate furniture obstacle
        const table = game.map.genObstacle("table_01", v2.create(180, 180), 0, 0) as Obstacle;
        table.collidable = true;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(185, 180), name: "SurvivorPastTable" });
        zm.spawnZombie("walker", v2.create(175, 180))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        expect(ai.isTargetReachable).toBe(true);
        expect(ai.noRoute).toBe(false);
        expect(ai.currentPath.length).toBeGreaterThan(0);
    });

    test("10. Failure A reproduction: Zombie near already-open door traverses cleanly without getting stuck", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door);
        expect(door).toBeDefined();
        if (!door || !door.door) return;

        // Open door already
        door.door.open = true;
        door.door.locked = false;

        const doorNorm = v2.rotate(v2.create(1, 0), math.oriToRad(door.door.closedOri ?? door.ori));
        const zombiePos = v2.add(door.pos, v2.mul(doorNorm, 2.0));
        const humanPos = v2.add(door.pos, v2.mul(v2.neg(doorNorm), 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "SurvivorFailureA" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Must traverse directly through without repeated door interactions or stuck states
        expect(ai.doorInteractionAttempts).toBe(0); // Door was already open, zero interactions needed
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.currentPath.length).toBeGreaterThan(0);
    });

    test("11. Failure B reproduction: Zombie and target separated by wall do not share node or walk into wall", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Exterior wall
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(100, 100), 0, 0);

        // Zombie on one side, target closely on other side
        const human = game.playerBarn.addTestPlayer({ pos: v2.create(100, 102.5), name: "BehindWallB" });
        zm.spawnZombie("walker", v2.create(100, 97.5))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // Zombie must not attempt direct pursuit through the wall
        expect(ai.lastRecalcReason).not.toBe("direct_pursuit");
    });

    test("12. Failure C reproduction: Multi-room building connectivity through doors", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && o.parentBuilding);
        expect(door).toBeDefined();
        if (!door || !door.door) return;

        door.door.open = false;
        door.door.locked = false;
        door.door.canUse = true;

        const doorNorm = v2.rotate(v2.create(1, 0), math.oriToRad(door.door.closedOri ?? door.ori));
        const zombiePos = v2.add(door.pos, v2.mul(doorNorm, 3.5));
        const humanPos = v2.add(door.pos, v2.mul(v2.neg(doorNorm), 4.0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "MultiRoomSurvivor" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        // In multi-room building, route must connect through door rather than returning NO_ROUTE
        expect(ai.noRoute).toBe(false);
        expect(ai.isTargetReachable).toBe(true);
        expect(ai.currentPath.length).toBeGreaterThan(0);
    });
});
