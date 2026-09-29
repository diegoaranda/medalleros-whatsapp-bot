import { describe, expect, it } from "vitest";
import {
  classifyIntents,
  type ClassifierCompletionClient,
  type ClassifierCompletionRequest,
  type IntentClassifierConfig
} from "../src/ai/intent-classifier.js";

const config: IntentClassifierConfig = { apiKey: "test-key", model: "gpt-5-nano", minConfidence: 0.8, timeoutMs: 1000 };

const sports = [{ id: "running", name: "Running" }];
const faqs = [
  { id: "faq-ubicacion", title: "Ubicación" },
  { id: "faq-material", title: "Material" }
];

function fakeClient(respond: (request: ClassifierCompletionRequest) => Promise<string> | string): ClassifierCompletionClient {
  return { complete: async (request) => respond(request) };
}

describe("classifyIntents", () => {
  it("C. accepts a valid FAQ id with sufficient confidence", async () => {
    const client = fakeClient(() => JSON.stringify({ intents: [{ type: "faq", id: "faq-ubicacion", confidence: 0.91 }] }));
    const { intents } = await classifyIntents({ message: "ustedes trabajan aqui en scz?", sports, faqs, config, client });
    expect(intents).toEqual([{ type: "faq", id: "faq-ubicacion", confidence: 0.91 }]);
  });

  it("D. accepts a valid sport id with sufficient confidence", async () => {
    const client = fakeClient(() => JSON.stringify({ intents: [{ type: "sport", id: "running", confidence: 0.85 }] }));
    const { intents } = await classifyIntents({ message: "quiero uno para mis carreras de los domingos", sports, faqs, config, client });
    expect(intents).toEqual([{ type: "sport", id: "running", confidence: 0.85 }]);
  });

  it("E. an id that doesn't exist in the offered options is discarded without affecting the rest", async () => {
    const client = fakeClient(() =>
      JSON.stringify({
        intents: [
          { type: "faq", id: "faq-inexistente", confidence: 0.95 },
          { type: "faq", id: "faq-ubicacion", confidence: 0.9 }
        ]
      })
    );
    const { intents } = await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(intents).toEqual([{ type: "faq", id: "faq-ubicacion", confidence: 0.9 }]);
  });

  it("F. confidence below the configured threshold discards only that intent", async () => {
    const client = fakeClient(() =>
      JSON.stringify({
        intents: [
          { type: "sport", id: "running", confidence: 0.4 },
          { type: "faq", id: "faq-material", confidence: 0.9 }
        ]
      })
    );
    const { intents } = await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(intents).toEqual([{ type: "faq", id: "faq-material", confidence: 0.9 }]);
  });

  it("G. more than 3 valid intents: keeps only the 3 highest-confidence ones", async () => {
    const manyFaqs = [
      { id: "faq-1", title: "Uno" },
      { id: "faq-2", title: "Dos" },
      { id: "faq-3", title: "Tres" },
      { id: "faq-4", title: "Cuatro" }
    ];
    const client = fakeClient(() =>
      JSON.stringify({
        intents: [
          { type: "faq", id: "faq-1", confidence: 0.81 },
          { type: "faq", id: "faq-2", confidence: 0.95 },
          { type: "faq", id: "faq-3", confidence: 0.88 },
          { type: "faq", id: "faq-4", confidence: 0.9 }
        ]
      })
    );
    const { intents } = await classifyIntents({ message: "algo", sports: [], faqs: manyFaqs, config, client });
    expect(intents).toHaveLength(3);
    expect(intents.map((intent) => intent.id)).toEqual(["faq-2", "faq-4", "faq-3"]); // highest confidence first
  });

  it("H. a valid intent plus an invented id: keeps the valid one, discards the invented one", async () => {
    const client = fakeClient(() =>
      JSON.stringify({
        intents: [
          { type: "sport", id: "running", confidence: 0.9 },
          { type: "sport", id: "futbol-inventado", confidence: 0.95 }
        ]
      })
    );
    const { intents } = await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(intents).toEqual([{ type: "sport", id: "running", confidence: 0.9 }]);
  });

  it("never repeats an intent already marked as found via alreadyFound", async () => {
    const client = fakeClient(() =>
      JSON.stringify({
        intents: [
          { type: "sport", id: "running", confidence: 0.95 },
          { type: "faq", id: "faq-material", confidence: 0.9 }
        ]
      })
    );
    const { intents } = await classifyIntents({
      message: "algo",
      sports,
      faqs,
      alreadyFound: [{ type: "sport", id: "running" }],
      config,
      client
    });
    expect(intents).toEqual([{ type: "faq", id: "faq-material", confidence: 0.9 }]);
  });

  it("J. a client error (timeout/network) fails closed to zero intents, never throws", async () => {
    const client = fakeClient(() => Promise.reject(new Error("timeout")));
    const { intents } = await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(intents).toEqual([]);
  });

  it("invalid JSON in the model response fails closed to zero intents", async () => {
    const client = fakeClient(() => "not json at all");
    const { intents } = await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(intents).toEqual([]);
  });

  it("an empty intents array from the model is accepted as-is", async () => {
    const client = fakeClient(() => JSON.stringify({ intents: [] }));
    const { intents } = await classifyIntents({ message: "quiero hablar con alguien", sports, faqs, config, client });
    expect(intents).toEqual([]);
  });

  it("O. never sends more than one completion request per call", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      return JSON.stringify({ intents: [{ type: "faq", id: "faq-ubicacion", confidence: 0.9 }] });
    });
    await classifyIntents({ message: "algo", sports, faqs, config, client });
    expect(calls).toBe(1);
  });

  it("with no sports and no FAQs offered, returns zero intents without calling the client", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      return JSON.stringify({ intents: [] });
    });
    const { intents } = await classifyIntents({ message: "algo", sports: [], faqs: [], config, client });
    expect(intents).toEqual([]);
    expect(calls).toBe(0);
  });
});
