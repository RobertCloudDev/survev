import type { Game } from "./game.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import { math } from "../../../shared/utils/math.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";

export interface ZombieNeeds {
    pursuit: number;
    attack: number;
    investigate: number;
    breach: number;
    survival: number;
    group: number;
}

export type ZombieAction =
    | "idle"
    | "pursuit"
    | "attack"
    | "investigate"
    | "breach"
    | "survival"
    | "group";

export interface ZombiePersonalityWeights {
    pursuit: number;
    attack: number;
    investigate: number;
    breach: number;
    survival: number;
    group: number;
}

export const DefaultPersonalityWeights: Record<string, ZombiePersonalityWeights> = {
    walker: {
        pursuit: 1.0,
        attack: 1.25,
        investigate: 0.85,
        breach: 1.15,
        survival: 0.6,
        group: 0.7,
    },
    runner: {
        pursuit: 1.35,
        attack: 1.2,
        investigate: 0.7,
        breach: 1.25,
        survival: 0.4,
        group: 0.5,
    },
    tank: {
        pursuit: 0.9,
        attack: 1.35,
        investigate: 0.5,
        breach: 1.5,
        survival: 0.8,
        group: 0.6,
    },
};

export interface UtilityContext {
    zombie: Player;
    game: Game;
    target: Player | null;
    lastKnownTargetPos: Vec2 | null;
    distToTarget: number;
    hasLineOfSight: boolean;
    isTargetReachable: boolean;
    attackCooldown: number;
    attackRange: number;
    nearbyObstacleToBreach: Obstacle | null;
    recentDamageTaken: number;
    timeSinceSawTarget: number;
    nearbyZombieDensity: number;
    staggerDuration: number;
}

export interface UtilityEvaluationResult {
    needs: ZombieNeeds;
    selectedAction: ZombieAction;
    decisionReason: string;
}

/**
 * Six-Need Modular Utility AI Evaluator.
 * Evaluates continuously scored needs (0-100), applies personality weights,
 * filters for action possibility, and enforces behavioral hysteresis to prevent rapid oscillating.
 */
export class ZombiesUtilityEvaluator {
    readonly weights: ZombiePersonalityWeights;
    static readonly HYSTERESIS_BONUS = 14.0;
    static readonly MIN_COMMITMENT_TIME = 0.25;

    constructor(personalityWeights?: ZombiePersonalityWeights) {
        this.weights = personalityWeights ?? DefaultPersonalityWeights.walker;
    }

    /**
     * Computes the raw scores for each of the six needs based on environment and context.
     */
    evaluateNeeds(ctx: UtilityContext): ZombieNeeds {
        // --- Need 1: Pursuit ---
        let pursuitRaw = 0;
        if (ctx.target && !ctx.target.dead) {
            // Distance decay: higher when closer
            const distFactor = math.clamp(1.0 - (ctx.distToTarget / 40.0), 0.1, 1.0);
            const basePursuit = 55.0 + (distFactor * 35.0);

            // Visibility & recent contact bonus
            const visibilityBonus = ctx.hasLineOfSight ? 10.0 : math.clamp(10.0 - ctx.timeSinceSawTarget * 2.5, 0, 10.0);

            // Reachability factor: slightly penalize if known unreachable
            const reachabilityFactor = ctx.isTargetReachable ? 1.0 : 0.85;

            pursuitRaw = (basePursuit + visibilityBonus) * reachabilityFactor;
        } else if (ctx.lastKnownTargetPos) {
            // Faint pursuit desire towards last known coordinate
            pursuitRaw = math.clamp(40.0 - ctx.timeSinceSawTarget * 4.0, 0, 40.0);
        }
        pursuitRaw = math.clamp(pursuitRaw * this.weights.pursuit, 0, 100);

        // --- Need 2: Attack ---
        // Rule: Attack must NEVER activate through solid geometry or out of physical reach
        let attackRaw = 0;
        if (
            ctx.target
            && !ctx.target.dead
            && ctx.distToTarget <= ctx.attackRange
            && ctx.hasLineOfSight
        ) {
            let baseAttack = 80.0;
            // Cooldown readiness
            if (ctx.attackCooldown <= 0) baseAttack += 15.0;
            // Target vulnerability (low health or downed)
            if (ctx.target.downed || ctx.target.health < 40) baseAttack += 5.0;

            attackRaw = math.clamp(baseAttack * this.weights.attack, 0, 100);
        }

        // --- Need 3: Investigate ---
        let investigateRaw = 0;
        if (
            !ctx.hasLineOfSight
            && ctx.lastKnownTargetPos
            && ctx.timeSinceSawTarget > 0.4
        ) {
            const distToLast = v2.distance(ctx.zombie.pos, ctx.lastKnownTargetPos);
            if (distToLast > 1.2) {
                // High interest right after losing sight, decaying with time and distance
                const freshInterest = math.clamp(80.0 - (ctx.timeSinceSawTarget * 5.0), 10.0, 80.0);
                const proximityWeight = math.clamp(1.0 - (distToLast / 35.0), 0.2, 1.0);
                investigateRaw = math.clamp(freshInterest * proximityWeight * this.weights.investigate, 0, 100);
            }
        }

        // --- Need 4: Breach ---
        let breachRaw = 0;
        if (ctx.nearbyObstacleToBreach && !ctx.nearbyObstacleToBreach.dead) {
            const obs = ctx.nearbyObstacleToBreach;
            const isBarricade = !!obs.isBarricade;
            const isClosedDoor = obs.isDoor && obs.door && !obs.door.open;

            if (isClosedDoor && !obs.door!.locked) {
                // High immediate utility to open unlocked doors blocking path
                breachRaw = math.clamp(85.0 * this.weights.breach, 0, 100);
            } else if (isBarricade) {
                // Attack breakable barricade
                const healthRatio = math.clamp(obs.health / (obs.maxHealth || 40), 0.1, 1.0);
                // Lower remaining health increases urgency to finish breaching
                breachRaw = math.clamp((75.0 + (1.0 - healthRatio) * 15.0) * this.weights.breach, 0, 100);
            }
        }

        // --- Need 5: Survival / Reaction ---
        let survivalRaw = 0;
        if (ctx.staggerDuration > 0) {
            // Stagger or stun forces reaction state
            survivalRaw = 95.0;
        } else if (ctx.recentDamageTaken > 20) {
            // High burst damage causes aggressive flinch / focus reaction
            survivalRaw = math.clamp((ctx.recentDamageTaken * 1.5) * this.weights.survival, 0, 85);
        }

        // --- Need 6: Group / Swarm ---
        let groupRaw = 0;
        if (ctx.nearbyZombieDensity >= 2 && ctx.distToTarget > ctx.attackRange) {
            // Congestion triggers minor lateral dispersion so zombies don't stack
            groupRaw = math.clamp((25.0 + ctx.nearbyZombieDensity * 12.0) * this.weights.group, 0, 70);
        }

        return {
            pursuit: Math.round(pursuitRaw * 10) / 10,
            attack: Math.round(attackRaw * 10) / 10,
            investigate: Math.round(investigateRaw * 10) / 10,
            breach: Math.round(breachRaw * 10) / 10,
            survival: Math.round(survivalRaw * 10) / 10,
            group: Math.round(groupRaw * 10) / 10,
        };
    }

