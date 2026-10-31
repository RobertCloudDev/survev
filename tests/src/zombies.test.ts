import { describe, expect, test } from "vitest";
import { ZombiesNavDebugger } from "../../server/src/game/zombiesDebug.ts";
import { isCapsuleClear, MapNavGraph, ZombieNavRadius } from "../../server/src/game/zombiesNav.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

describe("Zombies Mode Foundation", () => {
    test("Initializes ZombiesManager and mode isolation on zombies_cyberpunk map", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        expect(game.map.zombiesMode).toBe(true);
        expect(game.zombiesManager).toBeDefined();
        expect(game.modeManager.mode).toBe(3); // GameMode.Zombies

        // Gas should be inactive/disabled in Zombies mode
        expect(game.gas.damage).toBe(0);
    });

    test("Standard BR game does not initialize ZombiesManager or zombiesMode", () => {
        const game = createGame(TeamMode.Solo, "test_normal");
        expect(game.map.zombiesMode).toBe(false);
        expect(game.zombiesManager).toBeUndefined();
        expect(game.modeManager.mode).toBe(0); // GameMode.Solo
    });

    test("Human player counts exclude AI entities and control game-over lifecycle", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;

        // Add 1 human player
        const human = game.playerBarn.addTestPlayer({ name: "HumanSurvivor" });
        expect(human.isZombie).toBe(false);
        expect(game.modeManager.aliveCount()).toBe(1);
        expect(game.modeManager.isGameOver()).toBe(false);

        // Add 3 zombie AI entities (simulating spawned AI)
        const zombie1 = game.playerBarn.addTestPlayer({ name: "Zombie_1" });
        zombie1.isZombie = true;
        const zombie2 = game.playerBarn.addTestPlayer({ name: "Zombie_2" });
        zombie2.isZombie = true;
        const zombie3 = game.playerBarn.addTestPlayer({ name: "Zombie_3" });
        zombie3.isZombie = true;

        // Human alive count must strictly be 1, ignoring the 3 zombies
        expect(game.modeManager.aliveCount()).toBe(1);
        expect(game.playerBarn.livingPlayers.length).toBe(4);
        expect(game.modeManager.isGameOver()).toBe(false);

        // Kill the human player
        human.dead = true;
        const livingIdx = game.playerBarn.livingPlayers.indexOf(human);
        if (livingIdx !== -1) {
            game.playerBarn.livingPlayers.splice(livingIdx, 1);
        }

        // Alive count must now be 0 human survivors, triggering game over despite living zombies
        expect(game.modeManager.aliveCount()).toBe(0);
        expect(game.modeManager.isGameOver()).toBe(true);
    });
});

