import { describe, it, expect } from "vitest";
import {
  buildEvidenceForTool,
  createEvidenceIdGen,
} from "../../agent/src/evidenceBuilder.js";

const AS_OF = "2016-11-22T02:30:00Z";

describe("find_shared_entity_rings entity types", () => {
  it("creates Device entities for device rings", () => {
    const data = {
      rings: [
        {
          shared_type: "device",
          shared_id: "D123",
          card_ids: ["C1", "C2"],
        },
      ],
    };
    const items = buildEvidenceForTool("find_shared_entity_rings", data, createEvidenceIdGen(), AS_OF);
    const deviceEntity = items[0]!.entities.find((e) => e.id === "D123");
    expect(deviceEntity).toBeDefined();
    expect(deviceEntity!.type).toBe("Device");
  });

  it("creates Address entities for address rings (NOT Device)", () => {
    const data = {
      rings: [
        {
          shared_type: "address",
          shared_id: "420",
          card_ids: ["C1", "C2"],
        },
      ],
    };
    const items = buildEvidenceForTool("find_shared_entity_rings", data, createEvidenceIdGen(), AS_OF);
    const entity = items[0]!.entities.find((e) => e.id === "420");
    expect(entity).toBeDefined();
    expect(entity!.type).toBe("Address");
  });

  it("creates EmailDomain entities for email rings (NOT Device)", () => {
    const data = {
      rings: [
        {
          shared_type: "email",
          shared_id: "gmail.com",
          card_ids: ["C1", "C2"],
        },
      ],
    };
    const items = buildEvidenceForTool("find_shared_entity_rings", data, createEvidenceIdGen(), AS_OF);
    const entity = items[0]!.entities.find((e) => e.id === "gmail.com");
    expect(entity).toBeDefined();
    expect(entity!.type).toBe("EmailDomain");
  });

  it("includes Card entities for all ring types", () => {
    const cardIds = ["C1", "C2", "C3"];
    const data = {
      rings: [
        {
          shared_type: "device",
          shared_id: "D123",
          card_ids: cardIds,
        },
      ],
    };
    const items = buildEvidenceForTool("find_shared_entity_rings", data, createEvidenceIdGen(), AS_OF);
    const cardEntities = items[0]!.entities.filter((e) => e.type === "Card");
    expect(cardEntities).toHaveLength(cardIds.length);
    expect(cardEntities.map((e) => e.id)).toEqual(cardIds);
  });

  it("handles multiple rings with different types", () => {
    const data = {
      rings: [
        {
          shared_type: "device",
          shared_id: "D123",
          card_ids: ["C1"],
        },
        {
          shared_type: "address",
          shared_id: "420",
          card_ids: ["C2"],
        },
        {
          shared_type: "email",
          shared_id: "gmail.com",
          card_ids: ["C3"],
        },
      ],
    };
    const items = buildEvidenceForTool("find_shared_entity_rings", data, createEvidenceIdGen(), AS_OF);

    // Device ring
    const deviceItem = items.find((i) => i.entities.some((e) => e.id === "D123"))!;
    expect(deviceItem.entities.find((e) => e.id === "D123")!.type).toBe("Device");

    // Address ring
    const addressItem = items.find((i) => i.entities.some((e) => e.id === "420"))!;
    expect(addressItem.entities.find((e) => e.id === "420")!.type).toBe("Address");

    // Email ring
    const emailItem = items.find((i) => i.entities.some((e) => e.id === "gmail.com"))!;
    expect(emailItem.entities.find((e) => e.id === "gmail.com")!.type).toBe("EmailDomain");
  });
});
