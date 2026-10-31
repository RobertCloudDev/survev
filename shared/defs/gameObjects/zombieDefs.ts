export interface ZombieDef {
    id: string;
    name: string;
    health: number;
    speedMult: number;
    attackType: "melee";
    damage: number;
    attackRange: number;
    attackCooldown: number;
    outfit: string;
}

export const ZombieDefs: Record<string, ZombieDef> = {
    walker: {
        id: "walker",
        name: "Walker",
        health: 100,
        speedMult: 0.65,
        attackType: "melee",
        damage: 15,
        attackRange: 2.8,
        attackCooldown: 1.2,
        outfit: "outfitVerde",
    },

        runner: {
        id: "runner",
        name: "runner",
        health: 100,
        speedMult: 1.5,
        attackType: "melee",
        damage: 15,
        attackRange: 2.8,
        attackCooldown: 1.0,
        outfit: "outfitRed",
    },



};
