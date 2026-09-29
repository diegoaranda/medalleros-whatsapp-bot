import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/automation.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";

/**
 * Backend coverage for the FAQ "create-faq" bug fix (Fase 5.x): the UI-level
 * behaviors (busy state, single request on double-click/Enter, modal
 * closing only on confirmed success, form staying open with preserved data
 * on error) live as inline JS inside api/admin.ts's template-string page and
 * have no DOM test harness in this repo (no jsdom config) — those were
 * verified live via the browser tool against the real /automations page
 * (see the Fase 5.x report). This file covers the one piece of new server
 * logic: the duplicate-title guard in the create-faq action of
 * api/automation.ts, plus that a normal create still works with exactly one
 * inserted row per call.
 */

const flowRow = { id: "flow-1", status: "draft" };

interface FakeFaqRow {
  id: string;
  company_id: string;
  flow_id: string;
  title: string;
  answer: string;
  sort_order: number;
}

function thenable<T>(run: () => Promise<T>) {
  return { then: (resolve: (value: T) => void, reject?: (reason: unknown) => void) => run().then(resolve, reject) };
}

function makeFakeDb(faqs: FakeFaqRow[]) {
  return {
    from(table: string) {
      if (table === "companies") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "company-1", name: "Test Co" }, error: null }) }) }) };
      }
      if (table === "flows") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: flowRow, error: null }) }) }) }) };
      }
      if (table === "automation_faqs") {
        return {
          select: (_cols: string) => ({
            eq: (_c1: string, companyId: string) => ({
              eq: (_c2: string, flowId: string) =>
                thenable(async () => ({ data: faqs.filter((f) => f.company_id === companyId && f.flow_id === flowId), error: null }))
            })
          }),
          insert: (row: Record<string, unknown>) =>
            thenable(async () => {
              faqs.push({ id: `faq-${faqs.length + 1}`, company_id: row.company_id as string, flow_id: row.flow_id as string, title: row.title as string, answer: row.answer as string, sort_order: row.sort_order as number });
              return { error: null };
            })
        };
      }
      throw new Error(`Unexpected table in fake db: ${table}`);
    }
  };
}

vi.mock("../src/db/supabase.js", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("../src/admin/company.js", () => ({ getAdminCompany: vi.fn(async () => ({ id: "company-1", name: "Test Co" })) }));

function responseMock() {
  const response = { statusCode: 0, body: undefined as unknown, status: vi.fn(), json: vi.fn(), end: vi.fn() };
  response.status.mockImplementation((code: number) => {
    response.statusCode = code;
    return response;
  });
  response.json.mockImplementation((body: unknown) => {
    response.body = body;
    return response;
  });
  response.end.mockImplementation(() => response);
  return response;
}

function requestMock(body: Record<string, unknown>) {
  return { method: "POST", body } as never;
}

describe("create-faq (duplicate-title guard)", () => {
  let faqs: FakeFaqRow[];

  beforeEach(() => {
    faqs = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(makeFakeDb(faqs) as never);
  });

  it("A. a normal create inserts exactly one FAQ row", async () => {
    const res = responseMock();
    await handler(requestMock({ action: "create-faq", title: "Envíos", answer: "Sí, hacemos envíos." }) as never, res as never);

    expect(res.statusCode).toBe(204);
    expect(faqs).toHaveLength(1);
    expect(faqs[0].title).toBe("Envíos");
  });

  it("F. a duplicate title (same company, case/accent/whitespace-insensitive) is rejected with FAQ_ALREADY_EXISTS and creates nothing new", async () => {
    const first = responseMock();
    await handler(requestMock({ action: "create-faq", title: "Forma de pago", answer: "..." }) as never, first as never);
    expect(faqs).toHaveLength(1);

    const second = responseMock();
    await handler(requestMock({ action: "create-faq", title: "  FORMA   de   Pago  ", answer: "otra respuesta" }) as never, second as never);

    expect(second.statusCode).toBe(409);
    expect(second.body).toEqual({ error: "FAQ_ALREADY_EXISTS" });
    expect(faqs).toHaveLength(1); // no second row inserted
  });

  it("G. the same title is allowed again for a different company (scoped check)", async () => {
    faqs.push({ id: "faq-other-co", company_id: "company-2", flow_id: "flow-other", title: "Forma de pago", answer: "de otra empresa", sort_order: 0 });

    const res = responseMock();
    await handler(requestMock({ action: "create-faq", title: "Forma de pago", answer: "..." }) as never, res as never);

    expect(res.statusCode).toBe(204); // not blocked by the other company's FAQ
    expect(faqs.filter((f) => f.company_id === "company-1")).toHaveLength(1);
  });
});
