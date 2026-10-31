import * as PIXI from "pixi.js-legacy";
import type { NavDebugEdge, NavDebugNode, NavDebugZombie, ZombiesNavDebugMsg } from "../../../shared/net/net.ts";
import type { Camera } from "../camera.ts";

export interface ZombieNavFailureDiagnostic {
    timestamp: number;
    zombieId: number;
    failureType: "no_route" | "stuck" | "door_failure" | "collision_obstruction";
    failureReason?: string;
    zombiePos: { x: number; y: number };
    zombieLayer: number;
    targetPos: { x: number; y: number };
    targetLayer: number;
    currentNavNode: { id: number; pos: { x: number; y: number }; kind: string; layer: number } | null;
    targetNavNode: { id: number; pos: { x: number; y: number }; kind: string; layer: number } | null;
    currentWaypoint: { x: number; y: number } | null;
    currentWaypointIndex: number;
    calculatedPath: Array<{ x: number; y: number }>;
    blockedConnections: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; reason: string }>;
    doorState: {
        nearbyDoorId?: number;
        doorPos?: { x: number; y: number };
        isOpen?: boolean;
        isLocked?: boolean;
        canUse?: boolean;
        openOneWay?: number;
        attempts: number;
        lastAttemptResult?: string;
    } | null;
    collisionObstruction: {
        obstacleType?: string;
        pos?: { x: number; y: number };
        colliderType?: string;
        details?: string;
    } | null;
    timeSpentStuck: number;
    recalculationCount: number;
    lastRecalcReason: string;
}

declare global {
    interface Window {
        survevNavDiagnostics?: ZombieNavFailureDiagnostic[];
        exportNavDiagnostics?: () => ZombieNavFailureDiagnostic[];
    }
}

/**
 * Visual Navigation Debugger overlay for Survev Zombies mode.
 * Provides real-time rendering of calculated paths, waypoints, destinations,
 * local graph nodes, traversable/blocked connections, door portals, collision radii,
 * target reachability, stuck indicators, recalculation tracking, and failure diagnostics.
 */
export class ZombiesNavVisualizer {
    readonly container = new PIXI.Container();
    private readonly graphics = new PIXI.Graphics();
    private readonly textContainer = new PIXI.Container();

    private latestMsg: ZombiesNavDebugMsg | null = null;
    private failureReports: ZombieNavFailureDiagnostic[] = [];

    // Pooled text objects to avoid garbage collection spikes
    private textPool: PIXI.Text[] = [];
    private textPoolIdx = 0;

    constructor() {
        this.container.interactiveChildren = false;
        this.container.addChild(this.graphics);
        this.container.addChild(this.textContainer);

        // Expose global developer inspection utilities on window
        if (typeof window !== "undefined") {
            window.survevNavDiagnostics = this.failureReports;
            window.exportNavDiagnostics = () => {
                console.log(
                    `%c[SURVEV NAV DIAGNOSTICS] Total Failure Records: ${this.failureReports.length}`,
                    "color: #00ffff; font-weight: bold; font-size: 14px;",
                );
                console.table(
                    this.failureReports.map((r) => ({
                        Time: new Date(r.timestamp).toLocaleTimeString(),
                        Zombie: `#${r.zombieId} at (${r.zombiePos.x.toFixed(1)}, ${r.zombiePos.y.toFixed(1)})`,
                        Failure: r.failureType,
                        Target: `(${r.targetPos.x.toFixed(1)}, ${r.targetPos.y.toFixed(1)})`,
                        Obstruction: r.collisionObstruction?.obstacleType ?? "none",
                        Door: r.doorState ? `locked: ${r.doorState.isLocked}` : "none",
                        StuckTime: `${r.timeSpentStuck.toFixed(1)}s`,
                        Recalcs: r.recalculationCount,
                    })),
                );
                return this.failureReports;
            };
        }
    }