describe("Zombie Spawning & Lifecycle", () => {
    test("Delays spawning until a living human exists, then spawns exactly one prototype zombie", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        expect(zm).toBeDefined();

        // No human players yet -> update should NOT spawn any zombies
        zm.update(1 / 30);
        expect(zm.hasSpawnedTestZombie).toBe(false);
        expect(zm.zombies.length).toBe(0);

        // Add a human survivor
        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });

        // Update manager -> exactly one test zombie is spawned
        zm.update(1 / 30);
        expect(zm.hasSpawnedTestZombie).toBe(true);
        expect(zm.zombies.length).toBe(1);

        const zombieAI = zm.zombies[0];
        const zombie = zombieAI.zombie;

        expect(zombie.isZombie).toBe(true);
        expect(zombie.health).toBe(100);
        expect(zombie.outfit).toBe("outfitVerde");
        expect(zombie.speed).toBeCloseTo(GameConfig.player.moveSpeed * 0.65, 1);

        // Spawns at a reasonable distance from human
        const dist = v2.distance(zombie.pos, human.pos);
        expect(dist).toBeGreaterThan(10);
        expect(dist).toBeLessThan(35);

        // Subsequent manager updates do not spawn additional zombies
        zm.update(1 / 30);
        zm.update(1 / 30);
        expect(zm.zombies.length).toBe(1);

        // Alive count ignores the zombie
        expect(game.modeManager.aliveCount()).toBe(1);
    });

    test("Zombie target selection finds nearest living human and excludes dead or zombie entities", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human1 = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "NearHuman",
        });
        const human2 = game.playerBarn.addTestPlayer({
            pos: v2.create(200, 200),
            name: "FarHuman",
        });

        zm.update(1 / 30);
        expect(zm.zombies.length).toBe(1);
        const ai = zm.zombies[0];

        // Should target nearest human (human1)
        expect(ai.findTarget()).toBe(human1);

        // Mark human1 as dead
        human1.dead = true;
        // Should retarget living human2
        expect(ai.findTarget()).toBe(human2);

        // Mark human2 dead as well
        human2.dead = true;
        // Should find no valid target (ignores self and other zombies)
        expect(ai.findTarget()).toBeNull();
    });

    test("Zombie movement and obstacle collision respect archetype speed", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });

        zm.update(1 / 30);
        const ai = zm.zombies[0];
        const zombie = ai.zombie;

        // Position zombie far enough away to trigger chase
        zombie.pos = v2.create(120, 140);
        ai.target = human;

        ai.update(1 / 30);
        expect(ai.state).toBe("chase");
        expect(zombie.touchMoveActive).toBe(true);
        expect(zombie.touchMoveDir.x).toBeGreaterThan(0); // moving right towards human at (140, 140)
        expect(zombie.speed).toBeCloseTo(GameConfig.player.moveSpeed * 0.65, 1);
    });

    test("Melee combat deals damage and respects cooldown", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });
        human.health = 100;

        zm.update(1 / 30);
        const ai = zm.zombies[0];
        const zombie = ai.zombie;

        // Position zombie right next to human within melee range (<= 2.8)
        zombie.pos = v2.create(140, 141.5);
        ai.target = human;
        ai.attackCooldownTimer = 0;

        // First attack tick
        ai.update(1 / 30);
        expect(ai.state).toBe("attack");
        expect(human.health).toBe(85); // 100 - 15 damage
        expect(ai.attackCooldownTimer).toBeCloseTo(1.2, 1);

        // Next tick (cooldown still active) -> no extra damage
        ai.update(0.1);
        expect(human.health).toBe(85);

        // Advance past cooldown (1.2s)
        ai.attackCooldownTimer = 0;
        ai.update(1 / 30);
        expect(human.health).toBe(70); // 85 - 15 damage
    });

    test("Zombies take weapon damage, avoid friendly fire, and exclude PvP statistics", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });

        zm.update(1 / 30);
        const ai = zm.zombies[0];
        const zombie = ai.zombie;

        // Friendly fire check between two zombies
        const zombie2 = game.playerBarn.addTestPlayer({ pos: v2.create(142, 140) });
        zombie2.isZombie = true;

        const initialZombieHealth = zombie.health;
        zombie.damage({
            amount: 15,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: zombie2,
        });
        // Damage should be ignored (zombies do not hurt each other)
        expect(zombie.health).toBe(initialZombieHealth);

        // Human damage to zombie
        zombie.damage({
            amount: 30,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: human,
        });
        expect(zombie.health).toBe(70);
        // PvP stats for human should not be contaminated
        expect(human.damageDealt).toBe(0);
    });

    test("Zombie death cleans up AI state without ending the game", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });

        zm.update(1 / 30);
        const ai = zm.zombies[0];
        const zombie = ai.zombie;

        // Kill the zombie
        zombie.damage({
            amount: 100,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: human,
        });

        expect(zombie.dead).toBe(true);
        // Killing zombie must not grant PvP kill credit
        expect(human.kills).toBe(0);

        // Next manager update cleans up the AI
        zm.update(1 / 30);
        expect(zm.zombies.length).toBe(0);

        // Game session is still alive because human is alive
        expect(game.modeManager.aliveCount()).toBe(1);
        expect(game.modeManager.isGameOver()).toBe(false);

        // Now killing the human ends the game
        human.damage({
            amount: 100,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
        });
        expect(human.dead).toBe(true);
        expect(game.modeManager.aliveCount()).toBe(0);
        expect(game.modeManager.isGameOver()).toBe(true);
    });

    test("Zombies are excluded from match rankings, player status lists, and spectating", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({
            pos: v2.create(140, 140),
            name: "Survivor",
        });

        zm.update(1 / 30);
        expect(zm.zombies.length).toBe(1);
        const zombie = zm.zombies[0].zombie;

        // Player status should only contain humans
        const statusPlayers = game.modeManager.getPlayerStatusPlayers(human);
        expect(statusPlayers).toContain(human);
        expect(statusPlayers).not.toContain(zombie);

        // Match rankings should only contain humans
        const rankings = game.modeManager.getPlayersSortedByRank();
        expect(rankings.some((r) => r.player === human)).toBe(true);
        expect(rankings.some((r) => r.player === zombie)).toBe(false);

        // Spectating list for client should not include zombies
        const spectables = human.client.getSpectablePlayers();
        expect(spectables.includes(zombie)).toBe(false);
    });
});

