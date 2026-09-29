import { describe, expect, it } from "vitest";
import { resolveFaq, type AutomationFaq } from "../src/flows/automation-faq.js";

const faqs: AutomationFaq[] = [
  { id: "faq-envios", answer: "Sí, realizamos envíos a todo el país.", aliases: ["envio", "envios", "envían", "hacen envios", "envio nacional", "envio al interior"], sortOrder: 0 },
  { id: "faq-pagos", answer: "Aceptamos QR, transferencia y efectivo.", aliases: ["pago", "pagos", "metodos de pago", "como pago"], sortOrder: 1 }
];

describe("resolveFaq", () => {
  it("matches an alias by exact equality", () => {
    expect(resolveFaq("envio nacional", faqs)?.id).toBe("faq-envios");
  });

  it("matches an alias as a whole phrase inside a full sentence, case/accent/punctuation-insensitive", () => {
    expect(resolveFaq("¿Hacen envíos a Cochabamba?", faqs)?.id).toBe("faq-envios");
    expect(resolveFaq("Cuáles son los METODOS DE PAGO?", faqs)?.id).toBe("faq-pagos");
  });

  it("does not match an alias that is only a substring of an unrelated word", () => {
    expect(resolveFaq("estoy reenvioso con esto", faqs)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveFaq("quiero un descuento especial", faqs)).toBeNull();
    expect(resolveFaq("", faqs)).toBeNull();
  });

  it("resolves deterministically to a single FAQ when more than one could match, preferring the most specific alias", () => {
    // "envio" (faq-envios) and "pago" (faq-pagos) both appear; "hacen envios"
    // is not present here, so the plain single-word aliases tie in length —
    // sortOrder breaks the tie in favor of faq-envios (0 < 1).
    const match = resolveFaq("quiero saber el pago y el envio", faqs);
    expect(match?.id).toBe("faq-envios");
  });

  it("prefers a longer, more specific alias over a shorter one from another FAQ", () => {
    const specific: AutomationFaq[] = [
      { id: "faq-a", answer: "A", aliases: ["pago"], sortOrder: 5 },
      { id: "faq-b", answer: "B", aliases: ["como pago mi pedido"], sortOrder: 9 }
    ];
    expect(resolveFaq("hola, como pago mi pedido porfa", specific)?.id).toBe("faq-b");
  });

  it("ignores inactive FAQs (the caller is expected to filter before calling)", () => {
    // resolveFaq itself is unaware of "active" -- this documents that the
    // integration layer must exclude inactive FAQs before passing them in.
    const onlyActiveOnePassed: AutomationFaq[] = [faqs[1]];
    expect(resolveFaq("hacen envios?", onlyActiveOnePassed)).toBeNull();
  });
});
