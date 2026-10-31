import { type ZombieDef, ZombieDefs } from "../../../shared/defs/gameObjects/zombieDefs.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import { MsgType, ZombiesNavDebugMsg } from "../../../shared/net/net.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import { isPositionPassable, ZombieAI } from "./zombiesAI.ts";
import { ZombiesNavDebugger } from "./zombiesDebug.ts";
import { MapNavGraph } from "./zombiesNav.ts";

export class ZombiesManager {
    readonly game: Game;
    wave = 1;
    intermission = false;
    intermissionTimer = 0;

    hasSpawnedTestZombie = false;
    zombies: ZombieAI[] = [];
    navGraph?: MapNavGraph;
    debugBroadcastTimer = 0;

    constructor(game: Game) {
        this.game = game;
    }

    getNavGraph(): MapNavGraph {
        if (!this.navGraph) {
            this.navGraph = MapNavGraph.build(this.game);
        }
        return this.navGraph;
    }

    onDoorStateChanged(door: Obstacle): void {
        this.navGraph?.invalidateCache();
        for (let i = 0; i < this.zombies.length; i++) {
            const ai = this.zombies[i];
            const dist = v2.distance(ai.zombie.pos, door.pos);
            if (dist < 45.0 || ai.noRoute) {
                ai.onDoorStateChanged(door);
            }
        }
    }

    /**
     * Finds a valid collision-free spawn position at a reasonable distance from the given origin.
     */
    findZombieSpawnPos(origin: Vec2): Vec2 | undefined {
        const radii = [18, 24, 14, 28];
        const numAngles = 16;

        for (const r of radii) {
            for (let i = 0; i < numAngles; i++) {
                const angle = (i / numAngles) * 2 * Math.PI;
                const pos = v2.add(origin, v2.create(Math.cos(angle) * r, Math.sin(angle) * r));

                if (!isPositionPassable(this.game, pos, GameConfig.player.radius + 0.5, 0)) {
                    continue;
                }

                // If map provides canPlayerSpawn, use it as extra verification (water, buildings, etc.)
                if (this.game.map.canPlayerSpawn && !this.game.map.canPlayerSpawn(pos)) {
                    continue;
                }

                return pos;
            }
        }

        // Fallback: search around map center
        const center = v2.create(this.game.map.width / 2, this.game.map.height / 2);
        if (isPositionPassable(this.game, center, GameConfig.player.radius, 0)) {
            return center;
        }

        return undefined;
    }

    /**
     * Spawns a zombie entity authored by authoritative server.
     */
    spawnZombie(archetype = "walker", spawnPos?: Vec2): Player | undefined {
        const def: ZombieDef = ZombieDefs[archetype] ?? ZombieDefs.walker;
        const pos = spawnPos ?? this.findZombieSpawnPos(v2.create(this.game.map.width / 2, this.game.map.height / 2));

        if (!pos) {
            return undefined;
        }

        const zombie = this.game.playerBarn.addTestPlayer({
            pos,
            name: def.name,
        });

        zombie.isZombie = true;
        zombie.zombieDef = def;
        zombie.health = def.health;
        zombie.setOutfit(def.outfit);
        zombie.recalculateSpeed(false);

        const ai = new ZombieAI(zombie, this.game, def, this.getNavGraph());
        this.zombies.push(ai);
        this.hasSpawnedTestZombie = true;

        return zombie;
    }

    update(dt: number): void {
        // Only run when zombiesMode is active
        if (!this.game.map.zombiesMode) return;

        // Spawn single prototype zombie when a valid living human player exists
        if (!this.hasSpawnedTestZombie) {
            const livingHuman = this.game.playerBarn.livingPlayers.find(
                (p) => !p.isZombie && !p.dead,
            );

            if (livingHuman) {
                const spawnPos = this.findZombieSpawnPos(livingHuman.pos);
                if (spawnPos) {
                    this.spawnZombie("walker", spawnPos);
                    this.hasSpawnedTestZombie = true;
                }
            }
        }

        // Update all active zombie controllers and clean up dead ones
        for (let i = this.zombies.length - 1; i >= 0; i--) {
            const ai = this.zombies[i];
            if (ai.isDead || ai.zombie.dead || ai.zombie.health <= 0) {
                ai.destroy();
                this.zombies.splice(i, 1);
            } else {
                ai.update(dt);
            }
        }

        // Broadcast visual navigation debugger stream to enabled dev clients
        this.broadcastDebugNavState(dt);
    }

    buildDebugMsg(): ZombiesNavDebugMsg {
        const msg = new ZombiesNavDebugMsg();
        const seenNodeIds = new Set<number>();
        const seenEdgeKeys = new Set<number>();

        for (let i = 0; i < this.zombies.length; i++) {
            const ai = this.zombies[i];
            msg.zombies.push(ai.getDebugData());

            const nav = this.getNavGraph();
            const local = nav.getLocalSubgraph(this.game, ai.zombie.pos, ai.zombie.layer, 24);

            for (let j = 0; j < local.nodes.length; j++) {
                const n = local.nodes[j];
                if (!seenNodeIds.has(n.id)) {
                    seenNodeIds.add(n.id);
                    msg.nodes.push(n);
                }
            }

            for (let j = 0; j < local.edges.length; j++) {
                const e = local.edges[j];
                const edgeKey = e.fromId < e.toId ? (e.fromId << 16) | e.toId : (e.toId << 16) | e.fromId;
                if (!seenEdgeKeys.has(edgeKey)) {
                    seenEdgeKeys.add(edgeKey);
                    msg.edges.push(e);
                }
            }
        }

        const latestFailure = ZombiesNavDebugger.getLatestFailure();
        if (latestFailure) {
            msg.failureJson = JSON.stringify(latestFailure);
        }

        return msg;
    }

    private broadcastDebugNavState(dt: number): void {
        this.debugBroadcastTimer -= dt;
        if (this.debugBroadcastTimer > 0) return;
        this.debugBroadcastTimer = 0.1; // Rate limit to 10 Hz

        const clients = this.game.clientBarn.clients;
        let anyDebug = ZombiesNavDebugger.enabled;
        if (!anyDebug) {
            for (let i = 0; i < clients.length; i++) {
                if (clients[i].player?.debug?.zombiesNav) {
                    anyDebug = true;
                    break;
                }
            }
        }
        if (!anyDebug) return;

        const msg = this.buildDebugMsg();
        for (let i = 0; i < clients.length; i++) {
            const c = clients[i];
            if (c.player?.debug?.zombiesNav || ZombiesNavDebugger.enabled) {
                c.sendMsg(MsgType.ZombiesNavDebug, msg);
            }
        }
    }
}