describe("Zombie Navigation & Movement Refinement (Task 004.5)", () => {
    test("1. Zombie follows player in open space", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;
        game.playerBarn.addTestPlayer({ pos: v2.create(50, 50), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.create(50, 70))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.state).toBe("chase");
        expect(zombie.touchMoveActive).toBe(true);
        // Direct south pursuit towards (50, 50)
        expect(zombie.touchMoveDir.y).toBeLessThan(-0.9);
        expect(Math.abs(zombie.touchMoveDir.x)).toBeLessThan(0.1);
        expect(v2.dot(zombie.touchMoveDir, v2.create(0, -1))).toBeGreaterThan(0.95);
    });

    test("2. Zombie navigates around a wall", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const wall = game.map.obstacles.find((o) => o.isWall && !o.dead && o.collidable)!;
        expect(wall).toBeDefined();

        const humanPos = v2.add(wall.pos, v2.create(-8, 0));
        const zombiePos = v2.add(wall.pos, v2.create(8, 0));
        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Human" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.state).toBe("chase");
        expect(ai.currentPath.length).toBeGreaterThan(0);
        // Direct vector into wall is (-1, 0). Path directs around wall rather than walking straight into it
        expect(v2.dot(zombie.touchMoveDir, v2.create(-1, 0))).toBeLessThan(0.85);
    });

    test("3. Zombie opens an ordinary closed door", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.open && !o.door.locked && o.door.canUse,
        )!;
        expect(door).toBeDefined();
        expect(door.door!.open).toBe(false);

        const zombiePos = v2.add(door.pos, v2.create(1.2, 0));
        const humanPos = v2.add(door.pos, v2.create(-6, 0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Human" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(door.door!.open).toBe(true);
    });

    test("4. Zombie does not open locked doors", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && !o.door.open)!;
        expect(door).toBeDefined();
        door.door!.locked = true;
        door.door!.canUse = false;

        const zombiePos = v2.add(door.pos, v2.create(1.2, 0));
        const humanPos = v2.add(door.pos, v2.create(-6, 0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Human" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(door.door!.open).toBe(false);
    });

    test("5. Zombie enters a building through a valid entrance", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const b = game.map.buildings[0];
        expect(b).toBeDefined();
        const humanInside = game.playerBarn.addTestPlayer({ pos: v2.copy(b.pos), name: "HumanInside" });

        const zombieOutside = zm.spawnZombie("walker", v2.add(b.pos, v2.create(35, 35)))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(ai.currentPath[ai.currentPath.length - 1]).toEqual(humanInside.pos);
        expect(zombieOutside.touchMoveActive).toBe(true);
    });

    test("6. Zombie follows a player between rooms", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const b = game.map.buildings[0];
        const human = game.playerBarn.addTestPlayer({ pos: v2.add(b.pos, v2.create(-5, -5)), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.add(b.pos, v2.create(5, 5)))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.target).toBe(human);

        // Relocate player to another room
        human.pos = v2.add(b.pos, v2.create(8, -8));
        ai.pathRecalcTimer = 0;
        ai.update(1 / 30);

        expect(ai.target).toBe(human);
        expect(zombie.touchMoveActive).toBe(true);
    });

    test("7. Zombie exits a building when the player leaves", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const b = game.map.buildings[0];
        const human = game.playerBarn.addTestPlayer({ pos: v2.add(b.pos, v2.create(40, 40)), name: "HumanOutside" });
        const zombie = zm.spawnZombie("walker", v2.copy(b.pos))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(ai.currentPath[ai.currentPath.length - 1]).toEqual(human.pos);
        expect(zombie.touchMoveActive).toBe(true);
    });

    test("8. Zombie does not oscillate indefinitely near an obstacle", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const wall = game.map.obstacles.find((o) => o.isWall && !o.dead && o.collidable)!;
        game.playerBarn.addTestPlayer({ pos: v2.add(wall.pos, v2.create(0, -10)), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.add(wall.pos, v2.create(0, 10)))!;
        const ai = zm.zombies[0];

        const directions: Vec2[] = [];
        for (let t = 0; t < 20; t++) {
            ai.update(1 / 30);
            directions.push(v2.copy(zombie.touchMoveDir));
        }

        // Check for direction thrashing (reversals where dot product is < -0.7)
        let reversals = 0;
        for (let i = 1; i < directions.length; i++) {
            const dot = v2.dot(directions[i - 1], directions[i]);
            if (dot < -0.7) reversals++;
        }
        expect(reversals).toBe(0);
    });

    test("9. Zombie cannot attack through solid walls", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const wall = game.map.obstacles.find((o) => o.isWall && !o.dead && o.collidable)!;
        const human = game.playerBarn.addTestPlayer({ pos: v2.add(wall.pos, v2.create(0, -1.0)), name: "Human" });
        human.health = 100;
        zm.spawnZombie("walker", v2.add(wall.pos, v2.create(0, 1.0)))!;
        const ai = zm.zombies[0];
        ai.attackCooldownTimer = 0;

        ai.update(1 / 30);
        // Wall blocks melee attack
        expect(human.health).toBe(100);
    });

    test("10. Zombie death cleans up AI and navigation state", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(140, 140), name: "Survivor" });
        const zombie = zm.spawnZombie("walker", v2.create(140, 160))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(zm.zombies.length).toBe(1);

        zombie.damage({ amount: 100, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0), source: human });
        expect(zombie.dead).toBe(true);

        zm.update(1 / 30);
        expect(ai.isDead).toBe(true);
        expect(ai.target).toBeNull();
        expect(ai.currentPath.length).toBe(0);
        expect(zm.zombies.length).toBe(0);
    });
});

