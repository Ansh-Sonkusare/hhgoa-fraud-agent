import type { AgentEvent, EvidenceItem } from "./types";

// Pure graph construction for the Neighborhood graph panel, kept out of the
// React component so it can be unit-tested (tests/ws6/neighborhoodGraph.test.ts).

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  /** The case itself and the card it is about: drawn with a red outline. */
  flagged: boolean;
  /** Real members of this shared-entity group that are not drawn (see MAX_CARDS_PER_GROUP). */
  hidden: number;
  /** "root" | "flagged" | "hub" get a text label; everything else is hover-only. */
  role: "root" | "flagged" | "hub" | "leaf";
}

export interface GraphLink {
  source: string;
  target: string;
  label: string;
}

export interface NeighborhoodGraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Cards / entities that exist in the run's data but are not drawn, so the panel can say so. */
  hiddenCards: number;
  hiddenEntities: number;
}

/** A shared device/address can link 50+ cards; drawing them all is a blob, so cap what is drawn per group. */
export const MAX_CARDS_PER_GROUP = 8;
/** Same for the entities a single evidence item lists when no ring data is available. */
export const MAX_ENTITIES_PER_EVIDENCE = 12;

interface Ring {
  shared_type: string;
  shared_id: string;
  card_ids: string[];
}

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function isRing(x: unknown): x is Ring {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r["shared_type"] === "string" && typeof r["shared_id"] === "string" && Array.isArray(r["card_ids"]);
}

/**
 * The rings sit in different places depending on who produced the event: the
 * live agent wraps the tool's standard envelope (`payload.result.data.rings`),
 * while the WS0 fixture recordings store them flatter (`payload.rings`,
 * `payload.result.rings`). Accept all three.
 */
export function extractRings(payload: Record<string, unknown>): Ring[] {
  const result = payload["result"] as Record<string, unknown> | undefined;
  const data = result?.["data"] as Record<string, unknown> | undefined;
  const candidates = [data?.["rings"], result?.["rings"], payload["rings"]];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter(isRing);
  }
  return [];
}

/** The card the case is about, taken from the ring query's own arguments (`args.entity`), else the trigger resolution. */
function findFlaggedCard(events: AgentEvent[]): string | null {
  for (const event of events) {
    if (event.type === "tool_call" && event.payload["tool"] === "find_shared_entity_rings") {
      const args = event.payload["args"] as { entity?: { type?: string; id?: string } } | undefined;
      if (args?.entity?.type === "Card" && args.entity.id) return args.entity.id;
    }
  }
  for (const event of events) {
    if (event.type === "tool_result" && event.payload["tool"] === "resolve_trigger") {
      const result = event.payload["result"] as { data?: { card?: { id?: string } } } | undefined;
      const id = result?.data?.card?.id;
      if (id) return id;
    }
  }
  return null;
}

export function buildGraph(caseId: string, events: AgentEvent[]): NeighborhoodGraphData {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const linkKeys = new Set<string>();
  const addLink = (source: string, target: string, label: string) => {
    const key = `${source}|${target}|${label}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source, target, label });
  };
  let hiddenCards = 0;
  let hiddenEntities = 0;

  const root: GraphNode = { id: `Case:${caseId}`, type: "Case", label: caseId, flagged: true, hidden: 0, role: "root" };
  nodes.set(root.id, root);

  const addNode = (type: string, id: string, extra: Partial<GraphNode> = {}): GraphNode => {
    const key = `${type}:${id}`;
    let node = nodes.get(key);
    if (!node) {
      node = { id: key, type, label: id, flagged: false, hidden: 0, role: "leaf", ...extra };
      nodes.set(key, node);
    }
    return node;
  };

  const seedId = findFlaggedCard(events);
  const seed = seedId ? addNode("Card", seedId, { flagged: true, role: "flagged" }) : null;
  if (seed) addLink(root.id, seed.id, "flagged card");

  let ringsFound = false;
  for (const event of events) {
    if (event.type !== "tool_result" || event.payload["tool"] !== "find_shared_entity_rings") continue;
    for (const ring of extractRings(event.payload)) {
      ringsFound = true;
      const hub = addNode(titleCase(ring.shared_type), ring.shared_id, { role: "hub" });
      addLink(seed?.id ?? root.id, hub.id, `shares ${ring.shared_type}`);
      // Every member is real (the ring query returned it); only the drawing is capped.
      const others = [...new Set(ring.card_ids)].filter((id) => id !== seedId);
      for (const cardId of others.slice(0, MAX_CARDS_PER_GROUP)) {
        const card = addNode("Card", cardId);
        addLink(hub.id, card.id, `shares ${ring.shared_type}`);
      }
      const dropped = Math.max(0, others.length - MAX_CARDS_PER_GROUP);
      hub.hidden += dropped;
      hiddenCards += dropped;
    }
  }

  for (const event of events) {
    if (event.type !== "evidence_added") continue;
    const ev = event.payload["evidence"] as EvidenceItem | undefined;
    if (!ev) continue;
    // When the ring query's own result was found, the ring evidence lists the
    // same entities (with the group members already drawn as hub -> card), so
    // adding them again would only wire every member straight to the case.
    if (ringsFound && ev.source_tool === "find_shared_entity_rings") continue;
    const shown = ev.entities.slice(0, MAX_ENTITIES_PER_EVIDENCE);
    hiddenEntities += ev.entities.length - shown.length;
    for (const entity of shown) {
      if (seedId && entity.type === "Card" && entity.id === seedId) continue;
      const node = addNode(entity.type, entity.id);
      addLink(root.id, node.id, ev.category);
    }
  }

  return { nodes: [...nodes.values()], links, hiddenCards, hiddenEntities };
}