    onDebugMsg(msg: ZombiesNavDebugMsg): void {
        this.latestMsg = msg;

        if (msg.failureJson && msg.failureJson.length > 0) {
            try {
                const parsed = JSON.parse(msg.failureJson) as ZombieNavFailureDiagnostic;
                this.failureReports.push(parsed);
                if (this.failureReports.length > 50) {
                    this.failureReports.shift();
                }
                if (typeof window !== "undefined") {
                    window.survevNavDiagnostics = this.failureReports;
                }
            } catch {
                // Ignore malformed debug JSON
            }
        }
    }

    render(camera: Camera, enabled: boolean): void {
        if (!enabled || !this.latestMsg) {
            this.container.visible = false;
            this.graphics.clear();
            this.hideAllTexts();
            return;
        }

        this.container.visible = true;
        this.graphics.clear();
        this.textPoolIdx = 0;

        const gfx = this.graphics;
        const msg = this.latestMsg;

        // Build fast lookup map for local nodes
        const nodeMap = new Map<number, NavDebugNode>();
        for (let i = 0; i < msg.nodes.length; i++) {
            nodeMap.set(msg.nodes[i].id, msg.nodes[i]);
        }

        // 1. Render Local Graph Connections (Edges) (Req 3, 4, 5)
        for (let i = 0; i < msg.edges.length; i++) {
            const edge: NavDebugEdge = msg.edges[i];
            const na = nodeMap.get(edge.fromId);
            const nb = nodeMap.get(edge.toId);
            if (!na || !nb) continue;

            const p1 = camera.m_pointToScreen(na.pos);
            const p2 = camera.m_pointToScreen(nb.pos);

            if (edge.isDoor) {
                // Requirement 5: Highlight door-related navigation nodes and portal connections (Magenta)
                gfx.lineStyle({ width: 3.0, color: 0xff00ff, alpha: 0.95 });
            } else if (edge.isTraversable) {
                // Requirement 4: Differentiate traversable (Green)
                gfx.lineStyle({ width: 1.5, color: 0x00ff88, alpha: 0.45 });
            } else {
                // Requirement 4: Differentiate blocked (Red)
                gfx.lineStyle({ width: 2.2, color: 0xff2222, alpha: 0.8 });
            }

            gfx.moveTo(p1.x, p1.y);
            gfx.lineTo(p2.x, p2.y);
        }

        // 2. Render Local Graph Nodes (Req 3, 5)
        for (let i = 0; i < msg.nodes.length; i++) {
            const node: NavDebugNode = msg.nodes[i];
            const p = camera.m_pointToScreen(node.pos);

            switch (node.kind) {
                case "door": {
                    // Requirement 5: Door node highlight (Magenta diamond with white core)
                    gfx.lineStyle({ width: 1.5, color: 0xffffff, alpha: 0.9 });
                    gfx.beginFill(0xff00ff, 0.9);
                    this.drawDiamond(gfx, p.x, p.y, 6);
                    gfx.endFill();
                    break;
                }
                case "corner": {
                    // Corner convex waypoint (Amber/Orange)
                    gfx.lineStyle({ width: 1.0, color: 0xffd54f, alpha: 0.8 });
                    gfx.beginFill(0xffa000, 0.85);
                    gfx.drawCircle(p.x, p.y, 4.5);
                    gfx.endFill();
                    break;
                }
                case "interior": {
                    // Interior grid node (Cyan)
                    gfx.lineStyle({ width: 1.0, color: 0x80deea, alpha: 0.6 });
                    gfx.beginFill(0x00acc1, 0.7);
                    gfx.drawCircle(p.x, p.y, 3.5);
                    gfx.endFill();
                    break;
                }
                default: {
                    // Standard open / perimeter hull node (Light Blue)
                    gfx.lineStyle({ width: 1.0, color: 0x90caf9, alpha: 0.5 });
                    gfx.beginFill(0x1e88e5, 0.6);
                    gfx.drawCircle(p.x, p.y, 3.0);
                    gfx.endFill();
                    break;
                }
            }
        }

        // 3. Render Active Zombies Navigation States (Req 1, 2, 6, 7, 8, 9, 10)
        for (let i = 0; i < msg.zombies.length; i++) {
            const z: NavDebugZombie = msg.zombies[i];
            const zScreen = camera.m_pointToScreen(z.pos);
            const zRadScreen = camera.m_scaleToScreen(z.rad);

            // Requirement 6: Visualize the zombie's physical collision radius
            gfx.lineStyle({ width: 2.0, color: 0x00ffff, alpha: 0.85 });
            gfx.beginFill(0x00ffff, 0.12);
            gfx.drawCircle(zScreen.x, zScreen.y, zRadScreen);
            gfx.endFill();

            // Inner body radius indicator (rad = 1.0u)
            const bodyRadScreen = camera.m_scaleToScreen(1.0);
            gfx.lineStyle({ width: 1.0, color: 0xffffff, alpha: 0.4 });
            gfx.drawCircle(zScreen.x, zScreen.y, bodyRadScreen);

            // Requirement 1: Display calculated path as connected line segments (Yellow/Gold)
            if (z.path.length > 0) {
                gfx.lineStyle({ width: 3.5, color: 0xffd700, alpha: 0.95 });
                gfx.moveTo(zScreen.x, zScreen.y);

                for (let j = 0; j < z.path.length; j++) {
                    const wpScreen = camera.m_pointToScreen(z.path[j]);
                    gfx.lineTo(wpScreen.x, wpScreen.y);
                }

                // Small waypoint nodes along calculated path
                for (let j = 0; j < z.path.length; j++) {
                    const wpScreen = camera.m_pointToScreen(z.path[j]);
                    gfx.lineStyle({ width: 1.5, color: 0xffffff, alpha: 0.9 });
                    gfx.beginFill(0xffd700, 0.9);
                    gfx.drawCircle(wpScreen.x, wpScreen.y, 4.0);
                    gfx.endFill();
                }
            }

            // Requirement 2: Mark current waypoint
            if (z.currentWaypoint) {
                const wpScreen = camera.m_pointToScreen(z.currentWaypoint);
                // Glowing outer target ring
                gfx.lineStyle({ width: 2.5, color: 0xffff00, alpha: 0.95 });
                gfx.drawCircle(wpScreen.x, wpScreen.y, 9.0);
                // Inner center dot
                gfx.beginFill(0xffff00, 1.0);
                gfx.drawCircle(wpScreen.x, wpScreen.y, 3.5);
                gfx.endFill();

                this.addLabel(
                    `WP #${z.currentWaypointIndex}`,
                    wpScreen.x,
                    wpScreen.y - 16,
                    "#ffff00",
                    "rgba(0,0,0,0.75)",
                );
            }

            // Requirement 2: Mark final destination
            if (z.finalDestination) {
                const destScreen = camera.m_pointToScreen(z.finalDestination);
                gfx.lineStyle({ width: 2.0, color: 0xff6d00, alpha: 0.95 });
                gfx.beginFill(0xffab00, 0.9);
                this.drawDiamond(gfx, destScreen.x, destScreen.y, 8.0);
                gfx.endFill();

                this.addLabel(
                    "DEST",
                    destScreen.x,
                    destScreen.y + 12,
                    "#ffab00",
                    "rgba(0,0,0,0.75)",
                );
            }

            // Requirement 7: Show selected target and reachability
            if (z.targetId > 0) {
                const tgtScreen = camera.m_pointToScreen(z.targetPos);

                if (z.isReachable) {
                    // Reachable target: Green connection line
                    gfx.lineStyle({ width: 1.8, color: 0x00ff88, alpha: 0.75 });
                    gfx.moveTo(zScreen.x, zScreen.y);
                    gfx.lineTo(tgtScreen.x, tgtScreen.y);

                    this.addLabel(
                        "TARGET [REACHABLE]",
                        tgtScreen.x,
                        tgtScreen.y - 20,
                        "#00ff88",
                        "rgba(0,0,0,0.8)",
                    );
                } else {
                    // Unreachable target: Red connection line with cross
                    gfx.lineStyle({ width: 2.5, color: 0xff1744, alpha: 0.9 });
                    gfx.moveTo(zScreen.x, zScreen.y);
                    gfx.lineTo(tgtScreen.x, tgtScreen.y);

                    // Cross marker
                    gfx.moveTo(tgtScreen.x - 7, tgtScreen.y - 7);
                    gfx.lineTo(tgtScreen.x + 7, tgtScreen.y + 7);
                    gfx.moveTo(tgtScreen.x + 7, tgtScreen.y - 7);
                    gfx.lineTo(tgtScreen.x - 7, tgtScreen.y + 7);

                    this.addLabel(
                        "TARGET [UNREACHABLE]",
                        tgtScreen.x,
                        tgtScreen.y - 20,
                        "#ff1744",
                        "rgba(0,0,0,0.8)",
                    );
                }
            }

            // Requirement 8: Stuck indicator
            let yOffset = -zRadScreen - 18;
            if (z.isStuck || z.stuckStrikes > 0) {
                this.addLabel(
                    `⚠ STUCK (strikes: ${z.stuckStrikes}, ${z.timeSpentStuck.toFixed(1)}s)`,
                    zScreen.x,
                    zScreen.y + yOffset,
                    "#ffd600",
                    "rgba(180, 0, 0, 0.85)",
                );
                yOffset -= 18;
            }

            // Requirement 10: Identify when no valid route exists
            if (z.noRoute) {
                this.addLabel(
                    "⛔ NO ROUTE TO TARGET",
                    zScreen.x,
                    zScreen.y + yOffset,
                    "#ffffff",
                    "rgba(213, 0, 0, 0.9)",
                );
                yOffset -= 18;
            }

            // Requirement 9: Track path recalculations and report why each occurred
            this.addLabel(
                `Repath #${z.recalcCount}: ${z.lastRecalcReason}`,
                zScreen.x,
                zScreen.y + yOffset,
                "#80d8ff",
                "rgba(0, 0, 0, 0.75)",
            );
            yOffset -= 18;

            // Task 004.9 Requirement 9: Expose selected need, active behavior, and utility scores
            if (z.activeAction || z.selectedNeed) {
                this.addLabel(
                    `ACTION: ${(z.activeAction ?? "idle").toUpperCase()} [${z.selectedNeed ?? ""}] | NAV: ${z.navResult ?? "success"}`,
                    zScreen.x,
                    zScreen.y + yOffset,
                    "#e040fb",
                    "rgba(0, 0, 0, 0.8)",
                );
                yOffset -= 18;
            }

            if (z.utilityScores) {
                this.addLabel(
                    `NEEDS: ${z.utilityScores}`,
                    zScreen.x,
                    zScreen.y + yOffset,
                    "#b388ff",
                    "rgba(0, 0, 0, 0.8)",
                );
                yOffset -= 18;
            }
        }

        // Hide remaining pooled text elements that weren't utilized this frame
        this.hideUnusedTexts();
    }