describe("Deterministic Navigation & Clearance Regression Suite (Task 004.5 Overhaul)", () => {
    test("A. Navigates around an L-shaped corner with full physical radius clearance", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        // Two perpendicular walls meeting at (80, 80)
        // Vertical leg: spans y in [80, 93], x in [79.4, 80.6]
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(80, 86.5), 0, 0);
        // Horizontal leg: spans x in [80, 93], y in [79.4, 80.6]
        game.map.genObstacle("warehouse_wall_edge_2", v2.create(86.5, 80), 0, 1);

        const nav = MapNavGraph.build(game);

        // Target on one side of L-corner, zombie on the other
        const zombiePos = v2.create(86, 86);
        const humanPos = v2.create(74, 74);

        // Direct walk is blocked by the L-shaped corner
        expect(isCapsuleClear(game, zombiePos, humanPos, 0, ZombieNavRadius, true)).toBe(false);

        const path = nav.path(game, zombiePos, humanPos, 0, 0);
        expect(path).toBeDefined();
        expect(path!.length).toBeGreaterThan(1);

        // Every intermediate segment along the path must have verified capsule clearance
        for (let i = 1; i < path!.length; i++) {
            expect(isCapsuleClear(game, path![i - 1], path![i], 0, ZombieNavRadius, true)).toBe(true);
        }
    });

    test("B. Traverses narrow doorway cleanly without getting stuck on frame", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find(
            (o) => o.isDoor && o.door && !o.door.locked && o.door.canUse,
        )!;
        expect(door).toBeDefined();

        const nav = zm.getNavGraph();
        const approaches = nav.nodes.filter(
            (n) => n.kind === "door" && v2.distance(n.pos, door.pos) > 1.0 && v2.distance(n.pos, door.pos) < 3.5,
        );
        expect(approaches.length).toBeGreaterThanOrEqual(2);

        const zombiePos = approaches[0].pos;
        const humanPos = approaches[1].pos;

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Survivor" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        const initialDist = v2.distance(zombiePos, door.pos);

        // First tick opens closed door
        ai.update(1 / 30);
        expect(door.door!.open).toBe(true);

        // Simulate 20 movement ticks towards the doorway
        for (let t = 0; t < 20; t++) {
            ai.update(1 / 30);
            zombie.update(1 / 30);
        }

        // Zombie moves steadily closer to or through doorway
        const distToDoor = v2.distance(zombie.pos, door.pos);
        expect(distToDoor).toBeLessThan(initialDist);
    });

    test("C. Follows player between multiple rooms in a complex building", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const building = game.map.buildings[0];
        expect(building).toBeDefined();
        expect(building.zoomRegions.length).toBeGreaterThanOrEqual(1);

        // Start survivor in one part of building, zombie outside
        const human = game.playerBarn.addTestPlayer({
            pos: v2.add(building.pos, v2.create(-4, -4)),
            name: "Survivor",
        });

        const zombie = zm.spawnZombie("walker", v2.add(building.pos, v2.create(40, 40)))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        // Relocate player deeper into another room
        human.pos = v2.add(building.pos, v2.create(6, 6));
        ai.pathRecalcTimer = 0;
        ai.update(1 / 30);

        expect(ai.target).toBe(human);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(zombie.touchMoveActive).toBe(true);
    });

    test("D. Navigates around furniture blocking direct route with physical clearance", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const crate = game.map.obstacles.find(
            (o) => !o.dead && o.collidable && !o.isWall && !o.isDoor,
        )!;
        expect(crate).toBeDefined();

        const zombiePos = v2.add(crate.pos, v2.create(0, 5));
        const humanPos = v2.add(crate.pos, v2.create(0, -5));

        // Direct path intersects the crate obstacle
        expect(isCapsuleClear(game, zombiePos, humanPos, crate.layer, ZombieNavRadius, false)).toBe(false);

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Survivor" });
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        // AI does not attempt direct line straight through crate
        const directSouth = v2.create(0, -1);
        expect(v2.dot(zombie.touchMoveDir, directSouth)).toBeLessThan(0.85);
    });

    test("E. Player standing next to exterior wall routes through entrance rather than clipping wall", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const building = game.map.buildings[0];
        expect(building).toBeDefined();

        // Place human survivor inside building, 1 unit away from interior bounds
        const zoom = building.zoomRegions[0].zoomIn;
        const humanPos = zoom
            ? v2.create(zoom.min.x + 1.2, zoom.min.y + 1.2)
            : v2.copy(building.pos);

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "SurvivorWall" });

        // Zombie outside building
        const zombiePos = v2.add(building.pos, v2.create(35, 35));
        const zombie = zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);

        // Destination must be in building, reaching the human
        expect(zombie.touchMoveActive).toBe(true);
        const lastNode = ai.currentPath[ai.currentPath.length - 1];
        expect(v2.distance(lastNode, humanPos)).toBeLessThan(2.0);
    });

    test("F. Locked door is recognized as impassable and cannot be opened", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const door = game.map.obstacles.find((o) => o.isDoor && o.door && !o.door.open)!;
        expect(door).toBeDefined();
        door.door!.locked = true;
        door.door!.canUse = false;

        const zombiePos = v2.add(door.pos, v2.create(1.2, 0));
        const humanPos = v2.add(door.pos, v2.create(-6, 0));

        game.playerBarn.addTestPlayer({ pos: humanPos, name: "Human" });
        zm.spawnZombie("walker", zombiePos)!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);
        // Door remains locked and closed
        expect(door.door!.open).toBe(false);
    });

    test("G. Successfully exits building when player flees outdoors, and re-enters when player returns", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const building = game.map.buildings[0];
        const human = game.playerBarn.addTestPlayer({
            pos: v2.add(building.pos, v2.create(45, 45)),
            name: "SurvivorOutside",
        });

        // Zombie starts inside building
        const zombie = zm.spawnZombie("walker", v2.copy(building.pos))!;
        const ai = zm.zombies[0];

        // 1. Exit route
        ai.update(1 / 30);
        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(zombie.touchMoveActive).toBe(true);

        // 2. Player returns inside building (placed across room away from zombie so it enters chase)
        human.pos = v2.add(building.pos, v2.create(12, 12));
        ai.pathRecalcTimer = 0;
        ai.update(1 / 30);

        expect(ai.currentPath.length).toBeGreaterThan(0);
        expect(zombie.touchMoveActive).toBe(true);
    });

    test("H. Navigation diagnostics records snapshots and events when enabled", () => {
        ZombiesNavDebugger.enabled = true;
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const human = game.playerBarn.addTestPlayer({ pos: v2.create(100, 100), name: "Survivor" });
        const zombie = zm.spawnZombie("walker", v2.create(100, 130))!;
        const ai = zm.zombies[0];

        ai.update(1 / 30);

        const snap = ZombiesNavDebugger.getSnapshot(zombie.__id);
        expect(snap).toBeDefined();
        expect(snap!.zombieId).toBe(zombie.__id);
        expect(snap!.targetPos).toBeDefined();
        expect(snap!.pathLength).toBeGreaterThan(0);

        ZombiesNavDebugger.enabled = false;
    });

    test("I. Prevents directional oscillation and waypoint flipping over 30 ticks", () => {
        const game = createGame(TeamMode.Solo, "zombies_cyberpunk");
        game.preventStart = true;
        const zm = game.zombiesManager!;

        const wall = game.map.obstacles.find((o) => o.isWall && !o.dead && o.collidable)!;
        game.playerBarn.addTestPlayer({ pos: v2.add(wall.pos, v2.create(0, -12)), name: "Human" });
        const zombie = zm.spawnZombie("walker", v2.add(wall.pos, v2.create(0, 12)))!;
        const ai = zm.zombies[0];

        const dirs: Vec2[] = [];
        for (let t = 0; t < 30; t++) {
            ai.update(1 / 30);
            dirs.push(v2.copy(zombie.touchMoveDir));
        }

        // Test for contradictory sharp reversals (dot product < -0.7)
        let reversals = 0;
        for (let i = 1; i < dirs.length; i++) {
            if (v2.dot(dirs[i - 1], dirs[i]) < -0.7) reversals++;
        }
        expect(reversals).toBe(0);
    });
});
