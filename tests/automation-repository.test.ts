import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAutomationRepository } from "../src/db/automation-repository.js";

/** Minimal fake mimicking the chainable Supabase query builder used by
 * findWaitingExecution: .from().select().eq().eq().order().limit().maybeSingle().
 * Regression guard for the Production incident where this query ordered by a
 * column ("created_at") that does not exist on flow_executions (the real
 * column is "started_at"), which threw on every real inbound message and
 * silently blocked runWhatsAppIntakeAutomation from ever running. */
function fakeSupabaseClient() {
  const order = vi.fn().mockReturnThis();
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order,
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
  };
  const from = vi.fn().mockReturnValue(chain);
  return { client: { from } as unknown as SupabaseClient, order };
}

describe("SupabaseAutomationRepository.findWaitingExecution", () => {
  it("orders flow_executions by started_at, not created_at", async () => {
    const { client, order } = fakeSupabaseClient();
    const repository = new SupabaseAutomationRepository(client);

    await repository.findWaitingExecution("conversation-1");

    expect(order).toHaveBeenCalledWith("started_at", { ascending: true });
    expect(order).not.toHaveBeenCalledWith("created_at", expect.anything());
  });
});
