import { describe, expect, it } from "vitest";
import { DEFAULT_INTAKE_MESSAGES, resolveCode, resolveSport, step, type CatalogSport, type IntakeContext } from "../src/flows/whatsapp-intake.js";

const sports: CatalogSport[] = [
  {
    slug: "running",
    name: "Running",
    codes: ["RUN-01", "RUN-08", "RUN-23"],
    aliases: ["runner", "runer", "correr", "carrera", "carreras", "corredor", "corredora", "trote"],
    catalogUrl: "https://medalleros-whatsapp-bot.vercel.app/catalogo/running"
  },
  { slug: "futbol", name: "Fútbol", codes: ["FUT-01"], catalogUrl: "https://medalleros-whatsapp-bot.vercel.app/catalogo/futbol" }
];

const context: IntakeContext = { messages: DEFAULT_INTAKE_MESSAGES, sports };

describe("resolveSport", () => {
  it("matches by exact name or slug", () => {
    expect(resolveSport("Running", sports)?.slug).toBe("running");
    expect(resolveSport("running", sports)?.slug).toBe("running");
    expect(resolveSport("Fútbol", sports)?.slug).toBe("futbol");
  });

  it("matches accented/uppercase input and aliases", () => {
    expect(resolveSport("FUTBOL", sports)?.slug).toBe("futbol");
    expect(resolveSport("correr", sports)?.slug).toBe("running");
    expect(resolveSport("runner", sports)?.slug).toBe("running");
  });

  it("recognizes an alias inside a full sentence, as a whole word", () => {
    expect(resolveSport("quiero algo para correr", sports)?.slug).toBe("running");
    expect(resolveSport("busco algo de trote matutino", sports)?.slug).toBe("running");
  });

  it("does not match an alias that is only a substring of another word", () => {
    expect(resolveSport("recorrer la ciudad", sports)).toBeNull();
  });

  it("returns null for an unknown sport", () => {
    expect(resolveSport("natación", sports)).toBeNull();
    expect(resolveSport("", sports)).toBeNull();
  });

  it("is driven entirely by the sports it is given, with no hardcoded list", () => {
    const futureSports: CatalogSport[] = [
      { slug: "natacion", name: "Natación", codes: ["NAT-01"], aliases: ["natacion", "nadar", "nadador", "nadadora"] }
    ];
    expect(resolveSport("busco para nadar", futureSports)?.slug).toBe("natacion");
    expect(resolveSport("quiero uno de natación", futureSports)?.slug).toBe("natacion");
    expect(resolveSport("es para una nadadora", futureSports)?.slug).toBe("natacion");
  });
});

describe("resolveCode", () => {
  it("extracts and validates a known code regardless of case", () => {
    expect(resolveCode("run-08", sports[0].codes)).toBe("RUN-08");
    expect(resolveCode("me gusta el RUN-08 porfa", sports[0].codes)).toBe("RUN-08");
  });

  it("rejects a well-formed code that does not belong to this sport", () => {
    expect(resolveCode("FUT-01", sports[0].codes)).toBeNull();
  });

  it("returns null when no code-like text is present", () => {
    expect(resolveCode("no se cual elegir", sports[0].codes)).toBeNull();
  });

  it("finds the code inside a full WhatsApp-style sentence", () => {
    expect(resolveCode("Hola, me interesa el diseño RUN-08", sports[0].codes)).toBe("RUN-08");
    expect(resolveCode("Me interesa RUN-08", sports[0].codes)).toBe("RUN-08");
  });
});

describe("step", () => {
  it("greets on the first message and asks for the sport", () => {
    const result = step("NEW", {}, "Hola", context);
    expect(result.state).toBe("WAITING_FOR_SPORT");
    expect(result.replies).toEqual([DEFAULT_INTAKE_MESSAGES.greeting]);
  });

  it("recognizes the sport and moves straight to waiting for a selection", () => {
    const result = step("WAITING_FOR_SPORT", {}, "Running", context);
    expect(result.state).toBe("WAITING_FOR_SELECTION");
    expect(result.variables.sportSlug).toBe("running");
    expect(result.replies[0]).toContain("Running");
  });

  it("includes the sport's own catalog URL, not a hardcoded one", () => {
    const running = step("WAITING_FOR_SPORT", {}, "Running", context);
    expect(running.replies[0]).toContain("/catalogo/running");
    const futbol = step("WAITING_FOR_SPORT", {}, "Futbol", context);
    expect(futbol.replies[0]).toContain("/catalogo/futbol");
  });

  it("re-asks when the sport is not recognized, without changing state", () => {
    const result = step("WAITING_FOR_SPORT", {}, "no se", context);
    expect(result.state).toBe("WAITING_FOR_SPORT");
    expect(result.replies).toEqual([DEFAULT_INTAKE_MESSAGES.sportNotRecognized]);
  });

  it("resolves a code and hands off to a human", () => {
    const result = step("WAITING_FOR_SELECTION", { sportSlug: "running", sportName: "Running" }, "RUN-08", context);
    expect(result.state).toBe("HUMAN_HANDOFF");
    expect(result.variables.selectedCode).toBe("RUN-08");
    expect(result.replies[0]).toContain("RUN-08");
    expect(result.replies[1]).toBe(DEFAULT_INTAKE_MESSAGES.handoff);
  });

  it("resolves the code even when it arrives inside a full sentence", () => {
    const result = step("WAITING_FOR_SELECTION", { sportSlug: "running" }, "Hola, me interesa el diseño RUN-08", context);
    expect(result.state).toBe("HUMAN_HANDOFF");
    expect(result.variables.selectedCode).toBe("RUN-08");
  });

  it("rejects a code that does not belong to the selected sport", () => {
    const result = step("WAITING_FOR_SELECTION", { sportSlug: "running" }, "FUT-01", context);
    expect(result.state).toBe("WAITING_FOR_SELECTION");
    expect(result.variables.selectedCode).toBeUndefined();
  });

  it("stays silent once handed off to a human", () => {
    const result = step("HUMAN_HANDOFF", { sportSlug: "running", selectedCode: "RUN-08" }, "hola de nuevo", context);
    expect(result.state).toBe("HUMAN_HANDOFF");
    expect(result.replies).toEqual([]);
  });

  it("runs the full happy path: Hola -> Running -> RUN-08", () => {
    let state = step("NEW", {}, "Hola", context);
    expect(state.state).toBe("WAITING_FOR_SPORT");

    state = step(state.state, state.variables, "Running", context);
    expect(state.state).toBe("WAITING_FOR_SELECTION");

    state = step(state.state, state.variables, "RUN-08", context);
    expect(state.state).toBe("HUMAN_HANDOFF");
    expect(state.variables.selectedCode).toBe("RUN-08");
  });
});