    private drawDiamond(gfx: PIXI.Graphics, x: number, y: number, r: number): void {
        gfx.moveTo(x, y - r);
        gfx.lineTo(x + r, y);
        gfx.lineTo(x, y + r);
        gfx.lineTo(x - r, y);
        gfx.lineTo(x, y - r);
    }

    private addLabel(
        text: string,
        x: number,
        y: number,
        color: string,
        _bgColor: string,
    ): void {
        let textObj: PIXI.Text;
        if (this.textPoolIdx < this.textPool.length) {
            textObj = this.textPool[this.textPoolIdx];
        } else {
            textObj = new PIXI.Text("", {
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: "bold",
                fill: color,
                stroke: "#000000",
                strokeThickness: 3,
                align: "center",
            });
            this.textPool.push(textObj);
            this.textContainer.addChild(textObj);
        }

        textObj.text = text;
        textObj.style.fill = color;
        textObj.position.set(Math.round(x - textObj.width * 0.5), Math.round(y));
        textObj.visible = true;
        this.textPoolIdx++;
    }

    private hideUnusedTexts(): void {
        for (let i = this.textPoolIdx; i < this.textPool.length; i++) {
            this.textPool[i].visible = false;
        }
    }

    private hideAllTexts(): void {
        for (let i = 0; i < this.textPool.length; i++) {
            this.textPool[i].visible = false;
        }
    }
}