    /**
     * Determines whether an action is currently physically possible.
     */
    isActionPossible(action: ZombieAction, ctx: UtilityContext): boolean {
        switch (action) {
            case "attack":
                return !!(
                    ctx.target
                    && !ctx.target.dead
                    && ctx.distToTarget <= ctx.attackRange
                    && ctx.hasLineOfSight
                );
            case "breach":
                if (!ctx.nearbyObstacleToBreach || ctx.nearbyObstacleToBreach.dead) return false;
                const obs = ctx.nearbyObstacleToBreach;
                if (obs.isDoor && obs.door) {
                    return !obs.door.open && (!obs.door.locked || !!obs.isBarricade);
                }
                return !!obs.isBarricade;
            case "pursuit":
                return !!(
                    ctx.target
                    && !ctx.target.dead
                    && !ctx.zombie.dead
                );
            case "investigate":
                return !!(
                    !ctx.hasLineOfSight
                    && ctx.lastKnownTargetPos
                    && v2.distance(ctx.zombie.pos, ctx.lastKnownTargetPos) > 1.2
                );
            case "survival":
                return ctx.staggerDuration > 0 || ctx.recentDamageTaken > 15;
            case "group":
                return ctx.nearbyZombieDensity >= 2;
            case "idle":
                return true;
        }
    }

    /**
     * Evaluates all needs and selects the highest scoring valid action with hysteresis commitment.
     */
    selectAction(
        ctx: UtilityContext,
        currentAction: ZombieAction,
        commitmentTimer: number,
    ): UtilityEvaluationResult {
        const needs = this.evaluateNeeds(ctx);

        // Filter valid actions that are physically possible
        const candidates: Array<{ action: ZombieAction; score: number }> = [];

        const actionList: (keyof ZombieNeeds)[] = [
            "attack",
            "breach",
            "survival",
            "pursuit",
            "investigate",
            "group",
        ];

        for (let i = 0; i < actionList.length; i++) {
            const action = actionList[i];
            if (this.isActionPossible(action, ctx)) {
                let score = needs[action];
                // Apply hysteresis: active action gets an inertia boost to prevent jitter/rapid oscillation,
                // unless an important event justifies interruption (e.g. target reached for attack or obstacle reached for breach)
                const isInterrupted = currentAction === "pursuit" && (action === "pursuit") && (this.isActionPossible("attack", ctx) || this.isActionPossible("breach", ctx));
                if (action === currentAction && commitmentTimer > 0 && !isInterrupted) {
                    score += ZombiesUtilityEvaluator.HYSTERESIS_BONUS;
                }
                if (score > 0) {
                    candidates.push({ action, score });
                }
            }
        }

        if (candidates.length === 0) {
            return {
                needs,
                selectedAction: "idle",
                decisionReason: "no_valid_actions",
            };
        }

        // Sort descending by score
        candidates.sort((a, b) => b.score - a.score);

        const best = candidates[0];
        let reason = `highest_utility_${best.action}_${best.score.toFixed(1)}`;
        if (best.action === currentAction && commitmentTimer > 0) {
            reason += "_hysteresis_committed";
        }

        return {
            needs,
            selectedAction: best.action,
            decisionReason: reason,
        };
    }
}
