import type { Vec2 } from "../utils/v2.ts";
import type { AbstractMsg, BitStream } from "./net.ts";

export interface NavDebugZombie {
    id: number;
    pos: Vec2;
    layer: number;
    rad: number;
    targetId: number;
    targetPos: Vec2;
    targetLayer: number;
    isReachable: boolean;
    noRoute: boolean;
    isStuck: boolean;
    stuckStrikes: number;
    timeSpentStuck: number;
    recalcCount: number;
    lastRecalcReason: string;
    currentWaypointIndex: number;
    currentWaypoint: Vec2 | null;
    finalDestination: Vec2 | null;
    path: Vec2[];
    selectedNeed?: string;
    activeAction?: string;
    utilityScores?: string;
    navResult?: string;
}

export interface NavDebugNode {
    id: number;
    pos: Vec2;
    layer: number;
    kind: string;
}

export interface NavDebugEdge {
    fromId: number;
    toId: number;
    isDoor: boolean;
    isTraversable: boolean;
}

const NodeKinds = [
    "open",
    "hull",
    "corner",
    "door",
    "window",
    "stair",
    "interior",
];

export class ZombiesNavDebugMsg implements AbstractMsg {
    zombies: NavDebugZombie[] = [];
    nodes: NavDebugNode[] = [];
    edges: NavDebugEdge[] = [];
    failureJson = "";

    serialize(s: BitStream): void {
        // Zombies
        s.writeUint8(this.zombies.length);
        for (let i = 0; i < this.zombies.length; i++) {
            const z = this.zombies[i];
            s.writeUint16(z.id);
            s.writeFloat32(z.pos.x);
            s.writeFloat32(z.pos.y);
            s.writeUint8(z.layer);
            s.writeFloat32(z.rad);
            s.writeUint16(z.targetId);
            s.writeFloat32(z.targetPos.x);
            s.writeFloat32(z.targetPos.y);
            s.writeUint8(z.targetLayer);
            s.writeBoolean(z.isReachable);
            s.writeBoolean(z.noRoute);
            s.writeBoolean(z.isStuck);
            s.writeUint8(z.stuckStrikes);
            s.writeFloat32(z.timeSpentStuck);
            s.writeUint16(z.recalcCount);
            s.writeASCIIString(z.lastRecalcReason || "");
            s.writeUint8(z.currentWaypointIndex);

            s.writeBoolean(!!z.currentWaypoint);
            if (z.currentWaypoint) {
                s.writeFloat32(z.currentWaypoint.x);
                s.writeFloat32(z.currentWaypoint.y);
            }

            s.writeBoolean(!!z.finalDestination);
            if (z.finalDestination) {
                s.writeFloat32(z.finalDestination.x);
                s.writeFloat32(z.finalDestination.y);
            }

            s.writeUint8(z.path.length);
            for (let j = 0; j < z.path.length; j++) {
                s.writeFloat32(z.path[j].x);
                s.writeFloat32(z.path[j].y);
            }

            s.writeASCIIString(z.selectedNeed ?? "");
            s.writeASCIIString(z.activeAction ?? "");
            s.writeASCIIString(z.utilityScores ?? "");
            s.writeASCIIString(z.navResult ?? "");
        }

        // Nodes
        s.writeUint16(this.nodes.length);
        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];
            s.writeUint16(n.id);
            s.writeFloat32(n.pos.x);
            s.writeFloat32(n.pos.y);
            s.writeUint8(n.layer);
            let kindIdx = NodeKinds.indexOf(n.kind);
            if (kindIdx < 0) kindIdx = 0;
            s.writeUint8(kindIdx);
        }

        // Edges
        s.writeUint16(this.edges.length);
        for (let i = 0; i < this.edges.length; i++) {
            const e = this.edges[i];
            s.writeUint16(e.fromId);
            s.writeUint16(e.toId);
            const flags = (e.isDoor ? 1 : 0) | (e.isTraversable ? 2 : 0);
            s.writeUint8(flags);
        }

        // Latest Failure JSON
        const hasFailure = this.failureJson.length > 0;
        s.writeBoolean(hasFailure);
        if (hasFailure) {
            s.writeUTF8String(this.failureJson);
        }
    }

    deserialize(s: BitStream): void {
        // Zombies
        const zombieCount = s.readUint8();
        this.zombies = [];
        for (let i = 0; i < zombieCount; i++) {
            const id = s.readUint16();
            const posX = s.readFloat32();
            const posY = s.readFloat32();
            const layer = s.readUint8();
            const rad = s.readFloat32();
            const targetId = s.readUint16();
            const targetX = s.readFloat32();
            const targetY = s.readFloat32();
            const targetLayer = s.readUint8();
            const isReachable = s.readBoolean();
            const noRoute = s.readBoolean();
            const isStuck = s.readBoolean();
            const stuckStrikes = s.readUint8();
            const timeSpentStuck = s.readFloat32();
            const recalcCount = s.readUint16();
            const lastRecalcReason = s.readASCIIString();
            const currentWaypointIndex = s.readUint8();

            const hasWp = s.readBoolean();
            let currentWaypoint: Vec2 | null = null;
            if (hasWp) {
                currentWaypoint = { x: s.readFloat32(), y: s.readFloat32() };
            }

            const hasDest = s.readBoolean();
            let finalDestination: Vec2 | null = null;
            if (hasDest) {
                finalDestination = { x: s.readFloat32(), y: s.readFloat32() };
            }

            const pathLen = s.readUint8();
            const path: Vec2[] = [];
            for (let j = 0; j < pathLen; j++) {
                path.push({ x: s.readFloat32(), y: s.readFloat32() });
            }

            const selectedNeed = s.readASCIIString() || undefined;
            const activeAction = s.readASCIIString() || undefined;
            const utilityScores = s.readASCIIString() || undefined;
            const navResult = s.readASCIIString() || undefined;

            this.zombies.push({
                id,
                pos: { x: posX, y: posY },
                layer,
                rad,
                targetId,
                targetPos: { x: targetX, y: targetY },
                targetLayer,
                isReachable,
                noRoute,
                isStuck,
                stuckStrikes,
                timeSpentStuck,
                recalcCount,
                lastRecalcReason,
                currentWaypointIndex,
                currentWaypoint,
                finalDestination,
                path,
                selectedNeed,
                activeAction,
                utilityScores,
                navResult,
            });
        }

        // Nodes
        const nodeCount = s.readUint16();
        this.nodes = [];
        for (let i = 0; i < nodeCount; i++) {
            const id = s.readUint16();
            const posX = s.readFloat32();
            const posY = s.readFloat32();
            const layer = s.readUint8();
            const kindIdx = s.readUint8();
            const kind = NodeKinds[kindIdx] ?? "open";
            this.nodes.push({
                id,
                pos: { x: posX, y: posY },
                layer,
                kind,
            });
        }

        // Edges
        const edgeCount = s.readUint16();
        this.edges = [];
        for (let i = 0; i < edgeCount; i++) {
            const fromId = s.readUint16();
            const toId = s.readUint16();
            const flags = s.readUint8();
            this.edges.push({
                fromId,
                toId,
                isDoor: (flags & 1) !== 0,
                isTraversable: (flags & 2) !== 0,
            });
        }

        // Failure JSON
        const hasFailure = s.readBoolean();
        if (hasFailure) {
            this.failureJson = s.readUTF8String();
        } else {
            this.failureJson = "";
        }
    }
}
