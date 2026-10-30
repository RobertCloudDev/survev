import type { Game } from "./game.ts";

export class ZombiesManager {
    readonly game: Game;
    wave = 1;
    intermission = false;
    intermissionTimer = 0;

    constructor(game: Game) {
        this.game = game;
    }

    update(_dt: number): void {
        // Minimal stub for milestone 003 - no AI enemies yet
    }
}
