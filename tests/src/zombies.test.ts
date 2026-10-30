import { describe, expect, test } from "vitest";
import { TeamMode } from "../../shared/gameConfig.ts";
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
