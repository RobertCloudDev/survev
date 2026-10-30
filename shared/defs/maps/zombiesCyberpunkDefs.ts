import { GameConfig } from "../../gameConfig.ts";
import { util } from "../../utils/util.ts";
import { v2 } from "../../utils/v2.ts";
import type { MapDef } from "../mapDefs.ts";
import { Main, type PartialMapDef } from "./baseDefs.ts";

const mapDef: PartialMapDef = {
    mapId: GameConfig.MapId.Zombies,
    desc: {
        name: "Zombies",
        icon: "",
        buttonCss: "btn-mode-zombies",
        buttonText: "zombies",
        backgroundImg: "img/splashes/main.webp",
    },
    assets: {
        audio: [
            { name: "club_music_01", channel: "ambient" },
            { name: "ambient_steam_01", channel: "ambient" },
        ],
        atlases: ["loadout", "shared", "main"],
    },
    biome: {
        colors: {
            background: 0x0a0a14,
            water: 0x00f0ff,
            waterRipple: 0xff0055,
            beach: 0x1f1435,
            riverbank: 0x2a1b4e,
            grass: 0x181428,
            underground: 0x080610,
            playerSubmerge: 0x00f0ff,
            playerGhillie: 0x181428,
        },
    },
    gameMode: {
        maxPlayers: 4,
        killLeaderEnabled: false,
        zombiesMode: true,
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        map: {
            baseWidth: 280,
            baseHeight: 280,
            shoreInset: 20,
            grassInset: 10,
            rivers: {
                lakes: [],
                weights: [{ weight: 1, widths: [] }],
                spawnCabins: false,
            },
        },
        places: [
            {
                name: "Sector 4",
                pos: v2.create(0.5, 0.5),
            },
        ],
        bridgeTypes: {
            medium: "",
            large: "",
            xlarge: "",
        },
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: [],
        },
        densitySpawns: [
            {
                stone_01: 25,
                barrel_01: 15,
                crate_01: 15,
                crate_02: 4,
                bush_01: 15,
                tree_01: 20,
                loot_tier_1: 10,
            },
        ],
        fixedSpawns: [
            {
                warehouse_01: 1,
                house_red_01: 1,
                barn_01: 1,
                shack_03a: 1,
            },
        ],
        randomSpawns: [],
        spawnReplacements: [{}],
        importantSpawns: ["warehouse_01"],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

export const ZombiesCyberpunk = util.mergeDeep({}, Main, mapDef) as MapDef;
